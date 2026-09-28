import { INHERITED, type DeclRef, type RawDecl, type RawMatched, type RawRule, type RawStyles, type ElementStyles, type Winner } from "./styles.js";

/**
 * Work out which declaration won each tracked property on an element.
 *
 * CDP returns an element's matched rules in cascade order (layers in layer
 * order, then specificity and source order), but it doesn't say which
 * declaration won, so we resolve that ourselves:
 *
 *   - normal declarations: the last one that sets the property wins, and
 *     inline styles beat every rule;
 *   - `!important` declarations beat normal ones. Among them, inline beats
 *     layered, which beats unlayered, and earlier layers beat later ones;
 *   - inheritable and custom properties with no winner of their own fall back
 *     to the nearest ancestor that has one;
 *   - `var()` references are followed to the custom property declarations
 *     that supply them.
 *
 * `inherit` is followed like an inherited property. Other CSS-wide keywords
 * (`unset`, `revert`, ...) are marked uncertain rather than modelled.
 */

const KEYWORDS = new Set(["initial", "unset", "revert", "revert-layer"]);
const VAR_REF = /var\(\s*(--[\w-]+)/g;

interface Candidate {
	ref: DeclRef;
	decl: RawDecl;
	/** Sort key: later wins. */
	rank: number[];
}

const sides = (pre: string, post = "") => ["top", "right", "bottom", "left"].map((s) => `${pre}-${s}${post}`);
const corners = ["top-left", "top-right", "bottom-right", "bottom-left"].map((c) => `border-${c}-radius`);

/**
 * Longhands of common shorthands. CDP expands shorthands itself, except when
 * the value contains `var()` (it can't until substitution), so this covers
 * those.
 */
const SHORTHANDS: Record<string, string[]> = {
	margin: sides("margin"),
	padding: sides("padding"),
	inset: ["top", "right", "bottom", "left"],
	"border-width": sides("border", "-width"),
	"border-style": sides("border", "-style"),
	"border-color": sides("border", "-color"),
	border: [...sides("border", "-width"), ...sides("border", "-style"), ...sides("border", "-color")],
	...Object.fromEntries(
		["top", "right", "bottom", "left"].map((s) => [`border-${s}`, [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]]),
	),
	"border-radius": corners,
	outline: ["outline-width", "outline-style", "outline-color"],
	background: ["background-color", "background-image"],
	font: ["font-family", "font-size", "font-style", "font-weight", "line-height"],
	flex: ["flex-grow", "flex-shrink", "flex-basis"],
	"flex-flow": ["flex-direction", "flex-wrap"],
	gap: ["row-gap", "column-gap"],
	overflow: ["overflow-x", "overflow-y"],
	"grid-template": ["grid-template-columns", "grid-template-rows"],
	"text-decoration": ["text-decoration-line"],
	"place-items": ["align-items"],
	"place-content": ["justify-content"],
};

function sets(decl: RawDecl, prop: string): boolean {
	if (decl.name === prop) return true;
	return (decl.longhands ?? SHORTHANDS[decl.name] ?? []).includes(prop);
}

/**
 * The order layers first appear in among one element's matched rules. CDP
 * lists those in cascade order, so this is the layers' cascade order.
 */
function layerOrder(rules: (RawRule | undefined)[]): Map<string, number> {
	const order = new Map<string, number>();
	for (const r of rules) {
		const key = r?.layers?.join(".");
		if (key && !order.has(key)) order.set(key, order.size);
	}
	return order;
}

function compare(a: number[], b: number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

export class Cascade {
	constructor(private readonly styles: RawStyles) {}

	/** The winner for `prop` among one set of matched rules, or null. */
	private winnerAmong(ruleIds: number[], prop: string): Candidate | null {
		let best: Candidate | null = null;
		const layers = layerOrder(ruleIds.map((id) => this.styles.rules[id]));
		ruleIds.forEach((ruleId, position) => {
			const rule = this.styles.rules[ruleId];
			if (!rule) return;
			const layer = rule.layers?.length ? layers.get(rule.layers.join(".")) : undefined;
			rule.decls.forEach((decl, declIndex) => {
				if (!sets(decl, prop)) return;
				const inline = rule.inline !== undefined;
				// Normal: [0, inline, position, index]. Important: [1, tier, -layer, position, index].
				const rank = decl.important
					? [1, inline ? 2 : layer !== undefined ? 1 : 0, layer !== undefined ? -layer : 0, position, declIndex]
					: [0, inline ? 1 : 0, position, declIndex];
				if (!best || compare(rank, best.rank) >= 0) best = { ref: [ruleId, declIndex], decl, rank };
			});
		});
		return best;
	}

	/** The winning declaration for `prop` on `matched`, walking ancestors when it inherits. */
	private resolve(matched: RawMatched, prop: string): { found: Candidate; inherited: boolean } | { found: null; uncertain: boolean } {
		const inherits = prop.startsWith("--") || INHERITED.has(prop);
		const levels = [matched.rules, ...matched.inherited];
		for (let depth = 0; depth < levels.length; depth++) {
			const found = this.winnerAmong(levels[depth], prop);
			if (!found) {
				if (!inherits) break;
				continue;
			}
			const keyword = found.decl.value.trim().toLowerCase();
			if (keyword === "inherit") continue;
			if (KEYWORDS.has(keyword)) return { found: null, uncertain: true };
			return { found, inherited: depth > 0 };
		}
		return { found: null, uncertain: false };
	}

	/**
	 * Resolve the winner of each property in `props` for the element at
	 * `selector`. Elements CDP didn't report, and properties nothing declares,
	 * have no winner.
	 */
	resolveElement(selector: string, props: string[], computed: Record<string, string>): ElementStyles {
		const matched = this.styles.nodes[selector];
		const out: ElementStyles = { computed: {}, winners: {} };
		for (const prop of props) {
			out.computed[prop] = computed[prop] ?? "";
			if (!matched) continue;
			const r = this.resolve(matched, prop);
			if (!r.found) {
				if (r.uncertain) out.winners[prop] = { uncertain: true };
				continue;
			}
			const winner: Winner = { decl: r.found.ref };
			if (r.inherited) winner.inherited = true;
			const via = this.varChain(matched, r.found.decl.value);
			if (via.length) winner.via = via;
			out.winners[prop] = winner;
		}
		return out;
	}

	/** Custom property declarations `value` depends on through `var()`, outermost first. */
	private varChain(matched: RawMatched, value: string, seen = new Set<string>()): DeclRef[] {
		const out: DeclRef[] = [];
		for (const [, name] of value.matchAll(VAR_REF)) {
			if (seen.has(name)) continue;
			seen.add(name);
			const r = this.resolve(matched, name);
			if (!r.found) continue;
			out.push(r.found.ref, ...this.varChain(matched, r.found.decl.value, seen));
		}
		return out;
	}
}
