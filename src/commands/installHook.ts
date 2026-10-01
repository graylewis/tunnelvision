import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { execFileSync } from "node:child_process";
import { isGitRepo } from "../git.js";
import { ensureNotifier, notify } from "../notify.js";

export interface InstallHookOptions {
	root: string;
	force?: boolean;
}

const MARKER = "# >>> tunnelvision post-commit >>>";
const END_MARKER = "# <<< tunnelvision post-commit <<<";

interface Runner {
	bin: string;
	command: string;
}

// Run the project-local binary via the project's package manager. The hook
// only fires when node_modules/.bin/tunnelvision exists, and the no-install
// flags back that up so a commit never fetches tunnelvision from the registry.
// pnpm uses `exec` because `pnpx` is an alias for `pnpm dlx`, which always
// downloads and ignores the local install.
const RUNNERS = {
	npm: { bin: "npx", command: "npx --no tunnelvision" },
	pnpm: { bin: "pnpm", command: "pnpm exec tunnelvision" },
	bun: { bin: "bunx", command: "bunx --no-install tunnelvision" },
} satisfies Record<string, Runner>;

function detectRunner(root: string): Runner {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
		const name = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
		if (name in RUNNERS) return RUNNERS[name as keyof typeof RUNNERS];
	} catch {
		// No readable package.json — fall through to lockfile detection.
	}
	const has = (f: string) => fs.existsSync(path.join(root, f));
	if (has("bun.lock") || has("bun.lockb")) return RUNNERS.bun;
	if (has("pnpm-lock.yaml")) return RUNNERS.pnpm;
	return RUNNERS.npm;
}

// The review runs detached, so the commit returns at once; its output goes to
// .tunnelvision/review.log and a desktop notification says when it's done.
function hookBody(runner: Runner): string {
	return `#!/bin/sh
${MARKER}
# Runs a visual review in the background after each commit and sends a
# desktop notification when it's done. Remove this block to disable.
if [ -x node_modules/.bin/tunnelvision ] && command -v ${runner.bin} >/dev/null 2>&1; then
  mkdir -p .tunnelvision
  nohup ${runner.command} review --notify >.tunnelvision/review.log 2>&1 </dev/null &
  if [ -t 2 ]; then b='\\033[1;36m' d='\\033[2m' r='\\033[0m'; else b='' d='' r=''; fi
  printf '\\n%b━━ tunnelvision ━━%b\\n' "$b" "$r" >&2
  printf '%b▶ Reviewing this commit in the background.%b\\n' "$b" "$r" >&2
  printf "  You'll get a notification when it's done.\\n" >&2
  printf '%b  log: .tunnelvision/review.log%b\\n\\n' "$d" "$r" >&2
fi
${END_MARKER}
`;
}

function gitDir(root: string): string | null {
	try {
		const out = execFileSync("git", ["rev-parse", "--git-dir"], {
			cwd: root,
			encoding: "utf8",
		}).trim();
		return path.isAbsolute(out) ? out : path.join(root, out);
	} catch {
		return null;
	}
}

/** Whether the project's post-commit hook holds a tunnelvision block (of any version). */
export function hookInstalled(root: string): boolean {
	const gd = gitDir(root);
	if (!gd) return false;
	const hookPath = path.join(gd, "hooks", "post-commit");
	if (!fs.existsSync(hookPath)) return false;
	return fs.readFileSync(hookPath, "utf8").includes(MARKER);
}

export async function installHook(opts: InstallHookOptions): Promise<number> {
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

	const block = body.replace(/^#!\/bin\/sh\n/, "");
	if (fs.existsSync(hookPath)) {
		const existing = fs.readFileSync(hookPath, "utf8");
		const start = existing.indexOf(MARKER);
		const end = existing.indexOf(END_MARKER, start);
		if (start !== -1 && end !== -1) {
			const current = existing.slice(start, end + END_MARKER.length + 1);
			if (current === block) {
				console.log(pc.yellow("post-commit hook already contains the tunnelvision block."));
				return 0;
			}
			// An older tunnelvision block: replace it in place.
			fs.writeFileSync(hookPath, existing.slice(0, start) + block + existing.slice(start + current.length), "utf8");
			console.log(pc.green(`✓ updated the tunnelvision block in ${path.relative(opts.root, hookPath)}`));
			setUpNotifications();
			return 0;
		}
		if (!opts.force) {
			console.error(
				pc.red(
					`A post-commit hook already exists at ${hookPath}.\n` +
						"Re-run with --force to append the tunnelvision block to it.",
				),
			);
			return 1;
		}
		// Append our block to the existing hook.
		const appended = `${existing.replace(/\n*$/, "\n")}\n${block}`;
		fs.writeFileSync(hookPath, appended, "utf8");
	} else {
		fs.writeFileSync(hookPath, body, "utf8");
	}
	fs.chmodSync(hookPath, 0o755);

	console.log(pc.green(`✓ installed post-commit hook at ${path.relative(opts.root, hookPath)}`));
	console.log(
		pc.dim(`  It runs \`${runner.command} review --notify\` in the background after each commit. Delete the block to disable.`),
	);
	setUpNotifications();
	return 0;
}

/**
 * Build the notifier now and send a first notification, so macOS asks for
 * permission at install time rather than after the first commit.
 */
function setUpNotifications(): void {
	if (process.platform === "darwin" && !ensureNotifier()) {
		console.log(
			pc.yellow("  Notifications won't have buttons: building them needs Swift (`xcode-select --install`)."),
		);
	}
	const sent = notify({
		title: "tunnelvision",
		body: "You'll get a notification here when a background review finishes.",
	});
	if (sent && process.platform === "darwin") {
		console.log(pc.dim("  If macOS asks whether tunnelvision may send notifications, allow it."));
	} else if (!sent) {
		console.log(pc.yellow("  Couldn't send a desktop notification; check .tunnelvision/review.log after commits."));
	}
}
