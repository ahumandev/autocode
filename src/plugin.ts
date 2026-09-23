import { Plugin as OpenCodePlugin, type Agent } from "@opencode/plugin"
import type { Dirent } from "node:fs"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { posix, win32 } from "node:path"
import { join } from "node:path"
import { z } from "zod"
// V1 types remain for the legacy server entry and tool implementations without V2 equivalents.
import type { Hooks, PluginModule as LegacyPluginModule, PluginInput, ToolContext as LegacyToolContext, ToolDefinition } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import type { AgentConfig, Config } from "@opencode-ai/sdk/v2"
import { buildAgents, type AutocodeAgentConfig } from "./agents"
import { collectExternalDirectories, loadAutocodeConfig, mergeExternalDirectoryRules } from "./config"
import type { ExternalDirectoryRules, ModelTier, TierConfig } from "./config"
import { createCommands } from "./commands"
import { reconcileGeneratedSkills } from "./skills"
import { createTools } from "./tools"
import { createPlatformCapabilities, type PlatformCapabilities } from "./utils/platform"
import { createPendingAgentRestartCoordinator } from "./hooks/agent_restart_coordinator"
import { createManagedScriptLifecycle } from "./hooks/managed_script_lifecycle"
import { createRootSessionTitleHook } from "./hooks/root_session_title"
import { createLocalMemoryRecallHook, createOpenCodeLocalMemorySessionContextLoader } from "./hooks/local_memory_recall"
import type { SandboxPlatformSupportOptions } from "@/utils/sandbox"
import { isSandboxPlatformSupported } from "@/utils/sandbox"
import { permissionEffect, type PermissionRule } from "./utils/permissions"

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

type V2Context = OpenCodePlugin.Context
type V2PermissionRule = PermissionRule
type V2ContextWithRuntimeOverrides = V2Context & {
    homeOverride?: string
    platformOverride?: NodeJS.Platform
    sandboxSupportOverride?: SandboxPlatformSupportOptions
    serverUrl?: URL
}

const v2LocalMemoryPartsMetadataKey = "autocode.local_memory.parts"
const v2LocalMemoryOriginalTextMetadataKey = "autocode.local_memory.original_text"

function mergePluginAgentConfig(
    agentDef: PluginAgentConfig,
    tiers: Partial<Record<ModelTier, TierConfig>>,
    userOverride: AgentConfig | undefined,
): PluginAgentConfig {
    const { tier, ...agentBase } = agentDef
    const tierMapping = tier && tiers[tier] ? tiers[tier] : {}
    const merged: PluginAgentConfig = {
        ...agentBase, ...tierMapping, ...userOverride,
        permissions: [...(agentBase.permissions ?? []), ...(Array.isArray(userOverride?.permissions)
            ? userOverride.permissions.filter((rule): rule is PermissionRule => typeof rule === "object" && rule !== null
                && typeof rule.action === "string" && typeof rule.resource === "string"
                && (rule.effect === "allow" || rule.effect === "ask" || rule.effect === "deny"))
            : [])],
    }
    delete (merged as Record<string, unknown>).permission
    return merged
}

function stripRuntimeAgentTier(agent: PluginAgentConfig): Omit<PluginAgentConfig, "tier"> {
    const { tier, ...runtimeAgent } = agent
    return runtimeAgent
}

function enforceSpyLearnDenial(
    agents: Record<string, Omit<PluginAgentConfig, "tier">>,
): Record<string, Omit<PluginAgentConfig, "tier">> {
    const spy = agents.spy
    if (spy === undefined) {
        return agents
    }

    return { ...agents, spy: { ...spy, permissions: [...(Array.isArray(spy.permissions) ? spy.permissions : []), { action: "learn", resource: "*", effect: "deny" }] } }
}

