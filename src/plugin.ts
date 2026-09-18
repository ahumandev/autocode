import { define } from "@opencode-ai/plugin/v2/promise"
import type { Dirent } from "node:fs"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { posix, win32 } from "node:path"
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import type { AgentConfig, Config } from "@opencode-ai/sdk/v2"
import { applyExternalDirectoryPolicy, applySandboxPlatformPolicy, applyWindowsSandboxPolicy, buildAgents, injectExternalSkillPermissions, type AutocodeAgentConfig } from "./agents"
import { collectExternalDirectories, collectTaskExternalRules, loadAutocodeConfig, mergeExternalDirectoryRules } from "./config"
import type { ExternalDirectoryRules, ModelTier, PermissionAction, TierConfig } from "./config"
import { createCommands } from "./commands"
import { reconcileGeneratedSkills } from "./skills"
import { createTools } from "./tools"
import { createPlatformCapabilities, type PlatformCapabilities } from "./utils/platform"
import { createPendingAgentRestartCoordinator } from "./hooks/agent_restart_coordinator"
import { createManagedScriptLifecycle } from "./hooks/managed_script_lifecycle"
import { createRootSessionTitleHook } from "./hooks/root_session_title"
import { createLocalMemoryRecallHook, createOpenCodeLocalMemorySessionContextLoader } from "./hooks/local_memory_recall"
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

function isPermissionAction(value: unknown): value is PermissionAction {
    return value === "allow" || value === "ask" || value === "deny"
}

type PermissionObject = Exclude<PluginAgentConfig["permission"], PermissionAction | undefined>

function isPermissionObject(value: unknown): value is PermissionObject {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false
    }

    return Object.values(value).every((rule) => isPermissionAction(rule)
        || (rule !== null && typeof rule === "object" && !Array.isArray(rule)
            && Object.values(rule).every(isPermissionAction)))
}

function hardenSpyPermission(permission: unknown): PluginAgentConfig["permission"] {
    if (isPermissionAction(permission)) {
        return { "*": permission, learn: "deny" }
    }

    if (isPermissionObject(permission)) {
        return { ...permission, learn: "deny" }
    }

    return { "*": "deny", learn: "deny" }
}

