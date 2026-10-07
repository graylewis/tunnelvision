# human-written docs
tunnelvision is an app that allows you to review visual changes to your git repo just like code changes. each code change is mapped
directly to the visual consequences of that change, and presented to you with screenshots of exactly what changed. 

tunnelvision is installed directly into your repo. its config is `tunnelvision.json` at the repo root, which you commit; the captures, diffs and auth context it produces are stored in `.tunnelvision`, which is git-ignored.

### steps to set up:
1. install shot-scraper, ensure that it's on your path
2. install tunnelvision into your repo.
3. ensure that you have a valid sitemap.xml or tunnelvision.json "sitemap" field. Next.js and Astro projects don't need one: their pages are read from their file-based routes (see "Where pages come from" below).
4. `npx tunnelvision init` in your repo, and commit the `tunnelvision.json` it writes.
5. `npx tunnelvision review` to create a baseline 'commit' of how your app looks.
6. whenever you want to review your changes, use `npx tunnelvision review` to create a new point-in-time, and generate a diff for you or your agent`
7. optionally, use `npx tunnelvision inspector` for a lightweight web interface.
8. install tunnelvision sandhog for a richer experience

### troubleshooting for your project:
tunnelvision relies on playwright to generate screenshots, and therefore can be a bit finicky with things like long-running animations.
by default, tunnelvision requests reduced motion from the web browser, which should prevent most issues. 
if you're still finding diffs identified where they shouldn't be, try using --wait (wait for pageload) or --settle (wait for page to settle after scrolling)

if your app is behind an auth wall, use --auth to interactively log into your app and then store your auth information for tunnelvision to use (stored in .tunnelvision, so make sure not to commit it). tunnelvision will use the auth information when screenshotting your app. 

### cheat mode
sometimes running a tunnelvision shoot (snapshot) takes too long (especially in projects that use tailwind.). my goal is that for the majority of websites, runs take less than 10 seconds. To support this, I added 'cheat mode', 
which uses code hashing to skip a lot of the lengthy processing calls where no changes were made. 

in some edge cases, cheat mode will miss some changes. mostly in cases where javascript changes the styles or DOM without user input. the setup skill will test whether cheat mode is appropriate for your project, and set this up for you.

----
# agent-written docs
## tunnelvision

Screenshot every page of your app (from its Next.js or Astro routes, or its
sitemap), version the shots by git commit, and diff them visually with [pixelmatch](https://github.com/mapbox/pixelmatch).

tunnelvision is a Node/TypeScript CLI that wraps
[shot-scraper](https://shot-scraper.datasette.io/) for capture. Install it in
your project, initialise it, and every version of your screenshots is tracked
under `.tunnelvision/`, keyed by the git commit they were taken at.

## Requirements

- **Node.js ≥ 18**
- **[shot-scraper](https://shot-scraper.datasette.io/)** on your `PATH`:
  ```bash
  # a per-project venv keeps versions matched (recommended)
  uv venv
  uv pip install shot-scraper 'playwright==1.52.0'
  source .venv/bin/activate
  shot-scraper install   # downloads the matching browser
  ```
  Run `tunnelvision doctor` to verify your setup.

  > **Version note:** shot-scraper 1.8 is incompatible with Playwright ≥ 1.53
  > (which removed the `devtools` launch argument), producing
  > `TypeError: launch() got an unexpected keyword argument 'devtools'`.
  > Pin `playwright==1.52.0` (or any `<1.53`) until shot-scraper releases a fix.
  >
  > tunnelvision runs whichever `shot-scraper` is on your `PATH`, so activate the
  > venv (`source .venv/bin/activate`) before running it — otherwise a broken
  > global install (e.g. `/usr/local/bin/shot-scraper`) may be used instead."

### For the best experience

Tracing visual changes back to the lines that caused them works best when your app provides both of the following:

- **React 19+ in a development build.** React 19 records where each element's
  JSX was written, which tunnelvision uses to find its `file:line`. React 18
  and earlier, and production builds, only give component names. See
  [React source locations](#react-source-locations).
- **CSS source maps enabled.** These map each style rule back to the line of
  source that wrote it. Plain CSS served unchanged doesn't need them, but
  PostCSS, Tailwind, Sass and CSS-in-JS do. With Vite, set
  `css: { devSourcemap: true }` in `vite.config`. See
  [Tracing changes to the lines that caused them](#tracing-changes-to-the-lines-that-caused-them).

Without them, screenshots and visual diffs still work, but fewer changes can
be traced to a cause. `tunnelvision doctor` checks the Vite source map setting.

## Install

```bash
npm install --save-dev tunnelvision   # or -g for global
```

## Quick start

```bash
tunnelvision init            # prompts for your base URL, writes tunnelvision.json (commit it)
# start your app so it's serving at the base URL, then:
tunnelvision review          # first run captures a baseline
# make a change, commit, then:
tunnelvision review          # captures again and shows a visual diff
```

### With a coding agent

tunnelvision ships two [Agent Skills](https://agentskills.io) that do the
setup and check it end to end. Install them into your project, then use them as
slash commands (or just ask for what they do):

```bash
npx tunnelvision skills      # writes .agents/skills/, links .claude/skills/ — commit both
```

One copy goes to `.agents/skills/`, which Cursor, Gemini CLI, OpenCode and
GitHub Copilot read. Claude Code only reads `.claude/skills/`, so each skill
gets a symlink there (a junction on Windows).

- **`/setup-tunnelvision`** runs `doctor`, installs shot-scraper into a venv if
  it's missing (with the Playwright pin), finds or writes a sitemap, offers the
  source-map and React settings that make cause-tracing work, runs `init` and
  captures a baseline.
- **`/test-tunnelvision`** makes a throwaway branch with a dozen known changes
  (a custom property, a padding tweak, a deleted rule, a JSX class, one word of
  copy, a removed component, …), captures and diffs it, and grades the result:
  which planted changes were found and traced to the right line, and what was
  reported that wasn't planted. It names the two usual sources of false
  positives — animations that outlast `settle`, and regions that hadn't loaded
  when one side was captured and so show up as deletions — and proposes the
  per-page `wait`, `waitFor` or `settle` overrides that fix them.

Re-run `tunnelvision skills` after upgrading to pick up new versions.

## Where pages come from

tunnelvision supports file-based routing for **Next.js** and **Astro**. A
project counts as one when it has the framework's config file
(`next.config.*`, `astro.config.*`) or depends on the framework in
`package.json`. Its pages are then read from its route files, and the sitemap
is used only to fill in dynamic routes.

| Framework | Route files | Not pages |
| --- | --- | --- |
| Next.js (App Router) | every `page.*` under `app/` (or `src/app/`) | route groups `(group)` and slots `@slot` add no URL segment; private folders `_x`, intercepting routes `(..)x` and `route.ts` handlers are skipped |
| Next.js (Pages Router) | every page file under `pages/` (or `src/pages/`), `index` mapping to its folder | `api/`, `_app`, `_document`, `_error`, `404`, `500` |
| Astro | every `.astro`, `.md`, `.mdx` and `.html` file under `src/pages/` (or `<srcDir>/pages/`), `index` mapping to its folder | `.js`/`.ts` endpoints, anything starting with `_`, `404`, `500` |

Next's `pageExtensions` and Astro's `srcDir` are read from the config when
they're written as literals. A root `app/` or `pages/` wins over the `src/`
one, as in Next.

**Dynamic routes** (`[slug]`, `[...slug]`, `[[...slug]]`, Astro's
`post-[id]`) have no URLs of their own in the files, so they're filled in with
the sitemap's matching URLs when the project has exactly one `sitemap*.xml`.
Any dynamic route with no matching URLs is left out, and `shoot`, `review` and
`doctor` say which. So do sitemap URLs that match no route file: rewrites,
redirects, and routes added by integrations (like Starlight's docs) aren't in
the route files. To capture one of those, the project has to drop back to the
sitemap. That isn't configurable yet.

Every other project takes its pages from its sitemap: tunnelvision searches
the project recursively for `sitemap*.xml` (skipping `node_modules`, `.git`,
build dirs). If it finds more than one, it stops rather than guess.

Not supported: a framework app in a subfolder of the directory tunnelvision
runs in (a monorepo's `apps/web`), and Next's `basePath`, Astro's `base` and
i18n prefixes. If you use a base path, put it in `baseUrl`.

## How it works

- **Page discovery** — Next.js and Astro projects' pages come from their
  file-based routes; everything else's from the one `sitemap*.xml`. See
  [Where pages come from](#where-pages-come-from).
- **Target URLs** — takes the *path* of each route or `<loc>` and prepends your
  configured `baseUrl` (default `http://localhost:3000`), so you screenshot local
  dev regardless of the host in the sitemap.
