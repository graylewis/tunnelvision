import { physicalName } from "./logical.js";
import { INHERITED } from "./styles.js";
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
 *
 * Logical and physical longhands for the same box side cascade together
 * (`padding-inline-start` and `padding-left`, say): a declaration of either
 * sets both, mapped by the element's own `writing-mode` and `direction`.
 */
const KEYWORDS = new Set(["initial", "unset", "revert", "revert-layer"]);
const VAR_REF = /var\(\s*(--[\w-]+)/g;
const sides = (pre, post = "") => ["top", "right", "bottom", "left"].map((s) => `${pre}-${s}${post}`);
const corners = ["top-left", "top-right", "bottom-right", "bottom-left"].map((c) => `border-${c}-radius`);
const ends = (pre, post = "") => [`${pre}-start${post}`, `${pre}-end${post}`];
const borderParts = (pre) => [`${pre}-width`, `${pre}-style`, `${pre}-color`];
/**
 * Longhands of common shorthands. CDP expands shorthands itself, except when
 * the value contains `var()` (it can't until substitution), so this covers
 * those.
 */
const SHORTHANDS = {
    margin: sides("margin"),
    padding: sides("padding"),
    inset: ["top", "right", "bottom", "left"],
    "border-width": sides("border", "-width"),
    "border-style": sides("border", "-style"),
    "border-color": sides("border", "-color"),
    border: [...sides("border", "-width"), ...sides("border", "-style"), ...sides("border", "-color")],
    ...Object.fromEntries(["top", "right", "bottom", "left"].map((s) => [`border-${s}`, [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]])),
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
    // Logical shorthands (Tailwind v4 writes `px-*` as `padding-inline: calc(var(--spacing) * n)`).
    ...Object.fromEntries(["margin", "padding", "inset"].flatMap((p) => [
        [`${p}-block`, ends(`${p}-block`)],
        [`${p}-inline`, ends(`${p}-inline`)],
    ])),
    ...Object.fromEntries(["block", "inline"].flatMap((axis) => [
        ...["width", "style", "color"].map((part) => [`border-${axis}-${part}`, ends(`border-${axis}`, `-${part}`)]),
        [`border-${axis}`, [...ends(`border-${axis}`, "-width"), ...ends(`border-${axis}`, "-style"), ...ends(`border-${axis}`, "-color")]],
        ...["start", "end"].map((edge) => [`border-${axis}-${edge}`, borderParts(`border-${axis}-${edge}`)]),
    ])),
};
/** Whether `decl` sets `prop`, directly, through a shorthand, or through the logical property that maps to it. */
function sets(decl, prop, flow) {
    if (decl.name === prop)
        return true;
    const target = physicalName(prop, flow) ?? prop;
    return [decl.name, ...(decl.longhands ?? SHORTHANDS[decl.name] ?? [])].some((n) => n === prop || (physicalName(n, flow) ?? n) === target);
}
/**
 * The order layers first appear in among one element's matched rules. CDP
 * lists those in cascade order, so this is the layers' cascade order.
 */
function layerOrder(rules) {
    const order = new Map();
    for (const r of rules) {
        const key = r?.layers?.join(".");
        if (key && !order.has(key))
            order.set(key, order.size);
    }
    return order;
}
function compare(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] ?? 0) - (b[i] ?? 0);
        if (d !== 0)
            return d;
    }
    return 0;
}
export class Cascade {
    styles;
    constructor(styles) {
        this.styles = styles;
    }
    /** The winner for `prop` among one set of matched rules, or null. */
    winnerAmong(ruleIds, prop, flow) {
        let best = null;
        const layers = layerOrder(ruleIds.map((id) => this.styles.rules[id]));
        ruleIds.forEach((ruleId, position) => {
            const rule = this.styles.rules[ruleId];
            if (!rule)
                return;
            const layer = rule.layers?.length ? layers.get(rule.layers.join(".")) : undefined;
            rule.decls.forEach((decl, declIndex) => {
                if (!sets(decl, prop, flow))
                    return;
                const inline = rule.inline !== undefined;
                // Normal: [0, inline, position, index]. Important: [1, tier, -layer, position, index].
                const rank = decl.important
                    ? [1, inline ? 2 : layer !== undefined ? 1 : 0, layer !== undefined ? -layer : 0, position, declIndex]
                    : [0, inline ? 1 : 0, position, declIndex];
                if (!best || compare(rank, best.rank) >= 0)
                    best = { ref: [ruleId, declIndex], decl, rank };
            });
        });
        return best;
    }
    /** The winning declaration for `prop` on `matched`, walking ancestors when it inherits. */
    resolve(matched, prop, flow) {
        const inherits = prop.startsWith("--") || INHERITED.has(prop);
        const levels = [matched.rules, ...matched.inherited];
        for (let depth = 0; depth < levels.length; depth++) {
            const found = this.winnerAmong(levels[depth], prop, flow);
            if (!found) {
                if (!inherits)
                    break;
                continue;
            }
            const keyword = found.decl.value.trim().toLowerCase();
            if (keyword === "inherit")
                continue;
            if (KEYWORDS.has(keyword))
                return { found: null, uncertain: true };
            return { found, inherited: depth > 0 };
        }
        return { found: null, uncertain: false };
    }
    /**
     * Resolve the winner of each property in `props` for the element at
     * `selector`. Elements CDP didn't report, and properties nothing declares,
     * have no winner. `computed` also carries the element's `writing-mode` and
     * `direction` (see `FLOW_PROPERTIES`), which map logical properties to
     * physical ones; without them the default horizontal, left-to-right flow
     * is assumed.
     */
    resolveElement(selector, props, computed) {
        const matched = this.styles.nodes[selector];
        const out = { computed: {}, winners: {} };
        const flow = { writingMode: computed["writing-mode"], direction: computed.direction };
        for (const prop of props) {
            out.computed[prop] = computed[prop] ?? "";
            if (!matched)
                continue;
            const r = this.resolve(matched, prop, flow);
            if (!r.found) {
                if (r.uncertain)
                    out.winners[prop] = { uncertain: true };
                continue;
            }
            const winner = { decl: r.found.ref };
            if (r.inherited)
                winner.inherited = true;
            const via = this.varChain(matched, r.found.decl.value, flow);
            if (via.length)
                winner.via = via;
            out.winners[prop] = winner;
        }
        return out;
    }
    /** Custom property declarations `value` depends on through `var()`, outermost first. */
    varChain(matched, value, flow, seen = new Set()) {
        const out = [];
        for (const [, name] of value.matchAll(VAR_REF)) {
            if (seen.has(name))
                continue;
            seen.add(name);
            const r = this.resolve(matched, name, flow);
            if (!r.found)
                continue;
            out.push(r.found.ref, ...this.varChain(matched, r.found.decl.value, flow, seen));
        }
        return out;
    }
}
