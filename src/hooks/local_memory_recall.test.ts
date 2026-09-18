import { describe, expect, test } from "bun:test"
import type { Part, TextPart } from "@opencode-ai/sdk"
import {
    createLocalMemoryRecallHook,
    createOpenCodeLocalMemorySessionContextLoader,
    type LocalMemoryRecallDependencies,
    type LocalMemoryRecallDiagnostic,
    type LocalMemoryRecallChatMessageInput,
    type LocalMemoryRecallChatMessageOutput,
    type LocalMemorySessionContextLoader,
    type LocalMemorySessionMessage,
    type LocalMemorySessionMessagesClient,
} from "./local_memory_recall"
import {
    isTrustedLocalMemoryXmlBlock,
    parseTrustedLocalMemoryXmlBlocks,
    renderLocalMemoryXml,
    saveLocalMemory,
    type LocalMemory,
    type LocalMemoryFileSystem,
} from "@/utils/local_memory"
import { createAutocodeMemoryRecallTool } from "@/tools/autocode_memory_recall"
import { createToolContext } from "@/tools/test_context"

const CONTEXT = { directory: "/repo", worktree: "/repo" }
const OWNER_METADATA = { "autocode.local_memory": "v1" }
const PREPARATION_METADATA = { ...OWNER_METADATA, "autocode.local_memory_prepared": "v1" }

type FileSystem = LocalMemoryFileSystem & { actions: string[], files: Map<string, string>, directories: Set<string> }
type Harness = {
    hook: ReturnType<typeof createLocalMemoryRecallHook>
    fileSystem: FileSystem
    contextCalls: string[]
    diagnostics: LocalMemoryRecallDiagnostic[]
    smartAgents: Set<string>
}
type Deferred<T> = {
    promise: Promise<T>
    resolve: (value: T | PromiseLike<T>) => void
}

function deferred<T>(): Deferred<T> {
    let resolve!: Deferred<T>["resolve"]
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise
    })
    return { promise, resolve }
}

function missingError(): NodeJS.ErrnoException {
    const error = new Error("missing") as NodeJS.ErrnoException
    error.code = "ENOENT"
    return error
}

function createFileSystem(): FileSystem {
    const actions: string[] = []
    const files = new Map<string, string>()
    const directories = new Set<string>()
    return {
        actions,
        files,
        directories,
        async mkdir(directoryPath: string): Promise<string | undefined> {
            actions.push("mkdir")
            directories.add(directoryPath)
            return undefined
        },
        async readFile(filePath: string): Promise<string> {
            actions.push("readFile")
            const file = files.get(filePath)
            if (file === undefined) throw missingError()
            return file
        },
        async readdir(directoryPath: string): Promise<string[]> {
            actions.push("readdir")
            if (!directories.has(directoryPath)) throw missingError()
            return [...files.keys()]
                .filter((filePath: string): boolean => filePath.startsWith(`${directoryPath}/`))
                .map((filePath: string): string => filePath.slice(directoryPath.length + 1))
        },
        async rename(oldPath: string, newPath: string): Promise<void> {
            actions.push("rename")
            const file = files.get(oldPath)
            if (file === undefined) throw missingError()
            files.delete(oldPath)
            files.set(newPath, file)
        },
        async rm(filePath: string): Promise<void> {
            actions.push("rm")
            files.delete(filePath)
        },
        async writeFile(filePath: string, content: string): Promise<void> {
            actions.push("writeFile")
            files.set(filePath, content)
        },
    }
}

async function store(fileSystem: FileSystem, memory: LocalMemory, second: number = 1): Promise<void> {
    await saveLocalMemory(fileSystem, CONTEXT, memory, {
        now: (): Date => new Date(`2026-01-01T00:00:${String(second).padStart(2, "0")}Z`),
        temporary_suffix: (): string => `fixture-${second}`,
    })
    fileSystem.actions.splice(0, fileSystem.actions.length)
}

