---
name: setup-tunnelvision
description: Set up tunnelvision in this project — install Playwright's Chromium if it's missing, check where Pages come from (Next.js/Astro routes or the sitemap) and the source-map settings, run `tunnelvision init`, capture a baseline and check its stylesheets' source maps (turning on the Turbopack PostCSS workaround when they need it), offer the post-commit hook, and test whether cheat mode finds exactly what normal captures do before making it the default. Use when the user asks to set up, install, initialise or configure tunnelvision, or to take a first baseline capture.
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

It reports, one line each: `playwright chromium`, `config`, `git repo`, `post-commit hook`, `next.js routes`, `astro routes` or `sitemap`, and a `!` warning about CSS source maps when they're needed and off, or when Turbopack runs the project's PostCSS (it drops PostCSS's maps; step 8 confirms it). Fix each ✗ with the matching step below, then re-run the doctor until it prints `All good.` (the `config` line stays ✗ until step 6 — that's expected). The `post-commit hook` line is informational (`·` when it isn't installed) and never fails the doctor; step 9 deals with it.

## 3. Playwright's Chromium

tunnelvision captures with the `playwright` package it depends on, so there's nothing to install separately except the browser. If the doctor's `playwright chromium` line is ✗, download it with the project's package manager (`npx playwright install chromium`, `pnpm exec playwright install chromium` or `bunx playwright install chromium`) and re-run the doctor.

An older setup may have left a `.venv` with shot-scraper in the project. tunnelvision no longer uses it; mention that it can be removed, but don't delete it without asking.

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

- **CSS source maps.** If the doctor printed `! css source maps` about a Vite (or Astro `vite:`) config, it processes CSS (Tailwind, PostCSS, Sass…) without them. Add `css: { devSourcemap: true }` to the Vite config. If it's about Turbopack dropping PostCSS's maps, there's nothing to change yet: the baseline capture in step 8 checks the served maps and says whether the workaround is needed.
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

Then:

```sh
tunnelvision shoot
```

By default this captures every visible block-level element of every Page, plus the style data that makes cause-tracing work. Expect a few seconds per page. A page that fails to load is skipped and the run exits non-zero — read the error, fix the URL or the sitemap, and re-run.

### Check the source maps

`shoot` checks every stylesheet's source map against the files on disk, first for the sheets the first Page links to and then for any later Pages bring, and prints `! source maps (…)` with one line per file whose map is broken (the same list is in the Version's `meta.json` under `styleMaps`). Visual changes caused by rules in those files can't be traced, so they'd show up as unexplained. Deal with each kind of line in this order, since a stale compile hides the others:

1. **`probably a stale compile`**: the dev server is serving CSS it compiled from an older version of the file (Turbopack keeps it after a `git checkout`, even across restarts). The screenshots are wrong too. Make a real edit to the named file (append a comment), wait a few seconds, undo it byte for byte, and check `git status` shows the file unchanged. Then run `tunnelvision shoot` again.
2. **`Turbopack dropped PostCSS's source map`**: Turbopack ran the project's PostCSS (Tailwind's `@tailwindcss/postcss`, say) and kept the map from before it, so the map points into the compiled CSS. tunnelvision can rebuild the map by running the project's PostCSS on the file itself. Tell the user that in one sentence, then set it in `tunnelvision.json`:
   ```json
   "workarounds": { "turbopackPostcssMaps": true }
   ```
   The baseline's rule locations were found without it, so capture it again: offer to commit `tunnelvision.json` first (otherwise the new capture is keyed `-dirty`), run `tunnelvision shoot`, and check the output now says `source map rebuilt` for each of those files and warns about none of them. If the first baseline is left under another key, offer `tunnelvision clean --keep 1` to remove it.
3. **Anything else** (no map for a project file, a missing file, Sass or a Turbopack loader, an unknown cause): there's no fix in setup. Tell the user which files, and that visual changes from them will show as unexplained.

If `shoot` says `workarounds.turbopackPostcssMaps` is on but no source map needed rebuilding, Turbopack keeps PostCSS's maps now: offer to remove the setting.

Report back:

- the Version key (`ls .tunnelvision/versions`, newest by `meta.json` `capturedAt`), and how many pages it holds (`pageCount` in that `meta.json`);
- any pages that failed;
- which stylesheets' maps were broken, and whether the workaround was turned on;
- what was changed in the repo during setup.

## 9. Post-commit hook

tunnelvision can review every commit on its own: a git `post-commit` hook runs `tunnelvision review --notify` in the background, and a desktop notification says when the result is ready (with buttons to open it on macOS). It's opt-in, so check and ask.

