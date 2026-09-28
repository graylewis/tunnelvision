import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { originalPositionFor, type TraceMap } from "@jridgewell/trace-mapping";
import { loadMapRef, realpath, rootRelative, toFilePath } from "./reactsource.js";
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
 *   3. not at all. Its rules still take part in the cascade, just without a
 *      source line.
 */

type SheetMapping = { kind: "map"; map: TraceMap } | { kind: "file"; path: string } | null;

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

export class StyleLocator {
	private readonly root: string;

	constructor(root: string) {
		this.root = realpath(root);
	}

	private async mapping(sheet: RawSheet): Promise<SheetMapping> {
		const file =
			sheet.devId ?? (/^(https?|file):\/\//.test(sheet.sourceURL) ? toFilePath(sheet.sourceURL, this.root) : null);
		if (sheet.sourceMapURL) {
			// An inline map's sources are relative to the CSS file, not the page a
			// <style> sits in (Astro puts dev CSS in the page's HTML), where
			// Vite's absolute `/Users/…/global.css` would resolve to a URL.
			const inline = sheet.sourceMapURL.startsWith("data:");
			const base = inline && file ? pathToFileURL(file).href : sheet.sourceURL || (file ? pathToFileURL(file).href : "file:///");
			const map = await loadMapRef(sheet.sourceMapURL, base);
			if (map) return { kind: "map", map };
		}
		// A <style> block written in an HTML document starts partway through it.
		// One Vite put there (`devId`) holds just its file, so it can still match.
		if (!file || (sheet.startLine > 0 && !sheet.devId)) return null;
		try {
			return sameLines(sheet.text, fs.readFileSync(file, "utf8")) ? { kind: "file", path: file } : null;
		} catch {
			return null;
		}
	}

	private position(m: SheetMapping, line: number, column: number): { path: string; line: number } | null {
		if (!m) return null;
		if (m.kind === "file") return { path: rootRelative(m.path, this.root), line: line + 1 };
		const pos = originalPositionFor(m.map, { line: line + 1, column });
		if (!pos.source || pos.line == null) return null;
		return { path: rootRelative(toFilePath(pos.source, this.root), this.root), line: pos.line };
	}

	private loc(m: SheetMapping, range: RawRange | null, end?: RawRange | null): SourceLoc | null {
		if (!range) return null;
		const start = this.position(m, range.startLine, range.startColumn);
		if (!start) return null;
		const stop = end && this.position(m, end.endLine, Math.max(0, end.endColumn - 1));
		return stop && stop.path === start.path && stop.line >= start.line ? { ...start, endLine: stop.line } : start;
	}

	private decl(m: SheetMapping, d: RawDecl): StyleDecl {
		return {
			name: d.name,
			value: d.value,
			...(d.important ? { important: true as const } : {}),
			...(d.longhands ? { longhands: d.longhands } : {}),
			loc: this.loc(m, d.range),
		};
	}

	/**
	 * The page's rule table with source locations, index for index with
	 * `styles.rules`. `unlocated` counts stylesheets that couldn't be located.
	 */
	async rules(styles: RawStyles): Promise<{ rules: StyleRule[]; unlocated: number }> {
		const mappings = new Map<string, SheetMapping>();
		for (const sheet of styles.sheets) mappings.set(sheet.id, await this.mapping(sheet));
		const rules = styles.rules.map((r): StyleRule => {
			const m = r.sheet ? (mappings.get(r.sheet) ?? null) : null;
			return {
				selector: r.selector,
				...(r.inline ? { inline: r.inline } : {}),
				loc: this.loc(m, r.selectorRange, r.styleRange),
				decls: r.decls.map((d) => this.decl(m, d)),
			};
		});
		const unlocated = [...mappings.values()].filter((m) => !m).length;
		return { rules, unlocated };
	}
}
