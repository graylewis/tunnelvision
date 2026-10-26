import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "../src/atoms.js";
import type { ElementNode } from "../src/elements.js";

interface Spec {
	tag?: string;
	/** The component that rendered it, and the line it was called from (one instance per name and line). */
	owner?: [string, number];
	text?: string;
	interactive?: true;
	atom?: true;
	children?: Record<string, Spec>;
}

/** Elements named by their path, e.g. `card/title`. */
function build(specs: Record<string, Spec>, parent = ""): ElementNode[] {
	return Object.entries(specs).map(([slug, spec]) => {
		const dir = parent ? `${parent}/${slug}` : slug;
		const box = { x: 0, y: 0, width: 10, height: 10 };
		const source = (line: number) => ({ fileName: "src/App.tsx", lineNumber: line, columnNumber: 1, path: `src/App.tsx:${line}:1` });
		return {
			tag: spec.tag ?? "div",
			id: null,
			className: null,
			slug,
			dir,
			selector: dir,
			rect: box,
			box,
			react: null,
			...(spec.owner
				? { component: { tag: spec.tag ?? "div", selector: dir, source: null, components: [{ name: spec.owner[0], source: source(spec.owner[1]) }] } }
				: {}),
			...(spec.text ? { text: spec.text } : {}),
			...(spec.interactive ? { interactive: spec.interactive } : {}),
			...(spec.atom ? { atom: spec.atom } : {}),
			children: build(spec.children ?? {}, dir),
		};
	});
}

function roles(specs: Record<string, Spec>, components: string[] = []): Record<string, string> {
	const nodes = build(specs);
	const { role, atomOf } = classify(nodes, new Set(components));
	const out: Record<string, string> = {};
	for (const [n, r] of role) out[n.dir] = r === "part" ? `part of ${atomOf.get(n)!.dir}` : r;
	return out;
}

test("a chip alone in a paragraph is an atom, and the paragraph around it a container", () => {
	assert.deepEqual(
		roles({ p: { owner: ["JobDetailHeader", 40], children: { chip: { tag: "span", owner: ["StatusChip", 48], text: "FAILED" } } } }),
		{ "p/chip": "atom", p: "container" },
	);
});

test("an icon button is one atom: its label and icon are its parts, whoever rendered them", () => {
	assert.deepEqual(
		roles({
			save: {
				tag: "button",
				owner: ["Button", 10],
				interactive: true,
				children: { icon: { owner: ["Toolbar", 3] }, label: { tag: "span", owner: ["Toolbar", 3], text: "Save" } },
			},
		}),
		{ save: "atom", "save/icon": "part of save", "save/label": "part of save" },
	);
});

test("a card that is one big link stays a container, so its title and description are atoms", () => {
	assert.deepEqual(
		roles({
			card: {
				tag: "a",
				owner: ["JobCard", 5],
				interactive: true,
				children: { title: { tag: "h3", owner: ["JobCard", 5], text: "Job 12" }, description: { tag: "p", owner: ["JobCard", 5], text: "Completed" } },
			},
		}),
		{ card: "container", "card/title": "atom", "card/description": "atom" },
	);
});

test("a component that renders no other components is an atom, unless it holds more than one run of text", () => {
	assert.deepEqual(
		roles({
			avatar: { owner: ["Avatar", 7], children: { ring: { owner: ["Avatar", 7] } } },
			page: { owner: ["Unauthorized", 1], children: { heading: { tag: "h1", owner: ["Unauthorized", 1], text: "401" }, body: { tag: "p", owner: ["Unauthorized", 1], text: "Sign in" } } },
		}),
		{ avatar: "atom", "avatar/ring": "part of avatar", page: "container", "page/heading": "atom", "page/body": "atom" },
	);
});

test("a cell of text is an atom with a textless component inside it as its part", () => {
	assert.deepEqual(
		roles({ row: { tag: "tr", owner: ["TableRow", 2], children: { cell: { tag: "td", owner: ["TableCell", 3], text: "mtr_e562", children: { handle: { owner: ["ResizeHandle", 9] } } } } } }),
		{ row: "container", "row/cell": "atom", "row/cell/handle": "part of row/cell" },
	);
});

test("elements with no atom inside them are atoms, so every change belongs to one", () => {
	assert.deepEqual(roles({ layout: { children: { divider: {}, image: { tag: "img" } } } }), {
		layout: "container",
		"layout/divider": "atom",
		"layout/image": "atom",
	});
});

test("a marked element, or a named component's root, is an atom whatever is inside it", () => {
	const stat = { owner: ["StatCard", 4] as [string, number], children: { label: { owner: ["StatCard", 4] as [string, number], text: "Runs" }, value: { owner: ["StatCard", 4] as [string, number], text: "12" } } };
	assert.deepEqual(roles({ stat }, ["StatCard"]), { stat: "atom", "stat/label": "part of stat", "stat/value": "part of stat" });
	assert.deepEqual(roles({ stat: { ...stat, owner: undefined, atom: true } }).stat, "atom");
	assert.deepEqual(roles({ stat }).stat, "container");
});
