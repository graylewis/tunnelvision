---
name: test-tunnelvision
description: Check that tunnelvision works on this app — make a throwaway branch with known subtle and significant visual changes, capture and diff it, then verify tunnelvision reported exactly those changes and nothing else. Flags false positives from animations and from regions that hadn't loaded. Use when the user asks to test, validate, or trust tunnelvision's setup, or asks why a review is noisy.
---

# Test tunnelvision on this app

Prove the setup end to end: plant changes you know about, run tunnelvision, and grade its answer. The grading is the point — a capture that runs is not the same as a capture that's right.

Vocabulary: a **Version** is one capture keyed by git commit; a **Visual change** is an element whose pixels differ between two Versions; a **Cause** is a changed line that explains one; an **Unexplained visual change** has no cause among the changed lines; an **Invisible change** is a changed stylesheet line that changed no pixels. A **Knock-on effect** is an element that only moved because a neighbour or ancestor changed.

`tunnelvision` below means the project-local binary (`npx --no tunnelvision`, `pnpm exec tunnelvision` or `bunx --no-install tunnelvision`). If the project has a `.venv` with shot-scraper, activate it in the same shell invocation as every tunnelvision command.

Ask the user one question at a time, only when a step needs a decision.

## 1. Preconditions

Stop and say what's missing rather than working around it:

- `.tunnelvision/config.json` exists (else `/setup-tunnelvision`).
- `shot-scraper --version` works (venv active?).
- The app answers at `baseUrl` from the config (`curl -sI`). It must be the **dev server with hot reload**, not a production build, or the planted changes won't be served.
- `git status --porcelain` is empty. Ask the user to commit or stash; don't stash for them.
- Note the current branch (or detached SHA) — you'll return to it.

Read `.tunnelvision/versions/*/meta.json` and pick the **baseline**: the Version whose `sha` matches `git rev-parse --short HEAD` and isn't `dirty`. If there isn't one, run `tunnelvision shoot` now so the comparison contains only what you're about to change.

## 2. Test branch and noise floor

```sh
git checkout -b tunnelvision-test/<short-sha>
git commit --allow-empty -m "tunnelvision test: noise floor"
tunnelvision shoot
tunnelvision diff <baseline> <noise-key>
```

Same code, new key, second capture. Anything this diff reports is **noise** — a change tunnelvision sees between two captures of identical code — and it's the cleanest evidence of the two false-positive classes below. Ideal output: every page `unchanged`, no Causes, no unexplained changes. Keep the list of noisy elements; step 5 subtracts them.

## 3. Plant the changes

Read the app's stylesheets and components and pick concrete edits covering the kinds below. Aim for eight to twelve, on elements that appear on the captured pages (check the sitemap). Prefer files with CSS source maps or plain CSS; changes in a Tailwind class string count as JSX changes.

| Kind | Example | Magnitude | Expect |
| --- | --- | --- | --- |
| Custom property | `--muted: #6b7280` → `#4b5563` | subtle | one Cause of kind `variable`, effects `via: "var"` on many elements |
| Own declaration, subtle | `padding: 8px 12px` → `10px 12px`, or `font-weight: 500` → `600` | subtle | Cause `declaration`, effects `via: "direct"`, plus knock-on effects on siblings below |
| Own declaration, large | `font-size: 22px` → `30px` on a heading | significant | as above, with more knock-ons |
| Inherited | `font-size` on a container whose children have none | subtle | effects `via: "inherited"` on the children |
| Selector change | `.bar-label` → `.bar-label, .feed-item .small` | subtle | Cause `selector` |
| Deleted rule | remove `.badge.down { … }` | significant | Cause with `side: "LEFT"` |
| JSX class | `className="button"` → `"button primary"` | significant | Cause `jsx`, effect `via: "jsx"` |
| Copy | change one word of visible text | subtle | Cause `copy`, effect `via: "copy"` |
| Removed element | delete a small component or a list item | significant | effect `status: "removed"` on it, knock-ons on what moves up |
| Layout | `grid-template-columns: 1fr 2fr` → `2fr 1fr`, or a section's background colour | significant | many effects, mostly knock-on |
| Invisible: not exercised | add `.nav-item:hover { background: … }` | — | in `invisible` with `reason: "not-exercised"` |
| Invisible: no effect | add `cursor: text` to an input | — | in `invisible` with `reason: "no-effect"` |

Write the plan **before capturing** as a manifest at `.tunnelvision/test-manifest.md` (that directory is gitignored): one row per edit with `file:line` (line numbers *after* the edit — take them from `git diff`), kind, what should be visible, on which pages, and its magnitude. This is what you grade against; don't adjust it afterwards to fit the results.

Commit: `git commit -am "tunnelvision test: planted visual changes"`.

Confirm the dev server picked the commit up before capturing. Vite dev serves sources, so `curl -s <baseUrl>/src/styles.css | grep -c '<new value>'` (adjust the path) settles it; for other servers, fetch a page and look for the changed copy, or check the server log for a rebuild. If nothing confirms it and the server is a preview/production build, stop and ask.

## 4. Capture and diff

```sh
tunnelvision shoot
tunnelvision diff <noise-key> <test-key> --report .tunnelvision/test-report.json
```

Read both the printed summary (page table, then `Causes` with `path:line → N elements props`, then the unexplained / invisible counts) and the JSON. Exit code 1 means changes were found — expected here. In the JSON: `pages[]` has one entry per element with `filename`, `status` (`changed`, `added`, `removed`, `size-mismatch`, `unchanged`, `error`) and `diffPercent`; `correlation.causes[]`, `correlation.unexplained[]`, `correlation.invisible[]`; `correlationSkipped` explains a missing `correlation` (usually no git diff between the two Versions, or captures without style data).

