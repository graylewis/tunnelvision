import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STABILIZE_JS } from "./stabilize.js";
/**
 * Drive Playwright directly for `--by-element` captures. shot-scraper can't
 * measure elements and screenshot them from the same page load (its
 * `javascript` command has no viewport or screenshot support), so we run a
 * small driver script on the Python/Playwright install that shot-scraper
 * already uses.
 */
/** The driver, shipped alongside `dist/` (see `files` in package.json). */
const DRIVER = fileURLToPath(new URL("../assets/capture.py", import.meta.url));
const INSTALL_HINT = "--by-element needs the Python Playwright that shot-scraper uses.\n" +
    "Install shot-scraper (and run `shot-scraper install`) in the environment on your PATH.";
function findOnPath(bin) {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
        const candidate = path.join(dir, bin);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        }
        catch {
            // keep looking
        }
    }
    return null;
}
/** The interpreter a console-script launcher runs, from its shebang (or uv/pip's sh trampoline). */
function interpreterOf(script) {
    let head;
    try {
        head = fs.readFileSync(script, "utf8").slice(0, 1024);
    }
    catch {
        return null;
    }
    const trampoline = head.match(/^'''exec' '([^']+)'/m) ?? head.match(/^'''exec' "([^"]+)"/m);
    if (trampoline)
        return trampoline[1];
    const shebang = head.match(/^#!\s*(\S+)(?:\s+(\S+))?/);
    if (!shebang)
        return null;
    if (/python/.test(shebang[1]))
        return shebang[1];
    // `#!/usr/bin/env python3`
    if (shebang[1].endsWith("/env") && shebang[2] && /python/.test(shebang[2]))
        return shebang[2];
    return null;
}
function hasPlaywright(python) {
    const r = spawnSync(python, ["-c", "import playwright.async_api"], { stdio: "ignore" });
    return r.status === 0;
}
let cachedPython = null;
/** Locate a Python with Playwright installed, preferring shot-scraper's own. Throws if none. */
export function findPlaywrightPython() {
    if (cachedPython)
        return cachedPython;
    const candidates = [];
    const shotScraper = findOnPath("shot-scraper");
    if (shotScraper) {
        const interp = interpreterOf(shotScraper);
        if (interp)
            candidates.push(interp);
        const binDir = path.dirname(shotScraper);
        candidates.push(path.join(binDir, "python3"), path.join(binDir, "python"));
    }
    candidates.push("python3", "python");
    for (const python of candidates) {
        if (hasPlaywright(python)) {
            cachedPython = python;
            return python;
        }
    }
    throw new Error(INSTALL_HINT);
}
/**
 * Capture `pages` with one page load each: wait, extract the element tree, and
 * write a full-page screenshot. Results are returned in input order. `onPage`
 * fires as each page completes.
 */
export function capturePages(pages, opts, onPage) {
    const python = findPlaywrightPython();
    for (const page of pages)
        fs.mkdirSync(path.dirname(page.output), { recursive: true });
    return new Promise((resolve, reject) => {
        const proc = spawn(python, [DRIVER], { stdio: ["pipe", "pipe", "inherit"] });
        const results = pages.map(() => ({ ok: false, error: "not captured" }));
        let buffered = "";
        proc.stdout.setEncoding("utf8");
        proc.stdout.on("data", (chunk) => {
            buffered += chunk;
            let nl;
            while ((nl = buffered.indexOf("\n")) >= 0) {
                const line = buffered.slice(0, nl).trim();
                buffered = buffered.slice(nl + 1);
                if (!line)
                    continue;
                try {
                    const msg = JSON.parse(line);
                    const result = msg.ok
                        ? { ok: true, tree: Array.isArray(msg.tree) ? msg.tree : [] }
                        : { ok: false, error: msg.error ?? "unknown error" };
                    results[msg.index] = result;
                    onPage?.(msg.index, result);
                }
                catch {
                    // ignore stray output
                }
            }
        });
        proc.on("error", reject);
        proc.on("close", (code) => {
            if (code !== 0 && results.every((r) => !r.ok)) {
                reject(new Error(`Playwright capture failed (exit ${code}).`));
            }
            else {
                resolve(results);
            }
        });
        proc.stdin.end(JSON.stringify({
            viewport: opts.viewport,
            scaleFactor: opts.scaleFactor,
            authFile: opts.authFile ?? null,
            concurrency: opts.concurrency,
            extractJs: opts.extractJs,
            stabilizeJs: STABILIZE_JS,
            pages,
        }));
    });
}
