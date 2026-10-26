---
status: proposed
---

# Elements are nodes that form one box, not block-level nodes

Elements were every visible block-level node, with inline-level nodes flattened into their parent. The only real constraint behind that was cropping: a `display: inline` node can break across lines, so its bounding rect covers text that isn't its own. Atomic inline-level boxes (`inline-block`, `inline-flex`, `inline-grid`, `inline-table`, and form controls, which default to `inline-block`) never break and always have one rectangle, and they're usually the pieces of UI a reviewer cares about: buttons, badges, chips. So elements are now every visible node that forms one box, and `display: inline` nodes stay part of their element's own text and images.

Leaving them out went unnoticed because CSS blockifies the children of flex and grid containers: all 272 Buttons, Badges and StatusChips human-interfaces recorded on 26 Oct 2026 computed as `flex`. It surfaced when a StatusChip sat directly in a `<p>`. Its colour, copy and size changes were merged into the paragraph, whose own styles and JSX line hadn't changed, so the whole header above it was an unexplained visual change.

Two guards keep inline-level boxes that are really text out: one next to non-whitespace text is part of running text, and a parent with more than 20 atomic inline-level children is treated as text (split-text animations, KaTeX, icon fonts).

## Considered options

- **Promote inline-level nodes that paint a box** (a background, border or shadow). Rejected: whether a node is an element would depend on the very properties being compared, so a ghost button that gains a background would be a new element instead of a changed one.
- **Record every node**, `display: inline` and SVG included. Rejected for screenshots: on human-interfaces it adds 26% more leaves, about 12s on a full capture, for crops nobody reviews. Explaining changes to inline content and icons is left to atoms and parts (ADR 0015).

## Consequences

- Style queries go to leaves (ADR 0002), and a recorded chip turns the cell that held it from a leaf into a parent. On human-interfaces' 23 pages, elements rose 6% and leaves 0.1%, so captures take about as long as before.
- Elements inside a newly recorded box move under it, so the manifest version is bumped: older captures can't be compared, and each project recaptures its baseline once.
