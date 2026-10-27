import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decodedMappings, LEAST_UPPER_BOUND, originalPositionFor, type TraceMap } from "@jridgewell/trace-mapping";
import { styleBlocks } from "./changedrules.js";
import { loadMapRef, realpath, rootRelative, toFilePath } from "./reactsource.js";
import { MapChecker, type CssPipeline, type MapProblem, type SheetCheck, type SourceVerdict, type Untraced } from "./stylemaps.js";
import type { RawDecl, RawRange, RawSheet, RawStyles, SourceLoc, StyleDecl, StyleRule } from "./styles.js";

/**
 * Map matched rules back to the files they were written in.
 *
 * A stylesheet is located, in order of preference:
 *   1. through its source map (Vite with `css.devSourcemap`, webpack, ...);
 *   2. as the file it came from, line for line, when its text matches that
 *      file as it is on disk right now. Plain CSS in Vite dev is served
 *      unchanged, and CSS Modules only rename classes, so class names are
 *      ignored in the comparison;
 *   3. for a `<style>` block written in an HTML document, as the block in the
 *      document's file whose text is exactly the sheet's. Found by its text
 *      rather than where the browser says it starts, since a dev server that
 *      injects into the HTML shifts every line after the injection;
 *   4. not at all. Its rules still take part in the cascade, just without a
 *      source line.
 *
 * A map is only trusted as far as `stylemaps.ts` finds it points at the files
 * on disk. Positions in a file whose map is broken get no line rather than a
 * wrong one, and their rules record why (`StyleRule.untraced`).
 */

interface MapMapping {
	kind: "map";
	map: TraceMap;
	sources: Map<string, SourceVerdict>;
	/** The map's copy of each source, by line. */
	copies: Map<string, string[]>;
	/**
	 * Most generated lines have no mapping, as in Turbopack's CSS maps, where
	 * only rules are mapped. A position on an unmapped line then belongs to
	 * the nearest mapping before it.
	 */
	sparse: boolean;
}

/** A `<style>` block in its document's file: `line` is the 0-based line its text starts on. */
interface BlockMapping {
	kind: "block";
	path: string;
	line: number;
}

type SheetMapping = MapMapping | { kind: "file"; path: string } | BlockMapping | { kind: "none"; untraced: Untraced };

type Position = { path: string; line: number } | { untraced: Untraced } | null;

/**
 * A position in a map's copy of a source. `before`: found from the nearest
 * mapping before the one asked for. Turbopack's CSS maps place a rule's
 * start on the previous rule's closing line, with nothing on the rule's own
 * lines.
 */
interface CopyPosition {
	source: string;
	/** 1-based. */
	line: number;
	column: number;
	before: boolean;
}

/**
 * Walk the text of a rule from its start in `lines` (1-based `line`),
 * calling `visit` with each line's text at the rule's top nesting level
 * (depth 1), until the rule's closing brace. Returns where that brace is.
 */
