import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser } from "playwright";
import { checkPlaywright } from "../src/playwright.js";
import { parseUnifiedDiff } from "../src/git.js";
import { CODEC_JS } from "../src/plugins/tanstack-query.js";
import { LineMapper } from "../src/remap.js";
import { dataChanges, loadPlugins, readRecording, RECORDING, recordingNotes, StateSession, type CodeChanges, type StatePlugin, type StoredUnit } from "../src/state.js";
import type { UnitCode } from "../src/unitcode.js";

const browserless = !checkPlaywright().installed && "chromium not installed";

const CODE: UnitCode = { ran: { "src/api.js": [[1, 5]] }, functions: { "src/api.js": [[1, 5]] }, packages: {} };

/** No changes between the previous Recording and this capture. */
function noChanges(): CodeChanges {
	const changes = new Map();
	return { changes, mapper: new LineMapper(changes), prefix: "" };
}

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tunnelvision-state-"));
}

/** A plugin that records whatever it's told to, and remembers what it was asked to replay. */
function fakePlugin(found: StoredUnit[], version = "1"): StatePlugin & { replayed: StoredUnit[][] } {
	const replayed: StoredUnit[][] = [];
	return {
		name: "fake",
		version,
		replayed,
		async replay(_page, units) {
			replayed.push(units);
		},
		async record() {
			return { units: found, skipped: [{ id: "broken", reason: "error: 500" }] };
		},
	};
}

async function withPage<T>(fn: (page: import("playwright").Page) => Promise<T>): Promise<T> {
	const browser: Browser = await chromium.launch();
	try {
		return await fn(await browser.newPage());
	} finally {
		await browser.close();
	}
}

test("a session replays the previous Recording, keeps replayed data exactly, records new units and drops unused ones", { skip: browserless }, async () => {
	const fromDir = tmp();
	const recordedAt = Date.UTC(2026, 0, 2, 3, 4, 5);
	fs.mkdirSync(path.join(fromDir, "index"));
	fs.writeFileSync(
		path.join(fromDir, "index", RECORDING),
		JSON.stringify({
			version: 2,
			recordedAt,
			from: null,
			plugins: {
				fake: {
					version: "1",
					units: [
						{ id: "a", data: { n: 1 }, origin: "new", code: CODE },
						{ id: "b", data: { n: 2 }, origin: "new", code: CODE },
					],
					notRecorded: [],
				},
			},
		}),
	);
	// The page reports `a` (its data having been through the page) and a new `c`; `b` isn't used any more.
	const plugin = fakePlugin([{ id: "a", data: { n: 1, roundTripped: true } }, { id: "c", data: { n: 3 } }]);
	const session = StateSession.create({ plugins: [plugin], specs: ["./fake.js"], from: "abc1234", fromDir, code: noChanges(), slugs: ["index"], now: Date.now(), root: fromDir });
	const hooks = session.hooks();

	const clock = await withPage(async (page) => {
		await hooks.beforeLoad!(0, page);
		await page.goto("about:blank");
		await hooks.hydrated!(0, page);
		return page.evaluate(async () => {
			const t0 = performance.now();
			const d0 = Date.now();
			await new Promise((r) => setTimeout(r, 50));
			return { date: Date.now(), dateMoved: Date.now() !== d0, perfMoved: performance.now() - t0 >= 40 };
		});
	});

	assert.deepEqual(plugin.replayed, [[{ id: "a", data: { n: 1 } }, { id: "b", data: { n: 2 } }]]);
	assert.equal(clock.date, recordedAt, "Date is frozen at the Recording's time");
	assert.equal(clock.dateMoved, false);
	assert.equal(clock.perfMoved, true, "timers and performance.now() still run");

	const out = tmp();
	session.write(0, out);
	const rec = readRecording(out);
	assert.ok(rec);
	assert.equal(rec.recordedAt, recordedAt);
	assert.equal(rec.from, "abc1234");
	assert.deepEqual(rec.plugins.fake.units, [
		{ id: "a", data: { n: 1 }, origin: "replayed", code: CODE },
		{ id: "c", data: { n: 3 }, origin: "new", code: { ran: {}, functions: {}, packages: {} } },
	]);
	assert.deepEqual(rec.plugins.fake.notRecorded, [{ id: "broken", reason: "error: 500" }]);
	assert.deepEqual(session.totals(), { replayed: 1, new: 1, changed: 0, notRecorded: 1 });
});

test("a page with no previous Recording replays nothing and records at the capture's time", { skip: browserless }, async () => {
	const now = Date.UTC(2026, 5, 1);
	const plugin = fakePlugin([{ id: "a", data: 1 }]);
	const session = StateSession.create({ plugins: [plugin], specs: ["./fake.js"], from: null, fromDir: null, code: null, slugs: ["index"], now, root: tmp() });
	await withPage(async (page) => {
		await session.hooks().beforeLoad!(0, page);
		await session.hooks().hydrated!(0, page);
	});
	assert.deepEqual(plugin.replayed, [[]]);
	const out = tmp();
	session.write(0, out);
	assert.equal(readRecording(out)?.recordedAt, now);
	assert.equal(readRecording(out)?.from, null);
});

