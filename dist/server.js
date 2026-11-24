import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { detectFramework } from "./fileroutes.js";
import { isGitRepo } from "./git.js";
import { realpath } from "./reactsource.js";
import { changesDependencies, copyIgnored, installDependencies, openWorktree, pendingChanges, syncInPlace } from "./worktree.js";
const DEFAULT_START_TIMEOUT_MS = 120_000;
/** How long the server gets to notice the files changed under it before pages are requested. */
const DEFAULT_SYNC_SETTLE_MS = 1000;
/** The flags each framework's dev server takes for its port and host. */
const PORT_FLAGS = {
    next: "--port {port} --hostname {host}",
    vite: "--port {port} --strictPort --host {host}",
    astro: "--port {port} --host {host}",
};
function readPackage(root) {
    try {
        return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    }
    catch {
        return null;
    }
}
/** The project's framework, when it's one whose dev server tunnelvision can start. */
export function devFramework(root) {
    const routes = detectFramework(root);
    if (routes)
        return routes;
    const pkg = readPackage(root);
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    if ("vite" in deps)
        return "vite";
    return null;
}
/**
 * The command that starts a framework's dev server. The project's own `dev`
 * script is followed when its one command runs the framework (so `next dev
 * --turbopack` stays Turbopack), keeping what comes before it on the line
 * (env assignments, an env loader like `dotenvx run --`) but not whatever
 * port or host it pins. A script that runs other commands too (`&&`,
 * `concurrently`) is left out for the framework alone.
 */
