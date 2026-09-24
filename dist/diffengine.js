import fs from "node:fs";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { ELEMENT_IMAGE, ELEMENT_MANIFEST } from "./elements.js";
import { matchElements, matchOptions } from "./matching.js";
/**
 * All PNGs under `dir`, returned as POSIX-style paths relative to `dir`.
 * Recurses so per-element hierarchies (`--by-element`) diff the same way flat
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
function readPng(file) {
    return PNG.sync.read(fs.readFileSync(file));
}
function readManifest(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch {
        return null;
    }
}
/** Pixel-diff one image pair, writing a diff image when it counts as changed. */
function diffImages(fromFile, toFile, outFile, entry, config) {
    try {
        const a = readPng(fromFile);
        const b = readPng(toFile);
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
    const pageSlugs = new Set([...fromFiles, ...toFiles].map((f) => f.split("/")[0]));
    for (const slug of pageSlugs) {
        const a = readManifest(path.join(fromDir, slug, ELEMENT_MANIFEST));
        const b = readManifest(path.join(toDir, slug, ELEMENT_MANIFEST));
        if (!a || !b)
            continue;
        const match = matchElements(a.elements, b.elements, opts);
        const rel = (n) => `${slug}/${n.dir}/${ELEMENT_IMAGE}`;
        const visit = (nodes, side) => {
            for (const n of nodes) {
                const own = rel(n);
                if (side === "to") {
                    doneTo.add(own);
                    const partner = match.toFrom.get(n);
                    if (!partner) {
                        if (toFiles.has(own))
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
                        const inFrom = fromFiles.has(other);
                        const inTo = toFiles.has(own);
                        if (inFrom && inTo) {
                            pages.push(diffImages(abs(fromDir, other), abs(toDir, own), abs(outDir, own), entry, config));
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
                    if (fromFiles.has(own))
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
function perPageCutoff(filename, config) {
    if (!config.pages)
        return undefined;
    // filename is a slug; overrides are keyed by path. We can't perfectly reverse
    // a slug, so overrides only apply when the caller also stored the mapping.
    // For now, no reverse lookup; return undefined. (Extension point.)
    return undefined;
}
