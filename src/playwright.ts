import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Viewport } from "./config.js";
import type { RawElement } from "./elements.js";
import type { RawStyles } from "./styles.js";
import { HYDRATE_JS, MATCH_JS } from "./fingerprint.js";

/**
 * Drive Playwright directly for per-element captures. shot-scraper can't
 * measure elements and screenshot them from the same page load (its
 * `javascript` command has no viewport or screenshot support), so we run a
 * small driver script on the Python/Playwright install that shot-scraper
 * already uses.
 */

/** The driver, shipped alongside `dist/` (see `files` in package.json). */
const DRIVER = fileURLToPath(new URL("../assets/capture.py", import.meta.url));

const INSTALL_HINT =
	"Per-element captures need the Python Playwright that shot-scraper uses.\n" +
	"Install shot-scraper (and run `shot-scraper install`) in the environment on your PATH,\n" +
	"or pass --only-pages to capture whole pages with shot-scraper alone.";

export interface PageJob {
	url: string;
	/** Where to write the full-page screenshot. */
	output: string;
	wait?: number;
	waitFor?: string;
	/** Scrolls to fire reveals, lets them settle, and freezes CSS animations (see `stabilize.ts`). */
	stabilizeJs: string;
}

/** What the driver reports about a page, in order (see `assets/capture.py`). */
export type DriverEvent =
	| { index: number; event: "redirect"; url: string }
	| {
			index: number;
			event: "fingerprint";
			fingerprint: string;
			/** Only when fingerprinting alone: the normalized DOM lines and hashed resources. */
			dom?: string[];
			resources?: [string, string][];
	  }
	| { index: number; event: "extracted"; tree: RawElement[]; changed: string[] }
	| { index: number; event: "done"; styles: RawStyles | null }
	| { index: number; event: "error"; error: string };

/** tunnelvision's answer to a `fingerprint` (cheat mode) or `extracted` event. */
export type DriverReply = { carry: boolean } | { query: string[] | "all" };

export interface CaptureOptions {
	viewport: Viewport;
	scaleFactor: number;
	/** Playwright storage state (a shot-scraper auth file). */
	authFile?: string;
	/** Pages settled, screenshotted and read at once, each in its own browser context. */
	concurrency: number;
	/** Pages loaded and fingerprinted at once (at least `concurrency`); loading is mostly waiting. */
	loadConcurrency?: number;
	/** The element-extraction script evaluated in each page. */
	extractJs: string;
	/** The render fingerprint script (see `fingerprint.ts`). */
	fingerprintJs: string;
	/** Ask whether to carry each page over once it's fingerprinted. */
	cheat: boolean;
	/** `fingerprint`: stop every page once it's fingerprinted. */
	mode?: "capture" | "fingerprint";
	/** Every page's URL, so a page that redirects to another is recognised. */
	knownUrls: string[];
	/** Selectors of style rules the commit changed (see `changedrules.ts`). */
	changedSelectors: string[];
}

function findOnPath(bin: string): string | null {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		const candidate = path.join(dir, bin);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// keep looking
		}
	}
	return null;
}

