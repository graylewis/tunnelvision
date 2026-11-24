import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import { devCommand, moduleScripts, planServer, projectPort, rehostAuth } from "../src/server.js";
import { changesDependencies, copyIgnored, globToRegExp, matchGlob, openWorktree, packageManager, pendingChanges, rehome, syncInPlace, syncWorktree, treeOf } from "../src/worktree.js";
import { snapshotTree } from "../src/git.js";

function tmp(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tv-server-")));
}

function write(root: string, rel: string, text: string): void {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), text);
}

function project(pkg: Record<string, unknown>): string {
	const root = tmp();
	write(root, "package.json", JSON.stringify(pkg));
	return root;
}

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
	}).trim();

function repo(files: Record<string, string>): string {
	const root = tmp();
	git(root, "init", "-q", "-b", "main");
	for (const [rel, text] of Object.entries(files)) write(root, rel, text);
	git(root, "add", "-A");
	git(root, "commit", "-q", "--no-gpg-sign", "-m", "init");
	return root;
}

const config = (over: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, ...over, server: { ...DEFAULT_CONFIG.server, ...(over.server ?? {}) } });

test("devCommand: follows a dev script that just runs the framework, without its port or host", () => {
	const next = project({ scripts: { dev: "next dev --turbopack -p 3001 --hostname 0.0.0.0" } });
	assert.equal(devCommand(next, "next"), "next dev --turbopack --port {port} --hostname {host}");
	const vite = project({ scripts: { dev: "vite --open --port=5174 --host" } });
	assert.equal(devCommand(vite, "vite"), "vite --port {port} --strictPort --host {host}");
	const portable = project({ scripts: { dev: "vite --portable" } });
	assert.equal(devCommand(portable, "vite"), "vite --portable --port {port} --strictPort --host {host}");
});

test("devCommand: keeps env assignments and env loaders in front of the framework", () => {
	const next = project({ scripts: { dev: "NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=12000} next dev" } });
	assert.equal(devCommand(next, "next"), "NODE_OPTIONS=${NODE_OPTIONS:---max-old-space-size=12000} next dev --port {port} --hostname {host}");
	const astro = project({ scripts: { dev: "dotenvx run --strict -- astro dev --port 4321" } });
	assert.equal(devCommand(astro, "astro"), "dotenvx run --strict -- astro dev --port {port} --host {host}");
	const vitest = project({ scripts: { dev: "vitest" } });
	assert.equal(devCommand(vitest, "vite"), "vite --port {port} --strictPort --host {host}");
});

test("devCommand: a dev script that does more than run the framework is left out", () => {
	const root = project({ scripts: { dev: "concurrently 'next dev' 'tsc -w'" } });
	assert.equal(devCommand(root, "next"), "next dev --port {port} --hostname {host}");
	const chained = project({ scripts: { dev: "astro dev && echo done" } });
	assert.equal(devCommand(chained, "astro"), "astro dev --port {port} --host {host}");
});

test("projectPort: the same for a project every time, in tunnelvision's range", () => {
	const root = tmp();
	const port = projectPort(root);
	assert.equal(projectPort(root), port);
	assert.ok(port >= 41000 && port < 42000);
});

test("planServer: owned for a framework it can start, external when told or when it can't", () => {
	const vite = repo({ "package.json": JSON.stringify({ devDependencies: { vite: "7.0.0" } }) });
	const owned = planServer(vite, config());
	assert.equal(owned.mode, "owned");
	assert.ok(owned.mode === "owned" && owned.command.startsWith("vite "));
	assert.equal(owned.mode === "owned" && owned.port, projectPort(vite));

	const fixed = planServer(vite, config({ server: { port: 4999 } }));
	assert.ok(fixed.mode === "owned" && fixed.port === 4999 && fixed.portFixed);

	const told = planServer(vite, config({ server: { external: true }, baseUrl: "http://localhost:5173" }));
	assert.deepEqual(told.mode === "external" && told.url, "http://localhost:5173");

	const unknown = repo({ "package.json": JSON.stringify({ dependencies: { express: "4" } }) });
	assert.equal(planServer(unknown, config()).mode, "external");
	const custom = planServer(unknown, config({ server: { command: "node server.js --port {port}" } }));
	assert.ok(custom.mode === "owned" && custom.command === "node server.js --port {port}");

	const noGit = project({ devDependencies: { vite: "7" } });
	assert.equal(planServer(noGit, config()).mode, "external");
});