Images: diff images are written under `.tunnelvision/diffs/<from>__<to>/<page>/…/element.png`; each Version's full-page screenshot is `.tunnelvision/versions/<key>/<page>/page.png`, with the element tree in `elements.json` (each node has `dir`, `tag`, `className`, `text`, `box`, `component`) and style data in `styles.json`. Open the PNGs and actually look, don't infer from numbers alone. If you can't view images, say so up front and fall back to `diffPercent`, the two pages' `elements.json` (which elements exist on each side, and their `box` heights) and the `page.png` dimensions.

## 5. Grade

Build three tables.

### Recall — every manifest row found?

For each row, find its `path:line` in `correlation.causes[]` (deleted lines have `side: "LEFT"` and the baseline's line number). Check `kind`, the dominant `via`, and that `effects.length > 0` and lands on the expected pages. Invisible rows should be in `correlation.invisible[]` with the right `reason`. Outcomes:

- **found** — as expected.
- **found, mis-traced** — the change is in `unexplained[]` instead of under its Cause, or under a different line. Usually a source-map problem (`tunnelvision doctor`, Vite `css.devSourcemap`) or a React 18/production build; say which.
- **missed** — a subtle change with no Cause and no unexplained entry. Compare the two `page.png` crops of the element by eye. If the pixels really differ, the pixel threshold ate it: `diff.threshold` (0.1, per-pixel colour distance) or `diff.maxDiffPercent` (0.03, per element) — `tunnelvision diff <noise> <test> --threshold 0.05` re-diffs the stored captures without recapturing, so try it. If the pixels don't differ, the dev server didn't serve the change; re-check step 3.

### Precision — anything reported that wasn't planted?

Every entry in `correlation.unexplained[]`, every Cause not in the manifest, and every `added`/`removed` element not explained by a planted removal is a false positive. First remove anything that also showed up in the step 2 noise floor. Then classify what's left into one of the two classes below or "genuine" (e.g. a knock-on you didn't predict — those are correct, not false positives).

### False-positive class A: animations

tunnelvision already scrolls the page to fire scroll-triggered reveals, waits `settle` ms, emulates `prefers-reduced-motion: reduce`, and then turns off CSS animations and transitions before the screenshot. What slips through: JS-driven animations (framer-motion, GSAP, canvas, video, animated GIFs, carousels, typing effects, live clocks and counters) and reveals that take longer than `settle`.

Signatures:

- The same element differs in the **noise floor** and in the test diff, with no planted change on it.
- The diff image shows the same shape shifted, rotated, faded or mid-transition rather than a different design.
- `className` or `tag` hints: `animate-`, `motion`, `spinner`, `pulse`, `marquee`, `carousel`, `ticker`, `video`, `canvas`.
- A lone `unexplained` entry whose `props` are `opacity` or `transform`, or empty.

Remedies to propose, cheapest first: raise `settle` for that page (`pages["/path"].settle`, e.g. 2000) when the animation finishes on its own; a `pages["/path"].waitFor` JS predicate when the page exposes a done-state; have the app honour `prefers-reduced-motion` (tunnelvision sets it); for things that never finish (video, live data), accept them as known noise or hide them under a test-only flag.

### False-positive class B: not-loaded regions → false deletions

If a region hadn't rendered when one side was captured (data still fetching, lazy images, skeleton loaders, late hydration, a font swap), its elements are `removed` on that side, `added` on the other, and everything below them shifts.

Signatures:

- A **cluster** of `removed` (or `added`) elements sharing a parent `dir`, none of which you deleted; `message: "element no longer present"`.
- `img`, list rows, table bodies, charts, or anything below the fold in `elements.json`.
- One `page.png` is shorter, or has a blank/skeleton block where the other has content; the page entry itself may be `size-mismatch`.
- The noise-floor diff showed the same region, or the cluster appears in only one of the two captures of the test branch if you re-shoot.

Remedies: raise `wait` for that page (`pages["/path"].wait`, e.g. 3000) or globally; better, a `pages["/path"].waitFor` predicate on the last thing to load, e.g. `document.querySelectorAll('.orders tbody tr').length > 0` or `!document.querySelector('.skeleton')`; for images, `Array.from(document.images).every(i => i.complete)`. These need a recapture to take effect (`shoot`, not `diff`).

## 6. Report

Give the user, in this order:

1. **Verdict** — one line: found *n/m* planted changes, *k* false positives (A: …, B: …), noise floor clean / noisy.
2. **Recall table** — manifest row, outcome, note.
3. **False positives** — element, page, class, evidence (what you saw in the image), proposed remedy.
4. **Config changes** — the exact `.tunnelvision/config.json` additions you'd make. Offer to apply them and re-run: `diff --threshold` re-uses the stored captures; `wait`/`settle`/`waitFor` changes need `shoot` again on the test commit, then another diff. Do one iteration if the user agrees, and report whether the false positives went away.

Be plain about failures: a missed subtle change or a noisy page is the result, not something to soften.

## 7. Clean up

Ask, then:

```sh
git checkout <original branch>
git branch -D tunnelvision-test/<short-sha>
```

Keep the baseline Version. Offer to remove the test Versions and diffs (`rm -rf .tunnelvision/versions/<noise-key> .tunnelvision/versions/<test-key> .tunnelvision/diffs/*__<test-key> .tunnelvision/diffs/*__<noise-key>`) and the manifest and report files; leave them if the user wants to inspect further with `tunnelvision inspector`. Any config changes agreed in step 6 stay — they're the deliverable.
