import fs from "node:fs";
import path from "node:path";
import { classify, type Role } from "./atoms.js";
import { holdsStyleBlocks, styleBlockSpans } from "./changedrules.js";
import type { AtomsConfig } from "./config.js";
import type { DiffReport, ImageDiff, ImageStatus } from "./diffengine.js";
import { IMAGES_VERSION, STYLE_MANIFEST, type ElementManifest, type ElementNode, type OwnImage } from "./elements.js";
import { publicDir } from "./fileroutes.js";
import { changedLines, fileAt, isGitRepo, repoPrefix, topLevel, type FileChanges } from "./git.js";
import { imageFiles, imageName } from "./imagesource.js";
import type { ElementMatch } from "./matching.js";
import { realpath, type ComponentSource } from "./reactsource.js";
import { LineMapper } from "./remap.js";
import { readMeta, versionRev } from "./versions.js";
import { dataChanges, readRecording, recordingNotes, type DataChange } from "./state.js";
import { versionDir, type Paths } from "./paths.js";
import { pickRepresentative } from "./representative.js";
import { problemReason } from "./stylemaps.js";
import { readStyleManifest, type DeclRef, type ElementStyles, type SourceLoc, type StyleManifest, type StyleRule } from "./styles.js";

/**
 * Code-first correlation: which changed lines caused which visual changes.
 *
 * For every element that changed visually, the tracked properties whose
 * winning declaration changed between versions (its rule, its text, or a
 * `var()` it goes through) point at those declarations. A property whose
 * value changed while its declaration didn't (`width: 100%` in a wider
 * parent) is a result of layout, not a cause. Any of those declarations, or the element's
 * own JSX line, that sits on a changed line is a cause. On the old side
 * (deleted lines) the baseline's winners are used, on the new side (added
 * lines) the target's, so a deleted rule is still found.
 *
 * An element whose content changed is searched for in the changed lines
 * themselves. For its own text (copy), the words it gained are looked for in
 * added lines, the words it lost in deleted ones, in any file but a
 * stylesheet. That finds copy wherever it was written (a JSX text line, a
 * prop, a constants or translations file), which the element's JSX line
 * alone can't. For its own images, the file names of the sources it gained
 * are looked for literally in added lines, and a deleted line holding the
 * name of one it lost points at the added lines that replaced it. An image
 * whose source stayed the same is traced to its file, when that file is a
 * changed binary file or a changed SVG (see
 * docs/adr/0009-changed-binary-files-are-causes.md).
 *
 * Likewise, when a property's winning rule switches to or from a
 * single-class selector (a utility class: `.md\:grid-cols-4` to
 * `.md\:grid-cols-2`), the class it lost is looked for among the tokens a
 * file's deleted lines have more of than its added ones, and the class it
 * gained the other way round, in any file but a stylesheet. A class that's on
 * both sides of an edited line wasn't swapped there.
 * That finds a class swap on whichever line wrote it (a `className` prop
 * passed to a component, a `cn()` call), not just on the element's own JSX
 * line, which for a shared component is inside the component.
 *
 * A new element is caused by its own JSX line, or the call-site line of the
 * component that rendered it, if that line changed. Otherwise it's explained
 * by being new, and linked to its render site: its parent's JSX line, which
 * holds the `.map()` or conditional that rendered it and usually didn't
 * change (the data it maps over did). New elements inside it are explained
 * by it. Removed elements likewise, on the baseline's side. Their text isn't
 * searched for, see docs/adr/0004-new-elements-explained-by-render-site.md.
 *
 * Elements that changed without any tracked property changing are knock-on
 * effects of the nearest ancestor or earlier sibling that has a cause or is
 * new or removed. What's left over is reported as unexplained visual changes,
 * and changed stylesheet lines that caused nothing as invisible changes.
 * Terms as in CONTEXT.md.
 */

/** Diff sides, as GitHub names them: LEFT is the baseline (deleted lines), RIGHT the target (added lines). */
export type Side = "LEFT" | "RIGHT";

export interface PropChange {
	name: string;
	from: string | null;
	to: string | null;
	/** Its winning declaration changed too; otherwise the value is a result of layout or an ancestor. */
	own?: true;
}

/** `new` / `removed`: the new or removed element itself; `inside`: a new or removed element inside it. */
export type EffectVia = "direct" | "inherited" | "var" | "jsx" | "content" | "knock-on" | "new" | "removed" | "inside";

/** A visual change a cause produced. */
export interface Effect {
	page: string;
	/** The element's path in the target (the baseline's, for removed elements). */
	dir: string;
	/** Its path in the baseline, when it differs. */
	fromDir?: string;
	status: ImageStatus;
	/** Tracked properties whose values changed on the element. */
	props: PropChange[];
	via: EffectVia;
	/** Changed pixels, used to pick the representative screenshot. */
	size: number;
	/** Other causes of this element's change, as `path:line` (just `path` for a changed binary file). */
	alsoCausedBy?: string[];
	/** Whether the element is an atom, a part of one or a container (see `atoms.ts`). */
	role?: Role;
	/** The atom a part belongs to, by path on the same side. */
	atom?: string;
}

/** `data`: a line in the code of a unit of state that ran live (see state.ts), whose new data the element shows. */
export type CauseKind = "declaration" | "selector" | "variable" | "jsx" | "content" | "data";

/** What a content cause changed: an element's own text, or one of its own images. */
export type ContentKind = "copy" | "image";

/** A changed line, or a changed binary file, that explains visual changes. */
export interface Cause {
	/** Repository-relative path in the target, as a PR diff names it. */
	path: string;
	/** Absent for a changed binary file, which has no lines. */
	line?: number;
	side: Side;
	kind: CauseKind;
	/** Set when `kind` is `content`. */
	content?: ContentKind;
	/** What's on the line, e.g. `.card { padding: 18px }`. */
	text?: string;
	effects: Effect[];
	/** The effect a PR comment shows: the largest direct effect that isn't an outlier. */
	representative?: Effect;
}

export interface UnexplainedChange {
	page: string;
	dir: string;
	fromDir?: string;
	status: ImageStatus;
	props: PropChange[];
	/** Why no cause was found, when there's a hint (e.g. which rule took over). */
	note?: string;
	/** As on `Effect`. */
	role?: Role;
	atom?: string;
	/**
	 * The unexplained changes inside this element that all of its change comes
	 * from, by path: it changed only because they did, so it's counted with them
	 * rather than as an unexplained change of its own.
	 */
	downstreamOf?: string[];
}

/**
 * New or removed elements with no cause, grouped by their render site, with
 * the elements inside them and their knock-on effects.
 */
export interface RenderSite {
	/** The parent's JSX line, repository-relative in the target; absent when the parent has none. */
	path?: string;
	line?: number;
	/** RIGHT for new elements; LEFT for removed ones, rendered by the baseline's parent. */
	side: Side;
	effects: Effect[];
	/** The effect shown for it: the largest new or removed element that isn't an outlier. */
	representative?: Effect;
}

/** A changed stylesheet line that caused no visual change on any captured element. */
export interface InvisibleChange {
	path: string;
	line: number;
	side: Side;
	/** `not-exercised`: no captured element matched the rule at all (a hover state, another breakpoint, ...). */
	reason: "no-effect" | "not-exercised";
}

export interface Correlation {
	causes: Cause[];
	/** Missing in reports made before render sites existed. */
	renderSites?: RenderSite[];
	unexplained: UnexplainedChange[];
	invisible: InvisibleChange[];
	/** Pages whose captures have no style data, so only JSX lines could be causes. */
	withoutStyles: string[];
}

/** One version's side of a per-element page. */
export interface PageSide {
	manifest: ElementManifest;
	styles: StyleManifest | null;
}

