import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { JSHandle, Page as BrowserPage } from "playwright";
import { hashOf, LOCKFILES, nearestVersion, readJson, writeJson } from "./carryover.js";
import type { Config, PluginSpec } from "./config.js";
import { changedLines, repoPrefix, type FileChanges } from "./git.js";
import type { PageHooks } from "./playwright.js";
import { versionDir, type Paths } from "./paths.js";
import { LineMapper } from "./remap.js";
import { lineLabel, packageChanges, remapCode, touchedBy, UnitTracer, type ChangedLine, type UnitCode } from "./unitcode.js";
import { versionRev } from "./versions.js";

/**
 * State plugins: each records Units of state while a Page is captured and
 * replays them into the next capture of that Page, so live data doesn't
 * differ between Versions (see docs/adr/0011-state-plugins-record-and-replay.md).
 *
 * A plugin only records and replays. Core decides which units are replayed,
 * carries Recordings forward, freezes the clock and reports.
 */

/** A unit of state as stored in a Recording: plugin-defined, JSON-serialisable data. */
export interface StoredUnit {
	id: string;
	data: unknown;
}

/** A unit of state as a plugin records it. */
export interface RecordedUnit extends StoredUnit {
	/** A function in the page that reproduces the unit's data, which core traces to find its code. */
	rerun?: JSHandle<() => unknown>;
}

/** What a plugin found on a page: the units it recorded, and what it couldn't. */
export interface StateRecord {
	units: RecordedUnit[];
	/** Units that weren't in a state to record (an error, still loading), with why. */
	skipped?: { id: string; reason: string }[];
	/** Problems with replay worth knowing, e.g. replayed data a live fetch replaced. */
	warnings?: string[];
}

export interface StatePlugin {
	/** Unique among plugins; keys the plugin's part of a Recording. */
	name: string;
	/** Bumped whenever what the plugin records or how it replays changes. */
	version: string;
	/** Before the page loads, with only the units core chose to replay (maybe none). */
	replay(page: BrowserPage, units: StoredUnit[]): Promise<void>;
	/**
	 * Once the page has hydrated, before its render fingerprint: every unit on
	 * the page. From then on the page must keep showing exactly what was
	 * recorded (no refetch, no polling), so the screenshot taken after it
	 * matches the Recording the next Version replays.
	 */
	record(page: BrowserPage): Promise<StateRecord>;
}

/** A plugin module's default export. */
export type PluginFactory = (options: Record<string, unknown>) => StatePlugin;

/** Written next to `elements.json`: the page's Recording. */
export const RECORDING = "state.json";
/** Bumped whenever what a Recording holds changes meaning. */
const RECORDING_VERSION = 2;

/**
 * How a unit got into this Version's Recording: taken from the previous
 * Recording (`replayed`), or from the running app because the previous
 * Recording didn't have it (`new`) or because the commit changed its code
 * (`changed`).
 */
export type UnitOrigin = "replayed" | "new" | "changed";

export interface RecordingUnit extends StoredUnit {
	origin: UnitOrigin;
	/** The code the data came from, at this Version's revision. */
	code: UnitCode;
	/** For a `changed` unit: the changed lines that made it run live. */
	changedBy?: ChangedLine[];
}

export interface PluginRecording {
	version: string;
	units: RecordingUnit[];
	/** Units seen on the page but left live, with why. */
	notRecorded: { id: string; reason: string }[];
	/** The plugin's warnings about this capture (see `StateRecord.warnings`). */
	warnings?: string[];
}

/** A Page's units of state in one Version, and the time they were recorded at. */
export interface Recording {
	version: number;
	/** Epoch ms the page's clock is frozen at. Carried forward with the units. */
	recordedAt: number;
	/** The Version the Recording was carried forward from, if any. */
	from: string | null;
	plugins: Record<string, PluginRecording>;
}

export function readRecording(pageDir: string): Recording | null {
	const r = readJson<Recording>(path.join(pageDir, RECORDING));
	return r && r.version === RECORDING_VERSION ? r : null;
}

const BUILTIN = "tunnelvision/plugins/";

/** Where a plugin specifier points: a built-in, a file in the project, or a package the project depends on. */
function resolvePlugin(root: string, spec: string): string {
	if (spec.startsWith(BUILTIN)) {
		const file = new URL(`./plugins/${spec.slice(BUILTIN.length)}.js`, import.meta.url);
		if (!fs.existsSync(file)) throw new Error(`There's no built-in plugin ${spec}.`);
		return file.href;
	}
	if (spec.startsWith(".") || path.isAbsolute(spec)) return pathToFileURL(path.resolve(root, spec)).href;
	return pathToFileURL(createRequire(path.join(root, "package.json")).resolve(spec)).href;
}

