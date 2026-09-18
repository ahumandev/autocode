import { beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
    forgetLocalMemory,
    formatLocalMemoryFilename,
    getLocalMemoryDirectory,
    localMemoryForgetRemovalConcurrency,
    type LocalMemoryFileSystem,
} from "@/utils/local_memory"
import { createAutocodeMemoryForgetTool } from "./autocode_memory_forget"
import { createToolContext } from "./test_context"
import { resetRetryCounts } from "@/utils/tools"

const context = { directory: "/workspace/project", worktree: "/workspace/project" }
const directory = getLocalMemoryDirectory(context)

type ForgetFileSystem = LocalMemoryFileSystem & {
    files: Set<string>
    readCalls: number
    removedPaths: string[]
}

function filename(timestamp: string, id: string, aliases?: string[], memoryContext?: string): string {
    return formatLocalMemoryFilename(timestamp, { id, aliases, context: memoryContext })
}

function createFileSystem(names: readonly string[], failRemovals = new Set<string>()): ForgetFileSystem {
    const files = new Set(names.map((name: string): string => join(directory, name)))
    const removedPaths: string[] = []
    let readCalls = 0
    return {
        files,
        removedPaths,
        get readCalls(): number {
            return readCalls
        },
        async mkdir(): Promise<string | undefined> {
            return undefined
        },
        async readFile(): Promise<string> {
            readCalls += 1
            throw new Error("Forget must not read memory bodies.")
        },
        async readdir(): Promise<string[]> {
            return [...files].map((filePath: string): string => filePath.slice(directory.length + 1))
        },
        async rename(): Promise<void> {
        },
        async rm(filePath: string): Promise<void> {
            removedPaths.push(filePath)
            if (failRemovals.has(filePath)) throw new Error(`remove failed: ${filePath}`)
            files.delete(filePath)
        },
        async writeFile(): Promise<void> {
        },
    }
}

async function executeForget(fileSystem: LocalMemoryFileSystem, id_keyword: unknown): Promise<string> {
    return await createAutocodeMemoryForgetTool(fileSystem).execute({ id_keyword } as never, createToolContext(context)) as string
}

beforeEach((): void => {
    resetRetryCounts()
})

