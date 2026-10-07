import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PNG } from "pngjs";
import { assembleStyles, planElements, REDIRECT_RECORD } from "../src/carryover.js";
import { changedSelectors, EVERYTHING, scanBlocks, selectorAt, staticSelector } from "../src/changedrules.js";
import { compareSamples } from "../src/commands/fingerprint.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { diffVersions } from "../src/diffengine.js";
import type { ElementManifest, ElementNode, RawElement } from "../src/elements.js";
import { parseUnifiedDiff, type FileChanges } from "../src/git.js";
import { matchOptions } from "../src/matching.js";
import { LineMapper } from "../src/remap.js";
import type { ElementStyles, StyleManifest, StyleRule } from "../src/styles.js";

/** A diff of `file` from its hunks, each `[header, ...lines]`. */
function diff(file: string, ...hunks: string[][]): string {
	return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, ...hunks.flat(), ""].join("\n");
}

// --- line remapping ---------------------------------------------------------

test("parseUnifiedDiff records hunks", () => {
	const f = parseUnifiedDiff(diff("a.css", ["@@ -3 +3,2 @@", "-x", "+y", "+z"], ["@@ -10,0 +12 @@", "+w"])).get("a.css");
	assert.deepEqual(f?.hunks, [
		{ oldStart: 3, oldCount: 1, newStart: 3, newCount: 2 },
		{ oldStart: 10, oldCount: 0, newStart: 12, newCount: 1 },
	]);
});

test("LineMapper: lines outside hunks shift by what was added and deleted above them", () => {
	const m = new LineMapper(parseUnifiedDiff(diff("a.css", ["@@ -3 +3,2 @@", "-x", "+y", "+z"], ["@@ -10,0 +12 @@", "+w"])));
	assert.deepEqual(m.map("a.css", 2), { path: "a.css", line: 2 });
	assert.deepEqual(m.map("a.css", 5), { path: "a.css", line: 6 });
	assert.deepEqual(m.map("a.css", 10), { path: "a.css", line: 11 }); // insertion is after line 10
	assert.deepEqual(m.map("a.css", 11), { path: "a.css", line: 13 });
	assert.deepEqual(m.map("other.css", 7), { path: "other.css", line: 7 });
});

test("LineMapper: a line inside a hunk maps only when its exact text is on one new line", () => {
	const changes = parseUnifiedDiff(
		diff("a.css", ["@@ -4,3 +4,3 @@", "-  color: red;", "-  margin: 0;", "-  gap: 1px;", "+  margin: 0;", "+  color: blue;", "+  gap: 1px;"]),
	);
	const m = new LineMapper(changes);
	assert.equal(m.map("a.css", 4), null); // color: red is gone
	assert.deepEqual(m.map("a.css", 5), { path: "a.css", line: 4 }); // margin moved up
	assert.deepEqual(m.map("a.css", 6), { path: "a.css", line: 6 });
	assert.equal(m.added("a.css", 5), true);
	assert.equal(m.added("a.css", 7), false);
});

test("LineMapper: ambiguous text in a hunk doesn't map", () => {
	const m = new LineMapper(parseUnifiedDiff(diff("a.css", ["@@ -2 +2,2 @@", "-}", "+}", "+}"])));
	assert.equal(m.map("a.css", 2), null);
});

test("LineMapper: new files don't shadow a file renamed away from their path", () => {
	const text = [
		"diff --git a/a.css b/b.css",
		"rename from a.css",
		"rename to b.css",
		"diff --git a/a.css b/a.css",
		"new file mode 100644",
		"--- /dev/null",
		"+++ b/a.css",
		"@@ -0,0 +1 @@",
		"+new {}",
		"",
	].join("\n");
	const m = new LineMapper(parseUnifiedDiff(text));
	assert.deepEqual(m.map("a.css", 3), { path: "b.css", line: 3 });
});

