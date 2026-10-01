---
status: accepted
---

# Review notifications use a Swift helper compiled on the user's machine

Background reviews (`install-hook`) end with a desktop notification whose buttons open the result in the inspector or sandhog. macOS only shows buttons on notifications posted by an app bundle through `UNUserNotificationCenter`, so tunnelvision compiles a small helper app (`assets/notifier.swift`) with the user's own Swift compiler the first time it's needed, ad-hoc signs it, and keeps it in `~/Library/Application Support/tunnelvision/`. When the user clicks, macOS relaunches the helper, which runs the button's command itself. The review process doesn't wait around for the click.

We rejected `node-notifier`, because its bundled `terminal-notifier` is an Intel-only build and needs Rosetta on Apple Silicon. We also rejected `alerter` and `terminal-notifier` from Homebrew (an extra install for every user), `osascript display notification` (no buttons) and `display dialog` (a modal window, not a notification). We also rejected shipping a prebuilt binary, because this toolchain can't link an Intel slice and npm packages shouldn't carry native binaries that nobody can rebuild. Compiling on the user's machine needs the Command Line Tools, which most developers already have because Apple's `git` needs them. Without them, notifications fall back to `osascript` with no buttons.

The helper has to be started through LaunchServices (`open -n`), not run directly: macOS refuses notification permission to a binary that wasn't launched as an app.
