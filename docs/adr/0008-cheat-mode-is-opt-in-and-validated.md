---
status: accepted
---

# Cheat mode is opt-in, and becomes a project's default only after it proves identical reviews

Even with carry-over, normal mode settles and screenshots every page: about 50s on the 21-page reference site, where the target is under 20s. Cheat mode skips that work. Once a page has hydrated, it takes a Render fingerprint of the page's normalized DOM, the CSSOM rule text, and the bytes of every script, image and font the page loaded. If that matches the ancestor Version's fingerprint, the page is carried over without settling. Otherwise it falls back to normal mode.

Script bodies are part of the fingerprint because JS-only changes, such as a scroll-reveal's end state, never appear in the pre-scroll DOM. Bundle bytes alone were rejected as the signal because dev servers don't emit deterministic bundles across projects.

Things that vary between loads of the same code are ignored:

- inline styles are always canonicalized;
- a short built-in list of dev-mode attributes is stripped (Astro's `server-render-time` and `client-render-time`, Vite's `?t=` stamps);
- the setup skill fingerprints the same commit twice and saves any attribute that still varied to `tunnelvision.json`.

Nothing is learned during normal runs, because an attribute that varied harmlessly once can matter another time. Attributes that decide what's painted (`style`, `class`, `src`, …) are never learned. If one of them varies, the page was still changing when it was fingerprinted. For that reason the fingerprint waits up to 5s for the page to go quiet: finite animations finished, and two snapshots 100ms apart identical. framer-motion entrance animations otherwise made a few pages differ between loads. Audio and video load in byte ranges, so they're identified by their `ETag`, `Last-Modified` and length rather than their bytes.

Cheat mode trusts that render inputs determine pixels, so it is behind a flag. The setup skill makes it the default only when the following test passes. It plants changes on a throwaway branch, including ones aimed at the fingerprint's blind spots (a JS-only reveal change, an image swapped under the same URL, a font change). Cheat mode must then report exactly the same Visual changes and Causes as normal mode, and must fingerprint-match every page on a no-change capture.

The preference records the tunnelvision, framework and dev-server versions it was validated against. If any of them change, `shoot` falls back to normal mode and `doctor` reports it until setup validates again.
