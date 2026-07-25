import { define } from "@opencode-ai/plugin/v2/promise"
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import type { AgentConfig, Config } from "@opencode-ai/sdk/v2"
import { applyExternalDirectoryPolicy, applySandboxPlatformPolicy, buildAgents, injectExternalSkillPermissions, type AutocodeAgentConfig } from "./agents"
import { collectExternalDirectories, collectTaskExternalRules, loadAutocodeConfig, mergeExternalDirectoryRules } from "./config"
import type { ExternalDirectoryRules, ModelTier, TierConfig } from "./config"
import { commands } from "./commands"
import { createAgentSwitchBackHook } from "./hooks/agent_switch_back"
import { cleanupLearnedSkills, reconcileGeneratedSkills } from "./skills"
import { createTools } from "./tools"
import { resolveAgentsStorageRoot } from "@/utils/jobs"
import type { SandboxPlatformSupportOptions } from "@/utils/sandbox"

type PluginAgentConfig = AutocodeAgentConfig
type ConfigWithSubagentDepth = Config & { subagent_depth?: number }
type PluginInputWithSandboxSupportOverride = {
    client: Parameters<typeof createTools>[0]
    directory: string
    worktree: string
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
    externalSkills: Parameters<typeof injectExternalSkillPermissions>[1] = [],
): Record<string, Omit<PluginAgentConfig, "tier">> {
    const externalDirectoryFinalizedAgents = applyExternalDirectoryPolicy(agents, externalDirectories)
    const sandboxFinalizedAgents = applySandboxPlatformPolicy(externalDirectoryFinalizedAgents, sandboxSupportOverride ?? {})
    injectExternalSkillPermissions(sandboxFinalizedAgents, externalSkills)
    return Object.fromEntries(Object.entries(sandboxFinalizedAgents).map(([name, agent]) => [
        name,
        stripRuntimeAgentTier(agent),
    ]))
}

async function mergeConfig(
    cfg: ConfigWithSubagentDepth,
    input: PluginInputWithSandboxSupportOverride,
    autocodeConfig: Awaited<ReturnType<typeof loadAutocodeConfig>>,
    generatedSkills: Awaited<ReturnType<typeof reconcileGeneratedSkills>>,
): Promise<void> {
    const { tiers, externalDirectories } = autocodeConfig
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
    const agents = buildAgents(agentExternalDirectories, input.sandboxSupportOverride, generatedSkills.externalSkills)
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
        generatedSkills.externalSkills,
    )
    for (const [name, agent] of Object.entries(finalAgents)) {
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

async function createPluginHooks(
    input: PluginInputWithSandboxSupportOverride,
    registerSkills?: (path: string) => void,
): Promise<Hooks> {
    const home = process.env.HOME ?? ""
    const bunBin = `${home}/.bun/bin`
    process.env.BUN_INSTALL = `${home}/.bun`
    process.env.PATH = process.env.PATH ? `${bunBin}:${process.env.PATH}` : bunBin

    const autocodeConfig = await loadAutocodeConfig(input.worktree, input.directory)
    const generatedSkills = await reconcileGeneratedSkills({ skipExtraction: autocodeConfig.skills?.freeze === true })
    registerSkills?.(generatedSkills.root)
    if (autocodeConfig.skills?.freeze !== true) {
        try {
            const agentsRoot = resolveAgentsStorageRoot({ worktree: input.worktree, directory: input.directory })
            await cleanupLearnedSkills(agentsRoot, autocodeConfig.learned.max ?? 10)
        } catch (err) {
            console.warn(`autocode: cleanup learned skills failed: ${err instanceof Error ? err.message : String(err)}`)
        }
    }

    return {
        async config(cfg: ConfigWithSubagentDepth) {
            await mergeConfig(cfg, input, autocodeConfig, generatedSkills)
        },
        tool: createTools(input.client, autocodeConfig.sandbox, { serverUrl: input.serverUrl }),
        event: createAgentSwitchBackHook(input.client, input.directory, input.worktree),
    }
}

const plugin = define({
    id: "autocode",
    async setup(context) {
        const input = context as unknown as PluginInputWithSandboxSupportOverride
        await createPluginHooks(input, (path) => {
            context.skill.transform((draft) => {
                draft.source({ type: "directory", path })
            })
        })
    },
})

const autocode: Plugin = Object.assign(
    async (input: PluginInput): Promise<Hooks> => createPluginHooks(input as PluginInputWithSandboxSupportOverride),
    plugin,
)

export default autocode
