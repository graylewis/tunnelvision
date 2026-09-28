import path from "node:path";
import type { DiffReport, PageDiff, PageStatus } from "./diffengine.js";
import { STYLE_MANIFEST, type ElementManifest, type ElementNode } from "./elements.js";
import { changedLines, isGitRepo, topLevel, type FileChanges } from "./git.js";
import type { ElementMatch } from "./matching.js";
import { realpath, type ComponentSource } from "./reactsource.js";
import { readMeta, versionRev } from "./versions.js";
import { versionDir, type Paths } from "./paths.js";
import { pickRepresentative } from "./representative.js";
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
 * Elements that changed without any tracked property changing are knock-on
 * effects of the nearest ancestor or earlier sibling that has a cause. What's
 * left over is reported as unexplained visual changes, and changed stylesheet
 * lines that caused nothing as invisible changes. Terms as in CONTEXT.md.
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

export type EffectVia = "direct" | "inherited" | "var" | "jsx" | "knock-on";

/** A visual change a cause produced. */
export interface Effect {
	page: string;
	/** The element's path in the target (the baseline's, for removed elements). */
	dir: string;
	/** Its path in the baseline, when it differs. */
	fromDir?: string;
	status: PageStatus;
	/** Tracked properties whose values changed on the element. */
	props: PropChange[];
	via: EffectVia;
	/** Changed pixels, used to pick the representative screenshot. */
	size: number;
	/** Other causes of this element's change, as `path:line`. */
	alsoCausedBy?: string[];
}

export type CauseKind = "declaration" | "selector" | "variable" | "jsx";

/** A changed line that explains visual changes. */
export interface Cause {
	/** Repository-relative path in the target, as a PR diff names it. */
	path: string;
	line: number;
	side: Side;
	kind: CauseKind;
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
	status: PageStatus;
	props: PropChange[];
	/** Why no cause was found, when there's a hint (e.g. which rule took over). */
	note?: string;
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
}

export interface CorrelateInput {
	pages: CorrelatePage[];
	/** Element diffs from `diffVersions`. */
	diffs: PageDiff[];
	/** Changed lines keyed by repository-relative path in the target. */
	changes: Map<string, FileChanges>;
	/** Project root, which rule and component paths are relative to. */
	root: string;
	/** Repository top level, which `changes` paths are relative to. */
	top: string;
	/** Tracked properties that only count when a declaration sets them (layout results otherwise). */
	layoutProperties?: Set<string>;
}

const VISUAL: Set<PageStatus> = new Set(["changed", "size-mismatch"]);
const STYLESHEET = /\.(css|scss|sass|less|styl|pcss|postcss)$/i;
export const LAYOUT_PROPERTIES = new Set(["width", "height", "min-width", "min-height", "max-width", "max-height"]);

interface Candidate {
	side: Side;
	/** Repository-relative, on that side. */
	path: string;
	line: number;
	kind: CauseKind;
	via: EffectVia;
	text?: string;
}