The doctor's `post-commit hook` line says whether it's installed (it looks for the tunnelvision block in `.git/hooks/post-commit`). If it's `✓`, say so and move on. If it's `·  not installed`, ask the user, in one question, whether they'd like it set up: explain that each commit then starts a background review of the app at the base URL, that the commit itself isn't slowed down or blocked, and that the block can be removed from `.git/hooks/post-commit` to turn it off. If they say yes:

```sh
tunnelvision install-hook
```

If a `post-commit` hook from something else already exists, install-hook exits 1 and asks for `--force`, which appends the tunnelvision block to it without touching the rest. Show the user the existing hook and confirm before re-running with `--force`. On macOS, install-hook also builds the notifier and sends a first notification, so the permission prompt comes up now rather than after the first commit; tell the user to allow it. If they say no, don't install it, and don't ask again.

## 10. Cheat mode

Cheat mode makes captures several times faster: a page whose *render fingerprint* (its DOM, CSS and the bytes of every script, image and font it uses, taken once it has hydrated) matches the previous Version's is carried over without being scrolled, settled or screenshotted. It trusts that the same inputs render the same pixels, so it only becomes the project's default once you've shown it finds exactly the same visual changes and Causes as a normal capture. Tell the user that in one sentence and ask, in one question, whether to run the check now: it takes a few minutes and makes a throwaway branch. If they say no, leave it off and move on.

1. **Fingerprints are stable.** With the app serving at the base URL:
   ```sh
   tunnelvision fingerprint --save
   ```
   It loads every page twice and compares. Attributes that changed between loads of the same code (render timings, random ids) are added to `cheatMode.ignoreAttributes` in `tunnelvision.json` and it checks again. Pages it still reports can't be carried over: `style` or `class` changing means the page was still animating or loading when fingerprinted (it waits up to 5s); `resources` names files whose bytes changed between loads. Cheat mode is still safe with a few such pages (they're just captured normally), but if most pages are unstable, stop here, leave it off and tell the user why.
2. **Plant changes.** Follow `/test-tunnelvision` steps 1–3: preconditions, the test branch and noise-floor Version (`tunnelvision shoot --no-cheat`), and the planted-changes commit with its manifest. Add rows aimed at what a fingerprint could miss, wherever the app has a place for them (say which you skipped and why):
   - **JS only**: change something only client-side JavaScript decides, such as a framer-motion `animate`/`whileInView` end state, or the markup of a component that only renders in the browser (`client:only`, `useEffect`).
   - **Image bytes**: overwrite an image in `public/` (or wherever static files live) with a visibly different image under the same file name.
   - **Font**: swap a self-hosted font file, or change an `@font-face` `font-weight`.
3. **Capture the planted commit both ways**, cheat mode first so both carry over from the noise-floor Version:
   ```sh
   tunnelvision shoot --cheat
   tunnelvision diff <noise-key> <test-key> --report .tunnelvision/cheat-report.json
   mv .tunnelvision/versions/<test-key> .tunnelvision/versions/<test-key>-cheat
   tunnelvision shoot --no-cheat
   tunnelvision diff <noise-key> <test-key> --report .tunnelvision/normal-report.json
   ```
   The cheat capture's output says how many pages it carried over; a planted change on a carried-over page is a miss.
4. **Compare the two reports.** Cheat mode passes when, for every manifest row, it reports the same changed elements (`pages[]` entries whose `status` isn't `unchanged`) and the same Causes (`correlation.causes[]`: `path`, `line`, `side`) as normal mode. Normal mode re-captures every page, so it can also report noise that cheat mode doesn't (an element still animating on a page with no planted change); confirm each such entry is noise by the signatures in `/test-tunnelvision` step 5 and leave it out. Anything a planted change caused that only normal mode reports is a failure, and so is anything only cheat mode reports.
5. **Decide.** If it passes:
   ```sh
   tunnelvision cheat on
   ```
   This records the tunnelvision, framework and dev-server versions it was validated with in `tunnelvision.json`; when any of them change, captures run normally and `tunnelvision doctor` says so until this step is repeated. Offer to commit `tunnelvision.json`. If it fails, leave cheat mode off and tell the user which planted change it missed and why that kind of change can't be fingerprinted on this app.
6. **Clean up** as in `/test-tunnelvision` step 7, also removing `.tunnelvision/versions/<test-key>-cheat` and the two reports.

## 11. What's next

Suggest, briefly:

- `/test-tunnelvision` — makes a throwaway branch of known visual changes and checks that tunnelvision finds exactly those, catching flaky animations and slow-loading regions before they produce false positives in real reviews.
- `tunnelvision review` after the next change — captures and diffs against the previous Version in one go. With the hook installed, this happens after every commit.