export function devCommand(root, framework) {
    const bin = framework;
    const sub = framework === "vite" ? "" : " dev";
    const script = readPackage(root)?.scripts?.dev ?? "";
    // No shell operators or quotes: the framework has to be the line's one command, run last.
    const plain = "[^&|;<>'\"]";
    const own = script.match(new RegExp(`^\\s*((?:${plain}*?\\s)?)${bin}${sub}((?:\\s+${plain}+?)?)\\s*$`));
    const prefix = own ? own[1].trim() : "";
    const flags = own
        ? own[2]
            .replace(/\s(?:--port|-p|--hostname|-H|--host)(?:=\S+|\s+(?!-)\S+|(?=\s|$))/g, "")
            .replace(/\s(?:--strictPort|--open)(?=\s|$)/g, "")
            .trim()
        : "";
    return [prefix, `${bin}${sub}`, flags, PORT_FLAGS[framework], ...extraFlags(root, framework)].filter(Boolean).join(" ");
}
/** The installed major version of a package, from the project's node_modules or its declared range. */
function majorVersion(root, name) {
    try {
        const installed = JSON.parse(fs.readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8"));
        if (installed.version)
            return Number(installed.version.split(".")[0]);
    }
    catch {
        // not installed here
    }
    const pkg = readPackage(root);
    const range = { ...pkg?.dependencies, ...pkg?.devDependencies }[name];
    const m = range?.match(/(\d+)/);
    return m ? Number(m[1]) : null;
}
/**
 * Flags a framework needs to run as a capture's server. Astro 7 sends its dev
 * server to the background when it thinks an agent started it, and the
 * foreground command exits at once; `--ignore-lock` keeps it in the
 * foreground, where stopping the capture stops it.
 */
function extraFlags(root, framework) {
    if (framework === "astro" && (majorVersion(root, "astro") ?? 0) >= 7)
        return ["--ignore-lock"];
    return [];
}
/** A port for the project, the same every run: one of 41000-41999, from its path. */
export function projectPort(root) {
    const n = crypto.createHash("sha256").update(realpath(root)).digest().readUInt32BE(0);
    return 41000 + (n % 1000);
}
/** The host the server is reached at: the user's server's when it's a local name, so saved cookies still apply. */
function localHost(baseUrl) {
    try {
        const host = new URL(baseUrl).hostname;
        if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost"))
            return host;
    }
    catch {
        // fall through
    }
    return "localhost";
}
/** Decide how this capture's app is served. */
export function planServer(root, config) {
    const { server } = config;
    if (server.external !== undefined) {
        return { mode: "external", url: server.external === true ? config.baseUrl : server.external, why: "told to (--base-url or server.external)" };
    }
    if (!isGitRepo(root))
        return { mode: "external", url: config.baseUrl, why: "not a git repository, so there's no snapshot to serve" };
    const framework = devFramework(root);
    const command = server.command ?? (framework ? devCommand(root, framework) : null);
    if (!command) {
        return {
            mode: "external",
            url: config.baseUrl,
            why: "tunnelvision can't tell how to start this app's dev server (set server.command)",
        };
    }
    return {
        mode: "owned",
        command,
        framework: server.command ? "custom" : framework,
        port: server.port ?? projectPort(root),
        portFixed: server.port !== undefined,
        host: localHost(config.baseUrl),
    };
}
function portFree(port, host) {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.once("error", () => resolve(false));
        probe.listen(port, host === "localhost" ? undefined : host, () => probe.close(() => resolve(true)));
    });
}
/** The planned port, or the next free one after it when it's taken and wasn't set in the config. */
async function choosePort(plan) {
    for (let port = plan.port; port < plan.port + (plan.portFixed ? 1 : 50); port++) {
        if (await portFree(port, plan.host))
            return port;
    }
    throw new Error(plan.portFixed
        ? `Port ${plan.port} (server.port) is in use. Free it or choose another.`
        : `No free port in ${plan.port}-${plan.port + 49} for tunnelvision's dev server. Set server.port.`);
}
/** Where a server's output goes, for when it fails. */
export function serverLog(paths) {
    return path.join(paths.dir, "server.log");
}
/** The last lines of a log, for an error message. */
function tail(file, lines = 40) {
    try {
        return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
    }
    catch {
        return "";
    }
}
export class ServerError extends Error {
}
// Not SIGHUP: the post-commit hook runs reviews under `nohup`, which ignores it, and a listener would undo that.
const SIGNALS = ["SIGINT", "SIGTERM"];
/** A running owned dev server. */
export class OwnedServer {
    child;
    origin;
    tree;
    log;
    cold;
    exited = null;
    onExit = () => this.kill("SIGKILL");
    /**
     * The server is in its own process group, so a Ctrl-C in the terminal
     * doesn't reach it, and Node skips `exit` listeners when a signal ends it.
     */
    onSignal = (signal) => {
        this.kill("SIGKILL");
        process.exit(128 + (signal === "SIGINT" ? 2 : 15));
    };
    constructor(child, 
    /** The server's origin, e.g. `http://localhost:41234`. */
    origin, tree, log, 
    /** The worktree's dependencies were installed (or it was created) for this capture, so the server's caches are cold. */
    cold) {
        this.child = child;
        this.origin = origin;
        this.tree = tree;
        this.log = log;
        this.cold = cold;
        child.once("exit", (code, signal) => {
            this.exited = { code, signal };
        });
        process.once("exit", this.onExit);
        for (const signal of SIGNALS)
            process.once(signal, this.onSignal);
    }
    /**
     * Sync the worktree to `rev`, install its dependencies if they changed,
     * start the dev server in it, and wait until it answers.
     */
    static async start(paths, config, plan, rev, say) {
        const stateDir = path.join(paths.dir, "server");
        let t = Date.now();
        // The server starts on the files its caches were built from (where the last capture left the
        // worktree) and sees them change to `rev` while it runs, as a dev server sees an editor's saves.
        // Changed with it stopped, Turbopack's persistent cache keeps serving the old compile.
        const { tree, created } = openWorktree(paths.root, paths.dir, rev);
        const pending = pendingChanges(tree, rev);
        // New dependencies have to be installed before the server starts, so those files can't wait.
        const syncFirst = changesDependencies(pending);
        if (syncFirst)
            syncInPlace(tree, rev);
        const copied = copyIgnored(paths.root, tree, config.server.copyIgnored ?? [], stateDir);
        say(`worktree ready${copied.length ? `, with ${copied.join(", ")}` : ""} (${elapsed(t)})`);
        t = Date.now();
        const installed = installDependencies(tree, stateDir, (cmd) => say(`installing dependencies: ${cmd}`));
        if (installed)
            say(`dependencies installed (${elapsed(t)})`);
        const port = await choosePort(plan);
        const command = plan.command.replace(/\{port\}/g, String(port)).replace(/\{host\}/g, plan.host);
        const log = serverLog(paths);
        fs.writeFileSync(log, `$ ${command}\n`);
        const out = fs.openSync(log, "a");
        const bin = path.join(tree.root, "node_modules", ".bin");
        const child = spawn(command, {
            cwd: tree.root,
            shell: true,
            // Its own process group, so stopping it stops whatever it started.
            detached: true,
            stdio: ["ignore", out, out],
            env: {
                ...process.env,
                PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
                PORT: String(port),
                HOST: plan.host,
                BROWSER: "none",
                FORCE_COLOR: "0",
                NEXT_TELEMETRY_DISABLED: "1",
                ASTRO_TELEMETRY_DISABLED: "1",
                TUNNELVISION_SERVER: "1",
                // Development mode: React only records where JSX was written in a development build.
                NODE_ENV: "development",
            },
        });
        fs.closeSync(out);
        const origin = `http://${plan.host}:${port}`;
        const server = new OwnedServer(child, origin, tree, log, created || Boolean(installed));
        t = Date.now();
        try {
            await server.waitUntilReady(config.server.startTimeout ?? DEFAULT_START_TIMEOUT_MS);
        }
        catch (err) {
            await server.stop();
            throw err;
        }
        say(`${plan.framework} dev server at ${origin} (${elapsed(t)})`);
        if (!syncFirst && pending.length) {
            t = Date.now();
            try {
                syncInPlace(tree, rev);
                // The watcher's events and the invalidation they cause arrive asynchronously.
                await new Promise((r) => setTimeout(r, config.server.syncSettle ?? DEFAULT_SYNC_SETTLE_MS));
            }
            catch (err) {
                await server.stop();
                throw err;
            }
            say(`worktree at ${rev.slice(0, 7)}: ${pending.length} file(s) changed under the running server (${elapsed(t)})`);
        }
        else {
            say(`worktree at ${rev.slice(0, 7)}`);
        }
        return server;
    }
    async waitUntilReady(timeout) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (this.exited) {
                throw new ServerError(`tunnelvision's dev server exited before it was ready (${this.exited.signal ?? `exit ${this.exited.code}`}). From .tunnelvision/server.log:\n${this.tail()}`);
            }
            try {
                await fetch(this.origin, { redirect: "manual", signal: AbortSignal.timeout(2000) });
                return;
            }
            catch {
                await new Promise((r) => setTimeout(r, 200));
            }
        }
        throw new ServerError(`tunnelvision's dev server didn't answer within ${timeout / 1000}s (server.startTimeout). From .tunnelvision/server.log:\n${this.tail()}`);
    }
    /** Why the server can't be captured from now, if it can't: it stopped. */
    failure() {
        if (!this.exited)
            return null;
        return `tunnelvision's dev server stopped during the capture (${this.exited.signal ?? `exit ${this.exited.code}`}). From .tunnelvision/server.log:\n${this.tail()}`;
    }
    kill(signal) {
        if (this.exited || this.child.pid === undefined)
            return;
        try {
            process.kill(-this.child.pid, signal);
        }
        catch {
            // already gone
        }
    }
    async stop() {
        process.removeListener("exit", this.onExit);
        for (const signal of SIGNALS)
            process.removeListener(signal, this.onSignal);
        if (this.exited)
            return;
        const gone = new Promise((resolve) => this.child.once("exit", () => resolve()));
        this.kill("SIGTERM");
        const timer = new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000).unref());
        if ((await Promise.race([gone, timer])) === "timeout")
            this.kill("SIGKILL");
    }
    /** The last lines the server wrote, with the worktree's paths shown as the repository's. */
    tail(lines) {
        return tail(this.log, lines).split(`${this.tree.top}/`).join(`${this.tree.repoTop}/`);
    }
}
function elapsed(since) {
    return `${((Date.now() - since) / 1000).toFixed(1)}s`;
}
/** Module scripts a page's HTML loads from its own server (Vite's entry modules), which compile when requested. */
export function moduleScripts(html, pageUrl) {
    const origin = new URL(pageUrl).origin;
    return [...html.matchAll(/<script\b[^>]*\btype=["']?module["']?[^>]*>/gi)]
        .map((m) => m[0].match(/\bsrc=["']([^"']+)["']/i)?.[1])
        .filter((src) => Boolean(src))
        .map((src) => new URL(src.replace(/&amp;/g, "&"), pageUrl))
        .filter((u) => u.origin === origin)
        .map((u) => u.href);
}
/**
 * Request every page at once (and the module scripts its HTML loads), so the
 * dev server compiles them all in parallel before the browser asks for them
 * one capture slot at a time. A page the server can't build (a 5xx) is a
 * failure: its screenshot would be an error page, not the app.
 */
export async function warmUp(urls, cookie, timeoutMs = 120_000) {
    const headers = { accept: "text/html", ...(cookie ? { cookie } : {}) };
    const seenScripts = new Set();
    const failures = [];
    // Redirects are followed only on the server's own origin: a login page elsewhere (an auth
    // provider) compiles nothing here, and requests to it count against its rate limits.
    const get = async (url, accept) => {
        try {
            let at = url;
            for (let hops = 0;; hops++) {
                const res = await fetch(at, { headers: accept ? { ...headers, accept } : headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
                const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
                if (!location || hops >= 5)
                    return res;
                const next = new URL(location, at);
                if (next.origin !== new URL(url).origin)
                    return res;
                await res.arrayBuffer().catch(() => null);
                at = next.href;
            }
        }
        catch (err) {
            failures.push({ url, status: null, error: err.message });
            return null;
        }
    };
    await Promise.all(urls.map(async (url) => {
        const res = await get(url);
        if (!res)
            return;
        const html = await res.text().catch(() => "");
        if (res.status >= 500) {
            failures.push({ url, status: res.status });
            return;
        }
        const scripts = moduleScripts(html, url).filter((s) => !seenScripts.has(s));
        for (const s of scripts)
            seenScripts.add(s);
        await Promise.all(scripts.map(async (s) => {
            const r = await get(s, "*/*");
            if (r && r.status >= 500)
                failures.push({ url: s, status: r.status });
            await r?.arrayBuffer().catch(() => null);
        }));
    }));
    return failures;
}
/**
 * The saved login (Playwright storage state, taken on the user's own server
 * by `tunnelvision auth`) as it applies to the owned server. Cookies are kept
 * for a host whatever its port, so they carry over as they are; local
 * storage and IndexedDB belong to an origin, which includes the port, so the
 * user's server's origin is rewritten to the owned server's.
 */
export function rehostAuth(state, from, to) {
    const fromUrl = new URL(from);
    const toOrigin = new URL(to).origin;
    const sameHost = (origin) => {
        try {
            const u = new URL(origin);
            return u.hostname === fromUrl.hostname && u.protocol === fromUrl.protocol;
        }
        catch {
            return false;
        }
    };
    const origins = (state.origins ?? []).filter((o) => o.origin === fromUrl.origin || sameHost(o.origin));
    // The user's server's own origin wins over others on the same host.
    origins.sort((a, b) => Number(a.origin === fromUrl.origin) - Number(b.origin === fromUrl.origin));
    const rest = (state.origins ?? []).filter((o) => !origins.includes(o) && o.origin !== toOrigin);
    const moved = origins.length ? [{ ...origins[origins.length - 1], origin: toOrigin }] : [];
    return { ...state, origins: [...rest, ...moved] };
}
/** Write the saved login rehosted onto the owned server, for the capture's browser. Null when there's none. */
export function writeRehostedAuth(paths, authFile, from, to) {
    if (!authFile)
        return null;
    let state;
    try {
        state = JSON.parse(fs.readFileSync(authFile, "utf8"));
    }
    catch {
        return null;
    }
    const out = path.join(paths.dir, "server", "auth.json");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(rehostAuth(state, from, to), null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(out, 0o600);
    return out;
}
/** One line on how the app will be served, for capture output. */
export function describePlan(plan) {
    return plan.mode === "owned"
        ? `starting tunnelvision's own ${plan.framework === "custom" ? "" : `${plan.framework} `}dev server on a snapshot of the code`
        : `capturing the server at ${plan.url} (${plan.why})`;
}
