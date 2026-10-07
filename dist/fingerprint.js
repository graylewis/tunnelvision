/**
 * The render fingerprint: what a page rendered from, hashed once it has
 * hydrated but before it's scrolled or settled, so cheat mode can tell a page
 * hasn't changed without settling and screenshotting it (see
 * docs/adr/0008-cheat-mode-is-opt-in-and-validated.md).
 *
 * The page contributes its DOM and the text of its CSS (the scripts below);
 * the driver adds the bytes of every script, stylesheet, image and font it
 * loaded or refers to. Details that differ between two loads of the same code
 * are left out:
 *
 * - `<script>` elements (their code is hashed as a resource) and comments;
 * - attributes in `BUILTIN_VOLATILE_ATTRIBUTES` and the project's own
 *   `cheatMode.ignoreAttributes`, which `tunnelvision fingerprint` finds;
 * - the order and spacing of inline style declarations (framer-motion
 *   rewrites `style` in whatever order it animates);
 * - Vite's `?t=<timestamp>` on hot-reloaded module URLs.
 *
 * Entrance animations (framer-motion's `animate`, CSS fade-ins) are still
 * running when a page has just hydrated, and their in-flight inline styles
 * would differ from load to load. So the script waits, up to 5s, for the page
 * to go quiet: every finite animation finished, and two snapshots 100ms
 * apart the same.
 */
/**
 * Attributes never left out of the fingerprint, however much they vary: they
 * decide what's painted. One that varies means the page hasn't settled when
 * it's fingerprinted, not that it can be ignored.
 */
export const VISUAL_ATTRIBUTES = [
    "style",
    "class",
    "src",
    "srcset",
    "href",
    "hidden",
    "open",
    "width",
    "height",
    "d",
    "points",
    "viewbox",
    "transform",
    "fill",
    "stroke",
    "x",
    "y",
    "cx",
    "cy",
    "r",
    "value",
    "checked",
    "selected",
    "disabled",
];
/** Attributes known to change on every load of the same code. */
export const BUILTIN_VOLATILE_ATTRIBUTES = [
    // Astro dev: how long each island took to render.
    "server-render-time",
    "client-render-time",
];
/**
 * The in-page fingerprint script. Resolves to `{ dom, css, urls }`: the DOM as
 * normalized lines (`E path tag`, `A path name=value`, `T path text`), the
 * text of every stylesheet's rules, and the media URLs the page refers to.
 */
export function fingerprintScript(ignoreAttributes = []) {
    return FINGERPRINT_JS.replace("__IGNORED__", JSON.stringify([...new Set([...BUILTIN_VOLATILE_ATTRIBUTES, ...ignoreAttributes])]));
}
const FINGERPRINT_JS = `
async () => {
	const ignored = new Set(__IGNORED__);
	const stamp = /([?&])t=\\d{10,}&?/g;
	const clean = (v) => v.replace(stamp, "$1").replace(/[?&]$/, "");
	const lines = [];
	const urls = [];
	const styleText = (el) => {
		const out = [];
		for (let i = 0; i < el.style.length; i++) {
			const name = el.style[i];
			const prio = el.style.getPropertyPriority(name);
			out.push(name + ":" + el.style.getPropertyValue(name).trim() + (prio ? "!" + prio : ""));
		}
		return out.sort().join(";");
	};
	const visit = (node, path) => {
		let i = 0;
		for (const child of node.childNodes) {
			const p = path + "." + i++;
			if (child.nodeType === 3) {
				if (child.data.trim()) lines.push("T " + p + " " + child.data);
				continue;
			}
			if (child.nodeType !== 1) continue;
			const tag = child.tagName.toLowerCase();
			if (tag === "script" || child.hasAttribute("data-tunnelvision")) continue;
			lines.push("E " + p + " " + tag);
			const attrs = [];
			for (const a of child.attributes) {
				if (ignored.has(a.name)) continue;
				attrs.push(a.name + "=" + (a.name === "style" ? styleText(child) : clean(a.value)));
			}
			for (const a of attrs.sort()) lines.push("A " + p + " " + a);
			if (tag === "img") urls.push(child.currentSrc || child.src);
			if (tag === "video" && child.poster) urls.push(child.poster);
			if (tag === "source" && child.src) urls.push(child.src);
			if (child.shadowRoot) visit(child.shadowRoot, p + "s");
			visit(child, p);
		}
	};
	const snapshot = () => {
		lines.length = 0;
		urls.length = 0;
		visit(document, "");
		const css = [];
		for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) {
			if (sheet.ownerNode && sheet.ownerNode.hasAttribute && sheet.ownerNode.hasAttribute("data-tunnelvision")) continue;
			try {
				for (const rule of sheet.cssRules) css.push(rule.cssText);
			} catch (e) {
				css.push("unreadable " + clean(sheet.href || ""));
			}
		}
		return { dom: [...lines], css: css.join("\\n"), urls: urls.filter((u) => /^https?:/.test(u)) };
	};
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	const deadline = performance.now() + 5000;
	let last = snapshot();
	while (performance.now() < deadline) {
		const finite = document.getAnimations().filter((a) => {
			const t = a.effect && a.effect.getComputedTiming();
			return a.playState === "running" && t && Number.isFinite(t.endTime);
		});
		await Promise.race([Promise.all(finite.map((a) => a.finished.catch(() => {}))), sleep(deadline - performance.now())]);
		await frames();
		await sleep(100);
		const next = snapshot();
		if (next.css === last.css && next.dom.join("\\n") === last.dom.join("\\n")) return next;
		last = next;
	}
	return last;
}
`.trim();
/**
 * Wait (up to 10s) for Astro islands to hydrate, as step 1 of the stabilize
 * script does, so the fingerprint sees what they render.
 */
export const HYDRATE_JS = `
async () => {
	const unhydrated = () =>
		document.querySelectorAll('astro-island[ssr]:not([client="visible"]):not([client="media"])').length;
	for (let waited = 0; unhydrated() > 0 && waited < 10000; waited += 50) await new Promise((r) => setTimeout(r, 50));
}
`.trim();
/**
 * Which of `elements` (selectors from the element tree) any of `selectors`
 * matches. A selector the browser can't parse matches everything.
 */
export const MATCH_JS = `
({ selectors, elements }) => {
	const nodes = elements.map((s) => [s, document.querySelector(s)]);
	const hit = new Set();
	for (const sel of selectors) {
		let matched;
		try {
			matched = new Set(document.querySelectorAll(sel));
		} catch (e) {
			return elements;
		}
		for (const [s, el] of nodes) if (el && matched.has(el)) hit.add(s);
	}
	return [...hit];
}
`.trim();
