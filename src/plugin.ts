import { define } from "@opencode-ai/plugin/v2/promise"
import { homedir } from "node:os"
import { posix, win32 } from "node:path"
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import type { AgentConfig, Config } from "@opencode-ai/sdk/v2"
import { applyExternalDirectoryPolicy, applySandboxPlatformPolicy, applyWindowsSandboxPolicy, buildAgents, injectExternalSkillPermissions, type AutocodeAgentConfig } from "./agents"
import { collectExternalDirectories, collectTaskExternalRules, loadAutocodeConfig, mergeExternalDirectoryRules } from "./config"
import type { ExternalDirectoryRules, ModelTier, TierConfig } from "./config"
import { createCommands } from "./commands"
import { cleanupLearnedSkills, reconcileGeneratedSkills } from "./skills"
import { createTools } from "./tools"
import { createPlatformCapabilities, type PlatformCapabilities } from "./utils/platform"
import { createPendingAgentRestartCoordinator } from "./hooks/agent_restart_coordinator"
import { resolveAgentsStorageRoot } from "@/utils/jobs"
import type { SandboxPlatformSupportOptions } from "@/utils/sandbox"

type PluginAgentConfig = AutocodeAgentConfig
type ConfigWithSubagentDepth = Config & { subagent_depth?: number }
type CommandMap = NonNullable<Config["command"]>
type PluginInputWithSandboxSupportOverride = {
    client: Parameters<typeof createTools>[0]
    directory: string
    worktree: string
    sandboxSupportOverride?: SandboxPlatformSupportOptions
    platformOverride?: NodeJS.Platform
    homeOverride?: string
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
    capabilities: PlatformCapabilities = { isWindows: false, commandEnvironment: "linux" },
): Record<string, Omit<PluginAgentConfig, "tier">> {
    const externalDirectoryFinalizedAgents = applyExternalDirectoryPolicy(agents, externalDirectories)
    const sandboxFinalizedAgents = applySandboxPlatformPolicy(externalDirectoryFinalizedAgents, sandboxSupportOverride ?? {})
    injectExternalSkillPermissions(sandboxFinalizedAgents, externalSkills)
    return Object.fromEntries(Object.entries(applyWindowsSandboxPolicy(sandboxFinalizedAgents, capabilities)).map(([name, agent]) => [
        name,
        stripRuntimeAgentTier(agent),
    ]))
}

async function mergeConfig(
    cfg: ConfigWithSubagentDepth,
    input: PluginInputWithSandboxSupportOverride,
    autocodeConfig: Awaited<ReturnType<typeof loadAutocodeConfig>>,
    generatedSkills: Awaited<ReturnType<typeof reconcileGeneratedSkills>>,
    capabilities: PlatformCapabilities,
    commandDefinitions: CommandMap,
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
    const agents = buildAgents(capabilities, agentExternalDirectories, input.sandboxSupportOverride, generatedSkills.externalSkills)
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
        capabilities,
    )
    for (const [name, agent] of Object.entries(finalAgents)) {
        ;(cfg.agent as Record<string, unknown>)[name] = agent
    }
    if (capabilities.isWindows) {
        const windowsAgents = applyWindowsSandboxPolicy(cfg.agent as Record<string, PluginAgentConfig>, capabilities)
        for (const name of Object.keys(cfg.agent)) {
            delete cfg.agent[name]
        }
        Object.assign(cfg.agent, windowsAgents)
    }

    cfg.command = cfg.command ?? {}
    const mergedCommandCache = new WeakMap<object, NonNullable<Config["command"]>[string]>()
    for (const [name, commandDef] of Object.entries(commandDefinitions)) {
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
    const capabilities = createPlatformCapabilities(input.platformOverride ?? process.platform, process.env)
    const restartCoordinator = createPendingAgentRestartCoordinator()
    const commandDefinitions = createCommands(capabilities)
    const path = capabilities.isWindows ? win32 : posix
    const home = input.homeOverride ?? homedir()
    const bunRoot = path.join(home, ".bun")
    const bunBin = path.join(bunRoot, "bin")
    const originalPath = process.env.PATH
    process.env.BUN_INSTALL = bunRoot
    process.env.PATH = originalPath ? `${bunBin}${path.delimiter}${originalPath}` : bunBin

    const autocodeConfig = await loadAutocodeConfig(input.worktree, input.directory)
    const generatedSkills = await reconcileGeneratedSkills({ home, skipExtraction: autocodeConfig.skills?.freeze === true })
    registerSkills?.(generatedSkills.root)
    if (autocodeConfig.skills?.freeze !== true) {
        try {
            const agentsRoot = resolveAgentsStorageRoot({ worktree: input.worktree, directory: input.directory })
            await cleanupLearnedSkills(agentsRoot, autocodeConfig.skills?.learned?.max ?? 10)
        } catch (err) {
            console.warn(`autocode: cleanup learned skills failed: ${err instanceof Error ? err.message : String(err)}`)
        }
    }

    return {
        async dispose(): Promise<void> {
            restartCoordinator.dispose()
        },
        async event({ event }): Promise<void> {
            await restartCoordinator.handleEvent(event)
        },
        async config(cfg: ConfigWithSubagentDepth) {
            await mergeConfig(cfg, input, autocodeConfig, generatedSkills, capabilities, commandDefinitions)
        },
        tool: createTools(input.client, autocodeConfig.sandbox, { home, serverUrl: input.serverUrl, restartCoordinator }, capabilities),
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