/** An element with a visual change, and what might explain it. */
interface Changed {
	page: string;
	node: ElementNode;
	/** Target node, or the baseline's for removed elements. */
	fromNode?: ElementNode;
	status: PageStatus;
	props: PropChange[];
	/** Some property changed because its declaration did, so the change is the element's own. */
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

export function correlate(input: CorrelateInput): Correlation {
	const layout = input.layoutProperties ?? LAYOUT_PROPERTIES;
	const repoPath = (p: string): string | null => {
		const abs = path.isAbsolute(p) ? realpath(p) : path.join(input.root, p);
		const rel = path.relative(input.top, abs);
		return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : null;
	};

	// Changed lines per side: RIGHT by target path, LEFT by baseline path (mapped back to the target's).
	const added = new Map<string, Set<number>>();
	const deleted = new Map<string, { lines: Set<number>; path: string }>();
	for (const [p, c] of input.changes) {
		added.set(p, c.added);
		deleted.set(c.oldPath, { lines: c.deleted, path: p });
	}
	const isChanged = (side: Side, p: string, line: number) =>
		side === "RIGHT" ? Boolean(added.get(p)?.has(line)) : Boolean(deleted.get(p)?.lines.has(line));
	const targetPath = (side: Side, p: string) => (side === "RIGHT" ? p : (deleted.get(p)?.path ?? p));

	const diffByTo = new Map<string, PageDiff>();
	const diffByFrom = new Map<string, PageDiff>();
	for (const d of input.diffs) (d.status === "removed" ? diffByFrom : diffByTo).set(d.filename, d);
	const file = (page: string, dir: string) => `${page}/${dir}/element.png`;

	const withoutStyles: string[] = [];
	const changed: Changed[] = [];
	const byNode = new Map<ElementNode, Changed>();
	/** Per page: target node → parent and previous sibling, for knock-on effects. */
	const family = new Map<ElementNode, { parent: ElementNode | null; prev: ElementNode | null }>();
	/** Old-side lines whose new-side counterpart was taken as the cause, as `path:line`. */
	const absorbed = new Set<string>();
	/** Lines that sit inside a rule some element matched, per side, for invisible changes. */
	const ruleLines: Record<Side, Map<string, Array<[number, number]>>> = { LEFT: new Map(), RIGHT: new Map() };

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
		walk(page.from.manifest.elements, (n) => bySelector.LEFT.set(n.selector, n));
		walk(page.to.manifest.elements, (n, parent, prev) => {
			bySelector.RIGHT.set(n.selector, n);
			family.set(n, { parent, prev });
		});

		const jsx = (side: Side, node: ElementNode | undefined, via: EffectVia): Candidate | null => {
			const src: ComponentSource | null | undefined = node?.component?.source;
			if (!src || src.generated) return null;
			const p = repoPath(src.fileName);
			return p ? { side, path: p, line: src.lineNumber, kind: "jsx", via } : null;
		};

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
			if (onRight.length) for (const c of onLeft) absorbed.add(`${c.path}:${c.line}`);
			entry.hits.push(...(onRight.length ? onRight : onLeft));
		};

		const area = (n: ElementNode | undefined, scale: number) => (n ? Math.round(n.box.width * scale) * Math.round(n.box.height * scale) : 0);
		const sizeOf = (d: PageDiff, a: ElementNode | undefined, b: ElementNode | undefined) =>
			d.mismatchedPixels ?? Math.max(area(a, page.from.manifest.scale), area(b, page.to.manifest.scale));

