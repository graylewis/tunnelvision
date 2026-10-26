import assert from "node:assert/strict";
import { test } from "node:test";
import { causeLocation, correlate, utilityClass, type CorrelateInput } from "../src/correlate.js";
import type { PageDiff } from "../src/diffengine.js";
import type { ElementManifest, ElementNode, OwnImage } from "../src/elements.js";
import type { FileChanges, Hunk } from "../src/git.js";
import type { ElementMatch } from "../src/matching.js";
import type { ElementStyles, StyleManifest, StyleRule, Winner } from "../src/styles.js";

// Hand-built captures: a page with a few elements, identical structure in both
// versions, so elements pair by `dir`.

function node(dir: string, children: ElementNode[] = [], jsxLine?: number): ElementNode {
	const box = { x: 0, y: 0, width: 10, height: 10 };
	return {
		tag: "div",
		id: null,
		className: null,
		slug: dir.split("/").at(-1)!,
		dir,
		selector: `sel:${dir}`,
		rect: box,
		box,
		react: null,
		...(jsxLine
			? {
					component: {
						tag: "div",
						selector: `sel:${dir}`,
						source: { fileName: "src/App.jsx", lineNumber: jsxLine, columnNumber: 1, path: `src/App.jsx:${jsxLine}:1` },
						components: [],
					},
				}
			: {}),
		children,
	};
}

function tree(): ElementNode[] {
	return [node("main", [node("main/card", [node("main/card/inner")], 12), node("main/after")])];
}

function all(nodes: ElementNode[]): ElementNode[] {
	return nodes.flatMap((n) => [n, ...all(n.children)]);
}

/** A rule at `line` in src/styles.css with one declaration on the same line. */
function rule(selector: string, line: number, name: string, value: string): StyleRule {
	return {
		selector,
		loc: { path: "src/styles.css", line, endLine: line },
		decls: [{ name, value, loc: { path: "src/styles.css", line } }],
	};
}

interface Side {
	rules: StyleRule[];
	elements: Record<string, { computed: Record<string, string>; winners?: Record<string, Winner> }>;
}

function styles(side: Side): StyleManifest {
	const elements: Record<string, ElementStyles> = {};
	for (const [dir, e] of Object.entries(side.elements)) elements[dir] = { computed: e.computed, winners: e.winners ?? {} };
	return { version: 1, rules: side.rules, elements };
}

type Line = number | [number, string];

interface Extra {
	dir: string;
	/** Position among its siblings; last by default. */
	index?: number;
	/** Its own JSX line, in src/App.jsx unless `jsxFile` says otherwise. */
	jsx?: number;
	jsxFile?: string;
	/** The src/App.jsx line its component was called from. */
	calledFrom?: number;
	/** The src/App.jsx line the component around that one was called from. */
	outerCalledFrom?: number;
}

function input(opts: {
	from: Side;
	to: Side;
	changed: Record<string, "changed" | "size-mismatch">;
	/** Elements whose box is taller in the target. */
	grown?: string[];
	/** Each element's own text, before and after. */
	text?: Record<string, [string, string]>;
	/** Elements whose box moved down in the target. */
	moved?: string[];
	/** Elements whose box is shorter in the target. */
	shrunk?: string[];
	/** Elements only the target has, as children of the element their path names. */
	added?: Extra[];
	/** Elements only the baseline has. */
	removed?: Extra[];
	/** Changed line numbers, or `[line, text]` where the text matters; `binary` for a changed binary file. */
	changes: Record<string, { added?: Line[]; deleted?: Line[]; hunks?: Hunk[]; binary?: true }>;
	/** Each element's own images, before and after. Captures record them (manifest version 4) whenever this is given. */
	images?: Record<string, [OwnImage[], OwnImage[]]>;
	/** Where in each element's image its changed pixels are. */
	changedBox?: Record<string, { x: number; y: number; width: number; height: number }>;
}): CorrelateInput {
	const a = tree();
	const b = tree();
	for (const n of all(b)) {
		if (opts.grown?.includes(n.dir)) n.rect = n.box = { ...n.box, height: n.box.height + 6 };
		if (opts.moved?.includes(n.dir)) n.rect = n.box = { ...n.box, y: n.box.y + 6 };
		if (opts.shrunk?.includes(n.dir)) n.rect = n.box = { ...n.box, height: n.box.height - 6 };
	}
	const extras = (root: ElementNode[], list: Extra[] = []) => {
		for (const x of list) {
			const n = node(x.dir, [], x.jsx);
			if (x.jsxFile) n.component!.source = { ...n.component!.source!, fileName: x.jsxFile, path: `${x.jsxFile}:${x.jsx}:1` };
			const called = (name: string, line: number) => ({ name, source: { fileName: "src/App.jsx", lineNumber: line, columnNumber: 1, path: `src/App.jsx:${line}:1` } });
			if (x.calledFrom) n.component!.components = [called("Badge", x.calledFrom), ...(x.outerCalledFrom ? [called("Layout", x.outerCalledFrom)] : [])];
			const parentDir = x.dir.split("/").slice(0, -1).join("/");
			const siblings = parentDir ? all(root).find((p) => p.dir === parentDir)!.children : root;
			siblings.splice(x.index ?? siblings.length, 0, n);
		}
		return new Set(list.map((x) => x.dir));
	};
	const onlyB = extras(b, opts.added);
	const onlyA = extras(a, opts.removed);
	for (const [dir, [before, after]] of Object.entries(opts.text ?? {})) {
		all(a).find((n) => n.dir === dir)!.text = before;
		all(b).find((n) => n.dir === dir)!.text = after;
	}
	for (const [dir, [before, after]] of Object.entries(opts.images ?? {})) {
		if (before.length) all(a).find((n) => n.dir === dir)!.images = before;
		if (after.length) all(b).find((n) => n.dir === dir)!.images = after;
	}
	const match: ElementMatch = { fromTo: new Map(), toFrom: new Map(), matchedBy: new Map(), moved: new Set() };
	const byDir = new Map(all(a).map((n) => [n.dir, n]));
	for (const n of all(b)) {
		if (onlyB.has(n.dir)) continue;
		const partner = byDir.get(n.dir)!;
		match.fromTo.set(partner, n);
		match.toFrom.set(n, partner);
	}
	const manifest = (elements: ElementNode[]): ElementManifest => ({
		version: opts.images ? 4 : 3,
		url: "http://localhost:4321/",
		extractedAt: "",
		scale: 1,
		elements,
	});
	const diffs: PageDiff[] = [
		...all(b).map((n): PageDiff => ({
			filename: `index/${n.dir}/element.png`,
			status: onlyB.has(n.dir) ? "added" : (opts.changed[n.dir] ?? "unchanged"),
			mismatchedPixels: opts.changed[n.dir] ? 50 : 0,
			...(opts.changedBox?.[n.dir] ? { changedBox: opts.changedBox[n.dir] } : {}),
		})),
		...all(a)
			.filter((n) => onlyA.has(n.dir))
			.map((n): PageDiff => ({ filename: `index/${n.dir}/element.png`, status: "removed" })),
	];
	const lines = (ls: Line[] = []) => new Map(ls.map((l): [number, string] => (typeof l === "number" ? [l, ""] : l)));
	const changes = new Map<string, FileChanges>(
		Object.entries(opts.changes).map(([p, c]) => [
			p,
			{ oldPath: p, added: lines(c.added), deleted: lines(c.deleted), hunks: c.hunks ?? [], ...(c.binary ? { binary: true } : {}) },
		]),
	);
	return {
		pages: [{ slug: "index", from: { manifest: manifest(a), styles: styles(opts.from) }, to: { manifest: manifest(b), styles: styles(opts.to) }, match }],
		diffs,
		changes,
		root: "/repo",
		top: "/repo",
	};
}

