import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	".tunnelvision",
	".next",
	".nuxt",
	".svelte-kit",
	"dist",
	"build",
	".cache",
	".turbo",
	"coverage",
]);

/** File is considered a sitemap if named sitemap.xml or sitemap*.xml at any depth. */
function isSitemapFile(name: string): boolean {
	return /^sitemap.*\.xml$/i.test(name);
}

/** Recursively find sitemap files under root, skipping build/vendor dirs. */
export function findSitemaps(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
				walk(path.join(dir, entry.name));
			} else if (entry.isFile() && isSitemapFile(entry.name)) {
				found.push(path.join(dir, entry.name));
			}
		}
	};
	walk(root);
	// Shallowest first for stable, predictable ordering.
	found.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
	return found;
}

const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });

function asArray<T>(v: T | T[] | undefined): T[] {
	if (v === undefined) return [];
	return Array.isArray(v) ? v : [v];
}

/**
 * Parse <loc> entries out of a sitemap or sitemap index file. If it's an index,
 * only local child sitemaps (relative to the index file) are followed; remote
 * <loc> children of an index are ignored (we work from the filesystem).
 */
export function parseSitemap(file: string, seen = new Set<string>()): string[] {
	const abs = path.resolve(file);
	if (seen.has(abs)) return [];
	seen.add(abs);

	let xml: string;
	try {
		xml = fs.readFileSync(abs, "utf8");
	} catch (err) {
		throw new Error(`Could not read sitemap ${file}: ${(err as Error).message}`);
	}

	let doc: Record<string, unknown>;
	try {
		doc = parser.parse(xml) as Record<string, unknown>;
	} catch (err) {
		throw new Error(`Sitemap ${file} is not valid XML: ${(err as Error).message}`);
	}

	const urls: string[] = [];

	// Sitemap index: <sitemapindex><sitemap><loc>...</loc>
	const index = doc.sitemapindex as { sitemap?: unknown } | undefined;
	if (index) {
		for (const child of asArray(index.sitemap) as { loc?: string }[]) {
			if (!child?.loc) continue;
			// Try to resolve the child sitemap on the local filesystem.
			const childName = path.basename(new URL(child.loc, "http://x").pathname);
			const candidate = path.join(path.dirname(abs), childName);
			if (fs.existsSync(candidate)) {
				urls.push(...parseSitemap(candidate, seen));
			}
		}
	}

	// Regular sitemap: <urlset><url><loc>...</loc>
	const urlset = doc.urlset as { url?: unknown } | undefined;
	if (urlset) {
		for (const child of asArray(urlset.url) as { loc?: string }[]) {
			if (child?.loc) urls.push(String(child.loc).trim());
		}
	}

	// De-duplicate while preserving order.
	return [...new Set(urls)];
}
