import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTLE_MS, DEVTOOLS_OVERLAY_SELECTORS, stabilizeScript } from "../src/stabilize.js";

test("stabilize script substitutes the settle delay", () => {
	assert.ok(stabilizeScript().includes(`sleep(${DEFAULT_SETTLE_MS})`));
	assert.ok(stabilizeScript(2500).includes("sleep(2500)"));
	assert.ok(stabilizeScript(-5).includes("sleep(0)"), "negative settle clamps to 0");
	assert.ok(!stabilizeScript().includes("__SETTLE_MS__"));
});

test("stabilize script hides every dev overlay selector", () => {
	const js = stabilizeScript();
	assert.ok(!js.includes("__OVERLAY_SELECTORS__"));
	const start = js.indexOf("const overlays = ");
	assert.ok(start > 0);
	// Selectors themselves contain `]`, so take the whole array literal up to the statement's end.
	const end = js.indexOf(";", start);
	const list = JSON.parse(js.slice(js.indexOf("[", start), js.lastIndexOf("]", end) + 1)) as string[];
	assert.deepEqual(list, DEVTOOLS_OVERLAY_SELECTORS);
	for (const sel of ["astro-dev-toolbar", ".tsqd-parent-container", ".TanStackRouterDevtools", "#tanstack-devtools-panel"]) {
		assert.ok(list.includes(sel), `missing ${sel}`);
	}
});

test("overlays are hidden before the scroll pass and the freeze", () => {
	const js = stabilizeScript();
	const hideAt = js.indexOf('"hide-devtools"');
	const scrollAt = js.indexOf("window.scrollTo(");
	const freezeAt = js.indexOf('"stabilize"');
	assert.ok(hideAt > 0 && scrollAt > 0 && freezeAt > 0);
	assert.ok(hideAt < scrollAt, "hide runs before the scroll pass");
	assert.ok(scrollAt < freezeAt, "scroll pass runs before the CSS freeze");
});

test("stabilize script is a single async arrow the page can call", () => {
	const js = stabilizeScript();
	assert.ok(js.startsWith("async () => {"));
	assert.ok(js.endsWith("}"));
	// Parses as an expression; a syntax slip here would only surface mid-capture.
	assert.doesNotThrow(() => new Function(`return (${js});`));
});