const winner = (ruleIndex: number, extra: Omit<Winner, "decl"> = {}): Winner => ({ decl: [ruleIndex, 0], ...extra });

test("an edited declaration causes its element's change, and pushes later elements as knock-on effects", () => {
	const result = correlate(
		input({
			from: { rules: [rule(".card", 5, "padding-top", "18px")], elements: { "main/card": { computed: { "padding-top": "18px" }, winners: { "padding-top": winner(0) } } } },
			to: { rules: [rule(".card", 5, "padding-top", "24px")], elements: { "main/card": { computed: { "padding-top": "24px" }, winners: { "padding-top": winner(0) } } } },
			changed: { "main/card": "size-mismatch", "main/card/inner": "changed", "main/after": "changed" },
			grown: ["main/card"],
			changes: { "src/styles.css": { added: [5], deleted: [5] } },
		}),
	);
	assert.equal(result.causes.length, 1);
	const [cause] = result.causes;
	assert.deepEqual([cause.path, cause.line, cause.side, cause.kind], ["src/styles.css", 5, "RIGHT", "declaration"]);
	assert.equal(cause.text, ".card { padding-top: 24px }");
	assert.deepEqual(
		cause.effects.map((e) => [e.dir, e.via]),
		[
			["main/card", "direct"],
			["main/card/inner", "knock-on"],
			["main/after", "knock-on"],
		],
	);
	assert.deepEqual(cause.effects[0].props, [{ name: "padding-top", from: "18px", to: "24px", own: true }]);
	// The deleted half of the replaced line is part of the same cause, not an invisible change.
	assert.deepEqual(result.invisible, []);
	assert.deepEqual(result.unexplained, []);
});

test("a changed custom property causes the changes of every declaration that uses it", () => {
	const rules = (accent: string) => [rule(":root", 2, "--accent", accent), rule(".card", 9, "background-color", "var(--accent)")];
	const el = (value: string) => ({
		computed: { "background-color": value },
		winners: { "background-color": { decl: [1, 0] as [number, number], via: [[0, 0] as [number, number]] } },
	});
	const result = correlate(
		input({
			from: { rules: rules("#4f46e5"), elements: { "main/card": el("rgb(79, 70, 229)") } },
			to: { rules: rules("#16a34a"), elements: { "main/card": el("rgb(22, 163, 74)") } },
			changed: { "main/card": "changed" },
			changes: { "src/styles.css": { added: [2], deleted: [2] } },
		}),
	);
	assert.deepEqual(
		result.causes.map((c) => [c.line, c.kind, c.effects.map((e) => e.via)]),
		[[2, "variable", ["var"]]],
	);
});

test("inherited values are caused by the ancestor's declaration", () => {
	const el = (color: string) => ({ computed: { color }, winners: { color: winner(0, { inherited: true }) } });
	const result = correlate(
		input({
			from: { rules: [rule("body", 3, "color", "black")], elements: { "main/card/inner": el("black") } },
			to: { rules: [rule("body", 3, "color", "navy")], elements: { "main/card/inner": el("navy") } },
			changed: { "main/card/inner": "changed" },
			changes: { "src/styles.css": { added: [3], deleted: [3] } },
		}),
	);
	assert.deepEqual(
		result.causes.map((c) => [c.line, c.effects.map((e) => [e.dir, e.via])]),
		[[3, [["main/card/inner", "inherited"]]]],
	);
});

test("a deleted rule is a cause on the old side", () => {
	const base = rule(".base", 4, "padding-top", "4px");
	const result = correlate(
		input({
			from: {
				rules: [base, rule(".card", 7, "padding-top", "18px")],
				elements: { "main/card": { computed: { "padding-top": "18px" }, winners: { "padding-top": winner(1) } } },
			},
			to: { rules: [base], elements: { "main/card": { computed: { "padding-top": "4px" }, winners: { "padding-top": winner(0) } } } },
			changed: { "main/card": "size-mismatch" },
			changes: { "src/styles.css": { deleted: [7] } },
		}),
	);
	assert.deepEqual(
		result.causes.map((c) => [c.side, c.line, c.kind]),
		[["LEFT", 7, "declaration"]],
	);
});

test("a class swap in JSX is caused by the element's own line", () => {
	const utility = (selector: string, value: string): StyleRule => ({ selector, loc: null, decls: [{ name: "padding-top", value, loc: null }] });
	const result = correlate(
		input({
			from: { rules: [utility(".p-4", "1rem")], elements: { "main/card": { computed: { "padding-top": "16px" }, winners: { "padding-top": winner(0) } } } },
			to: { rules: [utility(".p-6", "1.5rem")], elements: { "main/card": { computed: { "padding-top": "24px" }, winners: { "padding-top": winner(0) } } } },
			changed: { "main/card": "size-mismatch" },
			changes: { "src/App.jsx": { added: [12], deleted: [12] } },
		}),
	);
	assert.deepEqual(
		result.causes.map((c) => [c.path, c.line, c.side, c.kind]),
		[["src/App.jsx", 12, "RIGHT", "jsx"]],
	);
});

