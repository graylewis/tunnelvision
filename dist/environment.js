import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Versions cheat mode's validation is tied to (see
 * docs/adr/0008-cheat-mode-is-opt-in-and-validated.md): tunnelvision's own,
 * and the installed versions of the project's framework, dev server and
 * the libraries that change what a page renders or how it hydrates.
 */
const WATCHED = [
    "astro",
    "next",
    "vite",
    "nuxt",
    "@sveltejs/kit",
    "svelte",
    "vue",
    "react",
    "react-dom",
    "solid-js",
    "@remix-run/react",
    "@tanstack/react-start",
    "@tanstack/react-router",
    "tailwindcss",
    "framer-motion",
    "motion",
];
function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch {
        return null;
    }
}
/** tunnelvision's own version. */
export function toolVersion() {
    const pkg = readJson(fileURLToPath(new URL("../package.json", import.meta.url)));
    return typeof pkg?.version === "string" ? pkg.version : "unknown";
}
/** `{ tunnelvision, <package>: <installed version> }` for the watched packages the project depends on. */
export function environmentVersions(root) {
    const out = { tunnelvision: toolVersion() };
    const pkg = readJson(path.join(root, "package.json"));
    const declared = {
        ...(pkg?.dependencies ?? {}),
        ...(pkg?.devDependencies ?? {}),
    };
    for (const name of WATCHED) {
        if (!(name in declared))
            continue;
        const installed = readJson(path.join(root, "node_modules", name, "package.json"));
        out[name] = typeof installed?.version === "string" ? installed.version : declared[name];
    }
    return out;
}
/** What changed between the versions cheat mode was validated with and now, e.g. `astro 5.1.0 → 5.2.0`. */
export function versionChanges(validated, current) {
    const names = [...new Set([...Object.keys(validated), ...Object.keys(current)])].sort();
    return names
        .filter((n) => validated[n] !== current[n])
        .map((n) => `${n} ${validated[n] ?? "(none)"} → ${current[n] ?? "(none)"}`);
}
