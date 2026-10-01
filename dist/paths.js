import fs from "node:fs";
import path from "node:path";
/** The directory that holds tunnelvision's local state (captures, diffs, auth), relative to a project root. */
export const DIR = ".tunnelvision";
/** The config file, at the project root so it's committed with the project. */
export const CONFIG_FILE = "tunnelvision.json";
export function resolvePaths(root) {
    const dir = path.join(root, DIR);
    return {
        root,
        dir,
        config: path.join(root, CONFIG_FILE),
        legacyConfig: path.join(dir, "config.json"),
        auth: path.join(dir, "auth.json"),
        versions: path.join(dir, "versions"),
        diffs: path.join(dir, "diffs"),
    };
}
/** The config file that exists: `tunnelvision.json`, else the legacy `.tunnelvision/config.json`, else null. */
export function existingConfig(paths) {
    if (fs.existsSync(paths.config))
        return paths.config;
    if (fs.existsSync(paths.legacyConfig))
        return paths.legacyConfig;
    return null;
}
export function versionDir(paths, key) {
    return path.join(paths.versions, key);
}
export function diffDir(paths, from, to) {
    return path.join(paths.diffs, `${from}__${to}`);
}
