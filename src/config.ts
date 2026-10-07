import fs from "node:fs";
import { existingConfig, resolvePaths, type Paths } from "./paths.js";
import { DEFAULT_SETTLE_MS } from "./stabilize.js";
import { DEFAULT_TRACKED_PROPERTIES } from "./styles.js";

export interface DiffConfig {
	/** pixelmatch per-pixel colour threshold (0-1, lower = more sensitive). */
	threshold: number;
	/** Detect & ignore anti-aliasing differences. */
	includeAA: boolean;
	/** Page is "changed" if the mismatched-pixel percentage exceeds this. */
	maxDiffPercent: number;
}

/** How per-element diffs decide which elements correspond between snapshots. */
export interface MatchConfig {
	/**
	 * Attributes that deliberately identify an element (test ids and the like),
	 * strongest first. Matched across the whole page, and a pair whose values
	 * differ is never matched, however much else agrees.
	 */
	attributes: string[];
	/**
	 * Extra regular expressions for generated `id`s to ignore, on top of the
	 * built-in list (React `useId`, Radix, MUI, ...). Generated ids change
	 * between renders, so they can't identify an element.
	 */
	ignoreIds: string[];
}

/** Style data recorded per element in per-element captures. */
export interface StylesConfig {
	/** Computed CSS properties whose changes are traced back to the declarations that set them. */
	properties: string[];
}

/**
 * How `update-pr` places screenshots. `code-first`: one comment per changed
 * line that caused visual changes, on that line. `visual-first`: one comment
 * per changed element, on its JSX line.
 */
export type PrMode = "code-first" | "visual-first";

export interface UpdatePrConfig {
	mode: PrMode;
}

/**
 * Cheat mode: carry a page over without settling or screenshotting it when its
 * render fingerprint matches the previous Version's (see
 * docs/adr/0008-cheat-mode-is-opt-in-and-validated.md).
 */
export interface CheatModeConfig {
	/** Use cheat mode by default. Only honoured while `validatedWith` matches the installed versions. */
	enabled: boolean;
	/** Attributes left out of the render fingerprint because they change between loads of the same code. */
	ignoreAttributes: string[];
	/** tunnelvision's and the framework's versions when cheat mode was shown to find exactly what normal mode does. */
	validatedWith?: Record<string, string>;
}

export interface Viewport {
	width: number;
	height: number;
}

export interface PageOverride {
	/** A JS predicate passed to shot-scraper `wait_for`. */
	waitFor?: string;
	/** Milliseconds to wait before capturing this page. */
	wait?: number;
	/** Milliseconds animations get to finish after the scroll pass on this page. */
	settle?: number;
	/** Per-page mismatch-% cutoff override. */
	maxDiffPercent?: number;
}

export interface Config {
	baseUrl: string;
	viewport: Viewport;
	/** Default milliseconds to wait before capturing each page. */
	wait: number;
	/**
	 * Milliseconds animations get to finish after the scroll pass that fires
	 * scroll-triggered reveals, before the screenshot. Raise it for pages with
	 * long JS-driven animations (framer-motion), which aren't frozen.
	 */
	settle: number;
	/** Capture at 2x (retina). Doubles image dimensions. Mutually exclusive with scaleFactor. */
	retina: boolean;
	/** Capture at a specific device-pixel scale factor (e.g. 3). Overrides retina when > 0. */
	scaleFactor?: number;
	authFile: string;
	/** Pages captured at once in per-element captures. */
	concurrency: number;
	/**
	 * Keep elements in per-element captures that paint nothing (clipped away
	 * by an ancestor's overflow or clip-path, inside a transparent ancestor, or
	 * off the page), cropped by their full box. Off by default: their crops show
	 * whatever is painted over them, so their changes are other elements'.
	 */
	includeHidden: boolean;
	diff: DiffConfig;
	match: MatchConfig;
	styles: StylesConfig;
	updatePr: UpdatePrConfig;
	cheatMode: CheatModeConfig;
	/** Optional per-page overrides keyed by URL path (e.g. "/pricing"). */
	pages?: Record<string, PageOverride>;
}

export const DEFAULT_CONFIG: Config = {
	baseUrl: "http://localhost:3000",
	viewport: { width: 1280, height: 800 },
	wait: 1000,
	settle: DEFAULT_SETTLE_MS,
	retina: false,
	authFile: ".tunnelvision/auth.json",
	concurrency: 4,
	includeHidden: false,
	diff: {
		threshold: 0.1,
		includeAA: false,
		maxDiffPercent: 0.03,
	},
	match: {
		attributes: ["data-testid", "data-test", "data-cy", "data-qa"],
		ignoreIds: [],
	},
	styles: {
		properties: DEFAULT_TRACKED_PROPERTIES,
	},
	updatePr: {
		mode: "code-first",
	},
	cheatMode: {
		enabled: false,
		ignoreAttributes: [],
	},
};

