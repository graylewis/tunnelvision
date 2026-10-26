import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { FLOW_PROPERTIES } from "./logical.js";
import type { ComponentFile } from "./reactsource.js";

/**
 * Extract, plan, and address the per-element hierarchy captured by default.
 *
 * We ask the browser (via the Playwright driver in `playwright.ts`) for a tree of
 * all *visible elements that form one box* on the page, preserving DOM nesting:
 * block-level ones, and atomic inline-level ones (`inline-flex` buttons and
 * chips) that aren't part of a line of text (docs/adr/0013). Nodes that flow
 * as text (`display: inline`, text nodes) are flattened away so the boxes inside
 * them bubble up to the nearest box ancestor. Elements with no
 * painted pixels (clipped away by an ancestor's overflow or clip-path, inside a
 * transparent ancestor, or off the page) are flattened away the same way. Each
 * surviving element records its page-coordinate box, a stable CSS selector (an
 * `nth-of-type` chain from <body>) and a hierarchical directory path that
 * addresses it (and its diff image) the same way the DOM nests.
 *
 * Element screenshots are never written to disk: each one is a crop of the
 * full-page screenshot taken in the same load, so it's cut out on demand from
 * `page.png` and the element's `box` (see `ElementImages`).
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

/**
 * What identifies an element across captures, used to pair elements between
 * snapshots (see `matching.ts`). Content is deliberately absent.
 */
export interface ElementIdentity {
	/** Configured match attributes present on the element, e.g. `{ "data-testid": "orders" }`. */
	attributes: Record<string, string>;
	/** The `name` attribute (form controls). */
	name: string | null;
	/** React `key` of the element, or of the component that rendered it as its root. */
	key: string | null;
	/** The component whose render produced the element (its nearest owner). */
	component: string | null;
	/** Source file of the element's JSX, relative to the project root, without line/column. */
	file: string | null;
	/** `file:line:col` of the element's JSX. A tie-breaker only: lines shift with edits. */
	source: string | null;
}

/**
 * One of an element's own images (see CONTEXT.md): an image it displays
 * itself or through an inline descendant, not through a nested element.
 */
export interface OwnImage {
	/** `img` (a `<picture>` shows through its `<img>`), `video` (its poster), `object` or `image` (SVG). */
	tag: string;
	/** The absolute URL shown: an `<img>`'s `currentSrc`, falling back to `src` when it hasn't loaded. */
	src: string;
	/** Whether it had loaded and decoded. One that hadn't is unknown, not changed. */
	loaded: boolean;
	/** Its border box in page coordinates. */
	box: ElementRect;
}

/** A node as returned by the in-page extraction script. */
export interface RawElement {
	tag: string;
	id: string | null;
	className: string | null;
	/** Configured match attributes present on the element. */
	attributes?: Record<string, string>;
	name?: string | null;
	reactKey?: string | null;
	selector: string;
	rect: ElementRect;
	/**
	 * The painted part of `rect`, without rounding: what's left once the
	 * ancestors that clip it have. Used to crop the element out of the page
	 * screenshot, so a clipped element's crop doesn't show what's painted
	 * over the parts of it that aren't.
	 */
	box: ElementRect;
	/** Null when the element isn't rendered by React. */
	react: ReactInfo | null;
	/** Computed values of the tracked properties, plus `FLOW_PROPERTIES`. */
	computed?: Record<string, string>;
	/** The element's own text (see `ElementNode.text`). */
	text?: string;
	/** The element's own images (see `ElementNode.images`). */
	images?: OwnImage[];
	/** See `ElementNode.interactive`. */
	interactive?: true;
	/** See `ElementNode.atom`. */
	atom?: true;
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
	/** Missing in captures made before identity matching existed. */
	identity?: ElementIdentity;
	/** Resolved React source locations, when React rendered the element. */
	component?: ComponentFile;
	/**
	 * The element's own text: what it renders, inline descendants included but
	 * not the text of descendants that are elements in their own right, with
	 * whitespace collapsed. Missing in captures made before it was recorded.
	 */
	text?: string;
	/**
	 * The element's own images, in document order: those it displays itself
	 * or through inline descendants, not through descendants that are
	 * elements in their own right. Missing in captures made before they were
	 * recorded, and when it has none.
	 */
	images?: OwnImage[];
	/** A control, link or ARIA widget: something a user acts on. Missing in captures before manifest version 5. */
	interactive?: true;
	/** Marked `data-tv-atom`: an atom whatever else it is (see `atoms.ts`). */
	atom?: true;
	children: ElementNode[];
}

