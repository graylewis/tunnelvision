import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Publish images to a dedicated orphan branch (no shared history with the
 * project) so PR comments can link to them.
 *
 * Everything goes through git plumbing and a throwaway index file: blobs are
 * hashed straight into the object store, a tree and commit are built on top of
 * the branch's current tip, and the commit is pushed. The user's checkout,
 * index and current branch are never touched.
 */

export interface ImageUpload {
	/** Absolute path of the PNG on disk. */
	file: string;
	/** POSIX path to store it at on the branch. */
	dest: string;
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
	try {
		return execFileSync("git", args, {
			cwd,
			env: env ? { ...process.env, ...env } : process.env,
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
		}).trim();
	} catch (err) {
		const stderr = (err as { stderr?: string }).stderr?.trim();
		throw new Error(`git ${args[0]} failed${stderr ? `: ${stderr}` : ""}`);
	}
}

/** The current tip of `branch` on `remote`, or null when the branch doesn't exist yet. */
function remoteTip(cwd: string, remote: string, branch: string): string | null {
	const line = git(cwd, ["ls-remote", "--heads", remote, `refs/heads/${branch}`]);
	if (!line) return null;
	git(cwd, ["fetch", "--quiet", "--no-tags", remote, `refs/heads/${branch}`]);
	return line.split(/\s+/)[0];
}

/**
 * Commit `uploads` onto `branch` (creating it as an orphan if needed) and push
 * it to `remote`. Returns the new commit's SHA, which image URLs should pin to
 * so they keep working after later pushes.
 */
export function publishImages(
	cwd: string,
	remote: string,
	branch: string,
	uploads: ImageUpload[],
	message: string,
): string {
	const parent = remoteTip(cwd, remote, branch);
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tunnelvision-index-"));
	const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
	try {
		if (parent) git(cwd, ["read-tree", parent], env);
		else git(cwd, ["read-tree", "--empty"], env);

		for (const u of uploads) {
			const blob = git(cwd, ["hash-object", "-w", "--", u.file]);
			git(cwd, ["update-index", "--add", "--cacheinfo", `100644,${blob},${u.dest}`], env);
		}
		const tree = git(cwd, ["write-tree"], env);
		// Re-running with identical images needs no new commit.
		if (parent && git(cwd, ["rev-parse", `${parent}^{tree}`]) === tree) return parent;
		const commit = git(cwd, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]);
		git(cwd, ["push", "--quiet", remote, `${commit}:refs/heads/${branch}`]);
		return commit;
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}
