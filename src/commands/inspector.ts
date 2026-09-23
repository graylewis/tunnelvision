import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import pc from "picocolors";
import { PNG } from "pngjs";
import { applyOverrides, configExists, DEFAULT_CONFIG, loadConfig, type Overrides } from "../config.js";
import { diffDir, resolvePaths, versionDir, type Paths } from "../paths.js";
import { diffVersions, type DiffReport, type PageDiff, type PageStatus } from "../diffengine.js";
import { listVersions, versionExists } from "../versions.js";
import {
	COMPONENT_FILE,
	ELEMENT_IMAGE,
	ELEMENT_MANIFEST,
	PAGE_IMAGE,
	type ElementManifest,
	type ElementNode,
	type ElementRect,
} from "../elements.js";
import type { ComponentFile } from "../reactsource.js";

/** The single-page UI, shipped alongside `dist/` (see `files` in package.json). */
const PAGE_FILE = new URL("../../assets/inspector.html", import.meta.url);

/**
 * `tunnelvision inspector` — a local web UI for exploring per-element diffs.
 *
 * The server diffs two versions on demand (writing diff images exactly like
 * `tunnelvision diff`), merges both versions' `elements.json` trees by element
 * directory, and annotates every node with its diff status and the React source
 * location recorded in its `component.json`. The browser renders that as a
 * collapsible tree next to before/after/diff images.
 */

export interface InspectorOptions extends Overrides {
	root: string;
	port?: number;
	host?: string;
	open?: boolean;
}

/** Where an element actually sits in a page screenshot, in image pixels. */
interface Located {
	x: number;
	y: number;
	width: number;
	height: number;
	/** False when pixel matching failed and this is just the recorded rect scaled. */
	matched: boolean;
}

/**
 * Find `element` inside `page` by pixel matching, searching outward from the
 * recorded position `(ex, ey)`.
 *
 * The recorded rects can't be trusted on their own. Elements are measured with
 * `shot-scraper javascript`, which always uses Playwright's default 1280×720
 * viewport, but screenshots use the configured viewport. So anything that
 * depends on viewport height (vertically centred layouts, `vh` units) lands
 * somewhere else in `page.png`. The element screenshot comes from the same run
 * as the page screenshot, so matching its pixels gives the true position.
 *
 * We compare only a sparse set of high-contrast "edge" pixels, which makes
 * each candidate cheap and keeps blank areas from matching at the wrong offset.
 */
function locateElement(page: PNG, element: PNG, ex: number, ey: number, dpr: number): Located | null {
	const { width: w, height: h } = element;
	if (w > page.width || h > page.height) return null;
	const e = element.data;
	const p = page.data;

	// The strongest-gradient pixel in each cell of a 16×16 grid over the element.
	const cells = 16;
	const samples: number[] = [];
	for (let cy = 0; cy < cells; cy++) {
		for (let cx = 0; cx < cells; cx++) {
			let best = -1;
			let bestGrad = 30;
			const x0 = Math.floor((cx * w) / cells);
			const x1 = Math.min(w - 1, Math.floor(((cx + 1) * w) / cells));
			const y0 = Math.floor((cy * h) / cells);
			const y1 = Math.min(h - 1, Math.floor(((cy + 1) * h) / cells));
			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) {
					const i = (y * w + x) * 4;
					const r = i + 4;
					const d = i + w * 4;
					let g = 0;
					for (let c = 0; c < 3; c++) g += Math.abs(e[i + c] - e[r + c]) + Math.abs(e[i + c] - e[d + c]);
					if (g > bestGrad) {
						bestGrad = g;
						best = y * w + x;
					}
				}
			}
			if (best >= 0) samples.push(best);
		}
	}
	// A flat element can't be told apart from its surroundings.
	if (samples.length < 4) return null;
	const sx = samples.map((s) => s % w);
	const sy = samples.map((s) => Math.floor(s / w));

	const score = (ox: number, oy: number, limit: number): number => {
		let total = 0;
		for (let k = 0; k < samples.length && total < limit; k++) {
			const i = samples[k] * 4;
			const j = ((oy + sy[k]) * page.width + ox + sx[k]) * 4;
			total += Math.abs(e[i] - p[j]) + Math.abs(e[i + 1] - p[j + 1]) + Math.abs(e[i + 2] - p[j + 2]);
		}
		return total;
	};

	// Search outward from the recorded position so ties go to the nearest offset.
	const outward = (range: number) => {
		const out = [0];
		for (let d = 1; d <= range; d++) out.push(d, -d);
		return out;
	};
	const dxs = outward(Math.round(64 * dpr));
	const dys = outward(Math.round(400 * dpr));
	let best = { x: 0, y: 0, score: Infinity };
	search: for (const dy of dys) {
		const oy = Math.round(ey) + dy;
		if (oy < 0 || oy + h > page.height) continue;
		for (const dx of dxs) {
			const ox = Math.round(ex) + dx;
			if (ox < 0 || ox + w > page.width) continue;
			const sc = score(ox, oy, best.score);
			if (sc < best.score) {
				best = { x: ox, y: oy, score: sc };
				if (sc === 0) break search;
			}
		}
	}
	// Allow for anti-aliasing and compression noise, but reject real mismatches.
	if (best.score / samples.length > 24) return null;
	return { x: best.x, y: best.y, width: w, height: h, matched: true };
}

