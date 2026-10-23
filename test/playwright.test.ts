import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { ancestors, checkPlaywright, normalUrl, pageFunction, resourceKey, wantedLeaves } from "../src/playwright.js";

test("pageFunction: function source becomes a function whose source is the string", () => {
	for (const src of ["async () => 1", "() => 1", "({ selectors, elements }) => 1", "x => x", "async x => x", "function () { return 1 }", "async function f() {}"]) {
		const fn = pageFunction(src);
		assert.equal(typeof fn, "function", src);
		assert.equal(String(fn), src);
	}
});

test("pageFunction: expressions stay strings", () => {
	for (const src of ["new Promise((resolve) => resolve(1))", "document.querySelector('.ready')", "window.loaded === true", "({ a: 1 }).a"]) {
		assert.equal(pageFunction(src), src);
	}
});

test("normalUrl drops the fragment and trailing slashes, lowercases the host, keeps the query", () => {
	assert.equal(normalUrl("http://LocalHost:3000/about/#team"), "http://localhost:3000/about");
	assert.equal(normalUrl("http://localhost:3000/"), "http://localhost:3000/");
	assert.equal(normalUrl("http://localhost:3000/a//?q=1"), "http://localhost:3000/a?q=1");
	assert.equal(normalUrl("http://localhost:3000/a/"), normalUrl("http://localhost:3000/a"));
});

test("resourceKey strips dev stamps and every trailing ? or &, like the Python driver's rstrip", () => {
	assert.equal(resourceKey("http://x/src/a.js?t=1712345678901"), "http://x/src/a.js");
	assert.equal(resourceKey("http://x/_next/static/a.js?v=1712345678901&dpl=1"), "http://x/_next/static/a.js?dpl=1");
	assert.equal(resourceKey("http://x/a.css?&&"), "http://x/a.css");
});

test("ancestors: nearest first, ending at html", () => {
	assert.deepEqual(ancestors("body > main > div:nth-of-type(2)"), ["body > main", "body", "html"]);
	assert.deepEqual(ancestors("body"), ["html"]);
});

test("wantedLeaves: wanted elements with no wanted descendant", () => {
	const tree = [
		{ selector: "a", children: [{ selector: "a > b", children: [{ selector: "a > b > c", children: [] }] }, { selector: "a > d", children: [] }] },
	];
	assert.deepEqual(wantedLeaves(tree, null), ["a > b > c", "a > d"]);
	assert.deepEqual(wantedLeaves(tree, new Set(["a", "a > b"])), ["a > b"]);
	assert.deepEqual(wantedLeaves(tree, new Set(["a"])), ["a"]);
});

test("Playwright calls function source handed over by pageFunction, with its argument", { skip: !checkPlaywright().installed && "chromium not installed" }, async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		assert.equal(await page.evaluate(pageFunction("async () => 40 + 2") as () => number), 42);
		assert.equal(await page.evaluate(pageFunction("({ a, b }) => a + b") as (x: { a: number; b: number }) => number, { a: 1, b: 2 }), 3);
		assert.equal(await page.evaluate(pageFunction("new Promise((r) => r('expr'))") as () => string), "expr");
		await page.waitForFunction(pageFunction("() => document.readyState === 'complete'") as () => boolean, undefined, { timeout: 2000 });
	} finally {
		await browser.close();
	}
});