/** The file written per page so the tree can be inspected/rebuilt. */
export interface ElementManifest {
	/** `MANIFEST_VERSION` at capture time; absent in the oldest captures. */
	version?: number;
	url: string;
	extractedAt: string;
	/** Device pixels per CSS pixel in `page.png`, used to crop element boxes. */
	scale: number;
	elements: ElementNode[];
}

/**
 * The name an element's image goes by inside its directory. Only diff images
 * are written there; the element itself is cropped from `page.png` on demand.
 */
export const ELEMENT_IMAGE = "element.png";
/** The full-page screenshot at each page's element root; every element is cropped from it. */
export const PAGE_IMAGE = "page.png";
/** The per-page manifest filename. */
export const ELEMENT_MANIFEST = "elements.json";
/** Per-page style data (see `styles.ts`), kept apart since it's large and only correlation reads it. */
export const STYLE_MANIFEST = "styles.json";

/**
 * 3: element images are cropped on demand (needs `scale`) and components live in the manifest.
 * 4: elements record their own images, so one without `images` has none.
 * 5: elements are every node that forms one box, not only block-level ones
 *    (docs/adr/0013), and record whether they're interactive.
 */
export const MANIFEST_VERSION = 5;
/** The oldest manifest that can still be read; older captures stored `element.png` files instead. */
export const MIN_MANIFEST_VERSION = 3;
/** The first manifest version that records own images. */
export const IMAGES_VERSION = 4;
/**
 * The first manifest version whose elements are every node that forms one
 * box. Captures on either side of it divide pages into different elements, so
 * their elements can't be paired.
 */
export const BOXES_VERSION = 5;

/**
 * The in-page extraction script, evaluated by the capture driver after the page
 * has loaded and settled. Returns an array of top-level elements
 * (children of <body>), each with nested `children`. `attributes` are the
 * configured match attributes to record on each element, and `properties` the
 * tracked CSS properties whose computed values are recorded (along with
 * `writing-mode` and `direction`, which the cascade needs to map logical
 * properties to physical ones). `includeHidden`
 * keeps elements with no painted pixels, cropped by their full box.
 */
export function extractScript(attributes: string[], properties: string[], includeHidden = false): string {
	return EXTRACT_JS.replace("__MATCH_ATTRIBUTES__", JSON.stringify(attributes))
		.replace("__TRACKED_PROPERTIES__", JSON.stringify([...new Set([...properties, ...FLOW_PROPERTIES])]))
		.replace("__INCLUDE_HIDDEN__", JSON.stringify(includeHidden));
}

