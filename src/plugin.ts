import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin"
import type { AgentConfig, Config } from "@opencode-ai/sdk/v2"
import { applyExternalDirectoryPolicy, applySandboxPlatformPolicy, buildAgents } from "./agents"
import { collectExternalDirectories, loadAutocodeConfig, mergeExternalDirectoryRules } from "./config"
import type { ExternalDirectoryRules, ModelTier, TierConfig } from "./config"
import { commands } from "./commands"
import { ensureGeneratedSkills, injectGeneratedSkillsPath } from "./skills"
import { createTools } from "./tools"

type PluginAgentConfig = AgentConfig & { tier?: ModelTier }

function mergePluginAgentConfig(
    agentDef: PluginAgentConfig,
    tiers: Partial<Record<ModelTier, TierConfig>>,
    userOverride: AgentConfig | undefined,
): PluginAgentConfig {
    const { tier, ...agentBase } = agentDef
    const tierMapping = tier && tiers[tier] ? tiers[tier] : {}
    return { ...agentBase, ...tierMapping, ...userOverride } as PluginAgentConfig
}

function stripRuntimeAgentTier(agent: PluginAgentConfig): AgentConfig {
    const { tier, ...runtimeAgent } = agent
    return runtimeAgent
}

function finalizePluginAgentsAfterOverrides(
    agents: Record<string, PluginAgentConfig>,
    externalDirectories: ExternalDirectoryRules,
): Record<string, AgentConfig> {
    const externalDirectoryFinalizedAgents = applyExternalDirectoryPolicy(agents, externalDirectories)
    const sandboxFinalizedAgents = applySandboxPlatformPolicy(externalDirectoryFinalizedAgents)
    return Object.fromEntries(Object.entries(sandboxFinalizedAgents).map(([name, agent]) => [
        name,
        stripRuntimeAgentTier(agent),
    ]))
}

async function mergeConfig(cfg: Config, input: PluginInput): Promise<void> {
    const generatedSkillsPath = await ensureGeneratedSkills()

    cfg.skills = cfg.skills ?? {}
    cfg.skills.paths = injectGeneratedSkillsPath(cfg.skills.paths, generatedSkillsPath)

    const { tiers, externalDirectories } = await loadAutocodeConfig(input.worktree, input.directory)
    const nativeExternalDirectories = typeof cfg.permission === "object" && cfg.permission !== null
        ? collectExternalDirectories(cfg.permission.external_directory)
        : undefined
    const agentExternalDirectories = nativeExternalDirectories
        ? mergeExternalDirectoryRules(nativeExternalDirectories, externalDirectories)
        : externalDirectories

    if (cfg.small_model === undefined && tiers.cheap?.model) {
        cfg.small_model = tiers.cheap.model
    }

    cfg.agent = cfg.agent ?? {}
    const agents = buildAgents(agentExternalDirectories)
    const mergedAgents: Record<string, PluginAgentConfig> = {}
    for (const [name, agentDef] of Object.entries(agents)) {
        const userOverride = cfg.agent[name]
        mergedAgents[name] = mergePluginAgentConfig(agentDef, tiers, userOverride)
    }
    for (const [name, agent] of Object.entries(finalizePluginAgentsAfterOverrides(mergedAgents, agentExternalDirectories))) {
        ;(cfg.agent as Record<string, unknown>)[name] = agent
    }

    cfg.command = cfg.command ?? {}
    for (const [name, commandDef] of Object.entries(commands)) {
        cfg.command[name] = {
            ...commandDef,
            ...cfg.command[name],
        }
    }
}

const autocode: Plugin = async (input: PluginInput): Promise<Hooks> => {
    const home = process.env.HOME ?? ""
    const bunBin = `${home}/.bun/bin`
    process.env.BUN_INSTALL = `${home}/.bun`
    process.env.PATH = process.env.PATH ? `${bunBin}:${process.env.PATH}` : bunBin
    const { sandbox } = await loadAutocodeConfig(input.worktree, input.directory)

    return {
        async config(cfg: Config) {
            await mergeConfig(cfg, input)
        },

        tool: createTools(input.client, sandbox),
    }
}

export default autocode
