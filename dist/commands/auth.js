import path from "node:path";
import pc from "picocolors";
import { loadConfig } from "../config.js";
import { resolvePaths } from "../paths.js";
import { requireShotScraper, runAuth } from "../shotscraper.js";
export async function auth(opts) {
    requireShotScraper();
    const paths = resolvePaths(opts.root);
    const config = loadConfig(paths);
    const rel = opts.out ?? config.authFile;
    const outFile = path.isAbsolute(rel) ? rel : path.join(paths.root, rel);
    console.log(pc.bold("Opening a browser for you to log in…"));
    console.log(pc.dim(`  target:  ${opts.url}`));
    console.log(pc.dim(`  saving:  ${outFile}`));
    console.log(pc.dim("  Sign in, then press <enter> in this terminal to save the session."));
    const code = runAuth(opts.url, outFile, paths.root);
    if (code === 0) {
        console.log(pc.green(`✓ auth context saved to ${path.relative(paths.root, outFile)}`));
        console.log(pc.dim("  This file holds live session cookies and is git-ignored."));
    }
    else {
        console.error(pc.red("shot-scraper auth failed."));
    }
    return code;
}