test("LineMapper: renames and deleted files", () => {
	const text = [
		"diff --git a/src/old.css b/src/new.css",
		"similarity index 90%",
		"rename from src/old.css",
		"rename to src/new.css",
		"--- a/src/old.css",
		"+++ b/src/new.css",
		"@@ -1,0 +2 @@",
		"+a {}",
		"diff --git a/src/gone.css b/src/gone.css",
		"deleted file mode 100644",
		"--- a/src/gone.css",
		"+++ /dev/null",
		"@@ -1,2 +0,0 @@",
		"-a {}",
		"-b {}",
		"",
	].join("\n");
	const m = new LineMapper(parseUnifiedDiff(text));
	assert.deepEqual(m.map("src/old.css", 3), { path: "src/new.css", line: 4 });
	assert.equal(m.map("src/gone.css", 1), null);
});

test("LineMapper: project paths inside a repository subdirectory", () => {
	const m = new LineMapper(parseUnifiedDiff(diff("web/src/a.css", ["@@ -0,0 +1 @@", "+x"])), "web");
	assert.deepEqual(m.map("src/a.css", 1), { path: "src/a.css", line: 2 });
	assert.deepEqual(m.map("/abs/node_modules/x.css", 9), { path: "/abs/node_modules/x.css", line: 9 });
	assert.equal(m.touched("src/a.css"), true);
});

// --- changed rule selectors --------------------------------------------------

const CSS = `/* header */
.card {
  color: red;
}

@media (min-width: 600px) {
  .card .title {
    margin: 0;
  }
}

@keyframes spin {
  to { transform: rotate(1turn); }
}

@theme {
  --color-brand: #f00;
}

.btn:hover::after { content: ""; }
`;

test("selectorAt: the rule a changed line belongs to", () => {
	const scan = scanBlocks(CSS);
	assert.equal(selectorAt(scan, 1), null); // comment
	assert.equal(selectorAt(scan, 3), ".card");
	assert.equal(selectorAt(scan, 5), null); // blank
	assert.equal(selectorAt(scan, 8), ".card .title");
	assert.equal(selectorAt(scan, 6), EVERYTHING); // the @media prelude
	assert.equal(selectorAt(scan, 13), null); // keyframes don't win declarations
	assert.equal(selectorAt(scan, 17), ":root");
	assert.equal(selectorAt(scan, 20), ".btn");
});

test("staticSelector drops state and pseudo-elements", () => {
	assert.equal(staticSelector(".a:hover > .b::before, :focus-visible"), ".a > .b, *");
	assert.equal(staticSelector(".x #{$y}"), null);
});

test("changedSelectors: nested rules, style blocks and unreadable files", () => {
	const scss = ".nav {\n  a {\n    color: red;\n  }\n  &.open { gap: 0; }\n}\n";
	const astro = "---\nconst x = 1;\n---\n<div class=\"a\">hi</div>\n<style>\n  .a {\n    color: red;\n  }\n</style>\n";
	const changes = new Map<string, FileChanges>([
		["s.scss", { oldPath: "s.scss", added: new Map([[3, "    color: red;"], [5, "  &.open { gap: 0; }"]]), deleted: new Map(), hunks: [] }],
		["c.astro", { oldPath: "c.astro", added: new Map([[4, ""], [7, ""]]), deleted: new Map(), hunks: [] }],
		["app.tsx", { oldPath: "app.tsx", added: new Map([[1, ""]]), deleted: new Map(), hunks: [] }],
	]);
	const read = (_side: "old" | "new", file: string) => (file === "s.scss" ? scss : file === "c.astro" ? astro : null);
	assert.deepEqual(changedSelectors(changes, read), [".a", ":is(.nav) a", ":is(.nav).open"]);

	const unreadable = new Map<string, FileChanges>([
		["x.css", { oldPath: "x.css", added: new Map([[1, ""]]), deleted: new Map(), hunks: [] }],
	]);
	assert.deepEqual(changedSelectors(unreadable, () => null), [EVERYTHING]);
});

// --- the element rule -------------------------------------------------------

