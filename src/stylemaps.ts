import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TraceMap } from "@jridgewell/trace-mapping";
import { rootRelative, toFilePath } from "./reactsource.js";

/**
 * Checking that a stylesheet's source map really points at the files on disk,
 * and the one broken map tunnelvision can repair.
 *
 * Each source a map names is checked in turn: it must be a file on disk, and
 * the copy of it the map carries (`sourcesContent`) must be that file. When
 * the copy isn't the file, running the project's PostCSS on the file tells
 * why. If PostCSS reproduces the copy exactly, the bundler kept the map of
 * what came before PostCSS and dropped PostCSS's own, so the map points into
 * PostCSS's output; Turbopack does this
 * (docs/adr/0010-rebuild-postcss-maps-turbopack-drops.md). The rebuild's map
 * then carries a position the rest of the way, when
 * `workarounds.turbopackPostcssMaps` is on.
 */

/** Why a stylesheet's rules, or some of them, can't be traced to the lines they were written on. */
export type MapProblem =
	/** The sheet has no source map, and isn't its file line for line. */
	| "no-map"
	/** The sheet is a `<style>` block whose text isn't in its document's file as written (a template, or HTML the server rewrote). */
	| "not-in-file"
	/** The map names a file that isn't on disk. */
	| "missing-source"
	/** The map's copy is PostCSS's output for the file: the bundler dropped PostCSS's map. */
	| "postcss-output"
	/** The map's copy is neither the file nor PostCSS's output for it: the dev server compiled an older version. */
	| "stale"
	/** The file is Sass, Less or Stylus, compiled before PostCSS, which tunnelvision can't rebuild. */
	| "preprocessor"
	/** A Turbopack loader (`turbopack.rules`, `@tailwindcss/turbopack`) builds the CSS, without a map. */
	| "turbopack-loader"
	/** The map's copy isn't the file, and nothing explains why. */
	| "unknown";

/** A problem found with one stylesheet, or with one of the files its map names. */
export interface SheetCheck {
	/** The stylesheet's URL, or `inline <style>`. */
	sheet: string;
	/** The file the problem is with, project-relative when it's inside the project. */
	file?: string;
	problem: MapProblem;
	/** `workarounds.turbopackPostcssMaps` rebuilt the file's map, so its rules are traced after all. */
	patched?: true;
	/** More about it: the files missing, or why PostCSS failed. */
	detail?: string;
}

/** Recorded on a rule that couldn't be traced because of a broken map. */
export interface Untraced {
	/** The file the rule came from, or the sheet's URL when the sheet has no map. */
	file: string;
	problem: MapProblem;
}

/** How the project builds its CSS, as far as its files say. */
export interface CssPipeline {
	/** The PostCSS config file, absolute. */
	postcssConfig: string | null;
	/** `next dev` runs Turbopack (Next 16+ unless `--webpack`, or `--turbo` / `--turbopack` before that). */
	turbopack: boolean;
	/** CSS goes through a Turbopack loader (`@tailwindcss/turbopack`, or `turbopack.rules` in the Next config). */
	turbopackLoader: boolean;
}

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

function packageJson(root: string): { deps: Record<string, string>; scripts: Record<string, string> } {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
		return { deps: { ...pkg.dependencies, ...pkg.devDependencies }, scripts: pkg.scripts ?? {} };
	} catch {
		return { deps: {}, scripts: {} };
	}
}

/** The installed major version of `name`, or null. */
function installedMajor(root: string, name: string): number | null {
	try {
		const { version } = JSON.parse(fs.readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8"));
		const major = Number.parseInt(String(version), 10);
		return Number.isNaN(major) ? null : major;
	} catch {
		return null;
	}
}

export function cssPipeline(root: string): CssPipeline {
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

type Rebuilt = { css: string; map: TraceMap } | { error: string };

function runRebuild(root: string, configFile: string, file: string): Promise<Rebuilt> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", REBUILD_SCRIPT, configFile, file], {
			cwd: root,
			env: { ...process.env, NODE_ENV: "development" },
			stdio: ["ignore", "pipe", "ignore"],
		});
		const chunks: Buffer[] = [];
		child.stdout.on("data", (c: Buffer) => chunks.push(c));
		child.on("error", (err) => resolve({ error: err.message }));
		child.on("close", () => {
			try {
				const out = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				resolve(out.error ? { error: out.error } : { css: out.css, map: new TraceMap(out.map, pathToFileURL(file).href) });
			} catch {
				resolve({ error: "PostCSS printed no result" });
			}
		});
	});
}