/** Diff status of a node, plus `missing` when neither version has an image for it. */
type NodeStatus = PageStatus | "missing";

interface InspectorNode {
	tag: string;
	id: string | null;
	className: string | null;
	dir: string;
	selector: string;
	/** Rect in each version, when the element exists there. */
	rect: { from: ElementRect | null; to: ElementRect | null };
	status: NodeStatus;
	diffPercent?: number;
	message?: string;
	/** Which sides have an `element.png`, and whether a diff image was written. */
	images: { from: boolean; to: boolean; diff: boolean };
	/** Contents of `component.json` (target version preferred), when React rendered it. */
	component: ComponentFile | null;
	/** Count of changed/added/removed nodes among descendants. */
	changedDescendants: number;
	children: InspectorNode[];
}

interface InspectorPage {
	slug: string;
	url: string | null;
	byElement: boolean;
	status: NodeStatus;
	diffPercent?: number;
	message?: string;
	/** Relative image path within a version/diff directory. */
	image: string;
	images: { from: boolean; to: boolean; diff: boolean };
	changedElements: number;
	elements: InspectorNode[];
}

interface InspectorDiff {
	from: string;
	to: string;
	summary: Pick<DiffReport, "changedCount" | "addedCount" | "removedCount" | "hasChanges">;
	pages: InspectorPage[];
}

const CHANGE_STATUSES = new Set<NodeStatus>(["changed", "added", "removed", "size-mismatch", "error"]);

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}

/** Page slugs in a version: element-root directories plus flat `<slug>.png` captures. */
function listPages(dir: string): Map<string, { byElement: boolean }> {
	const out = new Map<string, { byElement: boolean }>();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e.isDirectory()) {
			out.set(e.name, { byElement: fs.existsSync(path.join(dir, e.name, ELEMENT_MANIFEST)) });
		} else if (e.name.toLowerCase().endsWith(".png")) {
			const slug = e.name.replace(/\.png$/i, "");
			if (!out.has(slug)) out.set(slug, { byElement: false });
		}
	}
	return out;
}

/** Merge two sibling lists by `dir`, keeping target order and appending baseline-only nodes. */
function mergeSiblings(
	from: ElementNode[],
	to: ElementNode[],
): { dir: string; from: ElementNode | null; to: ElementNode | null }[] {
	const fromByDir = new Map(from.map((n) => [n.dir, n]));
	const toDirs = new Set(to.map((n) => n.dir));
	return [
		...to.map((n) => ({ dir: n.dir, from: fromByDir.get(n.dir) ?? null, to: n })),
		...from.filter((n) => !toDirs.has(n.dir)).map((n) => ({ dir: n.dir, from: n, to: null })),
	];
}

