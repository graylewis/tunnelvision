import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { execFileSync } from "node:child_process";
import { isGitRepo } from "../git.js";
const MARKER = "# >>> tunnelvision post-commit >>>";
// Run the project-local binary via the project's package manager. The hook
// only fires when node_modules/.bin/tunnelvision exists, and the no-install
// flags back that up so a commit never fetches tunnelvision from the registry.
// pnpm uses `exec` because `pnpx` is an alias for `pnpm dlx`, which always
// downloads and ignores the local install.
const RUNNERS = {
    npm: { bin: "npx", command: "npx --no tunnelvision" },
    pnpm: { bin: "pnpm", command: "pnpm exec tunnelvision" },
    bun: { bin: "bunx", command: "bunx --no-install tunnelvision" },
};
function detectRunner(root) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        const name = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
        if (name in RUNNERS)
            return RUNNERS[name];
    }
    catch {
        // No readable package.json — fall through to lockfile detection.
    }
    const has = (f) => fs.existsSync(path.join(root, f));
    if (has("bun.lock") || has("bun.lockb"))
        return RUNNERS.bun;
    if (has("pnpm-lock.yaml"))
        return RUNNERS.pnpm;
    return RUNNERS.npm;
}
function hookBody(runner) {
    return `#!/bin/sh
${MARKER}
# Runs a visual review after each commit. Remove this block to disable.
if [ -x node_modules/.bin/tunnelvision ] && command -v ${runner.bin} >/dev/null 2>&1; then
  ${runner.command} review || true
fi
# <<< tunnelvision post-commit <<<
`;
}
function gitDir(root) {
    try {
        const out = execFileSync("git", ["rev-parse", "--git-dir"], {
            cwd: root,
            encoding: "utf8",
        }).trim();
        return path.isAbsolute(out) ? out : path.join(root, out);
    }
    catch {
        return null;
    }
}
export async function installHook(opts) {
    if (!isGitRepo(opts.root)) {
        console.error(pc.red("Not a git repository — cannot install a git hook here."));
        return 1;
    }
    const gd = gitDir(opts.root);
    if (!gd) {
        console.error(pc.red("Could not locate the .git directory."));
        return 1;
    }
    const hooksDir = path.join(gd, "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, "post-commit");
    const runner = detectRunner(opts.root);
    const body = hookBody(runner);
    if (fs.existsSync(hookPath)) {
        const existing = fs.readFileSync(hookPath, "utf8");
        if (existing.includes(MARKER)) {
            console.log(pc.yellow("post-commit hook already contains the tunnelvision block."));
            return 0;
        }
        if (!opts.force) {
            console.error(pc.red(`A post-commit hook already exists at ${hookPath}.\n` +
                "Re-run with --force to append the tunnelvision block to it."));
            return 1;
        }
        // Append our block to the existing hook.
        const appended = `${existing.replace(/\n*$/, "\n")}\n${body.replace(/^#!\/bin\/sh\n/, "")}`;
        fs.writeFileSync(hookPath, appended, "utf8");
    }
    else {
        fs.writeFileSync(hookPath, body, "utf8");
    }
    fs.chmodSync(hookPath, 0o755);
    console.log(pc.green(`✓ installed post-commit hook at ${path.relative(opts.root, hookPath)}`));
    console.log(pc.dim(`  It runs \`${runner.command} review\` after each commit. Delete the block to disable.`));
    return 0;
}
