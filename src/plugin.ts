import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin"
import type { AgentConfig, Config } from "@opencode-ai/sdk/v2"
import { applyExternalDirectoryPolicy, applySandboxPlatformPolicy, buildAgents, type AutocodeAgentConfig } from "./agents"
import { collectExternalDirectories, loadAutocodeConfig, mergeExternalDirectoryRules } from "./config"
import type { ExternalDirectoryRules, ModelTier, TierConfig } from "./config"
import { commands } from "./commands"
import { ensureGeneratedSkills, injectGeneratedSkillsPath } from "./skills"
import { createTools } from "./tools"
import type { SandboxPlatformSupportOptions } from "@/utils/sandbox"

type PluginAgentConfig = AutocodeAgentConfig
type PluginInputWithSandboxSupportOverride = PluginInput & {
    sandboxSupportOverride?: SandboxPlatformSupportOptions
    serverUrl?: URL
}

function mergePluginAgentConfig(
    agentDef: PluginAgentConfig,
    tiers: Partial<Record<ModelTier, TierConfig>>,
    userOverride: AgentConfig | undefined,
): PluginAgentConfig {
    const { tier, ...agentBase } = agentDef
    const tierMapping = tier && tiers[tier] ? tiers[tier] : {}
    return { ...agentBase, ...tierMapping, ...userOverride }
}

function stripRuntimeAgentTier(agent: PluginAgentConfig): Omit<PluginAgentConfig, "tier"> {
    const { tier, ...runtimeAgent } = agent
    return runtimeAgent
}

function preparePluginAgentsAfterOverrides(
    agents: Record<string, PluginAgentConfig>,
    externalDirectories: ExternalDirectoryRules,
    sandboxSupportOverride?: SandboxPlatformSupportOptions,
): Record<string, Omit<PluginAgentConfig, "tier">> {
    const externalDirectoryFinalizedAgents = applyExternalDirectoryPolicy(agents, externalDirectories)
    const sandboxFinalizedAgents = applySandboxPlatformPolicy(externalDirectoryFinalizedAgents, sandboxSupportOverride ?? {})
    return Object.fromEntries(Object.entries(sandboxFinalizedAgents).map(([name, agent]) => [
        name,
        stripRuntimeAgentTier(agent),
    ]))
}

async function mergeConfig(cfg: Config, input: PluginInputWithSandboxSupportOverride): Promise<void> {
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
    const agents = buildAgents(agentExternalDirectories, input.sandboxSupportOverride)
    const mergedAgents: Record<string, PluginAgentConfig> = {}
    for (const [name, agentDef] of Object.entries(agents)) {
        const userOverride = cfg.agent[name]
        mergedAgents[name] = mergePluginAgentConfig(agentDef, tiers, userOverride)
    }
    for (const [name, agent] of Object.entries(preparePluginAgentsAfterOverrides(
        mergedAgents,
        agentExternalDirectories,
        input.sandboxSupportOverride,
    ))) {
        ;(cfg.agent as Record<string, unknown>)[name] = agent
    }

    cfg.command = cfg.command ?? {}
    const mergedCommandCache = new WeakMap<object, NonNullable<Config["command"]>[string]>()
    for (const [name, commandDef] of Object.entries(commands)) {
        const userOverride = cfg.command[name]
        if (userOverride === undefined) {
            const cachedCommand = mergedCommandCache.get(commandDef)
            const mergedCommand = cachedCommand ?? { ...commandDef }
            mergedCommandCache.set(commandDef, mergedCommand)
            cfg.command[name] = mergedCommand
            continue
        }
        cfg.command[name] = { ...commandDef, ...userOverride }
    }
}

const autocode: Plugin = async (input: PluginInput): Promise<Hooks> => {
    const pluginInput = input as PluginInputWithSandboxSupportOverride
    const home = process.env.HOME ?? ""
    const bunBin = `${home}/.bun/bin`
    process.env.BUN_INSTALL = `${home}/.bun`
    process.env.PATH = process.env.PATH ? `${bunBin}:${process.env.PATH}` : bunBin
    const { sandbox } = await loadAutocodeConfig(input.worktree, input.directory)

    return {
        async config(cfg: Config) {
            await mergeConfig(cfg, pluginInput)
        },

        tool: createTools(input.client, sandbox, { serverUrl: pluginInput.serverUrl }),
    }
}

export default autocode
