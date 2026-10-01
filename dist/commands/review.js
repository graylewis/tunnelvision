import pc from "picocolors";
import { diffDir, versionDir } from "../paths.js";
import { diffVersions } from "../diffengine.js";
import { addCorrelation } from "../correlate.js";
import { latestExcluding } from "../versions.js";
import { printReport, writeJsonReport } from "../report.js";
import { logSource, prepareCapture, runCapture } from "./shoot.js";
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
export async function review(opts) {
    const ctx = await prepareCapture(opts);
    await assertReachable(ctx.config.baseUrl);
    // Determine the baseline BEFORE capturing: the newest existing version that
    // isn't the current key (the current version may not exist on disk yet).
    const baseline = latestExcluding(ctx.paths, ctx.version.key);
    console.log(pc.bold(`Reviewing ${ctx.pages.length} pages`) + pc.dim(` → version ${ctx.version.key}`));
    logSource(ctx);
    if (ctx.version.dirty) {
        console.log(pc.yellow("  working tree is dirty; stored under a -dirty key"));
    }
    const capture = await runCapture(ctx);
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
        return capture.missing.length > 0 ? 1 : 0;
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
    if (capture.missing.length > 0 || report.hasChanges)
        return 1;
    return 0;
}
