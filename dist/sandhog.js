import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/**
 * sandhog, the desktop app for reviewing tunnelvision's captures, opens a
 * project at a pair of versions from a `sandhog://open?project=…&from=…&to=…`
 * link. Builds from before that link existed don't register the scheme.
 */
const BUNDLE_ID = "dev.sandhog.app";
const SCHEME = "sandhog";
function registersScheme(app) {
    try {
        const out = execFileSync("plutil", ["-extract", "CFBundleURLTypes", "json", "-o", "-", path.join(app, "Contents", "Info.plist")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const types = JSON.parse(out);
        return types.some((t) => t.CFBundleURLSchemes?.includes(SCHEME));
    }
    catch {
        return false;
    }
}
/** Path to an installed sandhog that handles `sandhog://` links, or null. macOS only. */
export function findSandhog() {
    if (process.platform !== "darwin")
        return null;
    const usual = [
        "/Applications/sandhog.app",
        path.join(os.homedir(), "Applications", "sandhog.app"),
    ].filter((p) => fs.existsSync(p));
    const found = usual.find(registersScheme);
    if (found)
        return found;
    // Installed somewhere else, or the usual copy predates links: ask Spotlight.
    try {
        const out = execFileSync("mdfind", [`kMDItemCFBundleIdentifier == "${BUNDLE_ID}"`], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 5000,
        });
        return out.split("\n").filter(Boolean).find(registersScheme) ?? null;
    }
    catch {
        return null;
    }
}
export function sandhogLink(project, from, to) {
    return `${SCHEME}://open?${new URLSearchParams({ project, from, to })}`;
}
