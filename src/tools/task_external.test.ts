import { describe, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import { createTaskProjectTool } from "./task_external"
import { createAskEffect, createNoopAsk } from "./test_context"
import { createAbortResponse } from "@/utils/tools"
import type { ToolContext } from "@opencode-ai/plugin"

type AskRequest = {
    permission: string
    patterns: string[]
    always: string[]
    metadata: Record<string, unknown>
}

type ExternalToolContext = ToolContext & {
    ask?: ToolContext["ask"]
}

function createAsk(run: (request: AskRequest) => void | Promise<void>): ToolContext["ask"] {
    return createAskEffect((request) => run(request as AskRequest))
}

function parseToolResult(result: string | { output: string }) {
    return JSON.parse(typeof result === "string" ? result : result.output)
}

function createMockStat(isDirectory = true) {
    return mock(async (_path: string) => ({
        isDirectory: () => isDirectory,
    }))
}

function createMockRealpath() {
    return mock(async (path: string) => path)
}

function createExpectedPatterns(path: string): string[] {
    return [path, `${path}/*`]
}

function createToolContext(overrides: Partial<ExternalToolContext> = {}): ExternalToolContext {
    return {
        sessionID: "session-1",
        messageID: "message-1",
        agent: "auto",
        directory: "/workspace",
        worktree: "/workspace",
        abort: new AbortController().signal,
        metadata() {
        },
        ask: createNoopAsk(),
        ...overrides,
    }
}

function createChildProcess() {
    const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { setEncoding: ReturnType<typeof mock> }
        stderr: EventEmitter & { setEncoding: ReturnType<typeof mock> }
    }
    child.stdout = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof mock> }
    child.stderr = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof mock> }
    child.stdout.setEncoding = mock((_encoding: string) => child.stdout)
    child.stderr.setEncoding = mock((_encoding: string) => child.stderr)
    return child
}

type SpawnOptions = {
    stdio: ["ignore", "pipe", "pipe"]
    env?: NodeJS.ProcessEnv
}

type SpawnCall = {
    command: string
    args: string[]
    options: {
        stdio: ["ignore", "pipe", "pipe"]
        env?: NodeJS.ProcessEnv
    }
}

function getSpawnCall(spawn: ReturnType<typeof mock>, index = 0): SpawnCall {
    const call = spawn.mock.calls[index]
    if (!call) throw new Error(`Expected spawn call at index ${index}`)
    return {
        command: call[0],
        args: call[1],
        options: call[2],
    }
}

async function withEnv(entries: Record<string, string | undefined>, run: () => Promise<void> | void): Promise<void> {
    const originals = new Map<string, string | undefined>()

    for (const [key, value] of Object.entries(entries)) {
        originals.set(key, process.env[key])
        if (value === undefined) {
            delete process.env[key]
            continue
        }

        process.env[key] = value
    }

    try {
        await run()
    }
    finally {
        for (const [key, value] of originals) {
            if (value === undefined) {
                delete process.env[key]
                continue
            }

            process.env[key] = value
        }
    }
}

