import path from "node:path";
/** The directory that holds all tunnelvision state, relative to a project root. */
export const DIR = ".tunnelvision";
export function resolvePaths(root) {
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
export function versionDir(paths, key) {
    return path.join(paths.versions, key);
}
export function diffDir(paths, from, to) {
    return path.join(paths.diffs, `${from}__${to}`);
}
