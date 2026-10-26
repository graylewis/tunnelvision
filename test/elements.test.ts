import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { extractScript, type RawElement } from "../src/elements.js";
import { checkPlaywright } from "../src/playwright.js";

const PAGE = `<!doctype html><body>
<main>
	<p id="status"><span id="chip" style="display:inline-flex;background:red;padding:2px">FAILED</span></p>
	<p id="prose">Press <kbd style="display:inline-block;border:1px solid">K</kbd> to search</p>
	<p id="wrapped">See <span><button style="display:inline-block">this</button></span> one</p>
	<h1 id="split">${"<span style=\"display:inline-block\">a</span>".repeat(21)}</h1>
	<div id="actions"><a id="cta" href="#" style="display:inline-flex;padding:4px">Go</a><span id="flat" style="background:blue">plain</span></div>
	<div id="marked" data-tv-atom>marked</div>
</main>
</body>`;

function flatten(nodes: RawElement[]): RawElement[] {
	return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

test(
	"elements are nodes that form one box: atomic inline-level ones too, unless they're part of a line of text",
	{ skip: !checkPlaywright().installed && "chromium not installed" },
	async () => {
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			await page.setContent(PAGE);
			const tree = await page.evaluate<RawElement[]>(extractScript([], ["color"]));
			const byId = new Map(flatten(tree).map((n) => [n.id ?? `${n.tag}`, n]));

			// A chip on its own in a paragraph is an element, and its copy is its own.
			assert.equal(byId.get("chip")?.text, "FAILED");
			assert.equal(byId.get("status")?.text, "");
			// In a line of text, directly or through inline wrappers, a box is the sentence's.
			assert.equal(byId.get("prose")?.children.length, 0);
			assert.equal(byId.get("prose")?.text, "Press K to search");
			assert.equal(byId.get("wrapped")?.children.length, 0);
			// More than 20 atomic siblings are text set as boxes.
			assert.equal(byId.get("split")?.children.length, 0);
			// `display: inline` never forms an element, background or not.
			assert.deepEqual(byId.get("actions")?.children.map((c) => c.id), ["cta"]);
			assert.equal(byId.get("actions")?.text, "plain");
			// What a user acts on, and what's marked as an atom, is recorded as such.
			assert.equal(byId.get("cta")?.interactive, true);
			assert.equal(byId.get("status")?.interactive, undefined);
			assert.equal(byId.get("marked")?.atom, true);
		} finally {
			await browser.close();
		}
	},
);
