import fs from "node:fs";
import path from "node:path";
import { LEAST_UPPER_BOUND, originalPositionFor } from "@jridgewell/trace-mapping";
import { parse } from "acorn";
import { loadMapRef, realpath, rootRelative, toFilePath } from "./reactsource.js";
/** How long a unit's rerun may take before it's given up on as untraceable. */
const RERUN_TIMEOUT_MS = 10_000;
/* eslint-disable @typescript-eslint/no-explicit-any -- CDP responses and ASTs are untyped JSON */
/** Re-runs units under coverage on one page, resolving what ran to project code. */
export class UnitTracer {
    cdp;
    root;
    scripts = new Map();
    lineCounts = new Map();
    constructor(cdp, root) {
        this.cdp = cdp;
        this.root = realpath(root);
    }
    static async open(page, root) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Debugger.enable");
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
        return new UnitTracer(cdp, root);
    }
    async close() {
        await this.cdp.detach().catch(() => { });
    }
    /** Run `rerun` alone and return the code it ran, or why it couldn't be traced. */
    async trace(rerun) {
        await this.cdp.send("Profiler.takePreciseCoverage"); // resets the counters
        try {
            const run = rerun.evaluate((fn) => Promise.resolve(fn()).then(() => true));
            const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`took over ${RERUN_TIMEOUT_MS / 1000}s`)), RERUN_TIMEOUT_MS));
            await Promise.race([run, timeout]);
        }
        catch (err) {
            return { error: `rerun failed: ${err.message.split("\n")[0]}` };
        }
        const { result } = (await this.cdp.send("Profiler.takePreciseCoverage"));
        const code = { ran: {}, functions: {}, packages: {} };
        const used = [];
        for (const entry of result) {
            const ran = entry.functions.filter((f) => f.ranges[0].count > 0);
            if (!ran.length || !entry.url)
                continue;
            const script = await this.script(entry.scriptId, entry.url);
            if (!script)
                continue;
            for (const fn of ran) {
                const where = await this.place(script, fn.ranges[0].startOffset, fn.ranges[0].endOffset);
                if (where === "unmapped")
                    return { error: `no source map for ${entry.url}` };
                if (!where)
                    continue;
                if ("package" in where)
                    code.packages[where.package] = where.version;
                else if (this.wholeFile(where.file, where.start, where.end))
                    code.ran[where.file] ??= [];
                else
                    (code.ran[where.file] ??= []).push([where.start, where.end]);
            }
            used.push(script);
        }
        if (!Object.keys(code.ran).length)
            return { error: "none of the project's code ran" };
        // Every function in the files that ran, ran or not, to tell module scope apart.
        for (const script of used) {
            for (const [start, end] of script.functions) {
                const where = await this.place(script, start, end);
                if (!where || where === "unmapped" || "package" in where || !(where.file in code.ran))
                    continue;
                if (!this.wholeFile(where.file, where.start, where.end))
                    (code.functions[where.file] ??= []).push([where.start, where.end]);
            }
        }
        for (const file of Object.keys(code.ran)) {
            code.ran[file] = dedupe(code.ran[file]);
            code.functions[file] = dedupe([...(code.functions[file] ?? []), ...code.ran[file]]);
        }
        return code;
    }
    script(scriptId, url) {
        let s = this.scripts.get(scriptId);
        if (!s) {
            s = (async () => {
                let source;
                try {
                    source = (await this.cdp.send("Debugger.getScriptSource", { scriptId })).scriptSource;
                }
                catch {
                    return null;
                }
                const lineStarts = [0];
                for (let i = 0; i < source.length; i++)
                    if (source.charCodeAt(i) === 10)
                        lineStarts.push(i + 1);
                const ref = [...source.matchAll(/[#@]\s*sourceMappingURL=([^\s'"]+)/g)].at(-1)?.[1];
                const map = ref && (ref.startsWith("data:") || /^https?:\/\//.test(url)) ? await loadMapRef(ref, url) : null;
                return { url, lineStarts, map, functions: functionRanges(source) };
            })();
            this.scripts.set(scriptId, s);
        }
        return s;
    }
    /** Where a function's [start, end) offsets are in the original source. */
    async place(script, startOffset, endOffset) {
        const ends = script.map ? originalEnds(script.map, script.lineStarts, startOffset, endOffset) : null;
        if (!ends) {
            // Code a map has no entry for anywhere is the bundler's own (Turbopack's
            // module factories and export getters), not the project's.
            if (script.map)
                return null;
            // Without a map the code can't be placed. It matters only if it's the project's own.
            const file = rootRelative(toFilePath(script.url, this.root), this.root);
            return path.isAbsolute(file) || file.startsWith("..") || file.includes("node_modules/") || /^https?:/.test(file) ? null : "unmapped";
        }
        const from = { fileName: toFilePath(ends.from.source, this.root), line: ends.wrapper ? 1 : ends.from.line };
        // A module wrapper spans its whole file, so it counts as module scope (see `wholeFile`).
        const to = { fileName: toFilePath(ends.to.source, this.root), line: ends.wrapper ? Infinity : ends.to.line };
        const pkg = packageOf(from.fileName, this.root);
        if (pkg)
            return pkg;
        const file = rootRelative(from.fileName, this.root);
        if (path.isAbsolute(file) || file.startsWith(".."))
            return null;
        if (to.fileName !== from.fileName)
            return null; // spans modules in a bundle
        return { file, start: from.line, end: Math.max(from.line, to.line) };
    }
    /** A function spanning its whole file is a module's scope (a bundler's wrapper, or the script itself). */
    wholeFile(file, start, end) {
        let count = this.lineCounts.get(file);
        if (count === undefined) {
            try {
                count = fs.readFileSync(path.join(this.root, file), "utf8").replace(/\n+$/, "").split("\n").length;
            }
            catch {
                count = Infinity;
            }
            this.lineCounts.set(file, count);
        }
        return start <= 1 && end >= count;
    }
}
/**
 * The original positions of a function's [start, end) offsets in a script,
 * or null when the map has no entry anywhere in it. A map may have no entry at
 * one end (an arrow mid-line): the other stands in. With no entry at either
 * end but some inside, it's a bundler's module wrapper around mapped code
 * (`wrapper`), whose inner lines say which file it wraps but not its extent.
 */
export function originalEnds(map, lineStarts, startOffset, endOffset) {
    const generated = (offset) => {
        let lo = 0;
        let hi = lineStarts.length - 1;
        let line = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (lineStarts[mid] <= offset) {
                line = mid;
                lo = mid + 1;
            }
            else
                hi = mid - 1;
        }
        return { line: line + 1, column: offset - lineStarts[line] };
    };
    const at = (pos, bias) => {
        const o = originalPositionFor(map, bias ? { ...pos, bias } : pos);
        return o.source && o.line != null ? { source: o.source, line: o.line } : null;
    };
    const start = generated(startOffset);
    const end = generated(Math.max(startOffset, endOffset - 1));
    let from = at(start);
    let to = at(end);
    from ??= to;
    to ??= from;
    if (from && to)
        return { from, to, wrapper: false };
    // The first mapping on a line wholly inside the function.
    for (let line = start.line + 1; line < end.line; line++) {
        const inner = at({ line, column: 0 }, LEAST_UPPER_BOUND);
        if (inner)
            return { from: inner, to: inner, wrapper: true };
    }
    return null;
}
/** The [start, end) offsets of every function in a script, or none when it doesn't parse. */
export function functionRanges(source) {
    let ast = null;
    for (const sourceType of ["module", "script"]) {
        try {
            ast = parse(source, { ecmaVersion: "latest", sourceType, allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
            break;
        }
        catch {
            // try the other
        }
    }
    const out = [];
    const visit = (node) => {
        if (!node || typeof node.type !== "string")
            return;
        if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression")
            out.push([node.start, node.end]);
        for (const key of Object.keys(node)) {
            const v = node[key];
            if (Array.isArray(v))
                v.forEach(visit);
            else if (v && typeof v === "object" && typeof v.type === "string")
                visit(v);
        }
    };
    visit(ast);
    return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
function dedupe(ranges) {
    const seen = new Set();
    return ranges
        .filter(([a, b]) => {
        const k = `${a}-${b}`;
        if (seen.has(k))
            return false;
        seen.add(k);
        return true;
    })
        .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}
/**
 * The installed package a file belongs to, from its path under node_modules.
 * Its version comes from the package.json next to it or, when a source map's
 * path doesn't lead there (Vite's prebundled dependencies climb to the
 * filesystem root), from the one Node would resolve from the project.
 */
function packageOf(file, root) {
    const m = file.match(/^(.*[\\/]node_modules[\\/])((?:@[^\\/]+[\\/])?[^\\/.][^\\/]*)/);
    if (!m)
        return null;
    const name = m[2].replace(/\\/g, "/");
    const candidates = [path.join(m[1], m[2], "package.json")];
    for (let dir = root;; dir = path.dirname(dir)) {
        candidates.push(path.join(dir, "node_modules", ...name.split("/"), "package.json"));
        if (path.dirname(dir) === dir)
            break;
    }
    for (const candidate of candidates) {
        try {
            return { package: name, version: String(JSON.parse(fs.readFileSync(candidate, "utf8")).version ?? "unknown") };
        }
        catch {
            // try the next
        }
    }
    return { package: name, version: "unknown" };
}
const inside = (line, ranges) => ranges.some(([a, b]) => line >= a && line <= b);
/** `path:line`, or just `path`. */
export function lineLabel(c) {
    return c.line === undefined ? c.path : `${c.path}:${c.line}`;
}
/**
 * The changed lines that touch a unit's code: hunks that delete, replace or
 * add lines inside a function it ran, or in the module scope of a file it
 * ran. A renamed or deleted file touches it too.
 */
export function touchedBy(code, changes, prefix = "") {
    const byOldPath = new Map();
    for (const [newPath, c] of changes)
        if (!c.created)
            byOldPath.set(c.oldPath, { newPath, c });
    const project = (repoPath) => (prefix ? path.posix.relative(prefix, repoPath) : repoPath);
    const out = [];
    for (const [file, ran] of Object.entries(code.ran)) {
        const repoPath = path.posix.join(prefix, file);
        const entry = byOldPath.get(repoPath);
        if (!entry)
            continue;
        const { newPath, c } = entry;
        const hunks = c.hunks.filter((h) => {
            const functions = code.functions[file] ?? [];
            if (h.oldCount > 0) {
                for (let l = h.oldStart; l < h.oldStart + h.oldCount; l++)
                    if (inside(l, ran) || !inside(l, functions))
                        return true;
                return false;
            }
            // Lines added between old lines `oldStart` and `oldStart + 1`: they're in a
            // function only when both of those are; otherwise they're module scope.
            const within = (ranges) => ranges.some(([x, y]) => h.oldStart >= x && h.oldStart < y);
            return within(ran) || !within(functions);
        });
        for (const h of hunks) {
            out.push(h.newCount > 0 ? { side: "RIGHT", path: project(newPath), line: h.newStart } : { side: "LEFT", path: file, line: h.oldStart });
        }
        if (newPath !== repoPath && !hunks.length)
            out.push({ side: "RIGHT", path: project(newPath) });
    }
    return out;
}
/** The version of package `name` Node would resolve from `root`, or null when it isn't installed. */
export function installedVersion(root, name) {
    for (let dir = root;; dir = path.dirname(dir)) {
        try {
            return String(JSON.parse(fs.readFileSync(path.join(dir, "node_modules", ...name.split("/"), "package.json"), "utf8")).version);
        }
        catch {
            // keep looking
        }
        if (path.dirname(dir) === dir)
            return null;
    }
}
/**
 * The lockfile lines behind packages a unit ran that are now installed at a
 * different version: the first added line naming each, else the lockfile
 * itself (no line), else nothing when no lockfile changed (node_modules
 * changed underneath). `changed` lists the packages either way.
 */
export function packageChanges(code, root, changes, lockfiles, prefix = "") {
    const changed = Object.entries(code.packages)
        .filter(([name, version]) => (installedVersion(root, name) ?? "missing") !== version)
        .map(([name]) => name);
    const lines = [];
    const project = (repoPath) => (prefix ? path.posix.relative(prefix, repoPath) : repoPath);
    for (const name of changed) {
        const quoted = new RegExp(`["'/@]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'@:/]`);
        let found = null;
        let lockfile = null;
        for (const [p, c] of changes) {
            if (!lockfiles.includes(path.posix.basename(p)))
                continue;
            lockfile ??= p;
            const hit = [...c.added].find(([, text]) => quoted.test(text));
            if (hit) {
                found = { side: "RIGHT", path: project(p), line: hit[0] };
                break;
            }
        }
        if (found)
            lines.push(found);
        else if (lockfile)
            lines.push({ side: "RIGHT", path: project(lockfile) });
    }
    return { lines, changed };
}
/**
 * A replayed unit's code moved to the new revision's lines. Ranges it ran
 * are untouched (or it wouldn't be replayed), so they map exactly; a range
 * of another function that no longer maps is dropped, which leaves its lines
 * counting as module scope. Null when a range it ran can't be placed.
 */
export function remapCode(code, mapper) {
    const out = { ran: {}, functions: {}, packages: { ...code.packages } };
    const move = (file, [a, b]) => {
        const s = mapper.map(file, a);
        const e = mapper.map(file, b);
        if (!s || !e || s.path !== e.path)
            return null;
        return { file: s.path, range: [s.line, e.line] };
    };
    for (const [file, ranges] of Object.entries(code.ran)) {
        const moved = ranges.map((r) => move(file, r));
        if (moved.some((m) => !m))
            return null;
        const to = moved[0]?.file ?? mapper.map(file, 1)?.path ?? file;
        out.ran[to] = moved.map((m) => m.range);
        out.functions[to] = (code.functions[file] ?? []).map((r) => move(file, r)).filter((m) => m && m.file === to).map((m) => m.range);
    }
    return out;
}