export async function loadPlugins(root: string, specs: PluginSpec[]): Promise<StatePlugin[]> {
	const plugins: StatePlugin[] = [];
	for (const entry of specs) {
		const [spec, options] = typeof entry === "string" ? [entry, {}] : entry;
		let mod: { default?: unknown };
		try {
			mod = await import(resolvePlugin(root, spec));
		} catch (err) {
			throw new Error(`Couldn't load the plugin ${spec}: ${(err as Error).message}`);
		}
		if (typeof mod.default !== "function") throw new Error(`The plugin ${spec} has no default export creating it.`);
		const plugin = (mod.default as PluginFactory)(options ?? {});
		if (!plugin?.name || typeof plugin.replay !== "function" || typeof plugin.record !== "function") {
			throw new Error(`The plugin ${spec} doesn't create a plugin (name, version, replay, record).`);
		}
		if (plugins.some((p) => p.name === plugin.name)) throw new Error(`Two plugins are both named ${plugin.name}.`);
		plugins.push(plugin);
	}
	return plugins;
}

/** Units `tunnelvision rerecord` records afresh instead of replaying: on these pages (all when null), of this plugin, with this in their id. */
export interface Rerecord {
	pages: Set<string> | null;
	plugin: string | null;
	text: string | null;
}

/** What the previous Recording means for one unit: replay it, or run it live and why. */
type Plan = { replay: true; code: UnitCode } | { replay: false; changedBy: ChangedLine[]; rerecorded?: true };

/** One page's capture so far. */
interface PageState {
	previous: Recording | null;
	recordedAt: number;
	/** By plugin, then unit id. */
	plans: Map<string, Map<string, Plan>>;
	recording?: Recording;
	/** Units recorded live, waiting for their code to be traced once the page is captured. */
	untraced: { plugin: string; unit: RecordingUnit; rerun?: JSHandle<() => unknown> }[];
}

/** What a session needs to know about the code between the previous Recording and this capture. */
export interface CodeChanges {
	changes: Map<string, FileChanges>;
	mapper: LineMapper;
	prefix: string;
}

/**
 * State plugins over one capture: replays each page's previous Recording,
 * except units whose code the commit changed, records what's on the page,
 * traces the code of what it recorded live, and writes the page's new
 * Recording.
 */
export class StateSession {
	/** Everything about the plugins that decides what a capture holds, for the settings hash. */
	readonly identity: string;
	private readonly pages: PageState[];

	private constructor(
		private readonly plugins: StatePlugin[],
		specs: PluginSpec[],
		/** The Version Recordings are carried forward from. */
		readonly from: string | null,
		fromDir: string | null,
		/** The diff from `from` to this capture; null when there's none (nothing is replayed). */
		private readonly code: CodeChanges | null,
		slugs: string[],
		now: number,
		private readonly root: string,
		rerecord: Rerecord | null,
	) {
		this.identity = hashOf({ recording: RECORDING_VERSION, plugins: plugins.map((p, i) => [p.name, p.version, specs[i]]) });
		this.pages = slugs.map((slug) => {
			const previous = fromDir ? readRecording(path.join(fromDir, slug)) : null;
			const selected = rerecord && (!rerecord.pages || rerecord.pages.has(slug)) ? rerecord : null;
			const fresh = (plugin: string, id: string) =>
				Boolean(selected && (!selected.plugin || selected.plugin === plugin) && (!selected.text || id.includes(selected.text)));
			const plans = this.plan(previous, fresh);
			// A page whose state is recorded afresh gets a fresh clock, so new data and time agree.
			const refreshed = [...plans.values()].some((byId) => [...byId.values()].some((p) => !p.replay && p.rerecorded));
			return { previous, recordedAt: previous && !refreshed ? previous.recordedAt : now, plans, untraced: [] };
		});
	}

	/** The session for a capture, or null when no plugins are configured. */
	static async open(
		paths: Paths,
		config: Config,
		key: string,
		rev: string | null,
		slugs: string[],
		rerecord: Rerecord | null = null,
	): Promise<StateSession | null> {
		if (!config.plugins.length) return null;
		const plugins = await loadPlugins(paths.root, config.plugins);
		const from = nearestVersion(paths, key);
		const fromRev = from && versionRev(from);
		const changes = fromRev && rev ? changedLines(paths.root, fromRev, rev) : null;
		const prefix = repoPrefix(paths.root);
		return StateSession.create({
			plugins,
			specs: config.plugins,
			from: from?.key ?? null,
			fromDir: from ? versionDir(paths, from.key) : null,
			code: changes ? { changes, mapper: new LineMapper(changes, prefix), prefix } : null,
			slugs,
			now: Date.now(),
			root: paths.root,
			rerecord,
		});
	}

