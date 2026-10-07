import fs from "node:fs";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { cropImage, cropRect, ELEMENT_IMAGE, ELEMENT_MANIFEST, PAGE_IMAGE, pngSize, readElementManifest, } from "./elements.js";
import { matchElements, matchOptions } from "./matching.js";
import { readRedirect } from "./carryover.js";
/**
 * All PNGs under `dir`, returned as POSIX-style paths relative to `dir`.
 * Recurses so per-element hierarchies diff the same way flat
 * page captures do.
 */
function listPngs(dir) {
    const out = new Set();
    const walk = (cur, rel) => {
        let entries;
        try {
            entries = fs.readdirSync(cur, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            const abs = path.join(cur, e.name);
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory())
                walk(abs, r);
            else if (e.name.toLowerCase().endsWith(".png"))
                out.add(r);
        }
    };
    walk(dir, "");
    return out;
}
function subdirs(dir) {
    try {
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
    }
    catch {
        return [];
    }
}
function readPng(file) {
    return PNG.sync.read(fs.readFileSync(file));
}
function tryReadPng(file) {
    try {
        return readPng(file);
    }
    catch {
        return null;
    }
}
/**
 * A page's element tree and screenshot, from which its element images are
 * cropped. The screenshot is only decoded once a crop is needed: a page
 * carried over unchanged has the same bytes on both sides, and its elements
 * can be compared by their boxes alone.
 */
