import path from "node:path";
import pc from "picocolors";
import fs from "node:fs";
import { applyOverrides, loadConfig } from "../config.js";
import { resolvePaths, versionDir } from "../paths.js";
import { resolveVersion, snapshotTree } from "../git.js";
import { discoverPages } from "../pagesource.js";
import { resolvePages } from "../pages.js";
import { buildShotsYaml, requireShotScraper, runMulti } from "../shotscraper.js";
import { runDriver } from "../playwright.js";
import { assignDirs, cropRect, extractScript, ELEMENT_MANIFEST, MANIFEST_VERSION, STYLE_MANIFEST, PAGE_IMAGE, pngSize, } from "../elements.js";
import { Cascade } from "../cascade.js";
import { StyleLocator } from "../stylesource.js";
import { writeStyleManifest } from "../styles.js";
import { metaFromInfo, writeMeta } from "../versions.js";
import { stabilizeScript } from "../stabilize.js";
import { resolveComponents, SourceResolver } from "../reactsource.js";
import { assembleStyles, carryPage, findReference, hashOf, pageRecord, planElements, referenceElements, writeJson, PAGE_RECORD, REDIRECT_RECORD, } from "../carryover.js";
import { fingerprintScript } from "../fingerprint.js";
import { matchOptions } from "../matching.js";
import { environmentVersions, versionChanges } from "../environment.js";
/** Load config + discover and resolve pages and the version key. Throws on fatal problems. */
export async function prepareCapture(opts) {
    const paths = resolvePaths(opts.root);
    const base = loadConfig(paths);
    const config = applyOverrides(base, opts);
    const source = discoverPages(opts.root);
    const pages = resolvePages(source.locs, config);
    const version = resolveVersion(opts.root);
    const outputDir = versionDir(paths, version.key);
    return { paths, config, version, pages, source, outputDir, byElement: !opts.onlyPages, cheat: useCheatMode(opts, config) };
}
/**
 * Whether to capture in cheat mode: `--cheat` / `--no-cheat` when given, else
 * the config's default, which only holds while the versions it was validated
 * with are still the installed ones.
 */
