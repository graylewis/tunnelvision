import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import pc from "picocolors";
import { PNG } from "pngjs";
import { applyOverrides, configExists, DEFAULT_CONFIG, loadConfig } from "../config.js";
import { diffDir, resolvePaths, versionDir } from "../paths.js";
import { diffVersions } from "../diffengine.js";
import { listVersions, versionExists } from "../versions.js";
import { addCorrelation } from "../correlate.js";
import { topLevel } from "../git.js";
import { matchElements, matchOptions } from "../matching.js";
import { cropRect, ELEMENT_IMAGE, ELEMENT_MANIFEST, ElementImages, PAGE_IMAGE, pngSize, readElementManifest, } from "../elements.js";
/** The single-page UI, shipped alongside `dist/` (see `files` in package.json). */
const PAGE_FILE = new URL("../../assets/inspector.html", import.meta.url);
export const CHANGE_STATUSES = new Set(["changed", "added", "removed", "size-mismatch", "error"]);
/** Page slugs in a version: element-root directories plus flat `<slug>.png` captures. */
function listPages(dir) {
    const out = new Map();
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const e of entries) {
        if (e.isDirectory()) {
            out.set(e.name, { byElement: fs.existsSync(path.join(dir, e.name, ELEMENT_MANIFEST)) });
        }
        else if (e.name.toLowerCase().endsWith(".png")) {
            const slug = e.name.replace(/\.png$/i, "");
            if (!out.has(slug))
                out.set(slug, { byElement: false });
        }
    }
    return out;
}
export function buildDiff(paths, overrides, from, to) {
    const base = configExists(paths) ? loadConfig(paths) : DEFAULT_CONFIG;
    const config = applyOverrides(base, overrides);
    const fromDir = versionDir(paths, from);
    const toDir = versionDir(paths, to);
    const outDir = diffDir(paths, from, to);
    const report = addCorrelation(paths, diffVersions(fromDir, toDir, outDir, config, { from, to }));
    // A removed element can share its path with a different element in the
    // target, so removals are looked up separately.
    const byFile = new Map();
    const removedByFile = new Map();
    for (const p of report.pages)
        (p.status === "removed" ? removedByFile : byFile).set(p.filename, p);
    const statusOf = (file, inFrom, inTo, removed = false) => {
        const d = removed ? removedByFile.get(file) : byFile.get(file);
        return {
            status: (d?.status ?? "missing"),
            diffPercent: d?.diffPercent,
            message: d?.message ?? (inFrom || inTo ? undefined : "no screenshot in either version"),
            images: { from: inFrom, to: inTo, diff: Boolean(d?.diffImage) },
        };
    };
    const fromPages = listPages(fromDir);
    const toPages = listPages(toDir);
    const slugs = [...new Set([...fromPages.keys(), ...toPages.keys()])].sort();
    const pages = slugs.map((slug) => {
        const byElement = Boolean(fromPages.get(slug)?.byElement || toPages.get(slug)?.byElement);
        const fromRoot = path.join(fromDir, slug);
        const toRoot = path.join(toDir, slug);
        if (!byElement) {
            const image = `${slug}.png`;
            const s = statusOf(image, fs.existsSync(path.join(fromDir, image)), fs.existsSync(path.join(toDir, image)));
            return { slug, url: null, byElement, ...s, image, changedElements: 0, elements: [] };
        }
        const fromManifest = readElementManifest(path.join(fromRoot, ELEMENT_MANIFEST));
        const toManifest = readElementManifest(path.join(toRoot, ELEMENT_MANIFEST));
        const fromSize = pngSize(path.join(fromRoot, PAGE_IMAGE));
        const toSize = pngSize(path.join(toRoot, PAGE_IMAGE));
        // Pair elements the same way the diff did, then lay the tree out in the
        // target's shape, with removed elements under their old parent's partner.
        const fromTree = fromManifest?.elements ?? [];
        const toTree = toManifest?.elements ?? [];
        const match = matchElements(fromTree, toTree, matchOptions(config.match));
        const countChanged = (children) => children.reduce((sum, c) => sum + c.changedDescendants + (CHANGE_STATUSES.has(c.status) ? 1 : 0), 0);
        const make = (a, b, children) => {
            const node = (b ?? a);
            const dir = node.dir;
            const crop = {
                from: (a && fromSize && fromManifest && cropRect(fromSize, a.box, fromManifest.scale)) || null,
                to: (b && toSize && toManifest && cropRect(toSize, b.box, toManifest.scale)) || null,
            };
            const s = statusOf(`${slug}/${dir}/${ELEMENT_IMAGE}`, Boolean(crop.from), Boolean(crop.to), !b);
            // A node missing from one tree is added/removed even if its capture failed.
            if (s.status === "missing" && (!a || !b))
                s.status = a ? "removed" : "added";
            const component = b?.component ?? a?.component;
            return {
                tag: node.tag,
                id: node.id,
                className: node.className,
                dir,
                uid: b ? b.dir : `removed:${a.dir}`,
                fromDir: a?.dir ?? null,
                matchedBy: (b && match.matchedBy.get(b)) ?? null,
                moved: Boolean(b && match.moved.has(b)),
                selector: node.selector,
                rect: { from: a?.rect ?? null, to: b?.rect ?? null },
                crop,
                ...s,
                component: component ?? null,
                changedDescendants: countChanged(children),
                children,
            };
        };
        // Unmatched baseline elements; matched descendants appear under their partners.
        const removed = (nodes) => nodes.filter((a) => !match.fromTo.has(a)).map((a) => make(a, null, removed(a.children)));
        const build = (to, fromSiblings) => [
            ...to.map((b) => {
                const a = match.toFrom.get(b) ?? null;
                return make(a, b, build(b.children, a?.children ?? []));
            }),
            ...removed(fromSiblings),
        ];
        const elements = build(toTree, fromTree);
        const image = `${slug}/${PAGE_IMAGE}`;
        const s = statusOf(image, fs.existsSync(path.join(fromRoot, PAGE_IMAGE)), fs.existsSync(path.join(toRoot, PAGE_IMAGE)));
        const changedElements = countChanged(elements);
        return {
            slug,
            url: toManifest?.url ?? fromManifest?.url ?? null,
            byElement,
            ...s,
            image,
            changedElements,
            elements,
        };
    });
    return {
        from,
        to,
        summary: {
            changedCount: report.changedCount,
            addedCount: report.addedCount,
            removedCount: report.removedCount,
            hasChanges: report.hasChanges,
        },
        threshold: config.diff.threshold,
        pages,
        correlation: report.correlation ?? null,
        ...(report.correlationSkipped ? { correlationSkipped: report.correlationSkipped } : {}),
        repoRoot: topLevel(paths.root) ?? paths.root,
    };
}
/** Resolve `rel` under `base`, refusing anything that escapes it. */
function safeJoin(base, rel) {
    const target = path.resolve(base, ...rel.split("/").filter(Boolean));
    return target === base || target.startsWith(base + path.sep) ? target : null;
}
function send(res, status, type, body) {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
}
function sendJson(res, status, body) {
    send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}
