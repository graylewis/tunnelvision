import { createRequire } from "node:module";
import os from "node:os";
export function currentRenderer() {
    let playwright = "unknown";
    try {
        playwright = createRequire(import.meta.url)("playwright/package.json").version;
    }
    catch {
        // not installed: capture fails anyway
    }
    return { playwright, os: `${process.platform} ${os.release()} ${process.arch}` };
}
/** Why screenshots from `a` and `b` may differ with nothing changed, or null when they were rendered alike (or one isn't known). */
export function rendererDifference(a, b) {
    if (!a || !b)
        return null;
    const diffs = ["playwright", "os"].filter((k) => a[k] !== b[k]).map((k) => `${k} ${a[k]} → ${b[k]}`);
    return diffs.length ? diffs.join(", ") : null;
}
