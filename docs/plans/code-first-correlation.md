# Plan: code-first correlation

> **Status:** implemented. Where the build differs from this plan, see [Deviations](#deviations) at the end.

Implements [ADR 0001](../adr/0001-property-level-correlation.md), [0002](../adr/0002-capture-style-data-for-every-element.md) and [0003](../adr/0003-code-first-pr-review.md). Terms as in [CONTEXT.md](../../CONTEXT.md).

## Findings from the code that shape the plan

- **`-dirty` versions can't be reproduced later.** A `-dirty` key only records `HEAD`, so running `git diff` after more edits compares against the wrong working tree. Each capture has to save its own tree.
- **Bumping the manifest version as-is would hide existing captures.** `readElementManifest` rejects anything below `MANIFEST_VERSION`, so bumping it to 4 would make every v3 capture unreadable. Reading needs its own minimum version.
- **`diffVersions` keeps its element pairs to itself.** `matchElements` runs inside it and the pairs are thrown away. Correlation needs them.
- **`commentableLines` merges context and changed lines together.** Causes need only the `+`/`-` lines, so the patch parser has to report them separately.
- **There is no test runner.** The new pure modules (cascade, diff parsing, correlation, choosing the screenshot) are where bugs will hide, so this plan adds one.

## Phase 0: CDP spike (throwaway, about half a day)

Run against `examples/dashboard`, extended with a `var()` token, a shorthand (`padding`), an `!important` rule, a CSS Module and an `@layer`. Confirm and write down:

- Whether `getMatchedStylesForNode` returns rules in cascade order, and how `@layer`, `!important` and inline styles appear in its output.
- How shorthands are reported: whether `cssProperties` holds longhands with their own `range`, or needs `longhandProperties`.
- The format of the `inherited[]` list, and whether custom properties show up there.
- That `ownerNode` → `data-vite-dev-id` works, and what `CSS.getStyleSheetText` returns for sheets Vite injects.
- How long pipelined calls take on the tunnelvision repo's own 935-element page.

**Deliverable:** a recorded CDP response saved as a test fixture, plus a short note in `FINDINGS.md`.

## Phase 1: Capture the tree for each version

- **`git.ts`: `snapshotTree(root)`**
  1. Make a temporary `GIT_INDEX_FILE`.
  2. `read-tree HEAD`, then `add -A` (respects `.gitignore`), then `write-tree`.
  3. `commit-tree -p HEAD`, then `update-ref refs/tunnelvision/<key>` so `git gc` can't delete it.
  - Clean trees just use `HEAD`.
- **`versions.ts`:** `VersionMeta.rev` (a commit that exists for every git capture).
  - `clean` deletes the ref along with the version.
- **`git.ts`: `changedLines(fromRev, toRev)`** runs `git diff -U0 -M` and returns, per file, `{ oldPath, added: Set<line>, deleted: Set<line> }`, using paths relative to the repo top level.
- Versions without `rev`: use `sha` if the capture was clean. Otherwise correlation is skipped with a notice.

## Phase 2: Capture style data

### In-page (`elements.ts` `EXTRACT_JS`)
- For each element, record `computed: { [prop]: value }` for the tracked properties.
- Also record the custom properties those values reference (`getPropertyValue("--x")`).
- The property list is passed in the same way as `MATCH_ATTRIBUTES`.

### Driver (`assets/capture.py`)
After `extractJs`:
1. Open `new_cdp_session`, register the `CSS.styleSheetAdded` listener, then enable `DOM` and `CSS`.
2. Resolve each element's `selector` to a `nodeId`.
3. Run `getMatchedStylesForNode` for all elements through an `asyncio.Semaphore(32)`.
4. Emit a compact result:
   - a **rule table** deduplicated by `(styleSheetId, selector range)`, holding the selector, its range, and declarations `{name, value, important, range}`
   - per element: its own rule refs and inline declarations, plus `inherited: [[rule refs], …]` for each ancestor
   - per sheet: its header plus its text (`getStyleSheetText`)
5. Filter to `origin == "regular"` and inline styles.

### New module `src/cascade.ts` (pure)
- For each element and each tracked property, resolve the **winning declaration**:
  - order: CDP's rule order, inline style last, `!important` pass, layer handling (per the spike)
  - shorthands expanded
  - fall back to inherited rules for inheritable properties and for custom properties
- Follow `var()` chains to the winner for each `--x` (nested, with cycle guard).
- Mark the winner `uncertain` when nothing declares it but the computed value is neither the inherited nor the initial value.

### New module `src/stylesource.ts`
Resolve each sheet to a location:
1. **Source map:** reuse `reactsource.ts`, splitting `loadSourceMap` into "fetch the script" and "load a map from a ref" so a sheet's `sourceMapURL` goes straight in.
2. **Verified identity:** the path comes from `sourceURL` or `data-vite-dev-id`, and the sheet text must equal the file on disk at capture time.
3. **Otherwise:** no location.

Each declaration and selector gets `{ path, line }` in the same root-relative form as `ComponentSource.path`.

### Manifest (v4)
- A rule table per page.
- Per node, `styles: { [prop]: { value, winner: { rule, decl, inherited?, via?: [var decl refs] } | null, uncertain? } }`.
- `MIN_MANIFEST_VERSION = 3` for reading. v3 manifests load with `styles` absent.

### Other capture changes
- **Config:** `styles.properties`, defaulting to the curated set. Width and height are tracked but only count as changed when a declaration wins them. Otherwise they're layout results, and the change is treated as a knock-on effect.
- **`shoot` warning:** if any rules have no location, print one line that suggests `css.devSourcemap: true`, like the existing "no React source" warning.

## Phase 3: Correlation (pure: `src/correlate.ts`, `src/representative.ts`)

- **`diffengine.ts` change:** return the element pairs for each page next to the `PageDiff`s (`DiffReport.pairs`, not serialised).
- **Inputs:** element pairs, `PageDiff` status and mismatched pixels, both manifests, and `changedLines`.

### For each paired element with a visual change
1. **Diff tracked properties.**
   - If some changed, the candidates are:
     - the from-winner's declaration (old side)
     - the to-winner's declaration (new side)
     - their `var()` chains
     - the winning rules' selector lines if the winner switched
     - the element's JSX line (from the React frame)
   - Candidates that land on a changed line become **causes**.
   - If none do: when the winner switched, record "winner changed"; otherwise the change is an **unexplained visual change**.
2. **No tracked property changed:** a **knock-on effect**. Attach it to the nearest ancestor, or earlier sibling in the `to` tree, that had a property change.
3. **Added or removed elements:** their JSX line (new side or old side) is the only candidate.

### Output
Group effects by cause: `Cause { path, line, side, kind: decl|selector|var|jsx, effects: [{ page, dir, props: [{name, from, to}], via: direct|inherited|var|knock-on }], representative, alsoCausedBy }`.

### Leftovers
- **Invisible change:** a changed line in a stylesheet that isn't a cause.
  - It counts as **not exercised** when it doesn't fall inside any rule in either version's rule table (no captured element matched that rule).

### `representative.ts`
- Rank a cause's effects by changed pixels.
- Tukey fence (Q3 + 1.5·IQR); with fewer than 4 effects, pick the largest.
- `size-mismatch` effects rank by the area of the larger crop.

## Phase 4: Surfaces

- **`report.ts`:** a "Causes" section (`file:line → n elements, props`) printed after the page list, plus counts of unexplained and invisible changes. The JSON report gets `correlation`.
- **Inspector:**
  - `/api/diff` includes `correlation`.
  - The node panel shows changed properties (before → after) and the cause chain.
  - New tabs list causes, unexplained visual changes, and invisible / not-exercised changes.
- **`update-pr`:**
  - `--mode code-first|visual-first` and config `updatePr.mode`, default `code-first`.
  - Code-first:
    - Correlate using the PR's `+`/`-` lines (the parser in `github.ts` returns changed lines separately from commentable ones).
    - One comment per cause line (LEFT for deleted lines).
    - The comment shows the representative's before/after/diff, plus a collapsed list of the other effects and any "also affected by" lines.
    - Leftovers are not posted.
  - Visual-first is today's code, moved into its own function unchanged.
  - The markers stay per line, so re-running edits comments in place in both modes.

## Phase 5: Tests and docs

- Add a `test/` directory with `node:test`.
- Add `tsconfig.test.json` (outDir `.test-dist`, gitignored) and a `test` script.
- Cover:
  - cascade (from the spike fixture)
  - `-U0` diff parsing
  - correlation (small hand-written manifests: direct, inherited, `var()`, knock-on, winner switched, deleted rule)
  - choosing the representative screenshot
- End-to-end check by hand on `examples/dashboard` over two commits:
  - a CSS declaration edit
  - a token edit
  - a className edit
  - a deleted rule
  - a dirty working tree
- Update README (the new capture data, correlation, `update-pr --mode`) and `doctor` (Vite with PostCSS/Tailwind but no `devSourcemap`).

## Order and dependencies

- Phase 0 blocks only `cascade.ts`.
- Phase 1, the `diffengine` pair export and `representative.ts` don't depend on it and can start straight away.
- Phase 3 needs Phases 1 and 2.
- Phase 4 needs Phase 3.
- `update-pr` last, because it depends on the other surfaces.

## Deviations

- **Style data is stored in `styles.json`, not in the manifest (and there's no v4 bump).** Pretty-printed nested style data grew `elements.json` from about 0.6MB to 2.5MB on the dashboard. A separate compact file holds computed values plus winners only where a declaration sets something (about 19% of properties). Its presence is what marks a capture as having style data.
- **Only the element's own property changes can be causes.** A property counts as the element's own when its winning declaration's text (or a `var()` it uses) differs between versions. If the value changed but the declaration didn't, it's a layout result (`PropChange.own` is unset) and doesn't block knock-on attribution.
- **Knock-on attribution depends on geometry.** An element that moved or resized was pushed by an earlier sibling that resized, or by an ancestor that moved, resized or changed itself. A box that stayed put changed because of its content, so it takes its descendants' causes. Knock-on effects resolve transitively.
- **Representative screenshots come from direct effects first.** Knock-on effects include containers up to the whole page, which would otherwise be picked. Those are only used when a line has no direct effects.
- **Replaced lines** (`-`/`+` pairs) become one RIGHT cause. The deleted half isn't reported as an invisible change.
- **`update-pr` code-first** filters the version-to-version correlation down to the PR's `+`/`-` lines instead of re-correlating against the PR diff.
- **The `uncertain` flag** covers only CSS-wide keywords (`unset`, `revert`, …). `inherit` is followed.
- **Tunnelvision's own stabilize `<style>`** (`data-tunnelvision`) is left out of the rule table.

## Known imprecision

- A resized element passes on only its own causes as knock-on effects, even when its resize came from something else. In the dashboard e2e, bar labels moved by the `.card` padding change were attributed to `--accent`, which the bars they sit next to changed.
- A cause's text shows the first declaration that hit on its line. A line with several declarations (`.dot { width: …; height: … }`) shows only one of them.
