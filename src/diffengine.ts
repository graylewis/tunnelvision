import fs from "node:fs";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { Config } from "./config.js";

export type PageStatus = "unchanged" | "changed" | "added" | "removed" | "size-mismatch" | "error";

export interface PageDiff {
	filename: string;
	status: PageStatus;
	/** Percentage of mismatched pixels (0-100), when a pixel diff ran. */
	diffPercent?: number;
	mismatchedPixels?: number;
	totalPixels?: number;
	/** Path to the written diff image, when produced. */
	diffImage?: string;
	message?: string;
}

export interface DiffReport {
	from: string;
	to: string;
	pages: PageDiff[];
	changedCount: number;
	addedCount: number;
	removedCount: number;
	/** True if anything counts as a change for exit-code purposes. */
	hasChanges: boolean;
}

/**
 * All PNGs under `dir`, returned as POSIX-style paths relative to `dir`.
 * Recurses so per-element hierarchies (`--by-element`) diff the same way flat
 * page captures do.
 */
function listPngs(dir: string): Set<string> {
	const out = new Set<string>();
	const walk = (cur: string, rel: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(cur, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const abs = path.join(cur, e.name);
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(abs, r);
			else if (e.name.toLowerCase().endsWith(".png")) out.add(r);
		}
	};
	walk(dir, "");
	return out;
}

function readPng(file: string): PNG {
	return PNG.sync.read(fs.readFileSync(file));
}

/**
 * Diff two version directories.
 * - Only files present in both are pixel-diffed.
 * - Files unique to one side are reported as added/removed and count as changes.
 * - Pages whose dimensions differ are reported as size-mismatch (a change).
 */
export function diffVersions(
	fromDir: string,
	toDir: string,
	outDir: string,
	config: Config,
	labels: { from: string; to: string },
): DiffReport {
	const fromFiles = listPngs(fromDir);
	const toFiles = listPngs(toDir);
	const all = [...new Set([...fromFiles, ...toFiles])].sort();

	const pages: PageDiff[] = [];
	fs.mkdirSync(outDir, { recursive: true });

	for (const filename of all) {
		const inFrom = fromFiles.has(filename);
		const inTo = toFiles.has(filename);

		if (inFrom && !inTo) {
			pages.push({ filename, status: "removed", message: "present in baseline only" });
			continue;
		}
		if (!inFrom && inTo) {
			pages.push({ filename, status: "added", message: "new page" });
			continue;
		}

		// Present in both -> pixel diff.
		try {
			const a = readPng(path.join(fromDir, ...filename.split("/")));
			const b = readPng(path.join(toDir, ...filename.split("/")));
			if (a.width !== b.width || a.height !== b.height) {
				pages.push({
					filename,
					status: "size-mismatch",
					message: `dimensions differ (${a.width}x${a.height} vs ${b.width}x${b.height})`,
				});
				continue;
			}

			const { width, height } = a;
			const diff = new PNG({ width, height });
			const mismatched = pixelmatch(a.data, b.data, diff.data, width, height, {
				threshold: config.diff.threshold,
				includeAA: config.diff.includeAA,
			});
			const total = width * height;
			const percent = total === 0 ? 0 : (mismatched / total) * 100;

			const override = perPageCutoff(filename, config);
			const cutoff = override ?? config.diff.maxDiffPercent;
			const changed = percent > cutoff;

			let diffImage: string | undefined;
			if (changed) {
				diffImage = path.join(outDir, ...filename.split("/"));
				fs.mkdirSync(path.dirname(diffImage), { recursive: true });
				fs.writeFileSync(diffImage, PNG.sync.write(diff));
			}

			pages.push({
				filename,
				status: changed ? "changed" : "unchanged",
				diffPercent: percent,
				mismatchedPixels: mismatched,
				totalPixels: total,
				diffImage,
			});
		} catch (err) {
			pages.push({ filename, status: "error", message: (err as Error).message });
		}
	}

	const changedCount = pages.filter(
		(p) => p.status === "changed" || p.status === "size-mismatch" || p.status === "error",
	).length;
	const addedCount = pages.filter((p) => p.status === "added").length;
	const removedCount = pages.filter((p) => p.status === "removed").length;

	return {
		from: labels.from,
		to: labels.to,
		pages,
		changedCount,
		addedCount,
		removedCount,
		hasChanges: changedCount + addedCount + removedCount > 0,
	};
}

/** Find a per-page maxDiffPercent override by matching the filename's page path. */
function perPageCutoff(filename: string, config: Config): number | undefined {
	if (!config.pages) return undefined;
	// filename is a slug; overrides are keyed by path. We can't perfectly reverse
	// a slug, so overrides only apply when the caller also stored the mapping.
	// For now, no reverse lookup; return undefined. (Extension point.)
	return undefined;
}
