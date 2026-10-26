import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginSpec } from "./config.js";

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

function readJson(file: string): Record<string, unknown> | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** tunnelvision's own version. */
export function toolVersion(): string {
	const pkg = readJson(fileURLToPath(new URL("../package.json", import.meta.url)));
	return typeof pkg?.version === "string" ? pkg.version : "unknown";
}

/**
 * `{ tunnelvision, <package>: <installed version> }` for the watched packages
 * the project depends on, and `plugin <spec>` for each state plugin: they
 * decide what a page renders too (see docs/adr/0011).
 */
export function environmentVersions(root: string, plugins: PluginSpec[] = []): Record<string, string> {
	const out: Record<string, string> = { tunnelvision: toolVersion() };
	const pkg = readJson(path.join(root, "package.json"));
	const declared = {
		...((pkg?.dependencies as Record<string, string>) ?? {}),
		...((pkg?.devDependencies as Record<string, string>) ?? {}),
	};
	for (const name of WATCHED) {
		if (!(name in declared)) continue;
		const installed = readJson(path.join(root, "node_modules", name, "package.json"));
		out[name] = typeof installed?.version === "string" ? installed.version : declared[name];
	}
	for (const entry of plugins) {
		const [spec, options] = typeof entry === "string" ? [entry, undefined] : entry;
		out[`plugin ${spec}`] = pluginVersion(root, spec) + (options ? ` ${hash(JSON.stringify(options)).slice(0, 8)}` : "");
	}
	return out;
}

const hash = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

/** A plugin's version: tunnelvision's for a built-in, the installed one for a package, a content hash for a project file. */
function pluginVersion(root: string, spec: string): string {
	if (spec.startsWith("tunnelvision/plugins/")) return toolVersion();
	if (spec.startsWith(".") || path.isAbsolute(spec)) {
		try {
			return `file ${hash(fs.readFileSync(path.resolve(root, spec), "utf8")).slice(0, 12)}`;
		} catch {
			return "missing";
		}
	}
	const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
	const installed = readJson(path.join(root, "node_modules", name, "package.json"));
	return typeof installed?.version === "string" ? installed.version : "missing";
}

/** What changed between the versions cheat mode was validated with and now, e.g. `astro 5.1.0 → 5.2.0`. */
export function versionChanges(validated: Record<string, string>, current: Record<string, string>): string[] {
	const names = [...new Set([...Object.keys(validated), ...Object.keys(current)])].sort();
	return names
		.filter((n) => validated[n] !== current[n])
		.map((n) => `${n} ${validated[n] ?? "(none)"} → ${current[n] ?? "(none)"}`);
}
