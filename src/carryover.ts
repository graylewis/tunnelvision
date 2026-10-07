import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	ELEMENT_MANIFEST,
	PAGE_IMAGE,
	STYLE_MANIFEST,
	readElementManifest,
	type ElementManifest,
	type ElementNode,
	type RawElement,
} from "./elements.js";
import { changedLines, fileAt, firstParentShas, repoPrefix } from "./git.js";
import { matchElements, type MatchOptions } from "./matching.js";
import type { Paths } from "./paths.js";
import { versionDir } from "./paths.js";
import { realpath, type ComponentFile, type ComponentSource } from "./reactsource.js";
import { LineMapper } from "./remap.js";
import { changedSelectors } from "./changedrules.js";
import { readStyleManifest, type DeclRef, type ElementStyles, type SourceLoc, type StyleManifest, type StyleRule, type Winner } from "./styles.js";
import { listVersions, versionRev, type VersionMeta } from "./versions.js";

/**
 * Carry a page's capture over from an earlier Version instead of reading it
 * again (see docs/adr/0007-carry-over-unchanged-elements.md and
 * docs/adr/0008-cheat-mode-is-opt-in-and-validated.md).
 *
 * The reference is the nearest ancestor Version. Every source location taken
 * from it is remapped exactly through the git diff to the new commit, or not
 * taken at all.
 */

/** Per-page record of how a page was captured, so a later Version can tell whether it can reuse it. */
export const PAGE_RECORD = "capture.json";
/** Written instead of a capture for a page that lands on another page. */
export const REDIRECT_RECORD = "redirect.json";

/** Bumped whenever what a page record vouches for changes meaning. */
const RECORD_VERSION = 1;

export interface PageRecord {
	version: number;
	/** Hash of everything that decides what a capture of this page holds (`settingsHash`). */
	settings: string;
	/** The page's render fingerprint, when it was taken. */
	fingerprint?: string;
	/** The Version the whole page was carried over from (cheat mode). */
	carriedFrom?: string;
}

export interface RedirectRecord {
	/** Where the page landed. */
	url: string;
	/** The slug of the page it landed on. */
	to: string;
}

export function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}

export function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readRedirect(pageDir: string): RedirectRecord | null {
	return readJson<RedirectRecord>(path.join(pageDir, REDIRECT_RECORD));
}

