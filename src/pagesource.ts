import path from "node:path";
import { detectFramework, findRoutes, FRAMEWORK_NAMES, routePattern, type Framework } from "./fileroutes.js";
import { findSitemaps, parseSitemap } from "./sitemap.js";

export interface PageSource {
	kind: Framework | "sitemap";
	/** Paths or sitemap <loc>s to capture. */
	locs: string[];
	/** Where they came from, for messages (e.g. "Next.js routes in src/app"). */
	from: string;
	/** Things worth telling the user, like dynamic routes that were left out. */
	notes: string[];
}

function pathname(loc: string): string {
	try {
		return new URL(loc).pathname;
	} catch {
		return loc.startsWith("/") ? loc : `/${loc}`;
	}
}

/** Pages from the project's one sitemap. Throws if there isn't exactly one. */
function fromSitemap(root: string): PageSource {
	const sitemaps = findSitemaps(root);
	if (sitemaps.length === 0) {
		throw new Error(`No sitemap found under ${root}. tunnelvision searches recursively for sitemap*.xml.`);
	}
	if (sitemaps.length > 1) {
		const list = sitemaps.map((s) => `  - ${path.relative(root, s)}`).join("\n");
		throw new Error(`Multiple sitemaps found; please remove or consolidate so exactly one remains:\n${list}`);
	}
	const file = path.relative(root, sitemaps[0]);
	const locs = parseSitemap(sitemaps[0]);
	if (locs.length === 0) throw new Error(`Sitemap ${file} contains no <loc> URLs.`);
	return { kind: "sitemap", locs, from: file, notes: [] };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Pages to capture. A Next.js or Astro project's are read from its file-based
 * routes, with dynamic routes filled in from the sitemap's matching URLs when
 * there's one sitemap; any other project's come from its sitemap.
 */
export function discoverPages(root: string): PageSource {
	const framework = detectFramework(root);
	const routes = framework ? findRoutes(root, framework) : null;
	if (!routes || (routes.paths.length === 0 && routes.dynamic.length === 0)) return fromSitemap(root);
	const name = FRAMEWORK_NAMES[routes.framework];

	let sitemapLocs: string[] = [];
	try {
		sitemapLocs = fromSitemap(root).locs;
	} catch {
		// No usable sitemap: dynamic routes are reported as left out below.
	}

	const known = new Set(routes.paths);
	const filled = new Set<string>();
	const locs: string[] = [...routes.paths];
	const unrouted: string[] = [];
	const patterns = routes.dynamic.map((route) => ({ route, re: routePattern(route, routes.framework) }));
	for (const loc of sitemapLocs) {
		const p = pathname(loc).replace(/(.)\/$/, "$1");
		if (known.has(p)) continue;
		const match = patterns.find(({ re }) => re.test(p));
		if (!match) {
			unrouted.push(p);
			continue;
		}
		known.add(p);
		filled.add(match.route);
		locs.push(loc);
	}

	const notes: string[] = [];
	const missing = routes.dynamic.filter((route) => !filled.has(route));
	if (missing.length > 0) {
		notes.push(`${plural(missing.length, "dynamic route")} left out (no matching sitemap URLs): ${missing.join(", ")}`);
	}
	// Rewrites, redirects, and routes injected by integrations (Starlight) have no route file.
	if (unrouted.length > 0) {
		const shown = unrouted.slice(0, 5).join(", ") + (unrouted.length > 5 ? ", …" : "");
		const one = unrouted.length === 1;
		notes.push(
			`${plural(unrouted.length, "sitemap URL")} ${one ? "matches" : "match"} no route file and ${one ? "was" : "were"} left out: ${shown}`,
		);
	}
	if (locs.length === 0) {
		throw new Error(`Every ${name} route needs parameters and none were found in a sitemap: ${missing.join(", ")}`);
	}
	return { kind: routes.framework, locs, from: `${name} routes in ${routes.dirs.join(", ")}`, notes };
}
