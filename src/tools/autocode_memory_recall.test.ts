import { beforeEach, describe, expect, test } from "bun:test"
import { basename, dirname } from "node:path"
import {
    recallLocalMemories,
    renderLocalMemoryXml,
    saveLocalMemory,
    parseTrustedLocalMemoryXmlBlocks,
    type LocalMemory,
    type LocalMemoryFileSystem,
} from "@/utils/local_memory"
import { createAutocodeMemoryRecallTool } from "./autocode_memory_recall"
import { createToolContext } from "./test_context"
import { resetRetryCounts } from "@/utils/tools"

const context = { directory: "/workspace/project", worktree: "/workspace/project" }

function createFileSystem(): LocalMemoryFileSystem & { files: Map<string, string>, readdirCalls: number } {
    const files = new Map<string, string>()
    let readdirCalls = 0
    return {
        files,
        get readdirCalls(): number {
            return readdirCalls
        },
        async mkdir(): Promise<string | undefined> {
            return undefined
        },
        async readFile(filePath: string): Promise<string> {
            const content = files.get(filePath)
            if (content === undefined) throw new Error(`Missing file: ${filePath}`)
            return content
        },
        async readdir(directoryPath: string): Promise<string[]> {
            readdirCalls += 1
            return [...files.keys()]
                .filter((filePath: string): boolean => dirname(filePath) === directoryPath)
                .map((filePath: string): string => basename(filePath))
        },
        async rename(oldPath: string, newPath: string): Promise<void> {
            const content = files.get(oldPath)
            if (content === undefined) throw new Error(`Missing temporary file: ${oldPath}`)
            files.delete(oldPath)
            files.set(newPath, content)
        },
        async rm(filePath: string): Promise<void> {
            files.delete(filePath)
        },
        async writeFile(filePath: string, content: string): Promise<void> {
            files.set(filePath, content)
        },
    }
}

function at(timestamp: string): () => Date {
    return (): Date => new Date(`${timestamp.replace(" ", "T").replace(/(\d{2})h(\d{2})s/, "$1:$2:")}Z`)
}

async function store(fileSystem: LocalMemoryFileSystem, timestamp: string, memory: LocalMemory): Promise<void> {
    await saveLocalMemory(fileSystem, context, memory, { now: at(timestamp), temporary_suffix: (): string => timestamp })
}

function paddedMemory(id: string, renderedLength: number): LocalMemory {
    const baseLength = renderLocalMemoryXml({ id, memory: "" }, id).length
    if (renderedLength < baseLength) throw new Error("Requested XML block is too short.")
    return { id, memory: "x".repeat(renderedLength - baseLength) }
}

async function executeRecall(fileSystem: LocalMemoryFileSystem, keywords: unknown): Promise<string> {
    return await createAutocodeMemoryRecallTool(fileSystem).execute({ keywords } as never, createToolContext(context)) as string
}

beforeEach((): void => {
    resetRetryCounts()
})

