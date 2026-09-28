import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
const FETCH_TIMEOUT_MS = 5000;
/** Resolve symlinks (e.g. macOS /var → /private/var) so root-relative paths line up. */
export function realpath(p) {
    // Resolve the nearest existing ancestor so paths to missing files still normalise.
    let rest = "";
    for (let cur = p;; cur = path.dirname(cur)) {
        try {
            return path.join(fs.realpathSync(cur), rest);
        }
        catch {
            if (path.dirname(cur) === cur)
                return p;
            rest = path.join(path.basename(cur), rest);
        }
    }
}
async function fetchText(url) {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        return res.ok ? await res.text() : null;
    }
    catch {
        return null;
    }
}
/** Fetch a script and load the source map it references, if any. */
async function loadSourceMap(scriptUrl) {
    const script = await fetchText(scriptUrl);
    if (!script)
        return null;
    const refs = [...script.matchAll(/[#@]\s*sourceMappingURL=([^\s'"]+)/g)];
    const ref = refs.at(-1)?.[1];
    return ref ? loadMapRef(ref, scriptUrl) : null;
}
/**
 * Load the source map `ref` points at: an inline `data:` URL, or a URL
 * relative to `baseUrl` (the script or stylesheet that referenced it).
 */
export async function loadMapRef(ref, baseUrl) {
    try {
        if (ref.startsWith("data:")) {
            const comma = ref.indexOf(",");
            const meta = ref.slice(0, comma);
            const data = ref.slice(comma + 1);
            const json = meta.endsWith(";base64")
                ? Buffer.from(data, "base64").toString("utf8")
                : decodeURIComponent(data);
            return new TraceMap(json, baseUrl);
        }
        const mapUrl = new URL(ref, baseUrl).href;
        const json = await fetchText(mapUrl);
        return json ? new TraceMap(json, mapUrl) : null;
    }
    catch {
        return null;
    }
}
/**
 * Normalise a source-map source (or raw frame URL) to a filesystem path where
 * possible. Handles the schemes dev servers commonly emit:
 *   file:///abs/App.tsx                          → /abs/App.tsx
 *   http://localhost:5173/src/App.tsx?t=1        → <root>/src/App.tsx
 *   http://localhost:5173/@fs/abs/App.tsx        → /abs/App.tsx
 *   webpack://app/./src/App.tsx                  → <root>/src/App.tsx
 *   webpack-internal:///(app-pages-browser)/./src/App.tsx → <root>/src/App.tsx
 *   turbopack:///[project]/src/App.tsx           → <root>/src/App.tsx
 *   rsc://React/Server/file:///abs/App.tsx?42    → /abs/App.tsx
 */
export function toFilePath(source, root) {
    let s = source.replace(/^(?:rsc|about):\/\/React\/[^/]+\//, "");
    try {
        if (s.startsWith("file://"))
            return fileURLToPath(s.replace(/\?.*$/, ""));
    }
    catch {
        return source;
    }
    let rel = null;
    let m;
    if ((m = s.match(/^webpack-internal:\/\/\/(?:\([^)]*\)\/)?(.*)$/)))
        rel = m[1];
    else if ((m = s.match(/^webpack:\/\/[^/]*\/(.*)$/)))
        rel = m[1];
    else if ((m = s.match(/^turbopack:\/\/\/\[project\]\/(.*)$/)))
        rel = m[1];
    else if (/^https?:\/\//.test(s)) {
        const pathname = decodeURIComponent(new URL(s).pathname);
        if (pathname.startsWith("/@fs/"))
            return pathname.slice("/@fs".length);
        rel = pathname.replace(/^\/+/, "");
    }
    else if (path.isAbsolute(s)) {
        return s;
    }
    else {
        rel = s;
    }
    rel = rel.replace(/\?.*$/, "").replace(/^\.\//, "");
    return path.join(root, ...rel.split("/"));
}
/** `file` relative to `root` (POSIX separators) when it's inside it, else unchanged. */
export function rootRelative(file, root) {
    if (!path.isAbsolute(file))
        return file;
    const rel = path.relative(root, realpath(file));
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : file;
}
function withPath(fileName, line, column, root) {
    const file = rootRelative(fileName, root);
    return { fileName, lineNumber: line, columnNumber: column, path: `${file}:${line}:${column}` };
}
/** Resolves frames to original sources, caching one source map per script. */
export class SourceResolver {
    maps = new Map();
    root;
    constructor(root) {
        this.root = realpath(root);
    }
    async resolve(frame) {
        if (!frame)
            return null;
        if (/^https?:\/\//.test(frame.url)) {
            let map = this.maps.get(frame.url);
            if (!map) {
                map = loadSourceMap(frame.url);
                this.maps.set(frame.url, map);
            }
            const traced = await map;
            if (traced) {
                // trace-mapping takes 1-based lines and 0-based columns.
                const pos = originalPositionFor(traced, { line: frame.line, column: frame.column - 1 });
                if (pos.source && pos.line != null && pos.column != null) {
                    return withPath(toFilePath(pos.source, this.root), pos.line, pos.column + 1, this.root);
                }
            }
        }
        // No source map (or a server/file frame): report the location as-is.
        const source = withPath(toFilePath(frame.url, this.root), frame.line, frame.column, this.root);
        return /^https?:\/\//.test(frame.url) ? { ...source, generated: true } : source;
    }
}
/** Resolve every React-rendered element's frames to original source locations. */
export async function resolveComponents(nodes, resolver) {
    const files = new Map();
    const visit = async (list) => {
        for (const node of list) {
            if (node.react) {
                files.set(node, {
                    tag: node.tag,
                    selector: node.selector,
                    source: await resolver.resolve(node.react.frame),
                    components: await Promise.all(node.react.components.map(async (c) => ({
                        name: c.name,
                        source: await resolver.resolve(c.frame),
                    }))),
                });
            }
            await visit(node.children);
        }
    };
    await visit(nodes);
    return files;
}
