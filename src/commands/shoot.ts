import path from "node:path";
import pc from "picocolors";
import fs from "node:fs";
import { applyOverrides, loadConfig, type Config, type Overrides } from "../config.js";
import { resolvePaths, versionDir, type Paths } from "../paths.js";
import { resolveVersion, type VersionInfo } from "../git.js";
import { findSitemaps, parseSitemap } from "../sitemap.js";
import { resolvePages, type Page } from "../pages.js";
import {
	buildShotsYaml,
	buildYaml,
	requireShotScraper,
	runEntries,
	runMulti,
	type RunResult,
	type ShotEntry,
} from "../shotscraper.js";
import {
	assignDirs,
	collectShots,
	extractElementTree,
	resolveElementOutput,
	ELEMENT_MANIFEST,
	PAGE_IMAGE,
	type ElementManifest,
} from "../elements.js";
import { metaFromInfo, writeMeta } from "../versions.js";

export interface ShootOptions extends Overrides {
	root: string;
	/** Capture even when the working tree is dirty is always allowed; this only affects messaging. */
}

export interface CaptureContext {
	paths: Paths;
	config: Config;
	version: VersionInfo;
	pages: Page[];
	outputDir: string;
	/** Capture every visible block-level element individually. */
	byElement: boolean;
}

/** Load config + sitemap + resolve pages and the version key. Throws on fatal problems. */
export async function prepareCapture(opts: ShootOptions): Promise<CaptureContext> {
	const paths = resolvePaths(opts.root);
	const base = loadConfig(paths);
	const config = applyOverrides(base, opts);

	// Locate the sitemap.
	const sitemaps = findSitemaps(opts.root);
	if (sitemaps.length === 0) {
		throw new Error(
			`No sitemap found under ${opts.root}. tunnelvision searches recursively for sitemap*.xml.`,
		);
	}
	if (sitemaps.length > 1) {
		const list = sitemaps.map((s) => `  - ${path.relative(opts.root, s)}`).join("\n");
		throw new Error(
			`Multiple sitemaps found; please remove or consolidate so exactly one remains:\n${list}`,
		);
	}

	const locs = parseSitemap(sitemaps[0]);
	if (locs.length === 0) {
		throw new Error(`Sitemap ${path.relative(opts.root, sitemaps[0])} contains no <loc> URLs.`);
	}

	const pages = resolvePages(locs, config);
	const version = resolveVersion(opts.root);
	const outputDir = versionDir(paths, version.key);

	return { paths, config, version, pages, outputDir, byElement: Boolean(opts.byElement) };
}

/** Fail fast if the base URL is not reachable. */
async function assertReachable(baseUrl: string): Promise<void> {
	try {
		const controller = new AbortController();
		const t = setTimeout(() => controller.abort(), 5000);
		await fetch(baseUrl, { signal: controller.signal, redirect: "manual" }).finally(() =>
			clearTimeout(t),
		);
	} catch (err) {
		throw new Error(
			`Could not reach ${baseUrl} (${(err as Error).message}).\n` +
				"Start your app (or set the base URL with --base-url) and try again.",
		);
	}
}

/** Run the actual capture given a prepared context. */
export function runCapture(ctx: CaptureContext): RunResult {
	requireShotScraper();
	const authFile = path.isAbsolute(ctx.config.authFile)
		? ctx.config.authFile
		: path.join(ctx.paths.root, ctx.config.authFile);
	const auth = fs.existsSync(authFile) ? authFile : undefined;

	if (ctx.byElement) {
		return runElementCapture(ctx, auth);
	}

	const yaml = buildShotsYaml(ctx.pages, ctx.config, ctx.outputDir);
	const result = runMulti(ctx.pages, ctx.outputDir, {
		root: ctx.paths.root,
		authFile: auth,
		shotsYamlPath: path.join(ctx.outputDir, "shots.yml"),
		yaml,
		retina: ctx.config.retina,
		scaleFactor: ctx.config.scaleFactor,
	});

	writeMeta(
		ctx.paths,
		metaFromInfo(ctx.version, ctx.config.baseUrl, ctx.pages.length),
	);
	return result;
}

