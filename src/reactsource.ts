import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { COMPONENT_FILE, resolveElementOutput, type ElementNode, type StackFrame } from "./elements.js";

/**
 * Turn the `_debugStack` frames captured in the browser into original source
 * locations, and write them next to each element as `component.json`.
 *
 * A frame points at the code the browser ran (a Vite-transformed module, a
 * webpack/Turbopack chunk, ...), so we fetch that script, follow its
 * `sourceMappingURL`, and map the position back to the file the JSX was
 * written in.
 */

/** A resolved source location, with a clickable `file:line:col` path. */
export interface ComponentSource {
	fileName: string;
	/** 1-based. */
	lineNumber: number;
	/** 1-based. */
	columnNumber: number;
	/** `file:line:col`, with the file relative to the project root when inside it. */
	path: string;
	/**
	 * True when no source map could be applied, so the location refers to the
	 * served (transformed) script rather than the original file.
	 */
	generated?: true;
}

/** Contents of each element's `component.json`. */
export interface ComponentFile {
	tag: string;
	selector: string;
	source: ComponentSource | null;
	components: { name: string; source: ComponentSource | null }[];
}

const FETCH_TIMEOUT_MS = 5000;

/** Resolve symlinks (e.g. macOS /var → /private/var) so root-relative paths line up. */
function realpath(p: string): string {
	// Resolve the nearest existing ancestor so paths to missing files still normalise.
	let rest = "";
	for (let cur = p; ; cur = path.dirname(cur)) {
		try {
			return path.join(fs.realpathSync(cur), rest);
		} catch {
			if (path.dirname(cur) === cur) return p;
			rest = path.join(path.basename(cur), rest);
		}
	}
}

async function fetchText(url: string): Promise<string | null> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		return res.ok ? await res.text() : null;
	} catch {
		return null;
	}
}

/** Fetch a script and load the source map it references, if any. */
async function loadSourceMap(scriptUrl: string): Promise<TraceMap | null> {
	const script = await fetchText(scriptUrl);
	if (!script) return null;
	const refs = [...script.matchAll(/[#@]\s*sourceMappingURL=([^\s'"]+)/g)];
	const ref = refs.at(-1)?.[1];
	if (!ref) return null;

	try {
		if (ref.startsWith("data:")) {
			const comma = ref.indexOf(",");
			const meta = ref.slice(0, comma);
			const data = ref.slice(comma + 1);
			const json = meta.endsWith(";base64")
				? Buffer.from(data, "base64").toString("utf8")
				: decodeURIComponent(data);
			return new TraceMap(json, scriptUrl);
		}
		const mapUrl = new URL(ref, scriptUrl).href;
		const json = await fetchText(mapUrl);
		return json ? new TraceMap(json, mapUrl) : null;
	} catch {
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
function toFilePath(source: string, root: string): string {
	let s = source.replace(/^(?:rsc|about):\/\/React\/[^/]+\//, "");
	try {
		if (s.startsWith("file://")) return fileURLToPath(s.replace(/\?.*$/, ""));
	} catch {
		return source;
	}

	let rel: string | null = null;
	let m: RegExpMatchArray | null;
	if ((m = s.match(/^webpack-internal:\/\/\/(?:\([^)]*\)\/)?(.*)$/))) rel = m[1];
	else if ((m = s.match(/^webpack:\/\/[^/]*\/(.*)$/))) rel = m[1];
	else if ((m = s.match(/^turbopack:\/\/\/\[project\]\/(.*)$/))) rel = m[1];
	else if (/^https?:\/\//.test(s)) {
		const pathname = decodeURIComponent(new URL(s).pathname);
		if (pathname.startsWith("/@fs/")) return pathname.slice("/@fs".length);
		rel = pathname.replace(/^\/+/, "");
	} else if (path.isAbsolute(s)) {
		return s;
	} else {
		rel = s;
	}

	rel = rel.replace(/\?.*$/, "").replace(/^\.\//, "");
	return path.join(root, ...rel.split("/"));
}

function withPath(fileName: string, line: number, column: number, root: string): ComponentSource {
	let file = fileName;
	if (path.isAbsolute(file)) {
		const rel = path.relative(root, realpath(file));
		if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
			file = rel.split(path.sep).join("/");
		}
	}
	return { fileName, lineNumber: line, columnNumber: column, path: `${file}:${line}:${column}` };
}

/** Resolves frames to original sources, caching one source map per script. */
export class SourceResolver {
	private readonly maps = new Map<string, Promise<TraceMap | null>>();
	private readonly root: string;

	constructor(root: string) {
		this.root = realpath(root);
	}

	async resolve(frame: StackFrame | null): Promise<ComponentSource | null> {
		if (!frame) return null;

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

/**
 * Write a `component.json` into every element directory whose element was
 * rendered by React. Returns how many were written and how many carried a
 * source location (zero with React present usually means a production build).
 */
export async function writeComponentFiles(
	pageRoot: string,
	nodes: ElementNode[],
	resolver: SourceResolver,
): Promise<{ written: number; withSource: number }> {
	let written = 0;
	let withSource = 0;
	const visit = async (list: ElementNode[]): Promise<void> => {
		for (const node of list) {
			if (node.react) {
				const file: ComponentFile = {
					tag: node.tag,
					selector: node.selector,
					source: await resolver.resolve(node.react.frame),
					components: await Promise.all(
						node.react.components.map(async (c) => ({
							name: c.name,
							source: await resolver.resolve(c.frame),
						})),
					),
				};
				const out = resolveElementOutput(pageRoot, `${node.dir}/${COMPONENT_FILE}`);
				fs.mkdirSync(path.dirname(out), { recursive: true });
				fs.writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`, "utf8");
				written++;
				if (file.source) withSource++;
			}
			await visit(node.children);
		}
	};
	await visit(nodes);
	return { written, withSource };
}
