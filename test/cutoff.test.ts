import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import { countsAsChanged } from "../src/diffengine.js";
import { rendererDifference } from "../src/renderer.js";

const config = (diff: Partial<Config["diff"]> = {}): Config => ({ ...DEFAULT_CONFIG, diff: { ...DEFAULT_CONFIG.diff, ...diff } });

test("one differing pixel is a visual change, however large the image", () => {
	// 1 pixel of a 1280x800 page: 0.0001%, far under the old 0.03% cutoff.
	assert.equal(countsAsChanged(1, (1 / 1_024_000) * 100, undefined, config()), true);
	assert.equal(countsAsChanged(0, 0, undefined, config()), false);
});

test("minDiffPixels sets how many pixels must differ, and never lets an identical image count", () => {
	assert.equal(countsAsChanged(3, 1, undefined, config({ minDiffPixels: 4 })), false);
	assert.equal(countsAsChanged(4, 1, undefined, config({ minDiffPixels: 4 })), true);
	assert.equal(countsAsChanged(0, 0, undefined, config({ minDiffPixels: 0 })), false);
});

test("a percentage cutoff applies only when a project opts into one", () => {
	assert.equal(countsAsChanged(64, 0.029, 0.03, config({ maxDiffPercent: 0.03 })), false);
	assert.equal(countsAsChanged(64, 0.031, 0.03, config({ maxDiffPercent: 0.03 })), true);
	assert.equal(DEFAULT_CONFIG.diff.maxDiffPercent, undefined);
});

test("versions rendered by another Playwright or OS are told apart; unknown renderers aren't", () => {
	const mac = { playwright: "1.63.0", os: "darwin 25.6.0 arm64" };
	assert.equal(rendererDifference(mac, { ...mac }), null);
	assert.equal(rendererDifference(mac, { ...mac, playwright: "1.64.0" }), "playwright 1.63.0 → 1.64.0");
	assert.equal(rendererDifference(undefined, mac), null);
});