	/** A session over loaded plugins, carrying Recordings forward from the page directories under `fromDir`. */
	static create(o: {
		plugins: StatePlugin[];
		specs: PluginSpec[];
		from: string | null;
		fromDir: string | null;
		code: CodeChanges | null;
		slugs: string[];
		now: number;
		root: string;
		rerecord?: Rerecord | null;
	}): StateSession {
		return new StateSession(o.plugins, o.specs, o.from, o.fromDir, o.code, o.slugs, o.now, o.root, o.rerecord ?? null);
	}

	get names(): string[] {
		return this.plugins.map((p) => p.name);
	}

	/** Whether there was a diff to decide replay by; without one every unit runs live. */
	get diffed(): boolean {
		return this.code !== null;
	}

	private plan(previous: Recording | null, fresh: (plugin: string, id: string) => boolean): Map<string, Map<string, Plan>> {
		const out = new Map<string, Map<string, Plan>>();
		for (const [name, p] of Object.entries(previous?.plugins ?? {})) {
			const plans = new Map<string, Plan>();
			for (const u of p.units) {
				if (fresh(name, u.id)) {
					plans.set(u.id, { replay: false, changedBy: [], rerecorded: true });
					continue;
				}
				if (!this.code || !u.code) continue; // no diff, or no code to check: live, as if new
				const packages = packageChanges(u.code, this.root, this.code.changes, LOCKFILES, this.code.prefix);
				const changedBy = [...touchedBy(u.code, this.code.changes, this.code.prefix), ...packages.lines];
				const moved = changedBy.length || packages.changed.length ? null : remapCode(u.code, this.code.mapper);
				plans.set(u.id, moved ? { replay: true, code: moved } : { replay: false, changedBy });
			}
			out.set(name, plans);
		}
		return out;
	}

	/** The units of `plugin` to replay on page `index`. */
	private replaying(index: number, plugin: StatePlugin): StoredUnit[] {
		const plans = this.pages[index].plans.get(plugin.name);
		return (this.pages[index].previous?.plugins[plugin.name]?.units ?? [])
			.filter((u) => plans?.get(u.id)?.replay)
			.map(({ id, data }) => ({ id, data }));
	}

	hooks(): PageHooks {
		return {
			beforeLoad: async (index, page) => {
				// Relative times in replayed data would drift with a real clock. Only
				// `Date` is frozen: timers and performance.now() still run.
				await page.clock.setFixedTime(this.pages[index].recordedAt);
				for (const plugin of this.plugins) {
					await failing(plugin, "replay", () => plugin.replay(page, this.replaying(index, plugin)));
				}
			},
			hydrated: async (index, page) => {
				const state = this.pages[index];
				const recording: Recording = { version: RECORDING_VERSION, recordedAt: state.recordedAt, from: state.previous ? this.from : null, plugins: {} };
				for (const plugin of this.plugins) {
					const found = await failing(plugin, "record", () => plugin.record(page));
					const previous = new Map((state.previous?.plugins[plugin.name]?.units ?? []).map((u) => [u.id, u]));
					const plans = state.plans.get(plugin.name);
					const units: RecordingUnit[] = [];
					for (const u of found.units) {
						const plan = plans?.get(u.id);
						const before = previous.get(u.id);
						if (plan?.replay && before) {
							// A replayed unit keeps its stored data exactly, rather than a
							// copy that has been through the page and back.
							units.push({ id: u.id, data: before.data, origin: "replayed", code: plan.code });
							await u.rerun?.dispose().catch(() => {});
							continue;
						}
						const unit: RecordingUnit =
							plan && !plan.replay && plan.changedBy.length
								? { id: u.id, data: u.data, origin: "changed", code: EMPTY_CODE, changedBy: plan.changedBy }
								: { id: u.id, data: u.data, origin: "new", code: EMPTY_CODE };
						units.push(unit);
						state.untraced.push({ plugin: plugin.name, unit, rerun: u.rerun });
					}
					recording.plugins[plugin.name] = {
						version: plugin.version,
						units,
						notRecorded: found.skipped ?? [],
						...(found.warnings?.length ? { warnings: found.warnings } : {}),
					};
				}
				state.recording = recording;
			},
			captured: async (index, page) => {
				const state = this.pages[index];
				const pending = state.untraced.splice(0);
				if (!pending.length || !state.recording) return;
				const tracer = await UnitTracer.open(page, this.root).catch(() => null);
				for (const { plugin, unit, rerun } of pending) {
					const traced = !rerun ? { error: "nothing to re-run" } : tracer ? await tracer.trace(rerun) : { error: "coverage unavailable" };
					await rerun?.dispose().catch(() => {});
					if ("error" in traced) {
						// Replaying it later could hide a change nothing would detect, so it stays live.
						const p = state.recording.plugins[plugin];
						p.units = p.units.filter((u) => u !== unit);
						p.notRecorded.push({ id: unit.id, reason: `couldn't trace its code (${traced.error})` });
					} else {
						unit.code = traced;
					}
				}
				await tracer?.close();
			},
		};
	}