function enforceSpyLearnDenial(
    agents: Record<string, Omit<PluginAgentConfig, "tier">>,
): Record<string, Omit<PluginAgentConfig, "tier">> {
    const spy = agents.spy
    if (spy === undefined) {
        return agents
    }

    return { ...agents, spy: { ...spy, permission: hardenSpyPermission(spy.permission) } }
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
    refreshSmartAgentNames: (agents: ReturnType<typeof buildAgents>) => void,
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
    const agents = buildAgents(capabilities, agentExternalDirectories, input.sandboxSupportOverride, generatedSkills.externalSkills, tiers)
    refreshSmartAgentNames(agents)
    for (const agentName of ["spy", "auto"] as const) {
        if (agents[agentName] === undefined) {
            delete (cfg.agent as Record<string, unknown>)[agentName]
        }
    }
    const mergedAgents: Record<string, PluginAgentConfig> = {}
    for (const [name, agentDef] of Object.entries(agents)) {
        const userOverride = cfg.agent[name]
        const mergedAgent = mergePluginAgentConfig(agentDef, tiers, userOverride)
        mergedAgents[name] = mergedAgent
    }
    const finalAgents = enforceSpyLearnDenial(preparePluginAgentsAfterOverrides(
        mergedAgents,
        agentExternalDirectories,
        input.sandboxSupportOverride,
        generatedSkills.externalSkills,
        capabilities,
    ))
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

async function preparePluginSkills(
    input: PluginInputWithSandboxSupportOverride,
    home: string,
    registerSkills?: (path: string) => void,
): Promise<{
    autocodeConfig: Awaited<ReturnType<typeof loadAutocodeConfig>>
    generatedSkills: Awaited<ReturnType<typeof reconcileGeneratedSkills>>
}> {
    const autocodeConfig = await loadAutocodeConfig(input.worktree, input.directory)
    const generatedSkills = await reconcileGeneratedSkills({ home, skipExtraction: autocodeConfig.skills?.freeze === true })
    registerSkills?.(generatedSkills.root)
    return { autocodeConfig, generatedSkills }
}

async function createPluginHooks(
    input: PluginInputWithSandboxSupportOverride,
    registerSkills?: (path: string) => void,
): Promise<Hooks> {
    const capabilities = createPlatformCapabilities(input.platformOverride ?? process.platform, process.env)
    const restartCoordinator = createPendingAgentRestartCoordinator()
    const managedScriptLifecycle = createManagedScriptLifecycle({ client: input.client })
    const rootSessionTitleHook = createRootSessionTitleHook(input.client, input.directory)
    const smartAgentNames = new Set<string>()
    const localMemoryRecallHook = createLocalMemoryRecallHook({
        context: { directory: input.directory, worktree: input.worktree },
        fileSystem: {
            mkdir: async (directoryPath: string, options?: { recursive?: boolean }): Promise<string | undefined> => await mkdir(directoryPath, options),
            readFile: async (filePath: string, encoding: "utf8"): Promise<string> => await readFile(filePath, encoding),
            readdir: async (directoryPath: string, options?: { withFileTypes?: boolean }): Promise<string[] | Dirent[]> => options?.withFileTypes ? await readdir(directoryPath, { withFileTypes: true }) : await readdir(directoryPath),
            rename: async (oldPath: string, newPath: string): Promise<void> => await rename(oldPath, newPath),
            rm: async (filePath: string, options?: { recursive?: boolean, force?: boolean }): Promise<void> => await rm(filePath, options),
            writeFile: async (filePath: string, content: string): Promise<void> => await writeFile(filePath, content),
        },
        loadSessionContext: createOpenCodeLocalMemorySessionContextLoader(input.client, input.directory),
        isSmartAgent(agentName: string): boolean {
            return smartAgentNames.has(agentName)
        },
    })
    const path = capabilities.isWindows ? win32 : posix
    const home = input.homeOverride ?? homedir()
    const bunRoot = path.join(home, ".bun")
    const bunBin = path.join(bunRoot, "bin")

    const { autocodeConfig, generatedSkills } = await preparePluginSkills(input, home, registerSkills)
    const commandDefinitions = createCommands(
        capabilities,
        autocodeConfig.tiers.spy !== undefined,
        autocodeConfig.tiers.smart !== undefined,
    )

    const hooks: Hooks = {
        async dispose(): Promise<void> {
            const results = await Promise.allSettled([
                managedScriptLifecycle.dispose(),
                (async (): Promise<void> => { restartCoordinator.dispose() })(),
                (async (): Promise<void> => { await localMemoryRecallHook.dispose?.() })(),
            ])
            for (const result of results) {
                if (result.status === "rejected") {
                    console.warn(`autocode: plugin lifecycle cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
                }
            }
        },
        async event({ event }): Promise<void> {
            await localMemoryRecallHook.event?.({ event })
            await managedScriptLifecycle.handleEvent(event)
            try {
                await restartCoordinator.handleEvent(event)
            }
            finally {
                await rootSessionTitleHook.handleEvent(event)
            }
        },
        async config(cfg: ConfigWithSubagentDepth) {
            const originalPath = process.env.PATH
            process.env.BUN_INSTALL = bunRoot
            process.env.PATH = originalPath ? `${bunBin}${path.delimiter}${originalPath}` : bunBin
            await mergeConfig(cfg, input, autocodeConfig, generatedSkills, capabilities, commandDefinitions, (agents: ReturnType<typeof buildAgents>): void => {
                smartAgentNames.clear()
                for (const [name, agent] of Object.entries(agents)) {
                    if (agent.tier === "smart") smartAgentNames.add(name)
                }
            })
        },
        tool: createTools(input.client, autocodeConfig.sandbox, {
            home,
            serverUrl: input.serverUrl,
            getWebUrl: () => process.env.AUTOCODE_WEB_URL,
            restartCoordinator,
            managedScriptLifecycle,
        }, capabilities),
    }
    return {
        ...hooks,
        "chat.message": localMemoryRecallHook["chat.message"],
        "experimental.chat.messages.transform": localMemoryRecallHook["experimental.chat.messages.transform"],
    }
}

const plugin = define({
    id: "autocode",
    async setup(context) {
        const input = context as unknown as PluginInputWithSandboxSupportOverride
        await preparePluginSkills(input, input.homeOverride ?? homedir(), (path) => {
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