function openBrowser(url) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => { }).unref();
}
export async function inspector(opts) {
    const paths = resolvePaths(opts.root);
    if (!fs.existsSync(paths.versions)) {
        throw new Error(`No captures found under ${paths.versions}. Run \`tunnelvision shoot\` first.`);
    }
    const cache = new Map();
    // Element images are cropped from page screenshots on request.
    const images = new ElementImages();
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        try {
            if (url.pathname === "/") {
                return send(res, 200, "text/html; charset=utf-8", fs.readFileSync(PAGE_FILE));
            }
            if (url.pathname === "/api/versions") {
                const versions = listVersions(paths).map((v) => ({
                    ...v,
                    byElement: [...listPages(versionDir(paths, v.key)).values()].some((p) => p.byElement),
                }));
                const base = configExists(paths) ? loadConfig(paths) : DEFAULT_CONFIG;
                const threshold = applyOverrides(base, opts).diff.threshold;
                return sendJson(res, 200, { root: paths.root, versions, threshold });
            }
            if (url.pathname === "/api/diff") {
                const from = url.searchParams.get("from") ?? "";
                const to = url.searchParams.get("to") ?? "";
                for (const key of [from, to]) {
                    if (!key || key.includes("/") || key.includes("\\") || !versionExists(paths, key)) {
                        return sendJson(res, 404, { error: `Unknown version "${key}"` });
                    }
                }
                const base = configExists(paths) ? loadConfig(paths) : DEFAULT_CONFIG;
                const overrides = { ...opts, threshold: applyOverrides(base, opts).diff.threshold };
                const t = url.searchParams.get("threshold");
                if (t !== null && t !== "") {
                    const threshold = Number(t);
                    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
                        return sendJson(res, 400, { error: "threshold must be a number between 0 and 1" });
                    }
                    overrides.threshold = threshold;
                }
                // One result per pair: diff images share a directory, so a cached result
                // from another threshold would point at images this run overwrote.
                const cacheKey = `${from}__${to}`;
                let result = cache.get(cacheKey);
                if (!result ||
                    url.searchParams.has("refresh") ||
                    overrides.threshold !== result.threshold) {
                    images.clear();
                    result = buildDiff(paths, overrides, from, to);
                    cache.set(cacheKey, result);
                }
                return sendJson(res, 200, result);
            }
            // /img/version/<key>/<rel> and /img/diff/<from>__<to>/<rel>
            const img = url.pathname.match(/^\/img\/(version|diff)\/([^/]+)\/(.+)$/);
            if (img) {
                const [, kind, key, rel] = img;
                const base = kind === "version" ? paths.versions : paths.diffs;
                const dir = safeJoin(base, decodeURIComponent(key));
                const relPath = decodeURIComponent(rel);
                const file = dir && safeJoin(dir, relPath);
                if (!file || !file.toLowerCase().endsWith(".png"))
                    return send(res, 404, "text/plain", "Not found");
                if (fs.existsSync(file))
                    return send(res, 200, "image/png", fs.readFileSync(file));
                // <slug>/<element dir>/element.png in a version: crop it out of the page.
                const parts = relPath.split("/").filter(Boolean);
                if (kind === "version" && parts.length > 2 && parts.at(-1) === ELEMENT_IMAGE) {
                    const crop = images.crop(path.join(dir, parts[0]), parts.slice(1, -1).join("/"));
                    if (crop)
                        return send(res, 200, "image/png", PNG.sync.write(crop));
                }
                return send(res, 404, "text/plain", "Not found");
            }
            send(res, 404, "text/plain", "Not found");
        }
        catch (err) {
            sendJson(res, 500, { error: err.message });
        }
    });
    const host = opts.host ?? "127.0.0.1";
    const port = opts.port ?? 4173;
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve());
    });
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    const shownHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
    const link = `http://${shownHost}:${actualPort}`;
    console.log(pc.bold("tunnelvision inspector") + pc.dim(` → ${path.relative(process.cwd(), paths.dir) || paths.dir}`));
    console.log(`  ${pc.cyan(link)}`);
    console.log(pc.dim("  press Ctrl+C to stop"));
    if (opts.open)
        openBrowser(link);
    // Keep running until interrupted.
    await new Promise((resolve) => {
        const stop = () => server.close(() => resolve());
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    });
    return 0;
}
