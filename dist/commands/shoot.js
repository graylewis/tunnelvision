import path from "node:path";
import pc from "picocolors";
import fs from "node:fs";
import { applyOverrides, loadConfig } from "../config.js";
import { resolvePaths, versionDir } from "../paths.js";
import { resolveVersion, snapshotTree } from "../git.js";
import { findSitemaps, parseSitemap } from "../sitemap.js";
import { resolvePages } from "../pages.js";
import { buildShotsYaml, requireShotScraper, runMulti } from "../shotscraper.js";
import { capturePages } from "../playwright.js";
import { assignDirs, cropRect, extractScript, ELEMENT_MANIFEST, MANIFEST_VERSION, STYLE_MANIFEST, PAGE_IMAGE, pngSize, } from "../elements.js";
import { Cascade } from "../cascade.js";
import { StyleLocator } from "../stylesource.js";
import { STYLE_MANIFEST_VERSION, writeStyleManifest } from "../styles.js";
import { metaFromInfo, writeMeta } from "../versions.js";
import { stabilizeScript } from "../stabilize.js";
import { resolveComponents, SourceResolver } from "../reactsource.js";
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
    // Taken before capturing, while the files match what the app is serving.
    const rev = captureRev(ctx);
    if (ctx.byElement) {
        return runElementCapture(ctx, rev, auth);
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
    writeMeta(ctx.paths, metaFromInfo(ctx.version, ctx.config.baseUrl, ctx.pages.length, rev));
    return result;
}
/**
 * Capture each page as a hierarchy of per-element screenshots.
 *
 * Each page is loaded once (several pages at a time): the driver waits, reads
 * the visible block-level element tree, and takes a full-page screenshot from
 * the same load. Only that screenshot and the tree (`elements.json`) are
 * stored; element images are cropped out of it whenever they're needed.
 */
async function runElementCapture(ctx, rev, auth) {
    const { config } = ctx;
    const scale = config.scaleFactor && config.scaleFactor > 0 ? config.scaleFactor : config.retina ? 2 : 1;
    const resolver = new SourceResolver(ctx.paths.root);
    const locator = new StyleLocator(ctx.paths.root);
    const produced = [];
    const missing = [];
    const noReactSource = [];
    const noStyles = [];
    let unlocatedSheets = 0;
    let elementCount = 0;
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
        // React source locations, which also feed each element's identity.
        const components = await resolveComponents(tree, resolver);
        addComponents(tree, components);
        const withSource = [...components.values()].filter((c) => c.source).length;
        if (components.size > 0 && withSource === 0)
            noReactSource.push(slug);
        if (capture.styles) {
            const { rules, unlocated } = await locator.rules(capture.styles);
            unlocatedSheets += unlocated;
            writeStyleManifest(path.join(pageRoot, STYLE_MANIFEST), {
                version: STYLE_MANIFEST_VERSION,
                rules,
                elements: elementStyles(tree, capture.tree ?? [], capture.styles, config.styles.properties),
            });
        }
        else {
            noStyles.push(slug);
        }
        const manifest = {
            version: MANIFEST_VERSION,
            url: ctx.pages[i].url,
            extractedAt: new Date().toISOString(),
            scale,
            elements: tree,
        };
        fs.writeFileSync(path.join(pageRoot, ELEMENT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
        produced.push(`${slug}/${PAGE_IMAGE}`);
        // Elements that can't be cropped out of the screenshot have no image.
        const size = pngSize(jobs[i].output);
        const visit = (nodes) => {
            for (const node of nodes) {
                if (size && cropRect(size, node.box, scale))
                    elementCount++;
                else
                    missing.push(`${slug}/${node.dir} (outside the page)`);
                visit(node.children);
            }
        };
        visit(tree);
    };
    const pending = [];
    let done = 0;
    await capturePages(jobs, {
        viewport: config.viewport,
        scaleFactor: scale,
        authFile: auth,
        concurrency: Math.max(1, Math.floor(config.concurrency)),
        extractJs: extractScript(config.match.attributes, config.styles.properties),
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
    if (noStyles.length > 0) {
        console.log(pc.yellow(`  Couldn't read CSS rules on ${noStyles.length} page(s); visual changes there can't be traced to CSS.`));
    }
    if (unlocatedSheets > 0) {
        console.log(pc.yellow(`  ${unlocatedSheets} stylesheet(s) couldn't be traced to a source file; ` +
            "with Vite, set `css: { devSourcemap: true }` for processed CSS (PostCSS, Tailwind, Sass)."));
    }
    console.log(pc.dim(`  ${elementCount} elements recorded (cropped from each page screenshot on demand)`));
    writeMeta(ctx.paths, metaFromInfo(ctx.version, config.baseUrl, ctx.pages.length, rev));
    return { produced, missing, exitCode: 0 };
}
/**
 * Resolve the winning declaration of each tracked property on every element,
 * keyed by element `dir`. `raw` is the tree `nodes` were planned from, index
 * for index.
 */
function elementStyles(nodes, raw, styles, properties) {
    const cascade = new Cascade(styles);
    const out = {};
    const visit = (planned, extracted) => {
        planned.forEach((node, i) => {
            const source = extracted[i];
            if (!source)
                return;
            out[node.dir] = cascade.resolveElement(node.selector, properties, source.computed ?? {});
            visit(node.children, source.children);
        });
    };
    visit(nodes, raw);
    return out;
}
/** Attach each element's resolved component info, and fill in its source identity from it. */
function addComponents(nodes, components) {
    for (const node of nodes) {
        const component = components.get(node);
        if (component)
            node.component = component;
        const source = component?.source;
        if (node.identity && source) {
            node.identity.source = source.path;
            node.identity.file = source.path.replace(/:\d+:\d+$/, "");
        }
        addComponents(node.children, components);
    }
}
/** Snapshot the files this capture was taken from, so it can be diffed at them later. */
function captureRev(ctx) {
    return ctx.version.fromGit ? snapshotTree(ctx.paths.root, ctx.version.key) : null;
}
/** Resolve wait / waitFor / settle for a page from config. */
function pageWait(ctx, page) {
    const override = ctx.config.pages?.[page.pathAndQuery];
    const out = {
        stabilizeJs: stabilizeScript(override?.settle ?? ctx.config.settle),
    };
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