function walkRule(
	lines: string[],
	line: number,
	column: number,
	visit?: (text: string, line: number, offset: number) => boolean,
): { line: number; column: number } | null {
	let depth = 0;
	for (let i = line - 1; i < lines.length; i++) {
		const offset = i === line - 1 ? column : 0;
		const text = lines[i].slice(offset);
		if (depth === 1 && visit?.(text, i + 1, offset)) return null;
		for (let c = 0; c < text.length; c++) {
			if (text[c] === "{") depth++;
			else if (text[c] === "}" && --depth <= 0) return { line: i + 1, column: offset + c };
		}
	}
	return null;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Class names ignored when comparing a sheet with its file (CSS Modules rename them). */
const CLASS_NAME = /\.-?[A-Za-z_][\w-]*/g;

function normalizedLines(text: string): string[] {
	return text
		.replace(/\/\*#\s*sourceMappingURL=[^*]*\*\/\s*$/, "")
		.replace(/\r\n/g, "\n")
		.trimEnd()
		.split("\n")
		.map((line) => line.replace(CLASS_NAME, ".C").trimEnd());
}

/** Whether a served stylesheet is its source file line for line. */
export function sameLines(served: string, file: string): boolean {
	const a = normalizedLines(served);
	const b = normalizedLines(file);
	return a.length === b.length && a.every((line, i) => line === b[i]);
}

/**
 * The 0-based line of `file` a `<style>` block's text starts on: the block
 * whose text is exactly the sheet's or, of several, the one starting where the
 * browser says the sheet does. Null when no single block is the sheet.
 */
export function blockLine(file: string, sheet: Pick<RawSheet, "text" | "startLine">): number | null {
	// The HTML parser turns CRLF into LF before the browser sees the text.
	const same = styleBlocks(file.replace(/\r\n/g, "\n")).filter((b) => b.css === sheet.text);
	const block = same.length === 1 ? same[0] : same.find((b) => b.startLine - 1 === sheet.startLine);
	return block ? block.startLine - 1 : null;
}

/** The file a URL's path names when it's a directory (`/`, `/docs/`) or an extensionless page: its `index.html`, or `<path>.html`. */
function servedFile(file: string): string {
	try {
		if (fs.statSync(file).isDirectory()) return path.join(file, "index.html");
		return file;
	} catch {
		return path.extname(file) === "" && fs.existsSync(`${file}.html`) ? `${file}.html` : file;
	}
}

/**
 * Bumped when the locations found for the same sheets change, so rules
 * located the old way aren't carried over (see `settingsHash` in `shoot.ts`).
 */
export const LOCATOR_VERSION = 4;

/** How a sheet is named in messages. */
function sheetLabel(sheet: RawSheet, root: string): string {
	if (sheet.devId) return rootRelative(sheet.devId, root);
	return sheet.sourceURL && sheet.startLine === 0 ? sheet.sourceURL : "inline <style>";
}

export class StyleLocator {
	private readonly root: string;
	readonly checker: MapChecker;

	/** `rebuild`: trace through rebuilt PostCSS maps (`workarounds.turbopackPostcssMaps`). */
	constructor(root: string, options: { rebuild?: boolean; pipeline?: CssPipeline } = {}) {
		this.root = realpath(root);
		this.checker = new MapChecker(this.root, { rebuild: options.rebuild ?? false, pipeline: options.pipeline });
	}

	private async mapping(sheet: RawSheet): Promise<{ mapping: SheetMapping; checks: SheetCheck[] }> {
		const label = sheetLabel(sheet, this.root);
		const file =
			sheet.devId ?? (/^(https?|file):\/\//.test(sheet.sourceURL) ? servedFile(toFilePath(sheet.sourceURL, this.root)) : null);
		if (sheet.sourceMapURL) {
			// An inline map's sources are relative to the CSS file, not the page a
			// <style> sits in (Astro puts dev CSS in the page's HTML), where
			// Vite's absolute `/Users/…/global.css` would resolve to a URL.
			const inline = sheet.sourceMapURL.startsWith("data:");
			const base = inline && file ? pathToFileURL(file).href : sheet.sourceURL || (file ? pathToFileURL(file).href : "file:///");
			const map = await loadMapRef(sheet.sourceMapURL, base);
			if (map) return this.checkMap(map, label);
		}
		// Only a sheet known to be one of the project's files is the project's to fix; others (a CDN's, a library's <style>) just get counted.
		const own = file !== null && fs.existsSync(file) && !path.isAbsolute(rootRelative(file, this.root));
		const none = (problem: MapProblem) => ({
			mapping: { kind: "none", untraced: { file: own ? rootRelative(file, this.root) : label, problem } } as SheetMapping,
			checks: [{ sheet: label, ...(own ? { file: rootRelative(file, this.root) } : {}), problem } as SheetCheck],
		});
		if (!file) return none("no-map");
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			return none("no-map");
		}
		// A <style> block written in an HTML document starts partway through it.
		// One Vite put there (`devId`) holds just its file, so it can match the whole file.
		if (!sheet.devId && (sheet.startLine > 0 || (sheet.startColumn ?? 0) > 0)) {
			const line = blockLine(text, sheet);
			if (line !== null) return { mapping: { kind: "block", path: file, line }, checks: [] };
			return none(own ? "not-in-file" : "no-map");
		}
		return sameLines(sheet.text, text) ? { mapping: { kind: "file", path: file }, checks: [] } : none("no-map");
	}

	/** Check each file a sheet's map names. */
	private async checkMap(map: TraceMap, sheet: string): Promise<{ mapping: SheetMapping; checks: SheetCheck[] }> {
		const sources = new Map<string, SourceVerdict>();
		const checks: SheetCheck[] = [];
		for (const [i, resolved] of map.resolvedSources.entries()) {
			if (sources.has(resolved)) continue;
			const verdict = await this.checker.source(resolved, map.sourcesContent?.[i]);
			sources.set(resolved, verdict);
			const file = this.checker.label(toFilePath(resolved, this.root));
			if ("via" in verdict) checks.push({ sheet, file, problem: "postcss-output", patched: true });
			else if (!verdict.ok) checks.push({ sheet, file, problem: verdict.problem, ...(verdict.detail ? { detail: verdict.detail } : {}) });
		}
		const copies = new Map<string, string[]>();
		map.resolvedSources.forEach((resolved, i) => {
			const copy = map.sourcesContent?.[i];
			if (copy != null && !copies.has(resolved)) copies.set(resolved, copy.split(/\r?\n/));
		});
		const lines = decodedMappings(map);
		const sparse = lines.filter((l) => l.length > 0).length < lines.length / 2;
		return { mapping: { kind: "map", map, sources, copies, sparse }, checks };
	}

	/** Check a stylesheet's source map without locating any rules. */
	async check(sheet: RawSheet): Promise<SheetCheck[]> {
		return (await this.mapping(sheet)).checks;
	}

	/** Where served text at a 0-based line came from, in the map's copy of its source. */
	private copyPosition(m: MapMapping, line: number, column: number): CopyPosition | null {
		const pos = originalPositionFor(m.map, { line: line + 1, column });
		if (pos.source && pos.line != null) return { source: pos.source, line: pos.line, column: pos.column ?? 0, before: false };
		if (!m.sparse) return null;
		// Nothing mapped here: the last mapping before it is the start of its rule (or of the block it was moved out of).
		const lines = decodedMappings(m.map);
		for (let i = Math.min(line, lines.length - 1); i >= 0; i--) {
			const seg = lines[i].filter((s) => s.length >= 4 && (i < line || s[0] <= column)).at(-1) as [number, number, number, number] | undefined;
			if (!seg) continue;
			const [, sourceIndex, sourceLine, sourceColumn] = seg;
			return { source: m.map.resolvedSources[sourceIndex], line: sourceLine + 1, column: sourceColumn, before: true };
		}
		return null;
	}

	/** A position in a copy, as a file and line, following a rebuilt map when its source has one. */
	private resolve(m: MapMapping, at: { source: string; line: number; column: number }): Position {
		const verdict = m.sources.get(at.source);
		if (verdict && !verdict.ok) {
			return { untraced: { file: this.checker.label(toFilePath(at.source, this.root)), problem: verdict.problem } };
		}
		if (verdict && "via" in verdict) {
			// The copy is PostCSS's output for the file; its rebuilt map has the rest of the way.
			const asked = { line: at.line, column: at.column };
			let original = originalPositionFor(verdict.via, asked);
			if (!original.source) original = originalPositionFor(verdict.via, { ...asked, bias: LEAST_UPPER_BOUND });
			if (!original.source || original.line == null) return null;
			return { path: rootRelative(toFilePath(original.source, this.root), this.root), line: original.line };
		}
		return { path: rootRelative(toFilePath(at.source, this.root), this.root), line: at.line };
	}

	/** `decl`: the declaration's property, found by name within its rule when only the rule's start is mapped. */
	private position(m: SheetMapping | null, line: number, column: number, decl?: string): Position {
		if (!m) return null;
		if (m.kind === "none") return { untraced: m.untraced };
		if (m.kind === "file") return { path: rootRelative(m.path, this.root), line: line + 1 };
		if (m.kind === "block") return { path: rootRelative(m.path, this.root), line: m.line + line + 1 };
		const at = this.copyPosition(m, line, column);
		if (!at) return null;
		const copy = m.copies.get(at.source);
		if (at.before && decl && copy) {
			const name = new RegExp(`^(\\s*)${escapeRegExp(decl)}\\s*:`);
			walkRule(copy, at.line, at.column, (text, l, offset) => {
				const found = text.match(name);
				if (found) Object.assign(at, { line: l, column: offset + found[1].length });
				return Boolean(found);
			});
		}
		return this.resolve(m, at);
	}

	private loc(m: SheetMapping | null, range: RawRange | null, end?: RawRange | null, decl?: string): SourceLoc | null {
		if (!range) return null;
		const start = this.position(m, range.startLine, range.startColumn, decl);
		if (!start || "untraced" in start) return null;
		let stop: Position = null;
		const at = end && m?.kind === "map" ? this.copyPosition(m, range.startLine, range.startColumn) : null;
		if (at?.before && m?.kind === "map") {
			// A rule placed from the mapping before it ends where its braces close in the copy; the map would give the next rule.
			const copy = m.copies.get(at.source);
			const close = copy && walkRule(copy, at.line, at.column);
			stop = close ? this.resolve(m, { source: at.source, ...close }) : null;
		} else if (end) {
			stop = this.position(m, end.endLine, Math.max(0, end.endColumn - 1));
		}
		return stop && "path" in stop && stop.path === start.path && stop.line >= start.line ? { ...start, endLine: stop.line } : start;
	}

	private start(m: SheetMapping | null, range: RawRange | null): Position {
		return range ? this.position(m, range.startLine, range.startColumn) : null;
	}

	/** Why a rule can't be traced, if a broken map is why: where its selector, or else a declaration, lands. */
	private untraced(m: SheetMapping | null, rule: RawStyles["rules"][number]): Untraced | null {
		for (const range of [rule.selectorRange, ...rule.decls.map((d) => d.range)]) {
			const pos = this.start(m, range);
			if (pos) return "untraced" in pos ? pos.untraced : null;
		}
		return null;
	}

	private decl(m: SheetMapping | null, d: RawDecl): StyleDecl {
		return {
			name: d.name,
			value: d.value,
			...(d.important ? { important: true as const } : {}),
			...(d.longhands ? { longhands: d.longhands } : {}),
			loc: this.loc(m, d.range, null, d.name),
		};
	}

	/**
	 * The page's rule table with source locations, index for index with
	 * `styles.rules`, and the problems found with the page's sheets' maps.
	 */
	async rules(styles: RawStyles): Promise<{ rules: StyleRule[]; checks: SheetCheck[] }> {
		const mappings = new Map<string, SheetMapping>();
		const checks: SheetCheck[] = [];
		for (const sheet of styles.sheets) {
			const found = await this.mapping(sheet);
			mappings.set(sheet.id, found.mapping);
			checks.push(...found.checks);
		}
		const rules = styles.rules.map((r): StyleRule => {
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