describe("autocode_memory_forget tool", () => {
    test("normalizes primary ID, removes every version, and never removes alias, context, or same-time peers", async () => {
        const first = filename("2026-01-01 00h00s00", "API")
        const second = filename("2026-01-02 00h00s00", " api ")
        const sameTimePeer = filename("2026-01-02 00h00s00", "Other")
        const aliasOnly = filename("2026-01-03 00h00s00", "Alias holder", ["api"])
        const contextOnly = filename("2026-01-04 00h00s00", "Context holder", [], "api")
        const fileSystem = createFileSystem([first, second, sameTimePeer, aliasOnly, contextOnly])

        const result = await forgetLocalMemory(fileSystem, context, " ＡＰＩ\u00a0 ")

        expect(result.normalized_id).toBe("api")
        expect(result.deleted.map((file) => file.filename).sort()).toEqual([first, second].sort())
        expect(result.failed).toEqual([])
        expect(fileSystem.files).toEqual(new Set([join(directory, sameTimePeer), join(directory, aliasOnly), join(directory, contextOnly)]))
        expect(fileSystem.readCalls).toBe(0)
    })

    test("reports zero matching versions as successful idempotent deletion", async () => {
        const fileSystem = createFileSystem([filename("2026-01-01 00h00s00", "Other")])

        expect(await executeForget(fileSystem, "missing")).toBe([
            "Normalized ID: missing",
            "Deleted: 0",
            "Locations: none",
        ].join("\n"))
        expect(fileSystem.removedPaths).toEqual([])
    })

    test("reports every successful multi-version deletion without reading or exposing memory bodies", async () => {
        const first = filename("2026-01-01 00h00s00", "API")
        const second = filename("2026-01-02 00h00s00", " api ")
        const sensitiveBody = "private credential body"
        const fileSystem = createFileSystem([first, second])
        fileSystem.readFile = async (): Promise<string> => {
            throw new Error(sensitiveBody)
        }

        const result = await executeForget(fileSystem, " ＡＰＩ\u00a0 ")

        expect(result).toBe([
            "Normalized ID: api",
            "Deleted: 2",
            `Locations: ${first}: ${join(directory, first)}, ${second}: ${join(directory, second)}`,
        ].join("\n"))
        expect(result).not.toContain(sensitiveBody)
        expect(fileSystem.readCalls).toBe(0)
        expect(fileSystem.removedPaths).toEqual([join(directory, first), join(directory, second)])
    })

    test("aborts malformed filename preflight before deleting matching versions", async () => {
        const target = filename("2026-01-01 00h00s00", "Target")
        const fileSystem = createFileSystem([target, "malformed.md"])

        const result = JSON.parse(await executeForget(fileSystem, "target")) as Record<string, unknown>

        expect(result.failedAction).toBe("autocode_memory_forget")
        expect(result.instruction).toContain("Immediately ABORT")
        expect(fileSystem.removedPaths).toEqual([])
    })

    test("uses abort envelope for listing failures", async () => {
        const fileSystem = createFileSystem([])
        fileSystem.readdir = async (): Promise<string[]> => {
            throw new Error("list unavailable")
        }

        const result = JSON.parse(await executeForget(fileSystem, "target")) as Record<string, unknown>

        expect(result).toMatchObject({
            failedAction: "autocode_memory_forget",
            error: "LocalMemoryError: read local memory directory: list unavailable",
        })
        expect(result.instruction).toContain("Immediately ABORT")
    })

    test("reports partial removals, continues after failures, and retries remaining versions", async () => {
        const first = filename("2026-01-01 00h00s00", "Target")
        const failing = filename("2026-01-02 00h00s00", " target ")
        const third = filename("2026-01-03 00h00s00", "TARGET")
        const failingPath = join(directory, failing)
        const failures = new Set([failingPath])
        const fileSystem = createFileSystem([first, failing, third], failures)

        const partial = JSON.parse(await executeForget(fileSystem, "target")) as Record<string, unknown>

        expect(partial.failedAction).toBe("autocode_memory_forget")
        expect(partial.error).toContain("Deleted: 2")
        expect(partial.error).toContain(first)
        expect(partial.error).toContain(third)
        expect(partial.error).toContain(`Failed: 1 (${failing}`)
        expect(partial.instruction).toContain("Retry with same exact ID")
        expect(fileSystem.files).toEqual(new Set([failingPath]))

        failures.clear()
        const retry = await executeForget(fileSystem, "target")

        expect(retry).toContain("Deleted: 1")
        expect(retry).toContain(failing)
        expect(fileSystem.files).toEqual(new Set())
    })

    test("limits concurrent removals to exported maximum", async () => {
        const names = Array.from({ length: localMemoryForgetRemovalConcurrency * 2 + 1 }, (_, index) => filename(`2026-01-01 00h00s${String(index).padStart(2, "0")}`, `Target${" ".repeat(index)}`))
        const fileSystem = createFileSystem(names)
        let activeRemovals = 0
        let maximumActiveRemovals = 0
        fileSystem.rm = async (filePath: string): Promise<void> => {
            activeRemovals += 1
            maximumActiveRemovals = Math.max(maximumActiveRemovals, activeRemovals)
            await new Promise<void>((resolve) => setTimeout(resolve, 1))
            activeRemovals -= 1
            fileSystem.files.delete(filePath)
        }

        await forgetLocalMemory(fileSystem, context, "target")

        expect(maximumActiveRemovals).toBeLessThanOrEqual(localMemoryForgetRemovalConcurrency)
    })
})
