import path from "node:path";

/** The directory that holds all tunnelvision state, relative to a project root. */
export const DIR = ".tunnelvision";

export interface Paths {
	/** Project root (where .tunnelvision lives). */
	root: string;
	/** Absolute path to the .tunnelvision directory. */
	dir: string;
	config: string;
	auth: string;
	versions: string;
	diffs: string;
}

export function resolvePaths(root: string): Paths {
	const dir = path.join(root, DIR);
	return {
		root,
		dir,
		config: path.join(dir, "config.json"),
		auth: path.join(dir, "auth.json"),
		versions: path.join(dir, "versions"),
		diffs: path.join(dir, "diffs"),
	};
}

export function versionDir(paths: Paths, key: string): string {
	return path.join(paths.versions, key);
}

export function diffDir(paths: Paths, from: string, to: string): string {
	return path.join(paths.diffs, `${from}__${to}`);
}
