import fs from "node:fs";
import path from "node:path";
import prompts from "prompts";
import pc from "picocolors";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../config.js";
import { ensureGitignore } from "../gitignore.js";
import { resolvePaths } from "../paths.js";
export async function init(opts) {
    const paths = resolvePaths(opts.root);
    if (fs.existsSync(paths.config) && !opts.force) {
        console.error(pc.yellow(`tunnelvision is already initialised (${paths.config}). Use --force to overwrite.`));
        return 1;
    }
    // A config from before it was committed: move it to the root, settings intact.
    if (fs.existsSync(paths.legacyConfig) && !opts.force) {
        const config = loadConfig(paths);
        saveConfig(paths, config);
        fs.unlinkSync(paths.legacyConfig);
        const rel = (p) => path.relative(opts.root, p);
        console.log(pc.green(`✓ moved ${rel(paths.legacyConfig)} to ${rel(paths.config)}`));
        console.log(pc.dim(`  base URL:  ${config.baseUrl}`));
        console.log(pc.dim(`  commit ${rel(paths.config)} so the whole team shares the same settings.`));
        return 0;
    }
    let baseUrl = opts.baseUrl ?? DEFAULT_CONFIG.baseUrl;
    const interactive = process.stdout.isTTY && !opts.yes && opts.baseUrl === undefined;
    if (interactive) {
        const answer = await prompts({
            type: "text",
            name: "baseUrl",
            message: "Base URL where your app is served",
            initial: DEFAULT_CONFIG.baseUrl,
        });
        if (answer.baseUrl === undefined) {
            console.error(pc.red("Cancelled."));
            return 1;
        }
        baseUrl = String(answer.baseUrl).trim() || DEFAULT_CONFIG.baseUrl;
    }
    const config = { ...DEFAULT_CONFIG, baseUrl };
    saveConfig(paths, config);
    const changed = ensureGitignore(opts.root);
    console.log(pc.green("✓ tunnelvision initialised"));
    console.log(pc.dim(`  config:    ${paths.config}`));
    console.log(pc.dim(`  base URL:  ${baseUrl}`));
    console.log(pc.dim(`  .gitignore ${changed ? "updated" : "already covers .tunnelvision/"}`));
    console.log("");
    console.log(pc.dim(`Commit ${path.relative(opts.root, paths.config)}: it holds the settings the whole team shares.`));
    console.log(pc.dim("Next: start your app, then run `tunnelvision shoot` (or `review`)."));
    return 0;
}