function buildDiff(paths: Paths, overrides: Overrides, from: string, to: string): InspectorDiff {
	const base = configExists(paths) ? loadConfig(paths) : DEFAULT_CONFIG;
	const config = applyOverrides(base, overrides);
	const fromDir = versionDir(paths, from);
	const toDir = versionDir(paths, to);
	const outDir = diffDir(paths, from, to);

	const report = diffVersions(fromDir, toDir, outDir, config, { from, to });
	const byFile = new Map<string, PageDiff>(report.pages.map((p) => [p.filename, p]));

	const statusOf = (file: string, inFrom: boolean, inTo: boolean) => {
		const d = byFile.get(file);
		return {
			status: (d?.status ?? "missing") as NodeStatus,
			diffPercent: d?.diffPercent,
			message: d?.message ?? (inFrom || inTo ? undefined : "no screenshot in either version"),
			images: { from: inFrom, to: inTo, diff: Boolean(d?.diffImage) },
		};
	};

	const fromPages = listPages(fromDir);
	const toPages = listPages(toDir);
	const slugs = [...new Set([...fromPages.keys(), ...toPages.keys()])].sort();

	const pages: InspectorPage[] = slugs.map((slug) => {
		const byElement = Boolean(fromPages.get(slug)?.byElement || toPages.get(slug)?.byElement);
		const fromRoot = path.join(fromDir, slug);
		const toRoot = path.join(toDir, slug);

		if (!byElement) {
			const image = `${slug}.png`;
			const s = statusOf(image, fs.existsSync(path.join(fromDir, image)), fs.existsSync(path.join(toDir, image)));
			return { slug, url: null, byElement, ...s, image, changedElements: 0, elements: [] };
		}

		const fromManifest = readJson<ElementManifest>(path.join(fromRoot, ELEMENT_MANIFEST));
		const toManifest = readJson<ElementManifest>(path.join(toRoot, ELEMENT_MANIFEST));

		const build = (from: ElementNode[], to: ElementNode[]): InspectorNode[] =>
			mergeSiblings(from, to).map(({ dir, from: a, to: b }) => {
				const node = (b ?? a)!;
				const rel = `${dir}/${ELEMENT_IMAGE}`;
				const children = build(a?.children ?? [], b?.children ?? []);
				const component =
					readJson<ComponentFile>(path.join(toRoot, ...dir.split("/"), COMPONENT_FILE)) ??
					readJson<ComponentFile>(path.join(fromRoot, ...dir.split("/"), COMPONENT_FILE));
				const s = statusOf(
					`${slug}/${rel}`,
					fs.existsSync(path.join(fromRoot, ...rel.split("/"))),
					fs.existsSync(path.join(toRoot, ...rel.split("/"))),
				);
				// A node missing from one tree is added/removed even if its capture failed.
				if (s.status === "missing" && (!a || !b)) s.status = a ? "removed" : "added";
				return {
					tag: node.tag,
					id: node.id,
					className: node.className,
					dir,
					selector: node.selector,
					rect: { from: a?.rect ?? null, to: b?.rect ?? null },
					...s,
					component,
					changedDescendants: children.reduce(
						(sum, c) => sum + c.changedDescendants + (CHANGE_STATUSES.has(c.status) ? 1 : 0),
						0,
					),
					children,
				};
			});

		const elements = build(fromManifest?.elements ?? [], toManifest?.elements ?? []);
		const image = `${slug}/${PAGE_IMAGE}`;
		const s = statusOf(
			image,
			fs.existsSync(path.join(fromRoot, PAGE_IMAGE)),
			fs.existsSync(path.join(toRoot, PAGE_IMAGE)),
		);
		const changedElements = elements.reduce(
			(sum, c) => sum + c.changedDescendants + (CHANGE_STATUSES.has(c.status) ? 1 : 0),
			0,
		);
		return {
			slug,
			url: toManifest?.url ?? fromManifest?.url ?? null,
			byElement,
			...s,
			image,
			changedElements,
			elements,
		};
	});

	return {
		from,
		to,
		summary: {
			changedCount: report.changedCount,
			addedCount: report.addedCount,
			removedCount: report.removedCount,
			hasChanges: report.hasChanges,
		},
		pages,
	};
}

/** Resolve `rel` under `base`, refusing anything that escapes it. */
function safeJoin(base: string, rel: string): string | null {
	const target = path.resolve(base, ...rel.split("/").filter(Boolean));
	return target === base || target.startsWith(base + path.sep) ? target : null;
}

