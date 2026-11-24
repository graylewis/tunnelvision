import path from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import prompts from "prompts";
import { applyOverrides, loadConfig, type Overrides } from "../config.js";
import { diffDir, resolvePaths, versionDir, type Paths } from "../paths.js";
import { diffVersions, type DiffReport } from "../diffengine.js";
import { addCorrelation, versionMapper } from "../correlate.js";
import { latestExcluding, listVersions, serverModeOf, versionRev, type VersionMeta } from "../versions.js";
import { resolveVersion } from "../git.js";
import { planServer } from "../server.js";
import type { RunResult } from "../playwright.js";
import { printReport, writeJsonReport } from "../report.js";
import { notify, type NotificationAction } from "../notify.js";
import { findSandhog, sandhogLink } from "../sandhog.js";
import { logReused, logSource, runCapture, shoot, withServedApp, type CaptureContext } from "./shoot.js";

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

export interface ReviewOptions extends Overrides {
	root: string;
	report?: string;
	json?: boolean;
	/** Send a desktop notification when the review finishes or fails. */
	notify?: boolean;
	/** Capture even when the code is the same as the latest Version's. */
	force?: boolean;
	/** Recapture a baseline taken from a running server through tunnelvision's own first. */
	rebaseline?: boolean;
}

interface Outcome {
	code: number;
	paths: Paths;
	to: string;
	pageCount: number;
	failedCount: number;
	/** Absent when this review established the baseline. */
	diff?: { from: string; report: DiffReport };
}

export async function review(opts: ReviewOptions): Promise<number> {
	try {
		const outcome = await runReview(opts);
		if (opts.notify) notifyReviewed(outcome);
		return outcome.code;
	} catch (err) {
		if (opts.notify) {
			notify({
				title: "tunnelvision review failed",
				subtitle: path.basename(opts.root),
				body: (err as Error).message.split("\n")[0],
			});
		}
		throw err;
	}
}

async function runReview(opts: ReviewOptions): Promise<Outcome> {
	await maybeRebaseline(opts);
	let baseline: VersionMeta | null = null;
	const run = await withServedApp(opts, (ctx) => runCapture(ctx), (ctx) => {
		// The baseline is decided BEFORE capturing: the newest existing version that
		// isn't the current key (the current version may not exist on disk yet).
		baseline = latestExcluding(ctx.paths, ctx.version.key);
		console.log(pc.bold(`Reviewing ${ctx.pages.length} pages`) + pc.dim(` → version ${ctx.version.key}`));
		logSource(ctx);
		if (ctx.version.dirty) {
			console.log(pc.yellow("  working tree is dirty; stored under a -dirty key"));
		}
		if (baseline && serverModeOf(baseline) !== ctx.serve.mode) {
			const how = (mode: string) => (mode === "owned" ? "tunnelvision's own dev server" : "a running server");
			console.log(
				pc.yellow(
					`  ${baseline.key} was captured from ${how(serverModeOf(baseline))} and this one is from ${how(ctx.serve.mode)}: ` +
						"differences between the two show as visual changes",
				),
			);
			if (ctx.serve.mode === "owned" && versionRev(baseline)) {
				console.log(pc.dim(`  recapture it the same way with \`tunnelvision shoot --at ${baseline.key}\`, or review with --rebaseline`));
			}
		}
	});
	const { ctx } = run;
	let capture: RunResult;
	if ("reused" in run) {
		logReused(ctx, run.reused);
		capture = { produced: [], missing: [], exitCode: 0 };
		// Copied under a new key: diff against what the copied Version was diffed against.
		const from = baseline as VersionMeta | null;
		if (run.reused.key !== ctx.version.key && from?.key === run.reused.key) {
			const keys = new Set([run.reused.key, ctx.version.key]);
			baseline = listVersions(ctx.paths).filter((v) => !keys.has(v.key)).at(-1) ?? null;
		}
	} else {
		capture = run.result;
		console.log(pc.green(`  ✓ ${capture.produced.length} captured`));
		if (capture.missing.length > 0) {
			console.log(pc.red(`  ✗ ${capture.missing.length} failed`));
			for (const m of capture.missing) console.log(pc.red(`      ${m}`));
		}
	}
	return diffAndReport(opts, ctx, baseline, capture);
}

/**
 * Recapture the baseline through tunnelvision's own dev server when it was
 * captured from a running one, so the switch itself doesn't show as visual
 * changes: with --rebaseline, or when asked in a terminal.
 */
