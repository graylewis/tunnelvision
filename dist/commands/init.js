import prompts from "prompts";
import pc from "picocolors";
import { DEFAULT_CONFIG, configExists, saveConfig } from "../config.js";
import { ensureGitignore } from "../gitignore.js";
import { resolvePaths } from "../paths.js";
export async function init(opts) {
    const paths = resolvePaths(opts.root);
    if (configExists(paths) && !opts.force) {
        console.error(pc.yellow(`tunnelvision is already initialised (${paths.config}). Use --force to overwrite.`));
        return 1;
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
    console.log(pc.dim("Next: start your app, then run `tunnelvision shoot` (or `review`)."));
    return 0;
}
