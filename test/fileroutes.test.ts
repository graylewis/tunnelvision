import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { detectFramework, findRoutes, routePattern } from "../src/fileroutes.js";
import { discoverPages } from "../src/pagesource.js";

/** Make a throwaway project from a map of relative path -> contents. */
function project(files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tv-next-"));
	for (const [rel, contents] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), contents);
	}
	return root;
}

const NEXT_PKG = JSON.stringify({ dependencies: { next: "15.0.0" } });
const ASTRO_PKG = JSON.stringify({ dependencies: { astro: "5.0.0" } });

const sitemap = (...paths: string[]) =>
	`<?xml version="1.0"?><urlset>${paths.map((p) => `<url><loc>https://example.com${p}</loc></url>`).join("")}</urlset>`;

test("detectFramework: dependency or config file", () => {
	assert.equal(detectFramework(project({ "package.json": NEXT_PKG })), "next");
	assert.equal(detectFramework(project({ "next.config.mjs": "export default {}" })), "next");
	assert.equal(detectFramework(project({ "package.json": ASTRO_PKG })), "astro");
	assert.equal(detectFramework(project({ "astro.config.mjs": "export default {}" })), "astro");
	assert.equal(detectFramework(project({ "package.json": JSON.stringify({ dependencies: { vite: "5" } }) })), null);
	assert.equal(detectFramework(project({})), null);
});

test("findRoutes (Next): App Router groups, slots, private and intercepting folders", () => {
	const root = project({
		"package.json": NEXT_PKG,
		"app/page.tsx": "",
		"app/layout.tsx": "",
		"app/(marketing)/pricing/page.tsx": "",
		"app/(marketing)/about/page.mdx": "",
		"app/dashboard/@stats/page.tsx": "",
		"app/dashboard/page.tsx": "",
		"app/dashboard/settings/page.js": "",
		"app/_components/page.tsx": "",
		"app/feed/(..)photo/[id]/page.tsx": "",
		"app/api/health/route.ts": "",
		"app/blog/[slug]/page.tsx": "",
		"app/docs/[[...path]]/page.tsx": "",
	});
	const routes = findRoutes(root, "next");
	assert.deepEqual(routes.dirs, ["app"]);
	assert.deepEqual(routes.paths, ["/", "/dashboard", "/dashboard/settings", "/docs", "/pricing"]);
	assert.deepEqual(routes.dynamic, ["/blog/[slug]", "/docs/[[...path]]"]);
});

test("findRoutes (Next): Pages Router skips api, special files and error pages", () => {
	const root = project({
		"package.json": NEXT_PKG,
		"src/pages/index.tsx": "",
		"src/pages/_app.tsx": "",
		"src/pages/_document.tsx": "",
		"src/pages/404.tsx": "",
		"src/pages/api/hello.ts": "",
		"src/pages/contact.jsx": "",
		"src/pages/blog/index.tsx": "",
		"src/pages/blog/[...slug].tsx": "",
		"src/pages/types.d.ts": "",
		"src/pages/styles.css": "",
	});
	const routes = findRoutes(root, "next");
	assert.deepEqual(routes.dirs, [path.join("src", "pages")]);
	assert.deepEqual(routes.paths, ["/", "/blog", "/contact"]);
	assert.deepEqual(routes.dynamic, ["/blog/[...slug]"]);
});

test("findRoutes (Next): root app/ wins over src/app, pageExtensions from next.config", () => {
	const root = project({
		"next.config.js": "module.exports = { pageExtensions: ['page.tsx', 'mdx'] }",
		"app/page.page.tsx": "",
		"src/app/ignored/page.tsx": "",
		"pages/home.page.tsx": "",
		"pages/Button.tsx": "",
		"pages/guide.mdx": "",
	});
	const routes = findRoutes(root, "next");
	assert.deepEqual(routes.dirs, ["app", "pages"]);
	assert.deepEqual(routes.paths, ["/", "/guide", "/home"]);
});

test("routePattern: dynamic, catch-all and optional catch-all segments", () => {
	const next = (route: string) => routePattern(route, "next");
	assert.ok(next("/blog/[slug]").test("/blog/hello"));
	assert.ok(!next("/blog/[slug]").test("/blog/a/b"));
	assert.ok(!next("/blog/[slug]").test("/blog"));
	assert.ok(next("/docs/[...path]").test("/docs/a/b"));
	assert.ok(!next("/docs/[...path]").test("/docs"));
	assert.ok(next("/docs/[[...path]]").test("/docs"));
	assert.ok(next("/docs/[[...path]]").test("/docs/a/b"));
	assert.ok(next("/").test("/"));
	assert.ok(!next("/v1.0").test("/v1x0"));
});

