# Findings

What the tunnelvision prototype taught us: a CLI that screenshots every page in the sitemap, stores shots by git commit, diffs them with pixelmatch, and (with `--by-element`) diffs individual elements and traces them back to React source.

## Stable captures are the hard part

- Lazy and animated content must be forced to settle (`src/stabilize.ts`): wait for Astro islands to hydrate, scroll down step by step to fire one-shot reveals (re-reading `scrollHeight`, since pages grow), scroll back up, then disable CSS animations and transitions.
- `networkidle` needs a timeout cap, because some pages poll forever.
- Chromium's first full-page screenshot can permanently shift text layout (e.g. 28px to 27px). Take a throwaway shot, then the real one, then measure element positions.

## Measure and screenshot from one page load

- shot-scraper can't do both in one load, so we run our own Playwright driver (`assets/capture.py`) on shot-scraper's Python install.
- Store one full-page screenshot plus the element tree, and crop elements out of it when needed.
- Take crop size from the element's own width and height, not its rounded edges. Otherwise sub-pixel shifts flip sizes (127 vs 128px) and produce false `size-mismatch` results.

## Don't pair elements by DOM path

- One inserted `<div>` renumbers every later sibling.
- What worked (`src/matching.ts`): try identifiers from strongest to weakest (test attributes, `id`, React `key`, component + file, `name`, source line, sibling order).
  - Only unique values pair.
  - Conflicting deliberate ids veto a pair.
  - Content is never used for matching.
- Ignore generated ids. React's `useId` format changed three times (`:r1:`, `«r1»`, `_r_1_`).

## React source mapping is narrow

- Walk the fiber's `_debugOwner` chain and use the first non-React frame of `_debugStack`, then source-map it via the dev server.
- Requires React 19+ in a dev build with source maps. Older React and production builds only give component names.
- Each bundler reports script URLs differently (Vite, webpack, Turbopack, RSC), so each needs its own normalisation.

## GitHub PR comments have hard limits

- Comments can only attach to lines in the PR's diff, so style-only changes to untouched components can't be annotated. This is the biggest gap.
- Committing images to an orphan branch with low-level git commands works well: the checkout is never touched, and SHA links render in private repos.

## Dependency pain

- shot-scraper 1.8 breaks with Playwright ≥ 1.53, so it needs a pinned version in a per-project venv.
- Wrapping a Python tool from a Node CLI adds real setup friction.

## Reading the cascade over CDP

- `CSS.getMatchedStylesForNode` returns matched rules in cascade order: layered rules first (in layer order), then unlayered rules by specificity and source order. So the last normal declaration wins. `!important` has to be handled separately (it reverses layer order), and each rule reports its `layers`.
- Shorthands come back as one entry with a `range` and `longhandProperties`, followed by duplicate longhand entries without a `range`. Only ranged entries are real declarations. A longhand that a shorthand set belongs to the shorthand's line.
- Before `var()` is substituted, longhands show an empty value. Use the shorthand's text.
- `inherited[]` lists ancestors nearest first, all the way up to `:root`, including custom properties. Responses average about 27KB per node on the dashboard, mostly repeated ancestor rules, so the driver has to deduplicate rules into a table.
- Pipelined calls (32 in flight) take about 1.3s per 1,000 nodes; one at a time, about 1.4ms per node.
- Vite dev injects `<style data-vite-dev-id="/abs/path">` with an empty `sourceURL`. There's no source map unless `css.devSourcemap: true`, in which case `sourceMapURL` is an inline `data:` URL.
- CSS Modules rename classes (`.box` becomes `._box_zlz7f_1`) but keep line numbers, so an exact text comparison with the file on disk fails. Compare with class names normalised instead.

## Takeaway

Pixel diffing is easy. The value is in stable captures, reliable element matching, and linking changes back to source. The source link only works with modern React dev builds, and GitHub's diff-line limit stops it from covering style-only changes.
