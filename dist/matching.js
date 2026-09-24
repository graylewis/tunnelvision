/**
 * Generated ids from common libraries. They're regenerated per render (or per
 * mount order), so they identify nothing across captures.
 */
const GENERATED_IDS = [
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
/** Compile the `match` config, reporting bad `ignoreIds` patterns clearly. */
export function matchOptions(config) {
    const ignoreIds = [...GENERATED_IDS];
    for (const pattern of config.ignoreIds ?? []) {
        try {
            ignoreIds.push(new RegExp(pattern));
        }
        catch (err) {
            throw new Error(`Invalid match.ignoreIds pattern ${JSON.stringify(pattern)}: ${err.message}`);
        }
    }
    return { attributes: config.attributes ?? [], ignoreIds };
}
export function matchElements(from, to, opts) {
    const fromTo = new Map();
    const toFrom = new Map();
    const matchedBy = new Map();
    const realId = (n) => n.id && !opts.ignoreIds.some((re) => re.test(n.id)) ? n.id : null;
    const attr = (n, name) => n.identity?.attributes?.[name] ?? null;
    /** Deliberate identifiers that disagree mean these are different elements. */
    const vetoed = (a, b) => {
        for (const name of opts.attributes) {
            const va = attr(a, name);
            const vb = attr(b, name);
            if (va !== null && vb !== null && va !== vb)
                return true;
        }
        const ia = realId(a);
        const ib = realId(b);
        return ia !== null && ib !== null && ia !== ib;
    };
    const pair = (a, b, by) => {
        fromTo.set(a, b);
        toFrom.set(b, a);
        matchedBy.set(b, by);
    };
    const group = (nodes, sig) => {
        const out = new Map();
        for (const n of nodes) {
            const v = sig(n);
            if (v === null)
                continue;
            const list = out.get(v);
            if (list)
                list.push(n);
            else
                out.set(v, [n]);
        }
        return out;
    };
    /** Pair elements whose signature is unique among the unmatched on both sides. */
    const unique = (as, bs, sig, by) => {
        const gb = group(bs.filter((n) => !toFrom.has(n)), sig);
        for (const [v, la] of group(as.filter((n) => !fromTo.has(n)), sig)) {
            const lb = gb.get(v);
            if (la.length === 1 && lb?.length === 1 && !vetoed(la[0], lb[0]))
                pair(la[0], lb[0], by);
        }
    };
    /** Pair the k-th unmatched element with the k-th, among those sharing a signature. */
    const inOrder = (as, bs, sig, by) => {
        const gb = group(bs.filter((n) => !toFrom.has(n)), sig);
        for (const [v, la] of group(as.filter((n) => !fromTo.has(n)), sig)) {
            const lb = gb.get(v) ?? [];
            let j = 0;
            for (const a of la) {
                // Skip partners this element may not pair with, keeping the rest in order.
                while (j < lb.length && vetoed(a, lb[j]))
                    j++;
                if (j >= lb.length)
                    break;
                pair(a, lb[j++], by);
            }
        }
    };
    const flatten = (nodes, out = []) => {
        for (const n of nodes) {
            out.push(n);
            flatten(n.children, out);
        }
        return out;
    };
    // 1–2: deliberate identifiers, across the whole page.
    const allFrom = flatten(from);
    const allTo = flatten(to);
    for (const name of opts.attributes)
        unique(allFrom, allTo, (n) => attr(n, name), `attr:${name}`);
    unique(allFrom, allTo, realId, "id");
    // 3–8: within matched parents, starting from the page roots. Each child list
    // belongs to exactly one parent, so the order parents are visited in doesn't
    // change the outcome.
    const component = (n) => n.identity?.component ?? null;
    const file = (n) => n.identity?.file ?? null;
    const scoped = (as, bs) => {
        unique(as, bs, (n) => (n.identity?.key != null ? `${component(n)}\0${n.identity.key}` : null), "key");
        unique(as, bs, (n) => (component(n) || file(n) ? `${n.tag}\0${component(n)}\0${file(n)}` : null), "component");
        unique(as, bs, (n) => (n.identity?.name ? `${n.tag}\0${n.identity.name}` : null), "name");
        unique(as, bs, (n) => (n.identity?.source ? `${n.tag}\0${n.identity.source}` : null), "source");
        inOrder(as, bs, (n) => (component(n) || file(n) ? `${n.tag}\0${component(n)}\0${file(n)}` : null), "order");
        inOrder(as, bs, (n) => n.tag, "tag-order");
    };
    const visited = new Set();
    const queue = [[from, to]];
    while (queue.length > 0) {
        const [as, bs] = queue.shift();
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
    const parentFrom = new Map();
    const parentTo = new Map();
    const index = (nodes, parent, map) => {
        for (const n of nodes) {
            map.set(n, parent);
            index(n.children, n, map);
        }
    };
    index(from, null, parentFrom);
    index(to, null, parentTo);
    const moved = new Set();
    for (const [b, a] of toFrom) {
        const pa = parentFrom.get(a) ?? null;
        const pb = parentTo.get(b) ?? null;
        const expected = pa ? (fromTo.get(pa) ?? undefined) : null;
        if (expected !== pb)
            moved.add(b);
    }
    return { fromTo, toFrom, matchedBy, moved };
}
