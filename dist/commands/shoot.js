import path from "node:path";
import pc from "picocolors";
import fs from "node:fs";
import { applyOverrides, loadConfig } from "../config.js";
import { resolvePaths, versionDir } from "../paths.js";
import { resolveVersion } from "../git.js";
import { findSitemaps, parseSitemap } from "../sitemap.js";
import { resolvePages } from "../pages.js";
import { buildShotsYaml, requireShotScraper, runMulti } from "../shotscraper.js";
import { capturePages } from "../playwright.js";
import { assignDirs, collectShots, cropElements, EXTRACT_JS, ELEMENT_MANIFEST, PAGE_IMAGE, } from "../elements.js";
import { metaFromInfo, writeMeta } from "../versions.js";
import { SourceResolver, writeComponentFiles } from "../reactsource.js";
/** Load config + sitemap + resolve pages and the version key. Throws on fatal problems. */
export async function prepareCapture(opts) {
    const paths = resolvePaths(opts.root);
    const base = loadConfig(paths);
    const config = applyOverrides(base, opts);
    // Locate the sitemap.
    const sitemaps = findSitemaps(opts.root);
    if (sitemaps.length === 0) {
        throw new Error(`No sitemap found under ${opts.root}. tunnelvision searches recursively for sitemap*.xml.`);
    }
    if (sitemaps.length > 1) {
        const list = sitemaps.map((s) => `  - ${path.relative(opts.root, s)}`).join("\n");
        throw new Error(`Multiple sitemaps found; please remove or consolidate so exactly one remains:\n${list}`);
    }
    const locs = parseSitemap(sitemaps[0]);
    if (locs.length === 0) {
        throw new Error(`Sitemap ${path.relative(opts.root, sitemaps[0])} contains no <loc> URLs.`);
    }
    const pages = resolvePages(locs, config);
    const version = resolveVersion(opts.root);
    const outputDir = versionDir(paths, version.key);
    return { paths, config, version, pages, outputDir, byElement: Boolean(opts.byElement) };
}
/** Fail fast if the base URL is not reachable. */
async function assertReachable(baseUrl) {
    try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 5000);
        await fetch(baseUrl, { signal: controller.signal, redirect: "manual" }).finally(() => clearTimeout(t));
    }
    catch (err) {
        throw new Error(`Could not reach ${baseUrl} (${err.message}).\n` +
            "Start your app (or set the base URL with --base-url) and try again.");
    }
}
/** Run the actual capture given a prepared context. */
export async function runCapture(ctx) {
    requireShotScraper();
    const authFile = path.isAbsolute(ctx.config.authFile)
        ? ctx.config.authFile
        : path.join(ctx.paths.root, ctx.config.authFile);
    const auth = fs.existsSync(authFile) ? authFile : undefined;
    if (ctx.byElement) {
        return runElementCapture(ctx, auth);
    }
    const yaml = buildShotsYaml(ctx.pages, ctx.config, ctx.outputDir);
    const result = runMulti(ctx.pages, ctx.outputDir, {
        root: ctx.paths.root,
        authFile: auth,
        shotsYamlPath: path.join(ctx.outputDir, "shots.yml"),
        yaml,
        retina: ctx.config.retina,
        scaleFactor: ctx.config.scaleFactor,
    });
    writeMeta(ctx.paths, metaFromInfo(ctx.version, ctx.config.baseUrl, ctx.pages.length));
    return result;
}
/**
 * Capture each page as a hierarchy of per-element screenshots.
 *
 * Each page is loaded once (several pages at a time): the driver waits, reads
 * the visible block-level element tree, and takes a full-page screenshot from
 * the same load. We then lay the tree out as nested directories under the
 * page's slug and crop every element's box out of that screenshot.
 */