/** The interpreter a console-script launcher runs, from its shebang (or uv/pip's sh trampoline). */
function interpreterOf(script: string): string | null {
	let head: string;
	try {
		head = fs.readFileSync(script, "utf8").slice(0, 1024);
	} catch {
		return null;
	}
	const trampoline = head.match(/^'''exec' '([^']+)'/m) ?? head.match(/^'''exec' "([^"]+)"/m);
	if (trampoline) return trampoline[1];
	const shebang = head.match(/^#!\s*(\S+)(?:\s+(\S+))?/);
	if (!shebang) return null;
	if (/python/.test(shebang[1])) return shebang[1];
	// `#!/usr/bin/env python3`
	if (shebang[1].endsWith("/env") && shebang[2] && /python/.test(shebang[2])) return shebang[2];
	return null;
}

function hasPlaywright(python: string): boolean {
	const r = spawnSync(python, ["-c", "import playwright.async_api"], { stdio: "ignore" });
	return r.status === 0;
}

let cachedPython: string | null = null;

/** Locate a Python with Playwright installed, preferring shot-scraper's own. Throws if none. */
export function findPlaywrightPython(): string {
	if (cachedPython) return cachedPython;
	const candidates: string[] = [];
	const shotScraper = findOnPath("shot-scraper");
	if (shotScraper) {
		const interp = interpreterOf(shotScraper);
		if (interp) candidates.push(interp);
		const binDir = path.dirname(shotScraper);
		candidates.push(path.join(binDir, "python3"), path.join(binDir, "python"));
	}
	candidates.push("python3", "python");

	for (const python of candidates) {
		if (hasPlaywright(python)) {
			cachedPython = python;
			return python;
		}
	}
	throw new Error(INSTALL_HINT);
}

/**
 * Capture `pages` with one page load each: wait, fingerprint, settle, write a
 * full-page screenshot, extract the element tree and read the matched styles
 * of the elements tunnelvision asks for. `onEvent` hears each step as it
 * happens and, for `fingerprint` (in cheat mode) and `extracted` events,
 * returns the reply the page is waiting on.
 */
export function runDriver(
	pages: PageJob[],
	opts: CaptureOptions,
	onEvent: (event: DriverEvent) => Promise<DriverReply | void> | DriverReply | void,
): Promise<void> {
	const python = findPlaywrightPython();
	for (const page of pages) fs.mkdirSync(path.dirname(page.output), { recursive: true });

	return new Promise((resolve, reject) => {
		const proc = spawn(python, [DRIVER], { stdio: ["pipe", "pipe", "inherit"] });
		let buffered = "";
		let failed: Error | null = null;
		const handling: Promise<void>[] = [];

		const handle = async (event: DriverEvent): Promise<void> => {
			const reply = await onEvent(event);
			if (reply && !proc.stdin.destroyed) proc.stdin.write(`${JSON.stringify({ index: event.index, ...reply })}\n`);
		};

		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => {
			buffered += chunk;
			let nl: number;
			while ((nl = buffered.indexOf("\n")) >= 0) {
				const line = buffered.slice(0, nl).trim();
				buffered = buffered.slice(nl + 1);
				if (!line) continue;
				let event: DriverEvent;
				try {
					event = JSON.parse(line) as DriverEvent;
				} catch {
					continue; // stray output
				}
				handling.push(
					handle(event).catch((err: Error) => {
						failed ??= err;
						// Unblock the page so the driver can finish.
						if (!proc.stdin.destroyed) proc.stdin.write(`${JSON.stringify({ index: event.index, carry: false, query: [] })}\n`);
					}),
				);
			}
		});
		proc.stdin.on("error", () => {
			// The driver exited; its exit code says why.
		});
		proc.on("error", reject);
		proc.on("close", async (code) => {
			await Promise.all(handling);
			if (failed) reject(failed);
			else if (code !== 0) reject(new Error(`Playwright capture failed (exit ${code}).`));
			else resolve();
		});

		proc.stdin.write(
			`${JSON.stringify({
				viewport: opts.viewport,
				scaleFactor: opts.scaleFactor,
				authFile: opts.authFile ?? null,
				concurrency: opts.concurrency,
				loadConcurrency: Math.max(opts.concurrency, opts.loadConcurrency ?? opts.concurrency),
				extractJs: opts.extractJs,
				fingerprintJs: opts.fingerprintJs,
				hydrateJs: HYDRATE_JS,
				matchJs: MATCH_JS,
				cheat: opts.cheat,
				mode: opts.mode ?? "capture",
				knownUrls: opts.knownUrls,
				changedSelectors: opts.changedSelectors,
				pages,
			})}\n`,
		);
	});
}
