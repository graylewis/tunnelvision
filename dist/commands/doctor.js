import pc from "picocolors";
import { configExists } from "../config.js";
import { resolvePaths } from "../paths.js";
import { isGitRepo } from "../git.js";
import { checkShotScraper } from "../shotscraper.js";
import { discoverPages } from "../pagesource.js";
import { FRAMEWORK_NAMES } from "../fileroutes.js";
import { findPlaywrightPython } from "../playwright.js";
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
    // shot-scraper
    const ss = checkShotScraper();
    line(ss.installed, "shot-scraper", ss.installed ? ss.version : "not found");
    if (!ss.installed) {
        console.log(pc.dim("      pip install shot-scraper && shot-scraper install"));
    }
    // Playwright (used directly for per-element captures)
    let python = null;
    try {
        python = findPlaywrightPython();
    }
    catch {
        // reported below
    }
    line(Boolean(python), "playwright (for per-element captures)", python ?? "not found next to shot-scraper");
    // config
    line(configExists(paths), "config", configExists(paths) ? paths.config : "run `tunnelvision init`");
    // git
    const git = isGitRepo(opts.root);
    line(git, "git repo", git ? "versions keyed by commit SHA" : "will use timestamp keys");
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
    console.log("");
    console.log(ok ? pc.green("All good.") : pc.yellow("Some checks need attention."));
    return ok ? 0 : 1;
}
