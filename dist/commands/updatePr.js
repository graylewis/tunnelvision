import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import { PNG } from "pngjs";
import { applyOverrides, configExists, DEFAULT_CONFIG, loadConfig } from "../config.js";
import { ELEMENT_IMAGE, ElementImages } from "../elements.js";
import { currentBranch, isGitRepo, mergeBase, remoteUrl, topLevel } from "../git.js";
import { GitHub, parseRepo, resolveToken } from "../github.js";
import { publishImages } from "../imagebranch.js";
import { diffDir, resolvePaths, versionDir } from "../paths.js";
import { readMeta, versionExists } from "../versions.js";
import { resolvePair } from "./diff.js";
import { buildDiff, CHANGE_STATUSES } from "./inspector.js";
export const DEFAULT_IMAGE_BRANCH = "tunnelvision-assets";
/** Elements sharing one source line (list items, chart bars) that get screenshots; the rest are listed. */
const MAX_SHOWN = 3;
const MAX_OWNERS = 4;
const MATCHED_BY = {
    id: "id",
    key: "React key",
    component: "component + source file",
    name: "name attribute",
    source: "source line",
    order: "order among similar siblings",
    "tag-order": "order among siblings with the same tag",
};
function realpath(p) {
    try {
        return fs.realpathSync(p);
    }
    catch {
        return p;
    }
}
/** Resolve a component source to a path relative to the repository root, or null if it's outside. */
function repoPath(src, root, top) {
    if (!src || src.generated || /^[a-z]+:\/\//i.test(src.fileName))
        return null;
    const abs = realpath(path.isAbsolute(src.fileName) ? src.fileName : path.join(root, src.fileName));
    const rel = path.relative(top, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel))
        return null;
    return rel.split(path.sep).join("/");
}
function walk(nodes, visit) {
    for (const n of nodes) {
        visit(n);
        walk(n.children, visit);
    }
}
/** Table cells can't hold pipes or newlines. */
function cell(s) {
    return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
function label(n) {
    let s = n.tag;
    if (n.id)
        s += `#${n.id}`;
    if (n.className) {
        const classes = n.className.split(/\s+/).filter(Boolean);
        s += `.${classes.slice(0, 2).join(".")}${classes.length > 2 ? "…" : ""}`;
    }
    return s;
}
function rectText(r) {
    return r ? `${r.width}×${r.height} @ ${r.x},${r.y}` : "—";
}
function sourceLink(src, ctx) {
    if (!src)
        return "—";
    const rel = repoPath(src, ctx.root, ctx.top);
    if (!rel)
        return `\`${cell(src.path)}\``;
    const url = `https://github.com/${ctx.gh.repo.owner}/${ctx.gh.repo.name}/blob/${ctx.pr.head.sha}/${rel}#L${src.lineNumber}`;
    return `[\`${cell(`${rel}:${src.lineNumber}`)}\`](${url})`;
}
function image(dest, alt, ctx) {
    if (!dest)
        return "—";
    const file = `${ctx.imageBase}/${dest}`;
    const src = ctx.imageCommit ? ctx.gh.imageUrl(ctx.imageCommit, file) : ctx.local.get(file);
    return `<img src="${src}" alt="${alt}" />`;
}
/** `extra` rows go after the element's path. */
function targetSection(t, ctx, extra = []) {
    const { node: n, page } = t;
    const pct = n.diffPercent !== undefined ? ` · ${n.diffPercent.toFixed(3)}% mismatch` : "";
    const rows = [];
    rows.push(["page", page.url ? `[\`${cell(page.slug)}\`](${page.url})` : `\`${cell(page.slug)}\``]);
    rows.push(["selector", `\`${cell(n.selector)}\``]);
    rows.push(["path", `\`${cell(`${page.slug}/${n.dir}`)}\``]);
    rows.push(...extra);
    if (n.fromDir && n.fromDir !== n.dir) {
        rows.push(["was at", `\`${cell(`${page.slug}/${n.fromDir}`)}\`${n.moved ? " (moved to a different parent)" : ""}`]);
    }
    if (n.matchedBy)
        rows.push(["matched by", MATCHED_BY[n.matchedBy] ?? n.matchedBy.replace(/^attr:/, "")]);
    if (n.message)
        rows.push(["note", cell(n.message)]);
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
function marker(a) {
    return `<!-- tunnelvision:${a.side}:${a.path}:${a.line} -->`;
}
const VIA = {
    direct: "set by this line",
    inherited: "inherited from an ancestor this line styles",
    var: "through a custom property this line sets",
    jsx: "this is the element's JSX line",
    "knock-on": "moved or resized by a change this line made",
};
const MAX_LISTED = 25;
const MAX_PROPS = 6;
/** A code-first comment: what the line changed, one representative screenshot, and the rest listed. */
function causeBody(a, cause, data, ctx) {
    const [t] = a.targets;
    const rep = cause.representative;
    const n = cause.effects.length;
    // Only properties whose declaration changed; the rest are results of layout.
    const own = rep.props.filter((p) => p.own);
    const props = own.slice(0, MAX_PROPS).map((p) => `\`${cell(p.name)}\` ${cell(p.from ?? "—")} → ${cell(p.to ?? "—")}`);
    const extra = [["how", VIA[rep.via]]];
    if (props.length)
        extra.push(["changed", props.join("<br>") + (own.length > MAX_PROPS ? "<br>…" : "")]);
    if (rep.alsoCausedBy?.length)
        extra.push(["also affected by", rep.alsoCausedBy.map((c) => `\`${cell(c)}\``).join(", ")]);
    const parts = [
        marker(a),
        `### tunnelvision · this line changed ${n} element${n === 1 ? "" : "s"}`,
        `Comparing \`${ctx.from}\` → \`${ctx.to}\`.${cause.text ? ` ${cause.side === "LEFT" ? "Removed" : "Now"}: \`${cell(cause.text)}\`` : ""}`,
        "",
        targetSection(t, ctx, extra),
    ];
    const rest = cause.effects.filter((e) => e !== rep);
    if (rest.length) {
        const line = (e) => {
            const node = findNode(data, e);
            return `- \`${cell(node ? label(node) : e.dir)}\` ${e.status}, ${e.via} — \`${cell(`${e.page}/${e.dir}`)}\``;
        };
        const listed = rest.slice(0, MAX_LISTED).map(line);
        if (rest.length > MAX_LISTED)
            listed.push(`- …and ${rest.length - MAX_LISTED} more (see \`tunnelvision inspector\`)`);
        parts.push("", `<details><summary>…and ${rest.length} more affected element${rest.length === 1 ? "" : "s"}</summary>\n\n${listed.join("\n")}\n</details>`);
    }
    return parts.join("\n").trimEnd();
}
/** The inspector node an effect refers to. */
function findNode(data, e) {
    const page = data.pages.find((p) => p.slug === e.page);
    const uid = e.status === "removed" ? `removed:${e.dir}` : e.dir;
    let found = null;
    if (page)
        walk(page.elements, (n) => {
            if (n.uid === uid)
                found = n;
        });
    return found;
}
function commentBody(a, ctx, data) {
    if (a.cause)
        return causeBody(a, a.cause, data, ctx);
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
        parts.push(`<details><summary>…and ${rest.length} more</summary>\n\n` +
            rest.map((t) => `- \`${cell(label(t.node))}\` ${t.node.status} — \`${t.page.slug}/${t.node.dir}\``).join("\n") +
            "\n</details>");
    }
    return parts.join("\n").trimEnd();
}
function targetOf(page, node) {
    return { page, node, dest: `${page.slug}/${node.uid.replace(/^removed:/, "removed/")}` };
}
/** One anchor per changed line that caused visual changes, with its representative change as the target. */
function codeFirstAnchors(data, lines) {
    const anchors = new Map();
    const c = data.correlation;
    if (!c)
        return { anchors, summary: `causes not traced: ${data.correlationSkipped ?? "unknown reason"}` };
    let offDiff = 0;
    for (const cause of c.causes) {
        const changedLines = (cause.side === "LEFT" ? lines.changed.left : lines.changed.right).get(cause.path);
        const rep = cause.representative;
        const node = rep && findNode(data, rep);
        const page = rep && data.pages.find((p) => p.slug === rep.page);
        if (!changedLines?.has(cause.line) || !node || !page) {
            offDiff++;
            continue;
        }
        anchors.set(`${cause.side}:${cause.path}:${cause.line}`, {
            path: cause.path,
            line: cause.line,
            side: cause.side,
            targets: [targetOf(page, node)],
            cause,
        });
    }
    const parts = [
        `${c.causes.length} changed lines caused visual changes`,
        `${offDiff} outside the PR diff`,
        `${c.unexplained.length} unexplained and ${c.invisible.length} invisible changes (inspector only)`,
    ];
    return { anchors, summary: parts.join(" · ") };
}
/** One anchor per JSX line that changed elements point at. */
function visualFirstAnchors(data, lines, root, top) {
    const anchors = new Map();
    let changed = 0;
    let noSource = 0;
    let offDiff = 0;
    for (const page of data.pages) {
        walk(page.elements, (node) => {
            if (!CHANGE_STATUSES.has(node.status))
                return;
            changed++;
            const src = node.component?.source ?? null;
            const file = repoPath(src, root, top);
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
            anchor.targets.push(targetOf(page, node));
            anchors.set(key, anchor);
        });
    }
    return { anchors, summary: `${changed} changed elements · ${noSource} without a source location · ${offDiff} outside the PR diff` };
}
/** The baseline for a PR: the capture at the merge base with its base branch, when there is one. */
function prBaseline(paths, remote, pr) {
    for (const rev of [pr.base.sha, `${remote}/${pr.base.ref}`]) {
        const sha = mergeBase(paths.root, "HEAD", rev);
        if (sha && versionExists(paths, sha))
            return sha;
    }
    return undefined;
}
export async function updatePr(opts) {
    const paths = resolvePaths(opts.root);
    if (!isGitRepo(paths.root))
        throw new Error("update-pr must be run inside a git repository.");
    const top = realpath(topLevel(paths.root));
    const remote = opts.remote ?? "origin";
    const branch = opts.branch ?? DEFAULT_IMAGE_BRANCH;
    const url = remoteUrl(paths.root, remote);
    if (!url)
        throw new Error(`No git remote named "${remote}". Pass --remote <name>.`);
    const gh = new GitHub(resolveToken(), parseRepo(url));
    let pr;
    if (opts.pr) {
        pr = await gh.getPull(opts.pr);
    }
    else {
        const head = currentBranch(paths.root);
        if (!head)
            throw new Error("HEAD is detached. Pass the PR number with --pr <n>.");
        const found = await gh.findPullForBranch(head);
        if (!found)
            throw new Error(`No open pull request for branch "${head}". Pass --pr <n>.`);
        pr = found;
    }
    console.log(pc.bold(`PR #${pr.number}`) + pc.dim(` ${pr.title}  ${pr.html_url}`));
    const { from, to } = resolvePair({ ...opts, from: opts.from ?? prBaseline(paths, remote, pr) }, paths);
    for (const key of [from, to]) {
        if (!versionExists(paths, key))
            throw new Error(`Version "${key}" not found under ${paths.versions}.`);
    }
    console.log(pc.dim(`  comparing ${from} → ${to}`));
    // Line numbers come from the target capture, so they only line up with the PR if it's the head commit.
    const toSha = readMeta(paths, to)?.sha ?? to.replace(/-dirty$/, "");
    if (to.endsWith("-dirty")) {
        console.log(pc.yellow(`  ${to} was captured with uncommitted changes; source lines may not match the PR.`));
    }
    else if (!pr.head.sha.startsWith(toSha)) {
        console.log(pc.yellow(`  ${to} isn't the PR head (${pr.head.sha.slice(0, 7)}); source lines may not match.`));
    }
    const data = buildDiff(paths, opts, from, to);
    if (!data.pages.some((p) => p.byElement)) {
        throw new Error("update-pr needs per-element captures. Re-capture both versions with `--by-element`.");
    }
    const lines = await gh.commentableLines(pr.number);
    const config = applyOverrides(configExists(paths) ? loadConfig(paths) : DEFAULT_CONFIG, opts);
    const mode = opts.mode ?? config.updatePr.mode;
    if (mode !== "code-first" && mode !== "visual-first")
        throw new Error(`Unknown --mode "${mode}". Use code-first or visual-first.`);
    console.log(pc.dim(`  ${mode}`));
    const { anchors, summary: counts } = mode === "code-first" ? codeFirstAnchors(data, lines) : visualFirstAnchors(data, lines, paths.root, top);
    const summary = pc.dim(`  ${counts}`);
    if (anchors.size === 0) {
        console.log(summary);
        console.log(pc.green("  Nothing to comment on."));
        return 0;
    }
    // Only the elements that get screenshots in a comment are uploaded. Their
    // before/after images are cropped from the page screenshots into a scratch
    // directory, which is kept for a dry run so the printed paths stay valid.
    const imageBase = `pr-${pr.number}/${from}__${to}`;
    const uploads = [];
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tunnelvision-pr-"));
    const images = new ElementImages();
    for (const a of anchors.values()) {
        for (const t of a.targets.slice(0, MAX_SHOWN)) {
            const { node, page } = t;
            const add = (file, name) => uploads.push({ file, dest: `${imageBase}/${t.dest}/${name}` });
            const crop = (version, dir, name) => {
                const png = images.crop(path.join(versionDir(paths, version), page.slug), dir);
                if (!png)
                    return;
                const file = path.join(scratch, ...t.dest.split("/"), name);
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, PNG.sync.write(png));
                add(file, name);
            };
            if (node.images.from)
                crop(from, node.fromDir ?? node.dir, "before.png");
            if (node.images.to)
                crop(to, node.dir, "after.png");
            if (node.images.diff)
                add(path.join(diffDir(paths, from, to), page.slug, ...node.dir.split("/"), ELEMENT_IMAGE), "diff.png");
        }
    }
    const ctx = {
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
            console.log(commentBody(a, ctx, data));
        }
        console.log("");
        console.log(summary);
        console.log(pc.dim(`  dry run: would push ${uploads.length} images to ${branch} and post ${sorted.length} comments`));
        return 0;
    }
    try {
        ctx.imageCommit = publishImages(top, remote, branch, uploads, `tunnelvision: PR #${pr.number} ${from} → ${to}`);
    }
    finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
    console.log(pc.green(`  ✓ pushed ${uploads.length} images to ${branch}`) + pc.dim(` (${ctx.imageCommit.slice(0, 7)})`));
    const existing = await gh.listReviewComments(pr.number);
    const fresh = [];
    let updated = 0;
    for (const a of sorted) {
        const body = commentBody(a, ctx, data);
        const prior = existing.find((c) => c.body.includes(marker(a)) && c.path === a.path && c.line === a.line && c.side === a.side);
        if (prior) {
            await gh.updateReviewComment(prior.id, body);
            updated++;
        }
        else {
            fresh.push({ path: a.path, line: a.line, side: a.side, body });
        }
    }
    if (fresh.length) {
        const review = await gh.createReview(pr.number, pr.head.sha, fresh);
        console.log(pc.green(`  ✓ posted ${fresh.length} comments`) + pc.dim(`  ${review.html_url}`));
    }
    if (updated)
        console.log(pc.green(`  ✓ updated ${updated} existing comments`));
    console.log(summary);
    return 0;
}