test("routePattern (Astro): rest params match no segments, params mix with text", () => {
	const astro = (route: string) => routePattern(route, "astro");
	assert.ok(astro("/blog/[...slug]").test("/blog"));
	assert.ok(astro("/blog/[...slug]").test("/blog/2024/post"));
	assert.ok(astro("/[...slug]").test("/"));
	assert.ok(astro("/docs/[lang]-[version]").test("/docs/en-v2"));
	assert.ok(!astro("/docs/[lang]-[version]").test("/docs/en"));
	assert.ok(astro("/post-[id]").test("/post-7"));
	assert.ok(!astro("/post-[id]").test("/page-7"));
});

test("findRoutes (Astro): pages, endpoints, underscores, srcDir", () => {
	const root = project({
		"package.json": ASTRO_PKG,
		"src/pages/index.astro": "",
		"src/pages/about.astro": "",
		"src/pages/terms.mdx": "",
		"src/pages/guide.md": "",
		"src/pages/legacy.html": "",
		"src/pages/404.astro": "",
		"src/pages/rss.xml.js": "",
		"src/pages/[page].md.ts": "",
		"src/pages/api/search.ts": "",
		"src/pages/_draft.astro": "",
		"src/pages/_partials/nav.astro": "",
		"src/pages/blog/index.astro": "",
		"src/pages/blog/[...slug].astro": "",
		"src/pages/tags/[tag].astro": "",
	});
	const routes = findRoutes(root, "astro");
	assert.deepEqual(routes.dirs, [path.join("src", "pages")]);
	assert.deepEqual(routes.paths, ["/", "/about", "/blog", "/guide", "/legacy", "/terms"]);
	assert.deepEqual(routes.dynamic, ["/blog/[...slug]", "/tags/[tag]"]);

	const custom = project({
		"astro.config.mjs": "export default defineConfig({ srcDir: './site' })",
		"site/pages/index.astro": "",
		"src/pages/ignored.astro": "",
	});
	assert.deepEqual(findRoutes(custom, "astro"), { framework: "astro", dirs: [path.join("site", "pages")], paths: ["/"], dynamic: [] });
});

test("discoverPages: Next routes win, sitemap fills in dynamic routes", () => {
	const root = project({
		"package.json": NEXT_PKG,
		"app/page.tsx": "",
		"app/pricing/page.tsx": "",
		"app/blog/[slug]/page.tsx": "",
		"app/shop/[id]/page.tsx": "",
		"public/sitemap.xml": sitemap("/", "/stale-page", "/blog/first/", "/blog/second"),
	});
	const source = discoverPages(root);
	assert.equal(source.kind, "next");
	assert.deepEqual(source.locs, [
		"/",
		"/pricing",
		"https://example.com/blog/first/",
		"https://example.com/blog/second",
	]);
	assert.deepEqual(source.notes, [
		"1 dynamic route left out (no matching sitemap URLs): /shop/[id]",
		"1 sitemap URL matches no route file and was left out: /stale-page",
	]);
});

test("discoverPages: Astro routes, rest routes filled from the sitemap", () => {
	const root = project({
		"package.json": ASTRO_PKG,
		"src/pages/index.astro": "",
		"src/pages/blog/index.astro": "",
		"src/pages/blog/[...slug].astro": "",
		"sitemap.xml": sitemap("/", "/blog/", "/blog/2024/hello/", "/docs/intro/"),
	});
	const source = discoverPages(root);
	assert.equal(source.kind, "astro");
	assert.equal(source.from, `Astro routes in ${path.join("src", "pages")}`);
	assert.deepEqual(source.locs, ["/", "/blog", "https://example.com/blog/2024/hello/"]);
	assert.deepEqual(source.notes, ["1 sitemap URL matches no route file and was left out: /docs/intro"]);
});

test("discoverPages: Next project with several sitemaps still works", () => {
	const root = project({
		"package.json": NEXT_PKG,
		"app/page.tsx": "",
		"public/sitemap.xml": sitemap("/"),
		"public/sitemap-2.xml": sitemap("/"),
	});
	assert.deepEqual(discoverPages(root).locs, ["/"]);
});

test("discoverPages: falls back to the sitemap without Next routes", () => {
	const root = project({ "package.json": NEXT_PKG, "public/sitemap.xml": sitemap("/", "/a") });
	const source = discoverPages(root);
	assert.equal(source.kind, "sitemap");
	assert.equal(source.from, path.join("public", "sitemap.xml"));
	assert.deepEqual(source.locs, ["https://example.com/", "https://example.com/a"]);

	assert.throws(() => discoverPages(project({})), /No sitemap found/);
});
