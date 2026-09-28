import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import { PNG } from "pngjs";
import type { Overrides } from "../config.js";
import { ELEMENT_IMAGE, ElementImages } from "../elements.js";
import { currentBranch, isGitRepo, mergeBase, remoteUrl, topLevel } from "../git.js";
import { GitHub, parseRepo, resolveToken, type NewReviewComment, type PullRequest } from "../github.js";
import { publishImages, type ImageUpload } from "../imagebranch.js";
import { diffDir, resolvePaths, versionDir, type Paths } from "../paths.js";
import type { ComponentSource } from "../reactsource.js";
import { readMeta, versionExists } from "../versions.js";
import { resolvePair } from "./diff.js";
import { buildDiff, CHANGE_STATUSES, type InspectorNode, type InspectorPage } from "./inspector.js";

/**
 * `tunnelvision update-pr` — annotate a GitHub pull request with visual diffs.
 *
 * Every changed element whose React source line is part of the PR's diff gets
 * an inline review comment on that line, with the essentials from the
 * inspector (status, mismatch, selector, match, rect, owner chain) and its
 * before / after / diff screenshots. The screenshots are committed to a shared
 * orphan branch so the comments can link to them. Elements whose source line
 * isn't in the diff are skipped, since GitHub can't anchor a comment there.
 *
 * Comments carry a hidden marker, so running it again edits them in place
 * rather than posting duplicates.
 */

export interface UpdatePrOptions extends Overrides {
	root: string;
	from?: string;
	to?: string;
	/** PR number; defaults to the open PR for the current branch. */
	pr?: number;
	remote?: string;
	/** Branch that hosts the images. */
	branch?: string;
	/** Print the comments instead of pushing images and posting. */
	dryRun?: boolean;
}

export const DEFAULT_IMAGE_BRANCH = "tunnelvision-assets";
/** Elements sharing one source line (list items, chart bars) that get screenshots; the rest are listed. */
const MAX_SHOWN = 3;
const MAX_OWNERS = 4;

const MATCHED_BY: Record<string, string> = {
	id: "id",
	key: "React key",
	component: "component + source file",
	name: "name attribute",
	source: "source line",
	order: "order among similar siblings",
	"tag-order": "order among siblings with the same tag",
};

interface Target {
	page: InspectorPage;
	node: InspectorNode;
	/** Where its images are stored on the image branch, relative to the run's folder. */
	dest: string;
}

/** A diff line that one or more changed elements point at. */
interface Anchor {
	path: string;
	line: number;
	/** Removed elements point at the baseline's source, so they anchor on the old side. */
	side: "LEFT" | "RIGHT";
	targets: Target[];
}

function realpath(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
}

