import type { MatchConfig } from "./config.js";
import type { ElementNode } from "./elements.js";

/**
 * Decide which elements correspond between two captures of a page.
 *
 * Elements are paired by the identifiers they carry, never by content: an
 * element's pixels are what we're diffing, and text or images can legitimately
 * move between containers. Identifiers are tried in tiers, strongest first, and
 * each tier runs across every element before the next one starts, so a pair is
 * always made by the strongest identifier available to it:
 *
 *   Across the whole page (so elements can move between containers):
 *     1. configured attributes, e.g. `data-testid` (in config order)
 *     2. `id`, ignoring generated ones (React `useId`, Radix, MUI, ...)
 *   Within a pair of already-matched parents:
 *     3. React `key`, alongside the component that rendered the element
 *     4. component + source file
 *     5. `name` (form controls)
 *     6. source `file:line:col`, a tie-breaker only since lines shift with edits
 *     7. order among siblings that share tag, component and file
 *     8. order among siblings with the same tag
 *
 * A tier only pairs values that are unique on both sides; anything ambiguous
 * falls through to a later tier. Deliberate identifiers also veto: if both
 * elements carry a configured attribute (or a real `id`) and the values differ,
 * they're never paired, whatever else agrees.
 */

/** Which identifier paired two elements. */
export type MatchedBy =
	| `attr:${string}`
	| "id"
	| "key"
	| "component"
	| "name"
	| "source"
	| "order"
	| "tag-order";

export interface ElementMatch {
	/** Baseline element → target element. */
	fromTo: Map<ElementNode, ElementNode>;
	/** Target element → baseline element. */
	toFrom: Map<ElementNode, ElementNode>;
	/** How each pair was made, keyed by the target element. */
	matchedBy: Map<ElementNode, MatchedBy>;
	/** Target elements whose partner sits under a different (matched) parent. */
	moved: Set<ElementNode>;
}

/**
 * Generated ids from common libraries. They're regenerated per render (or per
 * mount order), so they identify nothing across captures.
 */
const GENERATED_IDS: RegExp[] = [
	/:r[0-9a-z]+:/i, // React 18 useId, also inside Radix/Headless UI ids
	/«r[0-9a-z]+»/i, // React 19.0–19.1 useId
	/_r_[0-9a-z]+_/i, // React 19.2+ useId
	/^mui-\d+$/,
	/^headlessui-/,
	/^react-aria\d*-/,
	/^react-select-\d+/,
	/^downshift-\d+/,
	/^ember\d+$/,
];

export interface MatchOptions {
	attributes: string[];
	ignoreIds: RegExp[];
}

/** Compile the `match` config, reporting bad `ignoreIds` patterns clearly. */
export function matchOptions(config: MatchConfig): MatchOptions {
	const ignoreIds = [...GENERATED_IDS];
	for (const pattern of config.ignoreIds ?? []) {
		try {
			ignoreIds.push(new RegExp(pattern));
		} catch (err) {
			throw new Error(`Invalid match.ignoreIds pattern ${JSON.stringify(pattern)}: ${(err as Error).message}`);
		}
	}
	return { attributes: config.attributes ?? [], ignoreIds };
}

