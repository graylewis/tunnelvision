import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Desktop notifications with action buttons.
 *
 * macOS only shows buttons on notifications posted by an app bundle, so on
 * macOS a tiny Swift helper (assets/notifier.swift) is compiled on this machine
 * the first time it's needed, for its own architecture. Without a Swift
 * compiler, and on other platforms, notifications are posted without buttons.
 */
const SOURCE = fileURLToPath(new URL("../assets/notifier.swift", import.meta.url));
const BUNDLE_ID = "dev.tunnelvision.notifier";
function supportDir() {
    return path.join(os.homedir(), "Library", "Application Support", "tunnelvision");
}
function infoPlist() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
	<key>CFBundleName</key><string>tunnelvision</string>
	<key>CFBundleExecutable</key><string>tunnelvision</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>1.0</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>LSMinimumSystemVersion</key><string>11.0</string>
	<key>LSUIElement</key><true/>
</dict>
</plist>
`;
}
/**
 * True when a Swift compiler is installed. Checked by path rather than by
 * running `xcrun`, which offers to install the developer tools when they're missing.
 */
function hasSwiftc() {
    try {
        const dev = execFileSync("xcode-select", ["-p"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        return [
            path.join(dev, "usr", "bin", "swiftc"),
            path.join(dev, "Toolchains", "XcodeDefault.xctoolchain", "usr", "bin", "swiftc"),
        ].some((p) => fs.existsSync(p));
    }
    catch {
        return false;
    }
}
/**
 * Path to the notifier app, building it if it's missing or its source has
 * changed; null when it can't be built (not macOS, or no Swift compiler).
 */
export function ensureNotifier() {
    if (process.platform !== "darwin")
        return null;
    const dir = supportDir();
    const app = path.join(dir, "tunnelvision.app");
    // The stamp lives outside the bundle: extra files inside would break its signature.
    const stamp = path.join(dir, "notifier.hash");
    let source;
    try {
        source = fs.readFileSync(SOURCE);
    }
    catch {
        return null; // An install without assets/notifier.swift.
    }
    const hash = crypto.createHash("sha256").update(source).update(infoPlist()).digest("hex");
    try {
        if (fs.readFileSync(stamp, "utf8") === hash && fs.existsSync(app))
            return app;
    }
    catch {
        // Not built yet.
    }
    if (!hasSwiftc())
        return null;
    // Build next to the final location, then swap it in.
    const tmp = path.join(dir, `tunnelvision.app.${process.pid}.tmp`);
    try {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.mkdirSync(path.join(tmp, "Contents", "MacOS"), { recursive: true });
        fs.writeFileSync(path.join(tmp, "Contents", "Info.plist"), infoPlist(), "utf8");
        const arch = process.arch === "arm64" ? "arm64" : "x86_64";
        execFileSync("xcrun", [
            "swiftc",
            "-O",
            "-swift-version",
            "5",
            "-target",
            `${arch}-apple-macos11`,
            SOURCE,
            "-o",
            path.join(tmp, "Contents", "MacOS", "tunnelvision"),
        ], { stdio: "ignore" });
        execFileSync("codesign", ["--sign", "-", "--force", tmp], { stdio: "ignore" });
        fs.rmSync(app, { recursive: true, force: true });
        fs.renameSync(tmp, app);
        fs.writeFileSync(stamp, hash, "utf8");
        return app;
    }
    catch {
        fs.rmSync(tmp, { recursive: true, force: true });
        return null;
    }
}
/** A notification without buttons, for when the helper isn't available. */
function notifyPlain(n) {
    try {
        if (process.platform === "darwin") {
            const script = [
                "on run argv",
                "display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)",
                "end run",
            ];
            execFileSync("osascript", [...script.flatMap((l) => ["-e", l]), n.body, n.title, n.subtitle ?? ""], {
                stdio: "ignore",
            });
            return true;
        }
        if (process.platform === "linux") {
            execFileSync("notify-send", [n.title, n.subtitle ? `${n.subtitle}\n${n.body}` : n.body], { stdio: "ignore" });
            return true;
        }
    }
    catch {
        // No notifier available.
    }
    return false;
}
/**
 * Post a desktop notification. Returns false when nothing could be posted.
 * Buttons are dropped where the helper can't be built.
 */
export function notify(n) {
    const app = ensureNotifier();
    if (!app)
        return notifyPlain(n);
    // The helper deletes the payload once it has read it.
    const payload = path.join(os.tmpdir(), `tunnelvision-notification-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(payload, JSON.stringify({ ...n, actions: n.actions ?? [] }), "utf8");
    try {
        // Through LaunchServices (not by exec'ing the binary), or macOS won't let it notify.
        execFileSync("open", ["-n", app, "--args", payload], { stdio: "ignore" });
        return true;
    }
    catch {
        fs.rmSync(payload, { force: true });
        return notifyPlain(n);
    }
}
