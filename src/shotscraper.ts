import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import type { Config } from "./config.js";
import type { Page } from "./pages.js";
import { STABILIZE_JS } from "./stabilize.js";

export interface DoctorResult {
	installed: boolean;
	version?: string;
	message: string;
}

const INSTALL_HINT =
	"Install it with:\n  pip install shot-scraper\n  shot-scraper install   # downloads the browser";

/** Check whether shot-scraper is available on PATH. */
export function checkShotScraper(): DoctorResult {
	try {
		const out = execFileSync("shot-scraper", ["--version"], {
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
		}).trim();
		return { installed: true, version: out, message: `shot-scraper found: ${out}` };
	} catch {
		return {
			installed: false,
			message: `shot-scraper is not installed or not on your PATH.\n${INSTALL_HINT}`,
		};
	}
}

export function requireShotScraper(): void {
	const r = checkShotScraper();
	if (!r.installed) {
		throw new Error(r.message);
	}
}

export interface ShotEntry {
	url: string;
	output: string;
	width: number;
	height: number;
	wait?: number;
	wait_for?: string;
	/** Evaluated after `wait`, before `wait_for` and the screenshot. */
	javascript?: string;
}

/** Serialize shot-scraper `multi` entries to YAML. */
export function buildYaml(entries: ShotEntry[]): string {
	return yamlStringify(entries);
}

/** Build the shot-scraper `multi` YAML for a set of pages. */
export function buildShotsYaml(pages: Page[], config: Config, outputDir: string): string {
	const entries: ShotEntry[] = pages.map((page) => {
		const override = config.pages?.[page.pathAndQuery];
		const entry: ShotEntry = {
			url: page.url,
			output: path.join(outputDir, page.filename),
			width: config.viewport.width,
			height: config.viewport.height,
			javascript: STABILIZE_JS,
		};
		const wait = override?.wait ?? config.wait;
		if (wait && wait > 0) entry.wait = wait;
		if (override?.waitFor) entry.wait_for = override.waitFor;
		return entry;
	});
	return buildYaml(entries);
}

export interface RunOptions {
	root: string;
	authFile?: string;
	/** Path to write the generated shots.yml (kept for transparency). */
	shotsYamlPath: string;
	yaml: string;
	/** Capture all shots at retina (2x). */
	retina?: boolean;
	/** Capture all shots at a specific scale factor (overrides retina). */
	scaleFactor?: number;
}

export interface RunResult {
	/** Output filenames that were produced. */
	produced: string[];
	/** Output filenames that shot-scraper did not create (treated as failures). */
	missing: string[];
	exitCode: number;
}

/**
 * Run `shot-scraper multi` for a set of prebuilt entries. shot-scraper continues
 * past individual failures; we detect them by which `output` files exist
 * afterwards. `label` maps an absolute output path to the name reported back.
 */
export function runEntries(
	entries: ShotEntry[],
	opts: RunOptions,
	label: (output: string) => string = (o) => o,
): RunResult {
	for (const entry of entries) {
		fs.mkdirSync(path.dirname(entry.output), { recursive: true });
	}
	fs.mkdirSync(path.dirname(opts.shotsYamlPath), { recursive: true });
	fs.writeFileSync(opts.shotsYamlPath, opts.yaml, "utf8");

	const args = ["multi", opts.shotsYamlPath];
	if (opts.authFile && fs.existsSync(opts.authFile)) {
		args.push("--auth", opts.authFile);
	}
	if (opts.scaleFactor && opts.scaleFactor > 0) {
		args.push("--scale-factor", String(opts.scaleFactor));
	} else if (opts.retina) {
		args.push("--retina");
	}

	const proc = spawnSync("shot-scraper", args, {
		cwd: opts.root,
		stdio: ["ignore", "inherit", "inherit"],
		encoding: "utf8",
	});

	const produced: string[] = [];
	const missing: string[] = [];
	for (const entry of entries) {
		if (fs.existsSync(entry.output)) produced.push(label(entry.output));
		else missing.push(label(entry.output));
	}

	return { produced, missing, exitCode: proc.status ?? 1 };
}

/**
 * Run `shot-scraper multi` for the given YAML. shot-scraper continues past
 * individual page failures; we detect failures by which output files exist
 * afterwards.
 */
export function runMulti(pages: Page[], outputDir: string, opts: RunOptions): RunResult {
	const entries: ShotEntry[] = pages.map((page) => ({
		url: page.url,
		output: path.join(outputDir, page.filename),
		width: 0,
		height: 0,
	}));
	return runEntries(entries, opts, (output) => path.relative(outputDir, output));
}

/** Run `shot-scraper auth <url> <file>` interactively. */
export function runAuth(url: string, outFile: string, root: string): number {
	fs.mkdirSync(path.dirname(outFile), { recursive: true });
	const proc = spawnSync("shot-scraper", ["auth", url, outFile], {
		cwd: root,
		stdio: "inherit",
	});
	return proc.status ?? 1;
}