export interface CorrelatePage {
	slug: string;
	from: PageSide;
	to: PageSide;
	match: ElementMatch;
	/** Units of state on the page that ran live because their code changed (paths project-relative). */
	data?: DataChange[];
}

export interface CorrelateInput {
	pages: CorrelatePage[];
	/** Element diffs from `diffVersions`. */
	diffs: ImageDiff[];
	/** Changed lines keyed by repository-relative path in the target. */
	changes: Map<string, FileChanges>;
	/** Project root, which rule and component paths are relative to. */
	root: string;
	/** Repository top level, which `changes` paths are relative to. */
	top: string;
	/** Tracked properties that only count when a declaration sets them (layout results otherwise). */
	layoutProperties?: Set<string>;
	/** The directory served at the site's root, relative to `root` (default `public`). */
	publicDir?: string;
	/** Components whose root is an atom whatever it holds (`atoms.components` in config). */
	atomComponents?: ReadonlySet<string>;
	/**
	 * The 1-based line spans of `<style>` blocks in changed files that can hold
	 * them, per side, by repository path. Lines inside them are CSS; the rest
	 * of the file is markup.
	 */
	styleBlocks?: Record<Side, Map<string, Array<[number, number]>>>;
}

const VISUAL: Set<ImageStatus> = new Set(["changed", "size-mismatch"]);
const STYLESHEET = /\.(css|scss|sass|less|styl|pcss|postcss)$/i;
export const LAYOUT_PROPERTIES = new Set(["width", "height", "min-width", "min-height", "max-width", "max-height"]);
/** Words too common to say which line some copy came from, unless nothing else changed. */
const STOP_WORDS = new Set(["the", "and", "for", "you", "your", "are", "with", "this", "that", "from", "our", "was", "has", "have", "its"]);
/** More changed lines than this containing an element's new copy or class is a coincidence, not a cause. */
const MAX_MATCHING_LINES = 5;
/** Changed pixels this close to an image's box (CSS pixels) still count as inside it. */
const IMAGE_TOLERANCE = 2;

interface Candidate {
	side: Side;
	/** Repository-relative, on that side. */
	path: string;
	/** Absent for a changed binary file. */
	line?: number;
	kind: CauseKind;
	content?: ContentKind;
	via: EffectVia;
	text?: string;
}

/** A cause's location as people read it: `path:line`, or just `path` for a changed binary file. */
export function causeLocation(c: { path: string; line?: number }): string {
	return c.line === undefined ? c.path : `${c.path}:${c.line}`;
}

/** An element with a visual change, and what might explain it. */
interface Changed {
	page: string;
	node: ElementNode;
	/** Target node, or the baseline's for removed elements. */
	fromNode?: ElementNode;
	status: ImageStatus;
	props: PropChange[];
	/** Some property changed because its declaration did, or its content did on a changed line or file, so the change is the element's own. */
	own: boolean;
	size: number;
	note?: string;
	hits: Candidate[];
}

function walk(nodes: ElementNode[], visit: (n: ElementNode, parent: ElementNode | null, prev: ElementNode | null) => void, parent: ElementNode | null = null): void {
	nodes.forEach((n, i) => {
		visit(n, parent, i > 0 ? nodes[i - 1] : null);
		walk(n.children, visit, n);
	});
}

function declText(rule: StyleRule, ref: DeclRef): string {
	const d = rule.decls[ref[1]];
	return `${rule.selector} { ${d.name}: ${d.value}${d.important ? " !important" : ""} }`;
}

/** The words of `text`, lowercased: runs of letters and digits. */
/**
 * Whether copy shows a value from a unit's data: a string of 2+ characters
 * as written, or a number of 2+ digits however it's formatted (`48337` in
 * `$48,337`).
 */
function showsValue(text: string | undefined, v: string | number): boolean {
	if (!text) return false;
	if (typeof v === "number") {
		const digits = String(Math.abs(v)).replace(".", "");
		return digits.length >= 2 && text.replace(/[^\d]/g, "").includes(digits);
	}
	const s = v.trim();
	return s.length >= 2 && text.includes(s);
}

function words(text: string): string[] {
	return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The words of `to` that `from` doesn't have as many of. */
function gained(from: string[], to: string[]): string[] {
	const left = new Map<string, number>();
	for (const w of from) left.set(w, (left.get(w) ?? 0) + 1);
	const out = new Set<string>();
	for (const w of to) {
		const n = left.get(w) ?? 0;
		if (n > 0) left.set(w, n - 1);
		else out.add(w);
	}
	return [...out];
}

/**
 * The tokens of a line of source that could be class names. Class names are
 * written in strings (`className="…"`, `cn("…")`, `cva(…)`), and utilities like
 * `relative` or `hidden` are also English words, so on a line with string
 * literals only their contents count, and comments never do. A line with no
 * strings, like the middle of a multi-line template literal, counts whole.
 */
export function classTokens(text: string): string[] {
	const trimmed = text.trim();
	// Inside a block comment, or opening one that runs onto later lines.
	if (trimmed.startsWith("*") || (trimmed.startsWith("/*") && !trimmed.includes("*/"))) return [];
	let code = "";
	const strings: string[] = [];
	let quote: string | null = null;
	let current = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === "\\") current += text[++i] ?? "";
			else if (ch === quote) {
				strings.push(current);
				[current, quote] = ["", null];
			} else current += ch;
		} else if (ch === '"' || ch === "`" || (ch === "'" && !/[\p{L}\p{N}]/u.test(text[i - 1] ?? ""))) {
			// An apostrophe inside a word (JSX text like "it's") doesn't open a string.
			quote = ch;
		} else if (ch === "/" && text[i + 1] === "/") {
			break;
		} else if (ch === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			if (end < 0) break;
			i = end + 1;
		} else code += ch;
	}
	// A string still open at the end of the line continues onto the next.
	if (quote) strings.push(current);
	return (strings.length ? strings.join(" ") : code).split(/[\s"'`]+/).filter(Boolean);
}

/** `\:` to `:`, `\32 ` to `2`: a CSS identifier as written in markup. */
function unescapeCss(ident: string): string {
	return ident.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([\s\S])/g, (_, hex: string | undefined, ch: string | undefined) =>
		hex ? String.fromCodePoint(parseInt(hex, 16)) : (ch ?? ""),
	);
}

/** A single class, then any pseudo-classes and a pseudo-element: `.md\:p-4`, `.hover\:x:hover`, `.a::before`. */
const SINGLE_CLASS = /^\.((?:\\[0-9a-fA-F]{1,6}[ \t\n\r\f]?|\\[^\n\r\f0-9a-fA-F]|[\w-]|[^\x00-\x7f])+)(?:::?[\w-]+(?:\([^()]*\))?)*$/;

/** The class name a single-class selector targets, unescaped; null for any other selector. */
export function utilityClass(selector: string): string | null {
	const m = SINGLE_CLASS.exec(selector.trim());
	return m ? unescapeCss(m[1]) : null;
}

/** The words worth searching changed lines for: the distinctive ones, or all of them if none are. */
function searchTerms(ws: string[]): string[] {
	const distinctive = ws.filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
	return distinctive.length ? distinctive : ws;
}

