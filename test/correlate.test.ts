import assert from "node:assert/strict";
import { test } from "node:test";
import { correlate, type CorrelateInput } from "../src/correlate.js";
import type { PageDiff } from "../src/diffengine.js";
import type { ElementManifest, ElementNode } from "../src/elements.js";
import type { FileChanges } from "../src/git.js";
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

function input(opts: {
	from: Side;
	to: Side;
	changed: Record<string, "changed" | "size-mismatch">;
	/** Elements whose box is taller in the target. */
	grown?: string[];
	changes: Record<string, { added?: number[]; deleted?: number[] }>;
}): CorrelateInput {
	const a = tree();
	const b = tree();
	for (const n of all(b)) {
		if (opts.grown?.includes(n.dir)) n.rect = n.box = { ...n.box, height: n.box.height + 6 };
	}
	const match: ElementMatch = { fromTo: new Map(), toFrom: new Map(), matchedBy: new Map(), moved: new Set() };
	const byDir = new Map(all(a).map((n) => [n.dir, n]));
	for (const n of all(b)) {
		const partner = byDir.get(n.dir)!;
		match.fromTo.set(partner, n);
		match.toFrom.set(n, partner);
	}
	const manifest = (elements: ElementNode[]): ElementManifest => ({ version: 3, url: "/", extractedAt: "", scale: 1, elements });
	const diffs: PageDiff[] = all(b).map((n) => ({
		filename: `index/${n.dir}/element.png`,
		status: opts.changed[n.dir] ?? "unchanged",
		mismatchedPixels: opts.changed[n.dir] ? 50 : 0,
	}));
	const changes = new Map<string, FileChanges>(
		Object.entries(opts.changes).map(([p, c]) => [p, { oldPath: p, added: new Set(c.added ?? []), deleted: new Set(c.deleted ?? []) }]),
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
