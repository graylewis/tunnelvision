---
status: proposed
---

# Capture runs on Node Playwright; shot-scraper and Python are dropped

The page driver (`assets/capture.py`) runs on the Python Playwright that shot-scraper installs, and Node only sends it JS strings, while `--only-pages` runs through shot-scraper itself. State plugins (ADR 0011) need the real `Page`, init scripts and a CDP session from Node, so the driver moves to the `playwright` npm package, and `--only-pages` moves with it. That also removes the venv, the `playwright==1.52.0` pin and its `devtools` breakage, and the cost of wrapping a Python tool in a Node CLI that FINDINGS.md records. Setup installs Chromium with `npx playwright install chromium`, and `doctor` checks one toolchain instead of two.

The port ships on its own, before any plugin code, and only once it gives identical reviews to the Python driver on the reference sites. That way a regression in the port can't be mistaken for a plugin bug.

Playwright is pinned to an exact version, starting at 1.63.0, the version the shot-scraper venv ran. A new Playwright means a new Chromium, which changes pixels, so upgrading it is a deliberate step, like the version changes cheat mode watches for.

`runDriver` keeps the old driver's events and replies, so nothing downstream changed. Two details carry over Python Playwright's behaviour:

- **Function strings are called.** tunnelvision's scripts and users' `waitFor` predicates are function source in a string. Python's client calls a string that evaluates to a function, but Node's only calls actual functions, so the driver hands Playwright a function whose source is the string.
- **`undefined` becomes `null`.** Everything the driver reports is passed through JSON with `undefined` turned into `null`, as the old pipe did.

`--only-pages` keeps shot-scraper's behaviour: one shared context, pages loaded one at a time, and a **viewport** screenshot. shot-scraper set `full_page` only when no height was given, and tunnelvision always gave one, despite the README describing full-page screenshots.

## Parity

The gate was run against the old Python driver (shot-scraper 1.12, Python Playwright 1.63.0, the same Chromium build). The old driver ran twice, to separate run-to-run noise from driver differences:

- **`examples/dashboard`**, at its committed state with 4 URLs: a shoot, a review of planted changes (CSS padding, copy, a JSX class, a removed component), a cheat-mode review, `--only-pages` and `fingerprint`. Every screenshot, `elements.json`, `styles.json` and report was identical. Alternating old and new against one dev server gave the same render fingerprint every time, and a README-only commit carried all pages over in cheat mode under both drivers.
- **An Astro 6 and Tailwind 4 marketing site** (14 pages and 3,366 elements, with a real commit as the review): the same pages failed, the same elements fell outside the page, and both reviews found the same changes and causes. The only files where the new driver disagreed with both old runs held inline `style` attributes that framer-motion writes in varying order, which also differ between the two old runs.

Not run: a Next.js and Turbopack site. The one available needs secrets, its backends and a saved login.

## Considered options

- **Plugins as in-page JS behind the Python driver, with context-level settings declared as data**: rejected because the declarative vocabulary would have to grow with every plugin's needs, and coverage tracing needs a CDP round trip that plugins couldn't reach.
- **Keeping shot-scraper for `--only-pages`**: rejected because users would still need Python for that mode, plugins wouldn't work there, and `doctor` would check two toolchains.
