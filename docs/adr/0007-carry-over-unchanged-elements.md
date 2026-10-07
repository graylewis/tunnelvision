---
status: accepted
---

# Unchanged elements carry their style data over from the nearest ancestor Version

A full capture of a 21-page Astro site took about 3.5 minutes, and 72% of that was CDP style queries. Each `CSS.getMatchedStylesForNode` call returns the whole inherited chain, about 400KB on a Tailwind page, and costs about 115ms of renderer time however many are in flight. Most commits change one or two pages, so a new Version now reuses style data from the nearest ancestor Version: one already captured under the same key, else the newest Version of the nearest commit on HEAD's first-parent history. Nothing is reused when the capture settings or the data format differ, or when a lockfile changed, since installed packages can change in ways the diff can't see.

Every page is still loaded, settled, screenshotted and extracted; that part is cheap. An element then keeps its previous style data only if all of these hold:

- it matches its counterpart by identity;
- its tracked computed values are identical;
- its own JSX line isn't a line the commit added or edited;
- no stylesheet rule the commit added, edited or deleted matches it (the selectors are tested in the page);
- every rule its winners come from remaps exactly through `git diff -U0`. A line inside an edited hunk counts only if its exact text is in the new hunk.

Elements that fail any check are re-queried over CDP, so a typical edit costs a handful of calls instead of thousands. Every Version still holds full style data for every element, as ADR 0002 requires, and its source locations are correct at its own rev. That's why any Version can still be correlated against any other.

During design, page-level carry-over was going to be gated by a zero-pixel diff. It was dropped from normal mode because fresh extraction is cheap: the element rule decides per element, and it's never less precise. Whole-page carry-over now lives only in cheat mode (ADR 0008).

## Considered options

- **Approximate line remapping**: mapping lines inside edited hunks by their relative position. Rejected because a wrong baseline line turns into a silent Unexplained visual change.
- **Recording a captured-at rev per page**: rejected because it breaks the "one rev per Version" assumption across correlate, review and update-pr.
- **Reusing a page only when the commit touched none of its files**: rejected because shared layout and CSS files appear on every page, so almost nothing would be reused.
- **Replacing CDP with in-page CSSOM matching**: deferred. It would speed up first captures too, but it means reimplementing the cascade.
