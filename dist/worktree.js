import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { realpath } from "./reactsource.js";
function git(cwd, args) {
    return execFileSync("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
    }).trim();
}
function tryGit(cwd, args) {
    try {
        return git(cwd, args);
    }
    catch {
        return null;
    }
}
/** The worktree's directory for a project whose tunnelvision directory is `dir`. */
export function worktreeDir(dir) {
    return path.join(dir, "worktree");
}
/**
 * The worktree as the last capture left it, created at `rev` if it isn't
 * there (`created`). It isn't moved to `rev` here: see `syncInPlace`.
 */
export function openWorktree(projectRoot, dir, rev) {
    const repoTop = realpath(git(projectRoot, ["rev-parse", "--show-toplevel"]));
    const prefix = path.relative(repoTop, realpath(projectRoot));
    const top = worktreeDir(dir);
    let created = false;
    if (!isWorktree(top)) {
        // A directory left behind by a deleted worktree, or a stale registration, would refuse the add.
        tryGit(repoTop, ["worktree", "prune"]);
        fs.rmSync(top, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(top), { recursive: true });
        git(repoTop, ["worktree", "add", "--detach", "--force", top, rev]);
        created = true;
    }
    return { tree: { top: realpath(top), root: path.join(realpath(top), prefix), repoTop }, created };
}
/**
 * The files (relative to the worktree's top) that differ from `rev`: changed
 * between the commit it's at and `rev`, or changed in it since (a dev server
 * rewriting `next-env.d.ts`).
 */
export function pendingChanges(tree, rev) {
    const list = (args) => (tryGit(tree.top, args) ?? "").split("\0").filter(Boolean);
    return [...new Set([...list(["diff", "--name-only", "--no-renames", "-z", "HEAD", rev]), ...list(["diff", "--name-only", "--no-renames", "-z", "HEAD"])])].sort();
}
/** Whether syncing these files changes the worktree's dependencies. */
export function changesDependencies(files) {
    return files.some((f) => /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(f));
}
/**
 * Bring the worktree to `rev` by rewriting each file that differs in place,
 * the way an editor saves, then point its index at `rev` without touching
 * the files again. Done while the dev server runs, its file watcher sees each
 * change and recompiles what depends on it. A `git checkout` between
 * captures, with the server stopped, leaves Turbopack's persistent cache
 * serving the old compile. Returns the files rewritten.
 */
