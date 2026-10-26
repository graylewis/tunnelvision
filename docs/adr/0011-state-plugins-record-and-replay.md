---
status: proposed
---

# State plugins record each Page's state and replay it into the next Version; core decides what runs live by changed lines

Live data makes two captures of the same code look different: counts tick, feeds move, a different user's name shows. Those differences are Unexplained visual changes that no changed line could explain. A state plugin records Units of state while a Page is captured, such as one cached query each for TanStack Query, and replays them into the next capture of that Page. Then the only data that differs between Versions is data whose code changed.

## The contract

A plugin is a Node module with two hooks, run by the Node driver (ADR 0012):

- `replay(page, units)` runs before `goto`, with only the units core chose to replay, and installs whatever init scripts or routes it needs.
- `record(page)` runs after hydration, before the render fingerprint, and returns units `{ id, data, rerun }`. `rerun` is a handle to an in-page function that reproduces the unit's data. From then until the screenshot, the page must keep showing exactly what was recorded. Without that, a polled query refetched between recording and screenshot, and the first Version's screenshot disagreed with the Recording the next Version replayed: 14 changes on a commit that changed no code.

Core does everything else, so every plugin gets the same invalidation and reporting:

- **Carried forward.** A Page's Recording passes from Version to Version until the user re-records it. A new unit is recorded live and merged in. A unit the capture didn't use is dropped, so a Recording holds exactly what its capture used.
- **Live by changed lines.** After the page's capture is finished, core runs each new or live unit's `rerun` on its own under CDP precise coverage. The unit's code is the source-mapped range of every project function that ran, plus the top-level lines of the modules they're in, plus each package (name and installed version) whose code ran. A unit runs live, and is re-recorded, when the commit changed a line in its code (ranges are remapped through the diff as in ADR 0007, and a renamed file counts as changed) or changed the lockfile entry of one of its packages. Those lines are its Data causes. Otherwise it's replayed.
- **Only clean units.** Only data that loaded successfully and traced cleanly becomes a unit. Errors, pending loads and units whose `rerun` threw stay live every Version and are reported as not recorded, with the reason, so a transient failure is never frozen and nothing is replayed that invalidation can't reach.
- **The clock.** While any plugin is on, core freezes `Date` (Playwright's `clock.setFixedTime`; timers still run) at the time the Page's Recording was made, so relative times in replayed data don't drift.
- **Per page.** A Recording belongs to one Page and is stored with it, so carry-over and cheat mode move it along with the Page.
- **Before the fingerprint.** Replay finishes before the render fingerprint, and each plugin's id and version are part of the settings hash and of cheat mode's `validatedWith` (ADR 0008). Cheat mode's planted-change test gains a data-layer change that both modes must find as a Data cause.

Data causes are reported like any other Cause: in the Causes list, the inspector and `update-pr` line comments, labelled as live because code changed. A short per-page State line appears only when a unit wasn't replayed.

`tunnelvision rerecord [--page <path>] [--unit <plugin>:<key-prefix>]` re-captures the current commit's Version with the selected units live, replacing its screenshots and Recording together, since the two must agree. It produces no review.

Plugins are listed in `tunnelvision.json` as module specifiers, each optionally with options. `/setup-tunnelvision` offers the TanStack Query plugin when the project depends on it and validates it before keeping it: it captures the same commit twice and checks that the client was found, that no replayed key's data came from the network, and that no unexplained changes are left. `doctor` re-checks after upgrades.

## The TanStack Query plugin

It ships inside tunnelvision (`tunnelvision/plugins/tanstack-query`), so it can't fall out of step with the contract while the contract settles. A unit is one query, identified by its hashed query key, and `rerun` calls its `queryFn`. `replay` installs an init script on `__REACT_DEVTOOLS_GLOBAL_HOOK__`. At React's first commit, before the effects in which TanStack Query subscribes and fetches, it finds the `QueryClientProvider`'s client, cancels in-flight fetches for replayed keys, and seeds them with `setQueryData` at a fresh `dataUpdatedAt` and `staleTime: Infinity`. A Suspense query fetches during render, but React commits its fallback first, and cancelling makes it re-render from the seeded cache.

## Considered options

- **A single injected script as the plugin entry point**: rejected because an in-page script runs at one moment and can't record anything for the next Version. It also can't reach state set before the app boots, context options or the server.
- **General lifecycle hooks**: rejected for now. Plugins could break the invariants carry-over and the fingerprint rely on, and the API would be harder to keep stable.
- **Re-recording live in every Version**: rejected because every diff's data would come from a different moment.
- **Named fixtures independent of Versions**: rejected because a fixture silently misses queries added after it was recorded.
- **Comparing the live response's shape to decide what runs live**: rejected because it doubles requests, misses changes to values, and gives no changed line to blame.
- **Re-recording only when the user asks**: rejected as the only mechanism, because forgetting it silently hides a data-layer change in the PR under review.
- **Whole files, a mapping the user declares, or the module import graph as a unit's code**: rejected, respectively, because big API clients cause needless invalidation, the mapping goes stale silently, and the graph invalidates nearly everything through shared utilities.
- **Plugins finding their own files, or deciding replay versus live**: rejected because invalidation would be only as good as each plugin, and core could only report the causes plugins chose to give it.
- **Pairing units by queryFn location when keys change**: rejected because replaying data stored under an old key into a query whose meaning changed can be silently wrong. A key change brings in drift once, visibly.
- **Recording errors, or units that couldn't be traced**: rejected because both freeze things that invalidation can never reach.
- **Any lockfile change making every unit live**, or ignoring dependencies: rejected for, respectively, needless drift on every bump, and hiding client-library upgrades.
- **One Recording per Version shared by every Page**: rejected in favour of fitting per-page carry-over. The cost is that pages can disagree with each other, though each Page stays consistent with itself across Versions.
- **Plugins that can return untraced units (for clocks, flags or storage)**: rejected because it reopens the hole that tracing closes. The clock belongs to core instead.
- **Network-level replay with `page.route`**: rejected because data prefetched on the server never crosses the browser's network.
- **Turning the plugin on automatically when React Query is found**: rejected because behaviour that changes captures should be chosen, not implied.

## Consequences

- V8 reports only functions that ran, and a module's top-level code ran at import, before the trace. So a unit's code also lists every function in the files it ran, from parsing the JavaScript the browser actually ran and mapping each function's ends back to the source. Lines outside all of them are module scope. A bundler's module wrapper, which spans its whole file, counts as module scope, not as a function. A trace that finds none of the project's code is untraceable, so nothing is ever replayed that invalidation couldn't reach.
- A data cause explains a visual change only when the element's copy (or image) shows a value the unit's data gained or lost: a string of 2+ characters as written, or a number of 2+ digits however it's formatted. A changed line holding the copy takes precedence. Other unexplained changes on that page get a hint naming the unit, but no guessed cause.
- A unit that runs live because its code changed also brings in all the data drift since it was recorded, and every visual change it produces is blamed on its changed lines. Reports label these units for that reason.
- Server code is never part of a unit's code, because the trace runs in the browser. Mapping the URLs a queryFn fetched to Next.js route handlers is a possible later addition. Backends in other repos are never covered.
- `rerun` assumes queries are safe to re-run, which holds for reads. Mutations are never units.
- Recordings can hold real user data. They stay in the git-ignored `.tunnelvision/` and are never posted by `update-pr`.
- A Suspense query's request still goes out, because it starts during render, before the first commit. Its response is thrown away. So setup's validation checks that no replayed key's *data* came from the network, not that no request was sent.
- The coverage trace can't see module top-level code, because it ran at import, before the trace. A module's top-level lines are therefore derived from its source (the module minus its function bodies), not observed.
- Built in this order: the spike (done, see FINDINGS.md), then the driver port (ADR 0012), then plugins.