- **Versioning** — each capture is stored under `.tunnelvision/versions/<key>/`.
  The key is the short git SHA of `HEAD` (suffixed `-dirty` when the working tree
  has uncommitted changes), or a timestamp when you're not in a git repo.
- **Capture** — a fixed viewport (default 1280×800) guarantees identical
  dimensions so diffs are clean. A page that fails to load is skipped and the run
  exits non-zero.
- **Carry-over** — a capture reuses whatever the nearest ancestor Version
  already holds instead of reading it again, so a commit that changes one page
  costs about one page. See [Speed: carry-over and cheat mode](#speed-carry-over-and-cheat-mode).
- **Redirects** — a page that lands on another page (`/login` → `/` when
  signed out) is recorded as a redirect instead of being captured again.
  Starting or stopping redirecting shows up as one change to the page.
- **Diffing** — compares two versions with pixelmatch. Only pages present in both
  are pixel-diffed; added/removed pages are reported separately. A page counts as
  changed when its mismatched-pixel percentage exceeds `maxDiffPercent`.

## Commands

| Command | What it does |
| --- | --- |
| `tunnelvision init` | Write `tunnelvision.json` at the project root (commit it) and add `.tunnelvision/` to `.gitignore`. Moves a config from the old `.tunnelvision/config.json` location if it finds one. |
| `tunnelvision shoot` | Capture screenshots of every page for the current version. |
| `tunnelvision diff [from] [to]` | Diff two versions. Defaults to current-vs-previous. |
| `tunnelvision review` | Capture the current version, then diff it against the previous one. |
| `tunnelvision auth <url>` | Log in via a browser and save an auth context for authenticated screenshots. |
| `tunnelvision doctor` | Check shot-scraper, git, config, the post-commit hook and pages (Next.js routes or sitemap). |
| `tunnelvision clean` | Prune versions (`--keep <n>`), diffs (`--diffs`), or everything (`--all`). |
| `tunnelvision install-hook` | Install an opt-in git `post-commit` hook that runs `review` in the background and notifies you when it's done (see below). |
| `tunnelvision skills` | Install the agent skills (`/setup-tunnelvision`, `/test-tunnelvision`) into `.agents/skills/`, linked from `.claude/skills/`. |
| `tunnelvision fingerprint` | Load every page a few times and check its render fingerprint never changes; `--save` ignores attributes that vary from load to load (see cheat mode below). |
| `tunnelvision cheat [on\|off\|status]` | Make cheat mode the default (recording the versions it was validated with), stop using it, or show where it stands. |
| `tunnelvision inspector` | Open a local web UI to explore per-element diffs as a tree (see below). |
| `tunnelvision update-pr` | Comment on a GitHub PR with per-element diffs, anchored at each element's source line (see below). |

### Common options

`shoot`, `review` and `diff` accept overrides that beat config values:

```
--base-url <url>        override the base URL
--width <px> --height <px>   viewport size
--wait <ms>             wait before each capture
--settle <ms>           let animations finish after the scroll pass (default 500)
--auth <file>           auth context file
--threshold <n>         pixelmatch colour threshold (0-1)
--max-diff-percent <n>  page mismatch % cutoff for pass/fail
--only-pages            capture one screenshot per page instead of every element (see below)
--concurrency <n>       pages captured at once in per-element captures (default 4)
--cheat / --no-cheat    use cheat mode for this capture, or don't, whatever the config says
--json                  print a machine-readable report
--report <path>         write JSON report (use - for stdout)
```

## Per-element captures

By default tunnelvision captures **every visible block-level element**
individually and stores them as a directory tree that mirrors the page's DOM
hierarchy. That's what lets it trace each visual change to the line of code
that caused it.

With `--only-pages`, it captures and diffs one full-page screenshot per page
instead, through shot-scraper alone. There are no per-element diffs, style
data or causes, and the inspector and `update-pr` have nothing per element to
show:

```bash
tunnelvision shoot --only-pages
tunnelvision review --only-pages
```

How it works:

- **Single load per page** — each page is loaded once, directly through the
  Playwright install that shot-scraper uses. tunnelvision waits (`wait` /
  `waitFor`), takes a full-page screenshot, then reads the tree of every
  visible, block-level element (non-zero box, not
  `display:none`/`visibility:hidden`) from that same load. Inline wrappers and
  text nodes are flattened away so their block descendants bubble up to the
  nearest block ancestor.
- **Only what's painted** — an element's crop is the part of its box that's
  actually painted: what's left once ancestors that clip it (`overflow`,
  `clip-path`, `contain: paint`) and the page edges have cut it down. Elements
  with nothing left (clipped away entirely, inside an `opacity: 0` ancestor,
  `sr-only`, off the page) aren't recorded at all. Otherwise their crop would
  show whatever is painted over them, and changes to those layers would be
  reported as changes to the hidden element. Set `"includeHidden": true` to
  record them anyway, cropped by their full box.