/** Whether `text` holds the file name `name` as a whole, not inside a longer name (`a.png` in `data.png`). */
function holdsName(text: string, name: string): boolean {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|[^\\w.-])${escaped}(?:$|[^\\w.-])`).test(text);
}

/** The words two lines share, as a share of the first's: how much `b` reads like a rewrite of `a`. */
function likeness(a: Set<string>, b: Set<string>): number {
	return a.size ? [...a].filter((w) => b.has(w)).length / a.size : 0;
}

/** Own images that animate or play, whose pixels can differ between loads with nothing changed. */
function animates(image: OwnImage): boolean {
	return image.tag === "video" || /\.gif$/i.test(imageName(image.src) ?? "");
}

/** `text` in quotes, shortened for a note. */
function quote(text: string): string {
	return JSON.stringify(text.length > 40 ? `${text.slice(0, 39)}…` : text);
}

/** The winning rule's selector, to say which rule took over. */
function winnerSelector(styles: StyleManifest | null, el: ElementStyles | undefined, prop: string): string {
	const ref = el?.winners[prop]?.decl;
	return (ref && styles?.rules[ref[0]]?.selector) || "default";
}

/** A property's winning declaration and the `var()` declarations it goes through, as text. */
function winnerText(styles: StyleManifest | null, el: ElementStyles | undefined, prop: string): string {
	const w = el?.winners[prop];
	if (!styles || !w?.decl) return "";
	const text = (ref: DeclRef) => {
		const rule = styles.rules[ref[0]];
		return rule?.decls[ref[1]] ? declText(rule, ref) : "?";
	};
	return [w.decl, ...(w.via ?? [])].map(text).join(" <- ");
}

/**
 * Hints for the declarations behind a property that come from a stylesheet
 * whose source map is broken, so no changed line could be matched to them.
 */
function untracedHints(styles: StyleManifest | null, el: ElementStyles | undefined, prop: string): string[] {
	const w = el?.winners[prop];
	if (!styles || !w?.decl) return [];
	return [w.decl, ...(w.via ?? [])].flatMap((ref) => {
		const rule = styles.rules[ref[0]];
		return rule?.untraced ? [`${rule.selector} is in ${rule.untraced.file}, which can't be traced: ${problemReason(rule.untraced.problem)}`] : [];
	});
}

