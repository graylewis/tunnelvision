import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { cssPipeline, describeCheck, type CssPipeline } from "../src/stylemaps.js";
import { StyleLocator } from "../src/stylesource.js";
import type { RawStyles } from "../src/styles.js";

// A project whose PostCSS (a stand-in for the real thing, in its node_modules)
// runs one plugin that puts `lines` generated rules above the file, as
// Tailwind does, with a map from each of the file's lines to where it ends up.

const SOURCE = ":root {\n  --level-2: #333;\n}\nbody {\n  margin: 0;\n  color: var(--level-2);\n}\n";
/** Rules the plugin generates above the file. */
const GENERATED = 3;

const FAKE_POSTCSS = `
const path = require("node:path");
module.exports = (plugins) => ({
	async process(css, opts) {
		const lines = plugins.reduce((n, p) => n + p.prepend, 0);
		const header = Array.from({ length: lines }, (_, i) => ".generated-" + i + " { color: red; }");
		const input = css.split("\\n");
		const mappings = ";".repeat(lines) + input.map((_, i) => (i === 0 ? "AAAA" : "AACA")).join(";");
		return {
			css: [...header, ...input].join("\\n"),
			map: { toJSON: () => ({ version: 3, sources: [path.basename(opts.from)], names: [], mappings }) },
		};
	},
});
`;

/** What the fake PostCSS makes of SOURCE. */
const compiled = (source = SOURCE) =>
	[...Array.from({ length: GENERATED }, (_, i) => `.generated-${i} { color: red; }`), ...source.split("\n")].join("\n");

function project(options: { postcss?: boolean } = {}): { root: string; file: string; pipeline: CssPipeline } {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tv-stylemaps-")));
	const file = path.join(root, "src", "app", "globals.css");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, SOURCE);
	const write = (rel: string, text: string) => {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), text);
	};
	write("node_modules/postcss/index.js", FAKE_POSTCSS);
	write("node_modules/prepend-rules/index.js", "module.exports = (options) => ({ prepend: options.lines });");
	const config = path.join(root, "postcss.config.mjs");
	if (options.postcss !== false) write("postcss.config.mjs", `export default { plugins: { "prepend-rules": { lines: ${GENERATED} } } };`);
	return { root, file, pipeline: { postcssConfig: options.postcss === false ? null : config, turbopack: true, turbopackLoader: false } };
}

