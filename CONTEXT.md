# tunnelvision

tunnelvision finds visual changes between versions of an app and traces each one to the line of code that caused it.

## Captures

**Version**:
One capture of every page, keyed by the git commit it was taken at (suffixed `-dirty` for uncommitted work).
_Avoid_: Snapshot, build

**Page**:
One URL from the app's file-based routes (Next.js and Astro) or, for any other app, from its sitemap, captured once per version.
_Avoid_: Route, screen

**Redirect**:
A Page whose URL lands on another Page. A Version records where it lands instead of capturing it again, and a Page that starts or stops redirecting is a visual change.
_Avoid_: Alias, duplicate page

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

**Render fingerprint**:
A hash of a Page's rendered DOM and styles and of the scripts, images and fonts it loaded, taken once it has hydrated but before it is scrolled or settled, with details known to vary between loads of the same code left out.
_Avoid_: Bundle hash (the fingerprint is of what rendered, not of what was served)

**Carried-over page**:
A Page in a Version taken whole from an earlier Version because its render fingerprint is unchanged, with its source locations brought up to date with the new commit. Only cheat mode carries pages over.
_Avoid_: Skipped page, cached page (nothing is skipped: the Version still holds the Page)

**Carried-over element**:
An element whose style data is taken from its counterpart in an earlier Version, because nothing that could decide its winning declarations changed: not its computed values, its own JSX line, any rule that matches it, nor the lines its winners were written on.
_Avoid_: Cached element

**Cheat mode**:
An opt-in way of capturing a Version in which a Page whose render fingerprint matches the previous Version's is carried over without being settled or screenshotted. A project uses it by default only once it has proven to find exactly the same visual changes and causes as the normal way.
_Avoid_: Fast mode

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
A visual change on an element whose own tracked properties didn't change, attributed to the nearest ancestor or earlier sibling that did change or is new, or to a sibling that grew, came or went inside a parent that kept its size.
_Avoid_: Displacement, side effect

**Direct effect**:
A visual change a cause explains other than as a knock-on effect: the cause reaches the element through its own winning declarations (directly, by inheritance, or via a custom property), through a selector change, or through its own JSX or text.
_Avoid_: Own change, primary change

**Origin**:
A visual change where a cause first lands: a direct effect other than by inheritance, or an inherited one where no captured ancestor is a direct effect of the same cause.
_Avoid_: Direct change, root change, primary change

**Downstream change**:
An explained visual change that is not an origin: every cause reaches it as a knock-on effect or by inheritance below an origin, and every new or removed element it's explained by, as a knock-on effect.
_Avoid_: Follow-on change, secondary change

**New element**:
An element in the target with no counterpart in the baseline. It is explained by being new, even with no cause, and so are the new elements inside it.
_Avoid_: Added change

**Removed element**:
An element in the baseline with no counterpart in the target, explained by being removed, as a new element is by being new.

**Render site**:
The JSX line of a new or removed element's parent (the baseline's parent, for a removed one), where the element was rendered (by a `.map()`, a conditional, a slot); an element with no cause is linked to it when the parent has one. It needn't be a changed line, so it is never a cause.
_Avoid_: Generator, origin, cause

**Unexplained visual change**:
A visual change with no cause among the changed lines that isn't a new or removed element or a knock-on effect of one.

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
