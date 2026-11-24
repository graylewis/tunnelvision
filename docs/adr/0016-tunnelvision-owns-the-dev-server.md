---
status: proposed
---

# tunnelvision starts its own dev server on a snapshot of the code

Captures used to be taken from whatever the user had running at `baseUrl`. That server isn't tunnelvision's to control. An agent editing files mid-capture leaves some pages on old code and some on new, under one Version key. HMR reloads a page between its screenshot and its element tree. A server busy with the user's own browsing, or recompiling, slows down or drops requests. Each of these is a visual change that isn't real, or a real one that's missed, which breaks the first north star.

So for each capture, tunnelvision starts the framework's own dev server itself, on a snapshot of the code, and stops it when the capture ends.

- **Development mode, not a preview build.** React only records where each element's JSX was written (`_debugStack`) in a development build, and that's where an element's `file:line` cause comes from. A production preview build keeps CSS source maps but loses JSX locations, so element causes would fall back to component names. Development builds that are bundled (`vite build --mode development`) can't be made for Next.js.
- **The snapshot is a git worktree at `.tunnelvision/worktree`**, checked out at the commit `snapshotTree` already makes for every Version: `HEAD` for a clean tree, a commit of the working tree otherwise. Every page in a Version comes from exactly the files it's keyed to, and nothing edits the worktree while a capture runs, so nothing reloads. The sync is a commit, so capturing an arbitrary commit is the same operation (`shoot --at`).
- **The worktree persists between captures**, so the framework's on-disk caches in it (`.next`, Vite's prebundled dependencies) carry over and a capture recompiles only what changed. It's inside the project, next to the captures and git-ignored, where it's easy to find and delete. Tools that don't respect `.gitignore` will see a second copy of the app.
- **The files change under the running server.** The server starts on the files the worktree was left with, which its caches were built from. Only then is each file that differs from the commit rewritten in place, the way an editor saves, and the server gets a moment (`server.syncSettle`, 1s) to notice before pages are requested. A first version checked the commit out with the server stopped. Turbopack's persistent cache then kept serving the previous compile of `globals.css` on the next start, and on human-interfaces a planted colour change was missed outright (`probably a stale compile`). Changing the files under the running server fixed it on every change tried. Changes to the lockfile or a `package.json` are the exception: they're synced and installed before the server starts.
- **The worktree has its own `node_modules`**, installed with the project's package manager, and installed again only when the lockfile or `package.json` changes. A symlink to the user's would break Turbopack, which won't follow files outside the project root, and would share Vite's prebundle cache with the user's server.
- **Git-ignored files the app needs are copied in.** `.env*` files always are, and `server.copyIgnored` adds globs (generated clients, codegen output). A file is only written when its content changed.
- **The server is started fresh for each capture, not kept running.** A warm server between captures would hold 0.5–2 GB of memory (Next.js) for nothing most of the time. The persistent worktree's caches are what make a cold start cheap.
- **The command is detected**: the framework's own binary for Next.js, Vite and Astro, following the project's `dev` script when it only runs the framework (so `--turbopack` stays) but never its port or host. `server.command` overrides it.
- **The port is stable per project**, derived from its path into 41000–41999, falling back to the next free one, or set with `server.port`. A port that changed every run would show up in absolute URLs and render fingerprints.
- **Every page is requested once up front, all at once**, so the server compiles them in parallel instead of one capture slot at a time. Vite's entry modules are requested too, since its HTML compiles nothing. Redirects are only followed on the server's own origin: a hosted login page compiles nothing here, and on human-interfaces the extra requests tripped the auth provider's rate limit.
- **A page whose server dropped a request it needed is loaded again.** A stylesheet, script, font or image that fails at the network level, or a 5xx for one, means the page rendered without it. An overwhelmed server (Python's `http.server` resets connections past a backlog of 5) otherwise produces captures with half their styles, which show up as thousands of unexplained changes. Up to three loads, then the page fails. This applies to running servers too.
- **A server with cold caches is primed in the browser first.** After a fresh install (or a new worktree), every page is loaded once without capturing, since client code only compiles when a browser asks for it. If the server is still dropping requests after two rounds, it's restarted on the caches it just wrote. With a cold `.vite` cache, the Astro product site's dev server answered 504 for the dev toolbar's prebundled entry for as long as it ran (35 → 20 → 20 dropped requests), and after a restart, none. Before, the same cold start cost 7 of its 20 pages to Vite's mid-capture reloads.
- **Astro 7 is kept in the foreground.** When it thinks an agent started it, `astro dev` moves itself to a background process and exits, which would leave a server running on an old snapshot. `--ignore-lock` keeps it in the foreground.
- **A page that doesn't build fails the run.** A 5xx during warm-up, or the dev server's error overlay in the browser (Vite's, Astro's, Next.js's error dialog), stops the capture with the end of `.tunnelvision/server.log`, and no Version is written. A broken build is never mistaken for a visual change. This applies to external servers' error overlays too.
- **The same code isn't captured twice.** When the latest Version came from an owned server on a commit with the same git tree and was rendered alike, it stands for the new capture, and is copied under the new key when the key differs (the same files, committed). `--force` captures anyway. External servers can serve anything, so this only applies to owned ones.
- **Captures take turns.** One worktree and one port mean one capture at a time per project. A capture snapshots the working tree only once it holds the lock, so a run that waited captures the code as it is then, and the runs after it find that code already captured. A burst of reviews from an agent captures only the newest code.

## Auth

`tunnelvision auth` logs in on the user's own dev server, at `baseUrl`, where OAuth callbacks and allowlists already point. Captures carry the session over. Cookies belong to a host whatever its port, so they apply as they are. Local storage and IndexedDB belong to an origin, which includes the port, so the saved state's origin for the user's server is rewritten to the owned server's (`.tunnelvision/server/auth.json`). IndexedDB is saved now too, for libraries like Firebase that keep the session there. A session kept in the user's dev server's memory, or a token bound to its exact origin, won't carry over.

## Switching

Projects tunnelvision can start (Next.js, Vite, Astro, or any project with `server.command`) switch to an owned server with no config change. `baseUrl` keeps its name and now means the user's own dev server. `server.external` (or `--base-url` on the command line) captures a running server as before. Projects tunnelvision can't start fall back to that, and `doctor` says so.

A Version records how it was served (`meta.server`; absent means external). A diff between a Version from a running server and one from an owned server warns that the switch itself can show as visual changes. `review` offers to recapture the baseline through an owned server first (`--rebaseline` without asking), and `shoot --at <key>` does it for any Version whose files were kept.

## Considered options

- **A production preview build** (`next build && next start`, `vite preview`), cached by commit: the most stable and cacheable option, but it loses JSX locations, which means fewer causes. Rejected on reliability.
- **A development-mode bundle**: keeps JSX locations and can be cached, but Next.js has no supported way to make one and Astro only partly. Rejected as a per-framework hack.
- **A warm daemon between captures, or one shut down after an idle timeout**: faster back-to-back captures, at the cost of a second dev server's memory sitting in the background. Rejected in favour of cold starts on a cache-warm worktree.
- **Serving the live working tree with HMR off**: no copy to keep, but edits during a capture would still mix versions. Rejected.
- **The worktree outside the repository** (a user cache directory): invisible to the user's tools, but harder to find and to clean up. The user chose `.tunnelvision/worktree`.
- **A random port with the saved auth rewritten every run**: no clashes, but the port leaks into absolute URLs and fingerprints.

## Benchmark

Before (the user's own dev server, warmed up) and after, on five projects (16 Nov 2026). Each run had a baseline, three captures of unchanged code, a committed CSS change, and two captures of unchanged code with a file edited as the capture started.

| Project | Review (s) before → after | Unchanged code, changed elements before → after | Edit during a capture, changed elements before → after | Planted change traced |
| --- | --- | --- | --- | --- |
| human-interfaces (Next 16, signed in, 21 pages) | 10.3 → 14.4 | 0/0/0 → 0/0/7 | 1298/0 → 7/0 | both |
| Astro product site (Astro 6) | 30.3 → 34.2 | 2/2/2 → 2/4/6 | 716/2 → 4/2 | both |
| ASCII demo (Astro 7) | 2.8 → 3.5 | 0/0/0 → 0/0/0 | 52/0 → 0/0 | neither (no CSS source maps) |
| dashboard (Vite, live API) | 4.0 → 4.4 | 20/20/21 → 18/12/12 | 63/21 → 10/12 | both |
| wikipedia (Python `http.server`) | 30.7 → 36.6 | 6474/6323/5733 → 54/76/30 | 5060/3992 → 63/63 | both; 1045 → 0 unexplained |

A capture of unchanged code reuses the last Version in 0.3–3.6s. Each capture that does run costs 0.5–7s more than one from a warm server the user keeps running: the server starts, the files sync under it with a 1s settle, and every page compiles. On human-interfaces, the one noisy element pair after the change was a breadcrumb whose items swapped `display` between loads. The 18 unexplained changes alongside the planted change were on the billing page, in both modes.
