import { afterAll, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent, type Plugin } from "@opencode/plugin"
import { Config as V2Config } from "@opencode/schema/config"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { SessionStatusEvent } from "@opencode/schema/session-status-event"
import { Tool } from "@opencode/schema/tool"
import { Schema } from "effect"
import { buildAgents } from "./agents"
import { createPendingAgentRestartCoordinator as createActualRestartCoordinator, type PendingAgentRestartCoordinator } from "./hooks/agent_restart_coordinator"
import { createManagedScriptLifecycle as createActualManagedScriptLifecycle, type ManagedScriptLifecycle } from "./hooks/managed_script_lifecycle"
import type { ManagedScriptRuntime, ManagedScriptServiceCleanupResult } from "./utils/managed_script_runtime"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { createTools } from "./tools"
import { clearAutocodeSkillLoadLiveCacheForTest } from "./tools/skill"
import { permissionEffect, type PermissionRule } from "./utils/permissions"
import { createPlatformCapabilities } from "./utils/platform"

type Registration = { dispose(): Promise<void> }
type AgentDefinition = Record<string, unknown>
type SkillDefinition = { id: string; name: string; description?: string; path: string; content: string }
type CommandDefinition = {
    name: string
    description?: string
    execute(input: { sessionID: string; prompt: { text: string }; delivery: "steer" | "queue" }): Promise<void>
}
type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]
type ToolDefinition = Parameters<ToolEditor["add"]>[0]
type V2ToolContext = Parameters<ToolDefinition["execute"]>[1]
type Hook = (event: Record<string, unknown>) => Promise<void> | void

const lifecycleEvents: unknown[] = []
const restartEvents: unknown[] = []
const cleanedSessions: string[] = []
const actualCreateRestartCoordinator = createActualRestartCoordinator
const actualCreateManagedScriptLifecycle = createActualManagedScriptLifecycle
let activeRestartCoordinator: PendingAgentRestartCoordinator | undefined
let activeManagedScriptLifecycle: ManagedScriptLifecycle | undefined
let activeClient: OpencodeClient | undefined
let lifecycleDisposed = false
let restartDisposed = false
let resolveEventHandled: (() => void) | undefined

mock.module("./hooks/managed_script_lifecycle", () => ({
    createManagedScriptLifecycle: (...args: Parameters<typeof actualCreateManagedScriptLifecycle>): ManagedScriptLifecycle => {
        activeClient = args[0]?.client
        const unusedServiceOperation = async (): Promise<never> => { throw new Error("Service operations must not run in event contract tests.") }
        const lifecycle = actualCreateManagedScriptLifecycle({
            ...args[0],
            runtimeFactory: ({ context }): ManagedScriptRuntime => ({
                run: unusedServiceOperation,
                start: unusedServiceOperation,
                status: unusedServiceOperation,
                stop: unusedServiceOperation,
                async cleanup(): Promise<ManagedScriptServiceCleanupResult> {
                    cleanedSessions.push(context.sessionID)
                    return { stopped_run_ids: [], finalized_run_ids: [] }
                },
            }),
        })
        activeManagedScriptLifecycle = lifecycle
        return {
            ...lifecycle,
            async handleEvent(event): Promise<void> {
                await lifecycle.handleEvent(event)
                lifecycleEvents.push(event)
            },
            async dispose(): Promise<void> {
                await lifecycle.dispose()
                lifecycleDisposed = true
            },
        }
    },
}))

mock.module("./hooks/agent_restart_coordinator", () => ({
    createPendingAgentRestartCoordinator: (...args: Parameters<typeof actualCreateRestartCoordinator>): PendingAgentRestartCoordinator => {
        const coordinator = actualCreateRestartCoordinator(...args)
        activeRestartCoordinator = coordinator
        return {
            ...coordinator,
            async handleEvent(event): Promise<void> {
                await coordinator.handleEvent(event)
                restartEvents.push(event)
                resolveEventHandled?.()
            },
            dispose(): void {
                coordinator.dispose()
                restartDisposed = true
            },
        }
    },
}))

const { default: autocode } = await import("./plugin")

afterAll(() => {
    mock.restore()
})

class TestEventStream {
    private readonly queued: unknown[] = []
    private waiter?: (event: unknown | undefined) => void

    emit(event: unknown): void {
        if (this.waiter !== undefined) {
            const waiter = this.waiter
            this.waiter = undefined
            waiter(event)
            return
        }
        this.queued.push(event)
    }

    async *subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown> {
        const signal = options?.signal
        while (!signal?.aborted) {
            const queued = this.queued.shift()
            if (queued !== undefined) {
                yield queued
                continue
            }
            const event = await new Promise<unknown | undefined>((resolve) => {
                const abort = (): void => {
                    if (this.waiter === resolve) this.waiter = undefined
                    resolve(undefined)
                }
                this.waiter = resolve
                signal?.addEventListener("abort", abort, { once: true })
            })
            if (event === undefined) return
            yield event
        }
    }
}

