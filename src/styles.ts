import fs from "node:fs";

/**
 * Style data recorded for every element in per-element captures: the
 * computed value of each tracked property, and the declaration that won it.
 * `correlate.ts` joins these against changed lines to find what caused a
 * visual change (see docs/adr/0001-property-level-correlation.md).
 *
 * The capture driver reads matched rules over CDP and sends them in the `Raw*`
 * shapes below; `cascade.ts` resolves winners from them and `stylesource.ts`
 * maps rule ranges back to source files.
 */

/** A 0-based text range in a stylesheet, as CDP reports it. */
export interface RawRange {
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
}

/** A declaration as written (shorthands keep their longhands, so they can be expanded). */
export interface RawDecl {
	name: string;
	/** Value without any `!important` suffix. */
	value: string;
	important?: boolean;
	/** Longhands a shorthand sets. */
	longhands?: string[];
	/** Null for inline styles, which aren't in a stylesheet. */
	range: RawRange | null;
}

/** A stylesheet the page loaded. */
export interface RawSheet {
	id: string;
	sourceURL: string;
	sourceMapURL: string | null;
	/** Where the sheet starts inside its document, for `<style>` blocks in HTML. */
	startLine: number;
	/** Vite dev's `data-vite-dev-id` on the owning `<style>`: an absolute file path. */
	devId: string | null;
	text: string;
}

/** A matched rule, deduplicated across the page. */
export interface RawRule {
	/** Null for an element's inline style. */
	sheet: string | null;
	/** Selector of an inline style's element, so it can be traced to its JSX line. */
	inline?: string;
	selector: string;
	selectorRange: RawRange | null;
	/** The declaration block, `{` to `}`. */
	styleRange?: RawRange | null;
	/** Enclosing `@layer` names, outermost first. Unlayered rules have none. */
	layers?: string[];
	decls: RawDecl[];
}

/** Rules that apply to one element and each of its ancestors. */
export interface RawMatched {
	/** Indexes into `RawStyles.rules`, in cascade order (the inline style, if any, last). */
	rules: number[];
	/** Rules for each ancestor, nearest first, for inherited properties. */
	inherited: number[][];
}

export interface RawStyles {
	sheets: RawSheet[];
	rules: RawRule[];
	/** Keyed by element selector. */
	nodes: Record<string, RawMatched>;
}

/** Where a rule or declaration was written. `line` is 1-based. */
export interface SourceLoc {
	/** Relative to the project root, like `ComponentSource.path` without the line. */
	path: string;
	line: number;
	/** Last line of a rule, so a changed line can be placed inside it. */
	endLine?: number;
}

export interface StyleDecl {
	name: string;
	value: string;
	important?: true;
	longhands?: string[];
	loc: SourceLoc | null;
}

/** A rule in a page's rule table (`StyleManifest.rules`). */
export interface StyleRule {
	selector: string;
	/** Set for an element's inline style: that element's selector. */
	inline?: string;
	/** The rule's own location (selector through closing brace). */
	loc: SourceLoc | null;
	decls: StyleDecl[];
}

/** `[rule index, declaration index]` into a page's rule table. */
export type DeclRef = [number, number];

/** How a tracked property got its value on an element. */
export interface Winner {
	/** The winning declaration; absent when it couldn't be resolved (`uncertain`). */
	decl?: DeclRef;
	/** The winner is on an ancestor. */
	inherited?: true;
	/** Custom property declarations the winner's value goes through (`var()`), outermost first. */
	via?: DeclRef[];
	/** The cascade couldn't be resolved for sure (`revert`, `unset`, ...). */
	uncertain?: true;
}

/** An element's tracked properties. */
export interface ElementStyles {
	/** Computed value of every tracked property. */
	computed: Record<string, string>;
	/** Only properties some declaration sets; the rest have the browser's defaults. */
	winners: Record<string, Winner>;
}

/** A page's `styles.json`. */
export interface StyleManifest {
	version: 1;
	/** Every rule some element matched, indexed by `DeclRef`s. */
	rules: StyleRule[];
	/** Keyed by element `dir`. */
	elements: Record<string, ElementStyles>;
}

export const STYLE_MANIFEST_VERSION = 1;

/** Read a page's `styles.json`, or null when the capture has none. */
export function readStyleManifest(file: string): StyleManifest | null {
	try {
		const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as StyleManifest;
		return manifest.version === STYLE_MANIFEST_VERSION ? manifest : null;
	} catch {
		return null;
	}
}

/** Write a page's `styles.json`, compactly: it's large and read by tools, not people. */
export function writeStyleManifest(file: string, manifest: StyleManifest): void {
	fs.writeFileSync(file, `${JSON.stringify(manifest)}\n`, "utf8");
}

/** Properties that inherit by default. Custom properties always do. */
export const INHERITED = new Set([
	"color",
	"cursor",
	"direction",
	"font-family",
	"font-size",
	"font-style",
	"font-variant",
	"font-weight",
	"letter-spacing",
	"line-height",
	"list-style-position",
	"list-style-type",
	"text-align",
	"text-indent",
	"text-shadow",
	"text-transform",
	"visibility",
	"white-space",
	"word-spacing",
]);

/**
 * Tracked by default: longhands that paint or lay out an element. Width and
 * height only count when a declaration sets them (see `correlate.ts`),
 * since otherwise they're a result of layout, not a cause.
 */
export const DEFAULT_TRACKED_PROPERTIES = [
	"display",
	"position",
	"top",
	"right",
	"bottom",
	"left",
	"z-index",
	"width",
	"height",
	"min-width",
	"min-height",
	"max-width",
	"max-height",
	"margin-top",
	"margin-right",
	"margin-bottom",
	"margin-left",
	"padding-top",
	"padding-right",
	"padding-bottom",
	"padding-left",
	"border-top-width",
	"border-right-width",
	"border-bottom-width",
	"border-left-width",
	"border-top-style",
	"border-right-style",
	"border-bottom-style",
	"border-left-style",
	"border-top-color",
	"border-right-color",
	"border-bottom-color",
	"border-left-color",
	"border-top-left-radius",
	"border-top-right-radius",
	"border-bottom-right-radius",
	"border-bottom-left-radius",
	"flex-direction",
	"flex-wrap",
	"flex-grow",
	"flex-shrink",
	"flex-basis",
	"justify-content",
	"align-items",
	"align-self",
	"row-gap",
	"column-gap",
	"grid-template-columns",
	"grid-template-rows",
	"color",
	"background-color",
	"background-image",
	"font-family",
	"font-size",
	"font-style",
	"font-weight",
	"line-height",
	"letter-spacing",
	"text-align",
	"text-decoration-line",
	"text-transform",
	"white-space",
	"opacity",
	"transform",
	"box-shadow",
	"outline-style",
	"outline-width",
	"outline-color",
	"overflow-x",
	"overflow-y",
];
