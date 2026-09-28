import { execFileSync } from "node:child_process";

/**
 * A minimal GitHub REST client for `update-pr`. It uses the built-in `fetch`,
 * so there's no dependency on the `gh` CLI (it's only used, when present, as a
 * fallback source for a token).
 */

export interface Repo {
	owner: string;
	name: string;
}

export interface PullRequest {
	number: number;
	title: string;
	html_url: string;
	head: { sha: string; ref: string };
	base: { sha: string; ref: string };
}

export interface ReviewComment {
	id: number;
	path: string;
	line: number | null;
	side: "LEFT" | "RIGHT";
	body: string;
}

export interface NewReviewComment {
	path: string;
	line: number;
	side: "LEFT" | "RIGHT";
	body: string;
}

/** Lines that can take a review comment, per file, on each side of the diff. */
export interface CommentableLines {
	right: Map<string, Set<number>>;
	left: Map<string, Set<number>>;
	/** Only the added (right) and deleted (left) lines, without context. */
	changed: {
		right: Map<string, Set<number>>;
		left: Map<string, Set<number>>;
	};
}

const API = "https://api.github.com";

/** A token from `GITHUB_TOKEN` / `GH_TOKEN`, falling back to `gh auth token`. */
export function resolveToken(): string {
	const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	if (env) return env;
	try {
		const t = execFileSync("gh", ["auth", "token"], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
		if (t) return t;
	} catch {
		// gh not installed or not logged in.
	}
	throw new Error("No GitHub token found. Set GITHUB_TOKEN (or GH_TOKEN), or log in with `gh auth login`.");
}

/** Parse `owner/repo` from an https or ssh GitHub remote URL. */
export function parseRepo(remoteUrl: string): Repo {
	const m = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
	if (!m) throw new Error(`Remote "${remoteUrl}" doesn't look like a GitHub repository.`);
	return { owner: m[1], name: m[2] };
}

export class GitHub {
	constructor(
		private readonly token: string,
		readonly repo: Repo,
	) {}

	private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
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
				const err = (await res.json()) as { message?: string; errors?: unknown[] };
				detail = [err.message, ...(err.errors ?? []).map((e) => JSON.stringify(e))].filter(Boolean).join("; ");
			} catch {
				// Not JSON.
			}
			throw new Error(`GitHub ${method} ${route} failed (${res.status}): ${detail}`);
		}
		return (await res.json()) as T;
	}

	/** GET every page of a list endpoint. */
	private async list<T>(route: string): Promise<T[]> {
		const out: T[] = [];
		const sep = route.includes("?") ? "&" : "?";
		for (let page = 1; ; page++) {
			const batch = await this.request<T[]>("GET", `${route}${sep}per_page=100&page=${page}`);
			out.push(...batch);
			if (batch.length < 100) return out;
		}
	}

	getPull(number: number): Promise<PullRequest> {
		return this.request("GET", `/pulls/${number}`);
	}

	/** The open PR whose head is `branch` in this repository, if any. */
	async findPullForBranch(branch: string): Promise<PullRequest | null> {
		const head = encodeURIComponent(`${this.repo.owner}:${branch}`);
		const pulls = await this.request<PullRequest[]>("GET", `/pulls?state=open&head=${head}`);
		return pulls[0] ?? null;
	}

	/** Which lines of each changed file sit inside a diff hunk (and so can be commented on). */
	async commentableLines(number: number): Promise<CommentableLines> {
		const files = await this.list<{ filename: string; patch?: string }>(`/pulls/${number}/files`);
		const out: CommentableLines = { right: new Map(), left: new Map(), changed: { right: new Map(), left: new Map() } };
		for (const f of files) {
			if (!f.patch) continue;
			const right = new Set<number>();
			const left = new Set<number>();
			const added = new Set<number>();
			const deleted = new Set<number>();
			let oldLine = 0;
			let newLine = 0;
			for (const line of f.patch.split("\n")) {
				const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
				if (hunk) {
					oldLine = Number(hunk[1]);
					newLine = Number(hunk[2]);
				} else if (line.startsWith("+")) {
					added.add(newLine);
					right.add(newLine++);
				} else if (line.startsWith("-")) {
					deleted.add(oldLine);
					left.add(oldLine++);
				} else if (!line.startsWith("\\")) {
					// Context lines can be commented on from either side.
					right.add(newLine++);
					left.add(oldLine++);
				}
			}
			out.right.set(f.filename, right);
			out.left.set(f.filename, left);
			out.changed.right.set(f.filename, added);
			out.changed.left.set(f.filename, deleted);
		}
		return out;
	}

	listReviewComments(number: number): Promise<ReviewComment[]> {
		return this.list(`/pulls/${number}/comments`);
	}

	updateReviewComment(id: number, body: string): Promise<ReviewComment> {
		return this.request("PATCH", `/pulls/comments/${id}`, { body });
	}

	/** Post all `comments` as a single review, so the PR gets one notification. */
	createReview(number: number, commitId: string, comments: NewReviewComment[]): Promise<{ html_url: string }> {
		return this.request("POST", `/pulls/${number}/reviews`, { commit_id: commitId, event: "COMMENT", comments });
	}

	/** A URL that renders `file` at `commit` as an image, including in private repos. */
	imageUrl(commit: string, file: string): string {
		const rel = file.split("/").map(encodeURIComponent).join("/");
		return `https://github.com/${this.repo.owner}/${this.repo.name}/blob/${commit}/${rel}?raw=true`;
	}
}