test("a value that changed under an unchanged declaration is a layout result, not a cause", () => {
	const width = rule(".inner", 30, "width", "100%");
	const result = correlate(
		input({
			from: {
				rules: [rule(".card", 5, "padding-top", "18px"), width],
				elements: {
					"main/card": { computed: { "padding-top": "18px" }, winners: { "padding-top": winner(0) } },
					"main/card/inner": { computed: { width: "300px" }, winners: { width: winner(1) } },
				},
			},
			to: {
				rules: [rule(".card", 5, "padding-top", "24px"), width],
				elements: {
					"main/card": { computed: { "padding-top": "24px" }, winners: { "padding-top": winner(0) } },
					"main/card/inner": { computed: { width: "288px" }, winners: { width: winner(1) } },
				},
			},
			changed: { "main/card": "size-mismatch", "main/card/inner": "size-mismatch" },
			changes: { "src/styles.css": { added: [5], deleted: [5] } },
		}),
	);
	assert.deepEqual(
		result.causes[0].effects.map((e) => [e.dir, e.via]),
		[
			["main/card", "direct"],
			["main/card/inner", "knock-on"],
		],
	);
	assert.deepEqual(result.unexplained, []);
});

test("changed stylesheet lines with no visual change are invisible, and unmatched rules not exercised", () => {
	const result = correlate(
		input({
			from: { rules: [rule(".card", 5, "padding-top", "18px")], elements: {} },
			to: { rules: [rule(".card", 5, "padding-top", "18px")], elements: {} },
			changed: {},
			changes: { "src/styles.css": { added: [5, 20] }, "src/App.jsx": { added: [40] } },
		}),
	);
	assert.deepEqual(
		result.invisible.map((i) => [i.path, i.line, i.reason]),
		[
			["src/styles.css", 5, "no-effect"],
			["src/styles.css", 20, "not-exercised"],
		],
	);
});

test("an earlier sibling that didn't resize doesn't push the next one", () => {
	const color = (value: string) => ({ computed: { color: value }, winners: { color: winner(0) } });
	const result = correlate(
		input({
			from: { rules: [rule(".card", 5, "color", "black")], elements: { "main/card": color("black") } },
			to: { rules: [rule(".card", 5, "color", "navy")], elements: { "main/card": color("navy") } },
			changed: { "main/card": "changed", "main/after": "changed" },
			changes: { "src/styles.css": { added: [5], deleted: [5] } },
		}),
	);
	assert.deepEqual(
		result.unexplained.map((u) => u.dir),
		["main/after"],
	);
});

test("a container whose box stayed put changed because of its content", () => {
	const color = (value: string) => ({ computed: { color: value }, winners: { color: winner(0) } });
	const result = correlate(
		input({
			from: { rules: [rule(".inner", 5, "color", "black")], elements: { "main/card/inner": color("black") } },
			to: { rules: [rule(".inner", 5, "color", "navy")], elements: { "main/card/inner": color("navy") } },
			changed: { "main": "changed", "main/card": "changed", "main/card/inner": "changed" },
			changes: { "src/styles.css": { added: [5], deleted: [5] } },
		}),
	);
	assert.deepEqual(
		result.causes[0].effects.map((e) => [e.dir, e.via]),
		[
			["main", "knock-on"],
			["main/card", "knock-on"],
			["main/card/inner", "direct"],
		],
	);
});

test("changes with nothing to explain them are unexplained", () => {
	const result = correlate(
		input({ from: { rules: [], elements: {} }, to: { rules: [], elements: {} }, changed: { "main/after": "changed" }, changes: {} }),
	);
	assert.deepEqual(result.causes, []);
	assert.deepEqual(
		result.unexplained.map((u) => u.dir),
		["main/after"],
	);
});

test("an element with two causes lists the other on each", () => {
	const result = correlate(
		input({
			from: {
				rules: [rule(".card", 5, "padding-top", "18px"), rule(".card", 6, "color", "black")],
				elements: { "main/card": { computed: { "padding-top": "18px", color: "black" }, winners: { "padding-top": winner(0), color: winner(1) } } },
			},
			to: {
				rules: [rule(".card", 5, "padding-top", "24px"), rule(".card", 6, "color", "navy")],
				elements: { "main/card": { computed: { "padding-top": "24px", color: "navy" }, winners: { "padding-top": winner(0), color: winner(1) } } },
			},
			changed: { "main/card": "changed" },
			changes: { "src/styles.css": { added: [5, 6], deleted: [5, 6] } },
		}),
	);
	assert.deepEqual(
		result.causes.map((c) => [c.line, c.representative?.alsoCausedBy]),
		[
			[5, ["src/styles.css:6"]],
			[6, ["src/styles.css:5"]],
		],
	);
});

// Copy: the card's JSX starts on src/App.jsx:12, so its text sits on a later line.

test("changed copy on its own line inside the element's JSX is a content cause, for copy", () => {
	const result = correlate(
		input({
			from: { rules: [], elements: {} },
			to: { rules: [], elements: {} },
			changed: { "main/card": "changed" },
			text: { "main/card": ["Save changes", "Save draft"] },
			changes: { "src/App.jsx": { added: [[14, "        Save draft"], [30, "  const onSave = () => save(draft);"]], deleted: [[14, "        Save changes"]] } },
		}),
	);
	assert.deepEqual(
		result.causes.map((c) => [c.path, c.line, c.side, c.kind, c.content, c.text, c.effects.map((e) => [e.dir, e.via])]),
		[["src/App.jsx", 14, "RIGHT", "content", "copy", "Save draft", [["main/card", "content"]]]],
	);
	assert.deepEqual(result.unexplained, []);
});

test("copy from a translations file is found there", () => {
	const result = correlate(
		input({
			from: { rules: [], elements: {} },
			to: { rules: [], elements: {} },
			changed: { "main/card": "changed" },
			text: { "main/card": ["Save changes", "Save draft"] },
			changes: {
				"src/locales/en.json": { added: [[8, '  "save.label": "Save draft",']], deleted: [[8, '  "save.label": "Save changes",']] },
				"src/App.jsx": { added: [[40, "  // TODO: autosave"]] },
			},
		}),
	);
	assert.deepEqual(
		result.causes.map((c) => [c.path, c.line, c.side, c.kind]),
		[["src/locales/en.json", 8, "RIGHT", "content"]],
	);
});

