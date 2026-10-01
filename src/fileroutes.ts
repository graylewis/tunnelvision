import fs from "node:fs";
import path from "node:path";

/** Frameworks whose pages are read from their file-based routes. */
export type Framework = "next" | "astro";

export const FRAMEWORK_NAMES: Record<Framework, string> = { next: "Next.js", astro: "Astro" };

/** Next's default `pageExtensions`. */
const NEXT_EXTENSIONS = ["tsx", "ts", "jsx", "js"];

/** Files Astro renders as pages; `.js`/`.ts` files are endpoints, not pages. */
const ASTRO_EXTENSIONS = ["astro", "mdx", "md", "markdown", "mdown", "mkdn", "mkd", "mdwn", "html"];

export interface FileRoutes {
	framework: Framework;
	/** Route folders scanned, relative to the project root (e.g. "src/app"). */
	dirs: string[];
	/** Concrete URL paths (e.g. "/pricing"). */
	paths: string[];
	/** Route patterns that need parameters (e.g. "/blog/[slug]"). */
	dynamic: string[];
}

function configFile(root: string, tool: Framework): string | undefined {
	const re = new RegExp(`^${tool}\\.config\\.(js|cjs|mjs|ts|cts|mts)$`);
	try {
		const name = fs.readdirSync(root).find((f) => re.test(f));
		return name ? path.join(root, name) : undefined;
	} catch {
		return undefined;
	}
}

function dependsOn(root: string, name: string): boolean {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
		return name in { ...pkg.dependencies, ...pkg.devDependencies };
	} catch {
		return false;
	}
}

/** A Next.js or Astro project has the framework's config file or depends on it. */
export function detectFramework(root: string): Framework | null {
	for (const framework of ["next", "astro"] as const) {
		if (configFile(root, framework) || dependsOn(root, framework)) return framework;
	}
	return null;
}

/** A string option from the framework config when it's written as a literal. */
function configString(root: string, framework: Framework, key: string): string | undefined {
	const file = configFile(root, framework);
	if (!file) return undefined;
	return new RegExp(`${key}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`).exec(fs.readFileSync(file, "utf8"))?.[1];
}

/**
 * `pageExtensions` from the Next config when it's written as a literal array,
 * longest first so "page.tsx" is tried before "tsx".
 */
function nextPageExtensions(root: string): string[] {
	const file = configFile(root, "next");
	let exts: string[] = [];
	if (file) {
		const m = /pageExtensions\s*:\s*\[([^\]]*)\]/.exec(fs.readFileSync(file, "utf8"));
		if (m) exts = [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]);
	}
	return (exts.length > 0 ? exts : NEXT_EXTENSIONS).sort((a, b) => b.length - a.length);
}

function isDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function entries(dir: string): fs.Dirent[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** Segments of every page under a Next App Router `app/` directory. */
function appPages(dir: string, exts: string[]): string[][] {
	const found: string[][] = [];
	const walk = (d: string, segments: string[]) => {
		for (const entry of entries(d)) {
			const name = entry.name;
			if (entry.isFile()) {
				if (exts.some((e) => name === `page.${e}`)) found.push(segments);
				continue;
			}
			if (!entry.isDirectory()) continue;
			// Private folders and intercepting routes aren't URLs of their own.
			if (name.startsWith("_") || /^\(\.{1,3}\)/.test(name)) continue;
			const child = path.join(d, name);
			// Route groups and parallel-route slots don't add a URL segment.
			if (/^\(.+\)$/.test(name) || name.startsWith("@")) walk(child, segments);
			else walk(child, [...segments, name]);
		}
	};
	walk(dir, []);
	return found;
}

/**
 * Segments of every page under a `pages/` directory, Next's Pages Router or
 * Astro's. `_`-prefixed files aren't pages, nor are the top-level 404 and 500
 * error pages; `api/` (Next) and `_`-prefixed directories (Astro) are skipped.
 */
function pagesPages(dir: string, exts: string[], skipDir: (name: string, top: boolean) => boolean): string[][] {
	const found: string[][] = [];
	const walk = (d: string, segments: string[]) => {
		const top = segments.length === 0;
		for (const entry of entries(d)) {
			const name = entry.name;
			if (entry.isDirectory()) {
				if (!skipDir(name, top)) walk(path.join(d, name), [...segments, name]);
				continue;
			}
			if (!entry.isFile() || name.endsWith(".d.ts")) continue;
			const ext = exts.find((e) => name.endsWith(`.${e}`));
			if (!ext) continue;
			const base = name.slice(0, -(ext.length + 1));
			if (base.startsWith("_") || (top && (base === "404" || base === "500"))) continue;
			found.push(base === "index" ? segments : [...segments, base]);
		}
	};
	walk(dir, []);
	return found;
}

/** Next: `app/` and `pages/`, each at the root or, failing that, under `src/`. */
function nextRouteDirs(root: string): [string, string[][]][] {
	const exts = nextPageExtensions(root);
	const found: [string, string[][]][] = [];
	const app = [path.join(root, "app"), path.join(root, "src", "app")].find(isDir);
	if (app) found.push([app, appPages(app, exts)]);
	const pages = [path.join(root, "pages"), path.join(root, "src", "pages")].find(isDir);
	if (pages) found.push([pages, pagesPages(pages, exts, (name, top) => top && name === "api")]);
	return found;
}

/** Astro: `pages/` under `srcDir` (default `src`). */
function astroRouteDirs(root: string): [string, string[][]][] {
	const pages = path.resolve(root, configString(root, "astro", "srcDir") ?? "src", "pages");
	if (!isDir(pages)) return [];
	return [[pages, pagesPages(pages, ASTRO_EXTENSIONS, (name) => name.startsWith("_"))]];
}

const hasParam = (segment: string) => /\[.+?\]/.test(segment);
const isRest = (segment: string) => /^\[\.\.\..+\]$/.test(segment);

/**
 * A segment that matches any number of segments, including none: Next's
 * optional catch-all `[[...x]]`, or an Astro rest parameter `[...x]`.
 */
function isOptionalRest(segment: string, framework: Framework): boolean {
	return /^\[\[\.\.\..+\]\]$/.test(segment) || (framework === "astro" && isRest(segment));
}

const toPath = (segments: string[]) => `/${segments.join("/")}`;

/** Work out a Next.js or Astro project's pages from its route folders. */
export function findRoutes(root: string, framework: Framework): FileRoutes {
	const found = framework === "next" ? nextRouteDirs(root) : astroRouteDirs(root);
	const paths = new Set<string>();
	const dynamic = new Set<string>();
	for (const [, routes] of found) {
		for (const segments of routes) {
			if (!segments.some(hasParam)) {
				paths.add(toPath(segments));
				continue;
			}
			dynamic.add(toPath(segments));
			// A route ending in an optional rest also serves its parent path.
			const parent = segments.slice(0, -1);
			if (isOptionalRest(segments[segments.length - 1], framework) && !parent.some(hasParam)) {
				paths.add(toPath(parent));
			}
		}
	}
	return {
		framework,
		dirs: found.map(([dir]) => path.relative(root, dir)),
		paths: [...paths].sort(),
		dynamic: [...dynamic].sort(),
	};
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Regex matching the URL paths a route pattern like "/blog/[slug]" serves. */
export function routePattern(route: string, framework: Framework): RegExp {
	const body = route
		.split("/")
		.filter(Boolean)
		.map((segment) => {
			if (isOptionalRest(segment, framework)) return "(?:/[^?#]+)?";
			if (isRest(segment)) return "/[^?#]+";
			// Astro allows params mixed with text in a segment, like "[lang]-[version]".
			const parts = segment.split(/(\[[^\]]+\])/).map((part) => {
				if (/^\[\.\.\..+\]$/.test(part)) return "[^?#]+";
				if (/^\[.+\]$/.test(part)) return "[^/?#]+";
				return escape(part);
			});
			return `/${parts.join("")}`;
		})
		.join("");
	return new RegExp(`^${body || "/"}/?$`);
}
