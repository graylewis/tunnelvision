import assert from "node:assert/strict";
import test from "node:test";
import { parseUnifiedDiff } from "../src/git.js";
import { LineMapper } from "../src/remap.js";
import { encode } from "@jridgewell/sourcemap-codec";
import { TraceMap } from "@jridgewell/trace-mapping";
import { functionRanges, originalEnds, packageChanges, remapCode, touchedBy, type UnitCode } from "../src/unitcode.js";

function diff(file: string, ...hunks: string[][]): Map<string, import("../src/git.js").FileChanges> {
	return parseUnifiedDiff([`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, ...hunks.flat(), ""].join("\n"));
}

// api.js: request 1-5 and fetchStats 7-9 ran; fetchFeed 11-13 and createOrder 16-18 didn't; 6, 10, 14-15 are module scope.
const code: UnitCode = {
	ran: { "src/api.js": [[1, 5], [7, 9]] },
	functions: { "src/api.js": [[1, 5], [7, 9], [11, 13], [16, 18]] },
	packages: {},
};

test("touchedBy: a changed line in a function that ran", () => {
	assert.deepEqual(touchedBy(code, diff("src/api.js", ["@@ -8 +8 @@", "-a", "+b"])), [{ side: "RIGHT", path: "src/api.js", line: 8 }]);
});

test("touchedBy: a changed line in a function that didn't run doesn't count", () => {
	assert.deepEqual(touchedBy(code, diff("src/api.js", ["@@ -17 +17 @@", "-a", "+b"])), []);
});

test("touchedBy: module scope counts, deleted or inserted", () => {
	assert.deepEqual(touchedBy(code, diff("src/api.js", ["@@ -14,0 +15 @@", "+const X = 1;"])), [{ side: "RIGHT", path: "src/api.js", line: 15 }]);
	assert.deepEqual(touchedBy(code, diff("src/api.js", ["@@ -0,0 +1 @@", "+import x from 'x';"])), [{ side: "RIGHT", path: "src/api.js", line: 1 }]);
	assert.deepEqual(touchedBy(code, diff("src/api.js", ["@@ -6 +5,0 @@", "-const gone = 1;"])), [{ side: "LEFT", path: "src/api.js", line: 6 }]);
});

test("touchedBy: lines added inside a function count only if it ran", () => {
	assert.deepEqual(touchedBy(code, diff("src/api.js", ["@@ -2,0 +3 @@", "+x();"])), [{ side: "RIGHT", path: "src/api.js", line: 3 }]);
	assert.deepEqual(touchedBy(code, diff("src/api.js", ["@@ -12,0 +13 @@", "+x();"])), []);
	// After the last line of a function that didn't run: between it and module scope.
	assert.deepEqual(touchedBy(code, diff("src/api.js", ["@@ -13,0 +14 @@", "+x();"])), [{ side: "RIGHT", path: "src/api.js", line: 14 }]);
});

test("touchedBy: other files, renames, and a project in a subdirectory", () => {
	assert.deepEqual(touchedBy(code, diff("src/other.js", ["@@ -8 +8 @@", "-a", "+b"])), []);
	const renamed = parseUnifiedDiff(["diff --git a/src/api.js b/src/http.js", "rename from src/api.js", "rename to src/http.js", ""].join("\n"));
	assert.deepEqual(touchedBy(code, renamed), [{ side: "RIGHT", path: "src/http.js" }]);
	assert.deepEqual(touchedBy(code, diff("web/src/api.js", ["@@ -8 +8 @@", "-a", "+b"]), "web"), [{ side: "RIGHT", path: "src/api.js", line: 8 }]);
});

test("remapCode moves ranges past lines added above them", () => {
	const changes = diff("src/api.js", ["@@ -0,0 +1,2 @@", "+// a", "+// b"]);
	assert.deepEqual(remapCode(code, new LineMapper(changes)), {
		ran: { "src/api.js": [[3, 7], [9, 11]] },
		functions: { "src/api.js": [[3, 7], [9, 11], [13, 15], [18, 20]] },
		packages: {},
	});
});

test("remapCode drops a function range that no longer maps, and fails on a range that ran", () => {
	const inFeed = diff("src/api.js", ["@@ -13 +13 @@", "-}", "+};"]);
	assert.deepEqual(remapCode(code, new LineMapper(inFeed))?.functions["src/api.js"], [[1, 5], [7, 9], [16, 18]]);
	const inStats = diff("src/api.js", ["@@ -9 +9 @@", "-}", "+};"]);
	assert.equal(remapCode(code, new LineMapper(inStats)), null);
});

test("originalEnds: bundler glue the map has no entry for isn't placed; a wrapper around mapped lines is", () => {
	// Turbopack-style: a module factory and an export getter around one mapped function.
	const src = "(ctx) => {\nctx.s([\"f\", ()=>f]);\nfunction f() {\n  return 1;\n}\n}";
	const map = new TraceMap({
		version: 3,
		sources: ["src/api.js"],
		names: [],
		mappings: encode([[], [], [[0, 0, 0, 0]], [[2, 0, 1, 2]], [[0, 0, 2, 0]], []]),
	});
	const lineStarts = [0, ...[...src.matchAll(/\n/g)].map((m) => m.index + 1)];
	const ends = (code: string) => {
		const start = src.indexOf(code);
		const e = originalEnds(map, lineStarts, start, start + code.length);
		return e && [e.from.line, e.to.line, e.wrapper];
	};
	assert.equal(ends("()=>f"), null);
	assert.deepEqual(ends("function f() {\n  return 1;\n}"), [1, 3, false]);
	assert.deepEqual(ends(src), [1, 1, true]);
});

test("functionRanges finds every function in plain JS, and nothing in what doesn't parse", () => {
	const src = "function a() {}\nconst b = () => 1;\nclass C { m() { return function () {}; } }\nexport default async x => x;";
	const found = functionRanges(src).map(([s, e]) => src.slice(s, e));
	assert.deepEqual(found, ["function a() {}", "() => 1", "() { return function () {}; }", "function () {}", "async x => x"]);
	assert.deepEqual(functionRanges("this is not js {"), []);
});

test("packageChanges: a package now installed at another version, traced to the lockfile line naming it", async () => {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tunnelvision-pkg-"));
	fs.mkdirSync(path.join(root, "node_modules", "@scope", "lib"), { recursive: true });
	fs.writeFileSync(path.join(root, "node_modules", "@scope", "lib", "package.json"), JSON.stringify({ version: "2.0.0" }));
	const withPkgs = (packages: Record<string, string>): UnitCode => ({ ran: {}, functions: {}, packages });
	const lock = diff("package-lock.json", ["@@ -10 +10 @@", '-      "resolved": "https://registry.npmjs.org/@scope/lib/-/lib-1.0.0.tgz",', '+      "resolved": "https://registry.npmjs.org/@scope/lib/-/lib-2.0.0.tgz",']);
	assert.deepEqual(packageChanges(withPkgs({ "@scope/lib": "2.0.0" }), root, lock, ["package-lock.json"]), { lines: [], changed: [] });
	assert.deepEqual(packageChanges(withPkgs({ "@scope/lib": "1.0.0" }), root, lock, ["package-lock.json"]), {
		lines: [{ side: "RIGHT", path: "package-lock.json", line: 10 }],
		changed: ["@scope/lib"],
	});
	// Not named in the lockfile's changes: the lockfile itself. No lockfile change: just the package.
	const other = diff("bun.lock", ["@@ -3 +3 @@", "-a", "+b"]);
	assert.deepEqual(packageChanges(withPkgs({ "@scope/lib": "1.0.0" }), root, other, ["bun.lock"]).lines, [{ side: "RIGHT", path: "bun.lock" }]);
	assert.deepEqual(packageChanges(withPkgs({ "@scope/lib": "1.0.0" }), root, new Map(), ["bun.lock"]), { lines: [], changed: ["@scope/lib"] });
	assert.deepEqual(packageChanges(withPkgs({ gone: "1.0.0" }), root, new Map(), []).changed, ["gone"]);
});