async function maybeRebaseline(opts: ReviewOptions): Promise<void> {
	const paths = resolvePaths(opts.root);
	const config = applyOverrides(loadConfig(paths), opts);
	if (planServer(opts.root, config).mode !== "owned") return;
	const baseline = latestExcluding(paths, resolveVersion(opts.root).key);
	if (!baseline || serverModeOf(baseline) === "owned" || !versionRev(baseline)) return;
	let yes = Boolean(opts.rebaseline);
	if (!yes && process.stdin.isTTY && process.stdout.isTTY && !opts.json && opts.report !== "-") {
		const answer = await prompts({
			type: "confirm",
			name: "yes",
			message: `${baseline.key} was captured from a running server; recapture it with tunnelvision's own dev server first, so the switch doesn't show as changes?`,
			initial: true,
		});
		yes = Boolean(answer.yes);
	}
	if (!yes) return;
	const code = await shoot({ ...opts, at: baseline.key });
	if (code !== 0) throw new Error(`Recapturing ${baseline.key} failed.`);
	console.log("");
}

async function diffAndReport(opts: ReviewOptions, ctx: CaptureContext, baseline: VersionMeta | null, capture: RunResult): Promise<Outcome> {
	const result = {
		paths: ctx.paths,
		to: ctx.version.key,
		pageCount: ctx.pages.length,
		failedCount: capture.missing.length,
	};

	if (!baseline) {
		console.log("");
		console.log(pc.cyan("  Baseline established — nothing to diff against yet."));
		console.log(pc.dim("  Run `review` again after your next change to see a diff."));
		return { ...result, code: capture.missing.length > 0 ? 1 : 0 };
	}

	const report = diffVersions(
		versionDir(ctx.paths, baseline.key),
		versionDir(ctx.paths, ctx.version.key),
		diffDir(ctx.paths, baseline.key, ctx.version.key),
		ctx.config,
		{ from: baseline.key, to: ctx.version.key },
		versionMapper(ctx.paths, baseline.key, ctx.version.key),
	);
	addCorrelation(ctx.paths, report, ctx.config.atoms);

	printReport(report);
	if (report.hasChanges) {
		console.log(pc.dim(`  diff images: ${diffDir(ctx.paths, baseline.key, ctx.version.key)}`));
		console.log("");
	}

	if (opts.report) {
		if (opts.report === "-") console.log(JSON.stringify(report, null, 2));
		else writeJsonReport(report, opts.report);
	} else if (opts.json) {
		console.log(JSON.stringify(report, null, 2));
	}

	// Non-zero if capture failed OR visual changes were detected.
	const code = capture.missing.length > 0 || report.hasChanges ? 1 : 0;
	return { ...result, code, diff: { from: baseline.key, report } };
}

function summarize(report: DiffReport): string {
	if (!report.hasChanges) return "No visual changes";
	const counts = [
		report.changedCount && `${report.changedCount} changed`,
		report.addedCount && `${report.addedCount} added`,
		report.removedCount && `${report.removedCount} removed`,
	].filter(Boolean);
	const causes = report.correlation?.causes.length;
	return `${counts.join(", ") || "Visual changes"}${causes ? `, traced to ${causes} changed line${causes === 1 ? "" : "s"}` : ""}`;
}

function notifyReviewed(outcome: Outcome): void {
	const project = path.basename(outcome.paths.root);
	const failed = outcome.failedCount
		? ` ${outcome.failedCount} element${outcome.failedCount === 1 ? "" : "s"} failed to capture.`
		: "";
	if (!outcome.diff) {
		notify({
			title: `tunnelvision · ${project}`,
			subtitle: `Baseline captured at ${outcome.to}`,
			body: `${outcome.pageCount} pages captured; the next review diffs against them.${failed}`,
		});
		return;
	}
	const { from, report } = outcome.diff;
	const root = outcome.paths.root;
	const actions: NotificationAction[] = [
		{
			id: "inspector",
			title: "Open in inspector",
			argv: [process.execPath, CLI, "inspector", "--open", "--from", from, "--to", outcome.to],
			cwd: root,
			log: path.join(outcome.paths.dir, "inspector.log"),
		},
	];
	if (findSandhog()) {
		actions.push({ id: "sandhog", title: "Open in sandhog", argv: ["/usr/bin/open", sandhogLink(root, from, outcome.to)] });
	}
	notify({
		title: `tunnelvision · ${project}`,
		subtitle: `${from} → ${outcome.to}`,
		body: `${summarize(report)}.${failed}`,
		actions,
	});
}