export function syncInPlace(tree, rev) {
    const files = pendingChanges(tree, rev);
    for (const rel of files) {
        const abs = path.join(tree.top, rel);
        const entry = tryGit(tree.top, ["ls-tree", "-z", rev, "--", rel]);
        const [meta] = (entry ?? "").split("\t");
        const [mode, type, sha] = meta ? meta.split(" ") : [];
        if (!sha || type !== "blob") {
            // Gone at `rev` (or a submodule, which isn't served).
            if (!sha)
                fs.rmSync(abs, { force: true });
            continue;
        }
        const content = execFileSync("git", ["cat-file", "blob", sha], { cwd: tree.top, maxBuffer: 1024 * 1024 * 1024 });
        if (mode === "120000") {
            fs.rmSync(abs, { force: true });
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.symlinkSync(content.toString("utf8"), abs);
            continue;
        }
        let same = false;
        try {
            same = !fs.lstatSync(abs).isSymbolicLink() && fs.readFileSync(abs).equals(content);
        }
        catch {
            // new file
        }
        try {
            if (fs.lstatSync(abs).isSymbolicLink())
                fs.rmSync(abs);
        }
        catch {
            // not there
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (!same)
            fs.writeFileSync(abs, content);
        fs.chmodSync(abs, mode === "100755" ? 0o755 : 0o644);
    }
    git(tree.top, ["reset", "--quiet", rev]);
    git(tree.top, ["clean", "-d", "--force", "--quiet"]);
    return files;
}
/** Open the worktree and bring it to `rev` (with no server running). */
export function syncWorktree(projectRoot, dir, rev) {
    const { tree } = openWorktree(projectRoot, dir, rev);
    syncInPlace(tree, rev);
    return tree;
}
function isWorktree(top) {
    return fs.existsSync(path.join(top, ".git")) && tryGit(top, ["rev-parse", "--is-inside-work-tree"]) === "true";
}
/** The git tree a commit holds, to tell whether two captures are of the same files. */
export function treeOf(root, rev) {
    return tryGit(root, ["rev-parse", `${rev}^{tree}`]);
}
// ---------------------------------------------------------------------------
// Git-ignored files the app needs
/** `**` matches any number of directories, `*` and `?` anything within one. */
export function globToRegExp(glob) {
    let re = "";
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === "*" && glob[i + 1] === "*") {
            const slash = glob[i + 2] === "/";
            re += slash ? "(?:.*/)?" : ".*";
            i += slash ? 2 : 1;
        }
        else if (c === "*")
            re += "[^/]*";
        else if (c === "?")
            re += "[^/]";
        else
            re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`);
}
const SKIP_DIRS = new Set(["node_modules", ".git", ".tunnelvision"]);
/** Files under `root` matching `glob` (relative, `/`-separated). Walks only below the glob's first wildcard. */
export function matchGlob(root, glob) {
    const clean = glob.replace(/^\.\//, "");
    const re = globToRegExp(clean);
    const literal = clean.split("/");
    const base = [];
    for (const part of literal) {
        if (/[*?]/.test(part))
            break;
        base.push(part);
    }
    const out = [];
    const visit = (rel) => {
        const abs = path.join(root, rel);
        let stat;
        try {
            stat = fs.statSync(abs);
        }
        catch {
            return;
        }
        if (stat.isFile()) {
            if (re.test(rel))
                out.push(rel);
            return;
        }
        if (!stat.isDirectory())
            return;
        for (const name of fs.readdirSync(abs)) {
            if (SKIP_DIRS.has(name) && !clean.includes(name))
                continue;
            visit(rel ? `${rel}/${name}` : name);
        }
    };
    // A glob without wildcards names one file (or a directory, all of it).
    if (base.length === literal.length) {
        const rel = base.join("/");
        try {
            if (fs.statSync(path.join(root, rel)).isDirectory()) {
                const inner = matchGlob(root, `${rel}/**`);
                return inner;
            }
        }
        catch {
            return [];
        }
        return [rel];
    }
    visit(base.join("/"));
    return out.sort();
}
/** The `.env*` files at a directory's top. */
function envFiles(root) {
    try {
        return fs
            .readdirSync(root, { withFileTypes: true })
            .filter((d) => d.isFile() && /^\.env/.test(d.name))
            .map((d) => d.name);
    }
    catch {
        return [];
    }
}
const COPIED = "copied.json";
/**
 * Copy the git-ignored files the app needs into the worktree: `.env*` at the
 * project root (and the repository's, for a project in a subdirectory), and
 * whatever `globs` match. A file is only written when its content changed,
 * so the dev server doesn't see it as new; a file copied last time that's no
 * longer there is removed. Returns the files copied, project-relative.
 */
export function copyIgnored(projectRoot, tree, globs, stateDir) {
    const from = realpath(projectRoot);
    const prefix = path.relative(tree.repoTop, from);
    const wanted = new Set(envFiles(from));
    if (prefix)
        for (const f of envFiles(tree.repoTop))
            wanted.add(path.posix.join(...prefix.split(path.sep).map(() => ".."), f));
    for (const glob of globs)
        for (const f of matchGlob(from, glob))
            wanted.add(f);
    // Files git doesn't ignore are already in the snapshot, at the commit's content.
    const ignored = new Set((tryGit(from, ["check-ignore", "--", ...wanted]) ?? "").split("\n").filter(Boolean));
    for (const rel of wanted)
        if (!ignored.has(rel))
            wanted.delete(rel);
    for (const rel of wanted) {
        const src = path.resolve(from, rel);
        const dest = path.resolve(tree.root, rel);
        const content = fs.readFileSync(src);
        let same = false;
        try {
            same = fs.readFileSync(dest).equals(content);
        }
        catch {
            // not there yet
        }
        if (same)
            continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content, { mode: fs.statSync(src).mode });
    }
    const record = path.join(stateDir, COPIED);
    let before = [];
    try {
        before = JSON.parse(fs.readFileSync(record, "utf8"));
    }
    catch {
        // first sync
    }
    for (const rel of before) {
        // Only ever inside the worktree, and only if git doesn't track it (the checkout owns those).
        const dest = path.resolve(tree.root, rel);
        if (wanted.has(rel) || !dest.startsWith(tree.top + path.sep))
            continue;
        if (tryGit(tree.top, ["ls-files", "--error-unmatch", path.relative(tree.top, dest)]) !== null)
            continue;
        fs.rmSync(dest, { force: true });
    }
    const list = [...wanted].sort();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(record, `${JSON.stringify(list, null, 2)}\n`);
    return list;
}
const MANAGERS = [
    { name: "bun", lockfile: "bun.lock", install: ["bun", "install", "--frozen-lockfile"] },
    { name: "bun", lockfile: "bun.lockb", install: ["bun", "install", "--frozen-lockfile"] },
    { name: "pnpm", lockfile: "pnpm-lock.yaml", install: ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"] },
    { name: "yarn", lockfile: "yarn.lock", install: ["yarn", "install", "--frozen-lockfile"] },
    // `npm install` rather than `npm ci`: it updates node_modules in place instead of deleting it first.
    { name: "npm", lockfile: "package-lock.json", install: ["npm", "install", "--prefer-offline", "--no-audit", "--no-fund"] },
];
/**
 * The package manager and the directory it installs in: the nearest
 * directory from the project root up to the repository's top with a
 * lockfile (a workspace's lockfile is at its root). npm with no lockfile.
 */
export function packageManager(root, top) {
    for (let dir = root;; dir = path.dirname(dir)) {
        const declared = declaredManager(dir);
        const found = MANAGERS.filter((m) => fs.existsSync(path.join(dir, m.lockfile)));
        const manager = found.find((m) => m.name === declared) ?? found[0];
        if (manager)
            return { manager, dir };
        if (dir === top || path.dirname(dir) === dir)
            break;
    }
    return { manager: MANAGERS[MANAGERS.length - 1], dir: root };
}
function declaredManager(dir) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
        return typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : null;
    }
    catch {
        return null;
    }
}
const DEPS = "deps.json";
/** What decides the worktree's installed dependencies: the lockfile and every package.json beside it. */
function depsHash(dir, manager) {
    const h = crypto.createHash("sha256");
    h.update(manager.install.join(" "));
    for (const file of [manager.lockfile, "package.json"]) {
        try {
            h.update(file).update(fs.readFileSync(path.join(dir, file)));
        }
        catch {
            h.update(`${file} missing`);
        }
    }
    return h.digest("hex");
}
/**
 * Install the worktree's own dependencies when its lockfile or package.json
 * changed since the last install (or there's no node_modules). Returns what
 * ran, or null when nothing needed to. Throws with the installer's output
 * when it fails.
 */
