import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page as PwPage } from "playwright";
import type { Viewport } from "./config.js";
import type { RawElement } from "./elements.js";
import type { RawStyles } from "./styles.js";
import { HYDRATE_JS, MATCH_JS, stripDevStamps } from "./fingerprint.js";

/**
 * Drive Playwright for every capture. Per-element captures load each page
 * once: wait, fingerprint, settle, screenshot, then extract the element tree
 * and read matched styles over CDP from that same load, so the element rects
 * line up with the image exactly and tunnelvision can crop every element out
 * of it (see docs/adr/0012-node-playwright-driver.md).
 */

const INSTALL_HINT = "Playwright's Chromium isn't installed. Install it with:\n  npx playwright install chromium";

export interface PageJob {
	url: string;
	/** Where to write the full-page screenshot. */
	output: string;
	wait?: number;
	waitFor?: string;
	/** Scrolls to fire reveals, lets them settle, and freezes CSS animations (see `stabilize.ts`). */
	stabilizeJs: string;
}

/** What the driver reports about a page, in order. */
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
	/** Playwright storage state (written by `tunnelvision auth`). */
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
	/** Called around each page's load, for state plugins (see `state.ts`). */
	hooks?: PageHooks;
}

/** Points in a page's capture where state plugins run. A hook that throws fails the page. */
export interface PageHooks {
	/** Before the page loads: init scripts, routes, the clock. */
	beforeLoad?(index: number, page: PwPage): Promise<void>;
	/** Once it has hydrated, before the render fingerprint and before it's settled. */
	hydrated?(index: number, page: PwPage): Promise<void>;
	/** Once it's captured (or carried over), before its context closes. */
	captured?(index: number, page: PwPage): Promise<void>;
}

/** What a capture produced, by the names it reports them under. */
export interface RunResult {
	produced: string[];
	/** Pages or elements that couldn't be captured (treated as failures). */
	missing: string[];
	exitCode: number;
}

/** Whether Playwright's Chromium is installed, and where. */
export function checkPlaywright(): { installed: boolean; detail: string } {
	try {
		const exe = chromium.executablePath();
		return fs.existsSync(exe) ? { installed: true, detail: exe } : { installed: false, detail: "chromium not downloaded" };
	} catch (err) {
		return { installed: false, detail: (err as Error).message.split("\n")[0] };
	}
}

async function launch(headless = true): Promise<Browser> {
	if (!checkPlaywright().installed) throw new Error(INSTALL_HINT);
	return chromium.launch({ headless });
}

/**
 * tunnelvision's scripts, and users' `waitFor` predicates, are function
 * source in a string. Playwright calls a string that evaluates to a function
 * only when it's handed a function, so one is made whose source is the string.
 */
