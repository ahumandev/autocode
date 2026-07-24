// Symlink installer for cloned external skills. Walks a clone, finds SKILL.md dirs, and exposes them under the generated skills root.

import { existsSync, readdirSync, statSync, lstatSync, mkdirSync, symlinkSync, rmSync } from "node:fs"
import { join, basename, dirname } from "node:path"
import type { ParsedGitHubSkillUrl } from "./github"
import type { SkillLogger } from "./logger"
import { getGeneratedSkillsRoot } from "../skills/index"

const SKIP_DIRS = new Set(["node_modules", ".git"])

export type InstalledSkill = {
    category: string
    skillName: string
    owner: string
    project: string
}

function findSkillDirs(rootDir: string): string[] {
    const results: string[] = []

    function walk(dir: string): void {
        let entries: string[]
        try {
            entries = readdirSync(dir)
        } catch {
            return
        }

        try {
            if (statSync(join(dir, "SKILL.md")).isFile()) {
                results.push(dir)
            }
        } catch {
            // SKILL.md missing or unreadable; still recurse below
        }

        for (const entry of entries) {
            if (entry === "SKILL.md") continue
            if (SKIP_DIRS.has(entry)) continue
            const full = join(dir, entry)
            try {
                if (statSync(full).isDirectory()) {
                    walk(full)
                }
            } catch {
            }
        }
    }

    try {
        walk(rootDir)
    } catch {
        // Defensive: walk handles per-call errors; never throw out of findSkillDirs.
    }

    return results
}

export function installSymlinks(parsed: ParsedGitHubSkillUrl, cloneTarget: string, logger: SkillLogger): InstalledSkill[] {
    if (parsed.strategy === "invalid") {
        return []
    }

    let skillDirs: string[]
    if (parsed.strategy === "repo") {
        skillDirs = findSkillDirs(cloneTarget)
    } else if (parsed.strategy === "subtree") {
        skillDirs = findSkillDirs(join(cloneTarget, parsed.subDirs))
    } else {
        // blob or raw: exactly one skill dir
        const singleDir = join(cloneTarget, parsed.subDirs)
        try {
            if (!statSync(join(singleDir, "SKILL.md")).isFile()) {
                return []
            }
        } catch {
            return []
        }
        skillDirs = [singleDir]
    }

    const results: InstalledSkill[] = []
    const seenNames = new Map<string, string>()
    const ownerProject = `${parsed.owner}/${parsed.project}`

    for (const skillDir of skillDirs) {
        const skillName = basename(skillDir)
        const linkPath = join(getGeneratedSkillsRoot(), "github", parsed.owner, parsed.project, skillName)

        const prev = seenNames.get(skillName)
        if (prev !== undefined && prev !== ownerProject) {
            logger.log(`collision: skill ${skillName} from ${ownerProject} overrides previous ${prev}`)
        }
        seenNames.set(skillName, ownerProject)

        try {
            mkdirSync(dirname(linkPath), { recursive: true })
        } catch (error) {
            logger.log(`error: mkdir: ${skillName}: ${(error as Error).message}`)
            continue
        }

        // existsSync follows symlinks; pair with lstatSync to also detect broken links.
        let exists = existsSync(linkPath)
        if (!exists) {
            try {
                lstatSync(linkPath)
                exists = true
            } catch {
                exists = false
            }
        }

        if (exists) {
            try {
                rmSync(linkPath, { recursive: true, force: true })
                logger.log(`overwrite symlink: ${skillName}`)
            } catch (error) {
                logger.log(`error: rm: ${skillName}: ${(error as Error).message}`)
                continue
            }
        }

        try {
            symlinkSync(skillDir, linkPath, "dir")
            logger.log(`symlink: ${skillName} -> ${linkPath}`)
        } catch (error) {
            logger.log(`error: symlink: ${skillName}: ${(error as Error).message}`)
            continue
        }

        results.push({ category: "", skillName, owner: parsed.owner, project: parsed.project })
    }

    return results
}
