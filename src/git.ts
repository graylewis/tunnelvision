import { execFileSync } from "node:child_process";

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

function tryGit(root: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, {
			cwd: root,
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
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