/** How one source in a map turned out: fine, broken, or broken but traced through a rebuilt map. */
export type SourceVerdict = { ok: true } | { ok: false; problem: MapProblem; detail?: string } | { ok: true; via: TraceMap };

const normalized = (text: string) => text.replace(/\r\n/g, "\n");

export class MapChecker {
	private readonly root: string;
	private readonly pipeline: CssPipeline;
	private readonly rebuild: boolean;
	/** Keyed by file and the copy's text, since every page loads the same sheets. */
	private readonly verdicts = new Map<string, Promise<SourceVerdict>>();

	constructor(root: string, options: { rebuild: boolean; pipeline?: CssPipeline }) {
		this.root = root;
		this.rebuild = options.rebuild;
		this.pipeline = options.pipeline ?? cssPipeline(root);
	}

	/** The project-relative path of a file inside the project, else the path as is. */
	label(file: string): string {
		return rootRelative(file, this.root);
	}

	/** Check one source a map names, given the copy of it the map carries (if any). */
	source(resolved: string, copy: string | null | undefined): Promise<SourceVerdict> {
		const key = `${resolved}\0${copy ?? ""}`;
		let verdict = this.verdicts.get(key);
		if (!verdict) {
			verdict = this.check(toFilePath(resolved, this.root), copy);
			this.verdicts.set(key, verdict);
		}
		return verdict;
	}

	private async check(file: string, copy: string | null | undefined): Promise<SourceVerdict> {
		let disk: string;
		try {
			disk = fs.readFileSync(file, "utf8");
		} catch {
			// Nothing was written there to trace back to, so nothing's lost.
			if (NEXT_FONT_MODULE.test(file)) return { ok: true };
			return { ok: false, problem: "missing-source", detail: this.label(file) };
		}
		// Without a copy there's nothing to compare: trust the map.
		if (copy == null || normalized(copy) === normalized(disk)) return { ok: true };
		if (PREPROCESSED.test(file)) return { ok: false, problem: "preprocessor" };
		const { postcssConfig, turbopackLoader } = this.pipeline;
		const otherwise: MapProblem = turbopackLoader ? "turbopack-loader" : postcssConfig ? "stale" : "unknown";
		if (!postcssConfig) return { ok: false, problem: otherwise };
		const rebuilt = await runRebuild(this.root, postcssConfig, file);
		if ("error" in rebuilt) return { ok: false, problem: turbopackLoader ? otherwise : "unknown", detail: `PostCSS failed: ${rebuilt.error}` };
		if (normalized(rebuilt.css) !== normalized(copy)) return { ok: false, problem: otherwise };
		return this.rebuild ? { ok: true, via: rebuilt.map } : { ok: false, problem: "postcss-output" };
	}

	/** Whether the project's dev server runs Turbopack. */
	get turbopack(): boolean {
		return this.pipeline.turbopack;
	}
}

/** Why a rule can't be traced, as a clause for a hint: "…, which can't be traced: <reason>". */
export function problemReason(problem: MapProblem): string {
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
export function describeCheck(check: SheetCheck, context: { turbopack: boolean; rebuild: boolean }): string {
	const what = check.file ?? check.sheet;
	if (check.patched) return `${what}: source map rebuilt (Turbopack dropped PostCSS's map)`;
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
			return (
				`${what}: the dev server's CSS doesn't match the file or PostCSS's output for it, probably a stale compile. ` +
				"Screenshots may be wrong too: change the file and change it back (or restart the dev server without its cache), then capture again" +
				offer
			);
		case "preprocessor":
			return `${what} is compiled by Sass, Less or Stylus first, so its source map can't be rebuilt`;
		case "turbopack-loader":
			return `${what} is built by a Turbopack loader (\`@tailwindcss/turbopack\` or \`turbopack.rules\`) that leaves no source map to rebuild`;
		case "unknown":
			return `${what}: its source map's copy of the file doesn't match the file, for no reason tunnelvision knows${detail}${offer}`;
	}
}

/** A key for reporting a problem once, however many sheets and pages it turns up on. */
export function checkKey(check: SheetCheck): string {
	return `${check.file ?? check.sheet}\0${check.problem}\0${check.patched ? 1 : 0}`;
}
