import crypto from "node:crypto";

/**
 * Turn a URL (absolute or a path) into a deterministic, human-readable base
 * filename (without extension).
 *   "/"              -> "index"
 *   "/blog/post"     -> "blog__post"
 *   "/a/b?x=1"       -> "blog__post__q_x-1" style (query folded in)
 */
export function slugForUrl(url: string): string {
	let pathname = url;
	let search = "";
	try {
		// Handles absolute URLs; for bare paths this throws and we fall through.
		const u = new URL(url);
		pathname = u.pathname;
		search = u.search;
	} catch {
		const qIndex = url.indexOf("?");
		if (qIndex >= 0) {
			pathname = url.slice(0, qIndex);
			search = url.slice(qIndex);
		}
	}

	// Normalise trailing slash (but keep root as "/").
	pathname = pathname.replace(/\/+$/, "");
	if (pathname === "") pathname = "/";

	const segments = pathname.split("/").filter(Boolean);
	let base = segments.length === 0 ? "index" : segments.join("__");

	if (search && search !== "?") {
		const q = search.replace(/^\?/, "");
		base += `__q_${q}`;
	}

	// Replace anything unfriendly with a hyphen, collapse repeats.
	base = base
		.replace(/[^a-zA-Z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");

	return base || "index";
}

/**
 * Assign unique filenames to a set of URLs. On a slug collision, a short hash of
 * the full URL is appended so both pages remain addressable.
 */
export function assignFilenames(urls: string[]): Map<string, string> {
	const bySlug = new Map<string, string[]>();
	for (const url of urls) {
		const slug = slugForUrl(url);
		const list = bySlug.get(slug) ?? [];
		list.push(url);
		bySlug.set(slug, list);
	}

	const result = new Map<string, string>();
	for (const [slug, group] of bySlug) {
		if (group.length === 1) {
			result.set(group[0], `${slug}.png`);
			continue;
		}
		for (const url of group) {
			const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 7);
			result.set(url, `${slug}-${hash}.png`);
		}
	}
	return result;
}