export function pageFunction(js: string): string | (() => unknown) {
	const src = js.trim();
	if (!/^(async\s*)?(function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/.test(src)) return src;
	const fn = () => undefined;
	fn.toString = () => src;
	return fn;
}

function evaluate<T>(page: PwPage, js: string, arg?: unknown): Promise<T> {
	return page.evaluate(pageFunction(js) as () => T, arg);
}

/** Plain data, as it was when it crossed the old driver's JSON pipe: `undefined` becomes `null`. */
function plain<T>(value: T): T {
	return JSON.parse(JSON.stringify(value, (_k, v) => (v === undefined ? null : v)));
}

class Semaphore {
	private waiting: (() => void)[] = [];
	constructor(private free: number) {}

	async use<T>(fn: () => Promise<T>): Promise<T> {
		if (this.free > 0) this.free--;
		else await new Promise<void>((resolve) => this.waiting.push(resolve));
		try {
			return await fn();
		} finally {
			const next = this.waiting.shift();
			if (next) next();
			else this.free++;
		}
	}
}

const IMPORTANT = /\s*!\s*important\s*$/i;
// CDP calls in flight at once while reading matched styles.
const CDP_CONCURRENCY = 32;
const HASHED_TYPES = new Set(["script", "stylesheet", "image", "font", "media"]);

interface TreeNode {
	selector: string;
	children: TreeNode[];
}

function* selectors(tree: TreeNode[]): Generator<string> {
	for (const node of tree) {
		yield node.selector;
		yield* selectors(node.children);
	}
}

/** Selectors of an element's ancestors, nearest first, ending at <html>. */
export function ancestors(selector: string): string[] {
	const parts = selector.split(" > ");
	const out: string[] = [];
	for (let i = parts.length - 1; i > 0; i--) out.push(parts.slice(0, i).join(" > "));
	return [...out, "html"];
}

/** Wanted elements with no wanted descendant (every leaf when `want` is null). */
export function wantedLeaves(tree: TreeNode[], want: Set<string> | null): string[] {
	const out: string[] = [];
	const visit = (node: TreeNode): boolean => {
		let below = false;
		for (const child of node.children) below = visit(child) || below;
		const mine = want === null || want.has(node.selector);
		if (mine && !below) out.push(node.selector);
		return mine || below;
	};
	for (const node of tree) visit(node);
	return out;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- CDP responses are untyped JSON */

/** The declarations actually written in a CDP style (ranged entries only). */
function decls(style: any): any[] {
	const out: any[] = [];
	for (const p of style?.cssProperties ?? []) {
		if (!("range" in p) || p.disabled || p.parsedOk === false) continue;
		const d: any = { name: p.name, value: p.value.replace(IMPORTANT, ""), range: p.range };
		if (p.important) d.important = true;
		if (p.longhandProperties?.length) d.longhands = p.longhandProperties.map((l: any) => l.name);
		out.push(d);
	}
	return out;
}

/**
 * Matched rules for the elements of `tree` in `want` (all of them when null),
 * deduplicated into a rule table.
 *
 * Only the wanted elements furthest down are queried: each answer already
 * carries the matched rules of every ancestor (`inherited`, nearest first),
 * so an ancestor's own answer is read off that chain. Wanted elements no
 * answer covers are queried directly.
 */
async function readStyles(page: PwPage, tree: TreeNode[], want: Set<string> | null): Promise<RawStyles> {
	const cdp: CDPSession = await page.context().newCDPSession(page);
	const headers = new Map<string, any>();
	cdp.on("CSS.styleSheetAdded", (e: any) => headers.set(e.header.styleSheetId, e.header));
	await cdp.send("DOM.enable");
	await cdp.send("CSS.enable");
	const root = (await cdp.send("DOM.getDocument", { depth: 0 })).root.nodeId;
	const sem = new Semaphore(CDP_CONCURRENCY);

	const matched = (selector: string): Promise<any> =>
		sem.use(async () => {
			try {
				const node = await cdp.send("DOM.querySelector", { nodeId: root, selector });
				if (!node.nodeId) return null;
				return await cdp.send("CSS.getMatchedStylesForNode", { nodeId: node.nodeId });
			} catch {
				return null;
			}
		});

	const sels = [...selectors(tree)].filter((s) => want === null || want.has(s));
	const inTree = new Set(sels);
	const answers = new Map<string, any>();
	const leafSels = wantedLeaves(tree, want);
	const leafAnswers = await Promise.all(leafSels.map(matched));
	leafSels.forEach((sel, n) => {
		const res = leafAnswers[n];
		if (!res) return;
		answers.set(sel, res);
		const chain: any[] = res.inherited ?? [];
		const up = ancestors(sel);
		// A chain that doesn't line up with the selector's ancestors (the
		// flat tree differs from the DOM, e.g. slotted content) can't be trusted.
		if (chain.length !== up.length) return;
		up.forEach((anc, i) => {
			if (inTree.has(anc) && !answers.has(anc)) {
				answers.set(anc, {
					matchedCSSRules: chain[i].matchedCSSRules ?? [],
					inlineStyle: chain[i].inlineStyle ?? null,
					inherited: chain.slice(i + 1),
				});
			}
		});
	});
	const missing = sels.filter((s) => !answers.has(s));
	const missingAnswers = await Promise.all(missing.map(matched));
	missing.forEach((sel, n) => {
		if (missingAnswers[n]) answers.set(sel, missingAnswers[n]);
	});

	const ownerAttrs = async (header: any): Promise<Record<string, string>> => {
		if (!header.ownerNode) return {};
		try {
			const node = await cdp.send("DOM.describeNode", { backendNodeId: header.ownerNode });
			const attrs: string[] = node.node.attributes ?? [];
			const out: Record<string, string> = {};
			for (let i = 0; i + 1 < attrs.length; i += 2) out[attrs[i]] = attrs[i + 1];
			return out;
		} catch {
			return {};
		}
	};
	const owners = new Map<string, Record<string, string>>();
	for (const [sid, h] of [...headers]) owners.set(sid, await ownerAttrs(h));
	// tunnelvision's own <style> (animations frozen by the stabilize script) isn't the app's CSS.
	const ours = new Set([...owners].filter(([, attrs]) => "data-tunnelvision" in attrs).map(([sid]) => sid));

	// Sheets in first-use order, so they come out the same on every run.
	const rules: any[] = [];
	const index = new Map<string, number>();
	const usedSheets = new Set<string>();

	const ruleId = (rule: any): number | null => {
		const sheet = rule.styleSheetId;
		const rng = rule.style?.range;
		if (!sheet || !rng || ours.has(sheet)) return null;
		const key = `${sheet}\0${rng.startLine}\0${rng.startColumn}`;
		if (!index.has(key)) {
			const sel = rule.selectorList;
			const ranges = (sel.selectors ?? []).filter((s: any) => s.range).map((s: any) => s.range);
			const r: any = {
				sheet,
				selector: sel.text,
				selectorRange: ranges.length ? ranges[0] : null,
				styleRange: rng,
				decls: decls(rule.style),
			};
			const layers = (rule.layers ?? []).filter((l: any) => l.text).map((l: any) => l.text);
			if (layers.length) r.layers = layers;
			index.set(key, rules.length);
			rules.push(r);
			usedSheets.add(sheet);
		}
		return index.get(key)!;
	};

	const inlineId = (style: any, owner: string): number | null => {
		const key = `inline\0${owner}`;
		if (!index.has(key)) {
			const found = decls(style);
			if (!found.length) return null;
			for (const d of found) d.range = null;
			index.set(key, rules.length);
			rules.push({ sheet: null, inline: owner, selector: "style attribute", selectorRange: null, decls: found });
		}
		return index.get(key)!;
	};

	const level = (matchedRules: any[], inline: any, owner: string | null): number[] => {
		const ids = matchedRules.filter((m) => m.rule.origin === "regular").map((m) => ruleId(m.rule));
		if (inline && owner) ids.push(inlineId(inline, owner));
		return ids.filter((i): i is number => i !== null);
	};

	const nodes: Record<string, any> = {};
	for (const sel of sels) {
		const res = answers.get(sel);
		if (!res) continue;
		const up = ancestors(sel);
		nodes[sel] = {
			rules: level(res.matchedCSSRules ?? [], res.inlineStyle ?? null, sel),
			inherited: (res.inherited ?? []).map((lvl: any, i: number) =>
				level(lvl.matchedCSSRules ?? [], lvl.inlineStyle ?? null, i < up.length ? up[i] : null),
			),
		};
	}

	const sheets: any[] = [];
	for (const sid of usedSheets) {
		const h = headers.get(sid) ?? {};
		let text = "";
		try {
			text = (await cdp.send("CSS.getStyleSheetText", { styleSheetId: sid })).text;
		} catch {
			text = "";
		}
		sheets.push({
			id: sid,
			sourceURL: h.sourceURL ?? "",
			sourceMapURL: h.sourceMapURL || null,
			startLine: h.startLine ?? 0,
			devId: owners.get(sid)?.["data-vite-dev-id"] ?? null,
			text,
		});
	}
	await cdp.detach();
	return { sheets, rules, nodes } as RawStyles;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/** A URL without its fragment or trailing slash, for telling whether two URLs are the same page. */
export function normalUrl(url: string): string {
	const u = new URL(url);
	return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "") || "/"}${u.search}`;
}

/** A resource's URL without the stamps dev servers add afresh on every load. */
export function resourceKey(url: string): string {
	return stripDevStamps(url).replace(/[?&]+$/, "");
}

const digest = (data: Buffer | string): string => crypto.createHash("sha256").update(data).digest("hex");

interface Found {
	dom: string[];
	css: string;
	urls: string[];
}

/** The page's render fingerprint: its normalized DOM and CSS, and every script, stylesheet, image and font it uses. */
async function fingerprint(
	context: BrowserContext,
	page: PwPage,
	opts: CaptureOptions,
	bodies: Map<string, string>,
): Promise<{ fp: string; dom: string[]; resources: [string, string][] }> {
	const found = await evaluate<Found>(page, opts.fingerprintJs);
	const loaded = new Map(bodies);
	// Media the page refers to but hasn't loaded yet (lazy images below the fold).
	const missing = [...new Set(found.urls)].filter((u) => !loaded.has(resourceKey(u)));
	const fetched = await Promise.all(
		missing.map(async (url): Promise<[string, string]> => {
			try {
				const res = await context.request.get(url, { timeout: 5000 });
				return [resourceKey(url), digest(await res.body())];
			} catch {
				return [resourceKey(url), "unavailable"];
			}
		}),
	);
	for (const [key, value] of fetched) loaded.set(key, value);
	const resources = [...loaded].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const h = crypto.createHash("sha256");
	h.update(found.dom.join("\n"));
	h.update("\n--css--\n" + found.css);
	h.update("\n--resources--\n" + resources.map(([k, v]) => `${k} ${v}`).join("\n"));
	return { fp: h.digest("hex"), dom: found.dom, resources };
}

type Ask = (event: DriverEvent) => Promise<DriverReply | void>;
type Tell = (event: DriverEvent) => void;

/**
 * Load the page and fingerprint it. Returns the context and page when it
 * still needs capturing, or null when it's finished (redirected, carried
 * over, or fingerprinted only).
 */
async function openPage(
	browser: Browser,
	opts: CaptureOptions,
	index: number,
	job: PageJob,
	ask: Ask,
	tell: Tell,
): Promise<{ context: BrowserContext; page: PwPage } | null> {
	const context = await browser.newContext({
		viewport: opts.viewport,
		deviceScaleFactor: opts.scaleFactor,
		storageState: opts.authFile || undefined,
		// Sites that honour prefers-reduced-motion skip or shorten their
		// animations, so captures settle sooner and more consistently.
		reducedMotion: "reduce",
	});
	try {
		const page = await context.newPage();
		await opts.hooks?.beforeLoad?.(index, page);
		const bodies = new Map<string, string>();
		const pending: Promise<void>[] = [];
		page.on("response", (res) => {
			pending.push(
				(async () => {
					try {
						const kind = res.request().resourceType();
						if (!HASHED_TYPES.has(kind) || res.status() < 200 || res.status() >= 300) return;
						if (kind === "media" || res.status() === 206) {
							// Audio and video stream in byte ranges, which differ load to
							// load, so they're identified by their validators instead.
							const h = await res.allHeaders();
							const range = h["content-range"] ?? "";
							const total = range.slice(range.lastIndexOf("/") + 1) || (h["content-length"] ?? "");
							bodies.set(resourceKey(res.url()), digest(`${h.etag ?? ""}|${h["last-modified"] ?? ""}|${total}`));
						} else {
							bodies.set(resourceKey(res.url()), digest(await res.body()));
						}
					} catch {
						// a body that's gone (redirected, aborted) isn't part of the render
					}
				})(),
			);
		});
		await page.goto(job.url);
		const landed = normalUrl(page.url());
		if (landed !== normalUrl(job.url) && new Set(opts.knownUrls.map(normalUrl)).has(landed)) {
			tell({ index, event: "redirect", url: page.url() });
			await context.close();
			return null;
		}
		// Let hydration scripts finish loading. Components that hydrate
		// after the stabilize scroll pass never see their scroll-triggered
		// reveals fire. Capped, since some pages never go idle (polling).
		await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
		if (job.wait) await page.waitForTimeout(job.wait);
		await evaluate(page, HYDRATE_JS);
		await opts.hooks?.hydrated?.(index, page);
		await Promise.all([...pending]);
		const { fp, dom, resources } = await fingerprint(context, page, opts, bodies);
		if (opts.mode === "fingerprint") {
			tell({ index, event: "fingerprint", fingerprint: fp, dom: plain(dom), resources });
			await context.close();
			return null;
		}
		if (opts.cheat) {
			const reply = await ask({ index, event: "fingerprint", fingerprint: fp });
			if (reply && "carry" in reply && reply.carry) {
				await opts.hooks?.captured?.(index, page);
				await context.close();
				return null;
			}
		} else {
			tell({ index, event: "fingerprint", fingerprint: fp });
		}
		return { context, page };
	} catch (err) {
		await context.close();
		throw err;
	}
}

/** Settle the page, screenshot it, extract its elements and read the styles tunnelvision asks for. */
async function settleAndRead(page: PwPage, opts: CaptureOptions, index: number, job: PageJob, ask: Ask, tell: Tell): Promise<void> {
	// Fire scroll-triggered reveals and freeze CSS animations (after `wait`, before `waitFor`).
	if (job.stabilizeJs) await evaluate(page, job.stabilizeJs);
	if (job.waitFor) await page.waitForFunction(pageFunction(job.waitFor) as () => unknown);
	// Chromium's first full-page capture can permanently nudge text
	// layout (e.g. a heading 28px -> 27px), so the painted image no
	// longer matches rects measured beforehand. Take a throwaway shot
	// to settle the layout, capture for real, then measure what was
	// actually painted.
	await page.screenshot({ fullPage: true });
	await page.screenshot({ path: job.output, fullPage: true });
	const tree = plain(await evaluate<TreeNode[]>(page, opts.extractJs));
	let changed: string[] = [];
	if (opts.changedSelectors.length) {
		changed = plain(await evaluate<string[]>(page, MATCH_JS, { selectors: opts.changedSelectors, elements: [...selectors(tree)] }));
	}
	const reply = await ask({ index, event: "extracted", tree: tree as unknown as RawElement[], changed });
	const query = reply && "query" in reply ? reply.query : "all";
	let styles: RawStyles | null = null;
	if (query && (query === "all" || query.length)) {
		try {
			styles = plain(await readStyles(page, tree, query === "all" ? null : new Set(query)));
		} catch {
			styles = null;
		}
	}
	tell({ index, event: "done", styles });
}

/**
 * Capture `pages` with one page load each: wait, fingerprint, settle, write a
 * full-page screenshot, extract the element tree and read the matched styles
 * of the elements tunnelvision asks for. `onEvent` hears each step as it
 * happens and, for `fingerprint` (in cheat mode) and `extracted` events,
 * returns the reply the page is waiting on.
 */
export async function runDriver(
	pages: PageJob[],
	opts: CaptureOptions,
	onEvent: (event: DriverEvent) => Promise<DriverReply | void> | DriverReply | void,
): Promise<void> {
	for (const page of pages) fs.mkdirSync(path.dirname(page.output), { recursive: true });
	let failed: Error | null = null;
	const handling: Promise<unknown>[] = [];
	const ask: Ask = async (event) => {
		try {
			return await onEvent(event);
		} catch (err) {
			failed ??= err as Error;
			// Let the page finish without the answer it was waiting on.
			return { carry: false, query: [] } as unknown as DriverReply;
		}
	};
	const tell: Tell = (event) => {
		handling.push(ask(event));
	};

	const concurrency = Math.max(1, Math.floor(opts.concurrency));
	const load = new Semaphore(Math.max(concurrency, opts.loadConcurrency ?? concurrency));
	const capture = new Semaphore(concurrency);
	const browser = await launch();
	try {
		await Promise.all(
			pages.map(async (job, index) => {
				try {
					const opened = await load.use(() => openPage(browser, opts, index, job, ask, tell));
					if (!opened) return;
					try {
						await capture.use(async () => {
							await settleAndRead(opened.page, opts, index, job, ask, tell);
							await opts.hooks?.captured?.(index, opened.page);
						});
					} finally {
						await opened.context.close();
					}
				} catch (err) {
					// report and carry on with the other pages
					tell({ index, event: "error", error: String((err as Error).message ?? err).split("\n")[0] });
				}
			}),
		);
	} finally {
		await browser.close();
	}
	await Promise.all(handling);
	if (failed) throw failed;
}

export interface ShotJob {
	url: string;
	output: string;
	wait?: number;
	waitFor?: string;
	/** Evaluated after `wait`, before `waitFor` and the screenshot. */
	stabilizeJs: string;
}

/**
 * One viewport screenshot per page, for `--only-pages`. Pages load one at a
 * time in one shared context, the way shot-scraper's `multi` captured them.
 */
export async function runPages(
	jobs: ShotJob[],
	opts: { viewport: Viewport; scaleFactor: number; authFile?: string },
	label: (output: string) => string = (o) => o,
): Promise<RunResult> {
	const produced: string[] = [];
	const missing: string[] = [];
	const browser = await launch();
	try {
		const context = await browser.newContext({
			viewport: opts.viewport,
			deviceScaleFactor: opts.scaleFactor,
			storageState: opts.authFile || undefined,
			reducedMotion: "reduce",
		});
		for (const job of jobs) {
			fs.mkdirSync(path.dirname(job.output), { recursive: true });
			const page = await context.newPage();
			try {
				const res = await page.goto(job.url);
				if (res && res.status() >= 400) console.error(`  ${res.status()} error for ${job.url}`);
				if (job.wait) await page.waitForTimeout(job.wait);
				if (job.stabilizeJs) await evaluate(page, job.stabilizeJs);
				if (job.waitFor) await page.waitForFunction(pageFunction(job.waitFor) as () => unknown);
				await page.screenshot({ path: job.output });
				produced.push(label(job.output));
			} catch (err) {
				missing.push(`${label(job.output)} (${String((err as Error).message ?? err).split("\n")[0]})`);
			} finally {
				await page.close();
			}
		}
		await context.close();
	} finally {
		await browser.close();
	}
	return { produced, missing, exitCode: missing.length ? 1 : 0 };
}

/**
 * Open a visible browser at `url` for the user to sign in, and save the
 * session (cookies and local storage) as Playwright storage state once they
 * press enter. Readable only by the user, since it holds live session cookies.
 */
export async function saveAuth(url: string, outFile: string): Promise<void> {
	const browser = await launch(false);
	try {
		const context = await browser.newContext();
		const page = await context.newPage();
		await page.goto(url);
		const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
		await rl.question("Hit <enter> after you have signed in: ");
		rl.close();
		const state = await context.storageState();
		fs.mkdirSync(path.dirname(outFile), { recursive: true });
		fs.writeFileSync(outFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
		fs.chmodSync(outFile, 0o600);
	} finally {
		await browser.close();
	}
}
