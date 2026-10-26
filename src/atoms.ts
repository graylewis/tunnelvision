import type { ElementNode } from "./elements.js";

/**
 * Atoms, parts and containers (CONTEXT.md): which elements a user sees as one
 * thing, so visual changes are reported at them rather than at every element
 * captured (docs/adr/0015-atoms-are-classified-after-capture.md).
 *
 * An atom is the innermost element that is, in order of precedence:
 *   1. marked `data-tv-atom`, or rendered as the root of a component the
 *      project names as an atom;
 *   2. interactive (a control, link or ARIA widget) and holding at most one
 *      run of text, so a card that is one big link stays a container;
 *   3. the root of a component instance that renders no other components and
 *      holds at most one run of text, so a page component written as plain
 *      markup isn't one atom;
 *   4. a block of text with no other text, control or marked atom inside it
 *      (a textless component inside, like a resize handle, is its part);
 *   5. failing all of those, an element with no atom inside it (an image, a
 *      divider), so every change belongs to one.
 * The elements inside an atom are its parts, and the elements with atoms
 * inside them are containers.
 */

export type Role = "atom" | "part" | "container";

export interface Classification {
	role: Map<ElementNode, Role>;
	/** Each atom, and each part, to its atom. Containers have none. */
	atomOf: Map<ElementNode, ElementNode>;
}

/** The component instance that rendered `n`: its nearest owner, and where that was called from. */
function instance(n: ElementNode): string | null {
	const owner = n.component?.components[0];
	const name = owner?.name ?? n.identity?.component;
	return name ? `${name}@${owner?.source?.path ?? ""}` : null;
}

function ownerName(n: ElementNode): string | null {
	return n.component?.components[0]?.name ?? n.identity?.component ?? null;
}

export function classify(nodes: ElementNode[], atomComponents: ReadonlySet<string> = new Set()): Classification {
	const role = new Map<ElementNode, Role>();
	const atomOf = new Map<ElementNode, ElementNode>();

	const runs = new Map<ElementNode, number>();
	const textRuns = (n: ElementNode): number => {
		let count = runs.get(n);
		if (count === undefined) {
			count = (n.text ? 1 : 0) + n.children.reduce((sum, c) => sum + textRuns(c), 0);
			runs.set(n, count);
		}
		return count;
	};
	const sameInstance = (n: ElementNode, key: string): boolean => n.children.every((c) => instance(c) === key && sameInstance(c, key));

	const isRoot = (n: ElementNode, parent: ElementNode | null): boolean => {
		const key = instance(n);
		return key !== null && (parent === null || instance(parent) !== key);
	};
	/** Rule 1: marked, or a named component's root. */
	const marked = (n: ElementNode, parent: ElementNode | null): boolean =>
		Boolean(n.atom) || (atomComponents.size > 0 && isRoot(n, parent) && atomComponents.has(ownerName(n) ?? ""));
	/** Rules 1-3: an atom that closes over everything inside it. */
	const closed = (n: ElementNode, parent: ElementNode | null): boolean => {
		if (marked(n, parent)) return true;
		if (textRuns(n) > 1) return false;
		if (n.interactive) return true;
		return isRoot(n, parent) && sameInstance(n, instance(n)!);
	};
	/** Whether `n` holds text, a control or a marked atom below it, which makes it too big for rule 4. */
	const holdsMore = (n: ElementNode): boolean =>
		n.children.some((c) => textRuns(c) > 0 || c.interactive || marked(c, n) || holdsMore(c));

	const partOf = (n: ElementNode, atom: ElementNode): void => {
		for (const c of n.children) {
			role.set(c, "part");
			atomOf.set(c, atom);
			partOf(c, atom);
		}
	};
	const atom = (n: ElementNode): void => {
		role.set(n, "atom");
		atomOf.set(n, n);
		partOf(n, n);
	};
	const visit = (n: ElementNode, parent: ElementNode | null): void => {
		if (closed(n, parent) || (n.text && !holdsMore(n)) || n.children.length === 0) return atom(n);
		for (const c of n.children) visit(c, n);
		role.set(n, "container");
	};
	for (const n of nodes) visit(n, null);
	return { role, atomOf };
}
