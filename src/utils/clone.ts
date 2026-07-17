// Shallow-clones a GitHub repo into ~/.config/opencode/autocode/github/{owner}/{project}. Never throws; failures are logged and the target path is still returned for partial scans.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { SkillLogger } from "./logger"

export function getCloneRoot(): string {
    return join(homedir(), ".config", "opencode", "autocode", "github")
}

export function getCloneTarget(owner: string, project: string): string {
    return join(getCloneRoot(), owner, project)
}

export function cloneRepo(args: { owner: string; project: string; branch?: string; logger: SkillLogger }): string {
    const { owner, project, branch, logger } = args
    const target = getCloneTarget(owner, project)

    try {
        if (existsSync(target) && statSync(target).isDirectory() && readdirSync(target).length > 0) {
            logger.log(`skip: already cloned ${owner}/${project}`)
            return target
        }

        const parentDir = join(getCloneRoot(), owner)
        mkdirSync(parentDir, { recursive: true })

        const result = spawnSync("git", [
            "clone",
            "--depth",
            "1",
            `https://github.com/${owner}/${project}.git`,
            target,
        ], { encoding: "utf8" })

        if (result.error || (result.status !== null && result.status !== 0)) {
            const detail = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`
            logger.log(`error: clone: ${detail}`)
            return target
        }

        logger.log(`clone: ${owner}/${project} -> ${target}`)

        if (branch) {
            const fetch = spawnSync("git", ["-C", target, "fetch", "--depth", "1", "origin", branch], { encoding: "utf8" })
            if (fetch.error || (fetch.status !== null && fetch.status !== 0)) {
                const detail = fetch.error?.message ?? fetch.stderr?.trim() ?? `exit ${fetch.status}`
                logger.log(`error: checkout branch ${branch}: ${detail}`)
            } else {
                const checkout = spawnSync("git", ["-C", target, "checkout", branch], { encoding: "utf8" })
                if (checkout.error || (checkout.status !== null && checkout.status !== 0)) {
                    const detail = checkout.error?.message ?? checkout.stderr?.trim() ?? `exit ${checkout.status}`
                    logger.log(`error: checkout branch ${branch}: ${detail}`)
                }
            }
        }

        return target
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.log(`error: clone: ${message}`)
        return target
    }
}
