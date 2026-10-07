import path from "node:path";
import type { FileChanges } from "./git.js";

/**
 * Bring source locations recorded at one revision up to date with another,
 * exactly or not at all (see docs/adr/0007-carry-over-unchanged-elements.md).
 *
 * A line outside every hunk just shifts by the lines added and deleted above
 * it. A line inside a hunk was deleted or rewritten; it still maps when its
 * exact text is on exactly one of the hunk's new lines (it moved, or an edit
 * around it rewrote the block), and otherwise doesn't map at all, so whatever
 * recorded it is captured again rather than guessed at.
 *
 * Paths are relative to the project root, as `SourceLoc` and `ComponentSource`
 * record them; `prefix` is the root's path inside the repository, whose paths
 * the diff uses.
 */
export class LineMapper {
	/** Changes keyed by each file's old path, in repository terms. */
	private readonly byOldPath = new Map<string, { newPath: string; changes: FileChanges }>();

	constructor(
		private readonly changes: Map<string, FileChanges>,
		private readonly prefix = "",
	) {
		for (const [newPath, c] of changes) {
			// A new file has no old lines to map, and mustn't shadow a file renamed away from its path.
			if (!c.created) this.byOldPath.set(c.oldPath, { newPath, changes: c });
		}
	}

	private repoPath(file: string): string | null {
		if (path.isAbsolute(file)) return null;
		const joined = path.posix.normalize(path.posix.join(this.prefix, file));
		return joined.startsWith("../") ? null : joined;
	}

	private projectPath(repoPath: string): string {
		return this.prefix ? path.posix.relative(this.prefix, repoPath) : repoPath;
	}

	/**
	 * Where `line` of `file` (at the old revision) is at the new one, or null
	 * when it can't be placed exactly. Files outside the repository (absolute
	 * paths, `../`) aren't tracked by the diff and map to themselves.
	 */
	map(file: string, line: number): { path: string; line: number } | null {
		const repo = this.repoPath(file);
		if (repo === null) return { path: file, line };
		const entry = this.byOldPath.get(repo);
		if (!entry) {
			// Unchanged, unless a different file now lives at this path (it was renamed away and replaced).
			return this.changes.has(repo) ? null : { path: file, line };
		}
		const { newPath, changes } = entry;
		const out = this.projectPath(newPath);
		let shift = 0;
		for (const h of changes.hunks) {
			if (h.oldCount > 0 && line >= h.oldStart && line < h.oldStart + h.oldCount) {
				const text = changes.deleted.get(line);
				if (text === undefined) return null;
				const hits: number[] = [];
				for (let n = h.newStart; n < h.newStart + h.newCount; n++) {
					if (changes.added.get(n) === text) hits.push(n);
				}
				return hits.length === 1 ? { path: out, line: hits[0] } : null;
			}
			const before = h.oldCount > 0 ? h.oldStart + h.oldCount - 1 < line : h.oldStart < line;
			if (before) shift += h.newCount - h.oldCount;
		}
		return { path: out, line: line + shift };
	}

	/** Whether `line` of `file` (at the new revision) is one the diff added. */
	added(file: string, line: number): boolean {
		const repo = this.repoPath(file);
		return repo !== null && Boolean(this.changes.get(repo)?.added.has(line));
	}

	/** Whether the diff touched `file` (at the new revision) at all. */
	touched(file: string): boolean {
		const repo = this.repoPath(file);
		return repo !== null && this.changes.has(repo);
	}
}
