import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { diffDir, versionDir } from "../paths.js";
import { diffVersions } from "../diffengine.js";
import { addCorrelation } from "../correlate.js";
import { latestExcluding } from "../versions.js";
import { printReport, writeJsonReport } from "../report.js";
import { notify } from "../notify.js";
import { findSandhog, sandhogLink } from "../sandhog.js";
import { logSource, prepareCapture, runCapture } from "./shoot.js";
const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));
/** Fail fast if the base URL is not reachable (mirrors shoot). */
async function assertReachable(baseUrl) {
    try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 5000);
        await fetch(baseUrl, { signal: controller.signal, redirect: "manual" }).finally(() => clearTimeout(t));
    }
    catch (err) {
        throw new Error(`Could not reach ${baseUrl} (${err.message}).\n` +
            "Start your app (or set the base URL with --base-url) and try again.");
    }
}
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === "EPERM";
    }
}
/**
 * Wait until no other review is running in this project, then hold the lock
 * until the returned function is called. Background reviews from quick
 * successive commits run one after another, each diffing against the last.
 */
async function lockReviews(paths) {
    const file = path.join(paths.dir, "review.lock");
    let waiting = false;
    for (;;) {
        try {
            fs.writeFileSync(file, String(process.pid), { flag: "wx" });
            return () => fs.rmSync(file, { force: true });
        }
        catch (err) {
            if (err.code !== "EEXIST")
                throw err;
        }
        let pid = NaN;
        try {
            pid = Number(fs.readFileSync(file, "utf8"));
        }
        catch {
            continue; // Released in the meantime.
        }
        if (!Number.isInteger(pid) || !isAlive(pid)) {
            // Left behind by a review that was killed.
            fs.rmSync(file, { force: true });
            continue;
        }
        if (!waiting) {
            console.log(pc.dim(`  waiting for another review (pid ${pid}) to finish…`));
            waiting = true;
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
}
export async function review(opts) {
    try {
        const outcome = await runReview(opts);
        if (opts.notify)
            notifyReviewed(outcome);
        return outcome.code;
    }
    catch (err) {
        if (opts.notify) {
            notify({
                title: "tunnelvision review failed",
                subtitle: path.basename(opts.root),
                body: err.message.split("\n")[0],
            });
        }
        throw err;
    }
}
async function runReview(opts) {
    const ctx = await prepareCapture(opts);
    await assertReachable(ctx.config.baseUrl);
    const release = await lockReviews(ctx.paths);
    try {
        return await reviewLocked(opts, ctx);
    }
    finally {
        release();
    }
}
async function reviewLocked(opts, ctx) {
    // Determine the baseline BEFORE capturing: the newest existing version that
    // isn't the current key (the current version may not exist on disk yet).
    const baseline = latestExcluding(ctx.paths, ctx.version.key);
    console.log(pc.bold(`Reviewing ${ctx.pages.length} pages`) + pc.dim(` → version ${ctx.version.key}`));
    logSource(ctx);
    if (ctx.version.dirty) {
        console.log(pc.yellow("  working tree is dirty; stored under a -dirty key"));
    }
    const capture = await runCapture(ctx);
    const result = {
        paths: ctx.paths,
        to: ctx.version.key,
        pageCount: ctx.pages.length,
        failedCount: capture.missing.length,
    };
    console.log(pc.green(`  ✓ ${capture.produced.length} captured`));
    if (capture.missing.length > 0) {
        console.log(pc.red(`  ✗ ${capture.missing.length} failed`));
        for (const m of capture.missing)
            console.log(pc.red(`      ${m}`));
    }
    if (!baseline) {
        console.log("");
        console.log(pc.cyan("  Baseline established — nothing to diff against yet."));
        console.log(pc.dim("  Run `review` again after your next change to see a diff."));
        return { ...result, code: capture.missing.length > 0 ? 1 : 0 };
    }
    const report = diffVersions(versionDir(ctx.paths, baseline.key), versionDir(ctx.paths, ctx.version.key), diffDir(ctx.paths, baseline.key, ctx.version.key), ctx.config, { from: baseline.key, to: ctx.version.key });
    addCorrelation(ctx.paths, report);
    printReport(report);
    if (report.hasChanges) {
        console.log(pc.dim(`  diff images: ${diffDir(ctx.paths, baseline.key, ctx.version.key)}`));
        console.log("");
    }
    if (opts.report) {
        if (opts.report === "-")
            console.log(JSON.stringify(report, null, 2));
        else
            writeJsonReport(report, opts.report);
    }
    else if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
    }
    // Non-zero if capture failed OR visual changes were detected.
    const code = capture.missing.length > 0 || report.hasChanges ? 1 : 0;
    return { ...result, code, diff: { from: baseline.key, report } };
}
function summarize(report) {
    if (!report.hasChanges)
        return "No visual changes";
    const counts = [
        report.changedCount && `${report.changedCount} changed`,
        report.addedCount && `${report.addedCount} added`,
        report.removedCount && `${report.removedCount} removed`,
    ].filter(Boolean);
    const causes = report.correlation?.causes.length;
    return `${counts.join(", ") || "Visual changes"}${causes ? `, traced to ${causes} changed line${causes === 1 ? "" : "s"}` : ""}`;
}
function notifyReviewed(outcome) {
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
    const actions = [
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
