import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { causeLocation, type Correlation, type Effect, type RenderSite, type UnexplainedChange } from "./correlate.js";
import type { DiffReport, PageStatus } from "./diffengine.js";

const STATUS_STYLE: Record<PageStatus, (s: string) => string> = {
	unchanged: (s) => pc.dim(s),
	changed: (s) => pc.yellow(s),
	added: (s) => pc.green(s),
	removed: (s) => pc.red(s),
	"size-mismatch": (s) => pc.magenta(s),
	error: (s) => pc.red(s),
};

const STATUS_LABEL: Record<PageStatus, string> = {
	unchanged: "unchanged",
	changed: "CHANGED",
	added: "added",
	removed: "removed",
	"size-mismatch": "size!",
	error: "error",
};

export function printReport(report: DiffReport): void {
	console.log("");
	console.log(pc.bold(`Diff  ${report.from}  ->  ${report.to}`));
	console.log("");
	for (const w of report.warnings ?? []) console.log(pc.yellow(`  ! ${w}`));
	if (report.warnings?.length) console.log("");
	if (report.state?.length) {
		console.log(pc.bold("  State"));
		for (const { page, notes } of report.state) for (const note of notes) console.log(pc.dim(`    ${page}: ${note}`));
		console.log("");
	}

	const rows = report.pages.filter((p) => p.status !== "unchanged");
	if (rows.length === 0) {
		console.log(pc.green("  No visual changes detected."));
	} else {
		for (const p of report.pages) {
			if (p.status === "unchanged") continue;
			const style = STATUS_STYLE[p.status];
			const label = style(STATUS_LABEL[p.status].padEnd(9));
			let detail = "";
			if (p.diffPercent !== undefined) detail = pc.dim(`${p.diffPercent.toFixed(3)}%`);
			else if (p.message) detail = pc.dim(p.message);
			console.log(`  ${label} ${p.filename}  ${detail}`);
			if (p.diffImage) console.log(pc.dim(`            diff: ${p.diffImage}`));
			if (p.fromFilename) {
				const how = p.matchedBy ? ` by ${p.matchedBy.replace(/^attr:/, "")}` : "";
				console.log(pc.dim(`            ${p.moved ? "moved from" : "was"} ${p.fromFilename} (matched${how})`));
			}
		}
	}

	if (report.correlation) printCorrelation(report.correlation);
	else if (report.correlationSkipped && report.hasChanges) {
		console.log("");
		console.log(pc.dim(`  Causes not traced: ${report.correlationSkipped}.`));
	}

	const unchanged = report.pages.filter((p) => p.status === "unchanged").length;
	console.log("");
	console.log(
		pc.dim(
			`  ${report.pages.length} pages  •  ${report.changedCount} changed  •  ` +
				`${report.addedCount} added  •  ${report.removedCount} removed  •  ${unchanged} unchanged`,
		),
	);
	console.log("");
}

const MAX_PROPS = 3;

/** Changed lines and the visual changes they caused. */
function printCorrelation(c: Correlation): void {
	const { causes, unexplained, invisible, withoutStyles } = c;
	if (causes.length === 0 && !c.renderSites?.length && unexplained.length === 0 && invisible.length === 0) return;
	console.log("");
	console.log(pc.bold("  Causes"));
	if (causes.length === 0) console.log(pc.dim("    No changed line explains a visual change."));
	for (const cause of causes) {
		const where = `${causeLocation(cause)}${cause.side === "LEFT" ? " (deleted)" : ""}`;

		// Only properties whose declaration changed; the rest are results of layout.
		const props = [...new Set(cause.effects.flatMap((e) => e.props.filter((p) => p.own).map((p) => p.name)))];
		const propText = props.length ? `  ${props.slice(0, MAX_PROPS).join(", ")}${props.length > MAX_PROPS ? ", …" : ""}` : "";
		const kind = cause.kind === "content" || cause.kind === "data" ? `${cause.kind} (${cause.content})` : cause.kind;
		console.log(`    ${pc.cyan(where)}  ${pc.dim(cause.text ? `${cause.text}  · ${kind}` : kind)}`);
		console.log(pc.dim(`      → ${unitCount(cause.effects)}${propText}`));
	}
	printRenderSites(c.renderSites ?? []);
	const notExercised = invisible.filter((i) => i.reason === "not-exercised").length;
	const extras = [
		unexplainedSummary(unexplained),
		invisible.length
			? `${invisible.length} CSS line${invisible.length === 1 ? "" : "s"} with no visible effect` +
				(notExercised ? ` (${notExercised} not exercised)` : "")
			: "",
		withoutStyles.length ? `${withoutStyles.length} page(s) without style data (re-capture to trace CSS)` : "",
	].filter(Boolean);
	if (extras.length) console.log(pc.dim(`    ${extras.join("  •  ")}  — see \`tunnelvision inspector\``));
	printHints(unexplained);
}

