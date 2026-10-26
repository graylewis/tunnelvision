import pc from "picocolors";
import { CONFIG_FILE, existingConfig, resolvePaths } from "../paths.js";
import { isGitRepo } from "../git.js";
import { hookInstalled } from "./installHook.js";
import { discoverPages } from "../pagesource.js";
import { FRAMEWORK_NAMES } from "../fileroutes.js";
import { checkPlaywright } from "../playwright.js";
import { loadConfig } from "../config.js";
import { loadPlugins } from "../state.js";
import { environmentVersions, versionChanges } from "../environment.js";
import { cssPipeline } from "../stylemaps.js";
import fs from "node:fs";
import path from "node:path";
/** Dependencies that make Vite transform CSS, so its lines no longer match the source without a source map. */
const CSS_TOOLS = ["tailwindcss", "@tailwindcss/vite", "@tailwindcss/postcss", "postcss", "sass", "sass-embedded", "less", "stylus"];
/**
 * Why CSS changes can't be traced to their lines, if they can't: a Vite
 * project that processes its CSS without `css.devSourcemap`.
 */
function cssSourcemapProblem(root) {
    // Astro keeps Vite's options under `vite:` in its own config.
    const viteConfig = ["vite", "astro"]
        .flatMap((tool) => ["ts", "js", "mjs", "mts"].map((ext) => path.join(root, `${tool}.config.${ext}`)))
        .find((f) => fs.existsSync(f));
    if (!viteConfig)
        return null;
    let deps = {};
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        deps = { ...pkg.dependencies, ...pkg.devDependencies };
    }
    catch {
        // no package.json
    }
    const tools = CSS_TOOLS.filter((t) => t in deps);
    const postcss = fs.readdirSync(root).some((f) => /^postcss\.config\./.test(f));
    if (tools.length === 0 && !postcss)
        return null;
    if (/devSourcemap\s*:\s*true/.test(fs.readFileSync(viteConfig, "utf8")))
        return null;
    return `${path.basename(viteConfig)} processes CSS (${[...tools, ...(postcss ? ["postcss config"] : [])].join(", ")}) without \`css: { devSourcemap: true }\``;
}
export async function doctor(opts) {
    const paths = resolvePaths(opts.root);
    let ok = true;
    const line = (good, label, detail) => {
        const mark = good ? pc.green("✓") : pc.red("✗");
        console.log(`  ${mark} ${label}${detail ? pc.dim(`  ${detail}`) : ""}`);
        if (!good)
            ok = false;
    };
    console.log(pc.bold("tunnelvision doctor"));
    console.log("");
    // Playwright's Chromium, which every capture runs in
    const browser = checkPlaywright();
    line(browser.installed, "playwright chromium", browser.installed ? undefined : browser.detail);
    if (!browser.installed) {
        console.log(pc.dim("      npx playwright install chromium"));
    }
    // config
    const config = existingConfig(paths);
    line(Boolean(config), "config", config ?? "run `tunnelvision init`");
    if (config === paths.legacyConfig) {
        console.log(pc.dim(`      it's git-ignored there; \`tunnelvision init\` moves it to ${CONFIG_FILE} so it can be committed`));
    }
    // state plugins: none is fine; one that doesn't load fails every capture
    if (config) {
        try {
            const { plugins } = loadConfig(paths);
            if (plugins.length) {
                const loaded = await loadPlugins(paths.root, plugins).catch((err) => err);
                if (loaded instanceof Error)
                    line(false, "state plugins", loaded.message);
                else
                    line(true, "state plugins", loaded.map((p) => `${p.name} ${p.version}`).join(", "));
            }
        }
        catch {
            // the config line above covers a config that doesn't load
        }
    }
    // git
    const git = isGitRepo(opts.root);
    line(git, "git repo", git ? "versions keyed by commit SHA" : "will use timestamp keys");
    // post-commit hook: opt-in, so its absence isn't a failure
    if (git) {
        const hook = hookInstalled(opts.root);
        const mark = hook ? pc.green("✓") : pc.dim("·");
        const detail = hook ? "reviews each commit in the background" : "not installed; `tunnelvision install-hook` reviews each commit in the background";
        console.log(`  ${mark} post-commit hook${pc.dim(`  ${detail}`)}`);
    }
    // pages: Next.js / Astro routes, else the sitemap
    try {
        const source = discoverPages(opts.root);
        const label = source.kind === "sitemap" ? "sitemap" : `${FRAMEWORK_NAMES[source.kind].toLowerCase()} routes`;
        line(true, label, `${source.locs.length} pages from ${source.from}`);
        for (const note of source.notes)
            console.log(pc.dim(`      ${note}`));
    }
    catch (err) {
        line(false, "sitemap", err.message.split("\n")[0]);
    }
    // CSS source maps (tracing visual changes back to CSS lines)
    const css = cssSourcemapProblem(opts.root);
    if (css) {
        console.log(`  ${pc.yellow("!")} css source maps${pc.dim(`  ${css}`)}`);
        console.log(pc.dim("      visual changes can't be traced to CSS lines until it's set"));
    }
    const pipeline = cssPipeline(opts.root);
    if (pipeline.turbopack && pipeline.postcssConfig) {
        let rebuild = false;
        try {
            rebuild = config ? loadConfig(paths).workarounds.turbopackPostcssMaps : false;
        }
        catch {
            // the config line already reported it
        }
        const file = path.basename(pipeline.postcssConfig);
        if (rebuild) {
            console.log(`  ${pc.green("✓")} css source maps${pc.dim("  rebuilt from PostCSS for Turbopack (workarounds.turbopackPostcssMaps)")}`);
        }
        else {
            console.log(`  ${pc.yellow("!")} css source maps${pc.dim(`  Turbopack drops PostCSS's source maps, so CSS run through ${file} likely can't be traced to its lines`)}`);
            console.log(pc.dim("      a capture confirms it; `workarounds.turbopackPostcssMaps: true` in tunnelvision.json rebuilds them"));
        }
    }
    // cheat mode: opt-in, so being off isn't a failure; being stale is worth a look
    if (config) {
        try {
            const { cheatMode: { enabled, validatedWith }, plugins } = loadConfig(paths);
            const changes = enabled && validatedWith ? versionChanges(validatedWith, environmentVersions(opts.root, plugins)) : [];
            if (!enabled) {
                console.log(`  ${pc.dim("·")} cheat mode${pc.dim("  off; /setup-tunnelvision checks whether this project can use it")}`);
            }
            else if (!validatedWith || changes.length > 0) {
                console.log(`  ${pc.yellow("!")} cheat mode${pc.dim(`  needs validating again (${validatedWith ? changes.join(", ") : "never validated"}); captures run normally until then`)}`);
            }
            else {
                console.log(`  ${pc.green("✓")} cheat mode${pc.dim("  on; unchanged pages are carried over without a screenshot")}`);
            }
        }
        catch {
            // the config line already reported it
        }
    }
    console.log("");
    console.log(ok ? pc.green("All good.") : pc.yellow("Some checks need attention."));
    return ok ? 0 : 1;
}