		walk(page.to.manifest.elements, (b) => {
			const a = page.match.toFrom.get(b);
			const d = diffByTo.get(file(page.slug, b.dir));
			if (!d || !(VISUAL.has(d.status) || d.status === "added")) return;
			const entry: Changed = { page: page.slug, node: b, fromNode: a, status: d.status, props: [], own: false, size: sizeOf(d, a, b), hits: [] };
			changed.push(entry);
			byNode.set(b, entry);

			if (!a) {
				consider(entry, [], [jsx("RIGHT", b, "jsx")]);
				return;
			}
			const sa = fromStyles?.elements[a.dir];
			const sb = toStyles?.elements[b.dir];
			const switched: string[] = [];
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
					const selA = winnerSelector(fromStyles, sa, prop);
					const selB = winnerSelector(toStyles, sb, prop);
					if (selA !== selB) {
						// A different rule won: its selector (or the markup that made it match) may be what changed.
						consider(entry, [selectorLoc("LEFT", fromStyles, sa, prop)], [selectorLoc("RIGHT", toStyles, sb, prop)]);
						switched.push(`${prop}: ${selA} → ${selB}`);
					}
				}
			}
			consider(entry, [jsx("LEFT", a, "jsx")], [jsx("RIGHT", b, "jsx")]);
			if (switched.length) entry.note = `winner changed (${switched.slice(0, 3).join("; ")}${switched.length > 3 ? "; …" : ""})`;
		});

		walk(page.from.manifest.elements, (a) => {
			if (page.match.fromTo.has(a)) return;
			const d = diffByFrom.get(file(page.slug, a.dir));
			if (!d) return;
			const entry: Changed = { page: page.slug, node: a, status: d.status, props: [], own: false, size: sizeOf(d, a, undefined), hits: [] };
			changed.push(entry);
			consider(entry, [jsx("LEFT", a, "jsx")], []);
		});
	}

	// Knock-on effects: changes with no cause and no change of their own come
	// from nearby changes that have one, going by geometry:
	//   - an element that moved or resized was pushed: by the nearest earlier
	//     sibling (of it or an ancestor) that resized, else by the nearest
	//     ancestor that moved, resized or changed itself;
	//   - an element whose box stayed put changed because of its content:
	//     its descendants' causes.
	// Either falls back to the other. Knock-on effects can explain each other,
	// so this repeats until nothing new is resolved.
	const children = new Map<ElementNode, ElementNode[]>();
	for (const [n, f] of family) if (f.parent) children.set(f.parent, [...(children.get(f.parent) ?? []), n]);
	/** The causes each change resolves to: its own hits, or those of its knock-on source. */
	const resolved = new Map<Changed, Candidate[]>();
	for (const entry of changed) if (entry.hits.length) resolved.set(entry, entry.hits);
	const entryOf = (n: ElementNode | null | undefined) => (n ? byNode.get(n) : undefined);
	const resized = (e: Changed) =>
		Boolean(e.fromNode && (e.fromNode.rect.width !== e.node.rect.width || e.fromNode.rect.height !== e.node.rect.height));
	const moved = (e: Changed) => Boolean(e.fromNode && (e.fromNode.rect.x !== e.node.rect.x || e.fromNode.rect.y !== e.node.rect.y));

	const pushedBy = (node: ElementNode): Candidate[] | undefined => {
		for (let n: ElementNode | null = node; n; n = family.get(n)?.parent ?? null) {
			for (let s = family.get(n)?.prev ?? null; s; s = family.get(s)?.prev ?? null) {
				const e = entryOf(s);
				if (e && resized(e) && resolved.has(e)) return resolved.get(e);
			}
			const up = entryOf(family.get(n)?.parent);
			if (up && resolved.has(up) && (moved(up) || resized(up) || up.own)) return resolved.get(up);
		}
		return undefined;
	};
	const fromContent = (n: ElementNode): Candidate[] => {
		const out: Candidate[] = [];
		for (const child of children.get(n) ?? []) {
			const e = entryOf(child);
			out.push(...((e && resolved.get(e)) ?? fromContent(child)));
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
			const found = geometry ? (pushedBy(entry.node) ?? content()) : (content() ?? pushedBy(entry.node));
			if (found) {
				resolved.set(entry, [...new Map(found.map((c) => [`${c.side}:${c.path}:${c.line}`, c])).values()]);
				knockOn.add(entry);
				progress = true;
			}
		}
	}

	const causes = new Map<string, Cause>();
	const keyOf = (c: Candidate) => `${c.side}:${targetPath(c.side, c.path)}:${c.line}`;
	const addEffect = (c: Candidate, entry: Changed, via: EffectVia) => {
		const key = keyOf(c);
		let cause = causes.get(key);
		if (!cause) {
			cause = { path: targetPath(c.side, c.path), line: c.line, side: c.side, kind: c.kind, text: c.text, effects: [] };
			causes.set(key, cause);
		}
		if (cause.effects.some((e) => e.page === entry.page && e.dir === entry.node.dir)) return;
		cause.effects.push({
			page: entry.page,
			dir: entry.node.dir,
			...(entry.fromNode && entry.fromNode.dir !== entry.node.dir ? { fromDir: entry.fromNode.dir } : {}),
			status: entry.status,
			props: entry.props,
			via,
			size: entry.size,
		});
	};

	const unexplained: UnexplainedChange[] = [];
	for (const entry of changed) {
		const found = resolved.get(entry);
		if (found) {
			for (const c of found) addEffect(c, entry, knockOn.has(entry) ? "knock-on" : c.via);
		} else {
			unexplained.push({
				page: entry.page,
				dir: entry.node.dir,
				...(entry.fromNode && entry.fromNode.dir !== entry.node.dir ? { fromDir: entry.fromNode.dir } : {}),
				status: entry.status,
				props: entry.props,
				...(entry.note ? { note: entry.note } : {}),
			});
		}
	}

	// Cross-reference effects that share an element, and pick each cause's screenshot.
	const causesOf = new Map<string, string[]>();
	for (const cause of causes.values()) {
		for (const e of cause.effects) {
			const k = `${e.page}/${e.dir}`;
			causesOf.set(k, [...(causesOf.get(k) ?? []), `${cause.path}:${cause.line}`]);
		}
	}
	for (const cause of causes.values()) {
		const own = `${cause.path}:${cause.line}`;
		for (const e of cause.effects) {
			const others = [...new Set(causesOf.get(`${e.page}/${e.dir}`) ?? [])].filter((c) => c !== own);
			if (others.length) e.alsoCausedBy = others;
		}
		// Knock-on effects include containers up to the whole page, so they're
		// only shown when the line changed nothing directly.
		const direct = cause.effects.filter((e) => e.via !== "knock-on");
		cause.representative = pickRepresentative(direct.length ? direct : cause.effects, (e) => e.size);
	}

	// Changed stylesheet lines that didn't cause anything.
	const used = new Set([...causes.values()].map((c) => `${c.side}:${c.path}:${c.line}`));
	const invisible: InvisibleChange[] = [];
	const inRule = (side: Side, p: string, line: number) =>
		(ruleLines[side].get(p) ?? []).some(([start, end]) => line >= start && line <= end);
	const stylesheet = (p: string) => STYLESHEET.test(p) || ruleLines.LEFT.has(p) || ruleLines.RIGHT.has(p);
	for (const [p, c] of input.changes) {
		for (const [side, lines, sidePath] of [["RIGHT", c.added, p], ["LEFT", c.deleted, c.oldPath]] as const) {
			if (!stylesheet(sidePath)) continue;
			for (const line of lines) {
				if (used.has(`${side}:${p}:${line}`) || (side === "LEFT" && absorbed.has(`${sidePath}:${line}`))) continue;
				invisible.push({ path: p, line, side, reason: inRule(side, sidePath, line) ? "no-effect" : "not-exercised" });
			}
		}
	}

	const sorted = [...causes.values()].sort((x, y) => x.path.localeCompare(y.path) || x.line - y.line || x.side.localeCompare(y.side));
	invisible.sort((x, y) => x.path.localeCompare(y.path) || x.line - y.line);
	return { causes: sorted, unexplained, invisible, withoutStyles };
}