async function runElementCapture(ctx, auth) {
    const { config } = ctx;
    const scale = config.scaleFactor && config.scaleFactor > 0 ? config.scaleFactor : config.retina ? 2 : 1;
    const resolver = new SourceResolver(ctx.paths.root);
    const produced = [];
    const missing = [];
    const noReactSource = [];
    const slugs = ctx.pages.map((page) => page.filename.replace(/\.png$/i, ""));
    const jobs = ctx.pages.map((page, i) => ({
        url: page.url,
        output: path.join(ctx.outputDir, slugs[i], PAGE_IMAGE),
        ...pageWait(ctx, page),
    }));
    const processPage = async (i, capture) => {
        const slug = slugs[i];
        const pageRoot = path.join(ctx.outputDir, slug);
        if (!capture.ok || !fs.existsSync(jobs[i].output)) {
            missing.push(`${slug} (${capture.error ?? "no screenshot"})`);
            return;
        }
        const tree = assignDirs(capture.tree ?? []);
        const manifest = {
            url: ctx.pages[i].url,
            extractedAt: new Date().toISOString(),
            elements: tree,
        };
        fs.writeFileSync(path.join(pageRoot, ELEMENT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
        // React source locations alongside each element, when the page uses React.
        const react = await writeComponentFiles(pageRoot, tree, resolver);
        if (react.written > 0 && react.withSource === 0)
            noReactSource.push(slug);
        // One crop per element, nested to mirror the DOM.
        const crops = cropElements(jobs[i].output, pageRoot, collectShots(tree), scale);
        produced.push(`${slug}/${PAGE_IMAGE}`, ...crops.produced.map((rel) => `${slug}/${rel}`));
        missing.push(...crops.missing.map((rel) => `${slug}/${rel} (outside the page)`));
    };
    const pending = [];
    let done = 0;
    await capturePages(jobs, {
        viewport: config.viewport,
        scaleFactor: scale,
        authFile: auth,
        concurrency: Math.max(1, Math.floor(config.concurrency)),
        extractJs: EXTRACT_JS,
    }, (i, capture) => {
        done++;
        const status = capture.ok ? "" : pc.red(` failed: ${capture.error}`);
        console.log(pc.dim(`  [${done}/${jobs.length}] ${ctx.pages[i].url}`) + status);
        pending.push(processPage(i, capture));
    });
    await Promise.all(pending);
    if (noReactSource.length > 0) {
        console.log(pc.yellow(`  React detected but no source locations on ${noReactSource.length} page(s); ` +
            "line numbers need a React 19+ development build."));
    }
    writeMeta(ctx.paths, metaFromInfo(ctx.version, config.baseUrl, ctx.pages.length));
    return { produced, missing, exitCode: 0 };
}
/** Resolve wait / waitFor for a page from config. */
function pageWait(ctx, page) {
    const override = ctx.config.pages?.[page.pathAndQuery];
    const out = {};
    const wait = override?.wait ?? ctx.config.wait;
    if (wait && wait > 0)
        out.wait = wait;
    if (override?.waitFor)
        out.waitFor = override.waitFor;
    return out;
}
export async function shoot(opts) {
    const ctx = await prepareCapture(opts);
    await assertReachable(ctx.config.baseUrl);
    console.log(pc.bold(`Shooting ${ctx.pages.length} pages`) + pc.dim(` → version ${ctx.version.key}`));
    if (ctx.version.dirty) {
        console.log(pc.yellow("  working tree is dirty; stored under a -dirty key"));
    }
    const result = await runCapture(ctx);
    console.log("");
    console.log(pc.green(`  ✓ ${result.produced.length} captured`));
    if (result.missing.length > 0) {
        console.log(pc.red(`  ✗ ${result.missing.length} failed:`));
        for (const m of result.missing)
            console.log(pc.red(`      ${m}`));
    }
    console.log(pc.dim(`  saved to ${path.relative(ctx.paths.root, ctx.outputDir)}`));
    return result.missing.length > 0 ? 1 : 0;
}