class ElementPage {
    manifest;
    file;
    decoded;
    size;
    constructor(manifest, file) {
        this.manifest = manifest;
        this.file = file;
        this.size = pngSize(file);
    }
    get page() {
        if (this.decoded === undefined)
            this.decoded = tryReadPng(this.file);
        return this.decoded;
    }
    /** Whether this page's screenshot is byte-for-byte `other`'s. */
    sameImage(other) {
        try {
            return fs.readFileSync(this.file).equals(fs.readFileSync(other.file));
        }
        catch {
            return false;
        }
    }
}
/** Crop `node` out of its page screenshot, or null when it has no image. */
function cropNode(p, node) {
    const rect = p.size && cropRect(p.size, node.box, p.manifest.scale);
    const page = rect && p.page;
    return rect && page ? cropImage(page, rect) : null;
}
/** Whether `node` can be cropped out of its page screenshot. */
function hasImage(p, node) {
    return Boolean(p.size && cropRect(p.size, node.box, p.manifest.scale));
}
/** Pixel-diff two image files, writing a diff image when they count as changed. */
function diffImages(fromFile, toFile, outFile, entry, config) {
    try {
        const a = fs.readFileSync(fromFile);
        const b = fs.readFileSync(toFile);
        if (a.equals(b)) {
            // The same file (a page carried over unchanged): nothing to decode.
            const size = pngSize(toFile);
            const total = size ? size.width * size.height : 0;
            return { ...entry, status: "unchanged", diffPercent: 0, mismatchedPixels: 0, totalPixels: total };
        }
        return diffPngs(PNG.sync.read(a), PNG.sync.read(b), outFile, entry, config);
    }
    catch (err) {
        return { ...entry, status: "error", message: err.message };
    }
}
/** Pixel-diff one decoded image pair, writing a diff image when it counts as changed. */
function diffPngs(a, b, outFile, entry, config) {
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
        let diffImage;
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
    }
    catch (err) {
        return { ...entry, status: "error", message: err.message };
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
export function diffVersions(fromDir, toDir, outDir, config, labels) {
    const fromFiles = listPngs(fromDir);
    const toFiles = listPngs(toDir);
    const pages = [];
    fs.mkdirSync(outDir, { recursive: true });
    const abs = (dir, rel) => path.join(dir, ...rel.split("/"));
    // Element screenshots already handled by identity matching.
    const doneFrom = new Set();
    const doneTo = new Set();
    const opts = matchOptions(config.match);
    const pairs = new Map();
    const pageSlugs = new Set([...fromFiles, ...toFiles].map((f) => f.split("/")[0]));
    // Redirects: a page recorded as landing on another page has no capture of
    // its own. Starting or stopping redirecting, or landing somewhere else, is
    // one change to the page, not every element in it coming or going.
    for (const slug of new Set([...pageSlugs, ...subdirs(fromDir), ...subdirs(toDir)])) {
        const ra = readRedirect(path.join(fromDir, slug));
        const rb = readRedirect(path.join(toDir, slug));
        if (!ra && !rb)
            continue;
        pageSlugs.delete(slug);
        for (const f of fromFiles)
            if (f.startsWith(`${slug}/`))
                doneFrom.add(f);
        for (const f of toFiles)
            if (f.startsWith(`${slug}/`))
                doneTo.add(f);
        if (ra && rb && ra.to === rb.to)
            continue;
        const where = (r) => new URL(r.url).pathname;
        const message = ra && rb
            ? `redirects to ${where(rb)} instead of ${where(ra)}`
            : rb
                ? `now redirects to ${where(rb)}`
                : `no longer redirects to ${where(ra)}`;
        pages.push({ filename: `${slug}/${PAGE_IMAGE}`, status: "changed", message });
    }
    for (const slug of pageSlugs) {
        const a = readElementManifest(path.join(fromDir, slug, ELEMENT_MANIFEST));
        const b = readElementManifest(path.join(toDir, slug, ELEMENT_MANIFEST));
        if (!a || !b)
            continue;
        const pageA = new ElementPage(a, path.join(fromDir, slug, PAGE_IMAGE));
        const pageB = new ElementPage(b, path.join(toDir, slug, PAGE_IMAGE));
        const sameImage = a.scale === b.scale && pageA.sameImage(pageB);
        const match = matchElements(a.elements, b.elements, opts);
        pairs.set(slug, { from: a, to: b, match });
        const rel = (n) => `${slug}/${n.dir}/${ELEMENT_IMAGE}`;
        const visit = (nodes, side) => {
            for (const n of nodes) {
                const own = rel(n);
                if (side === "to") {
                    doneTo.add(own);
                    const partner = match.toFrom.get(n);
                    if (!partner) {
                        if (hasImage(pageB, n))
                            pages.push({ filename: own, status: "added", message: "new element" });
                    }
                    else {
                        const other = rel(partner);
                        doneFrom.add(other);
                        const entry = {
                            filename: own,
                            status: "unchanged",
                            matchedBy: match.matchedBy.get(n),
                            ...(other !== own ? { fromFilename: other } : {}),
                            ...(match.moved.has(n) ? { moved: true } : {}),
                        };
                        const rectFrom = pageA.size && cropRect(pageA.size, partner.box, a.scale);
                        const rectTo = pageB.size && cropRect(pageB.size, n.box, b.scale);
                        if (sameImage && rectFrom && rectTo && sameRect(rectFrom, rectTo)) {
                            // The same pixels from the same screenshot.
                            const total = rectTo.width * rectTo.height;
                            pages.push({ ...entry, diffPercent: 0, mismatchedPixels: 0, totalPixels: total });
                            visit(n.children, side);
                            continue;
                        }
                        const imgFrom = cropNode(pageA, partner);
                        const imgTo = cropNode(pageB, n);
                        const inFrom = Boolean(imgFrom);
                        const inTo = Boolean(imgTo);
                        if (imgFrom && imgTo) {
                            pages.push(diffPngs(imgFrom, imgTo, abs(outDir, own), entry, config));
                        }
                        else if (inFrom || inTo) {
                            // The element exists on both sides but one screenshot is missing.
                            pages.push({
                                ...entry,
                                status: inTo ? "added" : "removed",
                                message: `screenshot missing in ${inTo ? "baseline" : "target"}`,
                            });
                        }
                    }
                }
                else if (!match.fromTo.has(n)) {
                    doneFrom.add(own);
                    if (hasImage(pageA, n))
                        pages.push({ filename: own, status: "removed", message: "element no longer present" });
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
        }
        else if (!inFrom && inTo) {
            pages.push({ filename, status: "added", message: "new page" });
        }
        else if (inFrom && inTo) {
            pages.push(diffImages(abs(fromDir, filename), abs(toDir, filename), abs(outDir, filename), { filename, status: "unchanged" }, config));
        }
    }
    pages.sort((x, y) => x.filename.localeCompare(y.filename));
    const changedCount = pages.filter((p) => p.status === "changed" || p.status === "size-mismatch" || p.status === "error").length;
    const addedCount = pages.filter((p) => p.status === "added").length;
    const removedCount = pages.filter((p) => p.status === "removed").length;
    const report = {
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
function sameRect(a, b) {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
/** Find a per-page maxDiffPercent override by matching the filename's page path. */
function perPageCutoff(filename, config) {
    if (!config.pages)
        return undefined;
    // filename is a slug; overrides are keyed by path. We can't perfectly reverse
    // a slug, so overrides only apply when the caller also stored the mapping.
    // For now, no reverse lookup; return undefined. (Extension point.)
    return undefined;
}
