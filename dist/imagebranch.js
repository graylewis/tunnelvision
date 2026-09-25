import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
function git(cwd, args, env) {
    try {
        return execFileSync("git", args, {
            cwd,
            env: env ? { ...process.env, ...env } : process.env,
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf8",
        }).trim();
    }
    catch (err) {
        const stderr = err.stderr?.trim();
        throw new Error(`git ${args[0]} failed${stderr ? `: ${stderr}` : ""}`);
    }
}
/** The current tip of `branch` on `remote`, or null when the branch doesn't exist yet. */
function remoteTip(cwd, remote, branch) {
    const line = git(cwd, ["ls-remote", "--heads", remote, `refs/heads/${branch}`]);
    if (!line)
        return null;
    git(cwd, ["fetch", "--quiet", "--no-tags", remote, `refs/heads/${branch}`]);
    return line.split(/\s+/)[0];
}
/**
 * Commit `uploads` onto `branch` (creating it as an orphan if needed) and push
 * it to `remote`. Returns the new commit's SHA, which image URLs should pin to
 * so they keep working after later pushes.
 */
export function publishImages(cwd, remote, branch, uploads, message) {
    const parent = remoteTip(cwd, remote, branch);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tunnelvision-index-"));
    const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
    try {
        if (parent)
            git(cwd, ["read-tree", parent], env);
        else
            git(cwd, ["read-tree", "--empty"], env);
        for (const u of uploads) {
            const blob = git(cwd, ["hash-object", "-w", "--", u.file]);
            git(cwd, ["update-index", "--add", "--cacheinfo", `100644,${blob},${u.dest}`], env);
        }
        const tree = git(cwd, ["write-tree"], env);
        // Re-running with identical images needs no new commit.
        if (parent && git(cwd, ["rev-parse", `${parent}^{tree}`]) === tree)
            return parent;
        const commit = git(cwd, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]);
        git(cwd, ["push", "--quiet", remote, `${commit}:refs/heads/${branch}`]);
        return commit;
    }
    finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}
