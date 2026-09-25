import { afterAll, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearAutocodeSkillLoadLiveCacheForTest } from "./tools/skill"
import { permissionEffect, type PermissionRule } from "./utils/permissions"

type Registration = { dispose(): Promise<void> }
type AgentDefinition = Record<string, unknown>
type SkillDefinition = { id: string; name: string; description?: string; path: string; content: string }
type CommandDefinition = {
    name: string
    description?: string
    execute(input: { sessionID: string; prompt: { text: string }; delivery: "steer" | "queue" }): Promise<void>
}
type ToolDefinition = {
    name: string
    description: string
    input: unknown
    execute(input: unknown, context: Record<string, unknown>): Promise<{ content?: unknown; metadata?: Record<string, unknown> }>
}
type Hook = (event: Record<string, unknown>) => Promise<void> | void

const lifecycleEvents: unknown[] = []
const restartEvents: unknown[] = []
let lifecycleDisposed = false
let restartDisposed = false
let resolveEventHandled: (() => void) | undefined

mock.module("./hooks/managed_script_lifecycle", () => ({
    createManagedScriptLifecycle: () => ({
        registerStart(): void {},
        async handleEvent(event: unknown): Promise<void> {
            lifecycleEvents.push(event)
        },
        async dispose(): Promise<void> {
            lifecycleDisposed = true
        },
    }),
}))

mock.module("./hooks/agent_restart_coordinator", () => ({
    createPendingAgentRestartCoordinator: () => ({
        register: () => "registered",
        registerHandoff: () => ({
            status: "registered",
            sourceSessionID: "source-session",
            destinationSessionID: "destination-session",
        }),
        async handleEvent(event: unknown): Promise<void> {
            restartEvents.push(event)
            resolveEventHandled?.()
        },
        dispose(): void {
            restartDisposed = true
        },
        pendingCount: () => 0,
    }),
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

test("V2 setup registers runtime behavior and cleans up event resources", async () => {
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
                balanced: { model: "openai/balanced" },
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
        ["auto-feature", { ...createAgent("auto-feature"), model: { providerID: "opencode", id: "default" } }],
        ["auto-research", { ...createAgent("auto-research"), model: { providerID: "anthropic", id: "override", variant: "fast" } }],
        ["spy", { ...createAgent("spy", [{ action: "learn", resource: "*", effect: "allow" }]), system: "V2 spy override" }],
        ["assist", { ...createAgent("assist", [
            { action: "*", resource: "*", effect: "allow" },
            { action: "external_directory", resource: "*", effect: "ask" },
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
    const sessionHooks = new Map<string, Hook>()
    const shellHooks = new Map<string, Hook>()
    const switchedAgents: unknown[] = []
    const prompts: unknown[] = []
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
        platformOverride: "linux",
        sandboxSupportOverride: { platform: "linux", env: {}, bwrapUsable: true },
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
            transform: async (callback: (editor: unknown) => void): Promise<Registration> => transform(callback, {
                add(tool: ToolDefinition): void {
                    tools.set(tool.name, tool)
                },
            }),
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
            async switchAgent(input: unknown): Promise<void> {
                switchedAgents.push(input)
            },
            async switchModel(): Promise<void> {},
            async prompt(input: unknown): Promise<Record<string, unknown>> {
                prompts.push(input)
                return { id: "inbox" }
            },
            async create(): Promise<Record<string, unknown>> {
                return { id: "created", title: "Created", agent: "auto" }
            },
            async update(): Promise<void> {},
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

    try {
        expect((autocode as unknown as { id: string }).id).toBe("autocode")
        const cleanup = await (autocode as unknown as { setup(input: unknown): Promise<(() => Promise<void> | void) | void> }).setup(context)

        expect(agents.has("build")).toBe(false)
        expect(agents.has("explore")).toBe(false)
        expect(agents.has("general")).toBe(false)
        expect(agents.has("plan")).toBe(false)
        expect(agents.get("auto")).toEqual(expect.objectContaining({
            model: { providerID: "openai", id: "smart", variant: "high" },
            steps: 7,
            system: expect.any(String),
            request: { settings: {}, headers: {}, body: { temperature: 0.4 } },
        }))
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

        const toolResult = await tools.get("autocode_md_read")?.execute(
            { file_path_glob: "docs/guide.md", max_content_chars: 1000 },
            {
                sessionID: "session-1",
                messageID: "message-1",
                agent: "assist",
                signal: new AbortController().signal,
                progress: async (): Promise<void> => {},
            },
        )
        expect(toolResult?.content).toEqual(expect.stringContaining("guide"))

        const skillContext = {
            sessionID: "session-skill-v2",
            messageID: "message-skill-v2",
            agent: "assist",
            signal: new AbortController().signal,
            progress: async (): Promise<void> => {},
        }
        const skillLoad = await tools.get("skill")?.execute({ name: "example" }, skillContext)
        const marker = String(skillLoad?.content).match(/<!-- skill identity=[^\n]+ hash=[a-f0-9]+ -->/)?.[0]
        expect(marker).toBeTruthy()
        expect(skillLoad?.content).toEqual(expect.stringContaining("Use the example."))
        activeMessages = [{ type: "assistant", content: [{ text: marker }] }]
        clearAutocodeSkillLoadLiveCacheForTest()
        const skippedSkill = await tools.get("skill")?.execute({ name: "example" }, skillContext)
        expect(skippedSkill?.content).toBe("")
        expect(contextCalls.filter((call) => call.sessionID === "session-skill-v2")).toEqual([
            { sessionID: "session-skill-v2" },
            { sessionID: "session-skill-v2" },
        ])

        const environment: Record<string, string> = { PATH: "/usr/bin" }
        await shellHooks.get("create.before")?.({ env: environment })
        expect(environment).toEqual({
            BUN_INSTALL: `${root}/.bun`,
            PATH: `${root}/.bun/bin:/usr/bin`,
        })

        const eventHandled = new Promise<void>((resolve) => {
            resolveEventHandled = resolve
        })
        eventStream.emit({
            type: "session.idle",
            location: { directory: worktree },
            data: { sessionID: "session-1" },
        })
        await eventHandled
        expect(lifecycleEvents).toContainEqual(expect.objectContaining({
            type: "session.idle",
            directory: worktree,
            properties: { sessionID: "session-1", directory: worktree },
        }))
        expect(restartEvents).toContainEqual(expect.objectContaining({ type: "session.idle" }))

        await cleanup?.()
        expect(lifecycleDisposed).toBe(true)
        expect(restartDisposed).toBe(true)
    }
    finally {
        resolveEventHandled = undefined
        await rm(root, { recursive: true, force: true })
    }
})