test("a page that never recorded writes no Recording", () => {
	const session = StateSession.create({ plugins: [fakePlugin([])], specs: ["x"], from: null, fromDir: null, code: null, slugs: ["index"], now: 0, root: tmp() });
	const out = tmp();
	session.write(0, out);
	assert.equal(fs.existsSync(path.join(out, RECORDING)), false);
});

test("a session's identity changes with a plugin's version or options", () => {
	const make = (version: string, specs: (string | [string, Record<string, unknown>])[]) =>
		StateSession.create({ plugins: [fakePlugin([], version)], specs, from: null, fromDir: null, code: null, slugs: [], now: 0, root: "/" }).identity;
	assert.equal(make("1", ["./p.js"]), make("1", ["./p.js"]));
	assert.notEqual(make("1", ["./p.js"]), make("2", ["./p.js"]));
	assert.notEqual(make("1", ["./p.js"]), make("1", [["./p.js", { flag: true }]]));
});

test("loadPlugins: built-ins, project files with options, and helpful errors", async () => {
	const root = tmp();
	fs.writeFileSync(path.join(root, "package.json"), "{}");
	fs.writeFileSync(
		path.join(root, "mine.mjs"),
		"export default (o) => ({ name: 'mine', version: String(o.v ?? 0), async replay() {}, async record() { return { units: [] }; } });",
	);
	fs.writeFileSync(path.join(root, "nodefault.mjs"), "export const x = 1;");
	const [builtin, mine] = await loadPlugins(root, ["tunnelvision/plugins/tanstack-query", ["./mine.mjs", { v: 7 }]]);
	assert.equal(builtin.name, "tanstack-query");
	assert.equal(mine.version, "7");
	await assert.rejects(loadPlugins(root, ["tunnelvision/plugins/nope"]), /no built-in plugin/);
	await assert.rejects(loadPlugins(root, ["./nodefault.mjs"]), /no default export/);
	await assert.rejects(loadPlugins(root, ["./mine.mjs", "./mine.mjs"]), /both named mine/);
	await assert.rejects(loadPlugins(root, ["not-installed-plugin"]), /Couldn't load the plugin not-installed-plugin/);
});

test("the TanStack Query codec round-trips what JSON can't", { skip: browserless }, async () => {
	const result = await withPage(async (page) => {
		await page.addInitScript({ content: CODEC_JS });
		await page.goto("about:blank");
		return page.evaluate(() => {
			const { encode, decode } = (globalThis as any).__tvCodec; // eslint-disable-line @typescript-eslint/no-explicit-any
			const value = {
				when: new Date("2026-01-02T03:04:05.000Z"),
				tags: new Set(["a", "b"]),
				byId: new Map([[1, { name: "x" }]]),
				big: BigInt("12345678901234567890"),
				missing: undefined,
				inf: Infinity,
				tricky: { $tv: "Date", v: "not a date" },
				list: [new Date(0), null, 1, "s"],
			};
			const back = decode(JSON.parse(JSON.stringify(encode(value))));
			return {
				when: back.when instanceof Date && back.when.toISOString(),
				tags: back.tags instanceof Set && [...back.tags],
				byId: back.byId instanceof Map && back.byId.get(1).name,
				big: typeof back.big === "bigint" && String(back.big),
				missing: "missing" in back && back.missing === undefined,
				inf: back.inf === Infinity,
				tricky: back.tricky,
				list0: back.list[0] instanceof Date && back.list[0].getTime(),
				rest: back.list.slice(1),
			};
		});
	});
	assert.deepEqual(result, {
		when: "2026-01-02T03:04:05.000Z",
		tags: ["a", "b"],
		byId: "x",
		big: "12345678901234567890",
		missing: true,
		inf: true,
		tricky: { $tv: "Date", v: "not a date" },
		list0: 0,
		rest: [null, 1, "s"],
	});
});

test("a unit whose code the commit changed isn't replayed, and runs live with the lines that changed it", { skip: browserless }, async () => {
	const fromDir = tmp();
	fs.mkdirSync(path.join(fromDir, "index"));
	fs.writeFileSync(
		path.join(fromDir, "index", RECORDING),
		JSON.stringify({ version: 2, recordedAt: 0, from: null, plugins: { fake: { version: "1", units: [{ id: "a", data: 1, origin: "new", code: CODE }], notRecorded: [] } } }),
	);
	const changes = parseUnifiedDiff(
		["diff --git a/src/api.js b/src/api.js", "--- a/src/api.js", "+++ b/src/api.js", "@@ -3 +3 @@", "-  old", "+  new", ""].join("\n"),
	);
	const plugin = fakePlugin([{ id: "a", data: 2 }]);
	const session = StateSession.create({ plugins: [plugin], specs: ["x"], from: "abc", fromDir, code: { changes, mapper: new LineMapper(changes), prefix: "" }, slugs: ["index"], now: 0, root: fromDir });
	await withPage(async (page) => {
		await session.hooks().beforeLoad!(0, page);
		await session.hooks().hydrated!(0, page);
		await session.hooks().captured!(0, page);
	});
	assert.deepEqual(plugin.replayed, [[]]);
	const out = tmp();
	session.write(0, out);
	// Its rerun is missing, so it can't be traced: it's left out of the Recording, live.
	assert.deepEqual(readRecording(out)?.plugins.fake.units, []);
	assert.deepEqual(readRecording(out)?.plugins.fake.notRecorded.at(-1), { id: "a", reason: "couldn't trace its code (nothing to re-run)" });
	assert.deepEqual(session.totals(), { replayed: 0, new: 0, changed: 0, notRecorded: 2 });
});

test("dataChanges: what a unit that ran live because its code changed gained and lost", () => {
	const unit = (id: string, data: unknown, origin: "replayed" | "new" | "changed") => ({
		id,
		data,
		origin,
		code: CODE,
		...(origin === "changed" ? { changedBy: [{ side: "RIGHT" as const, path: "src/api.js", line: 8 }] } : {}),
	});
	const rec = (units: ReturnType<typeof unit>[]) => ({ version: 2, recordedAt: 0, from: null, plugins: { q: { version: "1", units, notRecorded: [] } } });
	const from = rec([unit("a", { rows: [{ n: "x", v: 1 }, { n: "y", v: 2 }] }, "new"), unit("b", ["same"], "new")]);
	const to = rec([unit("a", { rows: [{ n: "x", v: 1 }, { n: "z", v: 3 }] }, "changed"), unit("b", ["same"], "replayed")]);
	assert.deepEqual(dataChanges(from, to), [
		{ unit: "q a", causes: [{ side: "RIGHT", path: "src/api.js", line: 8 }], added: ["z", 3], removed: ["y", 2] },
	]);
	assert.deepEqual(dataChanges(null, to)[0].added, ["x", 1, "z", 3]);
});

test("rerecord: chosen units run live instead of replaying, and their pages get a fresh clock", { skip: browserless }, async () => {
	const fromDir = tmp();
	for (const slug of ["index", "pricing"]) {
		fs.mkdirSync(path.join(fromDir, slug));
		fs.writeFileSync(
			path.join(fromDir, slug, RECORDING),
			JSON.stringify({
				version: 2,
				recordedAt: 1000,
				from: null,
				plugins: { fake: { version: "1", units: [{ id: '["stats"]', data: 1, origin: "new", code: CODE }, { id: '["feed"]', data: 2, origin: "new", code: CODE }], notRecorded: [] } },
			}),
		);
	}
	const plugin = fakePlugin([]);
	const session = StateSession.create({
		plugins: [plugin],
		specs: ["x"],
		from: "abc",
		fromDir,
		code: noChanges(),
		slugs: ["index", "pricing"],
		now: 5000,
		root: fromDir,
		rerecord: { pages: new Set(["pricing"]), plugin: "fake", text: "feed" },
	});
	const clocks = await withPage(async (page) => {
		const out: number[] = [];
		for (const i of [0, 1]) {
			await session.hooks().beforeLoad!(i, page);
			await page.goto("about:blank");
			out.push(await page.evaluate(() => Date.now()));
		}
		return out;
	});
	assert.deepEqual(plugin.replayed.map((units) => units.map((u) => u.id)), [['["stats"]', '["feed"]'], ['["stats"]']]);
	assert.deepEqual(clocks, [1000, 5000]);
});

test("recordingNotes: units that ran live because their code changed, and units left live", () => {
	const notes = recordingNotes({
		version: 2,
		recordedAt: 0,
		from: null,
		plugins: {
			q: {
				version: "1",
				units: [
					{ id: "a", data: 1, origin: "replayed", code: CODE },
					{ id: "b", data: 1, origin: "changed", code: CODE, changedBy: [{ side: "RIGHT", path: "src/api.js", line: 8 }, { side: "RIGHT", path: "bun.lock" }] },
				],
				notRecorded: [{ id: "c", reason: "error: 500" }],
			},
		},
	});
	assert.deepEqual(notes, ["q: b ran live, its code changed (src/api.js:8, bun.lock)", "q: c not recorded (error: 500)"]);
});

test("environmentVersions: each plugin, so cheat mode validates again when one changes", async () => {
	const { environmentVersions, toolVersion } = await import("../src/environment.js");
	const root = tmp();
	fs.writeFileSync(path.join(root, "package.json"), "{}");
	fs.writeFileSync(path.join(root, "mine.mjs"), "export default 1;");
	const before = environmentVersions(root, ["tunnelvision/plugins/tanstack-query", ["./mine.mjs", { a: 1 }], "not-installed"]);
	assert.equal(before["plugin tunnelvision/plugins/tanstack-query"], toolVersion());
	assert.match(before["plugin ./mine.mjs"], /^file [0-9a-f]{12} [0-9a-f]{8}$/);
	assert.equal(before["plugin not-installed"], "missing");
	fs.writeFileSync(path.join(root, "mine.mjs"), "export default 2;");
	assert.notEqual(environmentVersions(root, [["./mine.mjs", { a: 1 }]])["plugin ./mine.mjs"], before["plugin ./mine.mjs"]);
	assert.deepEqual(Object.keys(environmentVersions(root)), ["tunnelvision"]);
});
