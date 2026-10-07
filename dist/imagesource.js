import path from "node:path";
/**
 * From the URL of one of an element's own images (see CONTEXT.md) to what
 * correlation looks for: its file name, searched for literally in changed
 * lines, and the files in the project it could have been served from,
 * looked up among changed binary files. See
 * docs/adr/0009-changed-binary-files-are-causes.md.
 */
/** A content hash a bundler put before the extension: `avatar.Bx7a3Kq1.png`. Must hold a digit, so `logo.dark.png` keeps `dark`. */
const BUILD_HASH = /\.(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{8,}(?=\.[A-Za-z0-9]+$)/;
/** The URL an image was served from, unwrapping Astro's dev image endpoint (`/_image?href=…`). */
function served(src, base) {
    let url;
    try {
        url = new URL(src, base);
    }
    catch {
        return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "file:")
        return null;
    const href = url.pathname === "/_image" ? url.searchParams.get("href") : null;
    return href ? served(href, url.href) : url;
}
/** The pathname of `url`, decoded, or null if it doesn't decode. */
function pathnameOf(url) {
    try {
        return decodeURIComponent(url.pathname);
    }
    catch {
        return null;
    }
}
/**
 * The file name an image was written as in source: the last path segment of
 * its URL, without the query or a bundler's content hash. Null for URLs that
 * don't name a file (`data:`, `blob:`).
 */
export function imageName(src) {
    const url = served(src);
    const pathname = url && pathnameOf(url);
    const name = pathname ? path.posix.basename(pathname) : "";
    return name ? name.replace(BUILD_HASH, "") : null;
}
/**
 * Absolute paths an image served from the app at `pageUrl` could have come
 * from, most likely first: a Vite `/@fs/` path as is, otherwise its pathname
 * under the public directory, then under the project root (Vite serves
 * `/src/…` from there). Empty for images from another origin and for hashed
 * build output, which can't be traced to a file.
 */
export function imageFiles(src, pageUrl, root, publicDir = "public") {
    const url = served(src, pageUrl);
    if (!url)
        return [];
    const pathname = pathnameOf(url);
    if (!pathname)
        return [];
    if (url.protocol === "file:")
        return [pathname];
    let origin;
    try {
        origin = new URL(pageUrl).origin;
    }
    catch {
        return [];
    }
    if (url.origin !== origin)
        return [];
    if (pathname.startsWith("/@fs/"))
        return [pathname.slice("/@fs".length)];
    const rel = pathname.replace(/^\/+/, "");
    if (!rel || rel.startsWith("_astro/") || rel.startsWith("_next/"))
        return [];
    return [path.join(root, publicDir, ...rel.split("/")), path.join(root, ...rel.split("/"))];
}
