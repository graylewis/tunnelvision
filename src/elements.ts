import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

/**
 * Extract, plan, and address the per-element hierarchy used by `--by-element`.
 *
 * We ask the browser (via the Playwright driver in `playwright.ts`) for a tree of
 * all *visible block-level* elements on the page, preserving DOM nesting.
 * Non-block wrappers (inline spans, text nodes, etc.) are flattened away so their
 * block descendants bubble up to the nearest block ancestor. Each surviving
 * element records its page-coordinate rect, which we use to crop it out of the
 * full-page screenshot taken in the same page load, plus a stable CSS selector
 * (an `nth-of-type` chain from <body>) and a filesystem-safe directory name so
 * the on-disk layout mirrors the page hierarchy.
 */

export interface ElementRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * A stack frame from React's dev-mode `_debugStack`: the location of the JSX
 * call in the code the browser actually ran (the bundled/transformed module).
 * Mapped back to the original source via source maps in `reactsource.ts`.
 */
export interface StackFrame {
	url: string;
	/** 1-based. */
	line: number;
	/** 1-based. */
	column: number;
}

/** A component in an element's owner chain (nearest first). */
export interface ReactComponent {
	name: string;
	/** Where this component was rendered from, when known. */
	frame: StackFrame | null;
}

/**
 * React metadata for a DOM element, found the way click-to-component does
 * (look up the element's fiber, walk `_debugOwner`), but located via React 19's
 * `_debugStack` rather than the removed `_debugSource`.
 */
export interface ReactInfo {
	/** Where the element's JSX was written (or its nearest ancestor's, as a fallback). */
	frame: StackFrame | null;
	components: ReactComponent[];
}

/** A node as returned by the in-page extraction script. */
export interface RawElement {
	tag: string;
	id: string | null;
	className: string | null;
	selector: string;
	rect: ElementRect;
	/** `rect` without rounding, used to crop the element out of the page screenshot. */
	box: ElementRect;
	/** Null when the element isn't rendered by React. */
	react: ReactInfo | null;
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
	/** Stable CSS selector for the element (an `nth-of-type` chain from <body>). */
	selector: string;
	rect: ElementRect;
	box: ElementRect;
	react: ReactInfo | null;
	children: ElementNode[];
}

