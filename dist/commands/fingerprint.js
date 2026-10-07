import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import { loadConfig, updateConfigFile } from "../config.js";
import { extractScript } from "../elements.js";
import { fingerprintScript, VISUAL_ATTRIBUTES } from "../fingerprint.js";
import { runDriver } from "../playwright.js";
import { prepareCapture } from "./shoot.js";
/** Compare the fingerprints of loads of one page, and say what differed. */
export function compareSamples(samples) {
    if (samples.every((s) => s.fingerprint === samples[0].fingerprint))
        return null;
    const out = { attributes: new Set(), text: 0, elements: 0, resources: new Set() };
    const [first, ...rest] = samples;
    const index = (lines) => {
        const attrs = new Map();
        const other = new Set();
        for (const line of lines) {
            if (line.startsWith("A ")) {
                const [, p, rest] = line.match(/^A (\S+) (.*)$/) ?? [];
                const eq = rest?.indexOf("=") ?? -1;
                if (p && eq > 0)
                    attrs.set(`${p} ${rest.slice(0, eq)}`, rest.slice(eq + 1));
            }
            else
                other.add(line);
        }
        return { attrs, other };
    };
    const a = index(first.dom);
    for (const sample of rest) {
        const b = index(sample.dom);
        for (const key of new Set([...a.attrs.keys(), ...b.attrs.keys()])) {
            if (a.attrs.get(key) !== b.attrs.get(key))
                out.attributes.add(key.slice(key.indexOf(" ") + 1));
        }
        for (const line of new Set([...a.other, ...b.other])) {
            if (a.other.has(line) && b.other.has(line))
                continue;
            if (line.startsWith("T "))
                out.text++;
            else
                out.elements++;
        }
        const ra = new Map(first.resources);
        const rb = new Map(sample.resources);
        for (const url of new Set([...ra.keys(), ...rb.keys()]))
            if (ra.get(url) !== rb.get(url))
                out.resources.add(url);
    }
    return out;
}
/**
 * Load every page several times without changing anything and compare their
 * render fingerprints. A page whose fingerprint varies can never be carried
 * over in cheat mode; the attributes that varied can be left out of the
 * fingerprint (`--save`), the rest needs a look.
 */
export async function fingerprint(opts) {
    const ctx = await prepareCapture({ ...opts, cheat: false });
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tunnelvision-fingerprint-"));
    const auth = path.isAbsolute(ctx.config.authFile) ? ctx.config.authFile : path.join(ctx.paths.root, ctx.config.authFile);
    try {
        for (let round = 0; round < 3; round++) {
            const config = round === 0 ? ctx.config : loadConfig(ctx.paths);
            console.log(pc.bold(`Fingerprinting ${ctx.pages.length} pages ${opts.runs} times`));
            const samples = ctx.pages.map(() => []);
            for (let run = 0; run < opts.runs; run++) {
                await runDriver(ctx.pages.map((page, i) => ({ url: page.url, output: path.join(scratch, `${i}.png`), stabilizeJs: "" })), {
                    viewport: config.viewport,
                    scaleFactor: 1,
                    authFile: fs.existsSync(auth) ? auth : undefined,
                    concurrency: Math.max(1, Math.floor(config.concurrency)),
                    extractJs: extractScript([], []),
                    fingerprintJs: fingerprintScript(config.cheatMode.ignoreAttributes),
                    cheat: false,
                    mode: "fingerprint",
                    knownUrls: ctx.pages.map((p) => p.url),
                    changedSelectors: [],
                }, (ev) => {
                    if (ev.event === "fingerprint") {
                        samples[ev.index].push({ fingerprint: ev.fingerprint, dom: ev.dom ?? [], resources: ev.resources ?? [] });
                    }
                    else if (ev.event === "error") {
                        console.log(pc.red(`  ${ctx.pages[ev.index].url}: ${ev.error}`));
                    }
                });
            }
            const learned = new Set();
            let unstable = 0;
            ctx.pages.forEach((page, i) => {
                if (samples[i].length < opts.runs)
                    return; // redirected or failed
                const v = compareSamples(samples[i]);
                if (!v) {
                    console.log(pc.green(`  ✓ ${page.url}`));
                    return;
                }
                unstable++;
                console.log(pc.yellow(`  ✗ ${page.url}`));
                const visual = [...v.attributes].filter((a) => VISUAL_ATTRIBUTES.includes(a.toLowerCase()));
                const other = [...v.attributes].filter((a) => !VISUAL_ATTRIBUTES.includes(a.toLowerCase()));
                if (other.length)
                    console.log(pc.dim(`      attributes: ${other.join(", ")}`));
                if (visual.length) {
                    console.log(pc.dim(`      ${visual.join(", ")} changed too: the page was still changing when fingerprinted (an animation, or data loading late)`));
                }
                if (v.text)
                    console.log(pc.dim(`      ${v.text} text node(s) differ`));
                if (v.elements)
                    console.log(pc.dim(`      ${v.elements} element(s) differ`));
                if (v.resources.size)
                    console.log(pc.dim(`      resources: ${[...v.resources].slice(0, 5).join(", ")}`));
                for (const a of other)
                    learned.add(a);
            });
            if (unstable === 0) {
                console.log(pc.green(`\n  Every page fingerprints the same on every load.`));
                return 0;
            }
            const fresh = [...learned].filter((a) => !config.cheatMode.ignoreAttributes.includes(a));
            if (!opts.save || fresh.length === 0) {
                console.log(pc.yellow(`\n  ${unstable} page(s) fingerprint differently between loads, so cheat mode can't carry them over.`));
                if (fresh.length)
                    console.log(pc.dim(`  Re-run with --save to ignore: ${fresh.join(", ")}`));
                return 1;
            }
            updateConfigFile(ctx.paths, (raw) => {
                const ignore = new Set([...(raw.cheatMode?.ignoreAttributes ?? []), ...fresh]);
                raw.cheatMode = { ...config.cheatMode, ...(raw.cheatMode ?? {}), ignoreAttributes: [...ignore].sort() };
            });
            console.log(pc.cyan(`\n  Ignoring ${fresh.join(", ")} from now on; checking again.\n`));
        }
        return 1;
    }
    finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}
