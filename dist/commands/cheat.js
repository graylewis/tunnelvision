import pc from "picocolors";
import { loadConfig, updateConfigFile } from "../config.js";
import { environmentVersions, versionChanges } from "../environment.js";
import { resolvePaths } from "../paths.js";
/**
 * Turn cheat mode on or off as the project's default, or say where it stands.
 * `on` records the versions it was validated with: only do it once cheat mode
 * has found exactly what normal mode does on this project (the setup skill
 * checks that).
 */
export async function cheat(opts) {
    const paths = resolvePaths(opts.root);
    const config = loadConfig(paths);
    const current = environmentVersions(opts.root);
    if (opts.action === "on") {
        updateConfigFile(paths, (raw) => {
            raw.cheatMode = { ...config.cheatMode, ...(raw.cheatMode ?? {}), enabled: true, validatedWith: current };
        });
        console.log(pc.green("Cheat mode is now the default."));
        console.log(pc.dim(`  validated with ${Object.entries(current).map(([k, v]) => `${k} ${v}`).join(", ")}`));
        return 0;
    }
    if (opts.action === "off") {
        updateConfigFile(paths, (raw) => {
            const { validatedWith: _, ...rest } = { ...config.cheatMode, ...(raw.cheatMode ?? {}) };
            raw.cheatMode = { ...rest, enabled: false };
        });
        console.log("Cheat mode is off; captures run normally unless you pass --cheat.");
        return 0;
    }
    const { enabled, validatedWith, ignoreAttributes } = config.cheatMode;
    const changes = validatedWith ? versionChanges(validatedWith, current) : [];
    if (!enabled)
        console.log("Cheat mode: off (pass --cheat to use it for one capture)");
    else if (!validatedWith)
        console.log(pc.yellow("Cheat mode: on, but never validated, so captures run normally"));
    else if (changes.length > 0)
        console.log(pc.yellow(`Cheat mode: on, but stale (${changes.join(", ")}), so captures run normally`));
    else
        console.log(pc.green("Cheat mode: on"));
    if (ignoreAttributes.length > 0)
        console.log(pc.dim(`  ignored attributes: ${ignoreAttributes.join(", ")}`));
    return 0;
}
