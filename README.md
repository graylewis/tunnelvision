# tunnelvision

Screenshot every page of your app from its sitemap, version the shots by git
commit, and diff them visually with [pixelmatch](https://github.com/mapbox/pixelmatch).

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

## Install

```bash
npm install --save-dev tunnelvision   # or -g for global
```

## Quick start

```bash
tunnelvision init            # prompts for your base URL, writes .tunnelvision/config.json
# start your app so it's serving at the base URL, then:
tunnelvision review          # first run captures a baseline
# make a change, commit, then:
tunnelvision review          # captures again and shows a visual diff
```

## How it works

- **Sitemap discovery** — recursively searches the project for `sitemap*.xml`
  (skipping `node_modules`, `.git`, build dirs). If more than one is found it
  errors so nothing is guessed.
- **Target URLs** — takes the *path* of each `<loc>` and prepends your configured
  `baseUrl` (default `http://localhost:3000`), so you screenshot local dev
  regardless of the host in the sitemap.
- **Versioning** — each capture is stored under `.tunnelvision/versions/<key>/`.
  The key is the short git SHA of `HEAD` (suffixed `-dirty` when the working tree
  has uncommitted changes), or a timestamp when you're not in a git repo.
- **Capture** — a fixed viewport (default 1280×800) guarantees identical
  dimensions so diffs are clean. A page that fails to load is skipped and the run
  exits non-zero.
- **Diffing** — compares two versions with pixelmatch. Only pages present in both
  are pixel-diffed; added/removed pages are reported separately. A page counts as
  changed when its mismatched-pixel percentage exceeds `maxDiffPercent`.

## Commands

| Command | What it does |
| --- | --- |
| `tunnelvision init` | Scaffold `.tunnelvision/config.json` and add `.tunnelvision/` to `.gitignore`. |
| `tunnelvision shoot` | Capture screenshots of every page for the current version. |
| `tunnelvision diff [from] [to]` | Diff two versions. Defaults to current-vs-previous. |
| `tunnelvision review` | Capture the current version, then diff it against the previous one. |
| `tunnelvision auth <url>` | Log in via a browser and save an auth context for authenticated screenshots. |
| `tunnelvision doctor` | Check shot-scraper, git, config and sitemap. |
| `tunnelvision clean` | Prune versions (`--keep <n>`), diffs (`--diffs`), or everything (`--all`). |
| `tunnelvision install-hook` | Install an opt-in git `post-commit` hook that runs `review`. |

### Common options

`shoot`, `review` and `diff` accept overrides that beat config values:

```
--base-url <url>        override the base URL
--width <px> --height <px>   viewport size
--wait <ms>             wait before each capture
--auth <file>           auth context file
--threshold <n>         pixelmatch colour threshold (0-1)
--max-diff-percent <n>  page mismatch % cutoff for pass/fail
--by-element            capture/diff every element individually (see below)
--json                  print a machine-readable report
--report <path>         write JSON report (use - for stdout)
```

## Per-element captures (`--by-element`)

By default tunnelvision captures and diffs one full-page screenshot per page.
With `--by-element`, it instead captures **every visible block-level element**
individually and stores them as a directory tree that mirrors the page's DOM
hierarchy:

```bash
tunnelvision shoot --by-element
tunnelvision review --by-element
tunnelvision diff --by-element <from> <to>
```

How it works:

- **Element discovery** — for each page, tunnelvision asks the browser (via
  `shot-scraper javascript`) for a tree of every visible, block-level element
  (non-zero box, not `display:none`/`visibility:hidden`). Inline wrappers and
  text nodes are flattened away so their block descendants bubble up to the
  nearest block ancestor.
- **Isolated capture** — each element is re-captured on its own with
  shot-scraper's `selector` support, using a stable `nth-of-type` CSS selector.
- **Hierarchy on disk** — every element becomes a directory named after its tag
  (disambiguated by `id` or sibling index), nested exactly like the DOM. The
  element's own screenshot is `element.png` inside that directory; a full-page
  `page.png` and an `elements.json` manifest sit at the page root:

  ```
  versions/<key>/<page>/
    page.png            # full-page screenshot (context)
    elements.json       # the extracted element tree + selectors
    header-top/
      element.png       # <header id="top"> on its own
      h1/element.png
    main/
      element.png
      section-1/element.png
      section-2/element.png
  ```

- **Per-element diffs** — `diff`/`review` walk the trees recursively, so you get
  one diff image per changed element under
  `diffs/<from>__<to>/<page>/.../element.png`. A styling tweak to a single
  component shows up as a change on just that element (plus the full page),
  instead of one big page-level diff. Diffing auto-detects the stored layout, so
  `--by-element` on `diff` is optional as long as both versions were captured
  that way.

> **Note:** "every element" can mean a lot of screenshots on a large page, and
> each one is a separate capture, so `--by-element` runs are slower than a
> single full-page shot. Both versions being compared must have been captured
> with `--by-element` for the per-element diff to line up.

## Authenticated apps

```bash
tunnelvision auth https://your-app.test/login
# sign in in the browser, press <enter> in the terminal
tunnelvision shoot   # auth.json is used automatically if present
```

The auth context (`.tunnelvision/auth.json`) holds live session cookies and is
git-ignored.

## Configuration (`.tunnelvision/config.json`)

```json
{
  "baseUrl": "http://localhost:3000",
  "viewport": { "width": 1280, "height": 800 },
  "wait": 1000,
  "authFile": ".tunnelvision/auth.json",
  "diff": { "threshold": 0.1, "includeAA": false, "maxDiffPercent": 0.1 },
  "pages": {
    "/pricing": { "waitFor": "document.querySelector('.loaded')", "wait": 2000 }
  }
}
```

Precedence: **CLI flags > `config.json` > built-in defaults**.

## CI

`diff` and `review` exit non-zero when any page changed (or was added/removed),
so they fail a build on unexpected visual changes. Use `--report results.json`
for structured output. tunnelvision assumes your app is already served at the
base URL and fails fast if it can't be reached.

## Layout

```
.tunnelvision/
  config.json
  auth.json                         # git-ignored secret
  versions/<key>/<page>.png         # screenshots, plus meta.json & shots.yml
  diffs/<from>__<to>/<page>.png      # pixelmatch diff images
```

## License

MIT
