/** Default milliseconds animations get to finish after the scroll pass. */
export const DEFAULT_SETTLE_MS = 500;
/**
 * Dev-only overlays that frameworks float over the page in development and
 * that drift between captures of identical code (the pill slides, auto-hides,
 * or lands at a different scroll offset in the full-page screenshot). Hidden
 * before the scroll pass so they neither paint nor enter the element tree.
 *
 * - Astro dev toolbar: the `<astro-dev-toolbar>` host appended to `<body>`
 *   (its UI lives in that element's shadow root).
 * - TanStack Devtools (`@tanstack/devtools`, `@tanstack/react-devtools`, …):
 *   the shell is portalled into `<body>` as an anonymous `<div>`, so target
 *   its trigger buttons and panel by their stable aria/data attributes.
 * - TanStack Query Devtools: `.tsqd-parent-container` is the framework
 *   wrappers' host; the `tsqd-*` classes are the core's own roots, which
 *   also match when a wrapper uses a different host.
 * - TanStack Router Devtools: `.TanStackRouterDevtools` is the core's root
 *   in every framework wrapper.
 */
export const DEVTOOLS_OVERLAY_SELECTORS = [
    "astro-dev-toolbar",
    '[aria-label^="Open TanStack Devtools"]',
    '[aria-label="TanStack Devtools"]',
    "#tanstack-devtools-panel",
    '[data-testid="tanstack-devtools-panel"]',
    "[data-tsd-surface]",
    ".tsqd-parent-container",
    ".tsqd-open-btn-container",
    ".tsqd-main-panel",
    ".tsqd-transitions-container",
    ".TanStackRouterDevtools",
];
/**
 * Settle animated pages before they're captured. Evaluated in the page after
 * the configured wait and before the screenshot, in both capture paths. Both
 * also emulate `prefers-reduced-motion: reduce`, which sites that honour it
 * (framer-motion's `useReducedMotion`, `MotionConfig reducedMotion="user"`,
 * CSS media queries) use to skip or shorten animations.
 *
 * 0. Hide framework dev overlays (`DEVTOOLS_OVERLAY_SELECTORS`) with a
 *    `display: none` stylesheet, and also any `<body>` child whose shadow root
 *    holds one (TanStack Query Devtools' `shadowDOMTarget`). Done first so
 *    they're out of the way for everything below, and so the element tree,
 *    which skips `display: none`, never records them.
 * 1. Wait (up to 10s) for Astro islands to hydrate. Astro removes the `ssr`
 *    attribute from `<astro-island>` once its component has hydrated, and a
 *    `whileInView` reveal only watches the viewport after hydration, so an
 *    island that hydrates after the scroll pass would stay hidden.
 * 2. Scroll down a step at a time, then back to the top, so every
 *    scroll-triggered reveal (framer-motion `whileInView`, IntersectionObserver
 *    fade-ins, lazy images) fires. These are usually one-shot, so they stay
 *    revealed once we're back at the top. IntersectionObserver only checks
 *    targets while rendering a frame, and a page busy with other captures can
 *    go 300ms without one, so each step waits for two frames at that scroll
 *    position (capped, in case frames never come) before its 300ms pause.
 * 3. Wait `settleMs` for the animations those reveals started to finish.
 *    JS-driven ones (framer-motion's `motion.div`) aren't affected by the next
 *    step, so pages with long ones need a longer settle.
 * 4. Turn off CSS animations and transitions, which freezes looping effects
 *    (pulsing dots, spinners) and snaps any leftover fades to their end state.
 *
 * Returns a promise; Playwright's `evaluate` waits for it to resolve.
 */
export function stabilizeScript(settleMs = DEFAULT_SETTLE_MS) {
    return STABILIZE_JS.replace("__SETTLE_MS__", String(Math.max(0, Math.round(settleMs)))).replace("__OVERLAY_SELECTORS__", JSON.stringify(DEVTOOLS_OVERLAY_SELECTORS));
}
const STABILIZE_JS = `
async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
	// The second rAF fires only once the first frame has rendered, and with it
	// the IntersectionObserver checks for this scroll position.
	const rendered = () => Promise.race([frame().then(frame), sleep(1000)]);
	const overlays = __OVERLAY_SELECTORS__;
	const hide = document.createElement("style");
	hide.setAttribute("data-tunnelvision", "hide-devtools");
	hide.textContent = overlays.join(", ") + " { display: none !important; }";
	(document.head || document.documentElement).appendChild(hide);
	// A stylesheet in the document can't reach into shadow roots; hide the host.
	for (const host of Array.from(document.body ? document.body.children : [])) {
		if (host.shadowRoot && overlays.some((s) => host.shadowRoot.querySelector(s))) {
			host.style.setProperty("display", "none", "important");
		}
	}
	// client:visible and client:media islands only hydrate once scrolled to or
	// matched, so don't wait on those here.
	const unhydrated = () =>
		document.querySelectorAll(
			'astro-island[ssr]:not([client="visible"]):not([client="media"])',
		).length;
	for (let waited = 0; unhydrated() > 0 && waited < 10000; waited += 50) await sleep(50);
	const scroller = document.scrollingElement || document.documentElement;
	const step = Math.max(100, Math.floor(window.innerHeight * 0.75));
	// scrollHeight can grow as lazy sections load, so re-read it every step.
	for (let i = 0, y = 0; i < 200 && y < scroller.scrollHeight - window.innerHeight; i++) {
		y += step;
		window.scrollTo({ top: y, behavior: "instant" });
		await rendered();
		await sleep(300);
	}
	window.scrollTo({ top: 0, behavior: "instant" });
	// Let the reveals the scroll triggered finish before freezing things.
	await sleep(__SETTLE_MS__);

	const style = document.createElement("style");
	style.setAttribute("data-tunnelvision", "stabilize");
	style.textContent =
		"*, *::before, *::after { animation: none !important; transition: none !important; }";
	(document.head || document.documentElement).appendChild(style);
	await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}
`.trim();