function useCheatMode(opts, config) {
    if (opts.cheat !== undefined)
        return opts.cheat;
    const { enabled, validatedWith } = config.cheatMode;
    if (!enabled)
        return false;
    const changes = validatedWith ? versionChanges(validatedWith, environmentVersions(opts.root)) : ["never validated"];
    if (changes.length === 0)
        return true;
    console.log(pc.yellow(`  cheat mode is off until it's validated again (${changes.join(", ")}); run /setup-tunnelvision, or pass --cheat`));
    return false;
}
/** Say where the pages came from, and anything left out. */
export function logSource(ctx) {
    console.log(pc.dim(`  pages from ${ctx.source.from}`));
    for (const note of ctx.source.notes)
        console.log(pc.yellow(`  ${note}`));
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
 *
 * Whatever the nearest ancestor Version already holds is carried over rather
 * than read again (see `carryover.ts`): every element's style data unless
 * the element rule says otherwise, and in cheat mode whole pages whose render
 * fingerprint is unchanged. The Version is written to a staging directory and
 * swapped in when done, so a capture under the same key can be the reference.
 */
async function runElementCapture(ctx, rev, auth) {
    const started = Date.now();
    const { config } = ctx;
    const scale = config.scaleFactor && config.scaleFactor > 0 ? config.scaleFactor : config.retina ? 2 : 1;
    const resolver = new SourceResolver(ctx.paths.root);
    const locator = new StyleLocator(ctx.paths.root);
    const produced = [];
    const missing = [];
    const noReactSource = [];
    const noStyles = [];
    const carriedPages = [];
    const redirects = [];
    let unlocatedSheets = 0;
    let elementCount = 0;
    let queried = 0;
    let planned = 0;
    const { reference, why } = findReference(ctx.paths, ctx.version.key, rev);
    if (reference)
        console.log(pc.dim(`  carrying over from ${reference.meta.key}`));
    else
        console.log(pc.dim(`  capturing everything: ${why}`));
    const staging = path.join(ctx.paths.versions, `.${ctx.version.key}.${process.pid}`);
    fs.rmSync(staging, { recursive: true, force: true });
    const slugs = ctx.pages.map((page) => page.filename.replace(/\.png$/i, ""));
    const jobs = ctx.pages.map((page, i) => ({
        url: page.url,
        output: path.join(staging, slugs[i], PAGE_IMAGE),
        ...pageWait(ctx, page),
    }));
    const extractJs = extractScript(config.match.attributes, config.styles.properties, config.includeHidden);
    const fingerprintJs = fingerprintScript(config.cheatMode.ignoreAttributes);
    const settings = jobs.map((job, i) => settingsHash(ctx, job, extractJs, scale, auth, ctx.pages[i].url));
    // Fingerprints are kept against the script that took them, so a changed ignore list never matches.
    const stored = (fp) => hashOf([fingerprintJs, fp]);
    const opts = matchOptions(config.match);
    const fingerprints = [];
    const extracted = new Map();
    let done = 0;
    const progress = (i, note = "") => {
        done++;
        console.log(pc.dim(`  [${done}/${jobs.length}] ${ctx.pages[i].url}${note ? ` ${note}` : ""}`));
    };
    const onEvent = async (ev) => {
        const i = ev.index;
        const slug = slugs[i];
        const pageRoot = path.join(staging, slug);
        switch (ev.event) {
            case "redirect": {
                const to = ctx.pages.findIndex((p) => sameUrl(p.url, ev.url));
                writeJson(path.join(pageRoot, REDIRECT_RECORD), { url: ev.url, to: slugs[to] ?? null });
                redirects.push(slug);
                progress(i, pc.cyan(`→ redirects to ${new URL(ev.url).pathname}`));
                return;
            }
            case "fingerprint": {
                fingerprints[i] = stored(ev.fingerprint);
                if (!ctx.cheat)
                    return;
                const carry = Boolean(reference && carryPage(reference, ctx.paths.root, slug, settings[i], fingerprints[i], staging));
                if (carry) {
                    carriedPages.push(slug);
                    produced.push(`${slug}/${PAGE_IMAGE}`);
                    progress(i, pc.green("unchanged (carried over)"));
                }
                return { carry };
            }
            case "extracted": {
                const tree = assignDirs(ev.tree);
                // React source locations, which also feed each element's identity.
                const components = await resolveComponents(tree, resolver);
                addComponents(tree, components);
                const withSource = [...components.values()].filter((c) => c.source).length;
                if (components.size > 0 && withSource === 0)
                    noReactSource.push(slug);
                const plan = planElements({
                    fresh: tree,
                    raw: ev.tree,
                    changed: new Set(ev.changed),
                    reference: referenceElements(reference, slug, settings[i]),
                    mapper: reference?.mapper ?? null,
                    match: opts,
                    properties: config.styles.properties,
                });
                extracted.set(i, { tree, raw: ev.tree, plan });
                return { query: plan.query };
            }
            case "done": {
                const page = extracted.get(i);
                if (!page || !fs.existsSync(jobs[i].output)) {
                    missing.push(`${slug} (no screenshot)`);
                    progress(i, pc.red("failed: no screenshot"));
                    return;
                }
                const { tree, raw, plan } = page;
                const asked = plan.query === "all" ? plan.total : plan.query.length;
                queried += asked;
                planned += plan.total;
                if (ev.styles || asked === 0) {
                    const located = ev.styles ? await locator.rules(ev.styles) : { rules: [], unlocated: 0 };
                    unlocatedSheets += located.unlocated;
                    const computed = computedByNode(tree, raw);
                    const fresh = ev.styles
                        ? elementStyles(tree, raw, ev.styles, config.styles.properties, plan.query === "all" ? null : new Set(plan.query))
                        : new Map();
                    writeStyleManifest(path.join(pageRoot, STYLE_MANIFEST), assembleStyles(plan, (n) => computed.get(n) ?? {}, { rules: located.rules, elements: fresh }));
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
                writeJson(path.join(pageRoot, ELEMENT_MANIFEST), manifest);
                writeJson(path.join(pageRoot, PAGE_RECORD), pageRecord(settings[i], fingerprints[i]));
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
                progress(i, asked < plan.total ? pc.dim(`(styles read for ${asked} of ${plan.total} elements)`) : "");
                return;
            }
            case "error":
                missing.push(`${slug} (${ev.error})`);
                progress(i, pc.red(`failed: ${ev.error}`));
                return;
        }
    };
    try {
        await runDriver(jobs, {
            viewport: config.viewport,
            scaleFactor: scale,
            authFile: auth,
            concurrency: Math.max(1, Math.floor(config.concurrency)),
            loadConcurrency: Math.max(1, Math.floor(config.concurrency)) * LOAD_FACTOR,
            extractJs,
            fingerprintJs,
            cheat: ctx.cheat && Boolean(reference),
            knownUrls: ctx.pages.map((p) => p.url),
            changedSelectors: reference?.changedSelectors ?? [],
        }, onEvent);
    }
    catch (err) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw err;
    }
    // Swap the finished capture in, replacing any earlier one under this key.
    fs.rmSync(ctx.outputDir, { recursive: true, force: true });
    fs.renameSync(staging, ctx.outputDir);
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
    const summary = [
        carriedPages.length && `${carriedPages.length} page(s) carried over unchanged`,
        redirects.length && `${redirects.length} redirect(s)`,
        planned && `styles read for ${queried} of ${planned} elements`,
    ].filter(Boolean);
    console.log(pc.dim(`  ${[...summary, `${((Date.now() - started) / 1000).toFixed(1)}s`].join(" · ")}`));
    writeMeta(ctx.paths, metaFromInfo(ctx.version, config.baseUrl, ctx.pages.length, rev));
    return { produced, missing, exitCode: 0 };
}
/** How many more pages are loaded and fingerprinted at once than are captured (see `capture.py`). */
const LOAD_FACTOR = 3;
/** Whether two URLs are the same page (ignoring a trailing slash and fragment). */
function sameUrl(a, b) {
    const norm = (u) => {
        const url = new URL(u);
        return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}${url.search}`;
    };
    return norm(a) === norm(b);
}
/**
 * Everything that decides what a capture of a page holds. A reference page
 * captured with different settings is never carried over.
 */
function settingsHash(ctx, job, extractJs, scale, auth, url) {
    let authState = null;
    try {
        authState = auth ? fs.readFileSync(auth, "utf8") : null;
    }
    catch {
        authState = null;
    }
    return hashOf({
        manifest: MANIFEST_VERSION,
        viewport: ctx.config.viewport,
        scale,
        properties: ctx.config.styles.properties,
        extractJs,
        stabilizeJs: job.stabilizeJs,
        wait: job.wait ?? null,
        waitFor: job.waitFor ?? null,
        auth: authState && hashOf(authState),
        url,
    });
}
/** Each element's extracted computed values. */
function computedByNode(nodes, raw) {
    const out = new Map();
    const visit = (planned, extracted) => {
        planned.forEach((node, i) => {
            out.set(node, extracted[i]?.computed ?? {});
            visit(node.children, extracted[i]?.children ?? []);
        });
    };
    visit(nodes, raw);
    return out;
}
/**
 * Resolve the winning declaration of each tracked property on the elements in
 * `only` (every element when null). `raw` is the tree `nodes` were planned
 * from, index for index.
 */
function elementStyles(nodes, raw, styles, properties, only) {
    const cascade = new Cascade(styles);
    const out = new Map();
    const visit = (planned, extracted) => {
        planned.forEach((node, i) => {
            const source = extracted[i];
            if (!source)
                return;
            if (!only || only.has(node.selector)) {
                out.set(node, cascade.resolveElement(node.selector, properties, source.computed ?? {}));
            }
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
    logSource(ctx);
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
