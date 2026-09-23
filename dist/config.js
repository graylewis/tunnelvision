import fs from "node:fs";
import { resolvePaths } from "./paths.js";
export const DEFAULT_CONFIG = {
    baseUrl: "http://localhost:3000",
    viewport: { width: 1280, height: 800 },
    wait: 1000,
    retina: false,
    authFile: ".tunnelvision/auth.json",
    concurrency: 4,
    diff: {
        threshold: 0.1,
        includeAA: false,
        maxDiffPercent: 0.1,
    },
};
/** Deep-merge a partial config on top of defaults. */
function withDefaults(partial) {
    return {
        ...DEFAULT_CONFIG,
        ...partial,
        viewport: { ...DEFAULT_CONFIG.viewport, ...(partial.viewport ?? {}) },
        diff: { ...DEFAULT_CONFIG.diff, ...(partial.diff ?? {}) },
    };
}
export function configExists(paths) {
    return fs.existsSync(paths.config);
}
export function loadConfig(paths) {
    if (!fs.existsSync(paths.config)) {
        throw new Error(`No tunnelvision config found at ${paths.config}. Run \`tunnelvision init\` first.`);
    }
    let raw;
    try {
        raw = fs.readFileSync(paths.config, "utf8");
    }
    catch (err) {
        throw new Error(`Could not read config at ${paths.config}: ${err.message}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        throw new Error(`Config at ${paths.config} is not valid JSON: ${err.message}`);
    }
    return withDefaults(parsed);
}
export function saveConfig(paths, config) {
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
export function applyOverrides(config, o) {
    const next = {
        ...config,
        viewport: { ...config.viewport },
        diff: { ...config.diff },
    };
    if (o.baseUrl !== undefined)
        next.baseUrl = o.baseUrl;
    if (o.width !== undefined)
        next.viewport.width = o.width;
    if (o.height !== undefined)
        next.viewport.height = o.height;
    if (o.wait !== undefined)
        next.wait = o.wait;
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
