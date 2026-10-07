import fs from "node:fs";
import { existingConfig, resolvePaths } from "./paths.js";
import { DEFAULT_SETTLE_MS } from "./stabilize.js";
import { DEFAULT_TRACKED_PROPERTIES } from "./styles.js";
export const DEFAULT_CONFIG = {
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
function withDefaults(partial) {
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
export function configExists(paths) {
    return existingConfig(paths) !== null;
}
/**
 * Read the config from `tunnelvision.json` at the project root, or from the
 * legacy `.tunnelvision/config.json` when only that exists (`doctor` suggests
 * the move). Missing fields take their defaults.
 */
export function loadConfig(paths) {
    const file = existingConfig(paths);
    if (!file) {
        throw new Error(`No tunnelvision config found at ${paths.config}. Run \`tunnelvision init\` first.`);
    }
    let raw;
    try {
        raw = fs.readFileSync(file, "utf8");
    }
    catch (err) {
        throw new Error(`Could not read config at ${file}: ${err.message}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        throw new Error(`Config at ${file} is not valid JSON: ${err.message}`);
    }
    return withDefaults(parsed);
}
export function saveConfig(paths, config) {
    // Default tracked properties aren't written out, so they keep up with new versions.
    const { styles, ...rest } = config;
    const saved = styles.properties === DEFAULT_CONFIG.styles.properties ? rest : config;
    fs.writeFileSync(paths.config, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
}
/**
 * Change the config file as written, leaving every setting it doesn't touch
 * (and the defaults it leaves out) alone.
 */
export function updateConfigFile(paths, change) {
    const file = existingConfig(paths) ?? paths.config;
    let raw = {};
    try {
        raw = JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch {
        // start from nothing
    }
    change(raw);
    fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}
export function applyOverrides(config, o) {
    const next = {
        ...config,
        viewport: { ...config.viewport },
        diff: { ...config.diff },
        match: { ...config.match },
        styles: { ...config.styles },
        updatePr: { ...config.updatePr },
        cheatMode: { ...config.cheatMode },
    };
    if (o.baseUrl !== undefined)
        next.baseUrl = o.baseUrl;
    if (o.width !== undefined)
        next.viewport.width = o.width;
    if (o.height !== undefined)
        next.viewport.height = o.height;
    if (o.wait !== undefined)
        next.wait = o.wait;
    if (o.settle !== undefined)
        next.settle = o.settle;
    if (o.retina !== undefined)
        next.retina = o.retina;
    if (o.scaleFactor !== undefined)
        next.scaleFactor = o.scaleFactor;
    if (o.threshold !== undefined)
        next.diff.threshold = o.threshold;
    if (o.maxDiffPercent !== undefined)
        next.diff.maxDiffPercent = o.maxDiffPercent;
    if (o.auth !== undefined)
        next.authFile = o.auth;
    if (o.concurrency !== undefined)
        next.concurrency = o.concurrency;
    return next;
}
export { resolvePaths };
