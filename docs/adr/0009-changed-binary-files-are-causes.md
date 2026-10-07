---
status: accepted
---

# A changed binary file can be a cause

Replacing an image file without touching any line that references it (overwriting `gray-lewis.png` in place) changes what the page shows, but the git diff has no changed line for it: binary files are reported as changed without lines. We let a cause be a changed binary file as well as a changed line. It explains a visual change when the file is one of the element's own images, and it is an image content cause with a path and no line. Image sources are matched to changed lines by their literal file name (ignoring query strings and build hashes), not by the words in their URL.

## Considered Options

- **Explain it only through a changed line that references the file.** Rejected: an in-place replacement changes no such line, so the commonest image update would stay unexplained.
- **Blame the unchanged line that references the file** (its import, say). Rejected: it breaks "a cause is a changed line" and can't be posted as an inline PR comment when that line isn't in the diff.
- **Match image sources by word scoring**, as the copy search does. Rejected for the reason ADR 0004 rejected it for new elements: URL words like `images`, `people` and `about` match many unrelated changed lines.

An SVG is text to git, so a changed SVG image isn't a changed binary file: its cause is the SVG's first changed line.

## Consequences

Everything that assumes a cause has a line (keying causes by path and line, inline PR comments, the inspector and sandhog) has to handle a cause with none. update-pr posts a binary file cause as a file-level review comment (`subject_type: "file"`) on the image, and counts it as outside the diff if GitHub won't take one.