/** The atom a change is reported at: its own path, or its atom's when it's a part. */
const unitOf = (c: { page: string; dir: string; role?: string; atom?: string }) => `${c.page}/${c.role === "part" && c.atom ? c.atom : c.dir}`;

/** Atoms and containers among `effects`, e.g. `3 atoms, 2 containers`. */
function units(effects: Effect[]): string {
	const atoms = new Set(effects.filter((e) => e.role !== "container").map(unitOf)).size;
	const containers = effects.filter((e) => e.role === "container").length;
	return [atoms ? plural(atoms, "atom") : "", containers ? plural(containers, "container") : ""].filter(Boolean).join(", ");
}

/**
 * What a cause changed, in atoms and the containers around them, with what it
 * only pushed or resized apart. Reports made before atoms existed count elements.
 */
export function unitCount(effects: Effect[]): string {
	if (effects.some((e) => !e.role)) return plural(effects.length, "element");
	const knockOn = effects.filter((e) => e.via === "knock-on");
	const direct = units(effects.filter((e) => e.via !== "knock-on"));
	if (!knockOn.length) return direct;
	return `${direct ? `${direct}; ` : ""}knock-on effects on ${units(knockOn)}`;
}

/** Unexplained visual changes in atoms, leaving out the elements around them that are downstream of them. */
export function unexplainedAtoms(unexplained: UnexplainedChange[]): number {
	return new Set(unexplained.filter((u) => !u.downstreamOf).map(unitOf)).size;
}

/**
 * How many unexplained visual changes there are, in atoms, not counting the
 * elements that only changed because an unexplained change inside them did.
 */
export function unexplainedSummary(unexplained: UnexplainedChange[]): string {
	if (!unexplained.length) return "";
	const roots = unexplainedAtoms(unexplained);
	const around = unexplained.filter((u) => u.downstreamOf).length;
	return `${plural(roots, "unexplained visual change")}${around ? ` (and ${plural(around, "element")} around them)` : ""}`;
}

const MAX_HINTS = 5;

/** The hints on unexplained visual changes, once each, the most common first. */
function printHints(unexplained: UnexplainedChange[]): void {
	const counts = new Map<string, number>();
	for (const u of unexplained) if (u.note) counts.set(u.note, (counts.get(u.note) ?? 0) + 1);
	const hints = [...counts].sort((a, b) => b[1] - a[1]);
	for (const [note, n] of hints.slice(0, MAX_HINTS)) console.log(pc.dim(`      hint${n > 1 ? ` (×${n})` : ""}: ${note}`));
	if (hints.length > MAX_HINTS) console.log(pc.dim(`      …and ${hints.length - MAX_HINTS} more hints`));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** New and removed elements with no cause, by render site. */
function printRenderSites(sites: RenderSite[]): void {
	if (!sites.length) return;
	console.log("");
	console.log(pc.bold("  New and removed elements"));
	let without = 0;
	for (const site of sites) {
		if (!site.path) {
			without += site.effects.filter((e) => e.via === "new" || e.via === "removed").length;
			continue;
		}
		const count = (via: string) => site.effects.filter((e) => e.via === via).length;
		const pages = new Set(site.effects.map((e) => e.page)).size;
		const what = [count("new") ? `${count("new")} new` : "", count("removed") ? `${count("removed")} removed` : ""].filter(Boolean).join(", ");
		const rest = [count("inside") ? `${count("inside")} inside them` : "", count("knock-on") ? plural(count("knock-on"), "knock-on effect") : ""].filter(Boolean);
		console.log(`    ${pc.cyan(`${site.path}:${site.line}${site.side === "LEFT" ? " (baseline)" : ""}`)}  ${pc.dim("render site")}`);
		console.log(pc.dim(`      → ${what} element${count("new") + count("removed") === 1 ? "" : "s"} on ${plural(pages, "page")}${rest.length ? `, ${rest.join(", ")}` : ""}`));
	}
	if (without) console.log(pc.dim(`    ${plural(without, "new or removed element")} without a render site`));
}

export function writeJsonReport(report: DiffReport, outPath: string): void {
	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
