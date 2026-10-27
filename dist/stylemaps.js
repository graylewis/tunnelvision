import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TraceMap } from "@jridgewell/trace-mapping";
import { rootRelative, toFilePath } from "./reactsource.js";
const POSTCSS_CONFIGS = [
    "postcss.config.js",
    "postcss.config.mjs",
    "postcss.config.cjs",
    "postcss.config.json",
    ".postcssrc",
    ".postcssrc.json",
];
const PREPROCESSED = /\.(scss|sass|less|styl)$/i;
/** `next/font` writes a CSS module that's never on disk, next to the file that loads the font. */
const NEXT_FONT_MODULE = /_[0-9a-f]{8}\.module\.css$/;
function packageJson(root) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        return { deps: { ...pkg.dependencies, ...pkg.devDependencies }, scripts: pkg.scripts ?? {} };
    }
    catch {
        return { deps: {}, scripts: {} };
    }
}
/** The installed major version of `name`, or null. */
function installedMajor(root, name) {
    try {
        const { version } = JSON.parse(fs.readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8"));
        const major = Number.parseInt(String(version), 10);
        return Number.isNaN(major) ? null : major;
    }
    catch {
        return null;
    }
}
export function cssPipeline(root) {
    const { deps, scripts } = packageJson(root);
    const postcss = POSTCSS_CONFIGS.map((f) => path.join(root, f)).find((f) => fs.existsSync(f)) ?? null;
    let turbopack = false;
    if ("next" in deps) {
        const dev = scripts.dev ?? "";
        turbopack = /--turbo(pack)?\b/.test(dev) || ((installedMajor(root, "next") ?? 0) >= 16 && !/--webpack\b/.test(dev));
    }
    const nextConfig = ["ts", "mjs", "js", "cjs", "mts"]
        .map((ext) => path.join(root, `next.config.${ext}`))
        .find((f) => fs.existsSync(f));
    const rules = nextConfig ? /\bturbopack\b[\s\S]*\brules\b/.test(fs.readFileSync(nextConfig, "utf8")) : false;
    return { postcssConfig: postcss, turbopack, turbopackLoader: "@tailwindcss/turbopack" in deps || rules };
}
/**
 * Runs the project's PostCSS config on a file the way Turbopack's PostCSS
 * transform does: in development, with the config's plugins normalised the
 * same way, `from` and `to` both the file. In a child process started in the
 * project root, so plugins resolve and scan from there as they do in the dev
 * server.
 */
const REBUILD_SCRIPT = `
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [configFile, from] = process.argv.slice(1);
try {
	const require = createRequire(path.join(process.cwd(), "package.json"));
	let config = /\\.json$|\\.postcssrc$/.test(configFile)
		? JSON.parse(fs.readFileSync(configFile, "utf8"))
		: (await import(pathToFileURL(configFile).href)).default;
	if (typeof config === "function") config = await config({ env: "development" });
	let plugins = config?.plugins ?? [];
	plugins = Array.isArray(plugins)
		? plugins.map((p) => (typeof p === "string" ? [p, {}] : p))
		: Object.entries(plugins).filter(([, options]) => options);
	const loaded = plugins.map((p) => {
		if (!Array.isArray(p)) return p;
		let [factory, options] = p;
		if (typeof factory === "string") factory = require(factory);
		if (factory.default) factory = factory.default;
		return factory(options);
	});
	const postcss = require("postcss");
	const result = await postcss(loaded).process(fs.readFileSync(from, "utf8"), {
		from,
		to: from,
		map: { inline: false, annotation: false, sourcesContent: false },
	});
	process.stdout.write(JSON.stringify({ css: result.css, map: result.map.toJSON() }));
} catch (err) {
	process.stdout.write(JSON.stringify({ error: String(err?.message ?? err).split("\\n")[0] }));
}
`;
function runRebuild(root, configFile, file) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", REBUILD_SCRIPT, configFile, file], {
            cwd: root,
            env: { ...process.env, NODE_ENV: "development" },
            stdio: ["ignore", "pipe", "ignore"],
        });
        const chunks = [];
        child.stdout.on("data", (c) => chunks.push(c));
        child.on("error", (err) => resolve({ error: err.message }));
        child.on("close", () => {
            try {
                const out = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                resolve(out.error ? { error: out.error } : { css: out.css, map: new TraceMap(out.map, pathToFileURL(file).href) });
            }
            catch {
                resolve({ error: "PostCSS printed no result" });
            }
        });
    });
}
const normalized = (text) => text.replace(/\r\n/g, "\n");
export class MapChecker {
    root;
    pipeline;
    rebuild;
    /** Keyed by file and the copy's text, since every page loads the same sheets. */
    verdicts = new Map();
    constructor(root, options) {
        this.root = root;
        this.rebuild = options.rebuild;
        this.pipeline = options.pipeline ?? cssPipeline(root);
    }
    /** The project-relative path of a file inside the project, else the path as is. */
    label(file) {
        return rootRelative(file, this.root);
    }
    /** Check one source a map names, given the copy of it the map carries (if any). */
    source(resolved, copy) {
        const key = `${resolved}\0${copy ?? ""}`;
        let verdict = this.verdicts.get(key);
        if (!verdict) {
            verdict = this.check(toFilePath(resolved, this.root), copy);
            this.verdicts.set(key, verdict);
        }
        return verdict;
    }
    async check(file, copy) {
        let disk;
        try {
            disk = fs.readFileSync(file, "utf8");
        }
        catch {
            // Nothing was written there to trace back to, so nothing's lost.
            if (NEXT_FONT_MODULE.test(file))
                return { ok: true };
            return { ok: false, problem: "missing-source", detail: this.label(file) };
        }
        // Without a copy there's nothing to compare: trust the map.
        if (copy == null || normalized(copy) === normalized(disk))
            return { ok: true };
        if (PREPROCESSED.test(file))
            return { ok: false, problem: "preprocessor" };
        const { postcssConfig, turbopackLoader } = this.pipeline;
        const otherwise = turbopackLoader ? "turbopack-loader" : postcssConfig ? "stale" : "unknown";
        if (!postcssConfig)
            return { ok: false, problem: otherwise };
        const rebuilt = await runRebuild(this.root, postcssConfig, file);
        if ("error" in rebuilt)
            return { ok: false, problem: turbopackLoader ? otherwise : "unknown", detail: `PostCSS failed: ${rebuilt.error}` };
        if (normalized(rebuilt.css) !== normalized(copy))
            return { ok: false, problem: otherwise };
        return this.rebuild ? { ok: true, via: rebuilt.map } : { ok: false, problem: "postcss-output" };
    }
    /** Whether the project's dev server runs Turbopack. */
    get turbopack() {
        return this.pipeline.turbopack;
    }
}
/** Why a rule can't be traced, as a clause for a hint: "…, which can't be traced: <reason>". */
export function problemReason(problem) {
    switch (problem) {
        case "no-map":
            return "its stylesheet has no source map";
        case "not-in-file":
            return "its <style> block isn't in the file as written";
        case "missing-source":
            return "its source map names a file that isn't on disk";
        case "postcss-output":
            return "Turbopack dropped PostCSS's source map";
        case "stale":
            return "the dev server's CSS doesn't match the file (a stale compile?)";
        case "preprocessor":
            return "it's compiled by a preprocessor tunnelvision can't rebuild";
        case "turbopack-loader":
            return "a Turbopack loader builds it without a source map";
        case "unknown":
            return "its source map's copy of the file doesn't match the file";
    }
}
/** What to tell the user about a problem found while capturing. */
export function describeCheck(check, context) {
    const what = check.file ?? check.sheet;
    if (check.patched)
        return `${what}: source map rebuilt (Turbopack dropped PostCSS's map)`;
    const flag = "`workarounds.turbopackPostcssMaps` in tunnelvision.json";
    const offer = context.turbopack && !context.rebuild ? ` (Turbopack drops PostCSS's source maps; ${flag} rebuilds them)` : "";
    const detail = check.detail ? ` (${check.detail})` : "";
    switch (check.problem) {
        case "no-map":
            return `${what} has no source map and isn't a file line for line${offer}`;
        case "not-in-file":
            return `${what} has a <style> block that isn't in the file as written (a template, or HTML the server rewrote)`;
        case "missing-source":
            return `${what}: its source map names files that aren't on disk${detail}`;
        case "postcss-output":
            return `${what}: Turbopack dropped PostCSS's source map, so it points into the compiled CSS; set ${flag} to true to rebuild it`;
        case "stale":
            return (`${what}: the dev server's CSS doesn't match the file or PostCSS's output for it, probably a stale compile. ` +
                "Screenshots may be wrong too: change the file and change it back (or restart the dev server without its cache), then capture again" +
                offer);
        case "preprocessor":
            return `${what} is compiled by Sass, Less or Stylus first, so its source map can't be rebuilt`;
        case "turbopack-loader":
            return `${what} is built by a Turbopack loader (\`@tailwindcss/turbopack\` or \`turbopack.rules\`) that leaves no source map to rebuild`;
        case "unknown":
            return `${what}: its source map's copy of the file doesn't match the file, for no reason tunnelvision knows${detail}${offer}`;
    }
}
/** A key for reporting a problem once, however many sheets and pages it turns up on. */
export function checkKey(check) {
    return `${check.file ?? check.sheet}\0${check.problem}\0${check.patched ? 1 : 0}`;
}