/** A stable hash of `value` (anything JSON-serialisable). */
export function hashOf(value: unknown): string {
	return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Lockfiles: when one changes, installed packages (and the CSS and scripts
 * they ship from outside the repository) may have too, which the diff can't
 * see, so nothing is carried over.
 */
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"];

/** The Version a new capture carries over from, and how to bring its data up to date. */
export interface Reference {
	meta: VersionMeta;
	dir: string;
	mapper: LineMapper;
	/** Selectors of the style rules changed since the reference (see `changedrules.ts`). */
	changedSelectors: string[];
}

/**
 * The nearest ancestor Version to carry over from: a Version already captured
 * under this key, else the newest Version of the nearest first-parent
 * ancestor commit (HEAD included) that has one. `why` explains a null.
 */
export function findReference(
	paths: Paths,
	key: string,
	rev: string | null,
): { reference: Reference | null; why?: string } {
	if (!rev) return { reference: null, why: "this capture can't be diffed (not in git)" };
	const versions = listVersions(paths).filter((v) => versionRev(v));
	const newestFirst = [...versions].reverse();
	let meta = newestFirst.find((v) => v.key === key) ?? null;
	if (!meta) {
		for (const sha of firstParentShas(paths.root)) {
			meta = newestFirst.find((v) => v.sha && sha.startsWith(v.sha)) ?? null;
			if (meta) break;
		}
	}
	if (!meta) return { reference: null, why: "no earlier Version of this branch" };
	const refRev = versionRev(meta) as string;
	const changes = changedLines(paths.root, refRev, rev);
	if (!changes) return { reference: null, why: `can't diff against ${meta.key}` };
	const prefix = repoPrefix(paths.root);
	const mapper = new LineMapper(changes, prefix);
	const lockfile = LOCKFILES.find((f) => mapper.touched(f));
	if (lockfile) return { reference: null, why: `${lockfile} changed since ${meta.key}` };
	const selectors = changedSelectors(changes, (side, file) => fileAt(paths.root, side === "old" ? refRev : rev, file));
	return { reference: { meta, dir: versionDir(paths, meta.key), mapper, changedSelectors: selectors } };
}

// --- remapping ------------------------------------------------------------------

/** Thrown inside a remap when a location can't be placed exactly. */
class Unmappable extends Error {}

function remapLoc(mapper: LineMapper, loc: SourceLoc | null): SourceLoc | null {
	if (!loc) return null;
	const start = mapper.map(loc.path, loc.line);
	if (!start) throw new Unmappable();
	if (loc.endLine === undefined) return { path: start.path, line: start.line };
	const end = mapper.map(loc.path, loc.endLine);
	if (!end || end.path !== start.path) throw new Unmappable();
	return { path: start.path, line: start.line, endLine: end.line };
}

/** A rule with every location remapped, its inline style re-pointed at its element's new selector. */
function remapRule(mapper: LineMapper, rule: StyleRule, selectors: Map<string, string>): StyleRule {
	const out: StyleRule = {
		...rule,
		loc: remapLoc(mapper, rule.loc),
		decls: rule.decls.map((d) => ({ ...d, loc: remapLoc(mapper, d.loc) })),
	};
	if (rule.inline !== undefined) {
		const moved = selectors.get(rule.inline);
		if (!moved) throw new Unmappable();
		out.inline = moved;
	}
	return out;
}

const LOCATION = /^(.*):(\d+):(\d+)$/;

/** A `file:line:col` path remapped, keeping its column. */
function remapPath(mapper: LineMapper, p: string): string {
	const m = p.match(LOCATION);
	if (!m) return p;
	const to = mapper.map(m[1], Number(m[2]));
	if (!to) throw new Unmappable();
	return `${to.path}:${to.line}:${m[3]}`;
}

function remapSource(mapper: LineMapper, root: string, s: ComponentSource | null): ComponentSource | null {
	if (!s || s.generated) return s;
	const p = remapPath(mapper, s.path);
	const [, file, line] = p.match(LOCATION) as RegExpMatchArray;
	const moved = file !== s.path.match(LOCATION)?.[1];
	return {
		...s,
		lineNumber: Number(line),
		path: p,
		...(moved ? { fileName: path.isAbsolute(s.fileName) ? path.join(realpath(root), file) : file } : {}),
	};
}

function remapComponent(mapper: LineMapper, root: string, c: ComponentFile): ComponentFile {
	return {
		...c,
		source: remapSource(mapper, root, c.source),
		components: c.components.map((x) => ({ ...x, source: remapSource(mapper, root, x.source) })),
	};
}

function remapNodes(mapper: LineMapper, root: string, nodes: ElementNode[]): ElementNode[] {
	return nodes.map((n) => {
		const out: ElementNode = { ...n, children: remapNodes(mapper, root, n.children) };
		if (n.component) out.component = remapComponent(mapper, root, n.component);
		if (n.identity) {
			const source = n.identity.source ? remapPath(mapper, n.identity.source) : null;
			out.identity = { ...n.identity, source, file: source ? source.replace(LOCATION, "$1") : n.identity.file };
		}
		return out;
	});
}

// --- whole pages (cheat mode) ---------------------------------------------------

/** The reference's capture of a page, when it was made with the same settings. */
export function referencePage(reference: Reference, slug: string, settings: string): { record: PageRecord; dir: string } | null {
	const dir = path.join(reference.dir, slug);
	const record = readJson<PageRecord>(path.join(dir, PAGE_RECORD));
	if (!record || record.version !== RECORD_VERSION || record.settings !== settings) return null;
	return { record, dir };
}

/**
 * Copy a page's capture from the reference into `outDir` with its source
 * locations remapped, when its fingerprint matches and every location maps
 * exactly. Returns whether it was carried over.
 */
export function carryPage(
	reference: Reference,
	root: string,
	slug: string,
	settings: string,
	fingerprint: string,
	outDir: string,
): boolean {
	const ref = referencePage(reference, slug, settings);
	if (!ref || ref.record.fingerprint !== fingerprint) return false;
	const elements = readElementManifest(path.join(ref.dir, ELEMENT_MANIFEST));
	const styles = readStyleManifest(path.join(ref.dir, STYLE_MANIFEST));
	if (!elements || !styles || !fs.existsSync(path.join(ref.dir, PAGE_IMAGE))) return false;

	let nextElements: ElementManifest;
	let nextStyles: StyleManifest;
	try {
		nextElements = { ...elements, elements: remapNodes(reference.mapper, root, elements.elements) };
		const same = new Map<string, string>();
		const collect = (nodes: ElementNode[]): void => {
			for (const n of nodes) {
				same.set(n.selector, n.selector);
				collect(n.children);
			}
		};
		collect(elements.elements);
		nextStyles = { ...styles, rules: styles.rules.map((r) => remapRule(reference.mapper, r, same)) };
	} catch (err) {
		if (err instanceof Unmappable) return false;
		throw err;
	}

	const dir = path.join(outDir, slug);
	fs.mkdirSync(dir, { recursive: true });
	fs.copyFileSync(path.join(ref.dir, PAGE_IMAGE), path.join(dir, PAGE_IMAGE), fs.constants.COPYFILE_FICLONE);
	writeJson(path.join(dir, ELEMENT_MANIFEST), nextElements);
	fs.writeFileSync(path.join(dir, STYLE_MANIFEST), `${JSON.stringify(nextStyles)}\n`, "utf8");
	const record: PageRecord = { version: RECORD_VERSION, settings, fingerprint, carriedFrom: ref.record.carriedFrom ?? reference.meta.key };
	writeJson(path.join(dir, PAGE_RECORD), record);
	return true;
}

export function pageRecord(settings: string, fingerprint?: string): PageRecord {
	return { version: RECORD_VERSION, settings, ...(fingerprint ? { fingerprint } : {}) };
}

// --- elements in a captured page ------------------------------------------------

/** An element whose style data comes from the reference. */
interface Carried {
	partner: ElementNode;
	styles: ElementStyles;
}

/** Which elements of a freshly captured page need their styles read, and which carry theirs over. */
export interface ElementPlan {
	/** Selectors to read over CDP, or every element. */
	query: string[] | "all";
	carried: Map<ElementNode, Carried>;
	/** Reference rules, remapped, by index in the reference's rule table. */
	rules: Map<number, StyleRule>;
	total: number;
}

function countNodes(nodes: ElementNode[]): number {
	return nodes.reduce((n, node) => n + 1 + countNodes(node.children), 0);
}

/** The reference's element tree and styles for a page, when both exist and were captured with the same settings. */
export function referenceElements(
	reference: Reference | null,
	slug: string,
	settings: string,
): { elements: ElementManifest; styles: StyleManifest } | null {
	if (!reference) return null;
	const ref = referencePage(reference, slug, settings);
	if (!ref) return null;
	const elements = readElementManifest(path.join(ref.dir, ELEMENT_MANIFEST));
	const styles = readStyleManifest(path.join(ref.dir, STYLE_MANIFEST));
	return elements && styles ? { elements, styles } : null;
}

/**
 * The element rule: an element keeps its reference style data when it's
 * paired with a reference element by identity, its tracked computed values
 * are identical, its own JSX line isn't one the commit added, no changed
 * style rule matches it, and every rule its winners come from remaps exactly.
 * Everything else is queried.
 */
export function planElements(input: {
	fresh: ElementNode[];
	raw: RawElement[];
	/** Selectors of fresh elements that a changed style rule matches. */
	changed: Set<string>;
	reference: { elements: ElementManifest; styles: StyleManifest } | null;
	mapper: LineMapper | null;
	match: MatchOptions;
	properties: string[];
}): ElementPlan {
	const { fresh, raw, reference, mapper } = input;
	const total = countNodes(fresh);
	const plan: ElementPlan = { query: "all", carried: new Map(), rules: new Map(), total };
	if (!reference || !mapper) return plan;

	const match = matchElements(reference.elements.elements, fresh, input.match);
	// Reference selector → fresh selector, for inline styles (an element's own, or an ancestor's it inherits from).
	const selectors = new Map<string, string>();
	for (const [from, to] of match.fromTo) selectors.set(from.selector, to.selector);
	const failed = new Set<number>();

	const ruleOk = (index: number): boolean => {
		if (plan.rules.has(index)) return true;
		if (failed.has(index)) return false;
		const rule = reference.styles.rules[index];
		if (!rule) return false;
		try {
			plan.rules.set(index, remapRule(mapper, rule, selectors));
			return true;
		} catch (err) {
			if (!(err instanceof Unmappable)) throw err;
			failed.add(index);
			return false;
		}
	};

	const query: string[] = [];
	const visit = (nodes: ElementNode[], extracted: RawElement[]): void => {
		nodes.forEach((node, i) => {
			const computed = extracted[i]?.computed ?? {};
			if (!carries(node, computed)) query.push(node.selector);
			visit(node.children, extracted[i]?.children ?? []);
		});
	};
	const carries = (node: ElementNode, computed: Record<string, string>): boolean => {
		const partner = match.toFrom.get(node);
		const styles = partner && reference.styles.elements[partner.dir];
		if (!partner || !styles) return false;
		if (input.properties.some((p) => (styles.computed[p] ?? "") !== (computed[p] ?? ""))) return false;
		if (input.changed.has(node.selector)) return false;
		const own = node.component?.source;
		if (own && !own.generated) {
			const m = own.path.match(LOCATION);
			if (m && mapper.added(m[1], Number(m[2]))) return false;
		}
		const refs = Object.values(styles.winners).flatMap((w) => [...(w.decl ? [w.decl] : []), ...(w.via ?? [])]);
		if (!refs.every(([rule]) => ruleOk(rule))) return false;
		plan.carried.set(node, { partner, styles });
		return true;
	};
	visit(fresh, raw);
	plan.query = query;
	return plan;
}

/**
 * The page's `styles.json`: carried elements' winners re-pointed into a new
 * rule table holding the remapped reference rules they use, followed by the
 * freshly located rules (`fresh`) and the winners resolved from them
 * (`resolved`, whose refs index `fresh`).
 */
export function assembleStyles(
	plan: ElementPlan,
	computedOf: (node: ElementNode) => Record<string, string>,
	fresh: { rules: StyleRule[]; elements: Map<ElementNode, ElementStyles> },
): StyleManifest {
	const rules: StyleRule[] = [];
	const index = new Map<number, number>();
	const at = (ref: number): number => {
		let i = index.get(ref);
		if (i === undefined) {
			i = rules.push(plan.rules.get(ref) as StyleRule) - 1;
			index.set(ref, i);
		}
		return i;
	};
	const elements: Record<string, ElementStyles> = {};
	for (const [node, { styles }] of plan.carried) {
		const winners: Record<string, Winner> = {};
		for (const [prop, w] of Object.entries(styles.winners)) {
			const next: Winner = { ...w };
			if (w.decl) next.decl = [at(w.decl[0]), w.decl[1]] as DeclRef;
			if (w.via) next.via = w.via.map(([r, d]) => [at(r), d] as DeclRef);
			winners[prop] = next;
		}
		const computed = computedOf(node);
		elements[node.dir] = {
			computed: Object.fromEntries(Object.keys(styles.computed).map((p) => [p, computed[p] ?? ""])),
			winners,
		};
	}
	const offset = rules.length;
	rules.push(...fresh.rules);
	const shift = ([r, d]: DeclRef): DeclRef => [r + offset, d];
	for (const [node, s] of fresh.elements) {
		const winners: Record<string, Winner> = {};
		for (const [prop, w] of Object.entries(s.winners)) {
			winners[prop] = { ...w, ...(w.decl ? { decl: shift(w.decl) } : {}), ...(w.via ? { via: w.via.map(shift) } : {}) };
		}
		elements[node.dir] = { computed: s.computed, winners };
	}
	return { version: 1, rules, elements };
}

