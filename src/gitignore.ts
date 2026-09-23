import fs from "node:fs";
import path from "node:path";
import { DIR } from "./paths.js";

const ENTRY = `${DIR}/`;

/**
 * Ensure the project's .gitignore ignores the .tunnelvision directory.
 * Returns true if the file was created or modified.
 */
export function ensureGitignore(root: string): boolean {
	const file = path.join(root, ".gitignore");
	let content = "";
	if (fs.existsSync(file)) {
		content = fs.readFileSync(file, "utf8");
		const lines = content.split(/\r?\n/).map((l) => l.trim());
		if (lines.includes(ENTRY) || lines.includes(DIR) || lines.includes(`/${ENTRY}`)) {
			return false;
		}
	}
	const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
	const block = `${prefix}\n# tunnelvision screenshots & diffs (local cache)\n${ENTRY}\n`;
	fs.writeFileSync(file, content + block, "utf8");
	return true;
}
