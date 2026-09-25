#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { init } from "./commands/init.js";
import { shoot } from "./commands/shoot.js";
import { diff } from "./commands/diff.js";
import { review } from "./commands/review.js";
import { auth } from "./commands/auth.js";
import { doctor } from "./commands/doctor.js";
import { clean } from "./commands/clean.js";
import { installHook } from "./commands/installHook.js";
import { inspector } from "./commands/inspector.js";
import { DEFAULT_IMAGE_BRANCH, updatePr } from "./commands/updatePr.js";

const ROOT = process.cwd();

function num(v: string): number {
	const n = Number(v);
	if (Number.isNaN(n)) throw new Error(`Expected a number, got "${v}"`);
	return n;
}

/** Common capture/diff overrides shared by several commands. */
function withCaptureOptions(cmd: Command): Command {
	return cmd
		.option("--base-url <url>", "override the base URL from config")
		.option("--width <px>", "viewport width", num)
		.option("--height <px>", "viewport height", num)
		.option("--wait <ms>", "milliseconds to wait before each capture", num)
		.option("--retina", "capture at 2x (retina); doubles image dimensions")
		.option("--scale-factor <n>", "capture at a specific device pixel scale factor", num)
		.option("--auth <file>", "path to a shot-scraper auth context file")
		.option("--concurrency <n>", "pages captured at once with --by-element", num)
		.option(
			"--by-element",
			"capture every visible block-level element individually into a hierarchy mirroring the page",
		);
}

function withDiffOptions(cmd: Command): Command {
	return cmd
		.option("--threshold <n>", "pixelmatch colour threshold (0-1)", num)
		.option("--max-diff-percent <n>", "page mismatch %% cutoff for pass/fail", num)
		.option("--json", "print a machine-readable JSON report")
		.option("--report <path>", "write JSON report to a file (use - for stdout)");
}

async function run(fn: () => Promise<number>): Promise<void> {
	try {
		const code = await fn();
		process.exitCode = code;
	} catch (err) {
		console.error(pc.red(`\nError: ${(err as Error).message}`));
		process.exitCode = 1;
	}
}

const program = new Command();
program
	.name("tunnelvision")
	.description(
		"Screenshot every page of your app from its sitemap, version the shots by git commit, and diff them visually.",
	)
	.version("0.1.0");

program
	.command("init")
	.description("Initialise tunnelvision in the current project")
	.option("--base-url <url>", "base URL where your app is served")
	.option("-y, --yes", "skip prompts and accept defaults")
	.option("--force", "overwrite an existing config")
	.action((opts) =>
		run(() => init({ root: ROOT, baseUrl: opts.baseUrl, yes: opts.yes, force: opts.force })),
	);

withCaptureOptions(
	program.command("shoot").description("Capture screenshots of every page for the current version"),
).action((opts) =>
	run(() =>
		shoot({
			root: ROOT,
			baseUrl: opts.baseUrl,
			width: opts.width,
			height: opts.height,
			wait: opts.wait,
			retina: opts.retina,
			scaleFactor: opts.scaleFactor,
			auth: opts.auth,
			concurrency: opts.concurrency,
			byElement: opts.byElement,
		}),
	),
);

withDiffOptions(
	program
		.command("diff")
		.description("Diff two captured versions (defaults to current vs previous)")
		.argument("[from]", "baseline version key")
		.argument("[to]", "target version key")
		.option("--base-url <url>", "override base URL (only affects re-resolving current key)")
		.option(
			"--by-element",
			"diff per-element hierarchies (auto-detected from the stored captures)",
		),
).action((from, to, opts) =>
	run(() =>
		diff({
			root: ROOT,
			from,
			to,
			threshold: opts.threshold,
			maxDiffPercent: opts.maxDiffPercent,
			json: opts.json,
			report: opts.report,
		}),
	),
);

withDiffOptions(
	withCaptureOptions(
		program.command("review").description("Capture the current version, then diff it against the previous"),
	),
).action((opts) =>
	run(() =>
		review({
			root: ROOT,
			baseUrl: opts.baseUrl,
			width: opts.width,
			height: opts.height,
			wait: opts.wait,
			retina: opts.retina,
			scaleFactor: opts.scaleFactor,
			auth: opts.auth,
			concurrency: opts.concurrency,
			byElement: opts.byElement,
			threshold: opts.threshold,
			maxDiffPercent: opts.maxDiffPercent,
			json: opts.json,
			report: opts.report,
		}),
	),
);

program
	.command("auth")
	.description("Log in via a browser and save an auth context for authenticated screenshots")
	.argument("<url>", "the login URL to open")
	.option("--out <file>", "where to save the auth context (defaults to config.authFile)")
	.action((url, opts) => run(() => auth({ root: ROOT, url, out: opts.out })));

program
	.command("doctor")
	.description("Check that shot-scraper, git, config and sitemap are ready")
	.action(() => run(() => doctor({ root: ROOT })));

program
	.command("clean")
	.description("Prune stored versions and diffs")
	.option("--keep <n>", "keep only the N most recent versions", num)
	.option("--diffs", "remove all diff outputs")
	.option("--all", "remove all versions and diffs")
	.action((opts) => run(() => clean({ root: ROOT, keep: opts.keep, diffsOnly: opts.diffs, all: opts.all })));

program
	.command("install-hook")
	.description("Install an opt-in git post-commit hook that runs `review`")
	.option("--force", "append to an existing post-commit hook")
	.action((opts) => run(() => installHook({ root: ROOT, force: opts.force })));

program
	.command("inspector")
	.description("Start a local web UI for exploring per-element diffs as a visual tree")
	.option("--port <n>", "port to listen on", num, 4173)
	.option("--host <host>", "interface to bind", "127.0.0.1")
	.option("--open", "open the inspector in your browser")
	.option("--threshold <n>", "pixelmatch colour threshold (0-1)", num)
	.option("--max-diff-percent <n>", "element mismatch % cutoff for changed", num)
	.action((opts) =>
		run(() =>
			inspector({
				root: ROOT,
				port: opts.port,
				host: opts.host,
				open: opts.open,
				threshold: opts.threshold,
				maxDiffPercent: opts.maxDiffPercent,
			}),
		),
	);

program
	.command("update-pr")
	.description("Comment on a GitHub PR with per-element visual diffs, anchored at each element's source line")
	.argument("[from]", "baseline version key (defaults to the PR's merge base, else the previous capture)")
	.argument("[to]", "target version key (defaults to the current HEAD)")
	.option("--pr <n>", "pull request number (defaults to the open PR for the current branch)", num)
	.option("--remote <name>", "git remote of the GitHub repository", "origin")
	.option("--branch <name>", "orphan branch that hosts the images", DEFAULT_IMAGE_BRANCH)
	.option("--threshold <n>", "pixelmatch colour threshold (0-1)", num)
	.option("--max-diff-percent <n>", "element mismatch %% cutoff for changed", num)
	.option("--dry-run", "print the comments without pushing images or posting")
	.action((from, to, opts) =>
		run(() =>
			updatePr({
				root: ROOT,
				from,
				to,
				pr: opts.pr,
				remote: opts.remote,
				branch: opts.branch,
				threshold: opts.threshold,
				maxDiffPercent: opts.maxDiffPercent,
				dryRun: opts.dryRun,
			}),
		),
	);

program.parseAsync(process.argv);