/**
 * Capture each page as a hierarchy of per-element screenshots.
 *
 * For every page we ask the browser for its visible block-level element tree,
 * lay that tree out as nested directories under the page's slug, and enqueue one
 * `selector` shot per element (plus one full-page shot for context). All shots
 * across all pages run in a single `shot-scraper multi` invocation.
 */
function runElementCapture(ctx: CaptureContext, auth?: string): RunResult {
	const entries: ShotEntry[] = [];
	const failedPages: string[] = [];

	for (const page of ctx.pages) {
		const pageSlug = page.filename.replace(/\.png$/i, "");
		const pageRoot = path.join(ctx.outputDir, pageSlug);

		let tree;
		try {
			const raw = extractElementTree(page.url, {
				authFile: auth,
				wait: ctx.config.pages?.[page.pathAndQuery]?.wait ?? ctx.config.wait,
				cwd: ctx.paths.root,
			});
			tree = assignDirs(raw);
		} catch (err) {
			failedPages.push(`${pageSlug} (${(err as Error).message.split("\n")[0]})`);
			continue;
		}

		fs.mkdirSync(pageRoot, { recursive: true });
		const manifest: ElementManifest = {
			url: page.url,
			extractedAt: new Date().toISOString(),
			elements: tree,
		};
		fs.writeFileSync(
			path.join(pageRoot, ELEMENT_MANIFEST),
			`${JSON.stringify(manifest, null, 2)}\n`,
			"utf8",
		);

		// Full-page shot for context at the page root.
		entries.push({
			url: page.url,
			output: path.join(pageRoot, PAGE_IMAGE),
			width: ctx.config.viewport.width,
			height: ctx.config.viewport.height,
			...waitFields(ctx, page),
		});

		// One shot per element, nested to mirror the DOM.
		for (const shot of collectShots(tree)) {
			entries.push({
				url: page.url,
				output: resolveElementOutput(pageRoot, shot.relOutput),
				width: ctx.config.viewport.width,
				height: ctx.config.viewport.height,
				selector: shot.selector,
				...waitFields(ctx, page),
			});
		}
	}

	let result: RunResult = { produced: [], missing: [], exitCode: 0 };
	if (entries.length > 0) {
		result = runEntries(
			entries,
			{
				root: ctx.paths.root,
				authFile: auth,
				shotsYamlPath: path.join(ctx.outputDir, "shots.yml"),
				yaml: buildYaml(entries),
				retina: ctx.config.retina,
				scaleFactor: ctx.config.scaleFactor,
			},
			(output) => path.relative(ctx.outputDir, output),
		);
	}

	result.missing.push(...failedPages);
	writeMeta(ctx.paths, metaFromInfo(ctx.version, ctx.config.baseUrl, ctx.pages.length));
	return result;
}

/** Resolve wait / wait_for fields for a page from config. */
function waitFields(ctx: CaptureContext, page: Page): Partial<ShotEntry> {
	const override = ctx.config.pages?.[page.pathAndQuery];
	const out: Partial<ShotEntry> = {};
	const wait = override?.wait ?? ctx.config.wait;
	if (wait && wait > 0) out.wait = wait;
	if (override?.waitFor) out.wait_for = override.waitFor;
	return out;
}

export async function shoot(opts: ShootOptions): Promise<number> {
	const ctx = await prepareCapture(opts);
	await assertReachable(ctx.config.baseUrl);

	console.log(pc.bold(`Shooting ${ctx.pages.length} pages`) + pc.dim(` → version ${ctx.version.key}`));
	if (ctx.version.dirty) {
		console.log(pc.yellow("  working tree is dirty; stored under a -dirty key"));
	}

	const result = runCapture(ctx);

	console.log("");
	console.log(pc.green(`  ✓ ${result.produced.length} captured`));
	if (result.missing.length > 0) {
		console.log(pc.red(`  ✗ ${result.missing.length} failed:`));
		for (const m of result.missing) console.log(pc.red(`      ${m}`));
	}
	console.log(pc.dim(`  saved to ${path.relative(ctx.paths.root, ctx.outputDir)}`));

	return result.missing.length > 0 ? 1 : 0;
}
