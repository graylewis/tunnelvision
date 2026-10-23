// Spike for ADR 0011: does seeding TanStack Query at React's first commit beat
// the live fetch (including Suspense), and can a queryFn's code be found by
// re-running it under precise coverage?
//
// Needs examples/dashboard's dev server on :5199. Run: node spike.mjs

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const BASE = "http://localhost:5199/";
const SETTLE_MS = 5000; // > two refetchInterval periods
const require = createRequire(path.resolve("../../examples/dashboard/package.json"));
const { SourceMapConsumer } = require("source-map-js");

// The replay plugin's init script. Installs a DevTools hook (keeping the
// `renderers` map tunnelvision's extractor reads), and at the first commit
// that contains a QueryClientProvider: cancels in-flight fetches of replayed
// keys, seeds them, and pins their fetch to the seeded data.
const HOOK = (units) => {
	const state = (window.__tv = { units, log: [], client: null, seededAt: null, commits: 0 });
	const log = (msg) => state.log.push(`${performance.now().toFixed(0)}ms ${msg}`);
	if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) log("hook already present");
	const renderers = new Map();
	let id = 0;
	function findClient(fiber) {
		const stack = [fiber];
		while (stack.length) {
			const f = stack.pop();
			if (!f) continue;
			const c = f.memoizedProps && f.memoizedProps.client;
			if (c && typeof c.getQueryCache === "function") return c;
			stack.push(f.sibling, f.child);
		}
		return null;
	}
	function seed(client) {
		const cache = client.getQueryCache();
		for (const u of state.units) {
			const before = cache.get(u.hash);
			if (before && before.state.fetchStatus === "fetching") {
				before.cancel({ revert: true });
				log(`cancelled in-flight ${u.hash}`);
			}
			client.setQueryData(u.key, u.data, { updatedAt: u.dataUpdatedAt });
			const q = cache.get(u.hash);
			q.fetch = function () {
				log(`blocked fetch ${u.hash}`);
				return Promise.resolve(this.state.data);
			};
		}
		log(`seeded ${state.units.length} at commit ${state.commits}`);
	}
	window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
		renderers,
		supportsFiber: true,
		checkDCE() {},
		inject(renderer) {
			renderers.set(++id, renderer);
			return id;
		},
		onScheduleFiberRoot() {},
		onCommitFiberRoot(_id, root) {
			state.commits++;
			if (state.client) return;
			const client = findClient(root.current);
			if (!client) return;
			state.client = client;
			log(`client found at commit ${state.commits}`);
			if (state.units.length) seed(client);
		},
		onCommitFiberUnmount() {},
		onPostCommitFiberRoot() {},
	};
};

async function open(browser, { units, at }) {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
	const page = await context.newPage();
	await page.clock.setFixedTime(at);
	await page.addInitScript(HOOK, units);
	const requests = [];
	page.on("request", (r) => {
		if (r.url().includes("/api/")) requests.push(new URL(r.url()).pathname);
	});
	await page.goto(BASE);
	await page.waitForSelector(".feed-item");
	await page.waitForTimeout(SETTLE_MS);
	return { context, page, requests };
}

const visible = (page) =>
	page.evaluate(() => ({
		stats: [...document.querySelectorAll(".stat")].map((e) => e.innerText.replace(/\s+/g, " ")),
		feed: [...document.querySelectorAll(".feed-item")].map((e) => e.innerText.replace(/\s+/g, " ")),
	}));

// Source-map a script's generated offset to the original file:line.
async function mapper(page, url) {
	const src = await (await page.request.get(url)).text();
	const m = src.match(/sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,(\S+)/);
	const consumer = m ? new SourceMapConsumer(JSON.parse(Buffer.from(m[1], "base64").toString())) : null;
	const lineStarts = [0];
	for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
	return (offset) => {
		let line = lineStarts.findLastIndex((s) => s <= offset);
		const column = offset - lineStarts[line];
		if (!consumer) return `${url}:${line + 1} (unmapped)`;
		const o = consumer.originalPositionFor({ line: line + 1, column });
		return `${o.source}:${o.line}`;
	};
}

async function trace(page, cdp, hash) {
	await cdp.send("Profiler.takePreciseCoverage"); // reset counters
	const ok = await page.evaluate(async (hash) => {
		const client = window.__tv.client;
		const q = client.getQueryCache().get(hash);
		await q.options.queryFn({ queryKey: q.queryKey, signal: new AbortController().signal, meta: q.meta, client });
		return true;
	}, hash);
	const { result } = await cdp.send("Profiler.takePreciseCoverage");
	const ran = [];
	for (const script of result) {
		if (!script.url.includes("/src/")) continue;
		const map = await mapper(page, script.url);
		for (const fn of script.functions) {
			const [whole] = fn.ranges;
			if (!whole.count) continue;
			const name = fn.functionName || "(module top level)";
			ran.push(`${name}  ${map(whole.startOffset)} – ${map(whole.endOffset - 1)}  ×${whole.count}`);
		}
	}
	return { ok, ran };
}

const browser = await chromium.launch();
const out = {};

// 1. Record: a live load, clock frozen at the recording time.
const at = Date.now();
{
	const { context, page, requests } = await open(browser, { units: [], at });
	const units = await page.evaluate(() =>
		window.__tv.client
			.getQueryCache()
			.getAll()
			.filter((q) => q.state.status === "success")
			.map((q) => ({ hash: q.queryHash, key: q.queryKey, data: q.state.data, dataUpdatedAt: q.state.dataUpdatedAt })),
	);
	const cdp = await context.newCDPSession(page);
	await cdp.send("Profiler.enable");
	await cdp.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
	const traces = {};
	for (const u of units) traces[u.hash] = await trace(page, cdp, u.hash);
	out.record = { at, units, traces, requests, visible: await visible(page), log: await page.evaluate(() => window.__tv.log) };
	await context.close();
}

// 2. Control: two more live loads, to show the data really moves.
out.live = [];
for (let i = 0; i < 2; i++) {
	const { context, page, requests } = await open(browser, { units: [], at });
	out.live.push({ requests, visible: await visible(page) });
	await context.close();
}

// 3. Replay the recording three times.
out.replay = [];
for (let i = 0; i < 3; i++) {
	const { context, page, requests } = await open(browser, { units: out.record.units, at });
	out.replay.push({ requests, visible: await visible(page), log: await page.evaluate(() => window.__tv.log) });
	await context.close();
}
await browser.close();

fs.writeFileSync("result.json", JSON.stringify(out, null, 2));

// Report.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
console.log("RECORD", out.record.units.map((u) => u.hash).join(", "));
console.log("  visible", JSON.stringify(out.record.visible));
for (const [hash, t] of Object.entries(out.record.traces)) {
	console.log(`  trace ${hash}`);
	for (const line of t.ran) console.log(`    ${line}`);
}
out.live.forEach((r, i) => console.log(`LIVE ${i}: matches recording? ${same(r.visible, out.record.visible)}  requests=${r.requests.length}`));
out.replay.forEach((r, i) => {
	console.log(`REPLAY ${i}: matches recording? ${same(r.visible, out.record.visible)}  requests=${JSON.stringify(r.requests)}`);
	if (!same(r.visible, out.record.visible)) console.log("  visible", JSON.stringify(r.visible));
	for (const line of r.log) console.log(`    ${line}`);
});
