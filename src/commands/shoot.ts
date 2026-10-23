import path from "node:path";
import pc from "picocolors";
import fs from "node:fs";
import { applyOverrides, loadConfig, type Config, type Overrides } from "../config.js";
import { resolvePaths, versionDir, type Paths } from "../paths.js";
import { resolveVersion, snapshotTree, type VersionInfo } from "../git.js";
import { discoverPages, type PageSource } from "../pagesource.js";
import { resolvePages, type Page } from "../pages.js";
import { runDriver, runPages, type DriverEvent, type DriverReply, type PageJob, type RunResult } from "../playwright.js";
import {
	assignDirs,
	cropRect,
	extractScript,
	ELEMENT_MANIFEST,
	MANIFEST_VERSION,
	STYLE_MANIFEST,
	PAGE_IMAGE,
	pngSize,
	type ElementManifest,
	type ElementNode,
	type RawElement,
} from "../elements.js";
import { Cascade } from "../cascade.js";
import { LOCATOR_VERSION, StyleLocator } from "../stylesource.js";
import { checkKey, describeCheck, type SheetCheck } from "../stylemaps.js";
import { writeStyleManifest, type ElementStyles, type RawSheet, type RawStyles } from "../styles.js";
import { metaFromInfo, writeMeta } from "../versions.js";
import { stabilizeScript } from "../stabilize.js";
import { resolveComponents, SourceResolver, type ComponentFile } from "../reactsource.js";
import {
	assembleStyles,
	carryPage,
	findReference,
	hashOf,
	pageRecord,
	planElements,
	referenceElements,
	writeJson,
	PAGE_RECORD,
	REDIRECT_RECORD,
	type ElementPlan,
	type Reference,
} from "../carryover.js";
import { fingerprintScript } from "../fingerprint.js";
import { matchOptions } from "../matching.js";
import { environmentVersions, versionChanges } from "../environment.js";

export interface ShootOptions extends Overrides {
	root: string;
	/** Capture even when the working tree is dirty is always allowed; this only affects messaging. */
}

export interface CaptureContext {
	paths: Paths;
	config: Config;
	version: VersionInfo;
	pages: Page[];
	/** Where the pages came from. */
	source: PageSource;
	outputDir: string;
	/** Capture every visible block-level element individually (unless `--only-pages`). */
	byElement: boolean;
	/** Carry pages over by render fingerprint, without settling them (see `fingerprint.ts`). */
	cheat: boolean;
}

/** Load config + discover and resolve pages and the version key. Throws on fatal problems. */
export async function prepareCapture(opts: ShootOptions): Promise<CaptureContext> {
	const paths = resolvePaths(opts.root);
	const base = loadConfig(paths);
	const config = applyOverrides(base, opts);

	const source = discoverPages(opts.root);

	const pages = resolvePages(source.locs, config);
	const version = resolveVersion(opts.root);
	const outputDir = versionDir(paths, version.key);

	return { paths, config, version, pages, source, outputDir, byElement: !opts.onlyPages, cheat: useCheatMode(opts, config) };
}

/**
 * Whether to capture in cheat mode: `--cheat` / `--no-cheat` when given, else
 * the config's default, which only holds while the versions it was validated
 * with are still the installed ones.
 */
function useCheatMode(opts: ShootOptions, config: Config): boolean {
	if (opts.cheat !== undefined) return opts.cheat;
	const { enabled, validatedWith } = config.cheatMode;
	if (!enabled) return false;
	const changes = validatedWith ? versionChanges(validatedWith, environmentVersions(opts.root)) : ["never validated"];
	if (changes.length === 0) return true;
	console.log(
		pc.yellow(
			`  cheat mode is off until it's validated again (${changes.join(", ")}); run /setup-tunnelvision, or pass --cheat`,
		),
	);
	return false;
}

