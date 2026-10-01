---
name: setup-tunnelvision
description: Set up tunnelvision in this project — install shot-scraper if it's missing, check where Pages come from (Next.js/Astro routes or the sitemap) and the source-map settings, run `tunnelvision init`, capture a baseline, and offer the post-commit hook. Use when the user asks to set up, install, initialise or configure tunnelvision, or to take a first baseline capture.
---

# Set up tunnelvision

Get this project from "tunnelvision is in `package.json`" to "a baseline Version is captured", fixing whatever `tunnelvision doctor` complains about on the way.

Vocabulary: a **Version** is one capture of every page, keyed by the git commit it was taken at (suffixed `-dirty` for uncommitted work). A **Page** is one URL from the app's Next.js or Astro routes, or from the sitemap. The config is `tunnelvision.json` at the project root and is committed; captures, diffs and the auth context live under `.tunnelvision/`, which is git-ignored.

Work through the steps in order. Ask the user one question at a time, only when a step needs a decision you can't make from the repo. Don't delete files or start long-running processes without asking.

## 1. Find the binary

tunnelvision runs from the project: `npx --no tunnelvision` (npm), `pnpm exec tunnelvision` or `bunx --no-install tunnelvision`, matching the lockfile. Use that form for every command below; `tunnelvision` in this file is shorthand for it.

If `node_modules/.bin/tunnelvision` doesn't exist, install it as a dev dependency with the project's package manager.

## 2. Run the doctor

```sh
tunnelvision doctor
```

