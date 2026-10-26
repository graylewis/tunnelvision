# Atoms and parts

Implements ADRs 0013–0015. Each step is shippable alone, in this order, because each one makes the next one's results trustworthy.

Steps 1–4 are built on `feat/atoms-and-parts`. On human-interfaces (`f875f2a..4eca9af`, both re-captured), elements went from 4,181 to 4,476 with a full capture still taking ~68s, unexplained changes went from 557 to 2 (both the toast region), and the StatusChip in the job header is an atom caused by `job-detail-header.tsx:48` and `status-chip.tsx:53`. The interactive check uses tags and ARIA roles only; step 3's contact sheet for judging atoms by eye isn't built yet.

## Steps

1. **Count changes in pixels** (ADR 0014). A pixel cutoff (default 1) replacing `maxDiffPercent` by default; browser and platform recorded in each Version's `meta.json`, with a warning when a diff's two Versions differ; an ancestor whose changed pixels all lie inside a changed child counts as its knock-on effect.
2. **Record elements that form one box** (ADR 0013). Add the atomic inline-level displays to the extraction script, with the running-text and 20-sibling guards, and bump the manifest version. Checked on the JobDetailHeader case (human-interfaces, `f875f2a..4eca9af`): the Badge (a `<div>`) and the StatusChip (a `<span>`) don't pair, so the chip is a new element caused by `job-detail-header.tsx:48` and the Badge a removed one caused by deleted line 49, where before the change the whole header was unexplained.
3. **Prototype the classifier** on existing captures: component chains and tags are already in `elements.json`, but interactive roles need adding to extraction (an in-page read, no CDP). Output a contact sheet, each page's screenshot with atoms outlined, and judge it by eye on the hard cases: a card that is one big link, table cells, the job detail header.
4. **Report in atoms.** Each element in the correlation report carries its atom and role; the CLI summary, representative screenshots and `update-pr` comments count and show atoms.
5. **sandhog.** Visual view rows are atoms and containers only; an atom's detail lists its changed parts, with each part's box outlined on the screenshot and in the on-page view; Code view groups effects by atom and component ("StatusChip × 20 in TracesTable"); a "show parts" toggle opens the full tree.
6. **Explain what still isn't elements.** SVGs (removed or swapped icons only show as pixels on their parent today) and the styles of `display: inline` content (a link's colour, an inline `<code>` background). Measure the extra leaves for SVGs before deciding whether they become elements or stay explanation-only.

## Speed work (second north star)

The floor isn't where the time goes. Measured on human-interfaces, 26 Oct 2026, 23 pages, 4 at a time:

| | Time |
|---|---|
| Full capture (styles for 2,031 leaves) | ~70s |
| Normal capture (styles carried over) | ~23s |
| Per leaf (CDP) | ~23ms of wall-clock |
| Diff | ~6s |

| Floor | Elements | Leaves | Full capture |
|---|---|---|---|
| Block-level (before ADR 0013) | baseline | 2,031 | ~70s |
| One box (ADR 0013), with guards | +6% | +0.1% | ~70s |
| Every node, `display: inline` and SVG included | +33% | +26% | ~83s |
| One box, at least 32×32 | −10% | −18% | ~62s |

Leads, largest first:

- **The fixed ~1s per page** sets the minimum for every normal review: the `wait`, the throwaway first screenshot, waiting for the network to go quiet. Profile it.
- **Repeated leaves.** Table rows repeat one structure, so one style query per distinct structure (tag, class and attribute path) could replace most of a table's queries, when no stylesheet rule can tell the rows apart (`:nth-child`, attribute selectors).
- **What each style query costs.** Each answer carries every ancestor's matched rules, so it grows with depth. Find out whether the ~23ms is spent in Chrome or in processing the answer.

## Bugs found on the way

- `words()` lowercases text before comparing copy, so a change only in case ("Failed" → "FAILED") gives no words to search for, and the hint "no changed line has it" is wrong: nothing was searched.
- Table cells in human-interfaces' TracesTable and TriageResultsTable changed with no change to their text or styles; probably a column-resize border from `data-table.tsx` painting over their crops (not verified).