export function matchElements(from: ElementNode[], to: ElementNode[], opts: MatchOptions): ElementMatch {
	const fromTo = new Map<ElementNode, ElementNode>();
	const toFrom = new Map<ElementNode, ElementNode>();
	const matchedBy = new Map<ElementNode, MatchedBy>();

	const realId = (n: ElementNode): string | null =>
		n.id && !opts.ignoreIds.some((re) => re.test(n.id!)) ? n.id : null;
	const attr = (n: ElementNode, name: string): string | null => n.identity?.attributes?.[name] ?? null;

	/** Deliberate identifiers that disagree mean these are different elements. */
	const vetoed = (a: ElementNode, b: ElementNode): boolean => {
		for (const name of opts.attributes) {
			const va = attr(a, name);
			const vb = attr(b, name);
			if (va !== null && vb !== null && va !== vb) return true;
		}
		const ia = realId(a);
		const ib = realId(b);
		return ia !== null && ib !== null && ia !== ib;
	};

	const pair = (a: ElementNode, b: ElementNode, by: MatchedBy): void => {
		fromTo.set(a, b);
		toFrom.set(b, a);
		matchedBy.set(b, by);
	};

	const group = (nodes: ElementNode[], sig: (n: ElementNode) => string | null): Map<string, ElementNode[]> => {
		const out = new Map<string, ElementNode[]>();
		for (const n of nodes) {
			const v = sig(n);
			if (v === null) continue;
			const list = out.get(v);
			if (list) list.push(n);
			else out.set(v, [n]);
		}
		return out;
	};

	/** Pair elements whose signature is unique among the unmatched on both sides. */
	const unique = (as: ElementNode[], bs: ElementNode[], sig: (n: ElementNode) => string | null, by: MatchedBy) => {
		const gb = group(bs.filter((n) => !toFrom.has(n)), sig);
		for (const [v, la] of group(as.filter((n) => !fromTo.has(n)), sig)) {
			const lb = gb.get(v);
			if (la.length === 1 && lb?.length === 1 && !vetoed(la[0], lb[0])) pair(la[0], lb[0], by);
		}
	};

	/** Pair the k-th unmatched element with the k-th, among those sharing a signature. */
	const inOrder = (as: ElementNode[], bs: ElementNode[], sig: (n: ElementNode) => string | null, by: MatchedBy) => {
		const gb = group(bs.filter((n) => !toFrom.has(n)), sig);
		for (const [v, la] of group(as.filter((n) => !fromTo.has(n)), sig)) {
			const lb = gb.get(v) ?? [];
			let j = 0;
			for (const a of la) {
				// Skip partners this element may not pair with, keeping the rest in order.
				while (j < lb.length && vetoed(a, lb[j])) j++;
				if (j >= lb.length) break;
				pair(a, lb[j++], by);
			}
		}
	};

	const flatten = (nodes: ElementNode[], out: ElementNode[] = []): ElementNode[] => {
		for (const n of nodes) {
			out.push(n);
			flatten(n.children, out);
		}
		return out;
	};

	// 1–2: deliberate identifiers, across the whole page.
	const allFrom = flatten(from);
	const allTo = flatten(to);
	for (const name of opts.attributes) unique(allFrom, allTo, (n) => attr(n, name), `attr:${name}`);
	unique(allFrom, allTo, realId, "id");

	// 3–8: within matched parents, starting from the page roots. Each child list
	// belongs to exactly one parent, so the order parents are visited in doesn't
	// change the outcome.
	const component = (n: ElementNode) => n.identity?.component ?? null;
	const file = (n: ElementNode) => n.identity?.file ?? null;
	const scoped = (as: ElementNode[], bs: ElementNode[]): void => {
		unique(as, bs, (n) => (n.identity?.key != null ? `${component(n)}\0${n.identity.key}` : null), "key");
		unique(as, bs, (n) => (component(n) || file(n) ? `${n.tag}\0${component(n)}\0${file(n)}` : null), "component");
		unique(as, bs, (n) => (n.identity?.name ? `${n.tag}\0${n.identity.name}` : null), "name");
		unique(as, bs, (n) => (n.identity?.source ? `${n.tag}\0${n.identity.source}` : null), "source");
		inOrder(as, bs, (n) => (component(n) || file(n) ? `${n.tag}\0${component(n)}\0${file(n)}` : null), "order");
		inOrder(as, bs, (n) => n.tag, "tag-order");
	};

	const visited = new Set<ElementNode>();
	const queue: [ElementNode[], ElementNode[]][] = [[from, to]];
	while (queue.length > 0) {
		const [as, bs] = queue.shift()!;
		scoped(as, bs);
		for (const a of as) {
			const b = fromTo.get(a);
			if (b && !visited.has(a)) {
				visited.add(a);
				queue.push([a.children, b.children]);
			}
		}
		// Children of elements matched across the page (moved) are scoped too.
		if (queue.length === 0) {
			for (const [a, b] of fromTo) {
				if (!visited.has(a)) {
					visited.add(a);
					queue.push([a.children, b.children]);
				}
			}
		}
	}

	// An element moved when its parent's partner isn't its partner's parent.
	const parentFrom = new Map<ElementNode, ElementNode | null>();
	const parentTo = new Map<ElementNode, ElementNode | null>();
	const index = (nodes: ElementNode[], parent: ElementNode | null, map: Map<ElementNode, ElementNode | null>) => {
		for (const n of nodes) {
			map.set(n, parent);
			index(n.children, n, map);
		}
	};
	index(from, null, parentFrom);
	index(to, null, parentTo);
	const moved = new Set<ElementNode>();
	for (const [b, a] of toFrom) {
		const pa = parentFrom.get(a) ?? null;
		const pb = parentTo.get(b) ?? null;
		const expected = pa ? (fromTo.get(pa) ?? undefined) : null;
		if (expected !== pb) moved.add(b);
	}

	return { fromTo, toFrom, matchedBy, moved };
}
