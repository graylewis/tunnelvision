---
status: accepted
---

# The config is `tunnelvision.json` at the project root, and is committed

tunnelvision's settings (base URL, viewport, waits, per-page overrides, matching attributes) describe how a project is captured, so everyone and every agent working on the project should run with the same ones. They live in `tunnelvision.json` at the project root, next to `package.json`, and are committed. Everything tunnelvision produces (Versions, diffs, the auth context, review logs) stays under `.tunnelvision/`, which `init` git-ignores.

Before this the config was `.tunnelvision/config.json`, inside the git-ignored directory, so every clone started from the defaults and per-page tuning done by `/test-tunnelvision` was lost. We rejected un-ignoring that one file with a `!.tunnelvision/config.json` rule: it's easy to break with a broader rule, and a committed file in a directory that is otherwise a local cache is a surprise. A root-level `tunnelvision.json` matches the convention tools like TypeScript, Biome and Playwright follow, and the README had already been calling it that.

The old location is still read when the root file is missing, and `tunnelvision init` moves it to the root with its settings intact, so existing projects don't start over.