function preparePluginAgentsAfterOverrides(
    agents: Record<string, PluginAgentConfig>,
    _externalDirectories: ExternalDirectoryRules,
    sandboxSupportOverride?: SandboxPlatformSupportOptions,
    _externalSkills: Parameters<typeof buildAgents>[3] = [],
    capabilities: PlatformCapabilities = { isWindows: false, commandEnvironment: "linux" },
): Record<string, Omit<PluginAgentConfig, "tier">> {
    const sandboxSupported = isSandboxPlatformSupported(sandboxSupportOverride ?? {})
    return Object.fromEntries(Object.entries(agents).filter(([name]) => !capabilities.isWindows || name !== "execute-sandbox").map(([name, agent]) => {
        const permissions = [...(agent.permissions ?? [])]
        if (!sandboxSupported) {
            for (const action of ["autocode_sandbox_create", "autocode_sandbox_cli", "autocode_sandbox_delete", "autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read", "autocode_sandbox_copy", "autocode_sandbox_config_edit", "autocode_sandbox_config_read", "autocode_sandbox_config_remove"]) {
                permissions.push({ action, resource: "*", effect: "deny" })
            }
        }
        const finalized = { ...agent, permissions: capabilities.isWindows
            ? permissions.filter((rule) => !`${rule.action} ${rule.resource}`.toLowerCase().includes("sandbox"))
            : permissions }
        return [name, stripRuntimeAgentTier(finalized)]
    }))
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
    const nativeExternalDirectories = collectExternalDirectories((cfg as Config & { permissions?: unknown }).permissions)
    const agentExternalDirectories = nativeExternalDirectories
        ? mergeExternalDirectoryRules(nativeExternalDirectories, externalDirectories)
        : externalDirectories

    if (cfg.small_model === undefined && tiers.cheap?.model) {
        cfg.small_model = tiers.cheap.model
    }

    cfg.subagent_depth = Math.max(cfg.subagent_depth ?? 0, 4)

    cfg.agent = cfg.agent ?? {}
    if (capabilities.isWindows) delete (cfg.agent as Record<string, unknown>)["execute-sandbox"]
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

function getRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
}

function unwrapLegacyRequest(request: unknown): { path: Record<string, unknown>; query: Record<string, unknown>; body: Record<string, unknown> } {
    const value = getRecord(request) ?? {}
    return {
        path: getRecord(value.path) ?? {},
        query: getRecord(value.query) ?? {},
        body: getRecord(value.body) ?? {},
    }
}

function modelRefFromLegacy(value: unknown): { providerID: string; id: string; variant?: string } | undefined {
    if (typeof value === "string") {
        const [reference, variant] = value.split("#", 2)
        const separator = reference.indexOf("/")
        if (separator <= 0 || separator === reference.length - 1) return undefined
        return {
            providerID: reference.slice(0, separator),
            id: reference.slice(separator + 1),
            ...(variant ? { variant } : {}),
        }
    }

    const model = getRecord(value)
    const providerID = model?.providerID
    const id = model?.id ?? model?.modelID ?? model?.model
    if (typeof providerID !== "string" || typeof id !== "string") return undefined
    return {
        providerID,
        id,
        ...(typeof model?.variant === "string" ? { variant: model.variant } : {}),
    }
}

function toLegacyMessages(messages: readonly unknown[], fallbackAgent?: string): Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> {
    let selectedAgent = fallbackAgent
    const result: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = []
    for (const candidate of messages) {
        const message = getRecord(candidate)
        if (message === undefined) continue
        const id = message?.id
        const type = message?.type
        if (typeof id !== "string" || typeof type !== "string") continue
        if (type === "agent-switched") {
            if (typeof message.agent === "string") selectedAgent = message.agent
            continue
        }
        if (type === "user") {
            const metadata = getRecord(message.metadata)
            const originalText = metadata?.[v2LocalMemoryOriginalTextMetadataKey]
            const text = typeof originalText === "string" ? originalText : typeof message.text === "string" ? message.text : ""
            const retainedParts = Array.isArray(metadata?.[v2LocalMemoryPartsMetadataKey])
                ? metadata[v2LocalMemoryPartsMetadataKey]
                    .map((part) => getRecord(part))
                    .filter((part): part is Record<string, unknown> => part !== undefined && typeof part.text === "string")
                : []
            result.push({
                info: { id, role: "user", agent: selectedAgent, time: message.time },
                parts: [
                    { id: `${id}-text`, messageID: id, type: "text", text },
                    ...retainedParts.map((part, index) => ({
                        id: `${id}-autocode-memory-${index}`,
                        messageID: id,
                        type: "text",
                        text: part.text,
                        metadata: part.metadata,
                    })),
                ],
            })
            continue
        }
        if (type === "assistant") {
            if (typeof message.agent === "string") selectedAgent = message.agent
            const content = Array.isArray(message.content) ? message.content : []
            result.push({
                info: {
                    id,
                    role: "assistant",
                    agent: selectedAgent,
                    time: message.time,
                    finish: message.finish,
                },
                parts: content.map((part, index) => ({
                    ...(getRecord(part) ?? {}),
                    id: getRecord(part)?.id ?? `${id}-${index}`,
                    messageID: id,
                })),
            })
        }
    }
    return result
}