function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer): void {
	res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
	res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
	send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function openBrowser(url: string): void {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

export async function inspector(opts: InspectorOptions): Promise<number> {
	const paths = resolvePaths(opts.root);
	if (!fs.existsSync(paths.versions)) {
		throw new Error(`No captures found under ${paths.versions}. Run \`tunnelvision shoot --by-element\` first.`);
	}

	const cache = new Map<string, InspectorDiff>();
	const located = new Map<string, Located | null>();
	const viewportWidth = (configExists(paths) ? loadConfig(paths) : DEFAULT_CONFIG).viewport.width;
	// Decoded page screenshots, kept for the most recent few pages.
	const pagePngs = new Map<string, PNG>();
	const readPagePng = (file: string): PNG => {
		let png = pagePngs.get(file);
		if (!png) {
			png = PNG.sync.read(fs.readFileSync(file));
			if (pagePngs.size >= 8) pagePngs.delete(pagePngs.keys().next().value!);
		}
		pagePngs.delete(file);
		pagePngs.set(file, png);
		return png;
	};

	/** The element's box in `page.png`: matched when possible, else the recorded rect. */
	const locate = (pageRoot: string, dir: string, elDir: string): Located | null => {
		const manifest = readJson<ElementManifest>(path.join(pageRoot, ELEMENT_MANIFEST));
		const find = (nodes: ElementNode[]): ElementNode | undefined => {
			for (const n of nodes) {
				if (n.dir === dir) return n;
				if (dir.startsWith(`${n.dir}/`)) return find(n.children);
			}
			return undefined;
		};
		const node = manifest && find(manifest.elements);
		const pageFile = path.join(pageRoot, PAGE_IMAGE);
		if (!node || !fs.existsSync(pageFile)) return null;
		const page = readPagePng(pageFile);
		const { rect } = node;

		const elementFile = path.join(elDir, ELEMENT_IMAGE);
		if (fs.existsSync(elementFile)) {
			const element = PNG.sync.read(fs.readFileSync(elementFile));
			const dpr = rect.width > 0 ? element.width / rect.width : 1;
			const found = locateElement(page, element, rect.x * dpr, rect.y * dpr, dpr);
			if (found) return found;
		}
		const dpr = Math.max(1, Math.round(page.width / viewportWidth));
		return { x: rect.x * dpr, y: rect.y * dpr, width: rect.width * dpr, height: rect.height * dpr, matched: false };
	};

	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		try {
			if (url.pathname === "/") {
				return send(res, 200, "text/html; charset=utf-8", fs.readFileSync(PAGE_FILE));
			}

			if (url.pathname === "/api/versions") {
				const versions = listVersions(paths).map((v) => ({
					...v,
					byElement: [...listPages(versionDir(paths, v.key)).values()].some((p) => p.byElement),
				}));
				return sendJson(res, 200, { root: paths.root, versions });
			}

			if (url.pathname === "/api/locate") {
				// ?version=<key>&page=<slug>&dir=<element dir>
				const version = url.searchParams.get("version") ?? "";
				const slug = url.searchParams.get("page") ?? "";
				const dir = url.searchParams.get("dir") ?? "";
				const vdir = safeJoin(paths.versions, version);
				const pageRoot = vdir && version && safeJoin(vdir, slug);
				const elDir = pageRoot && slug && safeJoin(pageRoot, dir);
				if (!elDir) return sendJson(res, 404, { error: "Unknown element" });
				const cacheKey = `${version}\0${slug}\0${dir}`;
				if (!located.has(cacheKey)) located.set(cacheKey, locate(pageRoot, dir, elDir));
				return sendJson(res, 200, located.get(cacheKey));
			}

			if (url.pathname === "/api/diff") {
				const from = url.searchParams.get("from") ?? "";
				const to = url.searchParams.get("to") ?? "";
				for (const key of [from, to]) {
					if (!key || key.includes("/") || key.includes("\\") || !versionExists(paths, key)) {
						return sendJson(res, 404, { error: `Unknown version "${key}"` });
					}
				}
				const cacheKey = `${from}__${to}`;
				if (url.searchParams.has("refresh")) cache.delete(cacheKey);
				let result = cache.get(cacheKey);
				if (!result) {
					result = buildDiff(paths, opts, from, to);
					cache.set(cacheKey, result);
				}
				return sendJson(res, 200, result);
			}

			// /img/version/<key>/<rel> and /img/diff/<from>__<to>/<rel>
			const img = url.pathname.match(/^\/img\/(version|diff)\/([^/]+)\/(.+)$/);
			if (img) {
				const [, kind, key, rel] = img;
				const base = kind === "version" ? paths.versions : paths.diffs;
				const dir = safeJoin(base, decodeURIComponent(key));
				const file = dir && safeJoin(dir, decodeURIComponent(rel));
				if (!file || !file.toLowerCase().endsWith(".png") || !fs.existsSync(file)) {
					return send(res, 404, "text/plain", "Not found");
				}
				return send(res, 200, "image/png", fs.readFileSync(file));
			}

			send(res, 404, "text/plain", "Not found");
		} catch (err) {
			sendJson(res, 500, { error: (err as Error).message });
		}
	});

	const host = opts.host ?? "127.0.0.1";
	const port = opts.port ?? 4173;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => resolve());
	});

	const address = server.address();
	const actualPort = typeof address === "object" && address ? address.port : port;
	const shownHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
	const link = `http://${shownHost}:${actualPort}`;
	console.log(pc.bold("tunnelvision inspector") + pc.dim(` → ${path.relative(process.cwd(), paths.dir) || paths.dir}`));
	console.log(`  ${pc.cyan(link)}`);
	console.log(pc.dim("  press Ctrl+C to stop"));
	if (opts.open) openBrowser(link);

	// Keep running until interrupted.
	await new Promise<void>((resolve) => {
		const stop = () => server.close(() => resolve());
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
	return 0;
}