test("when several changed lines have the copy, the element's own file wins", () => {
	const result = correlate(
		input({
			from: { rules: [], elements: {} },
			to: { rules: [], elements: {} },
			changed: { "main/card": "changed" },
			text: { "main/card": ["Save changes", "Save draft"] },
			changes: {
				"src/locales/en.json": { added: [[8, '  "draft.title": "Draft"']] },
				"src/App.jsx": { added: [[14, "        Save draft"]] },
			},
		}),
	);
	assert.deepEqual(
		result.causes.map((c) => [c.path, c.line]),
		[["src/App.jsx", 14]],
	);
});

test("copy that only lost words is found on the deleted line", () => {
	const result = correlate(
		input({
			from: { rules: [], elements: {} },
			to: { rules: [], elements: {} },
			changed: { "main/card": "changed" },
			text: { "main/card": ["Save all changes", "Save changes"] },
			changes: { "src/App.jsx": { added: [[14, "        Save changes"]], deleted: [[14, "        Save all changes"]] } },
		}),
	);
	assert.deepEqual(
		result.causes.map((c) => [c.path, c.line, c.side, c.kind]),
		[["src/App.jsx", 14, "LEFT", "content"]],
	);
});

test("copy on the element's JSX line is one cause, not two", () => {
	const result = correlate(
		input({
			from: { rules: [], elements: {} },
			to: { rules: [], elements: {} },
			// The container changes with it, taking the card's causes as a knock-on effect.
			changed: { main: "changed", "main/card": "changed" },
			text: { "main/card": ["Welcome", "Welcome back"] },
			changes: { "src/App.jsx": { added: [[12, "    <div>Welcome back</div>"]], deleted: [[12, "    <div>Welcome</div>"]] } },
		}),
	);
	assert.deepEqual(
		result.causes.map((c) => [c.line, c.kind, c.effects.map((e) => [e.dir, e.via])]),
		[
			[
				12,
				"content",
				[
					["main", "knock-on"],
					["main/card", "content"],
				],
			],
		],
	);
});

test("copy no changed line has is unexplained, and stylesheets aren't searched for it", () => {
	const result = correlate(
		input({
			from: { rules: [], elements: {} },
			to: { rules: [], elements: {} },
			changed: { "main/card": "changed" },
			text: { "main/card": ["Grid view", "List view"] },
			changes: { "src/styles.css": { added: [[3, ".list { display: grid }"]] } },
		}),
	);
	assert.deepEqual(result.causes, []);
	assert.deepEqual(
		result.unexplained.map((u) => [u.dir, u.note]),
		[["main/card", 'copy changed ("Grid view" → "List view") but no changed line has it']],
	);
});

test("copy that too many changed lines have is a coincidence, not a cause", () => {
	const result = correlate(
		input({
			from: { rules: [], elements: {} },
			to: { rules: [], elements: {} },
			changed: { "main/card": "changed" },
			text: { "main/card": ["Save changes", "Save draft"] },
			changes: { "src/drafts.js": { added: [1, 2, 3, 4, 5, 6].map((n): [number, string] => [n, `export const draft${n} = "draft";`]) } },
		}),
	);
	assert.deepEqual(result.causes, []);
	assert.equal(result.unexplained.length, 1);
});

// Utility class swaps are looked up by class name in changed lines.
const gridColumns = (selector: string, value: string): StyleRule => ({ selector, loc: null, decls: [{ name: "grid-template-columns", value, loc: null }] });
const gridSwap = (from: string, to: string, changes: Record<string, { added?: Line[]; deleted?: Line[] }>) =>
	correlate(
		input({
			from: { rules: [gridColumns(from, "repeat(4, 1fr)")], elements: { "main/card": { computed: { "grid-template-columns": "4" }, winners: { "grid-template-columns": winner(0) } } } },
			to: { rules: [gridColumns(to, "repeat(2, 1fr)")], elements: { "main/card": { computed: { "grid-template-columns": "2" }, winners: { "grid-template-columns": winner(0) } } } },
			changed: { "main/card": "size-mismatch" },
			changes,
		}),
	);
const where = (result: ReturnType<typeof correlate>) => result.causes.map((c) => [c.path, c.line, c.side, c.kind]);

test("a single-class selector names the class as written in markup", () => {
	assert.equal(utilityClass(".md\\:grid-cols-4"), "md:grid-cols-4");
	assert.equal(utilityClass(".\\32 xl\\:p-4"), "2xl:p-4");
	assert.equal(utilityClass(".w-1\\/2"), "w-1/2");
	assert.equal(utilityClass(".grid-cols-\\[repeat\\(2\\,1fr\\)\\]"), "grid-cols-[repeat(2,1fr)]");
	assert.equal(utilityClass(".hover\\:underline:hover"), "hover:underline");
	assert.equal(utilityClass(".dark\\:bg-black:where(.dark, .dark *)"), "dark:bg-black");
	for (const s of [".a .b", ".a.b", "div.a", ".a > .b", ".a, .b", "default", "style attribute", "*"]) assert.equal(utilityClass(s), null, s);
});

test("a class swapped on a line other than the element's own is found by class name", () => {
	const result = gridSwap(".md\\:grid-cols-4", ".md\\:grid-cols-2", {
		"src/App.jsx": { deleted: [[14, '    className="grid md:grid-cols-4"']], added: [[14, '    className="grid md:grid-cols-2"']] },
	});
	assert.deepEqual(where(result), [["src/App.jsx", 14, "RIGHT", "jsx"]]);
	assert.equal(result.causes[0].effects[0].via, "jsx");
	assert.equal(result.causes[0].text, 'className="grid md:grid-cols-2"');
});

test("a class added at a component's call site is found there, though the lost class is in the component", () => {
	const result = gridSwap(".rounded-md", ".rounded-full", {
		"src/Footer.jsx": { deleted: [[210, 'className="h-10 sm:h-auto"']], added: [[210, 'className="h-10 rounded-full sm:h-auto"']] },
	});
	assert.deepEqual(where(result), [["src/Footer.jsx", 210, "RIGHT", "jsx"]]);
});

