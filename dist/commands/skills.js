import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { fileURLToPath } from "node:url";
/** The skills shipped with the package, one directory per skill holding a SKILL.md. */
const SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));
/**
 * The cross-agent location: Cursor, Gemini CLI, OpenCode and GitHub Copilot
 * read project skills from here. The Agent Skills spec itself only defines the
 * file format, not a directory.
 */
export const DEFAULT_SKILLS_TARGET = ".agents/skills";
/** Claude Code reads only this directory, but follows a symlink per skill. */
const CLAUDE_SKILLS = ".claude/skills";
/**
 * Install the package's skills into the project so `/setup-tunnelvision` and
 * `/test-tunnelvision` are available to whichever coding agent is used. One
 * copy goes to `.agents/skills/`; `.claude/skills/<name>` is a relative symlink
 * to it, since Claude Code doesn't read `.agents/` (a junction on Windows,
 * where symlinks need privileges). Existing copies are overwritten: the package
 * owns them, and re-running after an upgrade is how they're updated.
 */
export async function skills(opts) {
    let names;
    try {
        names = fs
            .readdirSync(SKILLS_DIR, { withFileTypes: true })
            .filter((e) => e.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, e.name, "SKILL.md")))
            .map((e) => e.name)
            .sort();
    }
    catch {
        console.error(pc.red(`No skills found in this install (${SKILLS_DIR}).`));
        return 1;
    }
    const targetRel = opts.dir ?? DEFAULT_SKILLS_TARGET;
    const target = path.resolve(opts.root, targetRel);
    const claude = path.resolve(opts.root, CLAUDE_SKILLS);
    const link = target !== claude;
    fs.mkdirSync(target, { recursive: true });
    if (link)
        fs.mkdirSync(claude, { recursive: true });
    for (const name of names) {
        const dest = path.join(target, name);
        fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(path.join(SKILLS_DIR, name), dest, { recursive: true });
        if (link)
            linkSkill(dest, path.join(claude, name));
    }
    const rel = (p) => path.relative(opts.root, p) || ".";
    console.log(pc.green(`✓ installed ${names.length} skill${names.length === 1 ? "" : "s"} into ${rel(target)}/`));
    for (const name of names)
        console.log(pc.dim(`  /${name}`));
    if (link) {
        console.log(pc.dim(`  ${rel(claude)}/ links to them for Claude Code${process.platform === "win32" ? " (junctions, absolute)" : ""}`));
    }
    console.log("");
    console.log(pc.dim("Commit them so everyone on the project gets them. Re-run after upgrading tunnelvision."));
    return 0;
}
/** Point `at` to the skill at `dest`, replacing whatever was there (an older copy, or a stale link). */
function linkSkill(dest, at) {
    fs.rmSync(at, { recursive: true, force: true });
    if (process.platform === "win32") {
        fs.symlinkSync(dest, at, "junction");
    }
    else {
        fs.symlinkSync(path.relative(path.dirname(at), dest), at, "dir");
    }
}
