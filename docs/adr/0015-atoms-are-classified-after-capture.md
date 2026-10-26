---
status: proposed
---

# Atoms are classified after capture, not used as a capture floor

Recording more elements (ADR 0013) explains more changes, but would bury reviewers in labels, icons and wrappers. Rather than limit capture to what a user sees as one thing, tunnelvision captures as deep as explaining changes needs, then classifies every element as an atom, a part of one, or a container (CONTEXT.md). Reports, counts, representative screenshots and PR comments are given in atoms. Parts appear only in their atom's detail, outlined on its screenshot, and containers appear for changes to their own layout, spacing or order. An atom is changed when any of its parts is, and an unexplained part makes its atom unexplained, so classification groups changes but never hides one.

An atom is the innermost element that is, in order of precedence:

1. marked with `data-tv-atom`, or a component named as an atom in config;
2. interactive (a button, link, form control or ARIA widget) and holding at most one run of text, so a card that is one big link stays a container;
3. the root of a component instance that renders no other components and holds at most one run of text, so a page component written as plain markup isn't one atom;
4. a block of text with no other text, control or marked atom inside it, so a textless component inside it (a resize handle) is its part;
5. failing all of those, an element with no atom inside it (an image, a divider), so every change belongs to an atom or a container.

Classification runs on both Versions. Where a boundary moves between them, such as a span that becomes a button, the larger atom is used, so the pair isn't split into a removal and an addition.

## Considered options

- **Atomization as a capture floor**, recording only atoms. Rejected: changes land on parts (a chip's colour, a button's icon) and on containers that hold no data (a gap or padding change), so a floor either leaves them unexplained or blames the wrong element.
- **A minimum element size.** Rejected: at 32×32 it cuts 18% of human-interfaces' leaves (about 8s off a full capture, nothing off a normal one), drops small icon buttons, and without ADR 0014 makes detection coarser.
- **Classifying in sandhog.** Rejected: the CLI summary, `update-pr` and sandhog have to count and show the same units, so classification lives in tunnelvision and its report carries each element's atom.
