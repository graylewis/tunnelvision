import path from "node:path";
import pc from "picocolors";
import { loadConfig } from "../config.js";
import { resolvePaths } from "../paths.js";
import { saveAuth } from "../playwright.js";

export interface AuthOptions {
	root: string;
	url: string;
	/** Where to write the auth context; defaults to config.authFile. */
	out?: string;
}

export async function auth(opts: AuthOptions): Promise<number> {
	const paths = resolvePaths(opts.root);
	const config = loadConfig(paths);

	const rel = opts.out ?? config.authFile;
	const outFile = path.isAbsolute(rel) ? rel : path.join(paths.root, rel);

	console.log(pc.bold("Opening a browser for you to log in…"));
	console.log(pc.dim(`  target:  ${opts.url}`));
	console.log(pc.dim(`  saving:  ${outFile}`));
	console.log(pc.dim("  Sign in, then press <enter> in this terminal to save the session."));

	try {
		await saveAuth(opts.url, outFile);
	} catch (err) {
		console.error(pc.red(`Couldn't save the session: ${(err as Error).message}`));
		return 1;
	}
	console.log(pc.green(`✓ auth context saved to ${path.relative(paths.root, outFile)}`));
	console.log(pc.dim("  This file holds live session cookies and is git-ignored."));
	return 0;
}