/** Retains V1-shaped tool inputs while dispatching supported operations through the V2 context. */
function createV2ClientAdapter(context: V2Context): OpencodeClient {
    const adapter = {
        session: {
            async get(request: unknown) {
                const { path } = unwrapLegacyRequest(request)
                try {
                    return { data: await context.session.get({ sessionID: String(path.id ?? "") }) }
                }
                catch (error) {
                    return { error }
                }
            },
            async messages(request: unknown) {
                const { path } = unwrapLegacyRequest(request)
                try {
                    const sessionID = String(path.id ?? "")
                    const [session, messages] = await Promise.all([
                        context.session.get({ sessionID }),
                        context.session.context({ sessionID }),
                    ])
                    return { data: toLegacyMessages(messages, session.agent) }
                }
                catch (error) {
                    return { error }
                }
            },
            async create(request: unknown) {
                const { query, body } = unwrapLegacyRequest(request)
                try {
                    const model = modelRefFromLegacy(body.model)
                    return {
                        data: await context.session.create({
                            ...(typeof body.title === "string" ? { title: body.title } : {}),
                            ...(typeof body.agent === "string" ? { agent: body.agent } : {}),
                            ...(model ? { model } : {}),
                            ...(typeof query.directory === "string" ? { location: { directory: query.directory } } : {}),
                        }),
                    }
                }
                catch (error) {
                    return { error }
                }
            },
            async update(request: unknown) {
                const { path, body } = unwrapLegacyRequest(request)
                try {
                    await context.session.update({
                        sessionID: String(path.id ?? ""),
                        ...(typeof body.title === "string" ? { title: body.title } : {}),
                    })
                    return { data: true }
                }
                catch (error) {
                    return { error }
                }
            },
            async promptAsync(request: unknown) {
                const { path, body } = unwrapLegacyRequest(request)
                const sessionID = String(path.id ?? "")
                try {
                    if (body.system !== undefined) {
                        return { error: "OpenCode v2 session.prompt cannot set a per-prompt system message; use the V1 runtime for this request." }
                    }
                    if (typeof body.agent === "string") {
                        await context.session.switchAgent({ sessionID, agent: body.agent })
                    }
                    const model = modelRefFromLegacy(body.model)
                    if (model) await context.session.switchModel({ sessionID, model })
                    const parts = Array.isArray(body.parts) ? body.parts : []
                    const text = parts
                        .map((part) => getRecord(part))
                        .filter((part): part is Record<string, unknown> => part?.type === "text" && typeof part.text === "string")
                        .map((part) => String(part.text))
                        .join("\n")
                    return { data: await context.session.prompt({ sessionID, text, delivery: "queue" }) }
                }
                catch (error) {
                    return { error }
                }
            },
            async delete() {
                // V2 plugin contexts have no session.remove; rollback must report failure instead of pretending cleanup succeeded.
                return { error: "OpenCode v2 plugin contexts cannot remove sessions." }
            },
            async summarize() {
                // V2 plugin contexts have no session.compact; active context cannot replace durable compaction.
                return { error: "OpenCode v2 plugin contexts cannot trigger session compaction; use the V1 runtime for session summaries." }
            },
        },
    }
    return adapter as unknown as OpencodeClient
}