/** Deep-merge a partial config on top of defaults. */
function withDefaults(partial: Partial<Config>): Config {
	return {
		...DEFAULT_CONFIG,
		...partial,
		viewport: { ...DEFAULT_CONFIG.viewport, ...(partial.viewport ?? {}) },
		diff: { ...DEFAULT_CONFIG.diff, ...(partial.diff ?? {}) },
		match: { ...DEFAULT_CONFIG.match, ...(partial.match ?? {}) },
		styles: { ...DEFAULT_CONFIG.styles, ...(partial.styles ?? {}) },
		updatePr: { ...DEFAULT_CONFIG.updatePr, ...(partial.updatePr ?? {}) },
		cheatMode: { ...DEFAULT_CONFIG.cheatMode, ...(partial.cheatMode ?? {}) },
	};
}

export function configExists(paths: Paths): boolean {
	return existingConfig(paths) !== null;
}

/**
 * Read the config from `tunnelvision.json` at the project root, or from the
 * legacy `.tunnelvision/config.json` when only that exists (`doctor` suggests
 * the move). Missing fields take their defaults.
 */
export function loadConfig(paths: Paths): Config {
	const file = existingConfig(paths);
	if (!file) {
		throw new Error(
			`No tunnelvision config found at ${paths.config}. Run \`tunnelvision init\` first.`,
		);
	}
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (err) {
		throw new Error(`Could not read config at ${file}: ${(err as Error).message}`);
	}
	let parsed: Partial<Config>;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`Config at ${file} is not valid JSON: ${(err as Error).message}`);
	}
	return withDefaults(parsed);
}

export function saveConfig(paths: Paths, config: Config): void {
	// Default tracked properties aren't written out, so they keep up with new versions.
	const { styles, ...rest } = config;
	const saved = styles.properties === DEFAULT_CONFIG.styles.properties ? rest : config;
	fs.writeFileSync(paths.config, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
}

/**
 * Change the config file as written, leaving every setting it doesn't touch
 * (and the defaults it leaves out) alone.
 */
export function updateConfigFile(paths: Paths, change: (raw: Partial<Config>) => void): void {
	const file = existingConfig(paths) ?? paths.config;
	let raw: Partial<Config> = {};
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Config>;
	} catch {
		// start from nothing
	}
	change(raw);
	fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

/**
 * CLI flag overrides that can be layered on top of loaded config.
 * Precedence: flags > tunnelvision.json > defaults.
 */
export interface Overrides {
	baseUrl?: string;
	width?: number;
	height?: number;
	wait?: number;
	settle?: number;
	threshold?: number;
	maxDiffPercent?: number;
	retina?: boolean;
	scaleFactor?: number;
	auth?: string;
	concurrency?: number;
	/** Capture one full-page screenshot per page instead of every visible block-level element. */
	onlyPages?: boolean;
	/** Force cheat mode on or off, whatever the config says. */
	cheat?: boolean;
}

export function applyOverrides(config: Config, o: Overrides): Config {
	const next: Config = {
		...config,
		viewport: { ...config.viewport },
		diff: { ...config.diff },
		match: { ...config.match },
		styles: { ...config.styles },
		updatePr: { ...config.updatePr },
		cheatMode: { ...config.cheatMode },
	};
	if (o.baseUrl !== undefined) next.baseUrl = o.baseUrl;
	if (o.width !== undefined) next.viewport.width = o.width;
	if (o.height !== undefined) next.viewport.height = o.height;
	if (o.wait !== undefined) next.wait = o.wait;
	if (o.settle !== undefined) next.settle = o.settle;
	if (o.retina !== undefined) next.retina = o.retina;
	if (o.scaleFactor !== undefined) next.scaleFactor = o.scaleFactor;
	if (o.threshold !== undefined) next.diff.threshold = o.threshold;
	if (o.maxDiffPercent !== undefined) next.diff.maxDiffPercent = o.maxDiffPercent;
	if (o.auth !== undefined) next.authFile = o.auth;
	if (o.concurrency !== undefined) next.concurrency = o.concurrency;
	return next;
}

export { resolvePaths };
