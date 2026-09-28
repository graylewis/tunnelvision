import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { Cascade } from "../src/cascade.js";
import type { RawStyles } from "../src/styles.js";

// Recorded from the spike page by capture.py's read_styles (see FINDINGS.md).
const fixture = JSON.parse(fs.readFileSync("test/fixtures/raw-styles.json", "utf8")) as {
	styles: RawStyles;
	computedX: Record<string, string>;
};
const PARENT = "body > div:nth-of-type(1)";
const X = `${PARENT} > div:nth-of-type(1)`;
const P = `${X} > p:nth-of-type(1)`;

const cascade = new Cascade(fixture.styles);
const props = Object.keys(fixture.computedX);
const x = cascade.resolveElement(X, props, fixture.computedX);

/** `selector: first declaration's name` of a winner, for readable assertions. */
function describe(ref: [number, number] | undefined): string | undefined {
	if (!ref) return undefined;
	const rule = fixture.styles.rules[ref[0]];
	return `${rule.selector}: ${rule.decls[ref[1]].name}`;
}

test("!important beats specificity", () => {
	assert.equal(describe(x.winners.color?.decl), ".spike-b: color");
	assert.equal(x.computed.color, "rgb(0, 0, 255)");
});

test("inline style beats rules", () => {
	assert.equal(describe(x.winners["padding-left"]?.decl), "style attribute: padding-left");
});

test("unlayered rules beat layered ones, and shorthands set their longhands", () => {
	assert.equal(describe(x.winners["padding-top"]?.decl), ".spike-a: padding");
	assert.deepEqual(fixture.styles.rules[x.winners["padding-top"]?.decl![0]].layers, undefined);
});

test("var() is followed to the custom properties that supply it", () => {
	assert.equal(describe(x.winners["margin-top"]?.decl), "style attribute: margin-top");
	assert.deepEqual(x.winners["margin-top"]?.via?.map(describe), [":root: --spike-gap"]);
	// margin: var(--spike-alias), where --spike-alias: var(--spike-gap).
	assert.equal(describe(x.winners["margin-left"]?.decl), ".spike-a: margin");
	const alias = x.winners["margin-left"]?.via!.map((ref) => fixture.styles.rules[ref[0]].decls[ref[1]].name);
	assert.deepEqual(alias, ["--spike-alias", "--spike-gap"]);
});

test("CSS Module rules resolve like any other", () => {
	assert.equal(describe(x.winners["border-top-width"]?.decl), "._box_zlz7f_1: border");
});

test("inheritable properties fall back to the nearest ancestor", () => {
	assert.equal(describe(x.winners["font-size"]?.decl), ".spike-parent: font-size");
	assert.equal(x.winners["font-size"]?.inherited, true);
	const p = cascade.resolveElement(P, ["color", "padding-top"], {});
	assert.equal(describe(p.winners.color?.decl), ".spike-b: color");
	assert.equal(p.winners.color?.inherited, true);
	// Non-inherited properties don't look at ancestors.
	assert.equal(p.winners["padding-top"]?.decl, undefined);
});

const range = { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 };
function synthetic(rules: RawStyles["rules"], inherited: number[][] = []): Cascade {
	return new Cascade({ sheets: [], rules, nodes: { el: { rules: rules.map((_, i) => i), inherited } } });
}

test("among !important declarations, earlier layers win", () => {
	const c = synthetic([
		{ sheet: "s", selector: ".a", selectorRange: null, layers: ["base"], decls: [{ name: "color", value: "red", important: true, range }] },
		{ sheet: "s", selector: ".a", selectorRange: null, layers: ["theme"], decls: [{ name: "color", value: "green", important: true, range }] },
		{ sheet: "s", selector: ".a", selectorRange: null, decls: [{ name: "color", value: "blue", important: true, range }] },
	]);
	assert.equal(c.resolveElement("el", ["color"], {}).winners.color?.decl?.[0], 0);
});

test("`inherit` defers to the parent and `unset` is uncertain", () => {
	const parent = { sheet: "s", selector: ".p", selectorRange: null, decls: [{ name: "padding-top", value: "4px", range }] };
	const inherit = new Cascade({
		sheets: [],
		rules: [{ sheet: "s", selector: ".a", selectorRange: null, decls: [{ name: "padding-top", value: "inherit", range }] }, parent],
		nodes: { el: { rules: [0], inherited: [[1]] } },
	});
	assert.deepEqual(inherit.resolveElement("el", ["padding-top"], {}).winners["padding-top"]?.decl, [1, 0]);

	const unset = synthetic([{ sheet: "s", selector: ".a", selectorRange: null, decls: [{ name: "color", value: "unset", range }] }]);
	const v = unset.resolveElement("el", ["color"], {}).winners.color;
	assert.equal(v?.decl, undefined);
	assert.equal(v?.uncertain, true);
});

test("a var() cycle terminates", () => {
	const c = synthetic([
		{
			sheet: "s",
			selector: ":root",
			selectorRange: null,
			decls: [
				{ name: "--a", value: "var(--b)", range },
				{ name: "--b", value: "var(--a)", range },
				{ name: "color", value: "var(--a)", range },
			],
		},
	]);
	assert.deepEqual(c.resolveElement("el", ["color"], {}).winners.color?.via, [
		[0, 0],
		[0, 1],
	]);
});