function createAgent(id: string, permissions: AgentDefinition[] = []): AgentDefinition {
    return {
        id,
        name: id,
        request: { settings: {}, headers: {}, body: {} },
        mode: "primary",
        hidden: false,
        permissions,
    }
}

function createRegistration(): Registration {
    return { async dispose(): Promise<void> {} }
}

test("V2 native depth config preserves user limits; runtime config patch cannot set depth", () => {
    for (const depth of [0, 1, 5, 8]) {
        const config = Schema.decodeUnknownSync(V2Config.Info)({ experimental: { subagent_depth: depth } })
        expect(config.experimental?.subagent_depth).toBe(depth)
    }
    expect(() => Schema.decodeUnknownSync(V2Config.Info)({ experimental: { subagent_depth: 1.5 } })).toThrow()
    expect(Object.keys(V2Config.Patch.fields)).toEqual(["shell"])
})

test.each(["linux", "win32"])("V2 setup honors native registration contracts and modeled host discovery without broadening permissions (%s)", async (platform): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "autocode-plugin-v2-"))
    const worktree = join(root, "worktree")
    const generatedSkillPath = join(root, ".agents", "skills", "autocode", "example", "SKILL.md")
    await mkdir(join(worktree, ".opencode"), { recursive: true })
    await mkdir(join(worktree, "docs"), { recursive: true })
    await mkdir(join(generatedSkillPath, ".."), { recursive: true })
    await writeFile(join(worktree, ".opencode", "autocode.jsonc"), JSON.stringify({
        autocode: {
            skills: { freeze: true },
            tiers: {
                smart: { model: "openai/smart#default", variant: "high" },
                balanced: { model: "openai/balanced", variant: "medium" },
                spy: { model: "openai/spy#preview" },
            },
        },
    }))
    await writeFile(join(worktree, "docs", "guide.md"), "# Guide\n\nRuntime behavior.\n")
    await writeFile(generatedSkillPath, "---\nname: example\ndescription: Example generated skill.\n---\n\nUse the example.\n")

    const agents = new Map<string, AgentDefinition>([
        ["build", createAgent("build")],
        ["explore", createAgent("explore")],
        ["general", createAgent("general")],
        ["plan", createAgent("plan")],
        ["auto-feature", { ...createAgent("auto-feature"), mode: "subagent", model: { providerID: "opencode", id: "default" } }],
        ["auto-research", { ...createAgent("auto-research"), mode: "subagent", model: { providerID: "anthropic", id: "override", variant: "fast" } }],
        ["query-text", { ...createAgent("query-text"), mode: "subagent", hidden: true }],
        ["spy", { ...createAgent("spy", [{ action: "learn", resource: "*", effect: "allow" }]), system: "V2 spy override" }],
        ["assist", { ...createAgent("assist", [
            { action: "*", resource: "*", effect: "allow" },
            { action: "external_directory", resource: "*", effect: "ask" },
            { action: "autocode_sandbox_copy", resource: "local_target", effect: "ask" },
            { action: "external_directory", resource: "/globally-allowed/*", effect: "allow" },
            { action: "subagent", resource: "auto-*", effect: "deny" },
            { action: "subagent", resource: "auto-research", effect: "deny" },
        ]), model: { providerID: "anthropic", id: "override", variant: "fast" }, system: "V2 assist override", steps: 8,
            request: { settings: { timeout: 2000 }, headers: { "x-custom": "value" }, body: { temperature: 0.6, top_p: 0.7, effort: "high" } },
        }],
    ])
    agents.set("auto", { ...createAgent("auto"), steps: 7 })
    const skills: SkillDefinition[] = []
    const commands = new Map<string, CommandDefinition>()
    const tools = new Map<string, ToolDefinition>()
    const registeredNames: string[] = []
    const sessionHooks = new Map<string, Hook>()
    const shellHooks = new Map<string, Hook>()
    const switchedAgents: unknown[] = []
    const prompts: unknown[] = []
    const sessionCalls: Array<{ operation: string; input: unknown }> = []
    const createdSessionID = Session.ID.make("ses_created")
    const contextCalls: { sessionID: string }[] = []
    let activeMessages: unknown[] = []
    const eventStream = new TestEventStream()
    const registration = createRegistration()
    const transform = async (callback: (editor: unknown) => void, editor: unknown): Promise<Registration> => {
        callback(editor)
        return registration
    }
    const context = {
        homeOverride: root,
        platformOverride: platform,
        sandboxSupportOverride: { platform, env: {}, bwrapUsable: true },
        location: {
            directory: worktree,
            project: { id: "project", directory: worktree, canonical: join(root, "canonical") },
        },
        agent: {
            transform: async (callback: (editor: unknown) => void): Promise<Registration> => transform(callback, {
                get(id: string): AgentDefinition | undefined {
                    return agents.get(id)
                },
                remove(id: string): void {
                    agents.delete(id)
                },
                update(id: string, update: (agent: AgentDefinition) => void): void {
                    const agent = agents.get(id) ?? createAgent(id)
                    update(agent)
                    agents.set(id, agent)
                },
            }),
        },
        skill: {
            transform: async (callback: (editor: unknown) => void): Promise<Registration> => transform(callback, {
                add(skill: SkillDefinition): void {
                    skills.push(skill)
                },
            }),
        },
        command: {
            transform: async (callback: (editor: unknown) => void): Promise<Registration> => transform(callback, {
                add(command: CommandDefinition): void {
                    commands.set(command.name, command)
                },
            }),
        },
        tool: {
            transform: async (callback: (editor: ToolEditor) => void): Promise<Registration> => {
                callback({
                    list: (): ReturnType<ToolEditor["list"]> => [...tools.values()].map((tool) => ({ ...tool, id: tool.name })),
                    get(id): ReturnType<ToolEditor["get"]> {
                        const tool = tools.get(id)
                        return tool ? { ...tool, id } : undefined
                    },
                    namespace(): void {},
                    add(tool: ToolDefinition): void {
                        registeredNames.push(tool.name)
                        tools.set(tool.name, tool)
                    },
                    update(id, update): void {
                        const tool = tools.get(id)
                        if (tool) update(tool)
                    },
                    remove(id): void {
                        tools.delete(id)
                    },
                } satisfies ToolEditor)
                return registration
            },
        },
        session: {
            hook: async (name: string, hook: Hook): Promise<Registration> => {
                sessionHooks.set(name, hook)
                return registration
            },
            async get({ sessionID }: { sessionID: string }): Promise<Record<string, unknown>> {
                return { id: sessionID, title: "Session", agent: "auto" }
            },
            async context(args: { sessionID: string }): Promise<readonly unknown[]> {
                contextCalls.push(args)
                return activeMessages
            },
            async switchAgent(input: { sessionID: string; agent: string }): Promise<void> {
                if (!agents.has(input.agent)) throw new Error(`Agent not found: ${input.agent}`)
                switchedAgents.push(input)
                sessionCalls.push({ operation: "switchAgent", input })
            },
            async switchModel(input: unknown): Promise<void> {
                sessionCalls.push({ operation: "switchModel", input })
            },
            async prompt(input: unknown): Promise<Record<string, unknown>> {
                prompts.push(input)
                sessionCalls.push({ operation: "prompt", input })
                return { id: "inbox" }
            },
            async create(input: unknown): Promise<Record<string, unknown>> {
                sessionCalls.push({ operation: "create", input })
                return { id: createdSessionID, title: "Created", agent: "auto" }
            },
            async update(input: unknown): Promise<void> {
                sessionCalls.push({ operation: "archive", input })
            },
        },
        shell: {
            hook: async (name: string, hook: Hook): Promise<Registration> => {
                shellHooks.set(name, hook)
                return registration
            },
        },
        event: {
            subscribe: (options?: { signal?: AbortSignal }): AsyncIterable<unknown> => eventStream.subscribe(options),
        },
    }

    const originalConfigDir = process.env.OPENCODE_CONFIG_DIR
    const originalBunInstall = process.env.BUN_INSTALL
    const originalPath = process.env.PATH
    process.env.OPENCODE_CONFIG_DIR = join(root, "config")
    let cleanup: Plugin.Cleanup | void = undefined
    try {
        expect((autocode as unknown as { id: string }).id).toBe("autocode")
        cleanup = await (autocode as unknown as { setup(input: unknown): Promise<Plugin.Cleanup | void> }).setup(context)

        if (activeClient === undefined) throw new Error("Native tool client was not initialized.")
        const expectedNames = Object.keys(createTools(activeClient, {}, {
            home: root,
            activeSessionContext: ({ sessionID }) => context.session.context({ sessionID }),
            getWebUrl: () => process.env.AUTOCODE_WEB_URL,
            restartCoordinator: activeRestartCoordinator,
            managedScriptLifecycle: activeManagedScriptLifecycle,
        }, createPlatformCapabilities(platform, process.env)))
        expect([...registeredNames].sort()).toEqual(expectedNames.sort())
        expect(new Set(registeredNames).size).toBe(registeredNames.length)
        expect(registeredNames).toContain("autocode_session_create")
        for (const tool of tools.values()) expect(tool.options?.codemode).toBe(false)
        expect(registeredNames.some((name) => name.startsWith("autocode_sandbox_"))).toBe(platform !== "win32")
        // Remaining execution and event contracts exercise the Linux sandbox fixture.
        if (platform === "win32") return

        expect(agents.has("explore")).toBe(false)
        expect(agents.has("general")).toBe(false)
        expect(agents.has("plan")).toBe(false)
        expect(agents.get("auto")).toEqual(expect.objectContaining({
            model: { providerID: "openai", id: "smart", variant: "high" },
            steps: 7,
            system: expect.any(String),
            request: { settings: {}, headers: {}, body: { temperature: 0.4 } },
        }))
        const autoSystem = String(agents.get("auto")?.system ?? "")
        expect(autoSystem).toContain("New task: call `subagent` with `agent`, `description`, and `prompt`; omit `sessionID`.")
        expect(autoSystem).toContain("Save the `sessionID` returned by `subagent` for followups.")
        expect(autoSystem).toContain("call `subagent` again with that returned `sessionID`")
        expect(autoSystem).not.toContain("task_id")
        expect(agents.get("spy")?.model).toEqual({ providerID: "openai", id: "spy", variant: "preview" })
        expect(agents.get("spy")?.system).toBe("V2 spy override")
        expect(agents.get("auto-feature")?.model).toEqual({ providerID: "openai", id: "smart", variant: "high" })
        expect(agents.get("auto-research")?.model).toEqual({ providerID: "openai", id: "smart", variant: "high" })
        expect(agents.get("assist")).toEqual(expect.objectContaining({
            model: { providerID: "openai", id: "balanced", variant: "medium" },
            system: "V2 assist override",
            steps: 8,
            request: {
                settings: { timeout: 2000 },
                headers: { "x-custom": "value" },
                body: { temperature: 0.6, top_p: 0.7, effort: "high" },
            },
        }))
        expect(agents.get("spy")?.permissions).toEqual(expect.arrayContaining([
            { action: "learn", resource: "*", effect: "deny" },
        ]))
        const spyRules = agents.get("spy")?.permissions as AgentDefinition[]
        expect(spyRules.at(-1)).toEqual({ action: "learn", resource: "*", effect: "deny" })
        const assistRules = agents.get("assist")?.permissions as AgentDefinition[]
        expect(assistRules.slice(0, 3)).toEqual([
            { action: "*", resource: "*", effect: "allow" },
            { action: "*", resource: "*", effect: "deny" },
            { action: "external_directory", resource: "*", effect: "ask" },
        ])
        expect(assistRules).toContainEqual({ action: "subagent", resource: "auto-research", effect: "allow" })
        expect(assistRules.slice(-3)).toEqual([
            { action: "external_directory", resource: "/globally-allowed/*", effect: "allow" },
            { action: "subagent", resource: "auto-*", effect: "deny" },
            { action: "subagent", resource: "auto-research", effect: "deny" },
        ])
        expect(permissionEffect(assistRules as PermissionRule[], "subagent", "auto-research")).toBe("deny")
        expect(permissionEffect(assistRules as PermissionRule[], "subagent", "auto-feature")).toBe("deny")
        expect(permissionEffect(assistRules as PermissionRule[], "external_directory", "/elsewhere/file.md")).toBe("ask")
        expect(permissionEffect(assistRules as PermissionRule[], "external_directory", "/globally-allowed/file.md")).toBe("allow")
        expect(permissionEffect(assistRules as PermissionRule[], "shell", "*")).toBe("deny")
        expect(assistRules.some((rule) => rule.action === "task" || rule.action === "bash")).toBe(false)
        expect(agents.get("execute-os")?.permissions).toContainEqual({ action: "shell", resource: "*", effect: "allow" })
        expect(agents.get("query-code")?.permissions).toContainEqual({ action: "external_directory", resource: "*", effect: "ask" })
        for (const agent of agents.values()) {
            expect(agent).not.toHaveProperty("disabled")
            expect(Array.isArray(agent.permissions)).toBe(true)
            expect(() => Schema.decodeUnknownSync(Agent.Info)(agent)).not.toThrow()
        }
        for (const name of ["auto", "assist", "spy", "execute-os", "query-code"]) {
            expect(Object.keys(agents.get(name) ?? {}).every((key) => ["id", "name", "model", "request", "system", "description", "mode", "hidden", "color", "steps", "permissions"].includes(key))).toBe(true)
        }

        expect(skills).toContainEqual(expect.objectContaining({
            id: "example",
            path: generatedSkillPath,
            content: "Use the example.",
        }))
        expect(commands.has("explain")).toBe(true)
        expect(tools.has("autocode_md_read")).toBe(true)
        for (const tool of tools.values()) expect(tool.options).toEqual({ codemode: false })
        for (const [agentName, toolName, resource] of [
            ["assist", "autocode_md_read", "*"],
            ["assist", "skill", "assist-example"],
            ["query-db", "autocode_db_table_read", "*"],
            ["execute-ssh", "autocode_ssh_command", "*"],
        ]) {
            const rules = agents.get(agentName)?.permissions as PermissionRule[]
            expect(permissionEffect(rules, "execute", "*")).toBe("deny")
            expect(permissionEffect(rules, toolName, resource)).toBe("allow")
            expect(tools.get(toolName)?.options?.codemode).toBe(false)
        }

        const definitions = buildAgents({ isWindows: false, commandEnvironment: "linux" }, {}, { platform: "linux", env: {}, bwrapUsable: true })
        for (const [name, definition] of Object.entries(definitions)) {
            if (definition.mode !== "subagent" || definition.disable || name === "query-text") continue
            expect(agents.get(name)).toEqual(expect.objectContaining({ mode: "subagent", hidden: false }))
        }
        expect(agents.get("query-text")).toEqual(expect.objectContaining({ mode: "subagent", hidden: true }))
        expect(agents.get("auto-general")).toEqual(expect.objectContaining({ mode: "all", hidden: true }))
        for (const [parent, child] of [["auto", "auto-author"], ["auto-author", "document-env"], ["document-env", "query-os"]]) {
            expect(permissionEffect(agents.get(parent)?.permissions as PermissionRule[], "subagent", child)).toBe("allow")
            expect(agents.get(child)).toEqual(expect.objectContaining({ mode: "subagent", hidden: false }))
        }
        for (const parent of ["assist", "advise", "auto", "design"]) {
            const rules = agents.get(parent)?.permissions as PermissionRule[]
            const advertised = [...agents.entries()]
                .filter(([name, agent]) => agent.mode !== "primary" && !agent.hidden && permissionEffect(rules, "subagent", name) !== "deny")
                .map(([name]) => name)
            expect(advertised).toContain("query-code")
            expect(advertised).not.toContain("query-text")
        }
        const primaryMenu = [...agents.entries()].filter(([, agent]) => agent.mode !== "subagent" && !agent.hidden).map(([name]) => name)
        expect(primaryMenu).not.toContain("query-code")
        expect(primaryMenu).not.toContain("execute-code")
        expect(primaryMenu).not.toContain("auto-general")
        expect(sessionHooks.has("prompt")).toBe(true)
        expect(shellHooks.has("create.before")).toBe(true)

        const promptEvent: Record<string, unknown> = {
            sessionID: "session-memory",
            messageID: "message-memory",
            prompt: { text: "Remember this", files: [], agents: [], skills: [] },
            delivery: "steer",
        }
        await sessionHooks.get("prompt")?.(promptEvent)
        expect(promptEvent.prompt).toEqual(expect.objectContaining({ text: "Remember this" }))
        expect(promptEvent.metadata).toEqual(expect.objectContaining({
            "autocode.local_memory.original_text": "Remember this",
            "autocode.local_memory.parts": [expect.objectContaining({ text: "" })],
        }))

        await commands.get("explain")?.execute({
            sessionID: "session-1",
            prompt: { text: "Explain this" },
            delivery: "queue",
        })
        expect(switchedAgents).toContainEqual({ sessionID: "session-1", agent: "query-code" })
        expect(prompts).toContainEqual(expect.objectContaining({
            sessionID: "session-1",
            delivery: "queue",
            text: expect.stringContaining("Explain this"),
        }))
        await context.session.switchAgent({ sessionID: "session-explicit", agent: "query-text" })
        await context.session.switchAgent({ sessionID: "session-explicit", agent: "auto-general" })
        expect(switchedAgents).toContainEqual({ sessionID: "session-explicit", agent: "query-text" })
        expect(switchedAgents).toContainEqual({ sessionID: "session-explicit", agent: "auto-general" })

        const toolResult = await tools.get("autocode_md_read")?.execute(
            { file_path_glob: "docs/guide.md", max_content_chars: 1000 },
            {
                sessionID: Session.ID.make("ses_1"),
                messageID: SessionMessage.ID.make("msg_1"),
                agent: Agent.ID.make("assist"),
                signal: new AbortController().signal,
                id: Tool.CallID.make("call-md-read"),
                progress: async (): Promise<void> => {},
            } satisfies V2ToolContext,
        )
        expect(toolResult?.content).toEqual(expect.stringContaining("guide"))
        const approvalResult = await tools.get("autocode_sandbox_copy")?.execute(
            { sandbox_name: "uncreated", sandbox_source: "source.txt", local_target: "target.txt" },
            {
                sessionID: Session.ID.make("ses_approval"),
                messageID: SessionMessage.ID.make("msg_approval"),
                agent: Agent.ID.make("assist"),
                signal: new AbortController().signal,
                id: Tool.CallID.make("call-approval"),
                progress: async (): Promise<void> => {},
            } satisfies V2ToolContext,
        )
        expect(approvalResult?.content).toEqual(expect.stringContaining("does not expose interactive permission requests"))
        expect(JSON.parse(String(approvalResult?.content)).failedAction).toBe("authorize sandbox copy")

        const skillContext = {
            sessionID: Session.ID.make("ses_skill_v2"),
            messageID: SessionMessage.ID.make("msg_skill_v2"),
            agent: Agent.ID.make("assist"),
            signal: new AbortController().signal,
            id: Tool.CallID.make("call-skill"),
            progress: async (): Promise<void> => {},
        } satisfies V2ToolContext
        const skillLoad = await tools.get("skill")?.execute({ name: "example" }, skillContext)
        const marker = String(skillLoad?.content).match(/<!-- skill identity=[^\n]+ hash=[a-f0-9]+ -->/)?.[0]
        expect(marker).toBeTruthy()
        expect(skillLoad?.content).toEqual(expect.stringContaining("Use the example."))
        activeMessages = [{ type: "assistant", content: [{ text: marker }] }]
        clearAutocodeSkillLoadLiveCacheForTest()
        const skippedSkill = await tools.get("skill")?.execute({ name: "example" }, skillContext)
        expect(skippedSkill?.content).toBe("")
        expect(contextCalls.filter((call) => call.sessionID === skillContext.sessionID)).toEqual([
            { sessionID: skillContext.sessionID },
            { sessionID: skillContext.sessionID },
        ])

        const environment: Record<string, string> = { PATH: "/usr/bin" }
        await shellHooks.get("create.before")?.({ env: environment })
        expect(environment).toEqual({
            BUN_INSTALL: `${root}/.bun`,
            PATH: `${root}/.bun/bin:/usr/bin`,
        })

        const coordinator = activeRestartCoordinator
        const lifecycle = activeManagedScriptLifecycle
        const client = activeClient
        if (coordinator === undefined || lifecycle === undefined || client === undefined) throw new Error("Native event consumers were not initialized.")
        const deletedSessionID = Session.ID.make("ses_deleted")
        const failedSessionID = Session.ID.make("ses_failed")
        const laterSessionID = Session.ID.make("ses_later")
        const nativeError = { type: "APIError", message: "Provider unavailable", status: 503 }
        const summarizedSessions: string[] = []
        for (const sessionID of [deletedSessionID, failedSessionID, laterSessionID]) {
            expect(coordinator.register({
                client,
                directory: worktree,
                sessionID,
                currentAgent: "assist",
                targetAgent: "assist",
                prompt: `Continue ${sessionID}`,
                resolvedModel: {},
                async summarize(): Promise<{ data: boolean }> {
                    summarizedSessions.push(sessionID)
                    return { data: true }
                },
            })).toBe("registered")
            lifecycle.registerStart({ sessionID, directory: worktree, worktree }, {
                run_id: `run-${sessionID}`,
                stdout_log_path: join(root, `${sessionID}.out`),
                stderr_log_path: join(root, `${sessionID}.err`),
            }, new AbortController().signal)
        }
        expect(coordinator.pendingCount()).toBe(3)

        const invalidEvents: unknown[] = [
            null,
            [],
            {},
            { type: " ", data: {} },
            { type: "session.deleted" },
            ...[null, [], {}, { info: { id: deletedSessionID } }, { sessionID: 42 }, { sessionID: "" }, { sessionID: " " }, { sessionID: "invalid-id" }]
                .map((data) => ({ type: "session.deleted", data })),
            { type: "session.status", data: { sessionID: deletedSessionID } },
            { type: "session.idle", data: {} },
            ...[
                { sessionID: failedSessionID },
                { sessionID: failedSessionID, error: null },
                { sessionID: failedSessionID, error: nativeError.message },
                { sessionID: failedSessionID, error: { message: nativeError.message } },
                { sessionID: failedSessionID, error: { type: nativeError.type } },
                { sessionID: failedSessionID, error: { name: "UnknownError", data: { message: nativeError.message } } },
                { sessionID: failedSessionID, error: { ...nativeError, status: 600 } },
                { sessionID: "invalid-id", error: nativeError },
            ].map((data) => ({ type: "session.execution.failed", data })),
        ]
        const invalidEventsHandled = new Promise<void>((resolve) => {
            resolveEventHandled = resolve
        })
        for (const event of invalidEvents) eventStream.emit(event)
        eventStream.emit(Schema.decodeUnknownSync(SessionStatusEvent.Status)({
            id: "evt_irrelevant",
            created: 0,
            type: "session.status",
            location: { directory: worktree },
            data: { sessionID: "ses_irrelevant", status: { type: "idle" } },
        }))
        await invalidEventsHandled
        expect(coordinator.pendingCount()).toBe(3)
        expect(cleanedSessions).toEqual([])
        expect(summarizedSessions).toEqual([])
        expect(lifecycleEvents).toHaveLength(1)
        expect(restartEvents).toHaveLength(1)

        const deletionHandled = new Promise<void>((resolve) => {
            resolveEventHandled = resolve
        })
        eventStream.emit(Schema.decodeUnknownSync(Session.Event.Deleted)({
            id: "evt_deleted",
            created: 0,
            type: "session.deleted",
            durable: { aggregateID: deletedSessionID, seq: 0, version: 2 },
            location: { directory: worktree },
            data: { sessionID: deletedSessionID },
        }))
        await deletionHandled
        expect(coordinator.pendingCount()).toBe(2)
        expect(cleanedSessions).toEqual([deletedSessionID])
        expect(summarizedSessions).toEqual([])
        const expectedDeletion = expect.objectContaining({
            type: "session.deleted",
            directory: worktree,
            properties: { sessionID: deletedSessionID, info: { id: deletedSessionID }, directory: worktree },
        })
        expect(lifecycleEvents).toContainEqual(expectedDeletion)
        expect(restartEvents).toContainEqual(expectedDeletion)

        for (const reason of ["user", "shutdown", "superseded", "inactivity"]) {
            const interruptionHandled = new Promise<void>((resolve) => {
                resolveEventHandled = resolve
            })
            eventStream.emit(Schema.decodeUnknownSync(Session.Event.Execution.Interrupted)({
                id: `evt_interrupted_${reason}`,
                created: 0,
                type: "session.execution.interrupted",
                durable: { aggregateID: laterSessionID, seq: 0, version: 1 },
                location: { directory: worktree },
                data: { sessionID: laterSessionID, reason },
            }))
            await interruptionHandled
            expect(coordinator.pendingCount()).toBe(2)
            expect(cleanedSessions).toEqual([deletedSessionID])
            expect(summarizedSessions).toEqual([])
            expect(restartEvents.at(-1)).toEqual(expect.objectContaining({
                type: "session.execution.interrupted",
                properties: { sessionID: laterSessionID, reason, directory: worktree },
            }))
            expect(restartEvents.at(-1)).not.toHaveProperty("properties.error")
        }

        const retryHandled = new Promise<void>((resolve) => {
            resolveEventHandled = resolve
        })
        eventStream.emit(Schema.decodeUnknownSync(SessionStatusEvent.Status)({
            id: "evt_retry",
            created: 0,
            type: "session.status",
            location: { directory: worktree },
            data: { sessionID: laterSessionID, status: { type: "retry", attempt: 1, message: "Retrying provider request", next: 1000 } },
        }))
        await retryHandled
        expect(coordinator.pendingCount()).toBe(2)
        expect(cleanedSessions).toEqual([deletedSessionID])
        expect(summarizedSessions).toEqual([])

        const failureHandled = new Promise<void>((resolve) => {
            resolveEventHandled = resolve
        })
        const failure = Schema.decodeUnknownSync(Session.Event.Execution.Failed)({
            id: "evt_failed",
            created: 0,
            type: "session.execution.failed",
            durable: { aggregateID: failedSessionID, seq: 0, version: 1 },
            location: { directory: worktree },
            data: { sessionID: failedSessionID, error: nativeError },
        })
        eventStream.emit(failure)
        await failureHandled
        expect(coordinator.pendingCount()).toBe(1)
        expect(cleanedSessions).toEqual([deletedSessionID, failedSessionID])
        expect(summarizedSessions).toEqual([])
        const expectedFailure = expect.objectContaining({
            type: "session.error",
            data: failure.data,
            directory: worktree,
            properties: { sessionID: failedSessionID, error: failure.data.error, directory: worktree },
        })
        expect(lifecycleEvents).toContainEqual(expectedFailure)
        expect(restartEvents).toContainEqual(expectedFailure)
        expect(restartEvents.at(-1)).not.toHaveProperty("properties.error.name")

        const failedIdleHandled = new Promise<void>((resolve) => {
            resolveEventHandled = resolve
        })
        eventStream.emit(Schema.decodeUnknownSync(SessionStatusEvent.Idle)({
            id: "evt_failed_idle",
            created: 0,
            type: "session.idle",
            location: { directory: worktree },
            data: { sessionID: failedSessionID },
        }))
        await failedIdleHandled
        expect(coordinator.pendingCount()).toBe(1)
        expect(cleanedSessions).toEqual([deletedSessionID, failedSessionID])
        expect(summarizedSessions).toEqual([])
        expect(prompts).not.toContainEqual(expect.objectContaining({ sessionID: failedSessionID }))

        const eventHandled = new Promise<void>((resolve) => {
            resolveEventHandled = resolve
        })
        eventStream.emit(Schema.decodeUnknownSync(SessionStatusEvent.Idle)({
            id: "evt_later",
            created: 0,
            type: "session.idle",
            location: { directory: worktree },
            data: { sessionID: laterSessionID },
        }))
        await eventHandled
        expect(lifecycleEvents).toContainEqual(expect.objectContaining({
            type: "session.idle",
            directory: worktree,
            properties: { sessionID: laterSessionID, directory: worktree },
        }))
        expect(restartEvents).toContainEqual(expect.objectContaining({ type: "session.idle" }))
        expect(coordinator.pendingCount()).toBe(0)
        expect(cleanedSessions).toEqual([deletedSessionID, failedSessionID, laterSessionID])
        expect(summarizedSessions).toEqual([laterSessionID])
        expect(prompts).toContainEqual(expect.objectContaining({ sessionID: laterSessionID, text: `Continue ${laterSessionID}` }))

        const handoffSourceID = Session.ID.make("ses_handoff_source")
        const handoffMessageID = SessionMessage.ID.make("msg_handoff_source")
        const handoffPrompt = "Continue the requested task exactly.\nPreserve this second line."
        const handoffCallsStart = sessionCalls.length
        const createResult = await tools.get("autocode_session_create")?.execute(
            { prompt: handoffPrompt, agent: "assist" },
            {
                sessionID: handoffSourceID,
                messageID: handoffMessageID,
                agent: Agent.ID.make("auto"),
                signal: new AbortController().signal,
                id: Tool.CallID.make("call-session-create"),
                progress: async (): Promise<void> => {},
            } satisfies V2ToolContext,
        )
        expect(JSON.parse(String(createResult?.content))).toMatchObject({ session_id: createdSessionID })
        const expectedHandoffCalls = [
            { operation: "create", input: { title: "Session (assist)", location: { directory: worktree } } },
            { operation: "archive", input: { sessionID: handoffSourceID, title: expect.stringMatching(/^Session \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\)$/) } },
            { operation: "switchAgent", input: { sessionID: createdSessionID, agent: "assist" } },
            { operation: "switchModel", input: { sessionID: createdSessionID, model: { providerID: "openai", id: "balanced", variant: "medium" } } },
            { operation: "prompt", input: { sessionID: createdSessionID, text: handoffPrompt, delivery: "queue" } },
        ]
        expect(sessionCalls.slice(handoffCallsStart)).toEqual(expectedHandoffCalls.slice(0, 1))
        expect(coordinator.pendingCount()).toBe(1)

        const toolCallsBoundary = Schema.decodeUnknownSync(Session.Event.Step.Ended)({
            id: "evt_handoff_tool_calls",
            created: 0,
            type: "session.step.ended",
            durable: { aggregateID: handoffSourceID, seq: 0, version: 1 },
            location: { directory: worktree },
            data: {
                sessionID: handoffSourceID,
                assistantMessageID: handoffMessageID,
                finish: "tool-calls",
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
        })
        const handoffHandled = new Promise<void>((resolve) => {
            resolveEventHandled = resolve
        })
        eventStream.emit(toolCallsBoundary)
        await handoffHandled
        expect(sessionCalls.slice(handoffCallsStart)).toEqual(expectedHandoffCalls)
        expect(coordinator.pendingCount()).toBe(0)

        for (const event of [
            toolCallsBoundary,
            Schema.decodeUnknownSync(Session.Event.Step.Ended)({
                ...toolCallsBoundary,
                id: "evt_handoff_stop",
                durable: { aggregateID: handoffSourceID, seq: 1, version: 1 },
                data: { ...toolCallsBoundary.data, finish: "stop" },
            }),
            Schema.decodeUnknownSync(SessionStatusEvent.Idle)({
                id: "evt_handoff_idle",
                created: 0,
                type: "session.idle",
                location: { directory: worktree },
                data: { sessionID: handoffSourceID },
            }),
        ]) {
            const duplicateHandled = new Promise<void>((resolve) => {
                resolveEventHandled = resolve
            })
            eventStream.emit(event)
            await duplicateHandled
            expect(sessionCalls.slice(handoffCallsStart)).toEqual(expectedHandoffCalls)
            expect(coordinator.pendingCount()).toBe(0)
        }
        await cleanup?.()
        cleanup = undefined
        expect(lifecycleDisposed).toBe(true)
        expect(restartDisposed).toBe(true)
    }
    finally {
        resolveEventHandled = undefined
        await cleanup?.()
        if (originalConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
        else process.env.OPENCODE_CONFIG_DIR = originalConfigDir
        if (originalBunInstall === undefined) delete process.env.BUN_INSTALL
        else process.env.BUN_INSTALL = originalBunInstall
        if (originalPath === undefined) delete process.env.PATH
        else process.env.PATH = originalPath
        await rm(root, { recursive: true, force: true })
    }
})
