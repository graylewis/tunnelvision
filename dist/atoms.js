/** The component instance that rendered `n`: its nearest owner, and where that was called from. */
function instance(n) {
    const owner = n.component?.components[0];
    const name = owner?.name ?? n.identity?.component;
    return name ? `${name}@${owner?.source?.path ?? ""}` : null;
}
function ownerName(n) {
    return n.component?.components[0]?.name ?? n.identity?.component ?? null;
}
export function classify(nodes, atomComponents = new Set()) {
    const role = new Map();
    const atomOf = new Map();
    const runs = new Map();
    const textRuns = (n) => {
        let count = runs.get(n);
        if (count === undefined) {
            count = (n.text ? 1 : 0) + n.children.reduce((sum, c) => sum + textRuns(c), 0);
            runs.set(n, count);
        }
        return count;
    };
    const sameInstance = (n, key) => n.children.every((c) => instance(c) === key && sameInstance(c, key));
    const isRoot = (n, parent) => {
        const key = instance(n);
        return key !== null && (parent === null || instance(parent) !== key);
    };
    /** Rule 1: marked, or a named component's root. */
    const marked = (n, parent) => Boolean(n.atom) || (atomComponents.size > 0 && isRoot(n, parent) && atomComponents.has(ownerName(n) ?? ""));
    /** Rules 1-3: an atom that closes over everything inside it. */
    const closed = (n, parent) => {
        if (marked(n, parent))
            return true;
        if (textRuns(n) > 1)
            return false;
        if (n.interactive)
            return true;
        return isRoot(n, parent) && sameInstance(n, instance(n));
    };
    /** Whether `n` holds text, a control or a marked atom below it, which makes it too big for rule 4. */
    const holdsMore = (n) => n.children.some((c) => textRuns(c) > 0 || c.interactive || marked(c, n) || holdsMore(c));
    const partOf = (n, atom) => {
        for (const c of n.children) {
            role.set(c, "part");
            atomOf.set(c, atom);
            partOf(c, atom);
        }
    };
    const atom = (n) => {
        role.set(n, "atom");
        atomOf.set(n, n);
        partOf(n, n);
    };
    const visit = (n, parent) => {
        if (closed(n, parent) || (n.text && !holdsMore(n)) || n.children.length === 0)
            return atom(n);
        for (const c of n.children)
            visit(c, n);
        role.set(n, "container");
    };
    for (const n of nodes)
        visit(n, null);
    return { role, atomOf };
}
