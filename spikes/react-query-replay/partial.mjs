// Follow-up: replay only ["feed"] (stats stays live), and check that the
// hook leaves React fibers reachable the way src/elements.ts looks for them.
import fs from "node:fs";
import { chromium } from "playwright";

const { record } = JSON.parse(fs.readFileSync("result.json", "utf8"));
const src = fs.readFileSync("spike.mjs", "utf8");
const HOOK = eval("(" + src.match(/const HOOK = (\(units\) => \{[\s\S]*?\n\});/)[1] + ")");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
await page.clock.setFixedTime(record.at);
await page.addInitScript(HOOK, record.units.filter((u) => u.hash === '["feed"]'));
const requests = [];
page.on("request", (r) => r.url().includes("/api/") && requests.push(new URL(r.url()).pathname));
await page.goto("http://localhost:5199/");
await page.waitForSelector(".feed-item");
await page.waitForTimeout(3000);
const result = await page.evaluate(() => {
	const el = document.querySelector(".stat-value");
	const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
	const viaHook = [...hook.renderers.values()].some((r) => {
		try { return !!r.findFiberByHostInstance?.(el); } catch { return false; }
	});
	const viaExpando = Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
	return {
		feed: [...document.querySelectorAll(".feed-item")].map((e) => e.innerText.replace(/\s+/g, " ")),
		stats: [...document.querySelectorAll(".stat")].map((e) => e.innerText.replace(/\s+/g, " ")),
		renderers: hook.renderers.size,
		viaHook,
		viaExpando,
		log: window.__tv.log,
	};
});
await browser.close();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
console.log("feed replayed, matches recording?", same(result.feed, record.visible.feed));
console.log("stats live, differs from recording?", !same(result.stats, record.visible.stats), result.stats.join(" | "));
console.log("api requests", JSON.stringify(requests));
console.log("renderers", result.renderers, "fiber via hook", result.viaHook, "via expando", result.viaExpando);
for (const l of result.log) console.log("  ", l);
