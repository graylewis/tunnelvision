import { execFileSync } from "node:child_process";
function tryGit(root, args) {
    try {
        return execFileSync("git", args, {
            cwd: root,
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
        }).trim();
    }
    catch {
        return null;
    }
}
export function isGitRepo(root) {
    return tryGit(root, ["rev-parse", "--is-inside-work-tree"]) === "true";
}
/** SHA of a named revision (e.g. "HEAD", "HEAD~1"), short form, or null. */
export function shortSha(root, rev = "HEAD") {
    return tryGit(root, ["rev-parse", "--short", rev]);
}
export function isDirty(root) {
    const status = tryGit(root, ["status", "--porcelain"]);
    return status !== null && status.length > 0;
}
/** A safe key for the timestamp fallback, e.g. "ts-20240115-131502". */
function timestampKey() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, "0");
    return `ts-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
/**
 * Resolve the version key for a capture.
 * - In a git repo: short SHA, suffixed with "-dirty" when the tree is dirty.
 * - Outside a repo: a timestamp key.
 */
export function resolveVersion(root) {
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
export function parentSha(root) {
    return shortSha(root, "HEAD~1");
}
/** Absolute path of the repository's top-level directory, or null. */
export function topLevel(root) {
    return tryGit(root, ["rev-parse", "--show-toplevel"]);
}
/** The checked-out branch name, or null when detached. */
export function currentBranch(root) {
    const name = tryGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return name || null;
}
export function remoteUrl(root, remote) {
    return tryGit(root, ["remote", "get-url", remote]);
}
/** Short SHA of the best common ancestor of two revisions, or null. */
export function mergeBase(root, a, b) {
    const sha = tryGit(root, ["merge-base", a, b]);
    return sha ? shortSha(root, sha) : null;
}