test("a class only removed is found on the deleted line", () => {
	const result = gridSwap(".md\\:grid-cols-4", "*", { "src/App.jsx": { deleted: [[14, 'className="grid md:grid-cols-4"']], added: [[14, 'className="grid"']] } });
	assert.deepEqual(where(result), [["src/App.jsx", 14, "LEFT", "jsx"]]);
});

test("compound and descendant selectors aren't looked up by class", () => {
	const result = gridSwap(".card .cols-4", ".card .cols-2", { "src/App.jsx": { deleted: [[14, 'className="cols-4"']], added: [[14, 'className="cols-2"']] } });
	assert.deepEqual(result.causes, []);
	assert.equal(result.unexplained.length, 1);
});

test("when several files have the class, the element's own file wins", () => {
	const result = gridSwap(".md\\:grid-cols-4", ".md\\:grid-cols-2", {
		"src/Other.jsx": { added: [[3, '"md:grid-cols-2"']] },
		"src/App.jsx": { added: [[14, 'className="grid md:grid-cols-2"']] },
	});
	assert.deepEqual(where(result), [["src/App.jsx", 14, "RIGHT", "jsx"]]);
});

test("a class that too many changed lines have is a coincidence, not a cause", () => {
	const result = gridSwap(".md\\:grid-cols-4", ".md\\:grid-cols-2", {
		"src/Other.jsx": { added: [1, 2, 3, 4, 5, 6].map((n): Line => [n, `<div className="md:grid-cols-2" />`]) },
	});
	assert.deepEqual(result.causes, []);
});

test("stylesheets aren't searched for class names", () => {
	const result = gridSwap(".md\\:grid-cols-4", ".md\\:grid-cols-2", { "src/styles.css": { added: [[40, ".nav { @apply md:grid-cols-2 }"]] } });
	assert.deepEqual(result.causes.filter((c) => c.kind === "jsx"), []);
});

test("a class kept on an edited line isn't what changed", () => {
	const result = gridSwap(".text-meta", ".md\\:grid-cols-2", {
		"src/App.jsx": { deleted: [[14, 'className="text-meta grid md:grid-cols-4"']], added: [[14, 'className="text-meta grid md:grid-cols-2"']] },
	});
	assert.deepEqual(where(result), [["src/App.jsx", 14, "RIGHT", "jsx"]]);
	const kept = gridSwap(".text-meta", ".font-mono", {
		"src/App.jsx": { deleted: [[14, 'className="text-meta grid"']], added: [[14, 'className="text-meta grid gap-2"']] },
	});
	assert.deepEqual(kept.causes, []);
});

// New and removed elements: the card's JSX is on src/App.jsx:12, `main` has none.

const none = { rules: [], elements: {} };

test("a new element with no cause is linked to its parent's JSX line, and what it pushed are its knock-on effects", () => {
	const result = correlate(
		input({
			from: none,
			to: none,
			changed: { "main/card": "size-mismatch", "main/card/inner": "changed", "main/after": "changed" },
			grown: ["main/card"],
			moved: ["main/card/inner"],
			added: [{ dir: "main/card/badge", index: 0, jsx: 30 }],
			changes: { "src/config.ts": { added: [[4, "{ title: 'Media' },"]] } },
		}),
	);
	assert.deepEqual(result.causes, []);
	assert.deepEqual(result.unexplained, []);
	assert.equal(result.renderSites?.length, 1);
	const [site] = result.renderSites!;
	assert.deepEqual([site.path, site.line, site.side], ["src/App.jsx", 12, "RIGHT"]);
	assert.deepEqual(
		site.effects.map((e) => [e.dir, e.via]),
		[
			["main/card", "knock-on"],
			["main/card/badge", "new"],
			["main/card/inner", "knock-on"],
			["main/after", "knock-on"],
		],
	);
	assert.equal(site.representative?.dir, "main/card/badge");
});

test("a new element whose own JSX line changed is caused by it", () => {
	const result = correlate(
		input({
			from: none,
			to: none,
			changed: { "main/card": "size-mismatch" },
			grown: ["main/card"],
			added: [{ dir: "main/card/badge", jsx: 14 }],
			changes: { "src/App.jsx": { added: [14] } },
		}),
	);
	assert.deepEqual(result.renderSites, []);
	assert.deepEqual(
		result.causes.map((c) => [c.path, c.line, c.effects.map((e) => [e.dir, e.via])]),
		[["src/App.jsx", 14, [["main/card", "knock-on"], ["main/card/badge", "jsx"]]]],
	);
});

test("a new component's call site is its cause, though its own JSX line is in an unchanged file", () => {
	const result = correlate(
		input({
			from: none,
			to: none,
			changed: {},
			added: [{ dir: "main/card/badge", jsx: 3, jsxFile: "src/Badge.jsx", calledFrom: 20 }],
			changes: { "src/App.jsx": { added: [20] } },
		}),
	);
	assert.deepEqual(result.renderSites, []);
	assert.deepEqual(
		result.causes.map((c) => [c.path, c.line, c.effects.map((e) => e.dir)]),
		[["src/App.jsx", 20, ["main/card/badge"]]],
	);
});

test("an edited call site further up the component chain isn't a new element's cause", () => {
	const result = correlate(
		input({
			from: none,
			to: none,
			changed: {},
			added: [{ dir: "main/card/badge", jsx: 3, jsxFile: "src/Badge.jsx", calledFrom: 20, outerCalledFrom: 40 }],
			changes: { "src/App.jsx": { added: [40] } },
		}),
	);
	assert.deepEqual(result.causes, []);
	assert.deepEqual(
		result.renderSites?.map((s) => [s.line, s.effects.map((e) => e.dir)]),
		[[12, ["main/card/badge"]]],
	);
});

test("new elements inside a new element are explained by it", () => {
	const result = correlate(
		input({
			from: none,
			to: none,
			changed: {},
			added: [{ dir: "main/card/badge", jsx: 30 }, { dir: "main/card/badge/icon", jsx: 31 }],
			changes: {},
		}),
	);
	assert.deepEqual(
		result.renderSites?.map((s) => [s.line, s.effects.map((e) => [e.dir, e.via])]),
		[[12, [["main/card/badge", "new"], ["main/card/badge/icon", "inside"]]]],
	);
});