export function correlate(input: CorrelateInput): Correlation {
	const layout = input.layoutProperties ?? LAYOUT_PROPERTIES;
	const repoPath = (p: string): string | null => {
		const abs = path.isAbsolute(p) ? realpath(p) : path.join(input.root, p);
		const rel = path.relative(input.top, abs);
		return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : null;
	};

	// Changed lines per side: RIGHT by target path, LEFT by baseline path (mapped back to the target's).
	const added = new Map<string, Map<number, string>>();
	const deleted = new Map<string, { lines: Map<number, string>; path: string }>();
	for (const [p, c] of input.changes) {
		added.set(p, c.added);
		deleted.set(c.oldPath, { lines: c.deleted, path: p });
	}
	/** A changed line, or with no line, a changed binary file. */
	const isChanged = (side: Side, p: string, line: number | undefined) =>
		line === undefined
			? Boolean(side === "RIGHT" ? input.changes.get(p)?.binary : input.changes.get(deleted.get(p)?.path ?? p)?.binary)
			: side === "RIGHT"
				? Boolean(added.get(p)?.has(line))
				: Boolean(deleted.get(p)?.lines.has(line));
	const targetPath = (side: Side, p: string) => (side === "RIGHT" ? p : (deleted.get(p)?.path ?? p));

	/** A changed line inside a `<style>` block of a file that has them. */
	const inStyleBlock = (side: Side, p: string, line: number) =>
		(input.styleBlocks?.[side].get(p) ?? []).some(([start, end]) => line >= start && line <= end);

	// Changed lines copy or class names could be on, with their words: anything but stylesheets and `<style>` blocks.
	// `swapped` is the line's tokens the change added to its file (RIGHT) or removed from it (LEFT).
	type SourceLine = { path: string; line: number; text: string; words: Set<string>; swapped: Set<string> };
	const sourceLines: Record<Side, SourceLine[]> = { LEFT: [], RIGHT: [] };
	const tokenCounts = (lines: Map<number, string>) => {
		const out = new Map<string, number>();
		for (const text of lines.values()) for (const t of classTokens(text)) out.set(t, (out.get(t) ?? 0) + 1);
		return out;
	};
	for (const [p, c] of input.changes) {
		const counts = { RIGHT: tokenCounts(c.added), LEFT: tokenCounts(c.deleted) };
		for (const [side, other, lines, sidePath] of [["RIGHT", "LEFT", c.added, p], ["LEFT", "RIGHT", c.deleted, c.oldPath]] as const) {
			if (STYLESHEET.test(sidePath)) continue;
			const net = (t: string) => (counts[side].get(t) ?? 0) > (counts[other].get(t) ?? 0);
			for (const [line, text] of lines) {
				if (inStyleBlock(side, sidePath, line)) continue;
				sourceLines[side].push({ path: sidePath, line, text, words: new Set(words(text)), swapped: new Set(classTokens(text).filter(net)) });
			}
		}
	}

	const diffByTo = new Map<string, ImageDiff>();
	const diffByFrom = new Map<string, ImageDiff>();
	for (const d of input.diffs) (d.status === "removed" ? diffByFrom : diffByTo).set(d.filename, d);
	const file = (page: string, dir: string) => `${page}/${dir}/element.png`;

	const withoutStyles: string[] = [];
	const changed: Changed[] = [];
	const byNode = new Map<ElementNode, Changed>();
	/** Per page: target node → parent and previous sibling, for knock-on effects. */
	const family = new Map<ElementNode, { parent: ElementNode | null; prev: ElementNode | null }>();
	/** The same for baseline nodes, for removed elements. */
	const fromFamily = new Map<ElementNode, { parent: ElementNode | null; prev: ElementNode | null }>();
	/** Target node → its baseline counterpart. */
	const toFrom = new Map<ElementNode, ElementNode>();
	/** Old-side lines whose new-side counterpart was taken as the cause, as `path:line`. */
	const absorbed = new Set<string>();
	/** Lines that sit inside a rule some element matched, per side, for invisible changes. */
	const ruleLines: Record<Side, Map<string, Array<[number, number]>>> = { LEFT: new Map(), RIGHT: new Map() };

	/**
	 * Each element's role, and the atom it's reported at. Where an atom's
	 * boundary moved between versions (a span became a button), the larger of
	 * the two atoms is used, so the pair isn't split into a removal and an addition.
	 */
	const units = new Map<ElementNode, { role: Role; atom?: ElementNode }>();
	const within = (outer: ElementNode, n: ElementNode) => n.dir === outer.dir || n.dir.startsWith(`${outer.dir}/`);
	const addUnits = (page: CorrelatePage): void => {
		const to = classify(page.to.manifest.elements, input.atomComponents);
		const from = classify(page.from.manifest.elements, input.atomComponents);
		for (const [a, role] of from.role) if (!page.match.fromTo.has(a)) units.set(a, { role, atom: from.atomOf.get(a) });
		for (const b of to.role.keys()) {
			let atom = to.atomOf.get(b);
			const a = page.match.toFrom.get(b);
			const before = a && from.atomOf.get(a);
			const mapped = before && page.match.fromTo.get(before);
			if (mapped && within(mapped, b) && (!atom || (mapped !== atom && within(mapped, atom)))) atom = mapped;
			units.set(b, { role: atom === b ? "atom" : atom ? "part" : "container", atom });
		}
	};
	const unitFields = (n: ElementNode): { role?: Role; atom?: string } => {
		const u = units.get(n);
		if (!u) return {};
		return { role: u.role, ...(u.role === "part" && u.atom ? { atom: u.atom.dir } : {}) };
	};

	const jsx = (side: Side, node: ElementNode | null | undefined, via: EffectVia): Candidate | null => {
		const src: ComponentSource | null | undefined = node?.component?.source;
		if (!src || src.generated) return null;
		const p = repoPath(src.fileName);
		return p ? { side, path: p, line: src.lineNumber, kind: "jsx", via } : null;
	};
	/**
	 * Where the component that rendered `node` was called from. Only the
	 * nearest: an edited `<Layout>` line further up didn't add everything in
	 * it, and elements inside a new component are explained by its root.
	 */
	const callSite = (side: Side, node: ElementNode): Candidate | null => {
		const src = node.component?.components[0]?.source;
		const p = src && !src.generated ? repoPath(src.fileName) : null;
		return p && src ? { side, path: p, line: src.lineNumber, kind: "jsx", via: "jsx" } : null;
	};

	for (const page of input.pages) {
		const fromStyles = page.from.styles;
		const toStyles = page.to.styles;
		if (!fromStyles || !toStyles) withoutStyles.push(page.slug);
		for (const [side, styles] of [["LEFT", fromStyles], ["RIGHT", toStyles]] as const) {
			for (const rule of styles?.rules ?? []) {
				const p = rule.loc && repoPath(rule.loc.path);
				if (!p || !rule.loc) continue;
				const spans = ruleLines[side].get(p) ?? [];
				spans.push([rule.loc.line, rule.loc.endLine ?? rule.loc.line]);
				ruleLines[side].set(p, spans);
			}
		}

		const bySelector: Record<Side, Map<string, ElementNode>> = { LEFT: new Map(), RIGHT: new Map() };
		walk(page.from.manifest.elements, (n, parent, prev) => {
			bySelector.LEFT.set(n.selector, n);
			fromFamily.set(n, { parent, prev });
		});
		walk(page.to.manifest.elements, (n, parent, prev) => {
			bySelector.RIGHT.set(n.selector, n);
			family.set(n, { parent, prev });
		});
		for (const [b, a] of page.match.toFrom) toFrom.set(b, a);
		addUnits(page);

		/** Where a declaration was written. Inline styles point at their element's JSX line. */
		const declLoc = (side: Side, styles: StyleManifest, ref: DeclRef, kind: CauseKind, via: EffectVia): Candidate | null => {
			const rule = styles.rules[ref[0]];
			if (!rule) return null;
			if (rule.inline) {
				const c = jsx(side, bySelector[side].get(rule.inline), via);
				return c && { ...c, text: declText(rule, ref) };
			}
			const loc: SourceLoc | null | undefined = rule.decls[ref[1]]?.loc;
			const p = loc && repoPath(loc.path);
			return p && loc ? { side, path: p, line: loc.line, kind, via, text: declText(rule, ref) } : null;
		};

		const styleCandidates = (side: Side, styles: StyleManifest | null, el: ElementStyles | undefined, prop: string): Candidate[] => {
			const w = styles && el?.winners[prop];
			if (!styles || !w?.decl) return [];
			const out: Candidate[] = [];
			const direct = declLoc(side, styles, w.decl, "declaration", w.inherited ? "inherited" : "direct");
			if (direct) out.push(direct);
			for (const ref of w.via ?? []) {
				const v = declLoc(side, styles, ref, "variable", "var");
				if (v) out.push(v);
			}
			return out;
		};

		/** The lines in `found` from the files that rendered `node` (its component and their callers), or all of them if none are. */
		const nearest = (node: ElementNode, found: SourceLine[]): SourceLine[] => {
			const near = new Set(
				[node.component?.source, ...(node.component?.components ?? []).map((c) => c.source)]
					.map((src) => (src && !src.generated ? repoPath(src.fileName) : null))
					.filter(Boolean),
			);
			const own = found.filter((l) => near.has(l.path));
			return own.length ? own : found;
		};

		/**
		 * Changed lines on `side` holding `terms`: those with the most of them,
		 * narrowed to the files that rendered `node` if any of those qualify,
		 * then to those most made of `text`'s words (copy, rather than code
		 * that happens to share a word with it).
		 */
		const copyLoc = (side: Side, node: ElementNode, terms: string[], text: string[]): Candidate[] => {
			let best = 0;
			let found: SourceLine[] = [];
			for (const l of sourceLines[side]) {
				const score = terms.filter((t) => l.words.has(t)).length;
				if (score > best) [best, found] = [score, [l]];
				else if (score > 0 && score === best) found.push(l);
			}
			found = nearest(node, found);
			const inText = new Set(text);
			const share = (l: (typeof found)[number]) => [...l.words].filter((w) => inText.has(w)).length / l.words.size;
			const top = Math.max(0, ...found.map(share));
			found = found.filter((l) => share(l) === top);
			if (found.length > MAX_MATCHING_LINES) return [];
			return found.map((l) => ({ side, path: l.path, line: l.line, kind: "content", content: "copy", via: "content", text: l.text.trim() }));
		};

		/**
		 * The changed lines of the units whose new data `text` shows (or whose
		 * old data `before` showed), for a change no changed line explains.
		 */
		const dataLoc = (shows: (dc: DataChange) => boolean, content: ContentKind): { left: Candidate[]; right: Candidate[] } => {
			const left: Candidate[] = [];
			const right: Candidate[] = [];
			for (const dc of page.data ?? []) {
				if (!shows(dc)) continue;
				for (const c of dc.causes) {
					const p = repoPath(c.path);
					if (!p || c.line === undefined) continue;
					const text = c.side === "RIGHT" ? input.changes.get(p)?.added.get(c.line) : deleted.get(p)?.lines.get(c.line);
					(c.side === "RIGHT" ? right : left).push({ side: c.side, path: p, line: c.line, kind: "data", content, via: "content", ...(text ? { text: text.trim() } : {}) });
				}
			}
			return { left, right };
		};

		const imageCandidate = (side: Side, path: string, line?: number, text?: string): Candidate => ({
			side,
			path,
			...(line !== undefined ? { line } : {}),
			kind: "content",
			content: "image",
			via: "content",
			...(text !== undefined ? { text } : {}),
		});

		/**
		 * Changed lines that swapped an image source: for each deleted line
		 * holding the name of an image `a` lost, the added line of its hunk
		 * that reads most like it (what replaced it), or the deleted line
		 * itself when the hunk added nothing; then the added lines holding the
		 * name of an image `b` gained. Each narrowed to the files that rendered
		 * the element, if any of those qualify. Replacements come first: that
		 * line changed the value, while a gained name is often only an import.
		 */
		const imageLoc = (a: ElementNode, b: ElementNode, lost: string[], got: string[]): { left: Candidate[]; right: Candidate[] } => {
			const left: Candidate[] = [];
			const right: Candidate[] = [];
			const replaced = nearest(a, sourceLines.LEFT.filter((l) => lost.some((n) => holdsName(l.text, n))));
			const gainedLines = nearest(b, sourceLines.RIGHT.filter((l) => got.some((n) => holdsName(l.text, n))));
			if (replaced.length <= MAX_MATCHING_LINES) {
				for (const l of replaced) {
					const p = targetPath("LEFT", l.path);
					const c = input.changes.get(p);
					const hunk = c?.hunks.find((h) => h.oldCount > 0 && l.line >= h.oldStart && l.line < h.oldStart + h.oldCount);
					let best: { line: number; text: string; score: number } | null = null;
					for (let n = hunk?.newStart ?? 0; c && hunk && n < hunk.newStart + hunk.newCount; n++) {
						const text = c.added.get(n);
						if (text === undefined) continue;
						const score = likeness(l.words, new Set(words(text)));
						if (!best || score > best.score) best = { line: n, text, score };
					}
					if (best) right.push(imageCandidate("RIGHT", p, best.line, best.text.trim()));
					else left.push(imageCandidate("LEFT", l.path, l.line, l.text.trim()));
				}
			}
			if (gainedLines.length <= MAX_MATCHING_LINES) for (const l of gainedLines) right.push(imageCandidate("RIGHT", l.path, l.line, l.text.trim()));
			return { left, right };
		};

		/**
		 * The image file `image` was served from, when it changed: a changed
		 * binary file, or a changed SVG's first changed line (its first deleted
		 * one when it only lost lines).
		 */
		const imageFileLoc = (image: OwnImage): { left: Candidate[]; right: Candidate[] } => {
			for (const abs of imageFiles(image.src, page.to.manifest.url, input.root, input.publicDir)) {
				const p = repoPath(abs);
				const c = p ? input.changes.get(p) : undefined;
				if (!p || !c) continue;
				if (c.binary) return { left: [], right: [imageCandidate("RIGHT", p, undefined, imageName(image.src) ?? undefined)] };
				const first = (lines: Map<number, string>) => Math.min(...lines.keys());
				if (c.added.size) return { left: [], right: [imageCandidate("RIGHT", p, first(c.added), c.added.get(first(c.added))?.trim())] };
				if (c.deleted.size) return { left: [imageCandidate("LEFT", c.oldPath, first(c.deleted), c.deleted.get(first(c.deleted))?.trim())], right: [] };
				break;
			}
			return { left: [], right: [] };
		};

		/** Whether the changed pixels `d` recorded for `node` all lie inside `image`'s box. */
		const changedInside = (d: ImageDiff, node: ElementNode, image: OwnImage): boolean => {
			const box = d.changedBox;
			if (!box) return false;
			const scale = page.to.manifest.scale || 1;
			const [x, y] = [node.box.x + box.x / scale, node.box.y + box.y / scale];
			const [right, bottom] = [x + box.width / scale, y + box.height / scale];
			const t = IMAGE_TOLERANCE;
			const r = image.box;
			return x >= r.x - t && y >= r.y - t && right <= r.x + r.width + t && bottom <= r.y + r.height + t;
		};

		/**
		 * Look for what changed an element's own images, and return a note for
		 * when nothing explains it. Images that hadn't loaded on either side are
		 * unknown, not changed. Captures made before own images were recorded
		 * have nothing to compare.
		 */
		const traceImages = (entry: Changed, d: ImageDiff, a: ElementNode, b: ElementNode): string | null => {
			if ((page.from.manifest.version ?? 0) < IMAGES_VERSION || (page.to.manifest.version ?? 0) < IMAGES_VERSION) return null;
			const before = a.images ?? [];
			const after = b.images ?? [];
			if (!before.length && !after.length) return null;
			for (const [images, side] of [[before, "baseline"], [after, "target"]] as const) {
				const unloaded = images.find((i) => !i.loaded);
				if (unloaded) return `its image (${imageName(unloaded.src) ?? unloaded.src}) hadn't loaded in the ${side}`;
			}
			const named = (images: OwnImage[]) => images.map((i) => imageName(i.src)).filter((n): n is string => Boolean(n));
			const lost = gained(named(after), named(before));
			const got = gained(named(before), named(after));
			const hits = entry.hits.length;
			if (lost.length || got.length) {
				const { left, right } = imageLoc(a, b, lost, got);
				consider(entry, left, right);
				if (entry.hits.length === hits) {
					const named = (values: (string | number)[], names: string[]) => values.some((v) => typeof v === "string" && names.some((n) => holdsName(v, n)));
					const data = dataLoc((dc) => named(dc.added, got) || named(dc.removed, lost), "image");
					consider(entry, data.left, data.right);
				}
				if (entry.hits.length > hits) {
					entry.own = true;
					return null;
				}
				const list = (names: string[]) => (names.length ? names.join(", ") : "none");
				return `its image source changed (${list(lost)} → ${list(got)}) but no changed line holds either name`;
			}
			for (const image of after) {
				const { left, right } = imageFileLoc(image);
				consider(entry, left, right);
			}
			if (entry.hits.length > hits) {
				entry.own = true;
				return null;
			}
			const shown = after.find((i) => !animates(i) && changedInside(d, b, i));
			if (!shown) return null;
			return (
				`pixels changed inside its image (${imageName(shown.src) ?? shown.src}), but neither its source nor its file changed: ` +
				"the file may have changed outside the repo, its pipeline (image service, sharp) may have changed, or something drew over it"
			);
		};

		/**
		 * Changed lines on `side` that added (RIGHT) or removed (LEFT) the class
		 * `cls`, narrowed to the files that rendered `node` if any of those qualify.
		 */
		const classLoc = (side: Side, node: ElementNode, cls: string | null): Candidate[] => {
			if (!cls) return [];
			const found = nearest(
				node,
				sourceLines[side].filter((l) => l.swapped.has(cls)),
			);
			if (found.length > MAX_MATCHING_LINES) return [];
			return found.map((l) => ({ side, path: l.path, line: l.line, kind: "jsx", via: "jsx", text: l.text.trim() }));
		};

		const selectorLoc = (side: Side, styles: StyleManifest | null, el: ElementStyles | undefined, prop: string): Candidate | null => {
			const ref = styles && el?.winners[prop]?.decl;
			const rule = ref && styles?.rules[ref[0]];
			const p = rule?.loc && repoPath(rule.loc.path);
			return p && rule?.loc ? { side, path: p, line: rule.loc.line, kind: "selector", via: "direct", text: rule.selector } : null;
		};

		/**
		 * Keep the candidates that sit on changed lines. A replaced line is both
		 * deleted and added, so old-side hits only count when the new side has
		 * none (a deleted rule, say).
		 */
		const consider = (entry: Changed, left: (Candidate | null)[], right: (Candidate | null)[]) => {
			const hit = (list: (Candidate | null)[]) => list.filter((c): c is Candidate => Boolean(c && isChanged(c.side, c.path, c.line)));
			const onRight = hit(right);
			const onLeft = hit(left);
			if (onRight.length) for (const c of onLeft) absorbed.add(causeLocation(c));
			// A line already found (copy on the element's JSX line, say) keeps what it was found as first.
			const seen = new Set(entry.hits.map((c) => `${c.side}:${causeLocation(c)}`));
			entry.hits.push(...(onRight.length ? onRight : onLeft).filter((c) => !seen.has(`${c.side}:${causeLocation(c)}`)));
		};

		const area = (n: ElementNode | undefined, scale: number) => (n ? Math.round(n.box.width * scale) * Math.round(n.box.height * scale) : 0);
		const sizeOf = (d: ImageDiff, a: ElementNode | undefined, b: ElementNode | undefined) =>
			d.mismatchedPixels ?? Math.max(area(a, page.from.manifest.scale), area(b, page.to.manifest.scale));

		walk(page.to.manifest.elements, (b) => {
			const a = page.match.toFrom.get(b);
			const d = diffByTo.get(file(page.slug, b.dir));
			if (!d || !(VISUAL.has(d.status) || d.status === "added")) return;
			const entry: Changed = { page: page.slug, node: b, fromNode: a, status: d.status, props: [], own: false, size: sizeOf(d, a, b), hits: [] };
			changed.push(entry);
			byNode.set(b, entry);

			if (!a) {
				consider(entry, [], [jsx("RIGHT", b, "jsx"), callSite("RIGHT", b)]);
				return;
			}
			const sa = fromStyles?.elements[a.dir];
			const sb = toStyles?.elements[b.dir];
			const switched: string[] = [];
			const untraced = new Set<string>();
			if (sa && sb) {
				for (const prop of Object.keys(sb.computed)) {
					const before = sa.computed[prop] ?? null;
					const after = sb.computed[prop] ?? null;
					if (before === after) continue;
					if (layout.has(prop) && !sa.winners[prop]?.decl && !sb.winners[prop]?.decl) continue;
					const change: PropChange = { name: prop, from: before, to: after };
					entry.props.push(change);
					// Same declaration, different value: a result of layout or an ancestor, not a cause.
					if (winnerText(fromStyles, sa, prop) === winnerText(toStyles, sb, prop)) continue;
					change.own = true;
					entry.own = true;
					consider(entry, styleCandidates("LEFT", fromStyles, sa, prop), styleCandidates("RIGHT", toStyles, sb, prop));
					for (const hint of [...untracedHints(fromStyles, sa, prop), ...untracedHints(toStyles, sb, prop)]) untraced.add(hint);
					const selA = winnerSelector(fromStyles, sa, prop);
					const selB = winnerSelector(toStyles, sb, prop);
					if (selA !== selB) {
						// A different rule won: its selector (or the markup that made it match) may be what changed.
						consider(entry, [selectorLoc("LEFT", fromStyles, sa, prop)], [selectorLoc("RIGHT", toStyles, sb, prop)]);
						// A utility class swapped in markup: the lost class on a deleted line, the gained one on an added line.
						consider(entry, classLoc("LEFT", a, utilityClass(selA)), classLoc("RIGHT", b, utilityClass(selB)));
						switched.push(`${prop}: ${selA} → ${selB}`);
					}
				}
			}
			const notes: string[] = [];
			if (a.text !== undefined && b.text !== undefined && a.text !== b.text) {
				const before = words(a.text);
				const after = words(b.text);
				const hits = entry.hits.length;
				consider(
					entry,
					copyLoc("LEFT", a, searchTerms(gained(after, before)), before),
					copyLoc("RIGHT", b, searchTerms(gained(before, after)), after),
				);
				if (entry.hits.length === hits) {
					const was = a.text;
					const now = b.text;
					const { left, right } = dataLoc((dc) => dc.added.some((v) => showsValue(now, v)) || dc.removed.some((v) => showsValue(was, v)), "copy");
					consider(entry, left, right);
				}
				if (entry.hits.length > hits) entry.own = true;
				else notes.push(`copy changed (${quote(a.text)} → ${quote(b.text)}) but no changed line has it`);
			}
			const imageNote = traceImages(entry, d, a, b);
			if (imageNote) notes.push(imageNote);
			consider(entry, [jsx("LEFT", a, "jsx")], [jsx("RIGHT", b, "jsx")]);
			// First, since it's the likeliest reason no changed line was found.
			if (untraced.size) notes.unshift(...untraced);
			if (!entry.hits.length && page.data?.length) {
				notes.push(`${page.data.map((dc) => dc.unit).join(", ")} ran live on this page because its code changed`);
			}
			if (switched.length) notes.push(`winner changed (${switched.slice(0, 3).join("; ")}${switched.length > 3 ? "; …" : ""})`);
			if (notes.length) entry.note = notes.join("; ");
		});

		walk(page.from.manifest.elements, (a) => {
			if (page.match.fromTo.has(a)) return;
			const d = diffByFrom.get(file(page.slug, a.dir));
			if (!d) return;
			const entry: Changed = { page: page.slug, node: a, status: d.status, props: [], own: false, size: sizeOf(d, a, undefined), hits: [] };
			changed.push(entry);
			byNode.set(a, entry);
			consider(entry, [jsx("LEFT", a, "jsx"), callSite("LEFT", a)], []);
		});
	}

	// New and removed elements with no cause are explained by being new or
	// removed, and the new or removed elements inside them by them.
	/** What a change resolves to: changed lines, or the new or removed element it's inside or a knock-on effect of. */
	type Reason = Candidate | { element: Changed };
	const reasonKey = (r: Reason) =>
		"element" in r ? `element:${r.element.page}:${r.element.status}:${r.element.node.dir}` : `${r.side}:${causeLocation(r)}`;
	/** The reasons each change resolves to: its own hits, its new or removed element, or those of its knock-on source. */
	const resolved = new Map<Changed, Reason[]>();
	for (const entry of changed) if (entry.hits.length) resolved.set(entry, entry.hits);
	const entryOf = (n: ElementNode | null | undefined) => (n ? byNode.get(n) : undefined);
	const fresh = (e: Changed) => e.status === "added" || e.status === "removed";
	const parentOf = (e: Changed) => (e.status === "removed" ? fromFamily : family).get(e.node)?.parent ?? null;
	/** New or removed elements inside another one that explains them. */
	const inside = new Set<Changed>();
	// Parents come before their children in `changed`, so an outer element is resolved first.
	for (const entry of changed) {
		if (!fresh(entry) || resolved.has(entry)) continue;
		const up = entryOf(parentOf(entry));
		if (up && up.status === entry.status && resolved.has(up)) {
			resolved.set(entry, resolved.get(up)!);
			inside.add(entry);
		} else {
			resolved.set(entry, [{ element: entry }]);
		}
	}

	// Knock-on effects: changes with no cause and no change of their own come
	// from nearby changes that have one, going by geometry:
	//   - an element that moved or resized was pushed: by the nearest earlier
	//     sibling (of it or an ancestor) that resized or is new or removed,
	//     else by the nearest ancestor that moved, resized or changed itself;
	//     failing both, one that resized in a parent that didn't was squeezed
	//     by siblings on either side that resized or are new or removed;
	//   - an element whose box stayed put changed because of its content:
	//     its descendants' reasons, removed children included.
	// Either falls back to the other. Knock-on effects can explain each other,
	// so this repeats until nothing new is resolved.
	const children = new Map<ElementNode, ElementNode[]>();
	for (const [n, f] of family) if (f.parent) children.set(f.parent, [...(children.get(f.parent) ?? []), n]);
	const fromChildren = new Map<ElementNode, ElementNode[]>();
	for (const [n, f] of fromFamily) if (f.parent) fromChildren.set(f.parent, [...(fromChildren.get(f.parent) ?? []), n]);
	const resized = (e: Changed) =>
		Boolean(e.fromNode && (e.fromNode.rect.width !== e.node.rect.width || e.fromNode.rect.height !== e.node.rect.height));
	const moved = (e: Changed) => Boolean(e.fromNode && (e.fromNode.rect.x !== e.node.rect.x || e.fromNode.rect.y !== e.node.rect.y));
	const removed = (n: ElementNode) => {
		const e = entryOf(n);
		return e?.status === "removed" ? e : undefined;
	};

	const pushedBy = (node: ElementNode): Reason[] | undefined => {
		for (let n: ElementNode | null = node; n; n = family.get(n)?.parent ?? null) {
			for (let s = family.get(n)?.prev ?? null; s; s = family.get(s)?.prev ?? null) {
				const e = entryOf(s);
				if (e && (resized(e) || e.status === "added") && resolved.has(e)) return resolved.get(e);
			}
			// Earlier siblings that were removed, which only the baseline has.
			const a = toFrom.get(n);
			for (let s = (a && fromFamily.get(a)?.prev) ?? null; s; s = fromFamily.get(s)?.prev ?? null) {
				const e = removed(s);
				if (e && resolved.has(e)) return resolved.get(e);
			}
			const up = entryOf(family.get(n)?.parent);
			if (up && resolved.has(up) && (moved(up) || resized(up) || up.own)) return resolved.get(up);
		}
		return undefined;
	};
	const sameSize = (a: ElementNode, b: ElementNode) => a.rect.width === b.rect.width && a.rect.height === b.rect.height;
	/** A parent that kept its size shared space out among its children, so a sibling that grew (or came or went) took it. */
	const squeezedBy = (entry: Changed): Reason[] | undefined => {
		const parent = family.get(entry.node)?.parent;
		const before = parent && toFrom.get(parent);
		if (!parent || !before || !sameSize(before, parent) || !resized(entry)) return undefined;
		const out: Reason[] = [];
		for (const s of children.get(parent) ?? []) {
			const e = entryOf(s);
			if (e && e !== entry && (resized(e) || e.status === "added")) out.push(...(resolved.get(e) ?? []));
		}
		for (const s of fromChildren.get(before) ?? []) {
			const e = removed(s);
			if (e) out.push(...(resolved.get(e) ?? []));
		}
		return out.length ? out : undefined;
	};
	const fromContent = (n: ElementNode): Reason[] => {
		const out: Reason[] = [];
		for (const child of children.get(n) ?? []) {
			const e = entryOf(child);
			out.push(...((e && resolved.get(e)) ?? fromContent(child)));
		}
		const a = toFrom.get(n);
		for (const child of (a && fromChildren.get(a)) ?? []) {
			const e = removed(child);
			if (e) out.push(...(resolved.get(e) ?? []));
		}
		return out;
	};

	const knockOn = new Set<Changed>();
	for (let progress = true; progress; ) {
		progress = false;
		for (const entry of changed) {
			if (resolved.has(entry) || entry.own || !family.has(entry.node)) continue;
			const geometry = moved(entry) || resized(entry);
			const content = () => {
				const below = fromContent(entry.node);
				return below.length ? below : undefined;
			};
			const found = geometry ? (pushedBy(entry.node) ?? squeezedBy(entry) ?? content()) : (content() ?? pushedBy(entry.node));
			if (found) {
				resolved.set(entry, [...new Map(found.map((r) => [reasonKey(r), r])).values()]);
				knockOn.add(entry);
				progress = true;
			}
		}
	}

	const effectOf = (entry: Changed, via: EffectVia): Effect => ({
		page: entry.page,
		dir: entry.node.dir,
		...(entry.fromNode && entry.fromNode.dir !== entry.node.dir ? { fromDir: entry.fromNode.dir } : {}),
		status: entry.status,
		props: entry.props,
		via,
		size: entry.size,
		...unitFields(entry.node),
	});
	const has = (effects: Effect[], entry: Changed) => effects.some((e) => e.page === entry.page && e.dir === entry.node.dir && e.status === entry.status);

	const causes = new Map<string, Cause>();
	const entryOfEffect = new Map<Effect, Changed>();
	const keyOf = (c: Candidate) => `${c.side}:${causeLocation({ path: targetPath(c.side, c.path), line: c.line })}`;
	const addEffect = (c: Candidate, entry: Changed, via: EffectVia) => {
		const key = keyOf(c);
		let cause = causes.get(key);
		if (!cause) {
			cause = {
				path: targetPath(c.side, c.path),
				...(c.line !== undefined ? { line: c.line } : {}),
				side: c.side,
				kind: c.kind,
				...(c.content ? { content: c.content } : {}),
				text: c.text,
				effects: [],
			};
			causes.set(key, cause);
		}
		if (!has(cause.effects, entry)) {
			const effect = effectOf(entry, via);
			cause.effects.push(effect);
			entryOfEffect.set(effect, entry);
		}
	};

	// A new or removed element's render site is its parent's JSX line. Those
	// without one are grouped by their own JSX line, else listed by themselves.
	const sites = new Map<string, RenderSite>();
	const addSiteEffect = (element: Changed, entry: Changed, via: EffectVia) => {
		const side: Side = element.status === "removed" ? "LEFT" : "RIGHT";
		const at = jsx(side, parentOf(element), "jsx");
		const own = at ? null : jsx(side, element.node, "jsx");
		const key = at ? keyOf(at) : own ? `own:${keyOf(own)}` : `element:${element.page}:${element.status}:${element.node.dir}`;
		let site = sites.get(key);
		if (!site) {
			site = { ...(at ? { path: targetPath(side, at.path), line: at.line } : {}), side, effects: [] };
			sites.set(key, site);
		}
		if (!has(site.effects, entry)) site.effects.push(effectOf(entry, via));
	};

	// An unexplained change can only explain its ancestors by being unexplained
	// itself: one that changed nothing of its own, and whose changed pixels all
	// lie inside unexplained changes below it, is downstream of them.
	const scaleOf = new Map(input.pages.map((p) => [p.slug, p.to.manifest.scale]));
	const unexplainedBelow = (n: ElementNode): Changed[] =>
		(children.get(n) ?? []).flatMap((child) => {
			const e = entryOf(child);
			if (!e) return unexplainedBelow(child);
			return resolved.has(e) ? [] : [e];
		});
	const downstreamOf = (entry: Changed): Changed[] => {
		if (entry.own || entry.status === "removed" || entry.status === "added") return [];
		const below = unexplainedBelow(entry.node);
		if (!below.length) return [];
		const box = diffByTo.get(file(entry.page, entry.node.dir))?.changedBox;
		if (!box) return below;
		const scale = scaleOf.get(entry.page) ?? 1;
		const left = Math.round(entry.node.box.x * scale) / scale + box.x / scale;
		const top = Math.round(entry.node.box.y * scale) / scale + box.y / scale;
		const union = below.reduce(
			(u, e) => ({
				x0: Math.min(u.x0, e.node.box.x),
				y0: Math.min(u.y0, e.node.box.y),
				x1: Math.max(u.x1, e.node.box.x + e.node.box.width),
				y1: Math.max(u.y1, e.node.box.y + e.node.box.height),
			}),
			{ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
		);
		// A pixel of tolerance, for edges rounded differently in the two crops.
		const within = left >= union.x0 - 1 && top >= union.y0 - 1 && left + box.width / scale <= union.x1 + 1 && top + box.height / scale <= union.y1 + 1;
		return within ? below : [];
	};

	const unexplained: UnexplainedChange[] = [];
	for (const entry of changed) {
		const found = resolved.get(entry);
		if (found) {
			for (const r of found) {
				if ("element" in r) {
					const via = r.element === entry ? (entry.status === "removed" ? "removed" : "new") : inside.has(entry) ? "inside" : "knock-on";
					addSiteEffect(r.element, entry, via);
				} else {
					addEffect(r, entry, knockOn.has(entry) ? "knock-on" : inside.has(entry) ? "inside" : r.via);
				}
			}
		} else {
			const below = downstreamOf(entry);
			unexplained.push({
				page: entry.page,
				dir: entry.node.dir,
				...(entry.fromNode && entry.fromNode.dir !== entry.node.dir ? { fromDir: entry.fromNode.dir } : {}),
				status: entry.status,
				props: entry.props,
				...(entry.note ? { note: entry.note } : {}),
				...unitFields(entry.node),
				...(below.length ? { downstreamOf: below.map((e) => e.node.dir) } : {}),
			});
		}
	}
	for (const site of sites.values()) {
		const elements = site.effects.filter((e) => e.via === "new" || e.via === "removed");
		site.representative = pickRepresentative(elements.length ? elements : site.effects, (e) => e.size);
	}

	/** The effect `e` is shown as: its atom's, when it's on a part and the atom changed too. */
	const atomEffect = (cause: Cause, e: Effect): Effect => {
		if (e.role !== "part" || !e.atom) return e;
		const listed = cause.effects.find((x) => x.page === e.page && x.dir === e.atom && (x.status === "removed") === (e.status === "removed"));
		if (listed) return listed;
		const entry = entryOfEffect.get(e);
		const atom = entry && units.get(entry.node)?.atom;
		const atomEntry = atom && byNode.get(atom);
		return atomEntry ? effectOf(atomEntry, e.via) : e;
	};

	// Cross-reference effects that share an element, and pick each cause's screenshot.
	const causesOf = new Map<string, string[]>();
	for (const cause of causes.values()) {
		for (const e of cause.effects) {
			const k = `${e.page}/${e.dir}`;
			causesOf.set(k, [...(causesOf.get(k) ?? []), causeLocation(cause)]);
		}
	}
	for (const cause of causes.values()) {
		const own = causeLocation(cause);
		for (const e of cause.effects) {
			const others = [...new Set(causesOf.get(`${e.page}/${e.dir}`) ?? [])].filter((c) => c !== own);
			if (others.length) e.alsoCausedBy = others;
		}
		// Knock-on effects include containers up to the whole page, so they're
		// only shown when the line changed nothing directly. A part is shown as
		// the atom it belongs to.
		const direct = cause.effects.filter((e) => e.via !== "knock-on");
		const atAtoms = new Map<string, Effect>();
		for (const e of direct.length ? direct : cause.effects) {
			const shown = atomEffect(cause, e);
			atAtoms.set(`${shown.page}/${shown.status}/${shown.dir}`, shown);
		}
		cause.representative = pickRepresentative([...atAtoms.values()], (e) => e.size);
	}

	// Changed stylesheet lines that didn't cause anything.
	const used = new Set([...causes.values()].map((c) => `${c.side}:${c.path}:${c.line}`));
	const invisible: InvisibleChange[] = [];
	const inRule = (side: Side, p: string, line: number) =>
		(ruleLines[side].get(p) ?? []).some(([start, end]) => line >= start && line <= end);
	// In a file whose `<style>` blocks are known, only lines inside them are CSS.
	const cssLine = (side: Side, p: string, line: number) =>
		input.styleBlocks?.[side].has(p)
			? inStyleBlock(side, p, line)
			: STYLESHEET.test(p) || ruleLines.LEFT.has(p) || ruleLines.RIGHT.has(p);
	for (const [p, c] of input.changes) {
		for (const [side, lines, sidePath] of [["RIGHT", c.added, p], ["LEFT", c.deleted, c.oldPath]] as const) {
			for (const line of lines.keys()) {
				if (!cssLine(side, sidePath, line)) continue;
				if (used.has(`${side}:${p}:${line}`) || (side === "LEFT" && absorbed.has(`${sidePath}:${line}`))) continue;
				invisible.push({ path: p, line, side, reason: inRule(side, sidePath, line) ? "no-effect" : "not-exercised" });
			}
		}
	}

	const sorted = [...causes.values()].sort((x, y) => x.path.localeCompare(y.path) || (x.line ?? 0) - (y.line ?? 0) || x.side.localeCompare(y.side));
	invisible.sort((x, y) => x.path.localeCompare(y.path) || x.line - y.line);
	const renderSites = [...sites.values()].sort(
		(x, y) => (x.path ?? "\uffff").localeCompare(y.path ?? "\uffff") || (x.line ?? 0) - (y.line ?? 0) || x.side.localeCompare(y.side),
	);
	return { causes: sorted, renderSites, unexplained, invisible, withoutStyles };
}

/** Correlation input for the per-element pages of a `diffVersions` report, with each side's style data. */
export function correlationPages(report: DiffReport, fromDir: string, toDir: string): CorrelatePage[] {
	return [...(report.pairs ?? new Map())].map(([slug, pair]) => ({
		slug,
		from: { manifest: pair.from, styles: readStyleManifest(path.join(fromDir, slug, STYLE_MANIFEST)) },
		to: { manifest: pair.to, styles: readStyleManifest(path.join(toDir, slug, STYLE_MANIFEST)) },
		match: pair.match,
		data: dataChanges(readRecording(path.join(fromDir, slug)), readRecording(path.join(toDir, slug))),
	}));
}

/**
 * Correlate a `diffVersions` report between versions `from` and `to` with the
 * lines changed between the files they were captured from. Returns a reason
 * instead when that isn't possible.
 */
export function correlateVersions(paths: Paths, report: DiffReport, atomComponents?: ReadonlySet<string>): Correlation | { skipped: string } {
	if (!report.pairs?.size) return { skipped: "no per-element captures on both sides" };
	const revs = versionRevs(paths, report.from, report.to);
	if ("skipped" in revs) return revs;
	const changes = revChanges(paths, revs);
	if ("skipped" in changes) return changes;
	return correlate({
		pages: correlationPages(report, versionDir(paths, report.from), versionDir(paths, report.to)),
		diffs: report.images,
		changes,
		root: realpath(paths.root),
		top: realpath(topLevel(paths.root) ?? paths.root),
		publicDir: publicDir(paths.root),
		atomComponents,
		styleBlocks: changedStyleBlocks(paths, changes, revs),
	});
}

/** The commits versions `from` and `to` were captured from, or why they can't be known. */
function versionRevs(paths: Paths, from: string, to: string): { from: string; to: string } | { skipped: string } {
	if (!isGitRepo(paths.root)) return { skipped: "not a git repository" };
	const [fromRev, toRev] = [from, to].map((key) => {
		const meta = readMeta(paths, key);
		return meta ? versionRev(meta) : null;
	});
	if (!fromRev || !toRev) {
		return { skipped: "a version was captured from uncommitted changes before snapshots existed; re-capture it" };
	}
	return { from: fromRev, to: toRev };
}

function revChanges(paths: Paths, revs: { from: string; to: string }): Map<string, FileChanges> | { skipped: string } {
	return changedLines(paths.root, revs.from, revs.to) ?? { skipped: `couldn't diff ${revs.from.slice(0, 7)}..${revs.to.slice(0, 7)}` };
}

/** Lines changed between the files versions `from` and `to` were captured from, or why they can't be known. */
export function versionChanges(paths: Paths, from: string, to: string): Map<string, FileChanges> | { skipped: string } {
	const revs = versionRevs(paths, from, to);
	return "skipped" in revs ? revs : revChanges(paths, revs);
}

/** Where the `<style>` blocks are in changed files that can hold them, on each side (see `CorrelateInput.styleBlocks`). */
function changedStyleBlocks(
	paths: Paths,
	changes: Map<string, FileChanges>,
	revs: { from: string; to: string },
): Record<Side, Map<string, Array<[number, number]>>> {
	const out: Record<Side, Map<string, Array<[number, number]>>> = { LEFT: new Map(), RIGHT: new Map() };
	for (const [p, c] of changes) {
		for (const [side, rev, file, lines] of [["RIGHT", revs.to, p, c.added], ["LEFT", revs.from, c.oldPath, c.deleted]] as const) {
			if (lines.size === 0 || !holdsStyleBlocks(file)) continue;
			const text = fileAt(paths.root, rev, file);
			if (text !== null) out[side].set(file, styleBlockSpans(text));
		}
	}
	return out;
}

/** Carries source lines of version `from` over to version `to`, for matching their elements; null when that isn't possible. */
export function versionMapper(paths: Paths, from: string, to: string): LineMapper | null {
	const changes = versionChanges(paths, from, to);
	return "skipped" in changes ? null : new LineMapper(changes, repoPrefix(paths.root));
}

/** Add `correlation` (or why it was skipped) to a report. `atoms` is the project's `atoms` config. */
export function addCorrelation(paths: Paths, report: DiffReport, atoms?: AtomsConfig): DiffReport {
	const [from, to] = [readMeta(paths, report.from), readMeta(paths, report.to)];
	if (from && to && from.state !== to.state) {
		const which = !from.state ? `only ${to.key}` : !to.state ? `only ${from.key}` : "both, differently";
		(report.warnings ??= []).push(
			`state plugins replayed data in ${which}: data differences between these versions may not come from code (see docs/adr/0011)`,
		);
	}
	if (to?.state) {
		const dir = versionDir(paths, report.to);
		const state = fs.existsSync(dir)
			? fs.readdirSync(dir)
					.map((page) => ({ page, recording: readRecording(path.join(dir, page)) }))
					.map(({ page, recording }) => ({ page, notes: recording ? recordingNotes(recording) : [] }))
					.filter((p) => p.notes.length)
			: [];
		if (state.length) report.state = state;
	}
	const result = correlateVersions(paths, report, new Set(atoms?.components ?? []));
	if ("skipped" in result) report.correlationSkipped = result.skipped;
	else report.correlation = result;
	return report;
}