/** A single element screenshot, cropped out of the page screenshot. */
export interface ElementShot {
	/** The element's unrounded box in CSS pixels, in page coordinates. */
	box: ElementRect;
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
/** React source info placed alongside `element.png` when the page uses React. */
export const COMPONENT_FILE = "component.json";

/**
 * In-page script, evaluated by the capture driver after the page has loaded and
 * settled. Returns an array of top-level block elements (children of <body>),
 * each with nested `children`.
 */
export const EXTRACT_JS = `
new Promise((resolve) => {
  {
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
    // React lookup, mirroring click-to-component: prefer the DevTools hook,
    // then the fiber expando react-dom attaches to every host node.
    function reactFiber(el) {
      const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (hook && hook.renderers) {
        for (const renderer of hook.renderers.values()) {
          try {
            const fiber = renderer.findFiberByHostInstance(el);
            if (fiber) return fiber;
          } catch (e) {}
        }
      }
      if (el._reactRootContainer) {
        return el._reactRootContainer._internalRoot.current.child;
      }
      for (const key of Object.keys(el)) {
        if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
          return el[key];
        }
      }
      return null;
    }
    // React 19 records an Error at JSX creation time as \`_debugStack\` (server
    // component owners carry it as \`debugStack\`). Its first frame outside React
    // itself is the JSX call site.
    const REACT_FRAME = /node_modules|jsx-dev-runtime|jsx-runtime|react-dom/;
    const REACT_FN = /(^|\\.)(jsxDEV|jsxs?|jsxDEVImpl|jsxWithValidation\\w*|createElement)$/;
    function parseFrame(line) {
      // Chromium: "    at Name (url:1:2)" or "    at url:1:2"; Firefox/WebKit: "Name@url:1:2".
      let m = line.match(/^\\s*at (?:(.*?) \\()?(.*):(\\d+):(\\d+)\\)?\\s*$/);
      if (!m) m = line.match(/^(.*?)@(.*):(\\d+):(\\d+)\\s*$/);
      if (!m) return null;
      return { fn: m[1] || "", url: m[2], line: Number(m[3]), column: Number(m[4]) };
    }
    function reactFrame(fiber) {
      const err = fiber && (fiber._debugStack || fiber.debugStack);
      const stack = err && typeof err.stack === "string" ? err.stack : null;
      if (!stack) return null;
      for (const line of stack.split("\\n")) {
        const f = parseFrame(line);
        if (!f || REACT_FRAME.test(f.url) || REACT_FN.test(f.fn)) continue;
        return { url: f.url, line: f.line, column: f.column };
      }
      return null;
    }
    function reactName(fiber) {
      const type = fiber.elementType || fiber.type;
      // Server component owners (React 19) are plain info objects, not fibers.
      if (typeof fiber.tag !== "number") return fiber.name || "Anonymous Component";
      switch (fiber.tag) {
        case 0: case 1: case 2:
          return (type && (type.displayName || type.name)) || "Anonymous Component";
        case 3: return "HostRoot";
        case 4: return "HostPortal";
        case 5: case 26: case 27: return String(type);
        case 6: return "String";
        case 7: return "React.Fragment";
        case 9: return "Context.Consumer";
        case 10: return "Context.Provider";
        case 11:
          return (type && (type.displayName || (type.render && (type.render.displayName || type.render.name)))) || "React.forwardRef";
        case 14: case 15: {
          const inner = type && (type.type || type);
          return (type && type.displayName) || (inner && (inner.displayName || inner.name)) || "React.memo";
        }
        case 16: return "React.lazy";
        default: return "Unknown (" + fiber.tag + ")";
      }
    }
    function reactInfo(el) {
      const fiber = reactFiber(el);
      if (!fiber) return null;
      // Like click-to-component, fall back to the nearest ancestor with a source.
      let frame = reactFrame(fiber);
      for (let p = el.parentElement; !frame && p; p = p.parentElement) {
        frame = reactFrame(reactFiber(p));
      }
      const components = [];
      const seen = new Set();
      for (let owner = fiber._debugOwner; owner && !seen.has(owner); owner = owner._debugOwner || owner.owner) {
        seen.add(owner);
        components.push({ name: reactName(owner), frame: reactFrame(owner) });
      }
      return { frame, components };
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
            box: { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height },
            react: reactInfo(child),
            children: walk(child, sel)
          });
        } else {
          for (const g of walk(child, sel)) out.push(g);
        }
      }
      return out;
    }
    resolve(walk(document.body, "body"));
  }
});
`;

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
			box: node.box ?? node.rect,
			react: node.react ?? null,
			children: assignDirs(node.children, dir),
		};
	});
}

/** Flatten a planned tree into the list of element screenshots to capture. */
export function collectShots(nodes: ElementNode[]): ElementShot[] {
	const shots: ElementShot[] = [];
	const visit = (list: ElementNode[]): void => {
		for (const node of list) {
			shots.push({ box: node.box, relOutput: `${node.dir}/${ELEMENT_IMAGE}` });
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

/**
 * Crop every element out of the full-page screenshot at `pageFile`. Element
 * boxes are in CSS pixels, so they're scaled by `scale` (the device pixel
 * ratio) and clamped to the image. Returns the relative outputs written and
 * those skipped because their box lies outside the page.
 */
export function cropElements(
	pageFile: string,
	pageRoot: string,
	shots: ElementShot[],
	scale: number,
): { produced: string[]; missing: string[] } {
	const page = PNG.sync.read(fs.readFileSync(pageFile));
	const produced: string[] = [];
	const missing: string[] = [];
	for (const shot of shots) {
		// Size comes from the element's own dimensions, not its rounded edges, so
		// an unchanged element keeps the same crop size when a parent shifts it
		// by a sub-pixel amount (edge rounding would flip between e.g. 127/128).
		const { box } = shot;
		const left = Math.round(box.x * scale);
		const top = Math.round(box.y * scale);
		const x0 = Math.max(0, left);
		const y0 = Math.max(0, top);
		const x1 = Math.min(page.width, left + Math.round(box.width * scale));
		const y1 = Math.min(page.height, top + Math.round(box.height * scale));
		if (x1 <= x0 || y1 <= y0) {
			missing.push(shot.relOutput);
			continue;
		}
		const crop = new PNG({ width: x1 - x0, height: y1 - y0 });
		PNG.bitblt(page, crop, x0, y0, x1 - x0, y1 - y0, 0, 0);
		const out = resolveElementOutput(pageRoot, shot.relOutput);
		fs.mkdirSync(path.dirname(out), { recursive: true });
		fs.writeFileSync(out, PNG.sync.write(crop));
		produced.push(shot.relOutput);
	}
	return { produced, missing };
}
