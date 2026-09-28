import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface VersionInfo {
	/** The storage key used under .tunnelvision/versions/. */
	key: string;
	/** True when derived from a git commit (vs a timestamp fallback). */
	fromGit: boolean;
	/** True when the working tree had uncommitted changes. */
	dirty: boolean;
	/** The raw short SHA when in a repo, else undefined. */
	sha?: string;
}

function tryGit(root: string, args: string[], env?: NodeJS.ProcessEnv): string | null {
	try {
		return execFileSync("git", args, {
			cwd: root,
			env: env ? { ...process.env, ...env } : undefined,
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
			maxBuffer: 256 * 1024 * 1024,
		}).trim();
	} catch {
		return null;
	}
}

export function isGitRepo(root: string): boolean {
	return tryGit(root, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

/** SHA of a named revision (e.g. "HEAD", "HEAD~1"), short form, or null. */
export function shortSha(root: string, rev = "HEAD"): string | null {
	return tryGit(root, ["rev-parse", "--short", rev]);
}

export function isDirty(root: string): boolean {
	const status = tryGit(root, ["status", "--porcelain"]);
	return status !== null && status.length > 0;
}

/** A safe key for the timestamp fallback, e.g. "ts-20240115-131502". */
function timestampKey(): string {
	const d = new Date();
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return `ts-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
		d.getMinutes(),
	)}${p(d.getSeconds())}`;
}

/**
 * Resolve the version key for a capture.
 * - In a git repo: short SHA, suffixed with "-dirty" when the tree is dirty.
 * - Outside a repo: a timestamp key.
 */
export function resolveVersion(root: string): VersionInfo {
	if (isGitRepo(root)) {
		const sha = shortSha(root) ?? "unknown";
		const dirty = isDirty(root);
		return {
			key: dirty ? `${sha}-dirty` : sha,
			fromGit: true,
			dirty,
			sha,
		};
	}
	return { key: timestampKey(), fromGit: false, dirty: false };
}

/** The short SHA of HEAD's first parent, if available. */
export function parentSha(root: string): string | null {
	return shortSha(root, "HEAD~1");
}

/** Absolute path of the repository's top-level directory, or null. */
export function topLevel(root: string): string | null {
	return tryGit(root, ["rev-parse", "--show-toplevel"]);
}

/** The checked-out branch name, or null when detached. */
export function currentBranch(root: string): string | null {
	const name = tryGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	return name || null;
}

export function remoteUrl(root: string, remote: string): string | null {
	return tryGit(root, ["remote", "get-url", remote]);
}

/** Short SHA of the best common ancestor of two revisions, or null. */
export function mergeBase(root: string, a: string, b: string): string | null {
	const sha = tryGit(root, ["merge-base", a, b]);
	return sha ? shortSha(root, sha) : null;
}

/** The ref that keeps a dirty capture's working-tree commit from being garbage-collected. */
export function snapshotRef(key: string): string {
	return `refs/tunnelvision/${key}`;
}

/**
 * A commit holding exactly the files a capture was taken from, so it can be
 * diffed later even after the working tree has moved on.
 *
 * A clean tree is just `HEAD`. A dirty one (including untracked, non-ignored
 * files) is written through a scratch index, so the real index and working
 * tree are never touched, and committed on top of `HEAD` under
 * `refs/tunnelvision/<key>`. Returns the full SHA, or null outside a repo.
 */
export function snapshotTree(root: string, key: string): string | null {
	const head = tryGit(root, ["rev-parse", "HEAD"]);
	if (!head) return null;
	if (!isDirty(root)) return head;

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tunnelvision-index-"));
	const env = { GIT_INDEX_FILE: path.join(dir, "index") };
	try {
		const top = topLevel(root) ?? root;
		if (tryGit(top, ["read-tree", "HEAD"], env) === null) return null;
		if (tryGit(top, ["add", "-A"], env) === null) return null;
		const tree = tryGit(top, ["write-tree"], env);
		if (!tree) return null;
		// An internal object: never signed, and committable without a configured identity.
		const commit = tryGit(top, ["commit-tree", "--no-gpg-sign", tree, "-p", head, "-m", `tunnelvision ${key}`], {
			GIT_AUTHOR_NAME: "tunnelvision",
			GIT_AUTHOR_EMAIL: "tunnelvision@localhost",
			GIT_COMMITTER_NAME: "tunnelvision",
			GIT_COMMITTER_EMAIL: "tunnelvision@localhost",
		});
		if (!commit) return null;
		tryGit(top, ["update-ref", snapshotRef(key), commit]);
		return commit;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Delete a capture's snapshot ref, if it has one. */
export function deleteSnapshotRef(root: string, key: string): void {
	tryGit(root, ["update-ref", "-d", snapshotRef(key)]);
}

/** Lines a diff changed in one file, on each side. */
export interface FileChanges {
	/** The file's path before the change (differs from its key on renames). */
	oldPath: string;
	/** 1-based line numbers added in the new version. */
	added: Set<number>;
	/** 1-based line numbers deleted from the old version. */
	deleted: Set<number>;
}

/** Strip git's `a/` / `b/` prefix, or return null for `/dev/null`. */
function diffPath(raw: string, prefix: string): string | null {
	const p = raw.replace(/\t.*$/, "").replace(/^"(.*)"$/, "$1");
	if (p === "/dev/null") return null;
	return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/**
 * Parse a unified diff (any context size) into the lines it changed, keyed by
 * each file's new path. Deleted files are keyed by their old path.
 */
export function parseUnifiedDiff(text: string): Map<string, FileChanges> {
	const out = new Map<string, FileChanges>();
	let oldPath: string | null = null;
	let newPath: string | null = null;
	let current: FileChanges | null = null;
	let oldLine = 0;
	let newLine = 0;

	const open = (): FileChanges | null => {
		const key = newPath ?? oldPath;
		if (!key) return null;
		const changes = out.get(key) ?? { oldPath: oldPath ?? key, added: new Set<number>(), deleted: new Set<number>() };
		out.set(key, changes);
		return changes;
	};

	// Lines still owed to the current hunk, so content like "+++ x" or "-- x"
	// is never mistaken for a file header.
	let oldLeft = 0;
	let newLeft = 0;

	for (const line of text.split("\n")) {
		if (current && (oldLeft > 0 || newLeft > 0)) {
			if (line.startsWith("+")) {
				current.added.add(newLine++);
				newLeft--;
			} else if (line.startsWith("-")) {
				current.deleted.add(oldLine++);
				oldLeft--;
			} else if (line.startsWith(" ")) {
				oldLine++;
				newLine++;
				oldLeft--;
				newLeft--;
			}
			// "\ No newline at end of file" carries no line.
			continue;
		}
		const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
		if (hunk) {
			current ??= open();
			oldLine = Number(hunk[1]);
			oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
			newLine = Number(hunk[3]);
			newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
			continue;
		}
		if (line.startsWith("diff --git ")) {
			const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
			oldPath = m ? m[1] : null;
			newPath = m ? m[2] : null;
			current = null;
		} else if (line.startsWith("--- ")) {
			oldPath = diffPath(line.slice(4), "a/");
		} else if (line.startsWith("+++ ")) {
			newPath = diffPath(line.slice(4), "b/");
			current = open();
		} else if (line.startsWith("rename from ")) {
			oldPath = line.slice("rename from ".length);
		} else if (line.startsWith("rename to ")) {
			newPath = line.slice("rename to ".length);
			current = open();
		}
	}
	return out;
}

/**
 * Lines changed between two revisions, keyed by path relative to the
 * repository's top level. Renames are detected, so a moved file keeps its
 * unchanged lines out of the result. Null when git can't diff them.
 */
export function changedLines(root: string, fromRev: string, toRev: string): Map<string, FileChanges> | null {
	const text = tryGit(root, ["diff", "-U0", "-M", "--no-color", "--no-ext-diff", fromRev, toRev, "--"]);
	return text === null ? null : parseUnifiedDiff(text);
}
