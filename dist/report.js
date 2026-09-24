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
    const unchanged = report.pages.filter((p) => p.status === "unchanged").length;
    console.log("");
    console.log(pc.dim(`  ${report.pages.length} pages  •  ${report.changedCount} changed  •  ` +
        `${report.addedCount} added  •  ${report.removedCount} removed  •  ${unchanged} unchanged`));
    console.log("");
}
export function writeJsonReport(report, outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
