import fs from "node:fs";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { Config } from "./config.js";
import {
	cropImage,
	cropRect,
	ELEMENT_IMAGE,
	ELEMENT_MANIFEST,
	PAGE_IMAGE,
	readElementManifest,
	type ElementManifest,
	type ElementNode,
} from "./elements.js";
import type { Correlation } from "./correlate.js";
import { matchElements, matchOptions, type ElementMatch, type MatchedBy } from "./matching.js";

export type PageStatus = "unchanged" | "changed" | "added" | "removed" | "size-mismatch" | "error";

export interface PageDiff {
	/** Relative path of the image: the target's, or the baseline's when removed. */
	filename: string;
	/** The baseline's path, when an element was matched at a different path. */
	fromFilename?: string;
	/** Which identifier paired a per-element screenshot with its baseline. */
	matchedBy?: MatchedBy;
	/** The element's baseline partner sits under a different parent. */
	moved?: boolean;
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
	/**
	 * Per-element pages keyed by slug: both manifests and how their elements
	 * were paired. Non-enumerable, so it stays out of JSON reports.
	 */
	pairs?: Map<string, PagePairs>;
	/** Which changed lines caused which visual changes (see `correlate.ts`), when it could be worked out. */
	correlation?: Correlation;
	/** Why there's no `correlation`. */
	correlationSkipped?: string;
}

