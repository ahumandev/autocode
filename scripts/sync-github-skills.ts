import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { syncGitHubSkillInventory } from "../src/skills/github-sync"

export type GitHubSkillCacheRoots = {
    primaryCacheRoot: string
    fallbackCacheRoot: string
}

export function resolveGitHubSkillCacheRoots(repositoryRoot: string, homeDirectory: string): GitHubSkillCacheRoots {
    return {
        primaryCacheRoot: join(homeDirectory, ".cache", "autocode", "github"),
        fallbackCacheRoot: join(repositoryRoot, ".opencode", "autocode", "cache", "github"),
    }
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const arguments_ = process.argv.slice(2)
const forceRefresh = arguments_.length === 1 && arguments_[0] === "--force-refresh"

if (arguments_.length > 0 && !forceRefresh) {
    console.error(`Unknown flag: ${arguments_.join(" ")}`)
    process.exitCode = 1
} else {
    try {
        const cacheRoots = resolveGitHubSkillCacheRoots(repositoryRoot, homedir())
        await syncGitHubSkillInventory({
            manifestPath: join(repositoryRoot, "src", "skills", "github.jsonc"),
            skillsRoot: join(repositoryRoot, "src", "skills", "github"),
            cacheRoot: cacheRoots.primaryCacheRoot,
            fallbackCacheRoot: cacheRoots.fallbackCacheRoot,
            forceRefresh,
            logger: { warn: (message: string): void => console.warn(message) },
        })
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
    }
}
