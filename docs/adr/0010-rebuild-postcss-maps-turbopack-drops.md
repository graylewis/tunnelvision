---
status: accepted
---

# Rebuild the PostCSS source maps Turbopack drops, while it drops them

Turbopack runs a project's PostCSS config on its CSS but throws PostCSS's source map away: `turbopack-node/src/transforms/postcss.rs` keeps only `processed_css.css`, under a `// TODO handle SourceMap`, and the map it serves is the one from before PostCSS ran. Each section of a served sheet's map therefore names the right file, but its `sourcesContent` is PostCSS's output (6,891 lines of Tailwind output for a 235-line `globals.css`), and its positions are positions in that output. Rules either got no line or a wrong one (`:root, :host` → `globals.css:5`), so a change to a hand-written rule or theme variable showed as an unexplained visual change. Utility classes lose little, since even a correct map only takes them to Tailwind's own `index.css`, which is probably why the bug goes unnoticed.

## Every map is checked, every capture

`stylemaps.ts` checks each source a stylesheet's map names: the file must be on disk, and the map's copy of it must be the file. When the copy differs, running the project's PostCSS on the file (as Turbopack's transform does: in development, the config's plugins normalised the same way, from a child process in the project root) tells why:

- the rebuild reproduces the copy byte for byte: this bug (`postcss-output`);
- it doesn't, in a plain PostCSS project: the dev server compiled an older version of the file (`stale`). Turbopack keeps serving a branch's CSS after `git checkout` until the file is edited, so this is common, and the screenshots are wrong too;
- the file is Sass, Less or Stylus, or a Turbopack loader builds the CSS: named as what can't be rebuilt;
- otherwise `unknown`.

`shoot` checks the sheets the first Page links to before capturing, so the warnings come first, and checks any sheet a later Page brings when it's read. Positions in a file whose map is broken get no line rather than a wrong one, and their rules record why, so the diff's hint for an unexplained change says which file's map is to blame. Problems are listed in the Version's `meta.json`. The check never stops a capture: telling `stale` from an unknown transform depends on knowing the project's pipeline, and stopping on a guess was too narrow to be worth it.

## The workaround is a flag setup sets

With `workarounds.turbopackPostcssMaps` on, a source whose copy the rebuild reproduced is traced through the rebuild's map: Turbopack's map takes a served position to PostCSS's output, PostCSS's map takes that to the file. It's off by default because it means running the project's build tooling outside its dev server; the check runs the rebuild either way, so with the flag off it can tell the user the flag would help. `/setup-tunnelvision` turns it on when the baseline capture reports `postcss-output`. It needs no version pinning, unlike cheat mode (ADR 0008): it only applies to a source when the rebuild reproduces the copy exactly, so once Turbopack keeps PostCSS's map nothing matches, and `shoot` says the flag can go.

## Turbopack's CSS maps only map rules, from the line before

Lightning CSS, which prints the served sheet, emits one mapping per rule, placed at the end of the previous rule (on its closing `}` line), and nothing on the rule's own lines; it also reorders declarations and moves nested `@media` and `@supports` blocks out of their rules. A lookup on a selector's or declaration's line found nothing, and one on a closing brace found the next rule. So, in a map where most lines are unmapped, a position belongs to the nearest mapping before it, which is the start of its rule in the copy; a declaration is then found by its property name inside that rule, and the rule's end by matching its braces in the copy. Precise maps (Vite, webpack) are looked up exactly as before.

## Removing it

Remove the workaround once Turbopack keeps PostCSS's source map (the TODO in `postcss.rs` resolved). The check stays: it's what finds stale compiles, and maps broken in ways this one wasn't.
