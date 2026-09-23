import pc from "picocolors";
import { configExists } from "../config.js";
import { resolvePaths } from "../paths.js";
import { isGitRepo } from "../git.js";
import { checkShotScraper } from "../shotscraper.js";
import { findSitemaps } from "../sitemap.js";
import { findPlaywrightPython } from "../playwright.js";
import path from "node:path";

export interface DoctorOptions {
	root: string;
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

	// Playwright (used directly for --by-element captures)
	let python: string | null = null;
	try {
		python = findPlaywrightPython();
	} catch {
		// reported below
	}
	line(Boolean(python), "playwright (for --by-element)", python ?? "not found next to shot-scraper");

	// config
	line(configExists(paths), "config", configExists(paths) ? paths.config : "run `tunnelvision init`");

	// git
	const git = isGitRepo(opts.root);
	line(git, "git repo", git ? "versions keyed by commit SHA" : "will use timestamp keys");

	// sitemap
	const sitemaps = findSitemaps(opts.root);
	if (sitemaps.length === 1) {
		line(true, "sitemap", path.relative(opts.root, sitemaps[0]));
	} else if (sitemaps.length === 0) {
		line(false, "sitemap", "none found (searched recursively for sitemap*.xml)");
	} else {
		line(false, "sitemap", `${sitemaps.length} found — remove extras so exactly one remains`);
	}

	console.log("");
	console.log(ok ? pc.green("All good.") : pc.yellow("Some checks need attention."));
	return ok ? 0 : 1;
}
