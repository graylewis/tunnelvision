import fs from "node:fs";
import path from "node:path";
import { versionDir } from "./paths.js";
function metaPath(paths, key) {
    return path.join(versionDir(paths, key), "meta.json");
}
export function writeMeta(paths, meta) {
    const dir = versionDir(paths, meta.key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(metaPath(paths, meta.key), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}
export function readMeta(paths, key) {
    try {
        return JSON.parse(fs.readFileSync(metaPath(paths, key), "utf8"));
    }
    catch {
        return null;
    }
}
/** All captured versions, ordered oldest -> newest by capture time. */
export function listVersions(paths) {
    let dirs;
    try {
        dirs = fs
            .readdirSync(paths.versions, { withFileTypes: true })
            // Dot-directories are captures still being written (see `shoot.ts`).
            .filter((d) => d.isDirectory() && !d.name.startsWith("."))
            .map((d) => d.name);
    }
    catch {
        return [];
    }
    const metas = [];
    for (const key of dirs) {
        const meta = readMeta(paths, key);
        if (meta) {
            // The directory name is the key: a renamed capture keeps its old key in meta.json.
            metas.push({ ...meta, key });
        }
        else {
            // Fall back to directory mtime if meta is missing.
            const stat = fs.statSync(versionDir(paths, key));
            metas.push({
                key,
                capturedAt: stat.mtime.toISOString(),
                fromGit: false,
                dirty: key.endsWith("-dirty"),
                baseUrl: "",
                pageCount: fs.readdirSync(versionDir(paths, key)).filter((f) => f.endsWith(".png")).length,
            });
        }
    }
    metas.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    return metas;
}
/** The version captured immediately before `key`, or null. Requires `key` to exist. */
export function previousVersion(paths, key) {
    const all = listVersions(paths);
    const idx = all.findIndex((v) => v.key === key);
    if (idx <= 0)
        return null;
    return all[idx - 1];
}
/**
 * The most recent captured version that is NOT `key`. Used by `review` to pick a
 * baseline before the current version has been captured.
 */
export function latestExcluding(paths, key) {
    const all = listVersions(paths).filter((v) => v.key !== key);
    return all.length ? all[all.length - 1] : null;
}
export function versionExists(paths, key) {
    return fs.existsSync(versionDir(paths, key));
}
export function metaFromInfo(info, baseUrl, pageCount, rev) {
    return {
        key: info.key,
        capturedAt: new Date().toISOString(),
        fromGit: info.fromGit,
        dirty: info.dirty,
        sha: info.sha,
        ...(rev ? { rev } : {}),
        baseUrl,
        pageCount,
    };
}
/**
 * The revision a version's files can be read or diffed at: its snapshot, or
 * its commit when it was captured from a clean tree. Null when the captured
 * files can't be recovered (an old dirty capture, or one made outside git).
 */
export function versionRev(meta) {
    if (meta.rev)
        return meta.rev;
    if (meta.fromGit && !meta.dirty && meta.sha)
        return meta.sha;
    return null;
}
