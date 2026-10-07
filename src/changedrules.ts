import path from "node:path";
import type { FileChanges } from "./git.js";

/**
 * Selectors of the style rules a commit added, edited or deleted.
 *
 * An element whose computed values didn't change can still have a new winning
 * declaration: a rule added elsewhere that sets the same value, say. Carrying
 * its old style data over would then point at the wrong rule, so every
 * element one of these selectors matches is queried again (see
 * docs/adr/0007-carry-over-unchanged-elements.md).
 *
 * The result errs wide: a line that can't be placed in a rule gives `*`, which
 * matches every element. State pseudo-classes and pseudo-elements are dropped
 * from selectors, so `.a:hover::after` matches `.a`.
 */

/** Matches every element. */
export const EVERYTHING = "*";

const STYLESHEET = new Set([".css", ".scss", ".sass", ".less", ".pcss", ".postcss", ".styl"]);
/** Files whose `<style>` blocks hold CSS. */
const WITH_STYLE_BLOCKS = new Set([".astro", ".vue", ".svelte", ".html", ".htm"]);
/** At-rules whose bodies hold rules, so a changed line inside them belongs to one of those. */
const GROUPING = /^@(media|supports|container|layer|scope|document|starting-style)\b/i;
/** At-rules that can't change which declaration wins on an element. */
const INERT = /^@(keyframes|-webkit-keyframes|font-face|property|counter-style|font-feature-values|page)\b/i;
/** Tailwind v4's `@theme` defines custom properties on `:root`. */
const ROOT_LIKE = /^@theme\b/i;

interface Block {
	prelude: string;
	/** 1-based line where the prelude starts. */
	start: number;
	/** Line of the closing brace (Infinity while unclosed). */
	end: number;
	parent: Block | null;
}

/** A stylesheet's blocks, and the lines holding anything but whitespace and comments. */
export interface Scan {
	blocks: Block[];
	content: Set<number>;
}

/** Every `{ … }` block in `css`, with its prelude, outermost first. `lineOffset` is added to every line. */
export function scanBlocks(css: string, lineOffset = 0, lineComments = false): Scan {
	const blocks: Block[] = [];
	const content = new Set<number>();
	const stack: Block[] = [];
	let line = 1 + lineOffset;
	let prelude = "";
	let preludeLine = line;
	for (let i = 0; i < css.length; i++) {
		const ch = css[i];
		if (ch === "\n") {
			line++;
			if (prelude.trim()) prelude += " ";
			continue;
		}
		if (ch === "/" && css[i + 1] === "*") {
			const close = css.indexOf("*/", i + 2);
			const stop = close < 0 ? css.length : close + 2;
			for (let j = i; j < stop; j++) if (css[j] === "\n") line++;
			i = stop - 1;
			continue;
		}
		if (lineComments && ch === "/" && css[i + 1] === "/" && css[i - 1] !== ":") {
			const close = css.indexOf("\n", i);
			i = (close < 0 ? css.length : close) - 1;
			continue;
		}
		if (!/\s/.test(ch)) content.add(line);
		if (ch === '"' || ch === "'") {
			let j = i + 1;
			while (j < css.length && css[j] !== ch && css[j] !== "\n") j += css[j] === "\\" ? 2 : 1;
			if (!prelude.trim()) preludeLine = line;
			prelude += css.slice(i, j + 1);
			i = j;
			continue;
		}
		if (ch === "{") {
			const block: Block = { prelude: prelude.trim(), start: preludeLine, end: Infinity, parent: stack.at(-1) ?? null };
			blocks.push(block);
			stack.push(block);
			prelude = "";
			continue;
		}
		if (ch === "}") {
			const block = stack.pop();
			if (block) block.end = line;
			prelude = "";
			continue;
		}
		if (ch === ";") {
			prelude = "";
			continue;
		}
		if (!prelude.trim() && !/\s/.test(ch)) preludeLine = line;
		prelude += ch;
	}
	return { blocks, content };
}

