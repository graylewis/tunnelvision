import fs from "node:fs";
import { resolvePaths, type Paths } from "./paths.js";

export interface DiffConfig {
	/** pixelmatch per-pixel colour threshold (0-1, lower = more sensitive). */
	threshold: number;
	/** Detect & ignore anti-aliasing differences. */
	includeAA: boolean;
	/** Page is "changed" if the mismatched-pixel percentage exceeds this. */
	maxDiffPercent: number;
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
	/** Per-page mismatch-% cutoff override. */
	maxDiffPercent?: number;
}

export interface Config {
	baseUrl: string;
	viewport: Viewport;
	/** Default milliseconds to wait before capturing each page. */
	wait: number;
	/** Capture at 2x (retina). Doubles image dimensions. Mutually exclusive with scaleFactor. */
	retina: boolean;
	/** Capture at a specific device-pixel scale factor (e.g. 3). Overrides retina when > 0. */
	scaleFactor?: number;
	authFile: string;
	diff: DiffConfig;
	/** Optional per-page overrides keyed by URL path (e.g. "/pricing"). */
	pages?: Record<string, PageOverride>;
}

export const DEFAULT_CONFIG: Config = {
	baseUrl: "http://localhost:3000",
	viewport: { width: 1280, height: 800 },
	wait: 1000,
	retina: false,
	authFile: ".tunnelvision/auth.json",
	diff: {
		threshold: 0.1,
		includeAA: false,
		maxDiffPercent: 0.1,
	},
};

/** Deep-merge a partial config on top of defaults. */
function withDefaults(partial: Partial<Config>): Config {
	return {
		...DEFAULT_CONFIG,
		...partial,
		viewport: { ...DEFAULT_CONFIG.viewport, ...(partial.viewport ?? {}) },
		diff: { ...DEFAULT_CONFIG.diff, ...(partial.diff ?? {}) },
	};
}

export function configExists(paths: Paths): boolean {
	return fs.existsSync(paths.config);
}

export function loadConfig(paths: Paths): Config {
	if (!fs.existsSync(paths.config)) {
		throw new Error(
			`No tunnelvision config found at ${paths.config}. Run \`tunnelvision init\` first.`,
		);
	}
	let raw: string;
	try {
		raw = fs.readFileSync(paths.config, "utf8");
	} catch (err) {
		throw new Error(`Could not read config at ${paths.config}: ${(err as Error).message}`);
	}
	let parsed: Partial<Config>;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`Config at ${paths.config} is not valid JSON: ${(err as Error).message}`);
	}
	return withDefaults(parsed);
}

export function saveConfig(paths: Paths, config: Config): void {
	fs.mkdirSync(paths.dir, { recursive: true });
	fs.writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/**
 * CLI flag overrides that can be layered on top of loaded config.
 * Precedence: flags > config.json > defaults.
 */
export interface Overrides {
	baseUrl?: string;
	width?: number;
	height?: number;
	wait?: number;
	threshold?: number;
	maxDiffPercent?: number;
	retina?: boolean;
	scaleFactor?: number;
	auth?: string;
	/** Capture/diff every visible block-level element individually. */
	byElement?: boolean;
}

export function applyOverrides(config: Config, o: Overrides): Config {
	const next: Config = {
		...config,
		viewport: { ...config.viewport },
		diff: { ...config.diff },
	};
	if (o.baseUrl !== undefined) next.baseUrl = o.baseUrl;
	if (o.width !== undefined) next.viewport.width = o.width;
	if (o.height !== undefined) next.viewport.height = o.height;
	if (o.wait !== undefined) next.wait = o.wait;
	if (o.retina !== undefined) next.retina = o.retina;
	if (o.scaleFactor !== undefined) next.scaleFactor = o.scaleFactor;
	if (o.threshold !== undefined) next.diff.threshold = o.threshold;
	if (o.maxDiffPercent !== undefined) next.diff.maxDiffPercent = o.maxDiffPercent;
	if (o.auth !== undefined) next.authFile = o.auth;
	return next;
}

export { resolvePaths };