function createHarness(
    loadSessionContext: LocalMemorySessionContextLoader = async (): Promise<readonly LocalMemorySessionMessage[]> => [],
    smartAgents: Set<string> = new Set(["smart"]),
): Harness {
    const fileSystem = createFileSystem()
    const contextCalls: string[] = []
    const diagnostics: LocalMemoryRecallDiagnostic[] = []
    const dependencies: LocalMemoryRecallDependencies = {
        context: CONTEXT,
        fileSystem,
        isSmartAgent(agentName: string): boolean {
            return smartAgents.has(agentName)
        },
        async loadSessionContext(sessionID: string): Promise<readonly LocalMemorySessionMessage[] | undefined> {
            contextCalls.push(sessionID)
            return await loadSessionContext(sessionID)
        },
        diagnose(diagnostic: LocalMemoryRecallDiagnostic): void {
            diagnostics.push(diagnostic)
        },
    }
    return { hook: createLocalMemoryRecallHook(dependencies), fileSystem, contextCalls, diagnostics, smartAgents }
}

function input(sessionID: string = "session-one"): LocalMemoryRecallChatMessageInput {
    return { sessionID } as unknown as LocalMemoryRecallChatMessageInput
}

function output(messageID: string = "message-one", prompt: string = "deploy", agent: string = "smart"): LocalMemoryRecallChatMessageOutput {
    return {
        message: { id: messageID, role: "user", agent },
        parts: [{ type: "text", text: prompt }],
    } as unknown as LocalMemoryRecallChatMessageOutput
}

function ownedPart(xml: string): Part {
    return {
        id: "local-memory-part",
        sessionID: "session-one",
        messageID: "message-one",
        type: "text",
        text: xml,
        metadata: OWNER_METADATA,
    }
}

function preparationMarker(id: string = "local-memory-marker"): Part {
    return {
        id,
        sessionID: "session-one",
        messageID: "message-one",
        type: "text",
        text: "",
        metadata: PREPARATION_METADATA,
    }
}

function localMemoryParts(result: LocalMemoryRecallChatMessageOutput): TextPart[] {
    return result.parts.filter((part: Part): part is TextPart => part.type === "text" && typeof part.metadata === "object" && part.metadata !== null && (part.metadata as Record<string, unknown>)["autocode.local_memory"] === "v1")
}

async function recall(harness: Harness, request: LocalMemoryRecallChatMessageInput, result: LocalMemoryRecallChatMessageOutput): Promise<void> {
    await harness.hook["chat.message"]!(request, result)
}

describe("createOpenCodeLocalMemorySessionContextLoader", () => {
    test("returns validated OpenCode messages and rejects unavailable response shapes", async () => {
        const requests: unknown[] = []
        const client: LocalMemorySessionMessagesClient = {
            session: {
                async messages(request): Promise<unknown> {
                    requests.push(request)
                    return { data: [{ info: { id: "message-one" }, parts: [{ id: "prompt-part", sessionID: "session-one", messageID: "message-one", type: "text", text: "prompt" }] }] }
                },
            },
        }
        const loader = createOpenCodeLocalMemorySessionContextLoader(client, CONTEXT.directory)

        await expect(loader("session-one")).resolves.toEqual([{ info: { id: "message-one" }, parts: [{ id: "prompt-part", sessionID: "session-one", messageID: "message-one", type: "text", text: "prompt" }] }])
        expect(requests).toEqual([{ path: { id: "session-one" }, query: { directory: CONTEXT.directory } }])

        const unavailable = createOpenCodeLocalMemorySessionContextLoader({ session: { async messages(): Promise<unknown> { return { error: "unavailable" } } } }, CONTEXT.directory)
        await expect(unavailable("session-one")).resolves.toBeUndefined()
    })
})

