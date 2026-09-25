import { execFileSync } from "node:child_process";
const API = "https://api.github.com";
/** A token from `GITHUB_TOKEN` / `GH_TOKEN`, falling back to `gh auth token`. */
export function resolveToken() {
    const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (env)
        return env;
    try {
        const t = execFileSync("gh", ["auth", "token"], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
        if (t)
            return t;
    }
    catch {
        // gh not installed or not logged in.
    }
    throw new Error("No GitHub token found. Set GITHUB_TOKEN (or GH_TOKEN), or log in with `gh auth login`.");
}
/** Parse `owner/repo` from an https or ssh GitHub remote URL. */
export function parseRepo(remoteUrl) {
    const m = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
    if (!m)
        throw new Error(`Remote "${remoteUrl}" doesn't look like a GitHub repository.`);
    return { owner: m[1], name: m[2] };
}
export class GitHub {
    token;
    repo;
    constructor(token, repo) {
        this.token = token;
        this.repo = repo;
    }
    async request(method, route, body) {
        const url = route.startsWith("http") ? route : `${API}/repos/${this.repo.owner}/${this.repo.name}${route}`;
        const res = await fetch(url, {
            method,
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${this.token}`,
                "X-GitHub-Api-Version": "2022-11-28",
                ...(body ? { "Content-Type": "application/json" } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) {
            let detail = res.statusText;
            try {
                const err = (await res.json());
                detail = [err.message, ...(err.errors ?? []).map((e) => JSON.stringify(e))].filter(Boolean).join("; ");
            }
            catch {
                // Not JSON.
            }
            throw new Error(`GitHub ${method} ${route} failed (${res.status}): ${detail}`);
        }
        return (await res.json());
    }
    /** GET every page of a list endpoint. */
    async list(route) {
        const out = [];
        const sep = route.includes("?") ? "&" : "?";
        for (let page = 1;; page++) {
            const batch = await this.request("GET", `${route}${sep}per_page=100&page=${page}`);
            out.push(...batch);
            if (batch.length < 100)
                return out;
        }
    }
    getPull(number) {
        return this.request("GET", `/pulls/${number}`);
    }
    /** The open PR whose head is `branch` in this repository, if any. */
    async findPullForBranch(branch) {
        const head = encodeURIComponent(`${this.repo.owner}:${branch}`);
        const pulls = await this.request("GET", `/pulls?state=open&head=${head}`);
        return pulls[0] ?? null;
    }
    /** Which lines of each changed file sit inside a diff hunk (and so can be commented on). */
    async commentableLines(number) {
        const files = await this.list(`/pulls/${number}/files`);
        const out = { right: new Map(), left: new Map() };
        for (const f of files) {
            if (!f.patch)
                continue;
            const right = new Set();
            const left = new Set();
            let oldLine = 0;
            let newLine = 0;
            for (const line of f.patch.split("\n")) {
                const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
                if (hunk) {
                    oldLine = Number(hunk[1]);
                    newLine = Number(hunk[2]);
                }
                else if (line.startsWith("+")) {
                    right.add(newLine++);
                }
                else if (line.startsWith("-")) {
                    left.add(oldLine++);
                }
                else if (!line.startsWith("\\")) {
                    // Context lines can be commented on from either side.
                    right.add(newLine++);
                    left.add(oldLine++);
                }
            }
            out.right.set(f.filename, right);
            out.left.set(f.filename, left);
        }
        return out;
    }
    listReviewComments(number) {
        return this.list(`/pulls/${number}/comments`);
    }
    updateReviewComment(id, body) {
        return this.request("PATCH", `/pulls/comments/${id}`, { body });
    }
    /** Post all `comments` as a single review, so the PR gets one notification. */
    createReview(number, commitId, comments) {
        return this.request("POST", `/pulls/${number}/reviews`, { commit_id: commitId, event: "COMMENT", comments });
    }
    /** A URL that renders `file` at `commit` as an image, including in private repos. */
    imageUrl(commit, file) {
        const rel = file.split("/").map(encodeURIComponent).join("/");
        return `https://github.com/${this.repo.owner}/${this.repo.name}/blob/${commit}/${rel}?raw=true`;
    }
}
