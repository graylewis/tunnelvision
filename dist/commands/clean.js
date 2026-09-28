import fs from "node:fs";
import pc from "picocolors";
import { resolvePaths, versionDir } from "../paths.js";
import { deleteSnapshotRef } from "../git.js";
import { listVersions } from "../versions.js";
function rm(target) {
    fs.rmSync(target, { recursive: true, force: true });
}
export async function clean(opts) {
    const paths = resolvePaths(opts.root);
    if (opts.all) {
        for (const v of listVersions(paths))
            deleteSnapshotRef(paths.root, v.key);
        rm(paths.versions);
        rm(paths.diffs);
        console.log(pc.green("✓ removed all versions and diffs"));
        return 0;
    }
    if (opts.diffsOnly) {
        rm(paths.diffs);
        console.log(pc.green("✓ removed all diff outputs"));
        return 0;
    }
    if (opts.keep !== undefined) {
        if (!Number.isInteger(opts.keep) || opts.keep < 0) {
            console.error(pc.red("--keep must be a non-negative integer."));
            return 1;
        }
        const versions = listVersions(paths); // oldest -> newest
        const toRemove = versions.slice(0, Math.max(0, versions.length - opts.keep));
        for (const v of toRemove) {
            rm(versionDir(paths, v.key));
            deleteSnapshotRef(paths.root, v.key);
        }
        console.log(pc.green(`✓ kept ${Math.min(opts.keep, versions.length)} newest, removed ${toRemove.length} version(s)`));
        return 0;
    }
    console.log(pc.yellow("Nothing to do. Pass --keep <n>, --diffs, or --all."));
    return 0;
}