/** Say where the pages came from, and anything left out. */
export function logSource(ctx: CaptureContext): void {
	console.log(pc.dim(`  pages from ${ctx.source.from}`));
	for (const note of ctx.source.notes) console.log(pc.yellow(`  ${note}`));
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
export async function runCapture(ctx: CaptureContext): Promise<RunResult> {
	const authFile = path.isAbsolute(ctx.config.authFile)
		? ctx.config.authFile
		: path.join(ctx.paths.root, ctx.config.authFile);
	const auth = fs.existsSync(authFile) ? authFile : undefined;
	// Taken before capturing, while the files match what the app is serving.
	const rev = captureRev(ctx);

	if (ctx.byElement) {
		return runElementCapture(ctx, rev, auth);
	}

	const { config } = ctx;
	const result = await runPages(
		ctx.pages.map((page) => {
			const override = config.pages?.[page.pathAndQuery];
			const wait = override?.wait ?? config.wait;
			return {
				url: page.url,
				output: path.join(ctx.outputDir, page.filename),
				wait: wait > 0 ? wait : undefined,
				waitFor: override?.waitFor,
				stabilizeJs: stabilizeScript(override?.settle ?? config.settle),
			};
		}),
		{
			viewport: config.viewport,
			scaleFactor: config.scaleFactor && config.scaleFactor > 0 ? config.scaleFactor : config.retina ? 2 : 1,
			authFile: auth,
		},
		(output) => path.relative(ctx.outputDir, output),
	);

	writeMeta(
		ctx.paths,
		metaFromInfo(ctx.version, ctx.config.baseUrl, ctx.pages.length, rev),
	);
	return result;
}

/**
 * Capture each page as a hierarchy of per-element screenshots.
 *
 * Each page is loaded once (several pages at a time): the driver waits, reads
 * the visible block-level element tree, and takes a full-page screenshot from
 * the same load. Only that screenshot and the tree (`elements.json`) are
 * stored; element images are cropped out of it whenever they're needed.
 *
 * Whatever the nearest ancestor Version already holds is carried over rather
 * than read again (see `carryover.ts`): every element's style data unless
 * the element rule says otherwise, and in cheat mode whole pages whose render
 * fingerprint is unchanged. The Version is written to a staging directory and
 * swapped in when done, so a capture under the same key can be the reference.
 */
async function runElementCapture(ctx: CaptureContext, rev: string | null, auth?: string): Promise<RunResult> {
	const started = Date.now();
	const { config } = ctx;
	const scale = config.scaleFactor && config.scaleFactor > 0 ? config.scaleFactor : config.retina ? 2 : 1;
	const resolver = new SourceResolver(ctx.paths.root);
	const locator = new StyleLocator(ctx.paths.root, { rebuild: config.workarounds.turbopackPostcssMaps });
	const maps = new MapReport({ turbopack: locator.checker.turbopack, rebuild: config.workarounds.turbopackPostcssMaps });
	const produced: string[] = [];
	const missing: string[] = [];
	const noReactSource: string[] = [];
	const noStyles: string[] = [];
	const carriedPages: string[] = [];
	const redirects: string[] = [];
	let elementCount = 0;
	let queried = 0;
	let planned = 0;

	// Before capturing, so broken maps are known up front; sheets only other pages load are checked as they turn up.
	if (ctx.pages.length > 0) maps.report(await probeStyleMaps(ctx.pages[0].url, auth, locator), "before capturing");

	const { reference, why } = findReference(ctx.paths, ctx.version.key, rev);
	if (reference) console.log(pc.dim(`  carrying over from ${reference.meta.key}`));
	else console.log(pc.dim(`  capturing everything: ${why}`));

	const staging = path.join(ctx.paths.versions, `.${ctx.version.key}.${process.pid}`);
	fs.rmSync(staging, { recursive: true, force: true });
	const slugs = ctx.pages.map((page) => page.filename.replace(/\.png$/i, ""));
	const jobs: PageJob[] = ctx.pages.map((page, i) => ({
		url: page.url,
		output: path.join(staging, slugs[i], PAGE_IMAGE),
		...pageWait(ctx, page),
	}));
	const extractJs = extractScript(config.match.attributes, config.styles.properties, config.includeHidden);
	const fingerprintJs = fingerprintScript(config.cheatMode.ignoreAttributes);
	const settings = jobs.map((job, i) => settingsHash(ctx, job, extractJs, scale, auth, ctx.pages[i].url));
	// Fingerprints are kept against the script that took them, so a changed ignore list never matches.
	const stored = (fp: string) => hashOf([fingerprintJs, fp]);
	const opts = matchOptions(config.match);
	const fingerprints: string[] = [];
	const extracted = new Map<number, { tree: ElementNode[]; raw: RawElement[]; plan: ElementPlan }>();

	let done = 0;
	const progress = (i: number, note = ""): void => {
		done++;
		console.log(pc.dim(`  [${done}/${jobs.length}] ${ctx.pages[i].url}${note ? ` ${note}` : ""}`));
	};

	const onEvent = async (ev: DriverEvent): Promise<DriverReply | void> => {
		const i = ev.index;
		const slug = slugs[i];
		const pageRoot = path.join(staging, slug);
		switch (ev.event) {
			case "redirect": {
				const to = ctx.pages.findIndex((p) => sameUrl(p.url, ev.url));
				writeJson(path.join(pageRoot, REDIRECT_RECORD), { url: ev.url, to: slugs[to] ?? null });
				redirects.push(slug);
				progress(i, pc.cyan(`→ redirects to ${new URL(ev.url).pathname}`));
				return;
			}
			case "fingerprint": {
				fingerprints[i] = stored(ev.fingerprint);
				if (!ctx.cheat) return;
				const carry = Boolean(reference && carryPage(reference, ctx.paths.root, slug, settings[i], fingerprints[i], staging));
				if (carry) {
					carriedPages.push(slug);
					produced.push(`${slug}/${PAGE_IMAGE}`);
					progress(i, pc.green("unchanged (carried over)"));
				}
				return { carry };
			}
			case "extracted": {
				const tree = assignDirs(ev.tree);
				// React source locations, which also feed each element's identity.
				const components = await resolveComponents(tree, resolver);
				addComponents(tree, components);
				const withSource = [...components.values()].filter((c) => c.source).length;
				if (components.size > 0 && withSource === 0) noReactSource.push(slug);
				const plan = planElements({
					fresh: tree,
					raw: ev.tree,
					changed: new Set(ev.changed),
					reference: referenceElements(reference, slug, settings[i]),
					mapper: reference?.mapper ?? null,
					match: opts,
					properties: config.styles.properties,
				});
				extracted.set(i, { tree, raw: ev.tree, plan });
				return { query: plan.query };
			}
			case "done": {
				const page = extracted.get(i);
				if (!page || !fs.existsSync(jobs[i].output)) {
					missing.push(`${slug} (no screenshot)`);
					progress(i, pc.red("failed: no screenshot"));
					return;
				}
				const { tree, raw, plan } = page;
				const asked = plan.query === "all" ? plan.total : plan.query.length;
				queried += asked;
				planned += plan.total;
				if (ev.styles || asked === 0) {
					const located = ev.styles ? await locator.rules(ev.styles) : { rules: [], checks: [] };
					if (ev.styles) maps.read(ev.styles.sheets.length);
					maps.report(located.checks, `on ${ctx.pages[i].url}`);
					const computed = computedByNode(tree, raw);
					const fresh = ev.styles
						? elementStyles(tree, raw, ev.styles, config.styles.properties, plan.query === "all" ? null : new Set(plan.query))
						: new Map<ElementNode, ElementStyles>();
					writeStyleManifest(
						path.join(pageRoot, STYLE_MANIFEST),
						assembleStyles(plan, (n) => computed.get(n) ?? {}, { rules: located.rules, elements: fresh }),
					);
				} else {
					noStyles.push(slug);
				}

				const manifest: ElementManifest = {
					version: MANIFEST_VERSION,
					url: ctx.pages[i].url,
					extractedAt: new Date().toISOString(),
					scale,
					elements: tree,
				};
				writeJson(path.join(pageRoot, ELEMENT_MANIFEST), manifest);
				writeJson(path.join(pageRoot, PAGE_RECORD), pageRecord(settings[i], fingerprints[i]));

				produced.push(`${slug}/${PAGE_IMAGE}`);
				// Elements that can't be cropped out of the screenshot have no image.
				const size = pngSize(jobs[i].output);
				const visit = (nodes: ElementNode[]): void => {
					for (const node of nodes) {
						if (size && cropRect(size, node.box, scale)) elementCount++;
						else missing.push(`${slug}/${node.dir} (outside the page)`);
						visit(node.children);
					}
				};
				visit(tree);
				progress(i, asked < plan.total ? pc.dim(`(styles read for ${asked} of ${plan.total} elements)`) : "");
				return;
			}
			case "error":
				missing.push(`${slug} (${ev.error})`);
				progress(i, pc.red(`failed: ${ev.error}`));
				return;
		}
	};

	try {
		await runDriver(
			jobs,
			{
				viewport: config.viewport,
				scaleFactor: scale,
				authFile: auth,
				concurrency: Math.max(1, Math.floor(config.concurrency)),
				loadConcurrency: Math.max(1, Math.floor(config.concurrency)) * LOAD_FACTOR,
				extractJs,
				fingerprintJs,
				cheat: ctx.cheat && Boolean(reference),
				knownUrls: ctx.pages.map((p) => p.url),
				changedSelectors: reference?.changedSelectors ?? [],
			},
			onEvent,
		);
	} catch (err) {
		fs.rmSync(staging, { recursive: true, force: true });
		throw err;
	}

	// Swap the finished capture in, replacing any earlier one under this key.
	fs.rmSync(ctx.outputDir, { recursive: true, force: true });
	fs.renameSync(staging, ctx.outputDir);

	if (noReactSource.length > 0) {
		console.log(
			pc.yellow(
				`  React detected but no source locations on ${noReactSource.length} page(s); ` +
					"line numbers need a React 19+ development build.",
			),
		);
	}

	if (noStyles.length > 0) {
		console.log(pc.yellow(`  Couldn't read CSS rules on ${noStyles.length} page(s); visual changes there can't be traced to CSS.`));
	}
	maps.summarize();

	console.log(pc.dim(`  ${elementCount} elements recorded (cropped from each page screenshot on demand)`));
	const summary = [
		carriedPages.length && `${carriedPages.length} page(s) carried over unchanged`,
		redirects.length && `${redirects.length} redirect(s)`,
		planned && `styles read for ${queried} of ${planned} elements`,
	].filter(Boolean);
	console.log(pc.dim(`  ${[...summary, `${((Date.now() - started) / 1000).toFixed(1)}s`].join(" · ")}`));
	const styleMaps = maps.all();
	writeMeta(ctx.paths, { ...metaFromInfo(ctx.version, config.baseUrl, ctx.pages.length, rev), ...(styleMaps.length ? { styleMaps } : {}) });
	return { produced, missing, exitCode: 0 };
}

/**
 * The problems found with stylesheets' source maps over a capture, each told
 * once, as soon as it's found.
 */
class MapReport {
	private readonly found = new Map<string, SheetCheck>();
	private sheets = 0;
	private foreign = 0;

	constructor(private readonly context: { turbopack: boolean; rebuild: boolean }) {}

	/** Count stylesheets checked, so a capture that checked none doesn't say the maps are fine. */
	read(sheets: number): void {
		this.sheets += sheets;
	}

	report(checks: SheetCheck[], where: string): void {
		const fresh = checks.filter((c) => !this.found.has(checkKey(c)));
		for (const c of fresh) this.found.set(checkKey(c), c);
		// A sheet without a map that isn't a project file is someone else's (a CDN's, a library's <style>).
		const foreign = (c: SheetCheck) => c.problem === "no-map" && !c.file;
		this.foreign += fresh.filter(foreign).length;
		const broken = fresh.filter((c) => !c.patched && !foreign(c));
		const patched = fresh.filter((c) => c.patched);
		if (broken.length) {
			const files = new Set(broken.map((c) => c.file ?? c.sheet)).size;
			console.log(
				pc.yellow(
					`  ! source maps (${where}): ${files} stylesheet file(s) can't be traced to their lines; expect unexplained changes from them`,
				),
			);
			for (const c of broken) console.log(pc.yellow(`      ${describeCheck(c, this.context)}`));
		}
		for (const c of patched) console.log(pc.dim(`  source maps: ${describeCheck(c, this.context)}`));
	}

	summarize(): void {
		const all = this.all();
		const broken = new Set(all.filter((c) => !c.patched && !(c.problem === "no-map" && !c.file)).map((c) => c.file ?? c.sheet));
		if (this.foreign) console.log(pc.dim(`  ${this.foreign} stylesheet(s) from outside the project (CDNs, libraries' <style> tags) have no source map; their rules have no lines`));
		if (broken.size) console.log(pc.yellow(`  ${broken.size} stylesheet file(s) couldn't be traced (see above); visual changes they cause show as unexplained`));
		if (this.context.rebuild && this.sheets > 0 && !all.some((c) => c.patched)) {
			console.log(
				pc.dim(
					"  `workarounds.turbopackPostcssMaps` is on, but no source map needed rebuilding: if Turbopack keeps PostCSS's maps now, it can be removed",
				),
			);
		}
	}

	all(): SheetCheck[] {
		return [...this.found.values()];
	}
}

/** A cookie in a Playwright storage state (the auth file). */
interface StoredCookie {
	name: string;
	value: string;
	domain: string;
}

function cookieHeader(authFile: string | undefined, url: string): string | null {
	if (!authFile) return null;
	try {
		const { cookies = [] } = JSON.parse(fs.readFileSync(authFile, "utf8")) as { cookies?: StoredCookie[] };
		const host = new URL(url).hostname;
		const sent = cookies.filter((c) => {
			const domain = c.domain.replace(/^\./, "");
			return host === domain || host.endsWith(`.${domain}`);
		});
		return sent.length ? sent.map((c) => `${c.name}=${c.value}`).join("; ") : null;
	} catch {
		return null;
	}
}

/**
 * Check the source maps of the stylesheets a page links to, from its HTML,
 * without a browser. Sheets a script adds (Vite dev) aren't found this way;
 * they're checked when the capture reads them.
 */
async function probeStyleMaps(url: string, authFile: string | undefined, locator: StyleLocator): Promise<SheetCheck[]> {
	const get = async (href: string, headers: Record<string, string> = {}): Promise<string | null> => {
		try {
			const res = await fetch(href, { headers, signal: AbortSignal.timeout(10_000) });
			return res.ok ? await res.text() : null;
		} catch {
			return null;
		}
	};
	const cookie = cookieHeader(authFile, url);
	const html = await get(url, cookie ? { cookie } : {});
	if (!html) return [];
	const hrefs = [...html.matchAll(/<link\b[^>]*>/gi)]
		.map((m) => m[0])
		.filter((tag) => /\brel=["']?stylesheet\b/i.test(tag))
		.map((tag) => tag.match(/\bhref=["']([^"']+)["']/i)?.[1])
		.filter((href): href is string => Boolean(href))
		.map((href) => new URL(href.replace(/&amp;/g, "&"), url).href);
	const checks: SheetCheck[] = [];
	for (const href of new Set(hrefs)) {
		const text = await get(href);
		if (text === null) continue;
		const sheet: RawSheet = {
			id: href,
			sourceURL: href,
			sourceMapURL: text.match(/\/\*[#@]\s*sourceMappingURL=([^\s*]+)\s*\*\/\s*$/)?.[1] ?? null,
			startLine: 0,
			devId: null,
			text,
		};
		checks.push(...(await locator.check(sheet)));
	}
	return checks;
}

/** How many more pages are loaded and fingerprinted at once than are captured (see `capture.py`). */
const LOAD_FACTOR = 3;

/** Whether two URLs are the same page (ignoring a trailing slash and fragment). */
function sameUrl(a: string, b: string): boolean {
	const norm = (u: string) => {
		const url = new URL(u);
		return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}${url.search}`;
	};
	return norm(a) === norm(b);
}

/**
 * Everything that decides what a capture of a page holds. A reference page
 * captured with different settings is never carried over.
 */
function settingsHash(ctx: CaptureContext, job: PageJob, extractJs: string, scale: number, auth: string | undefined, url: string): string {
	let authState: string | null = null;
	try {
		authState = auth ? fs.readFileSync(auth, "utf8") : null;
	} catch {
		authState = null;
	}
	return hashOf({
		manifest: MANIFEST_VERSION,
		viewport: ctx.config.viewport,
		scale,
		properties: ctx.config.styles.properties,
		// Rule locations are carried over with the styles, so they must have been found the same way.
		styleMaps: { locator: LOCATOR_VERSION, rebuild: ctx.config.workarounds.turbopackPostcssMaps },
		extractJs,
		stabilizeJs: job.stabilizeJs,
		wait: job.wait ?? null,
		waitFor: job.waitFor ?? null,
		auth: authState && hashOf(authState),
		url,
	});
}

/** Each element's extracted computed values. */
function computedByNode(nodes: ElementNode[], raw: RawElement[]): Map<ElementNode, Record<string, string>> {
	const out = new Map<ElementNode, Record<string, string>>();
	const visit = (planned: ElementNode[], extracted: RawElement[]): void => {
		planned.forEach((node, i) => {
			out.set(node, extracted[i]?.computed ?? {});
			visit(node.children, extracted[i]?.children ?? []);
		});
	};
	visit(nodes, raw);
	return out;
}

/**
 * Resolve the winning declaration of each tracked property on the elements in
 * `only` (every element when null). `raw` is the tree `nodes` were planned
 * from, index for index.
 */
function elementStyles(
	nodes: ElementNode[],
	raw: RawElement[],
	styles: RawStyles,
	properties: string[],
	only: Set<string> | null,
): Map<ElementNode, ElementStyles> {
	const cascade = new Cascade(styles);
	const out = new Map<ElementNode, ElementStyles>();
	const visit = (planned: ElementNode[], extracted: RawElement[]): void => {
		planned.forEach((node, i) => {
			const source = extracted[i];
			if (!source) return;
			if (!only || only.has(node.selector)) {
				out.set(node, cascade.resolveElement(node.selector, properties, source.computed ?? {}));
			}
			visit(node.children, source.children);
		});
	};
	visit(nodes, raw);
	return out;
}

/** Attach each element's resolved component info, and fill in its source identity from it. */
function addComponents(nodes: ElementNode[], components: Map<ElementNode, ComponentFile>): void {
	for (const node of nodes) {
		const component = components.get(node);
		if (component) node.component = component;
		const source = component?.source;
		if (node.identity && source) {
			node.identity.source = source.path;
			node.identity.file = source.path.replace(/:\d+:\d+$/, "");
		}
		addComponents(node.children, components);
	}
}

/** Snapshot the files this capture was taken from, so it can be diffed at them later. */
function captureRev(ctx: CaptureContext): string | null {
	return ctx.version.fromGit ? snapshotTree(ctx.paths.root, ctx.version.key) : null;
}

/** Resolve wait / waitFor / settle for a page from config. */
function pageWait(ctx: CaptureContext, page: Page): Pick<PageJob, "wait" | "waitFor" | "stabilizeJs"> {
	const override = ctx.config.pages?.[page.pathAndQuery];
	const out: Pick<PageJob, "wait" | "waitFor" | "stabilizeJs"> = {
		stabilizeJs: stabilizeScript(override?.settle ?? ctx.config.settle),
	};
	const wait = override?.wait ?? ctx.config.wait;
	if (wait && wait > 0) out.wait = wait;
	if (override?.waitFor) out.waitFor = override.waitFor;
	return out;
}

export async function shoot(opts: ShootOptions): Promise<number> {
	const ctx = await prepareCapture(opts);
	await assertReachable(ctx.config.baseUrl);

	console.log(pc.bold(`Shooting ${ctx.pages.length} pages`) + pc.dim(` → version ${ctx.version.key}`));
	logSource(ctx);
	if (ctx.version.dirty) {
		console.log(pc.yellow("  working tree is dirty; stored under a -dirty key"));
	}

	const result = await runCapture(ctx);

	console.log("");
	console.log(pc.green(`  ✓ ${result.produced.length} captured`));
	if (result.missing.length > 0) {
		console.log(pc.red(`  ✗ ${result.missing.length} failed:`));
		for (const m of result.missing) console.log(pc.red(`      ${m}`));
	}
	console.log(pc.dim(`  saved to ${path.relative(ctx.paths.root, ctx.outputDir)}`));

	return result.missing.length > 0 ? 1 : 0;
}
