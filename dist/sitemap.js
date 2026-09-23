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
function isSitemapFile(name) {
    return /^sitemap.*\.xml$/i.test(name);
}
/** Recursively find sitemap files under root, skipping build/vendor dirs. */
export function findSitemaps(root) {
    const found = [];
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name) || entry.name.startsWith("."))
                    continue;
                walk(path.join(dir, entry.name));
            }
            else if (entry.isFile() && isSitemapFile(entry.name)) {
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
function asArray(v) {
    if (v === undefined)
        return [];
    return Array.isArray(v) ? v : [v];
}
/**
 * Parse <loc> entries out of a sitemap or sitemap index file. If it's an index,
 * only local child sitemaps (relative to the index file) are followed; remote
 * <loc> children of an index are ignored (we work from the filesystem).
 */
export function parseSitemap(file, seen = new Set()) {
    const abs = path.resolve(file);
    if (seen.has(abs))
        return [];
    seen.add(abs);
    let xml;
    try {
        xml = fs.readFileSync(abs, "utf8");
    }
    catch (err) {
        throw new Error(`Could not read sitemap ${file}: ${err.message}`);
    }
    let doc;
    try {
        doc = parser.parse(xml);
    }
    catch (err) {
        throw new Error(`Sitemap ${file} is not valid XML: ${err.message}`);
    }
    const urls = [];
    // Sitemap index: <sitemapindex><sitemap><loc>...</loc>
    const index = doc.sitemapindex;
    if (index) {
        for (const child of asArray(index.sitemap)) {
            if (!child?.loc)
                continue;
            // Try to resolve the child sitemap on the local filesystem.
            const childName = path.basename(new URL(child.loc, "http://x").pathname);
            const candidate = path.join(path.dirname(abs), childName);
            if (fs.existsSync(candidate)) {
                urls.push(...parseSitemap(candidate, seen));
            }
        }
    }
    // Regular sitemap: <urlset><url><loc>...</loc>
    const urlset = doc.urlset;
    if (urlset) {
        for (const child of asArray(urlset.url)) {
            if (child?.loc)
                urls.push(String(child.loc).trim());
        }
    }
    // De-duplicate while preserving order.
    return [...new Set(urls)];
}
