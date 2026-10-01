import type { Config } from "./config.js";
import { assignFilenames } from "./slug.js";

export interface Page {
	/** The original <loc> from the sitemap, or a Next.js route path. */
	source: string;
	/** Path-only portion used for slugging and re-hosting. */
	pathAndQuery: string;
	/** Full URL to actually screenshot (baseUrl + path). */
	url: string;
	/** Output filename (e.g. "blog__post.png"). */
	filename: string;
}

function pathOf(loc: string): string {
	try {
		const u = new URL(loc);
		return `${u.pathname}${u.search}`;
	} catch {
		// Already a bare path.
		return loc.startsWith("/") ? loc : `/${loc}`;
	}
}

function joinBase(baseUrl: string, pathAndQuery: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	const p = pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`;
	return `${base}${p}`;
}

/** Turn sitemap <loc> entries or route paths into concrete pages to screenshot. */
export function resolvePages(locs: string[], config: Config): Page[] {
	const pathList = locs.map(pathOf);
	// Filenames are keyed off the path so the same page lines up across versions.
	const filenames = assignFilenames(pathList);
	return locs.map((source, i) => {
		const pathAndQuery = pathList[i];
		return {
			source,
			pathAndQuery,
			url: joinBase(config.baseUrl, pathAndQuery),
			filename: filenames.get(pathAndQuery) ?? "index.png",
		};
	});
}
