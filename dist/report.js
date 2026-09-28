import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
const STATUS_STYLE = {
    unchanged: (s) => pc.dim(s),
    changed: (s) => pc.yellow(s),
    added: (s) => pc.green(s),
    removed: (s) => pc.red(s),
    "size-mismatch": (s) => pc.magenta(s),
    error: (s) => pc.red(s),
};
const STATUS_LABEL = {
    unchanged: "unchanged",
    changed: "CHANGED",
    added: "added",
    removed: "removed",
    "size-mismatch": "size!",
    error: "error",
};
export function printReport(report) {
    console.log("");
    console.log(pc.bold(`Diff  ${report.from}  ->  ${report.to}`));
    console.log("");
    const rows = report.pages.filter((p) => p.status !== "unchanged");
    if (rows.length === 0) {
        console.log(pc.green("  No visual changes detected."));
    }
    else {
        for (const p of report.pages) {
            if (p.status === "unchanged")
                continue;
            const style = STATUS_STYLE[p.status];
            const label = style(STATUS_LABEL[p.status].padEnd(9));
            let detail = "";
            if (p.diffPercent !== undefined)
                detail = pc.dim(`${p.diffPercent.toFixed(3)}%`);
            else if (p.message)
                detail = pc.dim(p.message);
            console.log(`  ${label} ${p.filename}  ${detail}`);
            if (p.diffImage)
                console.log(pc.dim(`            diff: ${p.diffImage}`));
            if (p.fromFilename) {
                const how = p.matchedBy ? ` by ${p.matchedBy.replace(/^attr:/, "")}` : "";
                console.log(pc.dim(`            ${p.moved ? "moved from" : "was"} ${p.fromFilename} (matched${how})`));
            }
        }
    }
    if (report.correlation)
        printCorrelation(report.correlation);
    else if (report.correlationSkipped && report.hasChanges) {
        console.log("");
        console.log(pc.dim(`  Causes not traced: ${report.correlationSkipped}.`));
    }
    const unchanged = report.pages.filter((p) => p.status === "unchanged").length;
    console.log("");
    console.log(pc.dim(`  ${report.pages.length} pages  •  ${report.changedCount} changed  •  ` +
        `${report.addedCount} added  •  ${report.removedCount} removed  •  ${unchanged} unchanged`));
    console.log("");
}
const MAX_PROPS = 3;
/** Changed lines and the visual changes they caused. */
function printCorrelation(c) {
    const { causes, unexplained, invisible, withoutStyles } = c;
    if (causes.length === 0 && unexplained.length === 0 && invisible.length === 0)
        return;
    console.log("");
    console.log(pc.bold("  Causes"));
    if (causes.length === 0)
        console.log(pc.dim("    No changed line explains a visual change."));
    for (const cause of causes) {
        const where = `${cause.path}:${cause.line}${cause.side === "LEFT" ? " (deleted)" : ""}`;
        const n = cause.effects.length;
        // Only properties whose declaration changed; the rest are results of layout.
        const props = [...new Set(cause.effects.flatMap((e) => e.props.filter((p) => p.own).map((p) => p.name)))];
        const propText = props.length ? `  ${props.slice(0, MAX_PROPS).join(", ")}${props.length > MAX_PROPS ? ", …" : ""}` : "";
        console.log(`    ${pc.cyan(where)}  ${pc.dim(cause.text ?? cause.kind)}`);
        console.log(pc.dim(`      → ${n} element${n === 1 ? "" : "s"}${propText}`));
    }
    const notExercised = invisible.filter((i) => i.reason === "not-exercised").length;
    const extras = [
        unexplained.length ? `${unexplained.length} unexplained visual change${unexplained.length === 1 ? "" : "s"}` : "",
        invisible.length
            ? `${invisible.length} CSS line${invisible.length === 1 ? "" : "s"} with no visible effect` +
                (notExercised ? ` (${notExercised} not exercised)` : "")
            : "",
        withoutStyles.length ? `${withoutStyles.length} page(s) without style data (re-capture to trace CSS)` : "",
    ].filter(Boolean);
    if (extras.length)
        console.log(pc.dim(`    ${extras.join("  •  ")}  — see \`tunnelvision inspector\``));
}
export function writeJsonReport(report, outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
