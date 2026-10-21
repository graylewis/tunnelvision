import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decodedMappings, LEAST_UPPER_BOUND, originalPositionFor } from "@jridgewell/trace-mapping";
import { loadMapRef, realpath, rootRelative, toFilePath } from "./reactsource.js";
import { MapChecker } from "./stylemaps.js";
/**
 * Walk the text of a rule from its start in `lines` (1-based `line`),
 * calling `visit` with each line's text at the rule's top nesting level
 * (depth 1), until the rule's closing brace. Returns where that brace is.
 */
function walkRule(lines, line, column, visit) {
    let depth = 0;
    for (let i = line - 1; i < lines.length; i++) {
        const offset = i === line - 1 ? column : 0;
        const text = lines[i].slice(offset);
        if (depth === 1 && visit?.(text, i + 1, offset))
            return null;
        for (let c = 0; c < text.length; c++) {
            if (text[c] === "{")
                depth++;
            else if (text[c] === "}" && --depth <= 0)
                return { line: i + 1, column: offset + c };
        }
    }
    return null;
}
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Class names ignored when comparing a sheet with its file (CSS Modules rename them). */
const CLASS_NAME = /\.-?[A-Za-z_][\w-]*/g;
function normalizedLines(text) {
    return text
        .replace(/\/\*#\s*sourceMappingURL=[^*]*\*\/\s*$/, "")
        .replace(/\r\n/g, "\n")
        .trimEnd()
        .split("\n")
        .map((line) => line.replace(CLASS_NAME, ".C").trimEnd());
}
/** Whether a served stylesheet is its source file line for line. */
export function sameLines(served, file) {
    const a = normalizedLines(served);
    const b = normalizedLines(file);
    return a.length === b.length && a.every((line, i) => line === b[i]);
}
/**
 * Bumped when the locations found for the same sheets change, so rules
 * located the old way aren't carried over (see `settingsHash` in `shoot.ts`).
 */
export const LOCATOR_VERSION = 3;
/** How a sheet is named in messages. */
function sheetLabel(sheet, root) {
    if (sheet.devId)
        return rootRelative(sheet.devId, root);
    return sheet.sourceURL && sheet.startLine === 0 ? sheet.sourceURL : "inline <style>";
}
export class StyleLocator {
    root;
    checker;
    /** `rebuild`: trace through rebuilt PostCSS maps (`workarounds.turbopackPostcssMaps`). */
    constructor(root, options = {}) {
        this.root = realpath(root);
        this.checker = new MapChecker(this.root, { rebuild: options.rebuild ?? false, pipeline: options.pipeline });
    }
    async mapping(sheet) {
        const label = sheetLabel(sheet, this.root);
        const file = sheet.devId ?? (/^(https?|file):\/\//.test(sheet.sourceURL) ? toFilePath(sheet.sourceURL, this.root) : null);
        if (sheet.sourceMapURL) {
            // An inline map's sources are relative to the CSS file, not the page a
            // <style> sits in (Astro puts dev CSS in the page's HTML), where
            // Vite's absolute `/Users/…/global.css` would resolve to a URL.
            const inline = sheet.sourceMapURL.startsWith("data:");
            const base = inline && file ? pathToFileURL(file).href : sheet.sourceURL || (file ? pathToFileURL(file).href : "file:///");
            const map = await loadMapRef(sheet.sourceMapURL, base);
            if (map)
                return this.checkMap(map, label);
        }
        // Only a sheet known to be one of the project's files is the project's to fix; others (a CDN's, a library's <style>) just get counted.
        const own = file !== null && fs.existsSync(file) && !path.isAbsolute(rootRelative(file, this.root));
        const none = {
            mapping: { kind: "none", untraced: { file: own ? rootRelative(file, this.root) : label, problem: "no-map" } },
            checks: [{ sheet: label, ...(own ? { file: rootRelative(file, this.root) } : {}), problem: "no-map" }],
        };
        // A <style> block written in an HTML document starts partway through it.
        // One Vite put there (`devId`) holds just its file, so it can still match.
        if (!file || (sheet.startLine > 0 && !sheet.devId))
            return none;
        try {
            return sameLines(sheet.text, fs.readFileSync(file, "utf8")) ? { mapping: { kind: "file", path: file }, checks: [] } : none;
        }
        catch {
            return none;
        }
    }
    /** Check each file a sheet's map names. */
    async checkMap(map, sheet) {
        const sources = new Map();
        const checks = [];
        for (const [i, resolved] of map.resolvedSources.entries()) {
            if (sources.has(resolved))
                continue;
            const verdict = await this.checker.source(resolved, map.sourcesContent?.[i]);
            sources.set(resolved, verdict);
            const file = this.checker.label(toFilePath(resolved, this.root));
            if ("via" in verdict)
                checks.push({ sheet, file, problem: "postcss-output", patched: true });
            else if (!verdict.ok)
                checks.push({ sheet, file, problem: verdict.problem, ...(verdict.detail ? { detail: verdict.detail } : {}) });
        }
        const copies = new Map();
        map.resolvedSources.forEach((resolved, i) => {
            const copy = map.sourcesContent?.[i];
            if (copy != null && !copies.has(resolved))
                copies.set(resolved, copy.split(/\r?\n/));
        });
        const lines = decodedMappings(map);
        const sparse = lines.filter((l) => l.length > 0).length < lines.length / 2;
        return { mapping: { kind: "map", map, sources, copies, sparse }, checks };
    }
    /** Check a stylesheet's source map without locating any rules. */
    async check(sheet) {
        return (await this.mapping(sheet)).checks;
    }
    /** Where served text at a 0-based line came from, in the map's copy of its source. */
    copyPosition(m, line, column) {
        const pos = originalPositionFor(m.map, { line: line + 1, column });
        if (pos.source && pos.line != null)
            return { source: pos.source, line: pos.line, column: pos.column ?? 0, before: false };
        if (!m.sparse)
            return null;
        // Nothing mapped here: the last mapping before it is the start of its rule (or of the block it was moved out of).
        const lines = decodedMappings(m.map);
        for (let i = Math.min(line, lines.length - 1); i >= 0; i--) {
            const seg = lines[i].filter((s) => s.length >= 4 && (i < line || s[0] <= column)).at(-1);
            if (!seg)
                continue;
            const [, sourceIndex, sourceLine, sourceColumn] = seg;
            return { source: m.map.resolvedSources[sourceIndex], line: sourceLine + 1, column: sourceColumn, before: true };
        }
        return null;
    }
    /** A position in a copy, as a file and line, following a rebuilt map when its source has one. */
    resolve(m, at) {
        const verdict = m.sources.get(at.source);
        if (verdict && !verdict.ok) {
            return { untraced: { file: this.checker.label(toFilePath(at.source, this.root)), problem: verdict.problem } };
        }
        if (verdict && "via" in verdict) {
            // The copy is PostCSS's output for the file; its rebuilt map has the rest of the way.
            const asked = { line: at.line, column: at.column };
            let original = originalPositionFor(verdict.via, asked);
            if (!original.source)
                original = originalPositionFor(verdict.via, { ...asked, bias: LEAST_UPPER_BOUND });
            if (!original.source || original.line == null)
                return null;
            return { path: rootRelative(toFilePath(original.source, this.root), this.root), line: original.line };
        }
        return { path: rootRelative(toFilePath(at.source, this.root), this.root), line: at.line };
    }
    /** `decl`: the declaration's property, found by name within its rule when only the rule's start is mapped. */
    position(m, line, column, decl) {
        if (!m)
            return null;
        if (m.kind === "none")
            return { untraced: m.untraced };
        if (m.kind === "file")
            return { path: rootRelative(m.path, this.root), line: line + 1 };
        const at = this.copyPosition(m, line, column);
        if (!at)
            return null;
        const copy = m.copies.get(at.source);
        if (at.before && decl && copy) {
            const name = new RegExp(`^(\\s*)${escapeRegExp(decl)}\\s*:`);
            walkRule(copy, at.line, at.column, (text, l, offset) => {
                const found = text.match(name);
                if (found)
                    Object.assign(at, { line: l, column: offset + found[1].length });
                return Boolean(found);
            });
        }
        return this.resolve(m, at);
    }
    loc(m, range, end, decl) {
        if (!range)
            return null;
        const start = this.position(m, range.startLine, range.startColumn, decl);
        if (!start || "untraced" in start)
            return null;
        let stop = null;
        const at = end && m?.kind === "map" ? this.copyPosition(m, range.startLine, range.startColumn) : null;
        if (at?.before && m?.kind === "map") {
            // A rule placed from the mapping before it ends where its braces close in the copy; the map would give the next rule.
            const copy = m.copies.get(at.source);
            const close = copy && walkRule(copy, at.line, at.column);
            stop = close ? this.resolve(m, { source: at.source, ...close }) : null;
        }
        else if (end) {
            stop = this.position(m, end.endLine, Math.max(0, end.endColumn - 1));
        }
        return stop && "path" in stop && stop.path === start.path && stop.line >= start.line ? { ...start, endLine: stop.line } : start;
    }
    start(m, range) {
        return range ? this.position(m, range.startLine, range.startColumn) : null;
    }
    /** Why a rule can't be traced, if a broken map is why: where its selector, or else a declaration, lands. */
    untraced(m, rule) {
        for (const range of [rule.selectorRange, ...rule.decls.map((d) => d.range)]) {
            const pos = this.start(m, range);
            if (pos)
                return "untraced" in pos ? pos.untraced : null;
        }
        return null;
    }
    decl(m, d) {
        return {
            name: d.name,
            value: d.value,
            ...(d.important ? { important: true } : {}),
            ...(d.longhands ? { longhands: d.longhands } : {}),
            loc: this.loc(m, d.range, null, d.name),
        };
    }
    /**
     * The page's rule table with source locations, index for index with
     * `styles.rules`, and the problems found with the page's sheets' maps.
     */
    async rules(styles) {
        const mappings = new Map();
        const checks = [];
        for (const sheet of styles.sheets) {
            const found = await this.mapping(sheet);
            mappings.set(sheet.id, found.mapping);
            checks.push(...found.checks);
        }
        const rules = styles.rules.map((r) => {
            const m = r.sheet ? (mappings.get(r.sheet) ?? null) : null;
            const untraced = this.untraced(m, r);
            return {
                selector: r.selector,
                ...(r.inline ? { inline: r.inline } : {}),
                loc: this.loc(m, r.selectorRange, r.styleRange),
                decls: r.decls.map((d) => this.decl(m, d)),
                ...(untraced ? { untraced } : {}),
            };
        });
        return { rules, checks };
    }
}