test("a new element whose parent has no JSX line is still explained, with no render site", () => {
	const result = correlate(
		input({ from: none, to: none, changed: { main: "changed" }, added: [{ dir: "main/banner" }], changes: {} }),
	);
	assert.deepEqual(result.unexplained, []);
	assert.deepEqual(
		result.renderSites?.map((s) => [s.path, s.effects.map((e) => [e.dir, e.via])]),
		[[undefined, [["main", "knock-on"], ["main/banner", "new"]]]],
	);
});

test("new elements rendered by the same parent line are grouped, across pages", () => {
	const page = (slug: string) => {
		const one = input({ from: none, to: none, changed: {}, added: [{ dir: "main/card/badge", jsx: 30 }], changes: {} });
		return { ...one.pages[0], slug, diffs: one.diffs.map((d) => ({ ...d, filename: d.filename.replace(/^index\//, `${slug}/`) })) };
	};
	const [a, b] = [page("index"), page("about")];
	const result = correlate({ ...input({ from: none, to: none, changed: {}, changes: {} }), pages: [a, b], diffs: [...a.diffs, ...b.diffs] });
	assert.deepEqual(
		result.renderSites?.map((s) => [s.line, s.effects.map((e) => e.page)]),
		[[12, ["index", "about"]]],
	);
});

test("a removed element is linked to its baseline parent's JSX line, and what moved up are its knock-on effects", () => {
	const result = correlate(
		input({
			from: none,
			to: none,
			changed: { "main/card/inner": "changed" },
			moved: ["main/card/inner"],
			removed: [{ dir: "main/card/old", index: 0, jsx: 13 }],
			changes: { "src/config.ts": { deleted: [4] } },
		}),
	);
	assert.deepEqual(result.unexplained, []);
	assert.deepEqual(
		result.renderSites?.map((s) => [s.path, s.line, s.side, s.effects.map((e) => [e.dir, e.via])]),
		[["src/App.jsx", 12, "LEFT", [["main/card/inner", "knock-on"], ["main/card/old", "removed"]]]],
	);
});

test("a container with a new element and a caused change is a knock-on effect of both", () => {
	const result = correlate(
		input({
			from: { rules: [rule(".inner", 5, "color", "black")], elements: { "main/card/inner": { computed: { color: "black" }, winners: { color: winner(0) } } } },
			to: { rules: [rule(".inner", 5, "color", "navy")], elements: { "main/card/inner": { computed: { color: "navy" }, winners: { color: winner(0) } } } },
			changed: { "main/card": "changed", "main/card/inner": "changed" },
			added: [{ dir: "main/card/badge", jsx: 30 }],
			changes: { "src/styles.css": { added: [5], deleted: [5] } },
		}),
	);
	assert.deepEqual(
		result.causes.map((c) => c.effects.map((e) => [e.dir, e.via])),
		[[["main/card", "knock-on"], ["main/card/inner", "direct"]]],
	);
	assert.deepEqual(
		result.renderSites?.map((s) => s.effects.map((e) => [e.dir, e.via])),
		[[["main/card", "knock-on"], ["main/card/badge", "new"]]],
	);
});

test("an element that shrank in a parent that kept its size was squeezed by a later sibling that grew", () => {
	const result = correlate(
		input({
			from: none,
			to: none,
			changed: { "main/card": "size-mismatch", "main/after": "size-mismatch" },
			grown: ["main/after"],
			added: [{ dir: "main/after/link", jsx: 40 }],
			changes: {},
			shrunk: ["main/card"],
		}),
	);
	assert.deepEqual(result.unexplained, []);
	assert.deepEqual(
		result.renderSites?.map((s) => s.effects.map((e) => [e.dir, e.via])),
		[[["main/card", "knock-on"], ["main/after", "knock-on"], ["main/after/link", "new"]]],
	);
});

test("a sibling that grew doesn't squeeze one whose parent resized too", () => {
	// The parent's own change has no cause, so nothing above explains the card either.
	const result = correlate(
		input({
			from: { rules: [rule("main", 5, "padding-top", "1px")], elements: { main: { computed: { "padding-top": "1px" }, winners: { "padding-top": winner(0) } } } },
			to: { rules: [rule("main", 5, "padding-top", "2px")], elements: { main: { computed: { "padding-top": "2px" }, winners: { "padding-top": winner(0) } } } },
			changed: { main: "size-mismatch", "main/card": "size-mismatch", "main/after": "size-mismatch" },
			grown: ["main", "main/after"],
			added: [{ dir: "main/after/link", jsx: 40 }],
			changes: {},
			shrunk: ["main/card"],
		}),
	);
	assert.deepEqual(
		result.unexplained.map((u) => u.dir),
		["main", "main/card"],
	);
});

// Images: the card shows an avatar inside it (an inline <img>, so the card's own image).

const BOX = { x: 0, y: 0, width: 10, height: 10 };
const image = (src: string, extra: Partial<OwnImage> = {}): OwnImage => ({ tag: "img", src: `http://localhost:4321${src}`, loaded: true, box: BOX, ...extra });

test("a swapped image source is caused by the line that replaced it, then the line with the new name", () => {
	const result = correlate(
		input({
			from: { rules: [], elements: {} },
			to: { rules: [], elements: {} },
			changed: { "main/card": "changed" },
			images: { "main/card": [[image("/images/about/person-circle-outline.webp")], [image("/@fs/repo/src/assets/people/gray-lewis.png?origWidth=285")]] },
			changes: {
				"src/App.jsx": {
					added: [
						[6, "import grayLewis from '@/assets/people/gray-lewis.png';"],
						[49, "    image: grayLewis.src,"],
					],
					deleted: [[48, "    image: '/images/about/person-circle-outline.webp',"]],
					hunks: [
						{ oldStart: 5, oldCount: 0, newStart: 6, newCount: 1 },
						{ oldStart: 48, oldCount: 1, newStart: 49, newCount: 1 },
					],
				},
				"src/assets/people/gray-lewis.png": { binary: true },
			},
		}),
	);
	assert.deepEqual(
		result.causes.map((c) => [c.path, c.line, c.side, c.kind, c.content, c.text, c.effects.map((e) => [e.dir, e.via])]),
		[
			["src/App.jsx", 6, "RIGHT", "content", "image", "import grayLewis from '@/assets/people/gray-lewis.png';", [["main/card", "content"]]],
			["src/App.jsx", 49, "RIGHT", "content", "image", "image: grayLewis.src,", [["main/card", "content"]]],
		],
	);
	assert.deepEqual(result.causes[0].effects[0].alsoCausedBy, ["src/App.jsx:49"], "each line names the other");
	assert.deepEqual(result.unexplained, []);
});

test("a name inside a longer file name isn't a match", () => {
	const result = correlate(
		input({
			from: { rules: [], elements: {} },
			to: { rules: [], elements: {} },
			changed: { "main/card": "changed" },
			images: { "main/card": [[image("/a.png")], [image("/b.png")]] },
			changes: { "src/App.jsx": { added: [[3, "const icon = '/data.png';"]], deleted: [[3, "const icon = '/beta.png';"]] } },
		}),
	);
	assert.deepEqual(result.causes, []);
	assert.deepEqual(
		result.unexplained.map((u) => [u.dir, u.note]),
		[["main/card", "its image source changed (a.png → b.png) but no changed line holds either name"]],
	);
});

test("an image file replaced in place is a changed binary file cause, with no line", () => {
	const result = correlate(
		input({
			from: { rules: [], elements: {} },
			to: { rules: [], elements: {} },
			changed: { "main/card": "changed" },
			images: { "main/card": [[image("/images/avatar.png")], [image("/images/avatar.png")]] },
			changes: { "public/images/avatar.png": { binary: true } },
		}),
	);
	assert.deepEqual(
		result.causes.map((c) => [c.path, c.line, c.side, c.kind, c.content, c.text, c.effects.map((e) => [e.dir, e.via])]),
		[["public/images/avatar.png", undefined, "RIGHT", "content", "image", "avatar.png", [["main/card", "content"]]]],
	);
	assert.equal("line" in result.causes[0], false);
	assert.deepEqual(result.unexplained, []);
});

test("an edited SVG image is caused by its first changed line", () => {
	const result = correlate(
		input({
			from: { rules: [], elements: {} },
			to: { rules: [], elements: {} },
			changed: { "main/card": "changed" },
			images: { "main/card": [[image("/icons/logo.svg")], [image("/icons/logo.svg")]] },
			changes: { "public/icons/logo.svg": { added: [[7, '  <path d="M1 1"/>'], [4, '  <circle r="3"/>']], deleted: [[4, '  <circle r="2"/>']] } },
		}),
	);
	assert.deepEqual(
		result.causes.map((c) => [c.path, c.line, c.side, c.content]),
		[["public/icons/logo.svg", 4, "RIGHT", "image"]],
	);
});

test("an image that hadn't loaded is unknown, with a hint saying so", () => {
	const result = correlate(
		input({
			from: { rules: [], elements: {} },
			to: { rules: [], elements: {} },
			changed: { "main/card": "changed" },
			images: { "main/card": [[image("/a.png", { loaded: false })], [image("/b.png")]] },
			changes: { "src/App.jsx": { added: [[3, "const icon = '/b.png';"]] } },
		}),
	);
	assert.deepEqual(result.causes, []);
	assert.deepEqual(
		result.unexplained.map((u) => [u.dir, u.note]),
		[["main/card", "its image (a.png) hadn't loaded in the baseline"]],
	);
});

test("pixels changed inside an unchanged image get a hint; elsewhere, or for animated images, they don't", () => {
	const hinted = (images: OwnImage[], changedBox: { x: number; y: number; width: number; height: number }) =>
		correlate(
			input({
				from: { rules: [], elements: {} },
				to: { rules: [], elements: {} },
				changed: { "main/card": "changed" },
				images: { "main/card": [images, images] },
				changedBox: { "main/card": changedBox },
				changes: {},
			}),
		).unexplained.map((u) => u.note);
	const avatar = image("/images/avatar.png", { box: { x: 0, y: 0, width: 4, height: 4 } });
	assert.deepEqual(hinted([avatar], { x: 1, y: 1, width: 3, height: 3 }), [
		"pixels changed inside its image (avatar.png), but neither its source nor its file changed: the file may have changed outside the repo, its pipeline (image service, sharp) may have changed, or something drew over it",
	]);
	assert.deepEqual(hinted([avatar], { x: 1, y: 1, width: 9, height: 9 }), [undefined], "changed pixels outside the image");
	assert.deepEqual(hinted([image("/spinner.gif", { box: avatar.box })], { x: 1, y: 1, width: 3, height: 3 }), [undefined], "a GIF animates");
	assert.deepEqual(hinted([{ ...avatar, tag: "video" }], { x: 1, y: 1, width: 3, height: 3 }), [undefined], "a video plays");
});

test("captures from before own images were recorded have no image evidence", () => {
	const result = correlate(
		input({
			from: { rules: [], elements: {} },
			to: { rules: [], elements: {} },
			changed: { "main/card": "changed" },
			changes: { "public/images/avatar.png": { binary: true } },
		}),
	);
	assert.deepEqual(result.causes, []);
	assert.deepEqual(result.unexplained.map((u) => u.note), [undefined]);
});

test("a change whose declaration is in a stylesheet with a broken source map says so", () => {
	const untraced = (value: string): StyleRule => ({
		selector: "body",
		loc: null,
		decls: [{ name: "color", value, loc: null }],
		untraced: { file: "src/app/globals.css", problem: "postcss-output" },
	});
	const el = (color: string) => ({ computed: { color }, winners: { color: winner(0, { inherited: true }) } });
	const result = correlate(
		input({
			from: { rules: [untraced("var(--foreground)")], elements: { "main/card/inner": el("rgb(37, 37, 37)") } },
			to: { rules: [untraced("var(--level-2)")], elements: { "main/card/inner": el("lab(27.7 0 0)") } },
			changed: { "main/card/inner": "changed" },
			changes: { "src/app/globals.css": { added: [163], deleted: [163] } },
		}),
	);
	assert.deepEqual(result.causes, []);
	assert.deepEqual(
		result.unexplained.map((u) => [u.dir, u.note]),
		[["main/card/inner", "body is in src/app/globals.css, which can't be traced: Turbopack dropped PostCSS's source map"]],
	);
});

// --- data causes (state plugins) ------------------------------------------------

test("copy showing data from a unit that ran live because its code changed is explained by that code's changed line", () => {
	const base = input({
		from: { rules: [], elements: {} },
		to: { rules: [], elements: {} },
		changed: { "main/card": "changed", "main/after": "changed" },
		text: { "main/card": ["Revenue $48,210", "Revenue $51,002"], "main/after": ["Welcome", "Hello"] },
		changes: { "src/api.js": { added: [[8, '\treturn request("/api/stats?v=2");']], deleted: [[8, '\treturn request("/api/stats");']] } },
	});
	base.pages[0].data = [{ unit: 'tanstack-query ["stats"]', causes: [{ side: "RIGHT", path: "src/api.js", line: 8 }], added: [51002], removed: [48210] }];
	const result = correlate(base);
	assert.deepEqual(
		result.causes.map((c) => [causeLocation(c), c.kind, c.content, c.text, c.effects.map((e) => e.dir)]),
		[["src/api.js:8", "data", "copy", 'return request("/api/stats?v=2");', ["main/card"]]],
	);
	// Copy no data explains stays unexplained, with a hint about the unit that ran live.
	assert.deepEqual(
		result.unexplained.map((u) => [u.dir, u.note]),
		[["main/after", 'copy changed ("Welcome" → "Hello") but no changed line has it; tanstack-query ["stats"] ran live on this page because its code changed']],
	);
});

test("a changed line holding the copy wins over a data cause", () => {
	const base = input({
		from: { rules: [], elements: {} },
		to: { rules: [], elements: {} },
		changed: { "main/card": "changed" },
		text: { "main/card": ["Grid view", "List view"] },
		changes: {
			"src/App.jsx": { added: [[4, "<p>List view</p>"]] },
			"src/api.js": { added: [[8, "x"]] },
		},
	});
	base.pages[0].data = [{ unit: "q", causes: [{ side: "RIGHT", path: "src/api.js", line: 8 }], added: ["List view"], removed: [] }];
	assert.deepEqual(correlate(base).causes.map((c) => [causeLocation(c), c.kind]), [["src/App.jsx:4", "content"]]);
});

test("the containers around an unexplained change are downstream of it, not unexplained changes of their own", () => {
	const result = correlate(
		input({
			from: { rules: [], elements: {} },
			to: { rules: [], elements: {} },
			changed: { "main": "changed", "main/card": "size-mismatch", "main/card/inner": "changed" },
			grown: ["main/card"],
			changedBox: { "main": { x: 2, y: 2, width: 4, height: 4 } },
			changes: {},
		}),
	);
	assert.deepEqual(
		result.unexplained.map((u) => [u.dir, u.downstreamOf]),
		[
			["main", ["main/card"]],
			["main/card", ["main/card/inner"]],
			["main/card/inner", undefined],
		],
	);
});

test("a container whose changed pixels reach outside the unexplained change inside it is unexplained in its own right", () => {
	const result = correlate(
		input({
			from: { rules: [], elements: {} },
			to: { rules: [], elements: {} },
			changed: { "main/card": "changed", "main/card/inner": "changed" },
			changedBox: { "main/card": { x: 0, y: 0, width: 30, height: 4 } },
			changes: {},
		}),
	);
	assert.deepEqual(
		result.unexplained.map((u) => [u.dir, u.downstreamOf]),
		[
			["main/card", undefined],
			["main/card/inner", undefined],
		],
	);
});

test("a container whose own declaration changed isn't downstream of an unexplained change inside it", () => {
	const pad = (value: string) => ({ computed: { "padding-top": value }, winners: { "padding-top": winner(0) } });
	const result = correlate(
		input({
			from: { rules: [rule(".card", 5, "padding-top", "18px")], elements: { "main/card": pad("18px") } },
			to: { rules: [rule(".card", 9, "padding-top", "24px")], elements: { "main/card": pad("24px") } },
			changed: { "main/card": "changed", "main/card/inner": "changed" },
			changes: {},
		}),
	);
	assert.deepEqual(
		result.unexplained.map((u) => [u.dir, u.downstreamOf]),
		[
			["main/card", undefined],
			["main/card/inner", undefined],
		],
	);
});

/** Make `dir` interactive (an atom over what's inside it) in the baseline, the target or both. */
function interactive(i: CorrelateInput, dir: string, sides: Array<"from" | "to"> = ["from", "to"]): CorrelateInput {
	for (const side of sides) all(i.pages[0][side].manifest.elements).find((n) => n.dir === dir)!.interactive = true;
	return i;
}

test("a change to a part is reported with its atom, and the cause is shown as the atom", () => {
	const color = (value: string) => ({ computed: { color: value }, winners: { color: winner(0) } });
	const result = correlate(
		interactive(
			input({
				from: { rules: [rule(".label", 5, "color", "black")], elements: { "main/card/inner": color("black") } },
				to: { rules: [rule(".label", 5, "color", "navy")], elements: { "main/card/inner": color("navy") } },
				changed: { "main": "changed", "main/card": "changed", "main/card/inner": "changed" },
				changes: { "src/styles.css": { added: [5], deleted: [5] } },
			}),
			"main/card",
		),
	);
	const [cause] = result.causes;
	assert.deepEqual(
		cause.effects.map((e) => [e.dir, e.via, e.role, e.atom]),
		[
			["main", "knock-on", "container", undefined],
			["main/card", "knock-on", "atom", undefined],
			["main/card/inner", "direct", "part", "main/card"],
		],
	);
	assert.equal(cause.representative?.dir, "main/card");
});

test("where an atom's boundary moved between versions, the larger atom is used", () => {
	const roles = (sides: Array<"from" | "to">) =>
		correlate(
			interactive(
				input({ from: { rules: [], elements: {} }, to: { rules: [], elements: {} }, changed: { "main/card/inner": "changed" }, changes: {} }),
				"main/card",
				sides,
			),
		).unexplained.map((u) => [u.dir, u.role, u.atom]);
	// The card became a button, or stopped being one: either way its inside is its part.
	assert.deepEqual(roles(["to"]), [["main/card/inner", "part", "main/card"]]);
	assert.deepEqual(roles(["from"]), [["main/card/inner", "part", "main/card"]]);
	assert.deepEqual(roles([]), [["main/card/inner", "atom", undefined]]);
});
