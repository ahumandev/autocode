import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin"
import type { AgentConfig, Config } from "@opencode-ai/sdk/v2"
import { applyExternalDirectoryPolicy, applySandboxPlatformPolicy, buildAgents, injectExternalSkillPermissions, type AutocodeAgentConfig } from "./agents"
import { collectExternalDirectories, collectTaskExternalRules, loadAutocodeConfig, mergeExternalDirectoryRules } from "./config"
import type { ExternalDirectoryRules, ModelTier, TierConfig } from "./config"
import { commands } from "./commands"
import { createAgentSwitchBackHook } from "./hooks/agent_switch_back"
import { cleanupLearnedSkills, ensureGeneratedSkills, injectGeneratedSkillsPath } from "./skills"
import { createTools } from "./tools"
import { createSkillLogger } from "./utils/logger"
import { bootstrapExternalSkills, type ExternalSkill } from "./utils/external"
import { resolveAgentsStorageRoot } from "@/utils/jobs"
import type { SandboxPlatformSupportOptions } from "@/utils/sandbox"

type PluginAgentConfig = AutocodeAgentConfig
type ConfigWithSubagentDepth = Config & { subagent_depth?: number }
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
    externalSkills: ExternalSkill[] = [],
): Record<string, Omit<PluginAgentConfig, "tier">> {
    const externalDirectoryFinalizedAgents = applyExternalDirectoryPolicy(agents, externalDirectories)
    const sandboxFinalizedAgents = applySandboxPlatformPolicy(externalDirectoryFinalizedAgents, sandboxSupportOverride ?? {})
    injectExternalSkillPermissions(sandboxFinalizedAgents, externalSkills)
    return Object.fromEntries(Object.entries(sandboxFinalizedAgents).map(([name, agent]) => [
        name,
        stripRuntimeAgentTier(agent),
    ]))
}

async function mergeConfig(cfg: ConfigWithSubagentDepth, input: PluginInputWithSandboxSupportOverride): Promise<void> {
    const generatedSkillsPath = await ensureGeneratedSkills()

    try {
        const cleanupConfig = await loadAutocodeConfig(input.worktree, input.directory)
        const agentsRoot = resolveAgentsStorageRoot({ worktree: input.worktree, directory: input.directory })
        await cleanupLearnedSkills(agentsRoot, cleanupConfig.learned.max ?? 10)
    } catch (err) {
        console.warn(`autocode: cleanup learned skills failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    cfg.skills = cfg.skills ?? {}
    cfg.skills.paths = injectGeneratedSkillsPath(cfg.skills.paths, generatedSkillsPath)

    // Bootstrap external GitHub skills (resilient — failures never break startup).
    const skillLogger = createSkillLogger()
    let externalSkills: ExternalSkill[] = []
    if (process.env.AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP) {
        skillLogger.log("skip bootstrap: AUTOCODE_SKIP_EXTERNAL_SKILLS_BOOTSTRAP set")
    } else {
        skillLogger.log("startup: bootstrap external skills")
        try {
            const config = await loadAutocodeConfig(input.worktree, input.directory)
            externalSkills = await bootstrapExternalSkills(config.skills, skillLogger)
        } catch (err) {
            skillLogger.log(`error: bootstrap: ${err instanceof Error ? err.message : String(err)}`)
        }
        skillLogger.log(`done: registered ${externalSkills.length} external skills`)
    }

    const { tiers, externalDirectories } = await loadAutocodeConfig(input.worktree, input.directory)
    const nativeExternalDirectories = typeof cfg.permission === "object" && cfg.permission !== null
        ? collectExternalDirectories(cfg.permission.external_directory)
        : undefined
    const nativeTaskExternalRules = typeof cfg.permission === "object" && cfg.permission !== null
        ? collectTaskExternalRules((cfg.permission as Record<string, unknown>).task_external)
        : undefined
    const nativePermissionRules = nativeTaskExternalRules
        ? mergeExternalDirectoryRules(nativeExternalDirectories ?? {}, nativeTaskExternalRules)
        : nativeExternalDirectories
    const agentExternalDirectories = nativePermissionRules
        ? mergeExternalDirectoryRules(nativePermissionRules, externalDirectories)
        : externalDirectories

    if (cfg.small_model === undefined && tiers.cheap?.model) {
        cfg.small_model = tiers.cheap.model
    }

    cfg.subagent_depth = Math.max(cfg.subagent_depth ?? 0, 4)

    cfg.agent = cfg.agent ?? {}
    const agents = buildAgents(agentExternalDirectories, input.sandboxSupportOverride, externalSkills)
    const mergedAgents: Record<string, PluginAgentConfig> = {}
    for (const [name, agentDef] of Object.entries(agents)) {
        const userOverride = cfg.agent[name]
        const mergedAgent = mergePluginAgentConfig(agentDef, tiers, userOverride)
        mergedAgents[name] = mergedAgent
    }
    const finalAgents = preparePluginAgentsAfterOverrides(
        mergedAgents,
        agentExternalDirectories,
        input.sandboxSupportOverride,
        externalSkills,
    )
    for (const [name, agent] of Object.entries(finalAgents)) {
        ;(cfg.agent as Record<string, unknown>)[name] = agent
    }

    const finalAgentNames = Object.keys(finalAgents)
    skillLogger.log(`agent-skill-registry: ${finalAgentNames.length} agents`)
    for (const name of finalAgentNames) {
        const skillPermission = (finalAgents[name] as { permission?: { skill?: unknown } }).permission?.skill
        if (skillPermission === undefined || typeof skillPermission !== "object" || skillPermission === null) continue
        for (const [skillName, action] of Object.entries(skillPermission as Record<string, unknown>)) {
            if (skillName === "*") continue
            skillLogger.log(`agent=${name} skill=${skillName} action=${action}`)
        }
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
        async config(cfg: ConfigWithSubagentDepth) {
            await mergeConfig(cfg, pluginInput)
        },

        tool: createTools(input.client, sandbox, { serverUrl: pluginInput.serverUrl }),
        event: createAgentSwitchBackHook(input.client, input.directory, input.worktree),
    }
}

export default autocode
