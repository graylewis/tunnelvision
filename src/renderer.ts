import { createRequire } from "node:module";
import os from "node:os";

/**
 * What rendered a Version's screenshots. Two Versions rendered differently can
 * differ by scattered pixels with nothing changed, so a diff between them
 * warns instead of hiding those pixels behind a cutoff
 * (see docs/adr/0014-visual-changes-are-counted-in-pixels.md).
 */
export interface Renderer {
	/** The Playwright version, which pins the Chromium build. */
	playwright: string;
	/** `process.platform`, its release and the CPU architecture, e.g. `darwin 25.6.0 arm64`. */
	os: string;
}

export function currentRenderer(): Renderer {
	let playwright = "unknown";
	try {
		playwright = (createRequire(import.meta.url)("playwright/package.json") as { version: string }).version;
	} catch {
		// not installed: capture fails anyway
	}
	return { playwright, os: `${process.platform} ${os.release()} ${process.arch}` };
}

/** Why screenshots from `a` and `b` may differ with nothing changed, or null when they were rendered alike (or one isn't known). */
export function rendererDifference(a: Renderer | undefined, b: Renderer | undefined): string | null {
	if (!a || !b) return null;
	const diffs = (["playwright", "os"] as const).filter((k) => a[k] !== b[k]).map((k) => `${k} ${a[k]} → ${b[k]}`);
	return diffs.length ? diffs.join(", ") : null;
}
