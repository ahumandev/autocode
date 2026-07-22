// Shallow-clones GitHub repos; existing target directories are reused without network access.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { SkillLogger } from "./logger"

/** Maximum time (ms) to wait for a single git operation before aborting. */
const GIT_OPERATION_TIMEOUT_MS = 1_000

export function getCloneRoot(): string {
    return join(homedir(), ".config", "opencode", "autocode", "github")
}

export function getCloneTarget(owner: string, project: string): string {
    return join(getCloneRoot(), owner, project)
}

export function findExistingCloneTarget(owner: string, project: string): string | undefined {
    const target = getCloneTarget(owner, project)
    try {
        return existsSync(target) && statSync(target).isDirectory() ? target : undefined
    } catch {
        return undefined
    }
}

export function cloneRepo(args: { owner: string; project: string; branch?: string; logger: SkillLogger }): string {
    const { owner, project, branch, logger } = args
    const target = getCloneTarget(owner, project)

    try {
        if (findExistingCloneTarget(owner, project) !== undefined) {
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
        ], { encoding: "utf8", timeout: GIT_OPERATION_TIMEOUT_MS })

        if (result.signal === "SIGTERM" || result.error || (result.status !== null && result.status !== 0)) {
            const detail = result.signal === "SIGTERM"
                ? "timed out after " + GIT_OPERATION_TIMEOUT_MS + "ms"
                : (result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`)
            logger.log(`error: clone: ${detail}`)
            return target
        }

        logger.log(`clone: ${owner}/${project} -> ${target}`)

        if (branch) {
            const fetch = spawnSync("git", ["-C", target, "fetch", "--depth", "1", "origin", branch], { encoding: "utf8", timeout: GIT_OPERATION_TIMEOUT_MS })
            if (fetch.signal === "SIGTERM" || fetch.error || (fetch.status !== null && fetch.status !== 0)) {
                const detail = fetch.signal === "SIGTERM"
                    ? "timed out after " + GIT_OPERATION_TIMEOUT_MS + "ms"
                    : (fetch.error?.message ?? fetch.stderr?.trim() ?? `exit ${fetch.status}`)
                logger.log(`error: checkout branch ${branch}: ${detail}`)
            } else {
                const checkout = spawnSync("git", ["-C", target, "checkout", branch], { encoding: "utf8", timeout: GIT_OPERATION_TIMEOUT_MS })
                if (checkout.signal === "SIGTERM" || checkout.error || (checkout.status !== null && checkout.status !== 0)) {
                    const detail = checkout.signal === "SIGTERM"
                        ? "timed out after " + GIT_OPERATION_TIMEOUT_MS + "ms"
                        : (checkout.error?.message ?? checkout.stderr?.trim() ?? `exit ${checkout.status}`)
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