test("planServer: the owned server is reached at the user's server's local host name", () => {
	const vite = repo({ "package.json": JSON.stringify({ devDependencies: { vite: "7.0.0" } }) });
	const plan = planServer(vite, config({ baseUrl: "http://127.0.0.1:5173" }));
	assert.ok(plan.mode === "owned" && plan.host === "127.0.0.1");
	const remote = planServer(vite, config({ baseUrl: "https://staging.example.com" }));
	assert.ok(remote.mode === "owned" && remote.host === "localhost");
});

test("rehostAuth: local storage moves to the owned server's origin, cookies stay as they are", () => {
	const state = {
		cookies: [{ name: "sid", value: "1", domain: "localhost", path: "/" }],
		origins: [
			{ origin: "http://localhost:3000", localStorage: [{ name: "token", value: "abc" }] },
			{ origin: "https://accounts.example.com", localStorage: [{ name: "x", value: "y" }] },
		],
	};
	const out = rehostAuth(state, "http://localhost:3000/app", "http://localhost:41234");
	assert.deepEqual(out.cookies, state.cookies);
	assert.deepEqual(
		out.origins?.map((o) => o.origin),
		["https://accounts.example.com", "http://localhost:41234"],
	);
	assert.deepEqual(out.origins?.[1]?.localStorage, [{ name: "token", value: "abc" }]);
	// The input isn't changed.
	assert.equal(state.origins[0].origin, "http://localhost:3000");
});

test("rehostAuth: the user's server's own origin wins over another port on the same host", () => {
	const state = {
		origins: [
			{ origin: "http://localhost:3000", localStorage: [{ name: "a", value: "main" }] },
			{ origin: "http://localhost:6006", localStorage: [{ name: "a", value: "storybook" }] },
		],
	};
	const out = rehostAuth(state, "http://localhost:3000", "http://localhost:41234");
	assert.equal(out.origins?.length, 1);
	assert.deepEqual(out.origins?.[0]?.localStorage, [{ name: "a", value: "main" }]);
});

test("moduleScripts: a page's own module scripts, resolved", () => {
	const html = `<script type="module" src="/@vite/client"></script>
		<script type="module" src="/src/main.jsx?t=1&amp;x=2"></script>
		<script src="/legacy.js"></script>
		<script type="module" src="https://cdn.example.com/lib.js"></script>`;
	assert.deepEqual(moduleScripts(html, "http://localhost:4000/about"), [
		"http://localhost:4000/@vite/client",
		"http://localhost:4000/src/main.jsx?t=1&x=2",
	]);
});

test("globToRegExp and matchGlob: ** across directories, * within one", () => {
	assert.ok(globToRegExp("src/generated/**").test("src/generated/a/b.ts"));
	assert.ok(globToRegExp("src/**/*.gen.ts").test("src/x.gen.ts"));
	assert.ok(globToRegExp("src/**/*.gen.ts").test("src/a/b/x.gen.ts"));
	assert.ok(!globToRegExp("src/*.ts").test("src/a/x.ts"));

	const root = tmp();
	write(root, "src/generated/client/index.js", "1");
	write(root, "src/generated/types.d.ts", "1");
	write(root, "src/app.ts", "1");
	write(root, "node_modules/x/index.js", "1");
	assert.deepEqual(matchGlob(root, "src/generated/**"), ["src/generated/client/index.js", "src/generated/types.d.ts"]);
	assert.deepEqual(matchGlob(root, "src/generated"), ["src/generated/client/index.js", "src/generated/types.d.ts"]);
	assert.deepEqual(matchGlob(root, "**/*.js"), ["src/generated/client/index.js"]);
	assert.deepEqual(matchGlob(root, "src/missing.ts"), []);
});