function el(dir: string, children: ElementNode[] = [], jsxLine?: number): ElementNode {
	const box = { x: 0, y: 0, width: 10, height: 10 };
	return {
		tag: "div",
		id: null,
		className: null,
		slug: dir.split("/").at(-1)!,
		dir,
		selector: `body > ${dir.replaceAll("/", " > ")}`,
		rect: box,
		box,
		react: null,
		identity: { attributes: {}, name: null, key: null, component: null, file: null, source: null },
		...(jsxLine
			? {
					component: {
						tag: "div",
						selector: "",
						source: { fileName: "src/App.tsx", lineNumber: jsxLine, columnNumber: 3, path: `src/App.tsx:${jsxLine}:3` },
						components: [],
					},
				}
			: {}),
		children,
	};
}

function raw(nodes: ElementNode[], computed: Record<string, Record<string, string>>): RawElement[] {
	return nodes.map((n) => ({
		tag: n.tag,
		id: null,
		className: null,
		selector: n.selector,
		rect: n.rect,
		box: n.box,
		react: null,
		computed: computed[n.dir] ?? { color: "red" },
		children: raw(n.children, computed),
	}));
}

const refRules: StyleRule[] = [
	{ selector: ".a", loc: { path: "src/a.css", line: 1, endLine: 3 }, decls: [{ name: "color", value: "red", loc: { path: "src/a.css", line: 2 } }] },
	{ selector: ".b", loc: { path: "src/a.css", line: 10, endLine: 12 }, decls: [{ name: "color", value: "red", loc: { path: "src/a.css", line: 11 } }] },
	{ selector: "style attribute", inline: "body > main", loc: null, decls: [{ name: "color", value: "red", loc: null }] },
];

function reference(): { elements: ElementManifest; styles: StyleManifest } {
	const tree = [el("main", [el("main/one", [], 5), el("main/two"), el("main/three")])];
	const styles: Record<string, ElementStyles> = {
		main: { computed: { color: "red" }, winners: { color: { decl: [2, 0] } } },
		"main/one": { computed: { color: "red" }, winners: { color: { decl: [0, 0] } } },
		"main/two": { computed: { color: "red" }, winners: { color: { decl: [1, 0] } } },
		"main/three": { computed: { color: "red" }, winners: { color: { decl: [2, 0], inherited: true } } },
	};
	return {
		elements: { version: 3, url: "/", extractedAt: "", scale: 1, elements: tree },
		styles: { version: 1, rules: refRules, elements: styles },
	};
}

function plan(opts: { diffText?: string; changed?: string[]; computed?: Record<string, Record<string, string>> } = {}) {
	const fresh = [el("main", [el("main/one", [], 5), el("main/two"), el("main/three")])];
	const mapper = new LineMapper(parseUnifiedDiff(opts.diffText ?? ""));
	return {
		fresh,
		plan: planElements({
			fresh,
			raw: raw(fresh, opts.computed ?? {}),
			changed: new Set(opts.changed ?? []),
			reference: reference(),
			mapper,
			match: matchOptions(DEFAULT_CONFIG.match),
			properties: ["color"],
		}),
	};
}

test("planElements: nothing changed carries every element over", () => {
	const { plan: p } = plan();
	assert.deepEqual(p.query, []);
	assert.equal(p.carried.size, 4);
});

test("planElements: changed computed values, changed rules and JSX lines are queried", () => {
	assert.deepEqual(plan({ computed: { "main/two": { color: "blue" } } }).plan.query, ["body > main > two"]);
	assert.deepEqual(plan({ changed: ["body > main > three"] }).plan.query, ["body > main > three"]);
	assert.deepEqual(plan({ diffText: diff("src/App.tsx", ["@@ -5 +5 @@", "-<div/>", "+<div className=\"x\"/>"]) }).plan.query, [
		"body > main > one",
	]);
});