const v2AgentKeys = ["id", "name", "model", "request", "system", "description", "mode", "hidden", "color", "steps", "permissions"] as const satisfies readonly (keyof Agent.Info)[]

function v2RequestBody(source: Record<string, unknown>): Record<string, unknown> {
    return {
        ...(typeof source.temperature === "number" ? { temperature: source.temperature } : {}),
        ...(typeof source.top_p === "number" ? { top_p: source.top_p } : {}),
        ...(getRecord(source.options) ?? {}),
    }
}

function v2Model(source: Record<string, unknown>): ReturnType<typeof modelRefFromLegacy> {
    const model = modelRefFromLegacy(source.model)
    if (!model) return undefined
    const variant = typeof source.variant === "string" ? source.variant : model.variant
    return { providerID: model.providerID, id: model.id, ...(variant ? { variant } : {}) }
}

function toV2Agent(name: string, agent: Omit<PluginAgentConfig, "tier">): Record<string, unknown> {
    const source = agent as Record<string, unknown>
    const model = v2Model(source)
    return {
        id: name,
        name,
        mode: source.mode ?? "primary",
        hidden: source.hidden ?? false,
        request: { settings: {}, headers: {}, body: v2RequestBody(source) },
        permissions: agent.permissions ?? [],
        ...(typeof source.prompt === "string" ? { system: source.prompt } : {}),
        ...(typeof source.description === "string" ? { description: source.description } : {}),
        ...(typeof source.color === "string" ? { color: source.color } : {}),
        ...(typeof source.steps === "number" ? { steps: source.steps } : typeof source.maxSteps === "number" ? { steps: source.maxSteps } : {}),
        ...(model ? { model } : {}),
    }
}

function mergeV2Agent(draft: Record<string, unknown>, definition: Record<string, unknown>, existing: Record<string, unknown> | undefined): void {
    for (const key of Object.keys(draft)) {
        if (!(v2AgentKeys as readonly string[]).includes(key)) delete draft[key]
    }
    Object.assign(draft, definition)
    if (existing === undefined) return
    const definitionRequest = getRecord(definition.request) ?? {}
    const existingRequest = getRecord(existing.request) ?? {}
    const existingModel = v2Model(existing)
    Object.assign(draft, {
        ...(typeof existing.system === "string" ? { system: existing.system } : typeof existing.prompt === "string" ? { system: existing.prompt } : {}),
        ...(typeof existing.description === "string" ? { description: existing.description } : {}),
        ...(existing.mode === "primary" || existing.mode === "subagent" || existing.mode === "all" ? { mode: existing.mode } : {}),
        ...(typeof existing.hidden === "boolean" ? { hidden: existing.hidden } : {}),
        ...(typeof existing.color === "string" ? { color: existing.color } : {}),
        ...(typeof existing.steps === "number" ? { steps: existing.steps } : typeof existing.maxSteps === "number" ? { steps: existing.maxSteps } : {}),
        ...(existingModel ? { model: existingModel } : {}),
        request: {
            ...definitionRequest,
            settings: { ...(getRecord(definitionRequest.settings) ?? {}), ...(getRecord(existingRequest.settings) ?? {}) },
            headers: { ...(getRecord(definitionRequest.headers) ?? {}), ...(getRecord(existingRequest.headers) ?? {}) },
            body: { ...(getRecord(definitionRequest.body) ?? {}), ...v2RequestBody(existing), ...(getRecord(existingRequest.body) ?? {}) },
        },
        permissions: [
            { action: "*", resource: "*", effect: "allow" },
            ...(Array.isArray(definition.permissions) ? definition.permissions.filter((rule) => getRecord(rule)?.action === "*") : []),
            { action: "external_directory", resource: "*", effect: "ask" },
            ...(Array.isArray(definition.permissions) ? definition.permissions.filter((rule) => {
                const value = getRecord(rule)
                return value?.action !== "*" && !(value?.action === "external_directory" && value.resource === "*" && value.effect === "ask")
            }) : []),
            ...(Array.isArray(existing.permissions) ? existing.permissions.filter((rule) => {
                const value = getRecord(rule)
                return !(value?.action === "*" && value.resource === "*" && value.effect === "allow")
                    && !(value?.action === "external_directory" && value.resource === "*" && value.effect === "ask")
            }) : []),
        ],
    })
}