	/** Write page `index`'s Recording into its directory, if it got as far as recording. */
	write(index: number, pageDir: string): void {
		const recording = this.pages[index].recording;
		if (recording) writeJson(path.join(pageDir, RECORDING), recording);
	}

	/** Counts over the capture, for its summary line. */
	totals(): Record<UnitOrigin | "notRecorded", number> {
		const t = { replayed: 0, new: 0, changed: 0, notRecorded: 0 };
		for (const { recording } of this.pages) {
			for (const p of Object.values(recording?.plugins ?? {})) {
				for (const u of p.units) t[u.origin]++;
				t.notRecorded += p.notRecorded.length;
			}
		}
		return t;
	}

	/** Per-page notes worth showing (see `recordingNotes`). */
	notes(index: number): string[] {
		const recording = this.pages[index].recording;
		return recording ? recordingNotes(recording) : [];
	}
}

/** What a Recording says wasn't replayed: units that ran live because their code changed, and units left live. */
export function recordingNotes(recording: Recording): string[] {
	const out: string[] = [];
	for (const [name, p] of Object.entries(recording.plugins)) {
		for (const u of p.units) {
			if (u.origin === "changed") out.push(`${name}: ${u.id} ran live, its code changed (${(u.changedBy ?? []).map(lineLabel).join(", ") || "a package"})`);
		}
		for (const s of p.notRecorded) out.push(`${name}: ${s.id} not recorded (${s.reason})`);
		for (const w of p.warnings ?? []) out.push(`${name}: ${w}`);
	}
	return out;
}

const EMPTY_CODE: UnitCode = { ran: {}, functions: {}, packages: {} };

async function failing<T>(plugin: StatePlugin, hook: string, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		throw new Error(`plugin ${plugin.name} (${hook}): ${(err as Error).message.split("\n")[0]}`);
	}
}

/**
 * What a unit that ran live because its code changed did to its data: the
 * changed lines behind it, and the values its data gained and lost. A visual
 * change showing one of those values is explained by those lines.
 */
export interface DataChange {
	/** `plugin id`, for people. */
	unit: string;
	causes: ChangedLine[];
	added: (string | number)[];
	removed: (string | number)[];
}

/** The data changes on a page between its Recordings in two Versions. */
export function dataChanges(from: Recording | null, to: Recording | null): DataChange[] {
	const out: DataChange[] = [];
	for (const [name, p] of Object.entries(to?.plugins ?? {})) {
		const before = new Map((from?.plugins[name]?.units ?? []).map((u) => [u.id, u.data]));
		for (const u of p.units) {
			if (u.origin !== "changed" || !u.changedBy?.length) continue;
			const was = leaves(before.get(u.id));
			const now = leaves(u.data);
			out.push({ unit: `${name} ${u.id}`, causes: u.changedBy, added: missingFrom(now, was), removed: missingFrom(was, now) });
		}
	}
	return out;
}

/** The strings and numbers in a JSON value. */
function leaves(value: unknown): (string | number)[] {
	const out: (string | number)[] = [];
	const visit = (v: unknown): void => {
		if (typeof v === "string" || typeof v === "number") out.push(v);
		else if (Array.isArray(v)) v.forEach(visit);
		else if (v && typeof v === "object") Object.values(v).forEach(visit);
	};
	visit(value);
	return out;
}

/** The values of `a` that `b` doesn't have as many of. */
function missingFrom(a: (string | number)[], b: (string | number)[]): (string | number)[] {
	const left = new Map<string, number>();
	for (const v of b) left.set(String(v), (left.get(String(v)) ?? 0) + 1);
	const out: (string | number)[] = [];
	for (const v of a) {
		const n = left.get(String(v)) ?? 0;
		if (n > 0) left.set(String(v), n - 1);
		else out.push(v);
	}
	return out;
}
