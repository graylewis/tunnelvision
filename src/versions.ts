import fs from "node:fs";
import path from "node:path";
import { versionDir, type Paths } from "./paths.js";
import type { VersionInfo } from "./git.js";

export interface VersionMeta {
	key: string;
	capturedAt: string;
	fromGit: boolean;
	dirty: boolean;
	sha?: string;
	baseUrl: string;
	pageCount: number;
}

function metaPath(paths: Paths, key: string): string {
	return path.join(versionDir(paths, key), "meta.json");
}

export function writeMeta(paths: Paths, meta: VersionMeta): void {
	const dir = versionDir(paths, meta.key);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(metaPath(paths, meta.key), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

export function readMeta(paths: Paths, key: string): VersionMeta | null {
	try {
		return JSON.parse(fs.readFileSync(metaPath(paths, key), "utf8")) as VersionMeta;
	} catch {
		return null;
	}
}

/** All captured versions, ordered oldest -> newest by capture time. */
export function listVersions(paths: Paths): VersionMeta[] {
	let dirs: string[];
	try {
		dirs = fs
			.readdirSync(paths.versions, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
	} catch {
		return [];
	}
	const metas: VersionMeta[] = [];
	for (const key of dirs) {
		const meta = readMeta(paths, key);
		if (meta) {
			metas.push(meta);
		} else {
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
export function previousVersion(paths: Paths, key: string): VersionMeta | null {
	const all = listVersions(paths);
	const idx = all.findIndex((v) => v.key === key);
	if (idx <= 0) return null;
	return all[idx - 1];
}

/**
 * The most recent captured version that is NOT `key`. Used by `review` to pick a
 * baseline before the current version has been captured.
 */
export function latestExcluding(paths: Paths, key: string): VersionMeta | null {
	const all = listVersions(paths).filter((v) => v.key !== key);
	return all.length ? all[all.length - 1] : null;
}

export function versionExists(paths: Paths, key: string): boolean {
	return fs.existsSync(versionDir(paths, key));
}

export function metaFromInfo(
	info: VersionInfo,
	baseUrl: string,
	pageCount: number,
): VersionMeta {
	return {
		key: info.key,
		capturedAt: new Date().toISOString(),
		fromGit: info.fromGit,
		dirty: info.dirty,
		sha: info.sha,
		baseUrl,
		pageCount,
	};
}