- **Cropped on demand** — only the full-page screenshot and the element tree
  are stored. Each element's image is its box cropped out of that screenshot,
  so it's cut out in memory whenever it's needed (diffing, the inspector,
  `update-pr`) rather than written to disk. The crop size comes from the element's own width and height
  (rounded to whole device pixels), not from its rounded edges. That way an
  element that didn't change keeps exactly the same image size when a parent
  shifts it by a fraction of a pixel, instead of flipping between e.g. 127 and
  128px and being reported as `size-mismatch`.
- **Parallel pages** — several pages are captured at once, each in its own
  browser context (default 4; set `concurrency` in config or pass
  `--concurrency <n>`).
- **Hierarchy** — every element gets a path named after its tag (disambiguated
  by `id` or sibling index), nested exactly like the DOM, e.g.
  `header-top/h1` or `main/section-2`. A version stores three files per page:

  ```
  versions/<key>/<page>/
    page.png            # full-page screenshot; every element is cropped from it
    elements.json       # the element tree: boxes, selectors, identity, React source
    styles.json         # tracked CSS properties per element and the rules that set them
  ```

- **Per-element diffs** — `diff`/`review` walk the trees recursively, so you get
  one diff image per changed element under
  `diffs/<from>__<to>/<page>/.../element.png`. A styling tweak to a single
  component shows up as a change on just that element (plus the full page),
  instead of one big page-level diff. Diffing auto-detects the stored layout, so
  `diff` takes no flag for it: pages captured per element in both versions are
  diffed per element.