test("rehome: worktree paths become the repository's, everything else is left alone", () => {
	const value = {
		fileName: "/repo/.tunnelvision/worktree/src/App.tsx",
		path: "src/App.tsx:3:4",
		nested: [{ file: "/repo/.tunnelvision/worktree/packages/ui/button.css" }, "file:///repo/.tunnelvision/worktree/x.js", "/repo/.tunnelvision/worktreeish"],
	};
	rehome(value, "/repo/.tunnelvision/worktree", "/repo");
	assert.deepEqual(value, {
		fileName: "/repo/src/App.tsx",
		path: "src/App.tsx:3:4",
		nested: [{ file: "/repo/packages/ui/button.css" }, "file:///repo/x.js", "/repo/.tunnelvision/worktreeish"],
	});
});

test("packageManager: the nearest lockfile up to the repository's top, the declared manager first", () => {
	const root = tmp();
	write(root, "package.json", JSON.stringify({ packageManager: "pnpm@9.0.0" }));
	write(root, "pnpm-lock.yaml", "");
	write(root, "package-lock.json", "{}");
	write(root, "apps/web/package.json", "{}");
	const found = packageManager(path.join(root, "apps/web"), root);
	assert.equal(found.manager.name, "pnpm");
	assert.equal(found.dir, root);
});

test("syncWorktree: checks out each snapshot, touching only changed files and keeping ignored ones", async () => {
	const root = repo({
		".gitignore": ".tunnelvision/\nnode_modules/\n.env.local\n",
		"package.json": "{}",
		"src/a.css": ".a { color: red }\n",
		"src/b.css": ".b { color: blue }\n",
	});
	const dir = path.join(root, ".tunnelvision");
	const first = snapshotTree(root, "v1")!;
	const tree = syncWorktree(root, dir, first);
	assert.equal(tree.root, tree.top);
	assert.equal(tree.repoTop, root);
	assert.equal(fs.readFileSync(path.join(tree.root, "src/a.css"), "utf8"), ".a { color: red }\n");

	// Things the server leaves behind: ignored ones stay, untracked ones go.
	write(tree.root, "node_modules/dep/index.js", "1");
	write(tree.root, "stray.txt", "1");
	const bBefore = fs.statSync(path.join(tree.root, "src/b.css")).mtimeMs;
	await new Promise((r) => setTimeout(r, 20));

	write(root, "src/a.css", ".a { color: green }\n");
	write(root, "src/new.css", ".n {}\n");
	const second = snapshotTree(root, "v2")!;
	assert.notEqual(treeOf(root, first), treeOf(root, second));
	syncWorktree(root, dir, second);
	assert.equal(fs.readFileSync(path.join(tree.root, "src/a.css"), "utf8"), ".a { color: green }\n");
	assert.ok(fs.existsSync(path.join(tree.root, "src/new.css")));
	assert.ok(fs.existsSync(path.join(tree.root, "node_modules/dep/index.js")));
	assert.ok(!fs.existsSync(path.join(tree.root, "stray.txt")));
	assert.equal(fs.statSync(path.join(tree.root, "src/b.css")).mtimeMs, bBefore);

	// The user's own checkout is untouched, and the worktree is ignored there.
	assert.deepEqual(git(root, "status", "--porcelain").split("\n").map((l) => l.trim()).sort(), ["?? src/new.css", "M src/a.css"]);

	// Back to the first snapshot: the file it didn't have is gone.
	syncWorktree(root, dir, first);
	assert.ok(!fs.existsSync(path.join(tree.root, "src/new.css")));
	assert.equal(treeOf(root, first), treeOf(tree.top, "HEAD"));
});

test("syncWorktree: recreates a worktree whose directory was deleted", () => {
	const root = repo({ ".gitignore": ".tunnelvision/\n", "index.html": "<p>hi</p>\n" });
	const dir = path.join(root, ".tunnelvision");
	const rev = snapshotTree(root, "v1")!;
	const tree = syncWorktree(root, dir, rev);
	fs.rmSync(tree.top, { recursive: true, force: true });
	syncWorktree(root, dir, rev);
	assert.ok(fs.existsSync(path.join(tree.top, "index.html")));
});