/** Correlation input for the per-element pages of a `diffVersions` report, with each side's style data. */
export function correlationPages(report: DiffReport, fromDir: string, toDir: string): CorrelatePage[] {
	return [...(report.pairs ?? new Map())].map(([slug, pair]) => ({
		slug,
		from: { manifest: pair.from, styles: readStyleManifest(path.join(fromDir, slug, STYLE_MANIFEST)) },
		to: { manifest: pair.to, styles: readStyleManifest(path.join(toDir, slug, STYLE_MANIFEST)) },
		match: pair.match,
	}));
}

/**
 * Correlate a `diffVersions` report between versions `from` and `to` with the
 * lines changed between the files they were captured from. Returns a reason
 * instead when that isn't possible.
 */
export function correlateVersions(paths: Paths, report: DiffReport): Correlation | { skipped: string } {
	if (!report.pairs?.size) return { skipped: "no per-element captures on both sides" };
	if (!isGitRepo(paths.root)) return { skipped: "not a git repository" };
	const revs = [report.from, report.to].map((key) => {
		const meta = readMeta(paths, key);
		return meta ? versionRev(meta) : null;
	});
	const [fromRev, toRev] = revs;
	if (!fromRev || !toRev) {
		return { skipped: "a version was captured from uncommitted changes before snapshots existed; re-capture it" };
	}
	const changes = changedLines(paths.root, fromRev, toRev);
	if (!changes) return { skipped: `couldn't diff ${fromRev.slice(0, 7)}..${toRev.slice(0, 7)}` };
	return correlate({
		pages: correlationPages(report, versionDir(paths, report.from), versionDir(paths, report.to)),
		diffs: report.pages,
		changes,
		root: realpath(paths.root),
		top: realpath(topLevel(paths.root) ?? paths.root),
	});
}

/** Add `correlation` (or why it was skipped) to a report. */
export function addCorrelation(paths: Paths, report: DiffReport): DiffReport {
	const result = correlateVersions(paths, report);
	if ("skipped" in result) report.correlationSkipped = result.skipped;
	else report.correlation = result;
	return report;
}
