// Orchestrates parse → clone → symlink for configured external skill URLs. Returns registered skills for agent permission injection.
import type { SkillLogger } from "./logger"
import { parseGitHubSkillUrl, type ParsedGitHubSkillUrl } from "./github"
import { cloneRepo } from "./clone"
import { installSymlinks, type InstalledSkill } from "./symlink"
import type { SkillCategory, SkillsConfig } from "../config"

export type ExternalSkill = {
    category: SkillCategory
    skillName: string
    owner: string
    project: string
}

const SKILL_CATEGORIES: SkillCategory[] = ["bash", "code", "design", "test"]

export async function bootstrapExternalSkills(
    skillsConfig: SkillsConfig | undefined,
    logger: SkillLogger,
): Promise<ExternalSkill[]> {
    if (skillsConfig === undefined || typeof skillsConfig !== "object") {
        logger.log("skip bootstrap: no skills config")
        return []
    }

    logger.log("startup: bootstrap external skills")

    const results: ExternalSkill[] = []

    for (const category of SKILL_CATEGORIES) {
        const urls = skillsConfig[category] ?? []
        if (!Array.isArray(urls)) {
            logger.log(`invalid category ${category}: expected string array`)
            continue
        }

        for (const url of urls) {
            try {
                if (typeof url !== "string") {
                    logger.log(`invalid url: ${url} (not a string)`)
                    continue
                }

                const parsed: ParsedGitHubSkillUrl = parseGitHubSkillUrl(url)
                if (parsed.strategy === "invalid") {
                    logger.log(`invalid url: ${url} (${parsed.reason})`)
                    continue
                }

                const cloneTarget = cloneRepo({
                    owner: parsed.owner,
                    project: parsed.project,
                    branch: "branch" in parsed ? parsed.branch : undefined,
                    logger,
                })

                const installed: InstalledSkill[] = installSymlinks(parsed, cloneTarget, logger)

                for (const inst of installed) {
                    results.push({ category, skillName: inst.skillName, owner: inst.owner, project: inst.project })
                    logger.log(`register: ${inst.skillName} under category ${category}`)
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                logger.log(`error: bootstrap url ${url}: ${message}`)
            }
        }
    }

    logger.log(`done: registered ${results.length} external skills`)
    return results
}