### Tracing changes to the lines that caused them

`diff`, `review`, the inspector and `update-pr` also work the other way round:
starting from the lines that changed between two versions, they find the
visual changes each line caused.

```
  Causes
    src/styles.css:7  :root { --accent: #0ea5e9 }
      → 46 elements  background-color, border-top-color, …
    src/styles.css:42  .card { padding: 24px }
      → 74 elements  padding-top, padding-right, …
    src/styles.css:47 (deleted)  .stat-value { font-size: 24px }
      → 4 elements  font-size, font-weight, line-height
    src/components/Header.jsx:6  jsx
      → 11 elements  font-size
    1 CSS line with no visible effect (1 not exercised)
```

- **At capture**, every element records the computed value of a set of
  **tracked properties** (box model, layout, colour, type, …; set
  `styles.properties` in config to change it) and, read over the Chrome
  DevTools Protocol from the same load, the **winning declaration** of each:
  the rule that set it after the cascade (`!important`, layers, inline
  styles, inheritance), and the custom properties it goes through via `var()`.
  Logical properties (`padding-inline`, Tailwind v4's `px-*`) compete with the
  physical ones they map to, by the element's `writing-mode` and `direction`.
- **Source lines** come from each stylesheet's source map, or, for CSS served
  unchanged (plain CSS, CSS Modules in Vite dev), from the file itself once
  its text is confirmed to match. With Vite and PostCSS, Tailwind or Sass, set
  `css: { devSourcemap: true }`; `doctor` checks for it.
- **At diff time**, the git diff between the two versions' captured files is
  joined against them. A property that changed on an element points at its
  winning declaration in each version: if that line (or a `var()` it uses, or
  the element's own JSX line, e.g. a `className` edit) is in the diff, it's a
  **cause**. Deleted lines are matched against the baseline, so removing a rule
  is found too. When the winning rule switches between utility classes
  (`.md:grid-cols-4` to `.md:grid-cols-2`), the classes themselves are looked
  for in changed lines outside stylesheets, so a class passed to a shared
  component is found at the call site. A value that changed under an unchanged declaration (`width:
  100%` in a wider parent) is a result of layout, not a cause.
- **Knock-on effects**: elements that moved or resized without a property of
  their own changing are attributed to the earlier sibling or ancestor that
  pushed them, and containers to the content that changed inside them.
- **Leftovers** are listed separately: **unexplained visual changes** (no
  changed line explains them) and **invisible changes**, changed CSS lines that
  changed nothing visible. Those whose rule matched no captured element at all
  (a `:hover` state, another breakpoint) are marked *not exercised*.
- **Uncommitted work**: a capture of a dirty tree snapshots it as a commit
  under `refs/tunnelvision/<key>` (your index and checkout are untouched), so it
  can still be diffed after you keep editing. `clean` removes these refs.

Versions captured before this have no `styles.json`; their changes can still be
traced to JSX lines. Re-capture them to trace CSS.

### How elements are matched between versions

Each element's folder path mirrors the DOM, but paths are *not* how elements
are paired. Inserting one `<div>` would renumber every later `div` sibling and
compare each with its neighbour. Instead, every element records the identifiers
it carries in `elements.json` (`identity`), and elements are paired by those,
strongest first. Each step runs across all elements before the next one starts:

| # | Identifier | Scope |
| --- | --- | --- |
| 1 | Configured attributes (`match.attributes`, e.g. `data-testid`), in config order | whole page |
| 2 | `id`, ignoring generated ones (React `useId`, Radix, MUI, … and `match.ignoreIds`) | whole page |
| 3 | React `key`, including the key on the component that rendered it (`<StatCard key="revenue">`) | within matched parents |
| 4 | Owning component + source file | within matched parents |
| 5 | `name` attribute (form controls) | within matched parents |
| 6 | Source `file:line:col`, a tie-breaker only (lines shift when a file is edited) | within matched parents |
| 7 | Order among siblings with the same tag, component and file | within matched parents |
| 8 | Order among siblings with the same tag | within matched parents |

- **Only unique values pair.** If a value appears more than once on either
  side (all twelve chart bars share a source line), that step skips it and a
  later one decides.
- **Deliberate identifiers veto.** If both elements carry the same configured
  attribute, or a real `id`, with *different* values, they're never paired, even
  if the React key and component agree. They show as removed + added.
- **Elements can move.** Steps 1–2 work across the whole page, so an element with
  a test id or real id is still matched after moving to another container.
  Reports say `moved from …`, and the inspector marks it *moved*.
- **Content is never used.** Text and images can move between containers, and
  they're what's being diffed.

`diff` output and the inspector show which identifier made each pair (`matched
by data-testid`, `React key`, …). Captures made before identity matching fall
back to sibling order, which pairs elements the same way path matching did.

### React source locations

If the page is rendered by React, each element in `elements.json` gets a
`component` recording where that element came from in your source.
It finds the element's React fiber and walks its `_debugOwner` chain the same
way [click-to-component](https://github.com/ericclemmons/click-to-component)
does. For locations it uses React 19's `_debugStack`, an `Error` that React
records whenever JSX is created:

1. In the browser, the first stack frame outside React is the JSX call site in
   the code the browser actually ran (e.g. a Vite-transformed module or a
   webpack/Turbopack chunk).
2. tunnelvision then fetches that script from your dev server, follows its
   `sourceMappingURL`, and maps the position back to the original file, line
   and column.

```json
{
  "tag": "section",
  "selector": "body > div:nth-of-type(1) > main:nth-of-type(1) > section:nth-of-type(2)",
  "source": { "fileName": "/…/src/Pricing.tsx", "lineNumber": 42, "columnNumber": 7, "path": "src/Pricing.tsx:42:7" },
  "components": [
    { "name": "Pricing", "source": { "…": "…", "path": "src/App.tsx:18:9" } },
    { "name": "App", "source": { "…": "…", "path": "src/main.tsx:6:3" } }
  ]
}
```

`source` is where the element's JSX was written (falling back to its nearest
ancestor with one); each entry in `components` is an owner, nearest first, with
the location it was rendered from. `path` is relative to the project root.

Line numbers require **React 19+** running a **development build** with source
maps (the default for Vite, Next.js and most dev servers). If a script has no
source map, the location in the served script is recorded instead and marked
`"generated": true`. React 18 and earlier don't record `_debugStack`, and
neither do production builds. In those cases component names are still
recorded but `source` is `null`. Elements not rendered by React get no
`component`.

> **Note:** Both versions being compared must have been captured per element
> (without `--only-pages`) for the per-element diff to line up. Captures made before
> element images were cropped on demand (with an `element.png` per element and
> no `scale` in `elements.json`) aren't matched per element; re-shoot them.

### Inspector

```bash
npx tunnelvision inspector            # http://127.0.0.1:4173
npx tunnelvision inspector --open --port 8080
npx tunnelvision inspector --open --from abc1234 --to def5678
```

Starts a local server with a single-page UI for browsing per-element diffs:

- pick any two captured versions (defaults to the two newest per-element ones);
- each page expands into its element tree; nodes are coloured by status
  (changed / added / removed / size mismatch) with mismatch % and a badge
  counting changed descendants; "changed only" and a text filter narrow it down;
- selecting an element shows its before / after / diff screenshots, selector,
  rect in both versions, an outline of where it sits on the full page, and the
  React source location and owner chain from `elements.json`, with buttons
  that open each `file:line` in Zed or VS Code, plus the lines that **caused**
  its change and its tracked properties before → after;
- the **causes** view lists the changed lines that caused visual changes,
  then unexplained visual changes and CSS changes with no visible effect.
  Selecting a cause shows its representative screenshot and every element it
  affected.

Diffs are computed when you pick a pair and diff images are written to
`diffs/<from>__<to>/`, the same as `tunnelvision diff`. Before/after element
images are cropped out of each version's `page.png` as the UI requests them. `--threshold` and
`--max-diff-percent` apply as they do there. The **threshold** field in the
header re-runs the diff at a different pixelmatch colour threshold, which is
useful when subtle, low-contrast changes (like white corners on a light grey
background) aren't being caught. Use ↑/↓ to move and ←/→ to
collapse or expand.

`--from` and `--to` pick the pair the opened page starts on. If the port is
already serving this project's inspector, `--open` opens that one instead of
starting another; if another project's inspector has it, a free port is used.

### Reviewing every commit (`install-hook`)

```bash
npx tunnelvision install-hook
```

Adds a block to `.git/hooks/post-commit` that runs `tunnelvision review --notify`
in the background after each commit, so `git commit` returns straight away. The
hook prints a notice that a review is running, its output goes to
`.tunnelvision/review.log`, and a desktop notification says when it's done:
how many elements changed, with buttons to **Open in inspector** (at that
commit against the previous capture) and, when [sandhog](../tunnelvis-sandhog)
is installed, **Open in sandhog**. A review that fails (say, your app isn't
running) sends a notification too. Reviews from quick successive commits wait
for each other and run in order.

On macOS, notification buttons need a small helper app, which tunnelvision
compiles with Swift the first time (into
`~/Library/Application Support/tunnelvision/`). `install-hook` builds it and
sends a first notification so macOS asks for permission up front. Without
Swift (`xcode-select --install`), and on Linux (`notify-send`), notifications
have no buttons. Run `install-hook` again to update a hook installed by an
older version.

The review captures whatever your app is serving when it runs, so let it finish
before editing files the app serves, or the capture may include those edits.

## Speed: carry-over and cheat mode

Reading every element's matched CSS rules over CDP is most of a capture's
cost: each `CSS.getMatchedStylesForNode` answer repeats every ancestor's rules
(Tailwind's universal rules at every level make it ~400KB), and the renderer
answers one at a time. So a capture reuses what the nearest ancestor Version
already knows: a Version under the same key, else the newest Version of the
nearest commit on `HEAD`'s first-parent history.

**Every capture (normal mode).** Each page is still loaded, settled,
screenshotted and its element tree extracted, which is cheap. An element then
keeps its previous style data when all of these hold, and only the rest are
read over CDP:

- it's paired with an element of the earlier capture (by identity, as diffs pair them);
- its tracked computed values are identical;
- its own JSX line isn't one the commit added or edited;
- no style rule the commit added, edited or deleted matches it (the rules'
  selectors are tested in the page, so a new rule that wins with the same value
  is still noticed);
- every rule its winning declarations come from can be brought up to date
  exactly: lines that shifted are moved, a line inside an edited block keeps
  its place only if its exact text is still there.

Carried data is rewritten to the new commit's line numbers, so every Version
stays correct on its own. Nothing is carried over when a lockfile changed
(installed packages may have too) or the capture settings differ.

**Cheat mode** (`--cheat`, or the configured default) goes further: once a page
has hydrated, and before it's scrolled or settled, it takes a *render
fingerprint* — the page's normalized DOM, the text of its CSS, and the bytes of
every script, stylesheet, image and font it uses — and when that matches the
earlier capture's, the whole page is carried over without a screenshot. A page
whose fingerprint differs is captured normally. Cheat mode trusts that the
same inputs render the same pixels, so it's opt-in: `/setup-tunnelvision`
plants changes and only makes it the default (`tunnelvision cheat on`) when it
finds exactly what normal mode does. The validation records tunnelvision's and
the framework's versions; when either changes, captures run normally and
`doctor` says so until it's validated again.

Things that differ between loads of the same code are left out of the
fingerprint: `<script>` elements (their code is hashed as a resource),
`?t=` HMR stamps, the order of inline style declarations, a few known dev-mode
attributes (Astro's `server-render-time`), and whatever `tunnelvision
fingerprint --save` finds (`cheatMode.ignoreAttributes`). It waits up to 5s
for entrance animations to finish first. Audio and video are identified by
their `ETag`/`Last-Modified` rather than their bytes, since they load in ranges.

On the reference Astro site (21 pages, warm dev server): a full capture takes
about 150s, a normal capture of a typical commit about 35–50s, and cheat mode
about 10–15s.

## Pull request comments (`update-pr`)

```bash
tunnelvision update-pr --dry-run      # preview the comments
tunnelvision update-pr                # push images + comment on the current branch's PR
tunnelvision update-pr --pr 12 <from> <to>
```

Annotates a GitHub pull request with the per-element diff. There are two
modes (`--mode`, or `updatePr.mode` in config):

- **`code-first`** (default): every changed line in the PR that
  [caused visual changes](#tracing-changes-to-the-lines-that-caused-them) gets
  an inline review comment on exactly that line (on the old side for deleted
  lines). It shows one representative change, the largest direct one that
  isn't an outlier, with the properties the line changed, and lists every
  other affected element. Visual changes without a cause in the diff, and
  changed lines with no visible effect, aren't posted; they're in the
  inspector.
- **`visual-first`**: every changed element whose React source line is part of
  the PR's diff gets a comment on that line. Elements that share a source
  line, like list items or chart bars, are grouped into one comment.

Comments show the essentials from the inspector (status, mismatch %, selector,
path, where it moved from, how it was matched, its rect before and after, and
the components that rendered it, linked to the PR's head) along with **before
/ after / diff** screenshots.

- **Versions**: `to` defaults to the current HEAD. `from` defaults to the
  capture at the PR's merge base with its base branch, and falls back to the
  previous capture. Line numbers come from `to`'s `elements.json`, so capture
  the PR's head commit.
- **Images** are committed to a shared orphan branch (`tunnelvision-assets`,
  override with `--branch`) under `pr-<n>/<from>__<to>/` and linked by commit
  SHA, so they render in private repos too. This uses git plumbing only, so
  your checkout and index are never touched.
- **Skipped changes**: GitHub can only anchor comments on lines inside the
  PR's diff. In visual-first mode, changes whose source line isn't in it (such
  as a CSS tweak that restyles an untouched component) are skipped and counted
  in the summary; code-first mode comments on the CSS line instead.
- **Re-running** edits the existing comments (matched by a hidden marker)
  instead of posting duplicates.
- **Auth**: needs a token with pull request write access and push access, from
  `GITHUB_TOKEN` or `GH_TOKEN`, or `gh auth token` if the
  [GitHub CLI](https://cli.github.com/) is logged in. The repository is read
  from `--remote` (default `origin`).

## Authenticated apps

```bash
tunnelvision auth https://your-app.test/login
# sign in in the browser, press <enter> in the terminal
tunnelvision shoot   # auth.json is used automatically if present
```

The auth context (`.tunnelvision/auth.json`) holds live session cookies and is
git-ignored.

## Configuration (`tunnelvision.json`)

The config lives at the project root and is meant to be committed, so everyone
(and every agent) captures the same pages the same way. Everything tunnelvision
produces goes under the git-ignored `.tunnelvision/`. A config at the previous
location, `.tunnelvision/config.json`, is still read; `tunnelvision init` moves
it to the root.

```json
{
  "baseUrl": "http://localhost:3000",
  "viewport": { "width": 1280, "height": 800 },
  "wait": 1000,
  "settle": 500,
  "authFile": ".tunnelvision/auth.json",
  "concurrency": 4,
  "includeHidden": false,
  "diff": { "threshold": 0.1, "includeAA": false, "maxDiffPercent": 0.03 },
  "match": {
    "attributes": ["data-testid", "data-test", "data-cy", "data-qa"],
    "ignoreIds": ["^tmp-"]
  },
  "styles": { "properties": ["color", "padding-top", "..."] },
  "updatePr": { "mode": "code-first" },
  "cheatMode": { "enabled": false, "ignoreAttributes": [] },
  "pages": {
    "/pricing": { "waitFor": "document.querySelector('.loaded')", "wait": 2000, "settle": 3000 }
  }
}
```

`match` controls how per-element diffs pair elements between versions (see
[How elements are matched](#how-elements-are-matched-between-versions)).
`attributes` lists deliberate identifiers, strongest first; they're recorded at
capture time, so re-shoot after changing this list. `ignoreIds` adds regular
expressions for generated ids to ignore, on top of the built-in list. It applies
at diff time, so it also affects existing captures.

`styles.properties` replaces the default list of tracked properties (leave it
out to keep the defaults, which change with new versions). It's recorded at
capture time.

`cheatMode` is managed by `tunnelvision cheat` and `tunnelvision fingerprint
--save` (see [cheat mode](#speed-carry-over-and-cheat-mode)): `enabled` makes it
the default, `validatedWith` records the versions it was validated with, and
`ignoreAttributes` lists attributes left out of the render fingerprint.

`wait` runs right after the page loads. Then tunnelvision hides framework
dev overlays (the Astro dev toolbar and the TanStack Devtools, Query Devtools
and Router Devtools floating UI), which otherwise land at a different spot in
every capture and show up as unexplained visual changes on every page. Then it
scrolls through the page to fire scroll-triggered reveals (framer-motion `whileInView`,
IntersectionObserver fade-ins, lazy images), waits `settle` for the animations
they start to finish, and freezes CSS animations and transitions before the
screenshot. Every capture also emulates `prefers-reduced-motion: reduce`, so
sites that honour it (CSS media queries, framer-motion's `useReducedMotion` or
`<MotionConfig reducedMotion="user">`) skip or shorten their animations.
JS-driven animations that ignore it, such as a plain `motion.div`, aren't
frozen, so if they're still moving at capture time (and show up as
unexplained visual changes), raise `settle` for the whole site or per page.

Precedence: **CLI flags > `tunnelvision.json` > built-in defaults**.

## CI

`diff` and `review` exit non-zero when any page changed (or was added/removed),
so they fail a build on unexpected visual changes. Use `--report results.json`
for structured output. tunnelvision assumes your app is already served at the
base URL and fails fast if it can't be reached.

## Layout

```
tunnelvision.json                   # committed config
.tunnelvision/                      # git-ignored
  auth.json                         # secret
  versions/<key>/<page>/            # page.png, elements.json, styles.json, capture.json (settings + render fingerprint)
  versions/<key>/<page>/redirect.json   # instead, for a page that lands on another page
  versions/.<key>.<pid>/            # a capture still being written; swapped in when it's done
  versions/<key>/<page>.png         # --only-pages screenshots, plus meta.json & shots.yml
  diffs/<from>__<to>/<page>.png      # pixelmatch diff images
  review.log                        # output of the last background review (install-hook)
  inspector.log                     # output of inspectors opened from notifications
```

## License

MIT
