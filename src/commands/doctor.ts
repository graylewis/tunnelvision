import pc from "picocolors";
import { CONFIG_FILE, existingConfig, resolvePaths } from "../paths.js";
import { isGitRepo } from "../git.js";
import { hookInstalled } from "./installHook.js";
import { checkShotScraper } from "../shotscraper.js";
import { discoverPages } from "../pagesource.js";
import { FRAMEWORK_NAMES } from "../fileroutes.js";
import { findPlaywrightPython } from "../playwright.js";
import fs from "node:fs";
import path from "node:path";

export interface DoctorOptions {
	root: string;
}

/** Dependencies that make Vite transform CSS, so its lines no longer match the source without a source map. */
const CSS_TOOLS = ["tailwindcss", "@tailwindcss/vite", "@tailwindcss/postcss", "postcss", "sass", "sass-embedded", "less", "stylus"];

/**
 * Why CSS changes can't be traced to their lines, if they can't: a Vite
 * project that processes its CSS without `css.devSourcemap`.
 */
function cssSourcemapProblem(root: string): string | null {
	// Astro keeps Vite's options under `vite:` in its own config.
	const viteConfig = ["vite", "astro"]
		.flatMap((tool) => ["ts", "js", "mjs", "mts"].map((ext) => path.join(root, `${tool}.config.${ext}`)))
		.find((f) => fs.existsSync(f));
	if (!viteConfig) return null;
	let deps: Record<string, string> = {};
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
		deps = { ...pkg.dependencies, ...pkg.devDependencies };
	} catch {
		// no package.json
	}
	const tools = CSS_TOOLS.filter((t) => t in deps);
	const postcss = fs.readdirSync(root).some((f) => /^postcss\.config\./.test(f));
	if (tools.length === 0 && !postcss) return null;
	if (/devSourcemap\s*:\s*true/.test(fs.readFileSync(viteConfig, "utf8"))) return null;
	return `${path.basename(viteConfig)} processes CSS (${[...tools, ...(postcss ? ["postcss config"] : [])].join(", ")}) without \`css: { devSourcemap: true }\``;
}

export async function doctor(opts: DoctorOptions): Promise<number> {
	const paths = resolvePaths(opts.root);
	let ok = true;

	const line = (good: boolean, label: string, detail?: string) => {
		const mark = good ? pc.green("✓") : pc.red("✗");
		console.log(`  ${mark} ${label}${detail ? pc.dim(`  ${detail}`) : ""}`);
		if (!good) ok = false;
	};

	console.log(pc.bold("tunnelvision doctor"));
	console.log("");

	// shot-scraper
	const ss = checkShotScraper();
	line(ss.installed, "shot-scraper", ss.installed ? ss.version : "not found");
	if (!ss.installed) {
		console.log(pc.dim("      pip install shot-scraper && shot-scraper install"));
	}

	// Playwright (used directly for per-element captures)
	let python: string | null = null;
	try {
		python = findPlaywrightPython();
	} catch {
		// reported below
	}
	line(Boolean(python), "playwright (for per-element captures)", python ?? "not found next to shot-scraper");

	// config
	const config = existingConfig(paths);
	line(Boolean(config), "config", config ?? "run `tunnelvision init`");
	if (config === paths.legacyConfig) {
		console.log(pc.dim(`      it's git-ignored there; \`tunnelvision init\` moves it to ${CONFIG_FILE} so it can be committed`));
	}

	// git
	const git = isGitRepo(opts.root);
	line(git, "git repo", git ? "versions keyed by commit SHA" : "will use timestamp keys");

	// post-commit hook: opt-in, so its absence isn't a failure
	if (git) {
		const hook = hookInstalled(opts.root);
		const mark = hook ? pc.green("✓") : pc.dim("·");
		const detail = hook ? "reviews each commit in the background" : "not installed; `tunnelvision install-hook` reviews each commit in the background";
		console.log(`  ${mark} post-commit hook${pc.dim(`  ${detail}`)}`);
	}

	// pages: Next.js / Astro routes, else the sitemap
	try {
		const source = discoverPages(opts.root);
		const label = source.kind === "sitemap" ? "sitemap" : `${FRAMEWORK_NAMES[source.kind].toLowerCase()} routes`;
		line(true, label, `${source.locs.length} pages from ${source.from}`);
		for (const note of source.notes) console.log(pc.dim(`      ${note}`));
	} catch (err) {
		line(false, "sitemap", (err as Error).message.split("\n")[0]);
	}

	// CSS source maps (tracing visual changes back to CSS lines)
	const css = cssSourcemapProblem(opts.root);
	if (css) {
		console.log(`  ${pc.yellow("!")} css source maps${pc.dim(`  ${css}`)}`);
		console.log(pc.dim("      visual changes can't be traced to CSS lines until it's set"));
	}

	console.log("");
	console.log(ok ? pc.green("All good.") : pc.yellow("Some checks need attention."));
	return ok ? 0 : 1;
}