function enforceV2AgentSecurity(name: string, draft: Record<string, unknown>, sandboxSupported: boolean, isWindows: boolean): void {
    let permissions: V2PermissionRule[] = Array.isArray(draft.permissions) ? draft.permissions : []
    if (isWindows) permissions = permissions.filter((rule) => !`${rule.action} ${rule.resource}`.toLowerCase().includes("sandbox"))
    if (!sandboxSupported && !isWindows) {
        permissions = [...permissions, ...["autocode_sandbox_create", "autocode_sandbox_cli", "autocode_sandbox_delete", "autocode_sandbox_edit", "autocode_sandbox_glob", "autocode_sandbox_grep", "autocode_sandbox_read", "autocode_sandbox_copy", "autocode_sandbox_config_edit", "autocode_sandbox_config_read", "autocode_sandbox_config_remove"].map((action) => ({ action, resource: "*", effect: "deny" as const }))]
    }
    if (name === "spy") permissions = [...permissions, { action: "learn", resource: "*", effect: "deny" }]
    draft.permissions = permissions
}

function createLegacyAsk(getPermissions: () => readonly V2PermissionRule[] | undefined): LegacyToolContext["ask"] {
    // V2 exposes permission evaluation and replies, but no interactive request API for plugin tools.
    return async (request): Promise<void> => {
        const rules = getPermissions() ?? []
        const resources = request.patterns.length > 0 ? request.patterns : ["*"]
        const effects = resources.map((resource) => {
            return permissionEffect(rules, request.permission, resource) ?? "ask"
        })
        if (effects.includes("deny")) throw new Error(`Permission denied: ${request.permission} ${resources.join(", ")}`)
        if (effects.includes("ask")) {
            throw new Error(`Permission approval is required for ${request.permission} (${resources.join(", ")}), but OpenCode v2 does not expose interactive permission requests to plugin tools.`)
        }
    }
}

function v2ToolResult(result: Awaited<ReturnType<ToolDefinition["execute"]>>): { content: string | Array<Record<string, unknown>>; metadata?: Record<string, unknown> } {
    if (typeof result === "string") return { content: result }
    const files = result.attachments?.map((attachment) => ({
        type: "file",
        uri: attachment.url,
        mime: attachment.mime,
        ...(attachment.filename ? { name: attachment.filename } : {}),
    })) ?? []
    return {
        content: files.length === 0 ? result.output : [{ type: "text", text: result.output }, ...files],
        ...(result.metadata ? { metadata: result.metadata } : {}),
    }
}

function frontmatterScalar(frontmatter: string, key: string): string | undefined {
    const value = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim()
    if (!value) return undefined
    if (value.startsWith('"') && value.endsWith('"')) {
        try {
            const parsed = JSON.parse(value)
            return typeof parsed === "string" ? parsed : value
        }
        catch {
            return value.slice(1, -1)
        }
    }
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'")
    return value
}

function parseGeneratedSkill(source: string, fallbackID: string): { id: string; description?: string; content: string } {
    const normalized = source.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n")
    const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
    if (match === null) return { id: fallbackID, content: normalized.trim() }
    const id = frontmatterScalar(match[1], "name") ?? fallbackID
    const description = frontmatterScalar(match[1], "description")
    return { id, ...(description ? { description } : {}), content: match[2].trim() }
}

async function discoverGeneratedSkills(root: string): Promise<Array<{ id: string; name: string; description?: string; path: string; content: string }>> {
    const skills: Array<{ id: string; name: string; description?: string; path: string; content: string }> = []
    async function visit(directory: string): Promise<void> {
        let entries: Dirent[]
        try {
            entries = await readdir(directory, { withFileTypes: true })
        }
        catch {
            return
        }
        for (const entry of entries) {
            const entryPath = join(directory, entry.name)
            if (entry.isDirectory()) {
                await visit(entryPath)
                continue
            }
            if (!entry.isFile() || entry.name !== "SKILL.md") continue
            const fallbackID = entryPath.slice(root.length + 1, -"/SKILL.md".length).replaceAll("\\", "/")
            const parsed = parseGeneratedSkill(await readFile(entryPath, "utf8"), fallbackID)
            skills.push({
                id: parsed.id,
                name: parsed.id,
                ...(parsed.description ? { description: parsed.description } : {}),
                path: entryPath,
                content: parsed.content,
            })
        }
    }
    await visit(root)
    return skills
}

