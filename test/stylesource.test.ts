import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { originalPositionFor } from "@jridgewell/trace-mapping";
import { loadMapRef, toFilePath } from "../src/reactsource.js";
import { StyleLocator, sameLines } from "../src/stylesource.js";
import type { RawStyles } from "../src/styles.js";

const range = (line: number) => ({ startLine: line, startColumn: 0, endLine: line, endColumn: 10 });

/** A project with src/styles/global.css, and a page sheet that Vite (in Astro) put in the page's HTML. */
function project(): { root: string; file: string; styles: (sheet: Partial<RawStyles["sheets"][0]>) => RawStyles } {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tv-stylesource-")));
	const file = path.join(root, "src", "styles", "global.css");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const css = ":root {\n  --radius: 0.25rem;\n}\n.card { border-radius: var(--radius); }\n";
	fs.writeFileSync(file, css);
	const styles = (sheet: Partial<RawStyles["sheets"][0]>): RawStyles => ({
		sheets: [{ id: "s1", sourceURL: "http://localhost:4321/about", sourceMapURL: null, startLine: 12, devId: file, text: css, ...sheet }],
		rules: [{ sheet: "s1", selector: ".card", selectorRange: range(3), styleRange: range(3), decls: [{ name: "border-radius", value: "var(--radius)", range: range(3) }] }],
		nodes: {},
	});
	return { root, file, styles };
}

