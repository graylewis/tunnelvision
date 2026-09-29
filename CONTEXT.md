# tunnelvision

tunnelvision finds visual changes between versions of an app and traces each one to the line of code that caused it.

## Captures

**Version**:
One capture of every page, keyed by the git commit it was taken at (suffixed `-dirty` for uncommitted work).
_Avoid_: Snapshot, build

**Page**:
One URL from the sitemap, captured once per version.
_Avoid_: Route, screen

**Element**:
A visible block-level DOM node in a page's element tree, paired across versions by identity rather than DOM path.
_Avoid_: Node, component

**Own text**:
The text an element renders, including its inline descendants but not the text of elements nested inside it.
_Avoid_: textContent (that includes nested elements' text)

**Tracked property**:
A computed CSS property whose value is recorded for every element, drawn from a curated set of visual properties.
_Avoid_: Style, computed style (for the whole set)

**Rule**:
A style rule the browser applied from any stylesheet, including generated ones (Tailwind utilities, CSS-in-JS), identified by its selector, declaration text and, when known, its source location.
_Avoid_: Style, class

**Winning declaration**:
The declaration that sets a tracked property on an element once the cascade is resolved, or a note that the value is inherited from an ancestor.
_Avoid_: Matched rule (a rule can match without winning anything)

## Changes

**Visual change**:
An element or page whose pixels differ between two versions, including a size mismatch.
_Avoid_: Diff (that's the image), regression

**Changed line**:
A line added or deleted in the git diff between the commits of two versions.
_Avoid_: Hunk (a hunk can hold several changed lines)

**Cause**:
A changed line that explains a visual change: a declaration, selector or custom-property definition in a stylesheet, an element's own JSX line, or a line holding the words an element's own text gained or lost (a copy cause).
_Avoid_: Culprit, source (source already means an element's JSX location)

**Knock-on effect**:
A visual change on an element whose own tracked properties didn't change, attributed to the nearest ancestor or earlier sibling that did change.
_Avoid_: Displacement, side effect

**Unexplained visual change**:
A visual change with no cause among the changed lines.

**Invisible change**:
A changed line in a stylesheet that caused no visual change on any captured element, either because it had no effect or because it wasn't exercised (a hover state, another breakpoint, a page that wasn't captured).
_Avoid_: Dead CSS (it may be live in states we don't capture)

## Review

**Code-first**:
Reviewing by changed lines: each cause gets a PR comment on that exact line, with the visual changes it caused.
_Avoid_: Top-down

**Visual-first**:
Reviewing by visual changes: each changed element gets a PR comment on its JSX line.
_Avoid_: Bottom-up

**Representative screenshot**:
The one visual change shown for a cause: the one with the most changed pixels that isn't an outlier among the cause's direct effects (knock-on effects only when it has none).