export function installDependencies(tree, stateDir, log) {
    const { manager, dir } = packageManager(tree.root, tree.top);
    if (!fs.existsSync(path.join(dir, "package.json")))
        return null;
    const hash = depsHash(dir, manager);
    const record = path.join(stateDir, DEPS);
    let previous = null;
    try {
        previous = JSON.parse(fs.readFileSync(record, "utf8")).hash;
    }
    catch {
        // never installed
    }
    if (previous === hash && fs.existsSync(path.join(dir, "node_modules")))
        return null;
    const command = manager.install.join(" ");
    log(command);
    const [bin, ...args] = manager.install;
    const res = spawnSync(bin, args, { cwd: dir, encoding: "utf8", env: { ...process.env, CI: "1" }, maxBuffer: 256 * 1024 * 1024 });
    if (res.error || res.status !== 0) {
        const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim().split("\n").slice(-30).join("\n");
        throw new Error(`Installing the worktree's dependencies failed (${command} in ${path.relative(tree.top, dir) || "."}): ${res.error?.message ?? `exit ${res.status}`}\n${output}`);
    }
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(record, `${JSON.stringify({ hash, command }, null, 2)}\n`);
    return command;
}
// ---------------------------------------------------------------------------
// Paths
/**
 * Rewrite every string in `value` that's a path into the worktree (`from`)
 * to the same path in the repository (`to`), in place. What a capture
 * records about files (source locations, stylesheet files) is about the
 * repository's files: the worktree's are only a copy of them at the commit.
 */
export function rehome(value, from, to) {
    if (from === to)
        return value;
    const swap = (s) => {
        if (s === from)
            return to;
        if (s.startsWith(`${from}/`))
            return to + s.slice(from.length);
        const url = `file://${from}/`;
        if (s.startsWith(url))
            return `file://${to}/${s.slice(url.length)}`;
        return s;
    };
    const seen = new Set();
    const visit = (v) => {
        if (typeof v === "string")
            return swap(v);
        if (!v || typeof v !== "object" || seen.has(v))
            return v;
        seen.add(v);
        if (Array.isArray(v)) {
            for (let i = 0; i < v.length; i++)
                v[i] = visit(v[i]);
        }
        else if (v instanceof Map) {
            for (const [k, item] of v)
                v.set(k, visit(item));
        }
        else {
            for (const k of Object.keys(v))
                v[k] = visit(v[k]);
        }
        return v;
    };
    return visit(value);
}