const EXTRACT_JS = `
new Promise((resolve) => {
  {
    const BLOCK = new Set([
      "block", "flex", "grid", "list-item", "flow-root",
      "table", "table-row", "table-row-group", "table-header-group",
      "table-footer-group", "table-cell", "table-caption"
    ]);
    const MATCH_ATTRIBUTES = __MATCH_ATTRIBUTES__;
    const TRACKED_PROPERTIES = __TRACKED_PROPERTIES__;
    const INCLUDE_HIDDEN = __INCLUDE_HIDDEN__;
    const SKIP = new Set([
      "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META",
      "HEAD", "BR", "HR", "SVG", "CANVAS"
    ]);
    // Inline-level boxes that never break across lines, so they have one
    // rectangle like a block does (docs/adr/0013).
    const ATOMIC = new Set(["inline-block", "inline-flex", "inline-grid", "inline-table"]);
    // More atomic inline-level siblings than this are text set as boxes
    // (split-text animations, KaTeX, icon fonts), not pieces of UI.
    const MAX_ATOMIC_SIBLINGS = 20;
    const atomicCounts = new Map();
    function crowded(parent) {
      if (!atomicCounts.has(parent)) {
        let n = 0;
        for (const c of parent.children) if (ATOMIC.has(getComputedStyle(c).display)) n++;
        atomicCounts.set(parent, n);
      }
      return atomicCounts.get(parent) > MAX_ATOMIC_SIBLINGS;
    }
    // Next to words in a line of text, through any inline wrappers up to the
    // box that holds the line: part of a sentence, so the sentence's.
    function inRunningText(el) {
      for (let p = el.parentElement; p; p = p.parentElement) {
        for (const n of p.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
        const d = getComputedStyle(p).display;
        if (d !== "inline" && d !== "contents") return false;
      }
      return false;
    }
    function formsBox(el) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      if (parseFloat(cs.opacity || "1") === 0) return false;
      if (!BLOCK.has(cs.display)) {
        if (!ATOMIC.has(cs.display) || !el.parentElement) return false;
        if (crowded(el.parentElement) || inRunningText(el)) return false;
      }
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      return true;
    }
    const WIDGET_ROLES = new Set([
      "button", "link", "checkbox", "radio", "switch", "tab", "menuitem",
      "menuitemcheckbox", "menuitemradio", "option", "slider", "spinbutton",
      "textbox", "combobox", "searchbox", "treeitem"
    ]);
    // Something a user acts on: a control, a link, or an ARIA widget.
    function interactive(el) {
      const role = el.getAttribute("role");
      if (role) return WIDGET_ROLES.has(role);
      const tag = el.tagName.toLowerCase();
      if (tag === "a") return el.hasAttribute("href");
      if (tag === "input") return el.type !== "hidden";
      return tag === "button" || tag === "select" || tag === "textarea" || tag === "summary";
    }
    // Nothing inside a display:none or fully transparent element is painted.
    function paintsNothing(el) {
      const cs = getComputedStyle(el);
      return cs.display === "none" || parseFloat(cs.opacity || "1") === 0;
    }
    function intersect(c, l, t, r, b) {
      c.l = Math.max(c.l, l); c.t = Math.max(c.t, t);
      c.r = Math.min(c.r, r); c.b = Math.min(c.b, b);
    }
    // An inset() or rect() length: px, or a percentage of \`size\`.
    function length(v, size) {
      return v.endsWith("%") ? (parseFloat(v) / 100) * size : parseFloat(v) || 0;
    }
    // Whether an element with style \`cs\` is the containing block of fixed descendants.
    function containsFixed(cs) {
      return cs.transform !== "none" || cs.perspective !== "none" || cs.filter !== "none" ||
        (cs.backdropFilter || "none") !== "none" || /paint|layout|strict|content/.test(cs.contain) ||
        /transform|perspective|filter/.test(cs.willChange);
    }
    // Overflow only clips descendants whose containing block chain passes
    // through it, so absolute and fixed elements escape the overflow of
    // ancestors below their containing block.
    function containingBlock(position, cs) {
      if (position === "fixed") return containsFixed(cs);
      if (position === "absolute") return cs.position !== "static" || containsFixed(cs);
      return true;
    }
    // Clip what clip-path and clip leave of border box \`b\`. Only inset()
    // shapes are resolved; any other clip-path is taken as the whole box.
    function shapeClip(c, cs, b) {
      const inset = cs.clipPath.match(/^inset\\(([^)]*?)(?:\\s+round\\b[^)]*)?\\)/);
      if (inset) {
        const v = inset[1].trim().split(/\\s+/);
        const top = v[0], right = v[1] || top, bottom = v[2] || top, left = v[3] || right;
        intersect(c, b.left + length(left, b.width), b.top + length(top, b.height),
          b.right - length(right, b.width), b.bottom - length(bottom, b.height));
      } else if (cs.clipPath !== "none") {
        intersect(c, b.left, b.top, b.right, b.bottom);
      }
      if ((cs.position === "absolute" || cs.position === "fixed") && cs.clip.startsWith("rect(")) {
        const v = cs.clip.slice(5, -1).split(/[,\\s]+/);
        const at = (i, auto) => (v[i] === "auto" ? auto : length(v[i], 0));
        intersect(c, b.left + at(3, 0), b.top + at(0, 0), b.left + at(1, b.width), b.top + at(2, b.height));
      }
    }
    // Clip to the padding box of \`b\` on the axes its overflow clips.
    function overflowClip(c, cs, b) {
      const paint = /paint|strict|content/.test(cs.contain);
      const x = paint || cs.overflowX !== "visible";
      const y = paint || cs.overflowY !== "visible";
      if (!x && !y) return;
      const l = b.left + (parseFloat(cs.borderLeftWidth) || 0);
      const t = b.top + (parseFloat(cs.borderTopWidth) || 0);
      const r = b.right - (parseFloat(cs.borderRightWidth) || 0);
      const bt = b.bottom - (parseFloat(cs.borderBottomWidth) || 0);
      intersect(c, x ? l : -Infinity, y ? t : -Infinity, x ? r : Infinity, y ? bt : Infinity);
    }
    // The part of el's box (\`r\`, from getBoundingClientRect) that's actually
    // painted, in page coordinates: what's left once its own clip-path and
    // every ancestor that clips it (overflow, clip-path, paint containment)
    // have cut it down, within the page. Null when nothing is left. A crop
    // of the full box would show whatever is painted where the clipped part
    // would be, i.e. other elements. Transformed boxes are their bounding
    // rectangles, so this can over-estimate but never cut off painted pixels.
    function paintedBox(el, r) {
      const c = { l: r.left, t: r.top, r: r.right, b: r.bottom };
      const own = getComputedStyle(el);
      let position = own.position;
      shapeClip(c, own, r);
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        const b = a.getBoundingClientRect();
        if (containingBlock(position, cs)) {
          overflowClip(c, cs, b);
          position = cs.position;
        }
        shapeClip(c, cs, b);
      }
      const doc = document.documentElement;
      intersect(c, -window.scrollX, -window.scrollY,
        Math.max(doc.scrollWidth, window.innerWidth) - window.scrollX,
        Math.max(doc.scrollHeight, window.innerHeight) - window.scrollY);
      if (c.r <= c.l || c.b <= c.t) return null;
      return { x: c.l + window.scrollX, y: c.t + window.scrollY, width: c.r - c.l, height: c.b - c.t };
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
    // The element's own key, or the key of the component that rendered it as
    // its root (e.g. \`<StatCard key="revenue">\` for StatCard's outer div).
    // Stops at the nearest host (DOM) ancestor, whose key belongs to it instead.
    const HOST_TAGS = new Set([3, 5, 26, 27]);
    function reactKey(el) {
      const fiber = reactFiber(el);
      for (let f = fiber; f; f = f.return) {
        if (f !== fiber && HOST_TAGS.has(f.tag)) break;
        if (f.key != null) return String(f.key);
      }
      return null;
    }
    function matchAttributes(el) {
      const out = {};
      for (const name of MATCH_ATTRIBUTES) {
        const v = el.getAttribute(name);
        if (v !== null && v !== "") out[name] = v;
      }
      return out;
    }
    function computed(el) {
      const cs = getComputedStyle(el);
      const out = {};
      for (const name of TRACKED_PROPERTIES) out[name] = cs.getPropertyValue(name);
      return out;
    }
    // Painted text inside \`el\`, skipping descendants that are elements of
    // their own (\`emitted\`) since their text is theirs. Joined as rendered,
    // with a space where a line break or a nested element splits it.
    const emitted = new Set();
    const MAX_TEXT = 10000;
    function ownText(el) {
      const hidden = getComputedStyle(el).visibility === "hidden";
      let s = "";
      for (const n of el.childNodes) {
        if (n.nodeType === 3) {
          if (!hidden) s += n.nodeValue;
        } else if (n.nodeType === 1) {
          const tagU = n.tagName.toUpperCase();
          if (emitted.has(n) || tagU === "BR") s += " ";
          else if (!SKIP.has(tagU) && !paintsNothing(n)) s += ownText(n);
        }
      }
      return s;
    }
    // Images \`el\` displays itself or through descendants that aren't
    // elements of their own, as ownText does for text. A <picture> shows
    // through its <img>, whose currentSrc is the source it chose.
    const MAX_IMAGES = 50;
    function pageBox(n) {
      const r = n.getBoundingClientRect();
      return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
    }
    function imageOf(n) {
      const tag = n.tagName.toLowerCase();
      if (tag === "img") {
        const src = n.currentSrc || n.src;
        return src ? { tag, src, loaded: Boolean(n.currentSrc && n.complete && n.naturalWidth > 0), box: pageBox(n) } : null;
      }
      if (tag === "video") return n.poster ? { tag, src: n.poster, loaded: true, box: pageBox(n) } : null;
      if (tag === "object") return n.data ? { tag, src: n.data, loaded: true, box: pageBox(n) } : null;
      if (tag === "image" && n.namespaceURI === "http://www.w3.org/2000/svg") {
        const href = n.href && n.href.baseVal;
        if (!href) return null;
        try {
          return { tag, src: new URL(href, document.baseURI).href, loaded: true, box: pageBox(n) };
        } catch (e) {
          return null;
        }
      }
      return null;
    }
    function ownImages(el, out = []) {
      if (out.length >= MAX_IMAGES || paintsNothing(el)) return out;
      const own = imageOf(el);
      if (own) out.push(own);
      if (el.tagName.toUpperCase() === "SVG") {
        for (const n of el.querySelectorAll("image")) {
          const img = !paintsNothing(n) && imageOf(n);
          if (img && out.length < MAX_IMAGES) out.push(img);
        }
        return out;
      }
      for (const n of el.children) {
        const tagU = n.tagName.toUpperCase();
        if (emitted.has(n) || (SKIP.has(tagU) && tagU !== "SVG")) continue;
        ownImages(n, out);
      }
      return out;
    }
    function walk(el, parentSel) {
      const out = [];
      for (const child of el.children) {
        const tagU = child.tagName.toUpperCase();
        if (SKIP.has(tagU)) continue;
        const sel = parentSel + " > " + child.tagName.toLowerCase() +
          ":nth-of-type(" + nthOfType(child) + ")";
        if (!INCLUDE_HIDDEN && paintsNothing(child)) continue;
        const r = formsBox(child) ? child.getBoundingClientRect() : null;
        const box = r && (INCLUDE_HIDDEN
          ? { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height }
          : paintedBox(child, r));
        if (box) {
          emitted.add(child);
          const children = walk(child, sel);
          const images = getComputedStyle(child).visibility === "hidden" ? [] : ownImages(child);
          out.push({
            tag: child.tagName.toLowerCase(),
            id: child.id || null,
            className: (typeof child.className === "string" ? child.className.trim() : "") || null,
            attributes: matchAttributes(child),
            name: child.getAttribute("name") || null,
            reactKey: reactKey(child),
            selector: sel,
            rect: {
              x: Math.round(r.x + window.scrollX),
              y: Math.round(r.y + window.scrollY),
              width: Math.round(r.width),
              height: Math.round(r.height)
            },
            box,
            react: reactInfo(child),
            computed: computed(child),
            text: ownText(child).replace(/\\s+/g, " ").trim().slice(0, MAX_TEXT),
            ...(images.length ? { images } : {}),
            ...(interactive(child) ? { interactive: true } : {}),
            ...(child.hasAttribute("data-tv-atom") ? { atom: true } : {}),
            children
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
			...(node.text !== undefined ? { text: node.text } : {}),
			...(node.images?.length ? { images: node.images } : {}),
			...(node.interactive ? { interactive: true as const } : {}),
			...(node.atom ? { atom: true as const } : {}),
			// Source-derived fields are filled in once frames are resolved (see shoot).
			identity: {
				attributes: node.attributes ?? {},
				name: node.name ?? null,
				key: node.reactKey ?? null,
				component: node.react?.components[0]?.name ?? null,
				file: null,
				source: null,
			},
			children: assignDirs(node.children, dir),
		};
	});
}

/** The node at `dir` in a planned tree. */
export function findNode(nodes: ElementNode[], dir: string): ElementNode | undefined {
	for (const n of nodes) {
		if (n.dir === dir) return n;
		if (dir.startsWith(`${n.dir}/`)) return findNode(n.children, dir);
	}
	return undefined;
}

/**
 * Read a page's `elements.json`. Returns null for manifests from before
 * on-demand cropping (no `scale`); those captures stored `element.png` files
 * instead and diff by path.
 */
export function readElementManifest(file: string): ElementManifest | null {
	try {
		const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as ElementManifest;
		return (manifest.version ?? 0) >= MIN_MANIFEST_VERSION ? manifest : null;
	} catch {
		return null;
	}
}

/** Width and height of a PNG, read from its header without decoding it. */
export function pngSize(file: string): { width: number; height: number } | null {
	try {
		const fd = fs.openSync(file, "r");
		try {
			const header = Buffer.alloc(24);
			if (fs.readSync(fd, header, 0, 24, 0) < 24) return null;
			return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return null;
	}
}

/**
 * Where an element's box lands in a page screenshot of `page`'s size, in image
 * pixels. Boxes are in CSS pixels, so they're scaled by `scale` (the device
 * pixel ratio) and clamped to the image. Null when the box lies outside it.
 */
export function cropRect(
	page: { width: number; height: number },
	box: ElementRect,
	scale: number,
): ElementRect | null {
	// Size comes from the element's own dimensions, not its rounded edges, so
	// an unchanged element keeps the same crop size when a parent shifts it
	// by a sub-pixel amount (edge rounding would flip between e.g. 127/128).
	const left = Math.round(box.x * scale);
	const top = Math.round(box.y * scale);
	const x0 = Math.max(0, left);
	const y0 = Math.max(0, top);
	const x1 = Math.min(page.width, left + Math.round(box.width * scale));
	const y1 = Math.min(page.height, top + Math.round(box.height * scale));
	if (x1 <= x0 || y1 <= y0) return null;
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Copy `rect` (image pixels) out of `page`. */
export function cropImage(page: PNG, rect: ElementRect): PNG {
	const crop = new PNG({ width: rect.width, height: rect.height });
	PNG.bitblt(page, crop, rect.x, rect.y, rect.width, rect.height, 0, 0);
	return crop;
}

/**
 * Crops element images out of page screenshots, keeping the most recently used
 * few decoded pages and manifests in memory. `pageRoot` is a page's directory
 * inside a version (`versions/<key>/<slug>`).
 */
export class ElementImages {
	private pages = new Map<string, PNG | null>();
	private manifests = new Map<string, ElementManifest | null>();

	constructor(private readonly limit = 8) {}

	manifest(pageRoot: string): ElementManifest | null {
		return this.cached(this.manifests, pageRoot, () => readElementManifest(path.join(pageRoot, ELEMENT_MANIFEST)));
	}

	page(pageRoot: string): PNG | null {
		return this.cached(this.pages, pageRoot, () => {
			try {
				return PNG.sync.read(fs.readFileSync(path.join(pageRoot, PAGE_IMAGE)));
			} catch {
				return null;
			}
		});
	}

	/** The element at `dir`, cropped out of its page screenshot; null if it can't be. */
	crop(pageRoot: string, dir: string): PNG | null {
		const manifest = this.manifest(pageRoot);
		const node = manifest && findNode(manifest.elements, dir);
		if (!node) return null;
		const page = this.page(pageRoot);
		const rect = page && cropRect(page, node.box, manifest!.scale);
		return rect ? cropImage(page, rect) : null;
	}

	/** Forget everything loaded, e.g. after a version was re-captured. */
	clear(): void {
		this.pages.clear();
		this.manifests.clear();
	}

	private cached<T>(cache: Map<string, T>, key: string, load: () => T): T {
		const hit = cache.has(key);
		const value = hit ? cache.get(key)! : load();
		cache.delete(key);
		if (!hit && cache.size >= this.limit) cache.delete(cache.keys().next().value!);
		cache.set(key, value);
		return value;
	}
}
