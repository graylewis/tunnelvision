import { assignFilenames } from "./slug.js";
function pathOf(loc) {
    try {
        const u = new URL(loc);
        return `${u.pathname}${u.search}`;
    }
    catch {
        // Already a bare path.
        return loc.startsWith("/") ? loc : `/${loc}`;
    }
}
function joinBase(baseUrl, pathAndQuery) {
    const base = baseUrl.replace(/\/+$/, "");
    const p = pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`;
    return `${base}${p}`;
}
/** Turn sitemap <loc> entries into concrete pages to screenshot. */
export function resolvePages(locs, config) {
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