It reports, one line each: `shot-scraper`, `playwright (for per-element captures)`, `config`, `git repo`, `post-commit hook`, `next.js routes`, `astro routes` or `sitemap`, and a `!` warning about CSS source maps when they're needed and off. Fix each ✗ with the matching step below, then re-run the doctor until it prints `All good.` (the `config` line stays ✗ until step 6 — that's expected). The `post-commit hook` line is informational (`·` when it isn't installed) and never fails the doctor; step 9 deals with it.

## 3. shot-scraper

tunnelvision captures through [shot-scraper](https://shot-scraper.datasette.io/) and the Playwright install next to it, found on `PATH`. If the doctor says `not found`:

1. Check for an existing install first: `command -v shot-scraper`, and whether `.venv/bin/shot-scraper` exists. A venv that exists but isn't activated is the usual cause — activate it (`source .venv/bin/activate`) in the same shell invocation as each tunnelvision command, and move on.
2. Otherwise install into a per-project venv so the versions stay matched. Prefer `uv` if it's on the machine:
   ```sh
   uv venv
   uv pip install shot-scraper 'playwright==1.52.0'
   source .venv/bin/activate
   shot-scraper install          # downloads the matching browser
   ```
   Without `uv`: `python3 -m venv .venv && source .venv/bin/activate && pip install shot-scraper 'playwright==1.52.0' && shot-scraper install`.
3. **Keep the Playwright pin.** shot-scraper 1.8 breaks on Playwright ≥ 1.53 with `TypeError: launch() got an unexpected keyword argument 'devtools'`. If that error shows up later, this is why.
4. Add `.venv/` to `.gitignore` if it isn't covered.
5. Tell the user, once, that tunnelvision uses whichever `shot-scraper` is on `PATH`, so they activate the venv before running it — a stale global install (e.g. `/usr/local/bin/shot-scraper`) would otherwise win.

Re-run the doctor: both the `shot-scraper` and `playwright` lines should now be ✓.

## 4. Sitemap

tunnelvision supports file-based routing for Next.js and Astro. In those projects it reads Pages from the route files (Next `app/` and `pages/`, Astro `src/pages/`), and the doctor prints a `next.js routes` or `astro routes` line instead of `sitemap`. Routes that need parameters (`[slug]`, `[...slug]`) are filled in from the sitemap's matching URLs if the project has exactly one sitemap. The doctor lists the dynamic routes left out, and any sitemap URLs that match no route file (rewrites, or routes injected by integrations like Starlight). If it lists some the user cares about, add concrete URLs for the dynamic routes to a sitemap as below; otherwise skip to step 5.

Everywhere else tunnelvision takes its Pages from the one `sitemap*.xml` in the project (searched recursively, skipping `node_modules`, `.git`, build dirs and dot-dirs). Only the *path* of each `<loc>` is used; the host is replaced by the base URL.

- **None found**: work out the app's routes from the framework (React Router / TanStack routes, SvelteKit `src/routes/`, or just `/` for a single-page app), show the list to the user, and write `public/sitemap.xml` (or wherever static files live):
  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>http://localhost:3000/</loc></url>
    <url><loc>http://localhost:3000/pricing</loc></url>
  </urlset>
  ```
  Leave out routes that need parameters unless the user gives concrete values, and routes behind login unless they'll set up `tunnelvision auth`.
- **More than one found**: tunnelvision refuses to guess. Show them and ask which to keep; don't delete the others yourself unless the user says so.

## 5. Best-experience checks

Neither of these blocks capture, but without them fewer visual changes can be traced to the lines that caused them. Offer each as a small change; skip if the user declines.

- **CSS source maps.** If the doctor printed `! css source maps`, the Vite (or Astro `vite:`) config processes CSS (Tailwind, PostCSS, Sass…) without them. Add `css: { devSourcemap: true }` to the Vite config.
- **React 19 in a development build.** React 19 dev builds record each element's JSX location; React 18 or a production build only give component names. Check the `react` version in `package.json` and mention it if it's older. Nothing to change here beyond making sure the base URL points at the dev server, not a production preview.

## 6. Initialise

Pick the base URL: read the dev script in `package.json` (Vite defaults to `http://localhost:5173`, Next and most Node servers to `http://localhost:3000`, Astro to `http://localhost:4321`) and confirm it with the user in one question. Then:

```sh
tunnelvision init --base-url <url>
```

`--base-url` skips the interactive prompt. init writes `tunnelvision.json` at the project root and adds `.tunnelvision/` to `.gitignore`. If `tunnelvision.json` already exists, init exits 1 and says so — keep the existing config rather than passing `--force`, unless the user wants a reset. If the doctor found a config at the old location, `.tunnelvision/config.json`, init moves it to `tunnelvision.json` with its settings intact instead of asking for a base URL.

`tunnelvision.json` is meant to be committed: it holds the settings the whole team shares (base URL, viewport, waits, per-page overrides), and `.tunnelvision/` is git-ignored because it's a local cache. Make sure no `.gitignore` rule covers `tunnelvision.json` (a broad `*.json` rule would; add `!tunnelvision.json` below it).

Defaults worth knowing (all in `tunnelvision.json`): viewport 1280×800, `wait` 1000 ms before each capture, `settle` 500 ms for animations after the scroll pass, `concurrency` 4, `diff.threshold` 0.1, `diff.maxDiffPercent` 0.03. Per-page overrides go under `pages["/path"]` (`wait`, `waitFor`, `settle`, `maxDiffPercent`). Don't tune these now; `/test-tunnelvision` finds out whether they need it.

## 7. Commit the setup

Steps 3–6 may have touched `.gitignore`, `package.json`, the sitemap and the Vite config, and created `tunnelvision.json`, which belongs in the repo. A baseline taken now would be keyed `<sha>-dirty`. tunnelvision copes with that (it snapshots the dirty tree so later diffs still find the changed lines), but a clean key is easier to reason about, so offer to commit the setup changes first. Don't commit without asking.

## 8. Capture the baseline

The app must be serving at the base URL. Check with `curl -sI <url>`; if nothing answers, ask the user to start the dev server (or whether you should start it in the background with the dev script).

Then, with the venv active if one was made:

```sh
tunnelvision shoot
```

By default this captures every visible block-level element of every Page, plus the style data that makes cause-tracing work. Expect a few seconds per page. A page that fails to load is skipped and the run exits non-zero — read the error, fix the URL or the sitemap, and re-run.

Report back:

- the Version key (`ls .tunnelvision/versions`, newest by `meta.json` `capturedAt`), and how many pages it holds (`pageCount` in that `meta.json`);
- any pages that failed;
- what was changed in the repo during setup.

## 9. Post-commit hook

tunnelvision can review every commit on its own: a git `post-commit` hook runs `tunnelvision review --notify` in the background, and a desktop notification says when the result is ready (with buttons to open it on macOS). It's opt-in, so check and ask.

The doctor's `post-commit hook` line says whether it's installed (it looks for the tunnelvision block in `.git/hooks/post-commit`). If it's `✓`, say so and move on. If it's `·  not installed`, ask the user, in one question, whether they'd like it set up: explain that each commit then starts a background review of the app at the base URL, that the commit itself isn't slowed down or blocked, and that the block can be removed from `.git/hooks/post-commit` to turn it off. If they say yes:

```sh
tunnelvision install-hook
```

If a `post-commit` hook from something else already exists, install-hook exits 1 and asks for `--force`, which appends the tunnelvision block to it without touching the rest. Show the user the existing hook and confirm before re-running with `--force`. On macOS, install-hook also builds the notifier and sends a first notification, so the permission prompt comes up now rather than after the first commit; tell the user to allow it. If they say no, don't install it, and don't ask again.

## 10. What's next

Suggest, briefly:

- `/test-tunnelvision` — makes a throwaway branch of known visual changes and checks that tunnelvision finds exactly those, catching flaky animations and slow-loading regions before they produce false positives in real reviews.
- `tunnelvision review` after the next change — captures and diffs against the previous Version in one go. With the hook installed, this happens after every commit.