describe("createLocalMemoryRecallHook", () => {
    test("selects once for a smart user prompt and replays without reselection", async () => {
        const harness = createHarness()
        await store(harness.fileSystem, { id: "deploy", memory: "private memory value" })
        const result = output()

        await recall(harness, input(), result)
        await recall(harness, input(), result)

        const parts = localMemoryParts(result)
        expect(harness.contextCalls).toEqual(["session-one"])
        expect(harness.fileSystem.actions).toEqual(["readdir", "readFile"])
        expect(parts).toHaveLength(1)
        expect(isTrustedLocalMemoryXmlBlock(parts[0].text)).toBeTrue()
        expect(parseTrustedLocalMemoryXmlBlocks(parts[0].text)[0].id_keyword).toBe("deploy")
    })

    test("skips unavailable session context without local-memory access or injection", async () => {
        const harness = createHarness(async (): Promise<undefined> => undefined)
        const result = output()

        await recall(harness, input(), result)
        await recall(harness, input(), result)

        expect(harness.contextCalls).toEqual(["session-one"])
        expect(harness.fileSystem.actions).toEqual([])
        expect(result.parts).toHaveLength(1)
        expect(harness.diagnostics).toEqual([{ reason: "session_context_unavailable", sessionID: "session-one", messageID: "message-one" }])
    })

    test("reports selection failure without injecting a local-memory part", async () => {
        const harness = createHarness()
        harness.fileSystem.readdir = async (): Promise<string[]> => {
            harness.fileSystem.actions.push("readdir")
            throw new Error("selection unavailable")
        }
        const result = output()

        await recall(harness, input(), result)
        await recall(harness, input(), result)

        expect(harness.contextCalls).toEqual(["session-one"])
        expect(harness.fileSystem.actions).toEqual(["readdir"])
        expect(result.parts).toHaveLength(1)
        expect(harness.diagnostics).toEqual([{ reason: "selection_failed", sessionID: "session-one", messageID: "message-one" }])
    })

    test("skips current-context prepared ID without selection or context refresh", async () => {
        const prepared = ownedPart(renderLocalMemoryXml({ id: "deploy", memory: "already loaded" }, "deploy"))
        const history = [{ info: { id: "message-one" }, parts: [prepared] }]
        const harness = createHarness(async (): Promise<typeof history> => history)
        const result = output()

        await recall(harness, input(), result)
        await recall(harness, input(), result)

        expect(harness.contextCalls).toEqual(["session-one"])
        expect(harness.fileSystem.actions).toEqual([])
        expect(result.parts).toHaveLength(1)
    })

    test("does not select during passive tool/effective-context transform and dedupes owned blocks", async () => {
        const harness = createHarness()
        const first = renderLocalMemoryXml({ id: " API\t", memory: "first" }, "API")
        const duplicate = renderLocalMemoryXml({ id: "api", memory: "duplicate" }, "api")
        const transformed = {
            messages: [
                { info: { id: "message-one" }, parts: [ownedPart(first), ownedPart(duplicate)] },
                { info: { id: "message-two" }, parts: [{ type: "tool" } as Part, { type: "text", text: "effective context" } as Part] },
            ],
        }

        await harness.hook["experimental.chat.messages.transform"]!({} as never, transformed as never)

        expect(harness.contextCalls).toEqual([])
        expect(harness.fileSystem.actions).toEqual([])
        expect(transformed.messages[0].parts).toEqual([ownedPart(first)])
        expect(transformed.messages[1].parts).toHaveLength(2)
    })

    test("skips stale normalized loaded IDs in core and records empty preparation once", async () => {
        const loaded = renderLocalMemoryXml({ id: "deploy", memory: "old" }, "deploy")
        const history = [{ info: { id: "prior" }, parts: [ownedPart(loaded)] }]
        const harness = createHarness(async (): Promise<typeof history> => history)
        await store(harness.fileSystem, { id: "  DEPLOY\t", memory: "new" })
        const result = output()

        await recall(harness, input(), result)
        await recall(harness, input(), result)

        expect(harness.contextCalls).toEqual(["session-one"])
        expect(harness.fileSystem.actions).toEqual(["readdir", "readFile"])
        expect(localMemoryParts(result)).toHaveLength(1)
        expect(localMemoryParts(result)[0].text).toBe("")
    })

    test("manual recall returns an ID excluded from automatic recall by loaded session context", async () => {
        const loaded = renderLocalMemoryXml({ id: "deploy", memory: "old deployment" }, "deploy")
        const history = [{ info: { id: "prior" }, parts: [ownedPart(loaded)] }]
        const harness = createHarness(async (): Promise<typeof history> => history)
        await store(harness.fileSystem, { id: "deploy", memory: "current deployment" })
        const automatic = output()

        await recall(harness, input(), automatic)
        const manual = await createAutocodeMemoryRecallTool(harness.fileSystem).execute({ keywords: "deploy" } as never, createToolContext(CONTEXT)) as string

        expect(localMemoryParts(automatic)).toHaveLength(1)
        expect(localMemoryParts(automatic)[0].text).toBe("")
        expect(parseTrustedLocalMemoryXmlBlocks(manual).map((block) => block.id_keyword)).toEqual(["deploy"])
    })

    test("does not select or inject when output already has a trusted local-memory block", async () => {
        const harness = createHarness()
        const block = ownedPart(renderLocalMemoryXml({ id: "deploy", memory: "already prepared" }, "deploy"))
        const result = { ...output(), parts: [block] } as LocalMemoryRecallChatMessageOutput

        await recall(harness, input(), result)

        expect(harness.contextCalls).toEqual([])
        expect(harness.fileSystem.actions).toEqual([])
        expect(result.parts).toEqual([block])
    })

    test("preserves one compaction marker and leaves absent messages absent without selection", async () => {
        const harness = createHarness()
        const marker = preparationMarker()
        const transformed = {
            messages: [
                { info: { id: "prepared" }, parts: [marker] },
                { info: { id: "absent" }, parts: [{ id: "plain-part", sessionID: "session-one", messageID: "absent", type: "text", text: "plain context" } as Part] },
            ],
        }

        await harness.hook["experimental.chat.messages.transform"]!({} as never, transformed as never)

        expect(transformed.messages[0].parts).toEqual([marker])
        expect(transformed.messages[1].parts).toEqual([{ id: "plain-part", sessionID: "session-one", messageID: "absent", type: "text", text: "plain context" }])
        expect(harness.contextCalls).toEqual([])
        expect(harness.fileSystem.actions).toEqual([])
    })

    test("retains multiple compaction preparation markers without creating another", async () => {
        const harness = createHarness()
        const first = preparationMarker("marker-one")
        const second = preparationMarker("marker-two")
        const transformed = { messages: [{ info: { id: "prepared" }, parts: [first, second] }] }

        await harness.hook["experimental.chat.messages.transform"]!({} as never, transformed as never)

        expect(transformed.messages[0].parts).toEqual([first, second])
        expect(harness.contextCalls).toEqual([])
        expect(harness.fileSystem.actions).toEqual([])
    })

    test("claims concurrent same-key selection once and prepares first output", async () => {
        const gate = deferred<readonly LocalMemorySessionMessage[]>()
        const loaderStarted = deferred<void>()
        const harness = createHarness(async (): Promise<readonly LocalMemorySessionMessage[]> => {
            loaderStarted.resolve()
            return await gate.promise
        })
        await store(harness.fileSystem, { id: "deploy", memory: "remember deployment" })
        const first = output("message-one")
        const second = output("message-one")

        const firstRecall = recall(harness, input(), first)
        const secondRecall = recall(harness, input(), second)
        await loaderStarted.promise
        expect(harness.contextCalls).toEqual(["session-one"])
        gate.resolve([])
        await Promise.all([firstRecall, secondRecall])

        const firstPart = localMemoryParts(first)[0]
        expect(harness.fileSystem.actions).toEqual(["readdir", "readFile"])
        expect(localMemoryParts(first)).toHaveLength(1)
        expect(isTrustedLocalMemoryXmlBlock(firstPart.text)).toBeTrue()
    })

    test("isolates loaded IDs across distinct session keys", async () => {
        const alpha = renderLocalMemoryXml({ id: "alpha", memory: "old alpha" }, "alpha")
        const beta = renderLocalMemoryXml({ id: "beta", memory: "old beta" }, "beta")
        const harness = createHarness(async (sessionID: string) => sessionID === "session-alpha"
            ? [{ info: { id: "prior-alpha" }, parts: [ownedPart(alpha)] }]
            : [{ info: { id: "prior-beta" }, parts: [ownedPart(beta)] }])
        await store(harness.fileSystem, { id: "alpha", memory: "new alpha" }, 1)
        await store(harness.fileSystem, { id: "beta", memory: "new beta" }, 2)
        const alphaResult = output("message-alpha", "beta")
        const betaResult = output("message-beta", "alpha")

        await Promise.all([
            recall(harness, input("session-alpha"), alphaResult),
            recall(harness, input("session-beta"), betaResult),
        ])

        expect(parseTrustedLocalMemoryXmlBlocks(localMemoryParts(alphaResult)[0].text)[0].id_keyword).toBe("beta")
        expect(parseTrustedLocalMemoryXmlBlocks(localMemoryParts(betaResult)[0].text)[0].id_keyword).toBe("alpha")
    })

    test("claims successful, unmatched, and failed automatic selection once", async () => {
        const success = createHarness()
        await store(success.fileSystem, { id: "deploy", memory: "remember deployment" })
        await recall(success, input(), output("success-one", "deploy"))
        await recall(success, input(), output("success-retry", "deploy"))
        expect(success.fileSystem.actions).toEqual(["readdir", "readFile"])

        const unmatched = createHarness()
        await recall(unmatched, input(), output("unmatched-one", "nothing matches"))
        await recall(unmatched, input(), output("unmatched-retry", "nothing matches"))
        expect(unmatched.fileSystem.actions).toEqual(["readdir"])

        const failed = createHarness()
        failed.fileSystem.readdir = async (): Promise<string[]> => {
            failed.fileSystem.actions.push("readdir")
            throw new Error("selection unavailable")
        }
        await recall(failed, input(), output("failed-one"))
        await recall(failed, input(), output("failed-retry"))
        expect(failed.fileSystem.actions).toEqual(["readdir"])
    })

    test("does not reselect for retries, tool loops, transforms, or compaction", async () => {
        const harness = createHarness()
        await store(harness.fileSystem, { id: "deploy", memory: "remember deployment" })
        await recall(harness, input(), output("first", "deploy"))
        await recall(harness, input(), output("retry", "deploy"))
        await recall(harness, input(), {
            ...output("tool-loop", "deploy"),
            parts: [{ type: "tool" } as Part, { type: "text", text: "deploy" } as Part],
        } as LocalMemoryRecallChatMessageOutput)
        const marker = preparationMarker()
        const transformed = { messages: [{ info: { id: "compacted" }, parts: [marker] }] }
        await harness.hook["experimental.chat.messages.transform"]!({} as never, transformed as never)

        expect(harness.fileSystem.actions).toEqual(["readdir", "readFile"])
        expect(transformed.messages[0].parts).toEqual([marker])
    })

    test("keeps separate first-selection claims per smart agent and session", async () => {
        const harness = createHarness(undefined, new Set(["smart-one", "smart-two"]))
        await store(harness.fileSystem, { id: "deploy", memory: "remember deployment" })
        await recall(harness, input("shared"), output("one", "deploy", "smart-one"))
        await recall(harness, input("shared"), output("two", "deploy", "smart-two"))
        await recall(harness, input("other"), output("three", "deploy", "smart-one"))

        expect(harness.contextCalls).toEqual(["shared", "shared", "other"])
        expect(harness.fileSystem.actions).toEqual(["readdir", "readFile", "readdir", "readFile", "readdir", "readFile"])
    })

    test("leaves ineligible messages unclaimed so later smart user text attempts selection", async () => {
        const harness = createHarness()
        await store(harness.fileSystem, { id: "deploy", memory: "remember deployment" })
        const nonUser = output("non-user")
        nonUser.message.role = "assistant" as never
        const missingAgent = output("missing-agent")
        delete (missingAgent.message as { agent?: string }).agent

        await recall(harness, input(), output("non-smart", "deploy", "plain"))
        await recall(harness, input(), nonUser)
        await recall(harness, input(), { ...output("no-text"), parts: [{ type: "tool" } as Part] } as LocalMemoryRecallChatMessageOutput)
        await recall(harness, input(), missingAgent)
        const eligible = output("eligible", "deploy")
        await recall(harness, input(), eligible)

        expect(harness.contextCalls).toEqual(["session-one"])
        expect(harness.fileSystem.actions).toEqual(["readdir", "readFile"])
        expect(localMemoryParts(eligible)).toHaveLength(1)
    })

    test("leaves empty smart user text unclaimed so first text-bearing message selects", async () => {
        const harness = createHarness()
        await store(harness.fileSystem, { id: "deploy", memory: "remember deployment" })
        const empty = output("empty", "")
        const whitespace = output("whitespace", " \t\n")
        const eligible = output("eligible", "deploy")

        await recall(harness, input(), empty)
        await recall(harness, input(), whitespace)
        await recall(harness, input(), eligible)

        expect(harness.contextCalls).toEqual(["session-one"])
        expect(harness.fileSystem.actions).toEqual(["readdir", "readFile"])
        expect(localMemoryParts(empty)).toHaveLength(0)
        expect(localMemoryParts(whitespace)).toHaveLength(0)
        expect(localMemoryParts(eligible)).toHaveLength(1)
    })

    test("uses every text part and persists plugin-owned prepared part shape", async () => {
        const harness = createHarness()
        await store(harness.fileSystem, { id: "alpha", memory: "first" }, 1)
        await store(harness.fileSystem, { id: "beta", memory: "second" }, 2)
        const result = {
            ...output("multi-text", "ignored"),
            parts: [{ type: "text", text: "alpha" } as Part, { type: "tool" } as Part, { type: "text", text: "beta" } as Part],
        } as LocalMemoryRecallChatMessageOutput

        await recall(harness, input(), result)

        const prepared = localMemoryParts(result)
        const preparedIDs = parseTrustedLocalMemoryXmlBlocks(prepared[0].text).map((block) => block.id_keyword)
        expect(preparedIDs).toHaveLength(2)
        expect(preparedIDs).toContain("alpha")
        expect(preparedIDs).toContain("beta")
        expect(prepared[0]).toEqual(expect.objectContaining({ id: expect.any(String), sessionID: "session-one", messageID: "multi-text", type: "text", metadata: OWNER_METADATA }))
        expect(result.parts).toHaveLength(4)
    })

    test("enforces exact 4,000 UTF-16 automatic-memory budget", async () => {
        const harness = createHarness()
        const emptyXmlLength = renderLocalMemoryXml({ id: "budget", memory: "" }, "budget").length
        await store(harness.fileSystem, { id: "budget", memory: "x".repeat(4_000 - emptyXmlLength) })
        const result = output("budget-message", "budget")

        await recall(harness, input(), result)

        expect(localMemoryParts(result)[0].text.length).toBe(4_000)
        expect(harness.fileSystem.actions).toEqual(["readdir", "readFile"])
    })

    test("resets matching session claims on deletion and all claims on disposal", async () => {
        const harness = createHarness()
        await store(harness.fileSystem, { id: "deploy", memory: "remember deployment" })
        await recall(harness, input("alpha"), output("alpha-one"))
        await recall(harness, input("beta"), output("beta-one"))
        await harness.hook.event!({ event: { type: "session.deleted", properties: { sessionID: "alpha" } } } as never)
        await recall(harness, input("alpha"), output("alpha-two"))
        await recall(harness, input("beta"), output("beta-two"))
        await harness.hook.dispose!()
        await recall(harness, input("alpha"), output("alpha-three"))
        await recall(harness, input("beta"), output("beta-three"))

        expect(harness.contextCalls).toEqual(["alpha", "beta", "alpha", "alpha", "beta"])
        expect(harness.fileSystem.actions).toEqual(["readdir", "readFile", "readdir", "readFile", "readdir", "readFile", "readdir", "readFile", "readdir", "readFile"])
    })

    test("retains claims across non-deletion lifecycle events", async () => {
        const harness = createHarness()
        await store(harness.fileSystem, { id: "deploy", memory: "remember deployment" })
        await recall(harness, input(), output("first"))
        await harness.hook.event!({ event: { type: "session.status", properties: { sessionID: "session-one", status: { type: "idle" } } } } as never)
        await harness.hook.event!({ event: { type: "session.error", properties: { sessionID: "session-one" } } } as never)
        await recall(harness, input(), output("after-events"))

        expect(harness.contextCalls).toEqual(["session-one"])
        expect(harness.fileSystem.actions).toEqual(["readdir", "readFile"])
    })

})