function commandText(template: string, argumentsText: string): string {
    return template.includes("$ARGUMENTS")
        ? template.replaceAll("$ARGUMENTS", argumentsText)
        : argumentsText.trim() ? `${template.trim()}\n\n${argumentsText}` : template
}

function prependPathEntry(current: string | undefined, entry: string, delimiter: string): string {
    const entries = current?.split(delimiter).filter((candidate) => candidate && candidate !== entry) ?? []
    return [entry, ...entries].join(delimiter)
}

function normalizeV2Event(event: unknown): unknown {
    const record = getRecord(event)
    if (record === undefined) return event
    const location = getRecord(record.location)
    const data = getRecord(record.data) ?? {}
    const directory = typeof location?.directory === "string" ? location.directory : undefined
    const type = record.type === "session.step.ended"
        ? "session.next.step.ended"
        : record.type === "session.step.failed" ? "session.next.step.failed" : record.type
    return {
        ...record,
        type,
        ...(directory ? { directory } : {}),
        properties: { ...data, ...(directory ? { directory } : {}) },
    }
}

function v2TitleProgressEvent(event: unknown): unknown | undefined {
    const record = getRecord(event)
    const data = getRecord(record?.data)
    if (record?.type !== "session.tool.called" && record?.type !== "session.tool.success" && record?.type !== "session.tool.failed") return undefined
    if (typeof data?.sessionID !== "string" || typeof data.assistantMessageID !== "string") return undefined
    return {
        type: "message.part.updated",
        properties: {
            sessionID: data.sessionID,
            part: { type: "tool", sessionID: data.sessionID, messageID: data.assistantMessageID },
        },
    }
}