test("an inline source map's absolute sources resolve to files, not to the page's URL", async () => {
	const { root, file, styles } = project();
	// Line 0 of the served sheet maps to line 3 (0-based) of global.css, named by absolute path as Vite does.
	const map = { version: 3, sources: [file], names: [], mappings: ";;;AAGA" };
	const sourceMapURL = `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;
	const { rules, checks } = await new StyleLocator(root).rules(styles({ sourceMapURL, text: "\n\n\n.card { border-radius: var(--radius); }\n" }));
	assert.deepEqual(checks, []);
	assert.deepEqual(rules[0].decls[0].loc, { path: "src/styles/global.css", line: 4 });
});

/** A source map as an inline `data:` URL. */
const inlineMap = (map: object) => `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;

test("a Turbopack stylesheet's index source map resolves through its section", async () => {
	const { root, styles } = project();
	// Turbopack heads the served sheet with a comment line, so the section starts on line 1 (0-based).
	const section = { version: 3, sources: ["turbopack:///[project]/src/styles/global.css"], names: [], mappings: ";;AAGA" };
	const sourceMapURL = inlineMap({ version: 3, sources: [], sections: [{ offset: { line: 1, column: 0 }, map: section }] });
	const text = "/* [project]/src/styles/global.css [app-client] (css) */\n\n\n.card { border-radius: var(--radius); }\n";
	const { rules, checks } = await new StyleLocator(root).rules(styles({ sourceMapURL, text }));
	assert.deepEqual(checks, []);
	assert.deepEqual(rules[0].decls[0].loc, { path: "src/styles/global.css", line: 4 });
});

test("loadMapRef reads Turbopack's index maps (one section per module) as well as flat ones", async () => {
	const a = { version: 3, sources: ["file:///app/src/a.tsx"], names: [], mappings: "AAAA" };
	const b = { version: 3, sources: ["file:///app/src/b.tsx"], names: [], mappings: "AAEE" };
	const indexed = await loadMapRef(
		inlineMap({ version: 3, sources: [], sections: [{ offset: { line: 4, column: 0 }, map: a }, { offset: { line: 20, column: 0 }, map: b }] }),
		"http://localhost:3000/_next/static/chunks/src_0abc._.js",
	);
	assert.ok(indexed);
	const pos = originalPositionFor(indexed, { line: 21, column: 0 });
	assert.equal(pos.source && toFilePath(pos.source, "/app"), "/app/src/b.tsx");
	assert.deepEqual([pos.line, pos.column], [3, 2]);

	const flat = await loadMapRef(inlineMap(a), "http://localhost:5173/src/a.tsx");
	assert.equal(flat && originalPositionFor(flat, { line: 1, column: 0 }).source, "file:///app/src/a.tsx");
});

test("a Vite <style> inside a page's HTML matches its file line for line", async () => {
	const { root, styles } = project();
	const { rules } = await new StyleLocator(root).rules(styles({}));
	assert.deepEqual(rules[0].loc, { path: "src/styles/global.css", line: 4, endLine: 4 });
});

/** A static site whose pages hold `<style>` blocks, and a sheet the browser reports for one of them. */
function page(html: string, file = "about.html") {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tv-styleblock-")));
	fs.writeFileSync(path.join(root, file), html);
	const styles = (text: string, sheet: Partial<RawStyles["sheets"][0]> = {}, ruleLine = 1): RawStyles => ({
		sheets: [{ id: "s1", sourceURL: "http://localhost:5201/about.html", sourceMapURL: null, startLine: 3, startColumn: 8, devId: null, text, ...sheet }],
		rules: [{ sheet: "s1", selector: ".card", selectorRange: range(ruleLine), styleRange: range(ruleLine), decls: [{ name: "color", value: "navy", range: range(ruleLine) }] }],
		nodes: {},
	});
	return { root, styles };
}

const CARD = "\n\t\t.card {\n\t\t\tcolor: navy;\n\t\t}\n\t";
const HTML = `<!DOCTYPE html>\n<html>\n<head>\n\t<style>${CARD}</style>\n</head>\n<body><div class="card">Hi</div></body>\n</html>\n`;

test("a <style> written in an HTML page is traced to its lines in the page's file", async () => {
	const { root, styles } = page(HTML);
	const { rules, checks } = await new StyleLocator(root).rules(styles(CARD));
	assert.deepEqual(checks, []);
	// The block's text starts on line 4 (`<style>`), so its line 1 is the file's line 5.
	assert.deepEqual(rules[0].loc, { path: "about.html", line: 5, endLine: 5 });
	assert.deepEqual(rules[0].decls[0].loc, { path: "about.html", line: 5 });
});

test("a <style> block is found by its text when the dev server shifted the page's lines", async () => {
	const { root, styles } = page(HTML);
	// A script injected above the block: the browser says it starts three lines further down.
	const { rules } = await new StyleLocator(root).rules(styles(CARD, { startLine: 6 }));
	assert.deepEqual(rules[0].decls[0].loc, { path: "about.html", line: 5 });
});

test("of identical <style> blocks, the one starting where the browser says is chosen, and otherwise none", async () => {
	const html = `<html>\n<head>\n<style>${CARD}</style>\n<style>${CARD}</style>\n</head>\n</html>\n`;
	const { root, styles } = page(html);
	const second = await new StyleLocator(root).rules(styles(CARD, { startLine: 7, startColumn: 7 }));
	assert.deepEqual(second.rules[0].decls[0].loc, { path: "about.html", line: 9 });
	const neither = await new StyleLocator(root).rules(styles(CARD, { startLine: 20 }));
	assert.equal(neither.rules[0].decls[0].loc, null);
	assert.deepEqual(neither.checks, [{ sheet: "inline <style>", file: "about.html", problem: "not-in-file" }]);
});

test("a <style> block that isn't in the file as written stays untraced, and says why", async () => {
	const { root, styles } = page(HTML.replace("navy", "{{ brand }}"));
	const { rules, checks } = await new StyleLocator(root).rules(styles(CARD));
	assert.equal(rules[0].loc, null);
	assert.deepEqual(rules[0].untraced, { file: "about.html", problem: "not-in-file" });
	assert.deepEqual(checks, [{ sheet: "inline <style>", file: "about.html", problem: "not-in-file" }]);
});

test("a page served at a directory URL is its index.html", async () => {
	const { root, styles } = page(HTML, "index.html");
	const { rules, checks } = await new StyleLocator(root).rules(styles(CARD, { sourceURL: "http://localhost:5201/" }));
	assert.deepEqual(checks, []);
	assert.deepEqual(rules[0].decls[0].loc, { path: "index.html", line: 5 });
});

test("a <style> on a page that isn't one of the project's files is still just counted", async () => {
	const { root, styles } = page(HTML);
	const { checks } = await new StyleLocator(root).rules(styles(CARD, { sourceURL: "http://localhost:5201/elsewhere" }));
	assert.deepEqual(checks, [{ sheet: "inline <style>", problem: "no-map" }]);
});

test("CSS Modules match their file with class names ignored", () => {
	assert.ok(sameLines("._box_zlz7f_1 {\n  border: 2px solid;\n}\n", ".box {\n  border: 2px solid;\n}"));
	assert.ok(!sameLines(".box { border: 2px solid; }", ".box { border: 3px solid; }"));
});
