import { homedir } from "node:os"
import { posix, win32 } from "node:path"

export type OpenCodePathResolverDependencies = {
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
    home?: string
}

export type OpenCodePaths = {
    globalConfigRoot: string
    globalAgentsRoot: string
    globalCommandsRoot: string
    globalOpenCodeJsonPath: string
    globalOpenCodeJsoncPath: string
    globalAutocodeConfigPath: string
    globalPluginRoot: string
    globalPluginPath: (filename: string) => string
    skillsRoot: string
    generatedSkillsRoot: string
    generatedGitHubSkillsRoot: string
    learnedSkillsRoot: (agentsRoot: string) => string
}

function nonEmpty(value: string | undefined): string | undefined {
    return value === "" ? undefined : value
}

export function resolveOpenCodePaths(dependencies: OpenCodePathResolverDependencies = {}): OpenCodePaths {
    const platform = dependencies.platform ?? process.platform
    const env = dependencies.env ?? process.env
    const home = dependencies.home ?? homedir()
    const path = platform === "win32" ? win32 : posix
    const openCodeConfigDirectory = nonEmpty(env.OPENCODE_CONFIG_DIR)
    const xdgConfigHome = nonEmpty(env.XDG_CONFIG_HOME)
    const globalConfigRoot = openCodeConfigDirectory
        ?? (xdgConfigHome ? path.join(xdgConfigHome, "opencode") : path.join(home, ".config", "opencode"))
    const skillsRoot = path.join(home, ".agents", "skills")

    return {
        globalConfigRoot,
        globalAgentsRoot: path.join(globalConfigRoot, "agents"),
        globalCommandsRoot: path.join(globalConfigRoot, "commands"),
        globalOpenCodeJsonPath: path.join(globalConfigRoot, "opencode.json"),
        globalOpenCodeJsoncPath: path.join(globalConfigRoot, "opencode.jsonc"),
        globalAutocodeConfigPath: path.join(globalConfigRoot, "autocode.jsonc"),
        globalPluginRoot: path.join(globalConfigRoot, "plugins"),
        globalPluginPath: (filename: string): string => path.join(globalConfigRoot, "plugins", filename),
        skillsRoot,
        generatedSkillsRoot: path.join(skillsRoot, "autocode"),
        generatedGitHubSkillsRoot: path.join(skillsRoot, "github"),
        learnedSkillsRoot: (agentsRoot: string): string => path.join(agentsRoot, ".agents", "skills"),
    }
}