/** A per-element page captured in both versions, and how its elements were paired. */
export interface PagePairs {
	from: ElementManifest;
	to: ElementManifest;
	match: ElementMatch;
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

function tryReadPng(file: string): PNG | null {
	try {
		return readPng(file);
	} catch {
		return null;
	}
}

/** A page's element tree and screenshot, from which its element images are cropped. */
interface ElementPage {
	manifest: ElementManifest;
	page: PNG | null;
}

/** Crop `node` out of its page screenshot, or null when it has no image. */
function cropNode({ manifest, page }: ElementPage, node: ElementNode): PNG | null {
	const rect = page && cropRect(page, node.box, manifest.scale);
	return rect ? cropImage(page, rect) : null;
}

/** Whether `node` can be cropped out of its page screenshot. */
function hasImage({ manifest, page }: ElementPage, node: ElementNode): boolean {
	return Boolean(page && cropRect(page, node.box, manifest.scale));
}

/** Pixel-diff two image files, writing a diff image when they count as changed. */
function diffImages(fromFile: string, toFile: string, outFile: string, entry: PageDiff, config: Config): PageDiff {
	try {
		return diffPngs(readPng(fromFile), readPng(toFile), outFile, entry, config);
	} catch (err) {
		return { ...entry, status: "error", message: (err as Error).message };
	}
}

/** Pixel-diff one decoded image pair, writing a diff image when it counts as changed. */
function diffPngs(a: PNG, b: PNG, outFile: string, entry: PageDiff, config: Config): PageDiff {
	try {
		if (a.width !== b.width || a.height !== b.height) {
			return {
				...entry,
				status: "size-mismatch",
				message: `dimensions differ (${a.width}x${a.height} vs ${b.width}x${b.height})`,
			};
		}

		const { width, height } = a;
		const diff = new PNG({ width, height });
		const mismatched = pixelmatch(a.data, b.data, diff.data, width, height, {
			threshold: config.diff.threshold,
			includeAA: config.diff.includeAA,
		});
		const total = width * height;
		const percent = total === 0 ? 0 : (mismatched / total) * 100;

		const override = perPageCutoff(entry.filename, config);
		const cutoff = override ?? config.diff.maxDiffPercent;
		const changed = percent > cutoff;

		let diffImage: string | undefined;
		if (changed) {
			diffImage = outFile;
			fs.mkdirSync(path.dirname(diffImage), { recursive: true });
			fs.writeFileSync(diffImage, PNG.sync.write(diff));
		}

		return {
			...entry,
			status: changed ? "changed" : "unchanged",
			diffPercent: percent,
			mismatchedPixels: mismatched,
			totalPixels: total,
			diffImage,
		};
	} catch (err) {
		return { ...entry, status: "error", message: (err as Error).message };
	}
}

/**
 * Diff two version directories.
 * - Per-element captures (pages with an `elements.json` on both sides) pair
 *   elements by identity (see `matching.ts`), so an element is compared with
 *   its counterpart even when its position in the tree, and so its path, changed.
 *   Each element's image is cropped from its page screenshot in memory, and
 *   only diff images for changed elements are written.
 * - Everything else pairs by identical relative path.
 * - Images unique to one side are reported as added/removed and count as changes.
 * - Images whose dimensions differ are reported as size-mismatch (a change).
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
	const pages: PageDiff[] = [];
	fs.mkdirSync(outDir, { recursive: true });

	const abs = (dir: string, rel: string) => path.join(dir, ...rel.split("/"));
	// Element screenshots already handled by identity matching.
	const doneFrom = new Set<string>();
	const doneTo = new Set<string>();
	const opts = matchOptions(config.match);
	const pairs = new Map<string, PagePairs>();

	const pageSlugs = new Set([...fromFiles, ...toFiles].map((f) => f.split("/")[0]));
	for (const slug of pageSlugs) {
		const a = readElementManifest(path.join(fromDir, slug, ELEMENT_MANIFEST));
		const b = readElementManifest(path.join(toDir, slug, ELEMENT_MANIFEST));
		if (!a || !b) continue;
		const pageA: ElementPage = { manifest: a, page: tryReadPng(path.join(fromDir, slug, PAGE_IMAGE)) };
		const pageB: ElementPage = { manifest: b, page: tryReadPng(path.join(toDir, slug, PAGE_IMAGE)) };

		const match = matchElements(a.elements, b.elements, opts);
		pairs.set(slug, { from: a, to: b, match });
		const rel = (n: ElementNode) => `${slug}/${n.dir}/${ELEMENT_IMAGE}`;
		const visit = (nodes: ElementNode[], side: "from" | "to"): void => {
			for (const n of nodes) {
				const own = rel(n);
				if (side === "to") {
					doneTo.add(own);
					const partner = match.toFrom.get(n);
					if (!partner) {
						if (hasImage(pageB, n)) pages.push({ filename: own, status: "added", message: "new element" });
					} else {
						const other = rel(partner);
						doneFrom.add(other);
						const entry: PageDiff = {
							filename: own,
							status: "unchanged",
							matchedBy: match.matchedBy.get(n),
							...(other !== own ? { fromFilename: other } : {}),
							...(match.moved.has(n) ? { moved: true } : {}),
						};
						const imgFrom = cropNode(pageA, partner);
						const imgTo = cropNode(pageB, n);
						const inFrom = Boolean(imgFrom);
						const inTo = Boolean(imgTo);
						if (imgFrom && imgTo) {
							pages.push(diffPngs(imgFrom, imgTo, abs(outDir, own), entry, config));
						} else if (inFrom || inTo) {
							// The element exists on both sides but one screenshot is missing.
							pages.push({
								...entry,
								status: inTo ? "added" : "removed",
								message: `screenshot missing in ${inTo ? "baseline" : "target"}`,
							});
						}
					}
				} else if (!match.fromTo.has(n)) {
					doneFrom.add(own);
					if (hasImage(pageA, n)) pages.push({ filename: own, status: "removed", message: "element no longer present" });
				}
				visit(n.children, side);
			}
		};
		visit(b.elements, "to");
		visit(a.elements, "from");
	}

	// Everything else (full-page shots, flat captures) pairs by path.
	const rest = [...new Set([...fromFiles, ...toFiles])].filter((f) => !doneFrom.has(f) && !doneTo.has(f));
	for (const filename of rest) {
		const inFrom = fromFiles.has(filename) && !doneFrom.has(filename);
		const inTo = toFiles.has(filename) && !doneTo.has(filename);
		if (inFrom && !inTo) {
			pages.push({ filename, status: "removed", message: "present in baseline only" });
		} else if (!inFrom && inTo) {
			pages.push({ filename, status: "added", message: "new page" });
		} else if (inFrom && inTo) {
			pages.push(
				diffImages(abs(fromDir, filename), abs(toDir, filename), abs(outDir, filename), { filename, status: "unchanged" }, config),
			);
		}
	}
	pages.sort((x, y) => x.filename.localeCompare(y.filename));

	const changedCount = pages.filter(
		(p) => p.status === "changed" || p.status === "size-mismatch" || p.status === "error",
	).length;
	const addedCount = pages.filter((p) => p.status === "added").length;
	const removedCount = pages.filter((p) => p.status === "removed").length;

	const report: DiffReport = {
		from: labels.from,
		to: labels.to,
		pages,
		changedCount,
		addedCount,
		removedCount,
		hasChanges: changedCount + addedCount + removedCount > 0,
	};
	Object.defineProperty(report, "pairs", { value: pairs, enumerable: false });
	return report;
}

/** Find a per-page maxDiffPercent override by matching the filename's page path. */
function perPageCutoff(filename: string, config: Config): number | undefined {
	if (!config.pages) return undefined;
	// filename is a slug; overrides are keyed by path. We can't perfectly reverse
	// a slug, so overrides only apply when the caller also stored the mapping.
	// For now, no reverse lookup; return undefined. (Extension point.)
	return undefined;
}