const inlineMap = (map: object) => `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;
const range = (line: number) => ({ startLine: line, startColumn: 0, endLine: line, endColumn: 10 });

/**
 * The sheet Turbopack serves for `file`: a header comment, then `copy` line
 * for line, with an index map whose section carries `copy` as the file's
 * content. The `body` rule is on the served sheet's last line but one.
 */
function served(file: string, copy: string, sourceFile = file): RawStyles {
	const lines = copy.split("\n");
	const section = {
		version: 3,
		sources: [pathToFileURL(sourceFile).href],
		sourcesContent: [copy],
		names: [],
		mappings: lines.map((_, i) => (i === 0 ? "AAAA" : "AACA")).join(";"),
	};
	const text = `/* [project]/src/app/globals.css [app-client] (css) */\n${copy}`;
	const body = lines.findIndex((l) => l.startsWith("body")) + 1;
	return {
		sheets: [
			{
				id: "s1",
				sourceURL: "http://localhost:3000/_next/static/chunks/src_app_globals.css",
				sourceMapURL: inlineMap({ version: 3, sources: [], sections: [{ offset: { line: 1, column: 0 }, map: section }] }),
				startLine: 0,
				devId: null,
				text,
			},
		],
		rules: [{ sheet: "s1", selector: "body", selectorRange: range(body), styleRange: range(body), decls: [{ name: "color", value: "var(--level-2)", range: range(body) }] }],
		nodes: {},
	};
}

const SHEET = "http://localhost:3000/_next/static/chunks/src_app_globals.css";

test("a map whose copy of the file is PostCSS's output is reported, and its rules get no line instead of a wrong one", async () => {
	const { root, file, pipeline } = project();
	const { rules, checks } = await new StyleLocator(root, { pipeline }).rules(served(file, compiled()));
	assert.deepEqual(checks, [{ sheet: SHEET, file: "src/app/globals.css", problem: "postcss-output" }]);
	assert.equal(rules[0].loc, null);
	assert.equal(rules[0].decls[0].loc, null);
	assert.deepEqual(rules[0].untraced, { file: "src/app/globals.css", problem: "postcss-output" });
});

test("with the workaround on, positions go through the rebuilt PostCSS map to the line in the file", async () => {
	const { root, file, pipeline } = project();
	const { rules, checks } = await new StyleLocator(root, { rebuild: true, pipeline }).rules(served(file, compiled()));
	assert.deepEqual(checks, [{ sheet: SHEET, file: "src/app/globals.css", problem: "postcss-output", patched: true }]);
	assert.deepEqual(rules[0].decls[0].loc, { path: "src/app/globals.css", line: 4 });
	assert.equal(rules[0].untraced, undefined);
});

test("a copy that's neither the file nor PostCSS's output for it is a stale compile, and isn't patched", async () => {
	const { root, file, pipeline } = project();
	const older = compiled(SOURCE.replace("#333", "#252525"));
	const { rules, checks } = await new StyleLocator(root, { rebuild: true, pipeline }).rules(served(file, older));
	assert.deepEqual(checks, [{ sheet: SHEET, file: "src/app/globals.css", problem: "stale" }]);
	assert.equal(rules[0].decls[0].loc, null);
	assert.match(describeCheck(checks[0], { turbopack: true, rebuild: true }), /stale compile/);
});

test("a copy that matches the file needs nothing rebuilt", async () => {
	const { root, file, pipeline } = project();
	const { rules, checks } = await new StyleLocator(root, { rebuild: true, pipeline }).rules(served(file, SOURCE));
	assert.deepEqual(checks, []);
	assert.deepEqual(rules[0].decls[0].loc, { path: "src/app/globals.css", line: 4 });
});

test("without a PostCSS config a mismatched copy has no known cause", async () => {
	const { root, file, pipeline } = project({ postcss: false });
	const { checks } = await new StyleLocator(root, { pipeline }).rules(served(file, compiled()));
	assert.deepEqual(checks, [{ sheet: SHEET, file: "src/app/globals.css", problem: "unknown" }]);
	assert.match(describeCheck(checks[0], { turbopack: true, rebuild: false }), /workarounds\.turbopackPostcssMaps/);
});

test("Sass sources and Turbopack loaders are named as what can't be rebuilt", async () => {
	const { root, file, pipeline } = project();
	const scss = path.join(root, "src", "app", "theme.scss");
	fs.writeFileSync(scss, "$c: #333;\nbody { color: $c; }\n");
	const sass = await new StyleLocator(root, { rebuild: true, pipeline }).rules(served(file, "body { color: #333; }\n", scss));
	assert.deepEqual(sass.checks.map((c) => c.problem), ["preprocessor"]);

	const loader = await new StyleLocator(root, { rebuild: true, pipeline: { ...pipeline, postcssConfig: null, turbopackLoader: true } }).rules(served(file, compiled()));
	assert.deepEqual(loader.checks.map((c) => c.problem), ["turbopack-loader"]);
});

test("a source that isn't on disk is reported, except next/font's generated module", async () => {
	const { root, file, pipeline } = project();
	const gone = await new StyleLocator(root, { pipeline }).rules(served(file, SOURCE, path.join(root, "src", "app", "gone.css")));
	assert.deepEqual(gone.checks, [{ sheet: SHEET, file: "src/app/gone.css", problem: "missing-source", detail: "src/app/gone.css" }]);
	const font = await new StyleLocator(root, { pipeline }).rules(served(file, SOURCE, path.join(root, "src", "app", "jetbrainsmono_c541ad42.module.css")));
	assert.deepEqual(font.checks, []);
});

test("a sheet without a map that isn't its file marks its rules as untraced", async () => {
	const { root, file, pipeline } = project();
	const styles = served(file, compiled());
	styles.sheets[0].sourceMapURL = null;
	const { rules, checks } = await new StyleLocator(root, { pipeline }).rules(styles);
	assert.deepEqual(checks, [{ sheet: SHEET, problem: "no-map" }]);
	assert.deepEqual(rules[0].untraced, { file: SHEET, problem: "no-map" });
});

test("the CSS pipeline is read from the project's files", () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tv-pipeline-")));
	const write = (rel: string, text: string) => {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), text);
	};
	write("package.json", JSON.stringify({ scripts: { dev: "next dev" }, dependencies: { next: "^16.0.0" } }));
	write("node_modules/next/package.json", JSON.stringify({ version: "16.3.8" }));
	write("postcss.config.mjs", "export default {};");
	assert.deepEqual(cssPipeline(root), { postcssConfig: path.join(root, "postcss.config.mjs"), turbopack: true, turbopackLoader: false });

	write("package.json", JSON.stringify({ scripts: { dev: "next dev --webpack" }, dependencies: { next: "^16.0.0" } }));
	assert.equal(cssPipeline(root).turbopack, false);

	write("node_modules/next/package.json", JSON.stringify({ version: "15.5.0" }));
	write("package.json", JSON.stringify({ scripts: { dev: "next dev --turbopack" }, dependencies: { next: "^15.5.0", "@tailwindcss/turbopack": "^4.3.0" } }));
	assert.deepEqual(cssPipeline(root), { postcssConfig: path.join(root, "postcss.config.mjs"), turbopack: true, turbopackLoader: true });
});

test("a project file served without a map is named as that file", async () => {
	const { root, file, pipeline } = project();
	const vite = await new StyleLocator(root, { pipeline }).rules({
		sheets: [{ id: "s1", sourceURL: "http://localhost:5173/src/app/globals.css", sourceMapURL: null, startLine: 0, devId: file, text: compiled() }],
		rules: [],
		nodes: {},
	});
	assert.deepEqual(vite.checks, [{ sheet: "src/app/globals.css", file: "src/app/globals.css", problem: "no-map" }]);
});

test("a rule Turbopack only maps from the line before it is found there, its declarations by name, its end by its braces", async () => {
	const { root, file, pipeline } = project();
	// Served as Lightning CSS prints it: declarations reordered, and the only
	// mapping for `body` (copy line 6, 0-based) on `:root`'s closing line.
	const copy = compiled();
	const text = [
		"/* [project]/src/app/globals.css [app-client] (css) */",
		":root {",
		"  --level-2: #333;",
		"}",
		"body {",
		"  color: var(--level-2);",
		"  margin: 0;",
		"}",
	].join("\n");
	// Line 3 (the `}`) → copy line 6 (`body {`); nothing else mapped.
	const section = { version: 3, sources: [pathToFileURL(file).href], sourcesContent: [copy], names: [], mappings: ";;AAMA" };
	const styles: RawStyles = {
		sheets: [{ id: "s1", sourceURL: SHEET, sourceMapURL: inlineMap({ version: 3, sources: [], sections: [{ offset: { line: 1, column: 0 }, map: section }] }), startLine: 0, devId: null, text }],
		rules: [{ sheet: "s1", selector: "body", selectorRange: range(4), styleRange: { startLine: 4, startColumn: 0, endLine: 7, endColumn: 1 }, decls: [{ name: "color", value: "var(--level-2)", range: range(5) }] }],
		nodes: {},
	};
	const { rules } = await new StyleLocator(root, { rebuild: true, pipeline }).rules(styles);
	assert.deepEqual(rules[0].loc, { path: "src/app/globals.css", line: 4, endLine: 7 });
	assert.deepEqual(rules[0].decls[0].loc, { path: "src/app/globals.css", line: 6 });
});
