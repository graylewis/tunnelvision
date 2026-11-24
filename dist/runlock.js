import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
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
 * Wait until no other capture is running in this project, then hold the lock
 * until the returned function is called. Captures share one snapshot worktree
 * and one dev server port, so they run one at a time. A capture snapshots the
 * working tree only once it holds the lock, so a run that waited captures the
 * code as it is when its turn comes, and a run whose code an earlier one
 * already captured reuses that Version (see `reuseUnchanged` in `shoot.ts`):
 * a burst of runs captures only the newest code.
 */
export async function lockRuns(paths) {
    fs.mkdirSync(paths.dir, { recursive: true });
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
            // Left behind by a run that was killed.
            fs.rmSync(file, { force: true });
            continue;
        }
        if (!waiting) {
            console.log(pc.dim(`  waiting for another capture (pid ${pid}) to finish…`));
            waiting = true;
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
}