describe("task_external tool", () => {
    test("returns retry response for missing or blank target_directory", async () => {
        const stat = createMockStat()
        const realpath = createMockRealpath()
        const spawn = mock((_command: string, _args: string[], _options: SpawnOptions) => createChildProcess())
        const tool = createTaskProjectTool({ stat, realpath, spawn })

        const missingResult = parseToolResult(await tool.execute({ prompt: "Do it" } as any, createToolContext()))
        const blankResult = parseToolResult(await tool.execute({ target_directory: "   ", prompt: "Do it" }, createToolContext()))

        expect(missingResult).toEqual({
            failedAction: "start project task",
            error: "Missing required argument: target_directory",
            instruction: "Provide the target project directory path.",
        })
        expect(blankResult).toEqual(missingResult)
        expect(stat).not.toHaveBeenCalled()
        expect(spawn).not.toHaveBeenCalled()
    })

    test("returns retry response for missing or blank prompt", async () => {
        const stat = createMockStat()
        const realpath = createMockRealpath()
        const spawn = mock((_command: string, _args: string[], _options: SpawnOptions) => createChildProcess())
        const tool = createTaskProjectTool({ stat, realpath, spawn })

        const missingResult = parseToolResult(await tool.execute({ target_directory: "/project" } as any, createToolContext()))
        const blankResult = parseToolResult(await tool.execute({ target_directory: "/project", prompt: "   " }, createToolContext()))

        expect(missingResult).toEqual({
            failedAction: "start project task",
            error: "Missing required argument: prompt",
            instruction: "Provide the prompt or task to send to the spawned opencode session.",
        })
        expect(blankResult).toEqual(missingResult)
        expect(stat).not.toHaveBeenCalled()
        expect(spawn).not.toHaveBeenCalled()
    })

    test("returns retry response when stat fails for missing directory", async () => {
        const stat = mock(async (_path: string) => { throw new Error("Not found") })
        const realpath = createMockRealpath()
        const spawn = mock((_command: string, _args: string[], _options: SpawnOptions) => createChildProcess())
        const tool = createTaskProjectTool({ stat, realpath, spawn })

        const result = parseToolResult(await tool.execute({ target_directory: "/missing", prompt: "Do it" }, createToolContext()))

        expect(result).toEqual({
            failedAction: "start project task",
            error: "Not found",
            instruction: "Provide an existing project directory path.",
        })
        expect(stat).toHaveBeenCalledWith("/missing")
        expect(spawn).not.toHaveBeenCalled()
    })

    test("resolves relative target_directory from the canonical context directory before asking and spawning", async () => {
        const events: string[] = []
        const stat = mock(async (path: string) => {
            events.push(`stat:${path}`)
            return { isDirectory: () => true }
        })
        const realpath = mock(async (path: string) => {
            events.push(`realpath:${path}`)
            if (path === "/workspace") {
                return "/canonical/workspace"
            }

            if (path === "/canonical/workspace/linked-project") {
                return "/real/projects/linked-project"
            }

            return path
        })
        const askCalls: AskRequest[] = []
        const ask = createAsk(async (request: AskRequest) => {
            events.push("ask")
            askCalls.push(request)
        })
        const child = createChildProcess()
        const spawn = mock((_command: string, _args: string[], _options: SpawnOptions) => {
            events.push("spawn")
            queueMicrotask(() => child.emit("close", 0, null))
            return child
        })
        const tool = createTaskProjectTool({ stat, realpath, spawn })

        await tool.execute(
            { target_directory: "./linked-project", prompt: "Do it" },
            createToolContext({ directory: "/workspace", ask })
        )

        expect(realpath.mock.calls.map((call) => call[0])).toEqual([
            "/workspace",
            "/canonical/workspace/linked-project",
        ])
        expect(stat.mock.calls.map((call) => call[0])).toEqual([
            "/canonical/workspace/linked-project",
            "/real/projects/linked-project",
        ])
        expect(askCalls).toHaveLength(1)
        expect(askCalls[0]).toEqual({
            permission: "external_directory",
            patterns: createExpectedPatterns("/real/projects/linked-project"),
            always: createExpectedPatterns("/real/projects/linked-project"),
            metadata: {
                tool: "task_external",
                target_directory: "/real/projects/linked-project",
                requested_target_directory: "./linked-project",
                context_directory: "/workspace",
                resolved_context_directory: "/canonical/workspace",
                resolved_target_directory: "/canonical/workspace/linked-project",
            },
        })
        expect(events).toEqual([
            "realpath:/workspace",
            "stat:/canonical/workspace/linked-project",
            "realpath:/canonical/workspace/linked-project",
            "stat:/real/projects/linked-project",
            "ask",
            "spawn",
        ])
        expect(getSpawnCall(spawn).args).toEqual([
            "run",
            "--dir",
            "/real/projects/linked-project",
            "--agent",
            "auto",
            "Do it",
        ])
    })

    test("returns retry response for non-directory stat result", async () => {
        const stat = createMockStat(false)
        const realpath = createMockRealpath()
        const spawn = mock((_command: string, _args: string[], _options: SpawnOptions) => createChildProcess())
        const tool = createTaskProjectTool({ stat, realpath, spawn })

        const result = parseToolResult(await tool.execute({ target_directory: "/file.txt", prompt: "Do it" }, createToolContext()))

        expect(result).toEqual({
            failedAction: "start project task",
            error: "/file.txt is not a directory",
            instruction: "Provide an existing project directory path.",
        })
        expect(spawn).not.toHaveBeenCalled()
    })

    test("canonicalizes absolute target_directory before asking and spawning", async () => {
        const stat = createMockStat()
        const realpath = mock(async (path: string) => {
            if (path === "/links/project") {
                return "/real/project"
            }

            return path
        })
        const askCalls: AskRequest[] = []
        const ask = createAsk(async (request: AskRequest) => {
            askCalls.push(request)
        })
        const child = createChildProcess()
        const spawn = mock((_command: string, _args: string[], _options: SpawnOptions) => {
            queueMicrotask(() => child.emit("close", 0, null))
            return child
        })
        const tool = createTaskProjectTool({ stat, realpath, spawn })

        await tool.execute({ target_directory: "/links/project", prompt: "Do it" }, createToolContext({ ask }))

        expect(stat.mock.calls.map((call) => call[0])).toEqual([
            "/links/project",
            "/real/project",
        ])
        expect(askCalls[0]).toEqual({
            permission: "external_directory",
            patterns: createExpectedPatterns("/real/project"),
            always: createExpectedPatterns("/real/project"),
            metadata: {
                tool: "task_external",
                target_directory: "/real/project",
                requested_target_directory: "/links/project",
                context_directory: "/workspace",
                resolved_context_directory: undefined,
                resolved_target_directory: "/links/project",
            },
        })
        expect(getSpawnCall(spawn).args).toEqual([
            "run",
            "--dir",
            "/real/project",
            "--agent",
            "auto",
            "Do it",
        ])
    })

    test("asks before spawning opencode", async () => {
        const stat = createMockStat()
        const realpath = createMockRealpath()
        const events: string[] = []
        const ask = createAsk(async (_request: AskRequest) => {
            events.push("ask")
        })
        const child = createChildProcess()
        const spawn = mock((_command: string, _args: string[], _options: SpawnOptions) => {
            events.push("spawn")
            queueMicrotask(() => child.emit("close", 0, null))
            return child
        })
        const tool = createTaskProjectTool({ stat, realpath, spawn })

        await tool.execute({ target_directory: "/project", prompt: "Do it" }, createToolContext({ ask }))

        expect(events).toEqual(["ask", "spawn"])
    })

    test("returns abort response and never spawns when ask rejects", async () => {
        const stat = createMockStat()
        const realpath = createMockRealpath()
        const askError = new Error("permission denied")
        const ask = createAsk(async (_request: AskRequest) => {
            throw askError
        })
        const spawn = mock((_command: string, _args: string[], _options: SpawnOptions) => createChildProcess())
        const tool = createTaskProjectTool({ stat, realpath, spawn })

        const result = await tool.execute({ target_directory: "/project", prompt: "Do it" }, createToolContext({ ask }))

        expect(result).toBe(createAbortResponse("authorize external directory", askError))
        expect(spawn).not.toHaveBeenCalled()
    })

    test("returns abort response and never spawns when ask returns a non-promise result", async () => {
        const stat = createMockStat()
        const realpath = createMockRealpath()
        const ask = mock((_request: AskRequest) => undefined)
        const spawn = mock((_command: string, _args: string[], _options: SpawnOptions) => createChildProcess())
        const tool = createTaskProjectTool({ stat, realpath, spawn })

        const result = await tool.execute(
            { target_directory: "/project", prompt: "Do it" },
            createToolContext({ ask: ask as unknown as ExternalToolContext["ask"] })
        )

        expect(result).toBe(createAbortResponse("authorize external directory", "Tool context ask() returned a non-promise result"))
        expect(spawn).not.toHaveBeenCalled()
    })

    test("runs opencode with general agent", async () => {
        const stat = createMockStat()
        const realpath = createMockRealpath()
        const child = createChildProcess()
        const spawn = mock((_command: string, _args: string[], _options: SpawnOptions) => {
            queueMicrotask(() => {
                child.stdout.emit("data", "done")
                child.stderr.emit("data", "warn")
                child.emit("close", 0, null)
            })
            return child
        })
        const tool = createTaskProjectTool({ stat, realpath, spawn })

        const result = await tool.execute({ target_directory: "/project", prompt: "Do it" }, createToolContext())

        expect(spawn).toHaveBeenCalledTimes(1)
        expect(getSpawnCall(spawn, 0).command).toBe("opencode")
        expect(getSpawnCall(spawn, 0).args).toEqual(["run", "--dir", "/project", "--agent", "auto", "Do it"])
        expect(getSpawnCall(spawn, 0).options.stdio).toEqual(["ignore", "pipe", "pipe"])
        expect(getSpawnCall(spawn, 0).options.env).toBeDefined()
        expect(result).toBe(JSON.stringify({
            target_directory: "/project",
            status: "completed",
            exit_code: 0,
            signal: null,
            stdout: "done",
            stderr: "warn",
        }))
    })

    test("returns abort response for non-zero exit code", async () => {
        const stat = createMockStat()
        const realpath = createMockRealpath()
        const child = createChildProcess()
        const spawn = mock((_command: string, _args: string[], _options: SpawnOptions) => {
            queueMicrotask(() => child.emit("close", 2, null))
            return child
        })
        const tool = createTaskProjectTool({ stat, realpath, spawn })

        const result = await tool.execute({ target_directory: "/project", prompt: "Do it" }, createToolContext())

        expect(result).toBe(createAbortResponse("run project task", {
            stdout: "",
            stderr: "",
            exitCode: 2,
            signal: null,
        }))
    })

    test("returns abort response for spawn error", async () => {
        const stat = createMockStat()
        const realpath = createMockRealpath()
        const child = createChildProcess()
        const error = new Error("spawn failed")
        const spawn = mock((_command: string, _args: string[], _options: SpawnOptions) => {
            queueMicrotask(() => child.emit("error", error))
            return child
        })
        const tool = createTaskProjectTool({ stat, realpath, spawn })

        const result = await tool.execute({ target_directory: "/project", prompt: "Do it" }, createToolContext())

        expect(result).toBe(createAbortResponse("start project task", error))
    })

    test("sanitizes spawned opencode environment without mutating process.env", async () => {
        await withEnv({
            AGENT: "parent-agent",
            OPENCODE_SESSION: "session-value",
            OPENCODE_BINARY: "/custom/opencode",
            OPENCODE_CONFIG: "/config/opencode.jsonc",
            OPENCODE_CONFIG_DIR: "/config",
            PATH: "/usr/bin",
            HOME: "/home/tester",
            TASK_EXTERNAL_TEST_VAR: "preserved",
        }, async () => {
            const stat = createMockStat()
            const realpath = createMockRealpath()
            const child = createChildProcess()
            const spawn = mock((_command: string, _args: string[], _options: SpawnOptions) => {
                queueMicrotask(() => child.emit("close", 0, null))
                return child
            })
            const tool = createTaskProjectTool({ stat, realpath, spawn })
            const originalAgent = process.env.AGENT
            const originalSession = process.env.OPENCODE_SESSION
            const originalBinary = process.env.OPENCODE_BINARY
            const originalConfig = process.env.OPENCODE_CONFIG
            const originalConfigDir = process.env.OPENCODE_CONFIG_DIR
            const originalTaskVar = process.env.TASK_EXTERNAL_TEST_VAR
            const originalPath = process.env.PATH

            await tool.execute({ target_directory: "/project", prompt: "Do it" }, createToolContext())

            const spawnCall = getSpawnCall(spawn)
            const env = spawnCall.options.env

            expect(spawnCall.command).toBe("opencode")
            expect(spawnCall.args).toEqual(["run", "--dir", "/project", "--agent", "auto", "Do it"])
            expect(spawnCall.options.stdio).toEqual(["ignore", "pipe", "pipe"])
            expect(env).toBeDefined()
            expect(env).not.toBe(process.env)
            expect(env?.AGENT).toBeUndefined()
            expect(env?.OPENCODE_SESSION).toBeUndefined()
            expect(env?.OPENCODE_BINARY).toBe(originalBinary)
            expect(env?.OPENCODE_CONFIG).toBe(originalConfig)
            expect(env?.OPENCODE_CONFIG_DIR).toBe(originalConfigDir)
            expect(env?.TASK_EXTERNAL_TEST_VAR).toBe(originalTaskVar)
            expect(env?.PATH).toBe(originalPath)
            expect(process.env.AGENT).toBe(originalAgent)
            expect(process.env.OPENCODE_SESSION).toBe(originalSession)
            expect(process.env.OPENCODE_BINARY).toBe(originalBinary)
            expect(process.env.OPENCODE_CONFIG).toBe(originalConfig)
            expect(process.env.OPENCODE_CONFIG_DIR).toBe(originalConfigDir)
            expect(process.env.TASK_EXTERNAL_TEST_VAR).toBe(originalTaskVar)
        })
    })
})
