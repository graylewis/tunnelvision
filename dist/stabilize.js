/** Default milliseconds animations get to finish after the scroll pass. */
export const DEFAULT_SETTLE_MS = 500;
/**
 * Settle animated pages before they're captured. Evaluated in the page after
 * the configured wait and before the screenshot, in both capture paths. Both
 * also emulate `prefers-reduced-motion: reduce`, which sites that honour it
 * (framer-motion's `useReducedMotion`, `MotionConfig reducedMotion="user"`,
 * CSS media queries) use to skip or shorten animations.
 *
 * 0. Wait (up to 10s) for Astro islands to hydrate. Astro removes the `ssr`
 *    attribute from `<astro-island>` once its component has hydrated, and a
 *    `whileInView` reveal only watches the viewport after hydration, so an
 *    island that hydrates after the scroll pass would stay hidden.
 * 1. Scroll down a step at a time, then back to the top, so every
 *    scroll-triggered reveal (framer-motion `whileInView`, IntersectionObserver
 *    fade-ins, lazy images) fires. These are usually one-shot, so they stay
 *    revealed once we're back at the top. Each step waits 300ms, so a page
 *    busy with other captures still renders a frame there for its reveals.
 * 2. Wait `settleMs` for the animations those reveals started to finish.
 *    JS-driven ones (framer-motion's `motion.div`) aren't affected by the next
 *    step, so pages with long ones need a longer settle.
 * 3. Turn off CSS animations and transitions, which freezes looping effects
 *    (pulsing dots, spinners) and snaps any leftover fades to their end state.
 *
 * Returns a promise; Playwright's `evaluate` waits for it to resolve.
 */
export function stabilizeScript(settleMs = DEFAULT_SETTLE_MS) {
    return STABILIZE_JS.replace("__SETTLE_MS__", String(Math.max(0, Math.round(settleMs))));
}
const STABILIZE_JS = `
async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