/** Drop what can't match in a static capture (hover, focus, …) and pseudo-elements, keeping the element they're on. */
export function staticSelector(selector: string): string | null {
	if (/#\{|%[\w-]/.test(selector)) return null; // Sass interpolation or placeholder
	const out = selector
		.replace(/:global\(([^()]*)\)/g, "$1")
		.replace(/::?(before|after|marker|placeholder|selection|first-line|first-letter|backdrop|file-selector-button|-webkit-[\w-]+|-moz-[\w-]+)(\([^()]*\))?/gi, "")
		.replace(/:(hover|focus-visible|focus-within|focus|active|visited|target|checked|indeterminate|placeholder-shown|autofill|popover-open|open)(?![\w-])/gi, "")
		.trim();
	return out
		.split(",")
		.map((s) => s.trim() || "*")
		.join(", ");
}

function nested(selector: string, parent: string): string {
	return selector.includes("&") ? selector.replaceAll("&", `:is(${parent})`) : `:is(${parent}) ${selector}`;
}

/** The selector that a changed line's rule applies through, `*` when unknown, or null when the line can't affect a winner. */
export function selectorAt({ blocks, content }: Scan, line: number): string | null {
	if (!content.has(line)) return null; // blank, or only a comment
	let innermost: Block | null = null;
	for (const b of blocks) if (b.start <= line && line <= b.end && (!innermost || b.start >= innermost.start)) innermost = b;
	// Outside every block: an `@import`, `@tailwind`, `@plugin`, … can change anything; a Sass variable too.
	if (!innermost) return EVERYTHING;

	const chain: Block[] = [];
	for (let b: Block | null = innermost; b; b = b.parent) chain.unshift(b);
	let selector: string | null = null;
	for (const b of chain) {
		if (INERT.test(b.prelude)) return null;
		if (ROOT_LIKE.test(b.prelude)) return ":root";
		if (b.prelude.startsWith("@")) {
			if (!GROUPING.test(b.prelude)) return EVERYTHING; // @utility, @variant, @mixin, …
			continue;
		}
		const own = staticSelector(b.prelude);
		if (own === null) return EVERYTHING;
		selector = selector ? nested(own, selector) : own;
	}
	// A grouping rule's own prelude, or a line directly inside one, can change any rule within it.
	return selector ?? EVERYTHING;
}

/** `<style>` blocks in a component or HTML file: their CSS and the line each starts on. */
export function styleBlocks(source: string): { css: string; startLine: number }[] {
	const out: { css: string; startLine: number }[] = [];
	const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
	for (let m = re.exec(source); m; m = re.exec(source)) {
		const bodyStart = m.index + m[0].indexOf(">") + 1;
		const startLine = source.slice(0, bodyStart).split("\n").length;
		out.push({ css: m[1], startLine });
	}
	return out;
}

/** Whether a file can hold style rules. */
export function holdsStyles(file: string): boolean {
	const ext = path.extname(file).toLowerCase();
	return STYLESHEET.has(ext) || WITH_STYLE_BLOCKS.has(ext);
}

function selectorsIn(file: string, text: string, lines: Map<number, string>, into: Set<string>): void {
	const ext = path.extname(file).toLowerCase();
	const lineComments = ext !== ".css";
	let regions: { scan: Scan; from: number; to: number }[];
	if (STYLESHEET.has(ext)) {
		regions = [{ scan: scanBlocks(text, 0, lineComments), from: 1, to: Infinity }];
	} else {
		regions = styleBlocks(text).map(({ css, startLine }) => ({
			scan: scanBlocks(css, startLine - 1, lineComments),
			from: startLine,
			to: startLine + css.split("\n").length - 1,
		}));
	}
	for (const line of lines.keys()) {
		const region = regions.find((r) => r.from <= line && line <= r.to);
		if (!region) continue; // markup, not CSS
		const sel = selectorAt(region.scan, line);
		if (sel) into.add(sel);
	}
}

/**
 * Selectors of every rule touched by `changes`. `read(rev, path)` returns a
 * file's text on the old (`"old"`) or new (`"new"`) side, by repository path.
 * Unreadable files count as touching everything.
 */
export function changedSelectors(
	changes: Map<string, FileChanges>,
	read: (side: "old" | "new", repoPath: string) => string | null,
): string[] {
	const out = new Set<string>();
	for (const [newPath, c] of changes) {
		if (!holdsStyles(newPath) && !holdsStyles(c.oldPath)) continue;
		for (const [side, file, lines] of [
			["new", newPath, c.added],
			["old", c.oldPath, c.deleted],
		] as const) {
			if (lines.size === 0 || !holdsStyles(file)) continue;
			const text = read(side, file);
			if (text === null) {
				out.add(EVERYTHING);
				continue;
			}
			selectorsIn(file, text, lines, out);
		}
	}
	return out.has(EVERYTHING) ? [EVERYTHING] : [...out].sort();
}
