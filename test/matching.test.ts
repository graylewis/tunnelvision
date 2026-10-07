import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { ElementNode } from "../src/elements.js";
import { parseUnifiedDiff } from "../src/git.js";
import { matchElements, matchOptions } from "../src/matching.js";
import { LineMapper } from "../src/remap.js";

const FILE = "src/Team.tsx";

/** A span rendered by `Team` at `line` of its file, or a div holding `children`. */
function el(dir: string, line: number, children: ElementNode[] = []): ElementNode {
	const rect = { x: 0, y: 0, width: 1, height: 1 };
	return {
		tag: children.length ? "div" : "span",
		id: null,
		className: null,
		slug: dir.split("/").pop()!,
		dir,
		selector: dir,
		rect,
		box: rect,
		react: null,
		identity: { attributes: {}, name: null, key: null, component: "Team", file: FILE, source: `${FILE}:${line}:9` },
		children,
	};
}

/** Baseline dir → target dir, for every pair under the root. */
function pairs(from: ElementNode[], to: ElementNode[], diffText: string | null): Record<string, string> {
	const mapper = diffText === null ? null : new LineMapper(parseUnifiedDiff(diffText));
	const match = matchElements(from, to, matchOptions(DEFAULT_CONFIG.match), mapper);
	return Object.fromEntries([...match.fromTo].filter(([a]) => a.dir !== "root").map(([a, b]) => [a.dir, b.dir]));
}

function diff(...hunks: string[][]): string {
	return [`diff --git a/${FILE} b/${FILE}`, `--- a/${FILE}`, `+++ b/${FILE}`, ...hunks.flat(), ""].join("\n");
}

test("matchElements: siblings on adjacent lines stay paired when a line is added above them", () => {
	const from = [el("root", 140, [el("root/roster", 141), el("root/count", 142)])];
	const to = [el("root", 141, [el("root/roster", 142), el("root/count", 143)])];
	const expected = { "root/roster": "root/roster", "root/count": "root/count" };
	assert.deepEqual(pairs(from, to, diff(["@@ -5,0 +6 @@", "+import x from './x';"])), expected);
	// Without the commit's diff, raw lines aren't compared at all.
	assert.deepEqual(pairs(from, to, null), expected);
});

test("matchElements: remapped lines pair the sibling that's left when another is removed", () => {
	const from = [el("root", 9, [el("root/a", 10), el("root/b", 11)])];
	const to = [el("root", 10, [el("root/b", 11)])];
	const text = diff(["@@ -0,0 +1 @@", "+'use client';"], ["@@ -10 +10,0 @@", "-<span>a</span>"]);
	assert.deepEqual(pairs(from, to, text), { "root/b": "root/b" });
});