async function setupV2(context: V2Context): Promise<OpenCodePlugin.Cleanup> {
    const runtimeContext = context as V2ContextWithRuntimeOverrides
    const directory = String(context.location.directory)
    const worktree = String(context.location.project.directory)
    const capabilities = createPlatformCapabilities(runtimeContext.platformOverride ?? process.platform, process.env)
    const home = runtimeContext.homeOverride ?? homedir()
    const path = capabilities.isWindows ? win32 : posix
    const bunRoot = path.join(home, ".bun")
    const bunBin = path.join(bunRoot, "bin")
    process.env.BUN_INSTALL = bunRoot
    process.env.PATH = prependPathEntry(process.env.PATH, bunBin, path.delimiter)

    const client = createV2ClientAdapter(context)
    const input: PluginInputWithSandboxSupportOverride = {
        client,
        directory,
        worktree,
        ...(runtimeContext.sandboxSupportOverride ? { sandboxSupportOverride: runtimeContext.sandboxSupportOverride } : {}),
        ...(runtimeContext.platformOverride ? { platformOverride: runtimeContext.platformOverride } : {}),
        ...(runtimeContext.homeOverride ? { homeOverride: runtimeContext.homeOverride } : {}),
        ...(runtimeContext.serverUrl ? { serverUrl: runtimeContext.serverUrl } : {}),
    }
    const restartCoordinator = createPendingAgentRestartCoordinator()
    const managedScriptLifecycle = createManagedScriptLifecycle({ client })
    const rootSessionTitleHook = createRootSessionTitleHook(client, directory)
    const { autocodeConfig, generatedSkills } = await preparePluginSkills(input, home)
    const smartAgentNames = new Set<string>()
    const runtimePermissions = new Map<string, V2PermissionRule[]>()
    const localMemoryRecallHook = createLocalMemoryRecallHook({
        context: { directory, worktree },
        fileSystem: {
            mkdir: async (directoryPath: string, options?: { recursive?: boolean }): Promise<string | undefined> => await mkdir(directoryPath, options),
            readFile: async (filePath: string, encoding: "utf8"): Promise<string> => await readFile(filePath, encoding),
            readdir: async (directoryPath: string, options?: { withFileTypes?: boolean }): Promise<string[] | Dirent[]> => options?.withFileTypes ? await readdir(directoryPath, { withFileTypes: true }) : await readdir(directoryPath),
            rename: async (oldPath: string, newPath: string): Promise<void> => await rename(oldPath, newPath),
            rm: async (filePath: string, options?: { recursive?: boolean, force?: boolean }): Promise<void> => await rm(filePath, options),
            writeFile: async (filePath: string, content: string): Promise<void> => await writeFile(filePath, content),
        },
        loadSessionContext: createOpenCodeLocalMemorySessionContextLoader(client, directory),
        isSmartAgent(agentName: string): boolean {
            return smartAgentNames.has(agentName)
        },
    })

    const builtAgents = buildAgents(capabilities, autocodeConfig.externalDirectoryPermissions, runtimeContext.sandboxSupportOverride, generatedSkills.externalSkills, autocodeConfig.tiers)
    smartAgentNames.clear()
    for (const [name, agent] of Object.entries(builtAgents)) if (agent.tier === "smart") smartAgentNames.add(name)
    const finalAgents = enforceSpyLearnDenial(preparePluginAgentsAfterOverrides(
        Object.fromEntries(Object.entries(builtAgents).map(([name, definition]) => [
            name,
            mergePluginAgentConfig(definition, autocodeConfig.tiers, undefined),
        ])),
        autocodeConfig.externalDirectories,
        runtimeContext.sandboxSupportOverride,
        generatedSkills.externalSkills,
        capabilities,
    ))

    await context.agent.transform((editor) => {
        for (const [name, definition] of Object.entries(finalAgents)) {
            if ((definition as Record<string, unknown>).disable === true) {
                editor.remove(name as never)
                runtimePermissions.delete(name)
                continue
            }
            const existing = editor.get(name as never) as unknown as Record<string, unknown> | undefined
            const converted = toV2Agent(name, definition)
            editor.update(name as never, (draft) => {
                mergeV2Agent(draft as unknown as Record<string, unknown>, converted, existing ? { ...existing } : undefined)
                enforceV2AgentSecurity(name, draft as unknown as Record<string, unknown>, isSandboxPlatformSupported(runtimeContext.sandboxSupportOverride ?? {}), capabilities.isWindows)
                const permissions = (draft as unknown as { permissions?: V2PermissionRule[] }).permissions ?? []
                runtimePermissions.set(name, permissions.map((rule) => ({ ...rule })))
            })
        }
    })

    const generatedSkillDefinitions = await discoverGeneratedSkills(generatedSkills.root)
    await context.skill.transform((editor) => {
        for (const skill of generatedSkillDefinitions) editor.add(skill as never)
    })

    const commands = createCommands(capabilities, autocodeConfig.tiers.spy !== undefined, autocodeConfig.tiers.smart !== undefined)
    await context.command.transform((editor) => {
        for (const [name, definition] of Object.entries(commands)) {
            editor.add({
                name,
                description: definition.description,
                async execute({ sessionID, prompt, delivery }) {
                    if (definition.agent) await context.session.switchAgent({ sessionID, agent: definition.agent })
                    await context.session.prompt({
                        ...prompt,
                        sessionID,
                        text: commandText(definition.template, prompt.text),
                        delivery,
                    })
                },
            })
        }
    })

    const tools = createTools(client, autocodeConfig.sandbox, {
        home,
        serverUrl: runtimeContext.serverUrl,
        activeSessionContext: ({ sessionID }) => context.session.context({ sessionID }),
        getWebUrl: () => process.env.AUTOCODE_WEB_URL,
        restartCoordinator,
        managedScriptLifecycle,
    }, capabilities)
    await context.tool.transform((editor) => {
        for (const [name, definition] of Object.entries(tools)) {
            editor.add({
                name,
                description: definition.description,
                input: z.object(definition.args),
                async execute(args, toolContext) {
                    // Retained V1 tools need a shaped context; V2 tool.transform owns registration.
                    const legacyContext: LegacyToolContext & { externalDirectoryPermissions?: V2PermissionRule[] } = {
                        sessionID: String(toolContext.sessionID),
                        messageID: String(toolContext.messageID),
                        agent: String(toolContext.agent),
                        directory,
                        worktree,
                        abort: toolContext.signal,
                        metadata(update) {
                            void toolContext.progress({ ...(update.metadata ?? {}), ...(update.title ? { title: update.title } : {}) })
                        },
                        ask: createLegacyAsk(() => runtimePermissions.get(String(toolContext.agent))),
                        externalDirectoryPermissions: runtimePermissions.get(String(toolContext.agent)),
                    }
                    return v2ToolResult(await definition.execute(args as never, legacyContext)) as never
                },
            })
        }
    })

    await context.session.hook("prompt", async (event) => {
        const session = await context.session.get({ sessionID: event.sessionID })
        const agent = session.agent
        if (typeof agent !== "string") return
        const originalText = event.prompt.text
        const output = {
            message: { id: event.messageID, role: "user", agent },
            parts: [{ id: `${event.messageID}-text`, sessionID: event.sessionID, messageID: event.messageID, type: "text", text: originalText }],
        }
        await localMemoryRecallHook["chat.message"]?.({ sessionID: event.sessionID } as never, output as never)
        const retainedMemoryParts = output.parts
            .map((part) => getRecord(part))
            .filter((part): part is Record<string, unknown> => part !== undefined
                && typeof part.text === "string"
                && getRecord(part.metadata)?.["autocode.local_memory"] === "v1")
            .map((part) => ({ text: part.text, metadata: part.metadata }))
        if (retainedMemoryParts.length > 0) {
            event.metadata = {
                ...event.metadata,
                [v2LocalMemoryOriginalTextMetadataKey]: originalText,
                [v2LocalMemoryPartsMetadataKey]: retainedMemoryParts,
            }
        }
        event.prompt.text = output.parts
            .filter((part): part is typeof output.parts[number] & { text: string } => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .filter(Boolean)
            .join("\n")
    })

    await context.shell.hook("create.before", (event) => {
        event.env.BUN_INSTALL = bunRoot
        event.env.PATH = prependPathEntry(event.env.PATH, bunBin, path.delimiter)
    })

    const eventController = new AbortController()
    const eventLoop = (async (): Promise<void> => {
        for await (const event of context.event.subscribe({ signal: eventController.signal })) {
            const normalized = normalizeV2Event(event) as never
            await localMemoryRecallHook.event?.({ event: normalized })
            await managedScriptLifecycle.handleEvent(normalized)
            try {
                await restartCoordinator.handleEvent(normalized)
            }
            finally {
                await rootSessionTitleHook.handleEvent(normalized)
                const titleEvent = v2TitleProgressEvent(event)
                if (titleEvent) await rootSessionTitleHook.handleEvent(titleEvent as never)
            }
        }
    })().catch((error) => {
        if (!eventController.signal.aborted) console.warn(`autocode: event subscription failed: ${error instanceof Error ? error.message : String(error)}`)
    })

    return async (): Promise<void> => {
        eventController.abort()
        await eventLoop
        const results = await Promise.allSettled([
            managedScriptLifecycle.dispose(),
            Promise.resolve(restartCoordinator.dispose()),
            Promise.resolve(localMemoryRecallHook.dispose?.()),
        ])
        for (const result of results) {
            if (result.status === "rejected") console.warn(`autocode: plugin lifecycle cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
        }
    }
}

const plugin = OpenCodePlugin.define({
    id: "autocode",
    setup: setupV2,
})

const autocode = {
    ...plugin,
    // V1 hosts still require the server hook; V2 hosts use setup instead.
    async server(input: PluginInput): Promise<Hooks> {
        return createPluginHooks(input as PluginInputWithSandboxSupportOverride)
    },
} satisfies LegacyPluginModule & OpenCodePlugin.Plugin

export default autocode