/** Resolve a component source to a path relative to the repository root, or null if it's outside. */
function repoPath(src: ComponentSource | null, root: string, top: string): string | null {
	if (!src || src.generated || /^[a-z]+:\/\//i.test(src.fileName)) return null;
	const abs = realpath(path.isAbsolute(src.fileName) ? src.fileName : path.join(root, src.fileName));
	const rel = path.relative(top, abs);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
	return rel.split(path.sep).join("/");
}

function walk(nodes: InspectorNode[], visit: (n: InspectorNode) => void): void {
	for (const n of nodes) {
		visit(n);
		walk(n.children, visit);
	}
}

/** Table cells can't hold pipes or newlines. */
function cell(s: string): string {
	return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function label(n: InspectorNode): string {
	let s = n.tag;
	if (n.id) s += `#${n.id}`;
	if (n.className) {
		const classes = n.className.split(/\s+/).filter(Boolean);
		s += `.${classes.slice(0, 2).join(".")}${classes.length > 2 ? "…" : ""}`;
	}
	return s;
}

function rectText(r: InspectorNode["rect"]["from"]): string {
	return r ? `${r.width}×${r.height} @ ${r.x},${r.y}` : "—";
}

interface BodyContext {
	gh: GitHub;
	pr: PullRequest;
	from: string;
	to: string;
	root: string;
	top: string;
	/** Commit on the image branch, or null in a dry run (local paths are shown instead). */
	imageCommit: string | null;
	imageBase: string;
	/** Absolute local paths per uploaded dest, for dry runs. */
	local: Map<string, string>;
}

function sourceLink(src: ComponentSource | null, ctx: BodyContext): string {
	if (!src) return "—";
	const rel = repoPath(src, ctx.root, ctx.top);
	if (!rel) return `\`${cell(src.path)}\``;
	const url = `https://github.com/${ctx.gh.repo.owner}/${ctx.gh.repo.name}/blob/${ctx.pr.head.sha}/${rel}#L${src.lineNumber}`;
	return `[\`${cell(`${rel}:${src.lineNumber}`)}\`](${url})`;
}

function image(dest: string | null, alt: string, ctx: BodyContext): string {
	if (!dest) return "—";
	const file = `${ctx.imageBase}/${dest}`;
	const src = ctx.imageCommit ? ctx.gh.imageUrl(ctx.imageCommit, file) : ctx.local.get(file)!;
	return `<img src="${src}" alt="${alt}" />`;
}

function targetSection(t: Target, ctx: BodyContext): string {
	const { node: n, page } = t;
	const pct = n.diffPercent !== undefined ? ` · ${n.diffPercent.toFixed(3)}% mismatch` : "";
	const rows: [string, string][] = [];
	rows.push(["page", page.url ? `[\`${cell(page.slug)}\`](${page.url})` : `\`${cell(page.slug)}\``]);
	rows.push(["selector", `\`${cell(n.selector)}\``]);
	rows.push(["path", `\`${cell(`${page.slug}/${n.dir}`)}\``]);
	if (n.fromDir && n.fromDir !== n.dir) {
		rows.push(["was at", `\`${cell(`${page.slug}/${n.fromDir}`)}\`${n.moved ? " (moved to a different parent)" : ""}`]);
	}
	if (n.matchedBy) rows.push(["matched by", MATCHED_BY[n.matchedBy] ?? n.matchedBy.replace(/^attr:/, "")]);
	if (n.message) rows.push(["note", cell(n.message)]);
	rows.push(["rect", `before ${rectText(n.rect.from)}<br>after ${rectText(n.rect.to)}`]);
	const owners = n.component?.components ?? [];
	if (owners.length) {
		const chain = owners
			.slice(0, MAX_OWNERS)
			.map((o) => `\`<${cell(o.name)}>\`${o.source ? ` ${sourceLink(o.source, ctx)}` : ""}`)
			.join(" ← ");
		rows.push(["rendered by", chain + (owners.length > MAX_OWNERS ? " ← …" : "")]);
	}

	const has = n.images;
	return [
		`#### \`${cell(label(n))}\` — ${n.status}${pct}`,
		"",
		"| | |",
		"|---|---|",
		...rows.map(([k, v]) => `| **${k}** | ${v} |`),
		"",
		`| Before · \`${ctx.from}\` | After · \`${ctx.to}\` | Diff |`,
		"|:-:|:-:|:-:|",
		`| ${image(has.from ? `${t.dest}/before.png` : null, "before", ctx)} | ${image(has.to ? `${t.dest}/after.png` : null, "after", ctx)} | ${image(has.diff ? `${t.dest}/diff.png` : null, "diff", ctx)} |`,
	].join("\n");
}

function marker(a: Anchor): string {
	return `<!-- tunnelvision:${a.side}:${a.path}:${a.line} -->`;
}

function commentBody(a: Anchor, ctx: BodyContext): string {
	const shown = a.targets.slice(0, MAX_SHOWN);
	const rest = a.targets.slice(MAX_SHOWN);
	const count = a.targets.length;
	const parts = [
		marker(a),
		`### tunnelvision · ${count} visual change${count === 1 ? "" : "s"} from this line`,
		`Comparing \`${ctx.from}\` → \`${ctx.to}\`.`,
		"",
		...shown.flatMap((t) => [targetSection(t, ctx), ""]),
	];
	if (rest.length) {
		parts.push(
			`<details><summary>…and ${rest.length} more</summary>\n\n` +
				rest.map((t) => `- \`${cell(label(t.node))}\` ${t.node.status} — \`${t.page.slug}/${t.node.dir}\``).join("\n") +
				"\n</details>",
		);
	}
	return parts.join("\n").trimEnd();
}

/** The baseline for a PR: the capture at the merge base with its base branch, when there is one. */
function prBaseline(paths: Paths, remote: string, pr: PullRequest): string | undefined {
	for (const rev of [pr.base.sha, `${remote}/${pr.base.ref}`]) {
		const sha = mergeBase(paths.root, "HEAD", rev);
		if (sha && versionExists(paths, sha)) return sha;
	}
	return undefined;
}

export async function updatePr(opts: UpdatePrOptions): Promise<number> {
	const paths = resolvePaths(opts.root);
	if (!isGitRepo(paths.root)) throw new Error("update-pr must be run inside a git repository.");
	const top = realpath(topLevel(paths.root)!);
	const remote = opts.remote ?? "origin";
	const branch = opts.branch ?? DEFAULT_IMAGE_BRANCH;
	const url = remoteUrl(paths.root, remote);
	if (!url) throw new Error(`No git remote named "${remote}". Pass --remote <name>.`);

	const gh = new GitHub(resolveToken(), parseRepo(url));
	let pr: PullRequest;
	if (opts.pr) {
		pr = await gh.getPull(opts.pr);
	} else {
		const head = currentBranch(paths.root);
		if (!head) throw new Error("HEAD is detached. Pass the PR number with --pr <n>.");
		const found = await gh.findPullForBranch(head);
		if (!found) throw new Error(`No open pull request for branch "${head}". Pass --pr <n>.`);
		pr = found;
	}
	console.log(pc.bold(`PR #${pr.number}`) + pc.dim(` ${pr.title}  ${pr.html_url}`));

	const { from, to } = resolvePair({ ...opts, from: opts.from ?? prBaseline(paths, remote, pr) }, paths);
	for (const key of [from, to]) {
		if (!versionExists(paths, key)) throw new Error(`Version "${key}" not found under ${paths.versions}.`);
	}
	console.log(pc.dim(`  comparing ${from} → ${to}`));

	// Line numbers come from the target capture, so they only line up with the PR if it's the head commit.
	const toSha = readMeta(paths, to)?.sha ?? to.replace(/-dirty$/, "");
	if (to.endsWith("-dirty")) {
		console.log(pc.yellow(`  ${to} was captured with uncommitted changes; source lines may not match the PR.`));
	} else if (!pr.head.sha.startsWith(toSha)) {
		console.log(pc.yellow(`  ${to} isn't the PR head (${pr.head.sha.slice(0, 7)}); source lines may not match.`));
	}

	const data = buildDiff(paths, opts, from, to);
	if (!data.pages.some((p) => p.byElement)) {
		throw new Error("update-pr needs per-element captures. Re-capture both versions with `--by-element`.");
	}

	const lines = await gh.commentableLines(pr.number);
	const anchors = new Map<string, Anchor>();
	let changed = 0;
	let noSource = 0;
	let offDiff = 0;
	for (const page of data.pages) {
		walk(page.elements, (node) => {
			if (!CHANGE_STATUSES.has(node.status)) return;
			changed++;
			const src = node.component?.source ?? null;
			const file = repoPath(src, paths.root, top);
			if (!src || !file) {
				noSource++;
				return;
			}
			const side = node.status === "removed" ? "LEFT" : "RIGHT";
			if (!(side === "LEFT" ? lines.left : lines.right).get(file)?.has(src.lineNumber)) {
				offDiff++;
				return;
			}
			const key = `${side}:${file}:${src.lineNumber}`;
			const anchor = anchors.get(key) ?? { path: file, line: src.lineNumber, side, targets: [] };
			anchor.targets.push({ page, node, dest: `${page.slug}/${node.uid.replace(/^removed:/, "removed/")}` });
			anchors.set(key, anchor);
		});
	}

	const summary = pc.dim(`  ${changed} changed elements · ${noSource} without a source location · ${offDiff} outside the PR diff`);
	if (anchors.size === 0) {
		console.log(summary);
		console.log(pc.green("  Nothing to comment on."));
		return 0;
	}

	// Only the elements that get screenshots in a comment are uploaded. Their
	// before/after images are cropped from the page screenshots into a scratch
	// directory, which is kept for a dry run so the printed paths stay valid.
	const imageBase = `pr-${pr.number}/${from}__${to}`;
	const uploads: ImageUpload[] = [];
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tunnelvision-pr-"));
	const images = new ElementImages();
	for (const a of anchors.values()) {
		for (const t of a.targets.slice(0, MAX_SHOWN)) {
			const { node, page } = t;
			const add = (file: string, name: string) => uploads.push({ file, dest: `${imageBase}/${t.dest}/${name}` });
			const crop = (version: string, dir: string, name: string) => {
				const png = images.crop(path.join(versionDir(paths, version), page.slug), dir);
				if (!png) return;
				const file = path.join(scratch, ...t.dest.split("/"), name);
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, PNG.sync.write(png));
				add(file, name);
			};
			if (node.images.from) crop(from, node.fromDir ?? node.dir, "before.png");
			if (node.images.to) crop(to, node.dir, "after.png");
			if (node.images.diff) add(path.join(diffDir(paths, from, to), page.slug, ...node.dir.split("/"), ELEMENT_IMAGE), "diff.png");
		}
	}

	const ctx: BodyContext = {
		gh,
		pr,
		from,
		to,
		root: paths.root,
		top,
		imageCommit: null,
		imageBase,
		local: new Map(uploads.map((u) => [u.dest, u.file])),
	};
	const sorted = [...anchors.values()].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);

	if (opts.dryRun) {
		for (const a of sorted) {
			console.log("");
			console.log(pc.cyan(`── ${a.path}:${a.line} (${a.side})`));
			console.log(commentBody(a, ctx));
		}
		console.log("");
		console.log(summary);
		console.log(pc.dim(`  dry run: would push ${uploads.length} images to ${branch} and post ${sorted.length} comments`));
		return 0;
	}

	try {
		ctx.imageCommit = publishImages(top, remote, branch, uploads, `tunnelvision: PR #${pr.number} ${from} → ${to}`);
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
	console.log(pc.green(`  ✓ pushed ${uploads.length} images to ${branch}`) + pc.dim(` (${ctx.imageCommit.slice(0, 7)})`));

	const existing = await gh.listReviewComments(pr.number);
	const fresh: NewReviewComment[] = [];
	let updated = 0;
	for (const a of sorted) {
		const body = commentBody(a, ctx);
		const prior = existing.find((c) => c.body.includes(marker(a)) && c.path === a.path && c.line === a.line && c.side === a.side);
		if (prior) {
			await gh.updateReviewComment(prior.id, body);
			updated++;
		} else {
			fresh.push({ path: a.path, line: a.line, side: a.side, body });
		}
	}
	if (fresh.length) {
		const review = await gh.createReview(pr.number, pr.head.sha, fresh);
		console.log(pc.green(`  ✓ posted ${fresh.length} comments`) + pc.dim(`  ${review.html_url}`));
	}
	if (updated) console.log(pc.green(`  ✓ updated ${updated} existing comments`));
	console.log(summary);
	return 0;
}
