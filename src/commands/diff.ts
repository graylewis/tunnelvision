import pc from "picocolors";
import { applyOverrides, loadConfig, type Overrides } from "../config.js";
import { diffDir, resolvePaths, versionDir } from "../paths.js";
import { resolveVersion } from "../git.js";
import { diffVersions } from "../diffengine.js";
import { listVersions, previousVersion, versionExists } from "../versions.js";
import { printReport, writeJsonReport } from "../report.js";

export interface DiffOptions extends Overrides {
	root: string;
	/** Explicit "from" (baseline) version key. */
	from?: string;
	/** Explicit "to" (current) version key. */
	to?: string;
	/** Emit machine-readable JSON to this path (or stdout when "-"). */
	report?: string;
	json?: boolean;
}

/** Resolve which two versions to compare. */
function resolvePair(
	opts: DiffOptions,
	paths: ReturnType<typeof resolvePaths>,
): { from: string; to: string } {
	// Explicit override: diff <from> <to>
	if (opts.from && opts.to) {
		return { from: opts.from, to: opts.to };
	}

	// Default "to" is the current HEAD version.
	const to = opts.to ?? resolveVersion(paths.root).key;
	if (!versionExists(paths, to)) {
		throw new Error(
			`Version "${to}" has not been captured. Run \`tunnelvision shoot\` first, or pass explicit keys: \`tunnelvision diff <from> <to>\`.`,
		);
	}

	// Default "from" is the version captured immediately before "to".
	const prev = opts.from ?? previousVersion(paths, to)?.key;
	if (!prev) {
		const all = listVersions(paths).map((v) => v.key);
		throw new Error(
			`No previous version to diff against "${to}".` +
				(all.length ? `\nAvailable versions: ${all.join(", ")}` : ""),
		);
	}
	return { from: prev, to };
}

export async function diff(opts: DiffOptions): Promise<number> {
	const paths = resolvePaths(opts.root);
	const config = applyOverrides(loadConfig(paths), opts);

	const { from, to } = resolvePair(opts, paths);
	if (!versionExists(paths, from)) {
		throw new Error(`Baseline version "${from}" not found under ${paths.versions}.`);
	}
	if (!versionExists(paths, to)) {
		throw new Error(`Target version "${to}" not found under ${paths.versions}.`);
	}

	const report = diffVersions(
		versionDir(paths, from),
		versionDir(paths, to),
		diffDir(paths, from, to),
		config,
		{ from, to },
	);

	if (opts.json && !opts.report) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		printReport(report);
		if (report.hasChanges) {
			console.log(pc.dim(`  diff images: ${diffDir(paths, from, to)}`));
			console.log("");
		}
	}

	if (opts.report) {
		if (opts.report === "-") console.log(JSON.stringify(report, null, 2));
		else writeJsonReport(report, opts.report);
	}

	return report.hasChanges ? 1 : 0;
}
