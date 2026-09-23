import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Extract, plan, and address the per-element hierarchy used by `--by-element`.
 *
 * We ask the browser (via `shot-scraper javascript`) for a tree of all *visible
 * block-level* elements on the page, preserving DOM nesting. Non-block wrappers
 * (inline spans, text nodes, etc.) are flattened away so their block descendants
 * bubble up to the nearest block ancestor. Each surviving element gets a stable
 * CSS selector (an `nth-of-type` chain from <body>) which we later feed to
 * shot-scraper's `selector` capture, plus a filesystem-safe directory name so the
 * on-disk layout mirrors the page hierarchy.
 */

export interface ElementRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A node as returned by the in-page extraction script. */
export interface RawElement {
	tag: string;
	id: string | null;
	className: string | null;
	selector: string;
	rect: ElementRect;
	children: RawElement[];
}

/** A node after we've assigned it a directory slug/path. */
export interface ElementNode {
	tag: string;
	id: string | null;
	className: string | null;
	/** Filesystem-safe directory name, unique among its siblings. */
	slug: string;
	/** POSIX directory path relative to the page's element root. */
	dir: string;
	/** CSS selector passed to shot-scraper for isolated capture. */
	selector: string;
	rect: ElementRect;
	children: ElementNode[];
}

/** A single element screenshot to capture. */
export interface ElementShot {
	selector: string;
	/** POSIX path (relative to the page element root) of the output PNG. */
	relOutput: string;
}

/** The file written per page so the tree can be inspected/rebuilt. */
export interface ElementManifest {
	url: string;
	extractedAt: string;
	elements: ElementNode[];
}

/** The name of the screenshot placed inside every element directory. */
export const ELEMENT_IMAGE = "element.png";
/** The full-page screenshot kept at each page's element root for context. */
export const PAGE_IMAGE = "page.png";
/** The per-page manifest filename. */
export const ELEMENT_MANIFEST = "elements.json";

/**
 * In-page script. Returns an array of top-level block elements (children of
 * <body>), each with nested `children`. `__WAIT__` is replaced with a settle
 * delay because `shot-scraper javascript` has no `--wait` flag of its own.
 */
const EXTRACT_JS = `
new Promise((resolve) => {
  setTimeout(() => {
    const BLOCK = new Set([
      "block", "flex", "grid", "list-item", "flow-root",
      "table", "table-row", "table-row-group", "table-header-group",
      "table-footer-group", "table-cell", "table-caption"
    ]);
    const SKIP = new Set([
      "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META",
      "HEAD", "BR", "HR", "SVG", "CANVAS"
    ]);
    function visibleBlock(el) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      if (parseFloat(cs.opacity || "1") === 0) return false;
      if (!BLOCK.has(cs.display)) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      return true;
    }
    function nthOfType(el) {
      let n = 0, sib = el;
      while (sib) {
        if (sib.nodeType === 1 && sib.tagName === el.tagName) n++;
        sib = sib.previousElementSibling;
      }
      return n;
    }
    function walk(el, parentSel) {
      const out = [];
      for (const child of el.children) {
        const tagU = child.tagName.toUpperCase();
        if (SKIP.has(tagU)) continue;
        const sel = parentSel + " > " + child.tagName.toLowerCase() +
          ":nth-of-type(" + nthOfType(child) + ")";
        if (visibleBlock(child)) {
          const r = child.getBoundingClientRect();
          out.push({
            tag: child.tagName.toLowerCase(),
            id: child.id || null,
            className: (typeof child.className === "string" ? child.className.trim() : "") || null,
            selector: sel,
            rect: {
              x: Math.round(r.x + window.scrollX),
              y: Math.round(r.y + window.scrollY),
              width: Math.round(r.width),
              height: Math.round(r.height)
            },
            children: walk(child, sel)
          });
        } else {
          for (const g of walk(child, sel)) out.push(g);
        }
      }
      return out;
    }
    resolve(walk(document.body, "body"));
  }, __WAIT__);
});
`;

export interface ExtractOptions {
	/** shot-scraper auth context file, when present. */
	authFile?: string;
	/** Settle delay (ms) before reading the DOM. */
	wait?: number;
	/** Working directory for the shot-scraper process. */
	cwd?: string;
}

/**
 * Run `shot-scraper javascript` against `url` and return the raw element tree.
 * Throws if the page fails to load or the script errors.
 */
export function extractElementTree(url: string, opts: ExtractOptions = {}): RawElement[] {
	const js = EXTRACT_JS.replace("__WAIT__", String(Math.max(0, Math.floor(opts.wait ?? 0))));
	const args = ["javascript", url, js];
	if (opts.authFile) args.push("-a", opts.authFile);

	const out = execFileSync("shot-scraper", args, {
		cwd: opts.cwd,
		encoding: "utf8",
		maxBuffer: 128 * 1024 * 1024,
		stdio: ["ignore", "pipe", "inherit"],
	});
	const parsed = JSON.parse(out);
	return Array.isArray(parsed) ? (parsed as RawElement[]) : [];
}

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/** Base directory name for a node, before sibling disambiguation. */
function baseName(node: RawElement): string {
	let base = slugify(node.tag) || "el";
	if (node.id) {
		const id = slugify(node.id);
		if (id) base += `-${id}`;
	}
	return base;
}

/**
 * Assign unique, filesystem-safe directory names to each node relative to its
 * parent, recursing through the tree. Colliding siblings get a 1-based suffix so
 * the same DOM position maps to the same path across versions.
 */
export function assignDirs(nodes: RawElement[], parentDir = ""): ElementNode[] {
	const bases = nodes.map(baseName);
	const totals = new Map<string, number>();
	for (const b of bases) totals.set(b, (totals.get(b) ?? 0) + 1);
	const seen = new Map<string, number>();

	return nodes.map((node, i) => {
		let slug = bases[i];
		if ((totals.get(slug) ?? 0) > 1) {
			const n = (seen.get(slug) ?? 0) + 1;
			seen.set(slug, n);
			slug = `${slug}-${n}`;
		}
		const dir = parentDir ? `${parentDir}/${slug}` : slug;
		return {
			tag: node.tag,
			id: node.id,
			className: node.className,
			slug,
			dir,
			selector: node.selector,
			rect: node.rect,
			children: assignDirs(node.children, dir),
		};
	});
}

/** Flatten a planned tree into the list of element screenshots to capture. */
export function collectShots(nodes: ElementNode[]): ElementShot[] {
	const shots: ElementShot[] = [];
	const visit = (list: ElementNode[]): void => {
		for (const node of list) {
			shots.push({ selector: node.selector, relOutput: `${node.dir}/${ELEMENT_IMAGE}` });
			visit(node.children);
		}
	};
	visit(nodes);
	return shots;
}

/** Convert a POSIX relative output path into an absolute filesystem path. */
export function resolveElementOutput(pageRoot: string, relOutput: string): string {
	return path.join(pageRoot, ...relOutput.split("/"));
}
