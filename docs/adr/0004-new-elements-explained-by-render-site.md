---
status: accepted
---

# New and removed elements are explained without a changed line

A new element is often rendered by unchanged JSX (a `.map()` over data) and caused by a changed data line elsewhere, like an entry added to a nav array in a config file. We don't search for that line. A new or removed element is explained by being new or removed. Its cause is its own JSX line, or the line its nearest component was called from, if that line changed. Call sites further up the component chain don't count: an edited `<Layout>` line didn't add everything inside the layout. Otherwise we link it to its parent's JSX line (its render site), which may be unchanged and so is never a cause. Parents and later siblings that have no change of their own are its knock-on effects. Render sites are reported in the PR summary comment, never as inline comments.

## Considered Options

- **Search added lines for the element's text**, as the copy search does for edited text. Rejected: in the commit that prompted this ("media page v1"), 19 added lines contained "media", and the three that ranked highest (a route constant, a page-meta key, a label on the new page) were all wrong. The right line lost because it also contained other words.
- **Confirm a text match using the siblings' text on neighbouring lines.** This picked the right line in that commit, but was judged too fragile to rely on in general.
- **Resolve the rendering component's imports** to narrow which files to search. Rejected: it needs alias resolution and still can't tell two entries in the same file apart.
- **Leave such elements unexplained**, as before. Rejected: a single added list item made it and every ancestor up to `<header>` unexplained on every page.