test("syncWorktree: a project in a subdirectory is served from the same subdirectory of the worktree", () => {
	const top = repo({ ".gitignore": ".tunnelvision/\n", "apps/web/package.json": "{}" });
	const root = path.join(top, "apps/web");
	const tree = syncWorktree(root, path.join(root, ".tunnelvision"), snapshotTree(root, "v1")!);
	assert.equal(tree.root, path.join(tree.top, "apps/web"));
	assert.ok(fs.existsSync(path.join(tree.root, "package.json")));
});

test("copyIgnored: copies ignored env files and globs, skips tracked ones, removes ones that went", () => {
	const root = repo({
		".gitignore": ".tunnelvision/\n.env.local\nsrc/generated/\n",
		".env": "TRACKED=1\n",
		"src/app.ts": "",
	});
	write(root, ".env.local", "SECRET=1\n");
	write(root, "src/generated/client.js", "gen\n");
	const dir = path.join(root, ".tunnelvision");
	const tree = syncWorktree(root, dir, snapshotTree(root, "v1")!);
	const state = path.join(dir, "server");

	// A tracked .env comes from the snapshot, not the working tree.
	write(root, ".env", "TRACKED=changed\n");
	const copied = copyIgnored(root, tree, ["src/generated/**"], state);
	assert.deepEqual(copied, [".env.local", "src/generated/client.js"]);
	assert.equal(fs.readFileSync(path.join(tree.root, ".env.local"), "utf8"), "SECRET=1\n");
	assert.equal(fs.readFileSync(path.join(tree.root, ".env"), "utf8"), "TRACKED=1\n");
	assert.equal(fs.readFileSync(path.join(tree.root, "src/generated/client.js"), "utf8"), "gen\n");

	// Unchanged files aren't rewritten.
	const mtime = fs.statSync(path.join(tree.root, ".env.local")).mtimeMs;
	copyIgnored(root, tree, ["src/generated/**"], state);
	assert.equal(fs.statSync(path.join(tree.root, ".env.local")).mtimeMs, mtime);

	fs.rmSync(path.join(root, ".env.local"));
	copyIgnored(root, tree, ["src/generated/**"], state);
	assert.ok(!fs.existsSync(path.join(tree.root, ".env.local")));
});

test("syncInPlace: rewrites changed files in place, restores ones the server changed, and leaves the index at the commit", () => {
	const root = repo({ ".gitignore": ".tunnelvision/\n", "src/a.css": "a\n", "next-env.d.ts": "x\n", "gone.txt": "1\n" });
	const dir = path.join(root, ".tunnelvision");
	const first = snapshotTree(root, "v1")!;
	const { tree, created } = openWorktree(root, dir, first);
	assert.ok(created);
	const inode = fs.statSync(path.join(tree.top, "src/a.css")).ino;
	// A dev server rewriting a tracked file.
	write(tree.top, "next-env.d.ts", "rewritten by the server\n");

	write(root, "src/a.css", "b\n");
	fs.rmSync(path.join(root, "gone.txt"));
	write(root, "src/new.css", "n\n");
	const second = snapshotTree(root, "v2")!;
	assert.equal(openWorktree(root, dir, second).created, false);
	assert.deepEqual(pendingChanges(tree, second), ["gone.txt", "next-env.d.ts", "src/a.css", "src/new.css"]);
	syncInPlace(tree, second);

	assert.equal(fs.readFileSync(path.join(tree.top, "src/a.css"), "utf8"), "b\n");
	assert.equal(fs.statSync(path.join(tree.top, "src/a.css")).ino, inode);
	assert.equal(fs.readFileSync(path.join(tree.top, "next-env.d.ts"), "utf8"), "x\n");
	assert.ok(!fs.existsSync(path.join(tree.top, "gone.txt")));
	assert.ok(fs.existsSync(path.join(tree.top, "src/new.css")));
	assert.equal(git(tree.top, "status", "--porcelain"), "");
	assert.equal(treeOf(tree.top, "HEAD"), treeOf(root, second));
	assert.deepEqual(pendingChanges(tree, second), []);
});

test("changesDependencies: lockfiles and package.json, anywhere in the repository", () => {
	assert.ok(changesDependencies(["src/a.ts", "bun.lock"]));
	assert.ok(changesDependencies(["apps/web/package.json"]));
	assert.ok(!changesDependencies(["src/package.json.ts", "docs/yarn.lock.md"]));
});