describe("autocode_memory_recall tool", () => {
    test("retries empty comma forms before reading storage", async () => {
        const fileSystem = createFileSystem()

        for (const keywords of [",api", "api,", "api,,cache", ","]) {
            const result = JSON.parse(await executeRecall(fileSystem, keywords)) as Record<string, unknown>

            expect(result.failedAction).toBe("autocode_memory_recall")
            expect(result.instruction).toContain("Retry")
        }
        expect(fileSystem.readdirCalls).toBe(0)
    })

    test("uses shared abort envelope for listing, reading, and malformed active memory failures", async () => {
        const listingFailure = createFileSystem()
        listingFailure.readdir = async (): Promise<string[]> => {
            throw new Error("list unavailable")
        }

        const readFailure = createFileSystem()
        await store(readFailure, "2026-01-01 00h00s00", { id: "active", memory: "active memory" })
        readFailure.readFile = async (): Promise<string> => {
            throw new Error("read unavailable")
        }

        const malformedMemory = createFileSystem()
        await store(malformedMemory, "2026-01-01 00h00s00", { id: "active", memory: "active memory" })
        const malformedPath = [...malformedMemory.files.keys()][0]
        malformedMemory.files.set(malformedPath, "<!-- autocode-local-memory:v1\nmalformed")

        const results = await Promise.all([
            executeRecall(listingFailure, "active"),
            executeRecall(readFailure, "active"),
            executeRecall(malformedMemory, "active"),
        ])
        const failures = results.map((result: string): Record<string, unknown> => JSON.parse(result) as Record<string, unknown>)

        expect(failures.map((failure: Record<string, unknown>): string => failure.failedAction as string)).toEqual([
            "autocode_memory_recall",
            "autocode_memory_recall",
            "autocode_memory_recall",
        ])
        expect(failures.map((failure: Record<string, unknown>): string => failure.error as string)).toEqual([
            "LocalMemoryError: read local memory directory: list unavailable",
            "LocalMemoryError: read local memory: read unavailable",
            `LocalMemoryError: Local memory metadata is incomplete: ${basename(malformedPath)}`,
        ])
        const instructions = failures.map((failure: Record<string, unknown>): string => {
            if (typeof failure.instruction !== "string") throw new Error("Expected failure instruction to be a string.")
            return failure.instruction
        })
        expect(instructions).toEqual([
            instructions[0],
            instructions[0],
            instructions[0],
        ])
        for (const failure of failures) {
            expect(Object.keys(failure).sort()).toEqual(["error", "failedAction", "instruction"])
        }
        for (const instruction of instructions) {
            expect(instruction).toContain("Immediately ABORT")
        }
    })

    test("trims, normalizes, dedupes, and preserves first ordered tool terms", async () => {
        const fileSystem = createFileSystem()
        await store(fileSystem, "2026-01-01 00h00s00", { id: "API Request", memory: "old" })
        await store(fileSystem, "2026-01-04 00h00s00", { id: "ＡＰＩ\u00a0Request", memory: "new" })
        await store(fileSystem, "2026-01-03 00h00s00", { id: "Browser", aliases: ["Ｆｏｏ"], memory: "alias" })
        await store(fileSystem, "2026-01-02 00h00s00", { id: "Operations", context: " CACHE\u00a0MISS ", memory: "context" })

        const result = await executeRecall(fileSystem, " ＦＯＯ , browser, api\trequest, cache miss, foo ")

        expect(parseTrustedLocalMemoryXmlBlocks(result).map((block) => [block.id_keyword, block.matched_keyword])).toEqual([
            ["Browser", "foo"],
            ["ＡＰＩ\u00a0Request", "api request"],
            ["Operations", "cache miss"],
        ])
    })

    test("uses whole boundaries for IDs, aliases, and context", async () => {
        const fileSystem = createFileSystem()
        await store(fileSystem, "2026-01-01 00h00s00", { id: "Cache", memory: "id" })
        await store(fileSystem, "2026-01-02 00h00s00", { id: "Alias", aliases: ["Token"], memory: "alias" })
        await store(fileSystem, "2026-01-03 00h00s00", { id: "Context", context: "Audit", memory: "context" })

        expect(await executeRecall(fileSystem, "cacheable,tokenize,auditing")).toBe("")
    })

    test("emits keyword one context match before keyword two direct ID match", async () => {
        const fileSystem = createFileSystem()
        await store(fileSystem, "2026-01-02 00h00s00", { id: "second direct", memory: "second" })
        await store(fileSystem, "2026-01-01 00h00s00", { id: "context memory", context: "first context", memory: "first" })

        const result = await executeRecall(fileSystem, "first context,second direct")

        expect(parseTrustedLocalMemoryXmlBlocks(result).map((block) => [block.id_keyword, block.matched_keyword])).toEqual([
            ["context memory", "first context"],
            ["second direct", "second direct"],
        ])
    })

    test("emits all keyword one matches before keyword two matches", async () => {
        const fileSystem = createFileSystem()
        await store(fileSystem, "2026-01-03 00h00s00", { id: "first newest", memory: "newest" })
        await store(fileSystem, "2026-01-02 00h00s00", { id: "first older", memory: "older" })
        await store(fileSystem, "2026-01-01 00h00s00", { id: "second match", memory: "second" })

        const result = await executeRecall(fileSystem, "first,second")

        expect(parseTrustedLocalMemoryXmlBlocks(result).map((block) => block.id_keyword)).toEqual([
            "first newest",
            "first older",
            "second match",
        ])
    })

    test("emits duplicate IDs once across keyword passes", async () => {
        const fileSystem = createFileSystem()
        await store(fileSystem, "2026-01-02 00h00s00", { id: "alpha beta", memory: "shared" })
        await store(fileSystem, "2026-01-01 00h00s00", { id: "beta only", memory: "later" })

        const result = await executeRecall(fileSystem, "alpha,beta")

        expect(parseTrustedLocalMemoryXmlBlocks(result).map((block) => block.id_keyword)).toEqual(["alpha beta", "beta only"])
    })

    test("advances from unmatched keyword to later matching keyword", async () => {
        const fileSystem = createFileSystem()
        await store(fileSystem, "2026-01-01 00h00s00", { id: "later match", memory: "later" })

        const result = await executeRecall(fileSystem, "missing,later")

        expect(parseTrustedLocalMemoryXmlBlocks(result).map((block) => block.id_keyword)).toEqual(["later match"])
    })

    test("applies cumulative manual budget across keyword scans", async () => {
        const fileSystem = createFileSystem()
        await store(fileSystem, "2026-01-03 00h00s00", paddedMemory("first", 6_500))
        await store(fileSystem, "2026-01-02 00h00s00", paddedMemory("second", 600))
        await store(fileSystem, "2026-01-01 00h00s00", paddedMemory("third", 300))

        const result = await recallLocalMemories(fileSystem, context, ["first", "second", "third"])

        expect(parseTrustedLocalMemoryXmlBlocks(result.xml).map((block) => block.id_keyword)).toEqual(["first"])
        expect(result.characters).toBe(6_500)
        expect(result.trace).toContainEqual({ reason: "budget_stop", selected_characters: 6_500, next_block_characters: 600 })
    })

    test("stops all later keywords when earlier keyword overflows budget", async () => {
        const fileSystem = createFileSystem()
        await store(fileSystem, "2026-01-02 00h00s00", paddedMemory("overflow", 7_001))
        await store(fileSystem, "2026-01-01 00h00s00", paddedMemory("later", 300))

        const result = await recallLocalMemories(fileSystem, context, ["overflow", "later"])

        expect(parseTrustedLocalMemoryXmlBlocks(result.xml)).toEqual([])
        expect(result.characters).toBe(0)
        expect(result.trace).toContainEqual({ reason: "budget_stop", selected_characters: 0, next_block_characters: 7_001 })
    })

    test("stops at exact 7,000 characters before later keyword", async () => {
        const fileSystem = createFileSystem()
        await store(fileSystem, "2026-01-02 00h00s00", paddedMemory("exact", 7_000))
        await store(fileSystem, "2026-01-01 00h00s00", paddedMemory("later", 300))

        const result = await recallLocalMemories(fileSystem, context, ["exact", "later"])

        expect(parseTrustedLocalMemoryXmlBlocks(result.xml).map((block) => block.id_keyword)).toEqual(["exact"])
        expect(result.characters).toBe(7_000)
        expect(result.trace).toContainEqual({ reason: "budget_stop", selected_characters: 7_000, next_block_characters: 0 })
    })

    test("returns more than seven matching manual recall blocks", async () => {
        const fileSystem = createFileSystem()
        const ids = Array.from({ length: 8 }, (_, index) => `memory-${index}`)
        for (const [index, id] of ids.entries()) {
            await store(fileSystem, `2026-01-01 00h00s${String(index).padStart(2, "0")}`, paddedMemory(id, 300))
        }

        const result = await recallLocalMemories(fileSystem, context, ids)

        expect(result.memories).toHaveLength(8)
        expect(result.characters).toBe(8 * 300 + 7)
    })
})