test("planElements: a winner on an edited line is queried, a shifted one carried", () => {
	const edited = plan({ diffText: diff("src/a.css", ["@@ -11 +11 @@", "-  color: red;", "+  color: red !important;"]) });
	assert.deepEqual(edited.plan.query, ["body > main > two"]);
	const shifted = plan({ diffText: diff("src/a.css", ["@@ -5,0 +6,2 @@", "+.x {}", "+.y {}"]) });
	assert.deepEqual(shifted.plan.query, []);
	assert.deepEqual(shifted.plan.rules.get(1)?.loc, { path: "src/a.css", line: 12, endLine: 14 });
});

test("planElements: without a reference everything is queried", () => {
	const fresh = [el("main")];
	const p = planElements({
		fresh,
		raw: raw(fresh, {}),
		changed: new Set(),
		reference: null,
		mapper: null,
		match: matchOptions(DEFAULT_CONFIG.match),
		properties: ["color"],
	});
	assert.equal(p.query, "all");
});

test("assembleStyles: carried winners point into the new rule table, fresh ones follow", () => {
	const { fresh, plan: p } = plan({ computed: { "main/two": { color: "blue" } } });
	const two = fresh[0].children[1];
	const freshRule: StyleRule = { selector: ".b", loc: null, decls: [{ name: "color", value: "blue", loc: null }] };
	const out = assembleStyles(p, () => ({ color: "red" }), {
		rules: [freshRule],
		elements: new Map([[two, { computed: { color: "blue" }, winners: { color: { decl: [0, 0] } } }]]),
	});
	const winner = (dir: string) => {
		const ref = out.elements[dir].winners.color.decl!;
		return out.rules[ref[0]];
	};
	assert.equal(winner("main/one").selector, ".a");
	assert.equal(winner("main/two"), freshRule);
	assert.equal(winner("main").inline, "body > main");
	assert.equal(out.elements["main/three"].winners.color.inherited, true);
	assert.equal(out.rules.filter((r) => r.inline).length, 1); // shared, not duplicated
});

// --- redirects in diffs -----------------------------------------------------

function writePage(dir: string, slug: string): void {
	const png = new PNG({ width: 4, height: 4 });
	fs.mkdirSync(path.join(dir, slug), { recursive: true });
	fs.writeFileSync(path.join(dir, slug, "page.png"), PNG.sync.write(png));
}

function redirect(dir: string, slug: string, to: string): void {
	fs.mkdirSync(path.join(dir, slug), { recursive: true });
	fs.writeFileSync(path.join(dir, slug, REDIRECT_RECORD), JSON.stringify({ url: `http://x/${to}`, to }));
}

test("diffVersions: a page that starts redirecting is one change", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tv-redirect-"));
	try {
		const a = path.join(root, "a");
		const b = path.join(root, "b");
		writePage(a, "index");
		writePage(b, "index");
		writePage(a, "login");
		redirect(b, "login", "index");
		redirect(a, "product", "index");
		redirect(b, "product", "index");
		const report = diffVersions(a, b, path.join(root, "out"), DEFAULT_CONFIG, { from: "a", to: "b" });
		const notable = report.pages.filter((p) => p.status !== "unchanged");
		assert.deepEqual(notable, [{ filename: "login/page.png", status: "changed", message: "now redirects to /index" }]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// --- fingerprint stability --------------------------------------------------

test("compareSamples: names the attributes that varied", () => {
	const s = (fp: string, dom: string[], resources: [string, string][] = []) => ({ fingerprint: fp, dom, resources });
	assert.equal(compareSamples([s("1", ["E .0 div"]), s("1", ["E .0 div"])]), null);
	const v = compareSamples([
		s("1", ["E .0 div", "A .0 data-t=1", "A .0 class=x", "T .0.0 hi"], [["a.js", "h1"]]),
		s("2", ["E .0 div", "A .0 data-t=2", "A .0 class=x", "T .0.0 ho"], [["a.js", "h2"]]),
	]);
	assert.deepEqual([...(v?.attributes ?? [])], ["data-t"]);
	assert.equal(v?.text, 2);
	assert.deepEqual([...(v?.resources ?? [])], ["a.js"]);
});
