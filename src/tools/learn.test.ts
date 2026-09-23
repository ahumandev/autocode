import { beforeEach, describe, expect, test } from "bun:test"
import { basename, dirname, join, resolve } from "node:path"
import type { LocalMemoryFileSystem } from "@/utils/local_memory"
import { resetRetryCounts } from "@/utils/tools"
import { createLearnTool, validateLearnArgs } from "./learn"
import { createToolContext } from "./test_context"

type MemoryFileSystem = {
    fileSystem: LocalMemoryFileSystem
    files: Map<string, string>
    mkdirPaths: string[]
    removedPaths: string[]
    renamedPaths: Array<{ oldPath: string, newPath: string }>
}

const fixedTime = new Date("2026-09-16T12:34:56.000Z")
const validArgs = {
    memory: "Keep durable lessons concise.",
    id_keyword: "Browser Tools",
    alias_keywords: "Chrome, Firefox",
    context_keywords: "UI tests",
}

function createMemoryFileSystem(files = new Map<string, string>()): MemoryFileSystem {
    const mkdirPaths: string[] = []
    const removedPaths: string[] = []
    const renamedPaths: Array<{ oldPath: string, newPath: string }> = []
    const fileSystem: LocalMemoryFileSystem = {
        async mkdir(directoryPath: string): Promise<string | undefined> {
            mkdirPaths.push(directoryPath)
            return undefined
        },
        async readFile(filePath: string, _encoding: "utf8"): Promise<string> {
            const content = files.get(filePath)
            if (content === undefined) throw new Error(`Missing file: ${filePath}`)
            return content
        },
        async readdir(directoryPath: string): Promise<string[]> {
            return [...files.keys()]
                .filter((filePath: string): boolean => dirname(filePath) === directoryPath)
                .map((filePath: string): string => basename(filePath))
        },
        async rename(oldPath: string, newPath: string): Promise<void> {
            renamedPaths.push({ oldPath, newPath })
            const content = files.get(oldPath)
            if (content === undefined) throw new Error(`Missing temporary file: ${oldPath}`)
            files.delete(oldPath)
            files.set(newPath, content)
        },
        async rm(filePath: string): Promise<void> {
            removedPaths.push(filePath)
            files.delete(filePath)
        },
        async writeFile(filePath: string, content: string): Promise<void> {
            files.set(filePath, content)
        },
    }
    return { fileSystem, files, mkdirPaths, removedPaths, renamedPaths }
}

async function withFixedTime<T>(run: () => Promise<T>, time: Date = fixedTime): Promise<T> {
    const originalDate = globalThis.Date
    const FixedDate = class extends originalDate {
        constructor(value?: string | number) {
            super(value === undefined ? time.getTime() : value)
        }

        static now(): number {
            return time.getTime()
        }
    }
    globalThis.Date = FixedDate as DateConstructor
    try {
        return await run()
    } finally {
        globalThis.Date = originalDate
    }
}

async function executeLearn(fileSystem: LocalMemoryFileSystem, args: Record<string, unknown>): Promise<string> {
    const result = await createLearnTool(fileSystem).execute(args as never, createToolContext({
        directory: join(resolve("/project-root"), "packages", "ui"),
        worktree: resolve("/project-root"),
    }))
    return result as string
}

function parseEnvelope(result: string): Record<string, unknown> {
    return JSON.parse(result) as Record<string, unknown>
}

beforeEach((): void => {
    resetRetryCounts()
})

describe("learn tool", () => {
    test("saves required strings with ordered normalized keyword dedupe and optional details", async () => {
        await withFixedTime(async () => {
            const memoryFileSystem = createMemoryFileSystem()

            const result = await executeLearn(memoryFileSystem.fileSystem, {
                memory: "Keep durable lessons concise.",
                id_keyword: "  Browser Tools  ",
                alias_keywords: "Chrome, Browser tools, Firefox, chrome",
                context_keywords: "UI tests, firefox, UI tests",
                positive_example: "Use direct tool assertions.",
                negative_example: "Do not store task progress.",
                references: ["https://bun.sh", "  "],
            })

            const filename = "2026-09-16 12h34s56 Browser Tools,Chrome,Firefox;UI tests.md"
            const directory = join(resolve("/project-root"), ".opencode", "autocode", "memories")
            const savedPath = join(directory, filename)

            expect(memoryFileSystem.mkdirPaths).toEqual([directory])
            expect(memoryFileSystem.removedPaths).toEqual([])
            expect(memoryFileSystem.files.get(savedPath)).toBe("Keep durable lessons concise.")
            expect(memoryFileSystem.files.get(savedPath)).not.toContain("<!--")
            expect(memoryFileSystem.files.get(savedPath)).not.toContain("## memory")
            expect(memoryFileSystem.files.get(savedPath)).not.toContain("```json")
            expect(result).toBe("OK")
        })
    })

    test("supersedes same-timestamp memory with same normalized ID", async () => {
        await withFixedTime(async () => {
            const directory = join(resolve("/project-root"), ".opencode", "autocode", "memories")
            const oldPath = join(directory, "2026-09-16 12h34s56 browser tools.md")
            const filename = "2026-09-16 12h34s56 Browser Tools,Chrome,Firefox;UI tests.md"
            const savedPath = join(directory, filename)
            const oldMemory = "old memory"
            const memoryFileSystem = createMemoryFileSystem(new Map([[oldPath, oldMemory]]))

            const result = await executeLearn(memoryFileSystem.fileSystem, validArgs)

            expect(memoryFileSystem.removedPaths).toEqual([oldPath])
            expect(memoryFileSystem.files.has(oldPath)).toBe(false)
            expect(memoryFileSystem.renamedPaths).toHaveLength(1)
            expect(memoryFileSystem.renamedPaths[0]?.oldPath).toMatch(/\.autocode-memory-.+\.tmp$/)
            expect(memoryFileSystem.renamedPaths[0]?.newPath).toBe(savedPath)
            expect(memoryFileSystem.files.get(savedPath)).toBe("Keep durable lessons concise.")
            expect(result).toBe("OK")
        })
    })

    test("formats compact comma-separated context keywords", async () => {
        await withFixedTime(async () => {
            const memoryFileSystem = createMemoryFileSystem()
            const filename = "2026-09-17 12h28s52 wsl2-windows-host,environment,wsl,ubuntu,windows-11;wsl2,windows.md"

            const result = await executeLearn(memoryFileSystem.fileSystem, {
                memory: "Use WSL2 environment settings.",
                id_keyword: "wsl2-windows-host",
                alias_keywords: "environment,wsl,ubuntu,windows-11",
                context_keywords: "environment,wsl2,ubuntu,windows",
            })

            expect(memoryFileSystem.renamedPaths[0]?.newPath).toBe(join(resolve("/project-root"), ".opencode", "autocode", "memories", filename))
            expect(result).toBe("OK")
        }, new Date("2026-09-17T12:28:52.000Z"))
    })

    test("allows empty alias and context strings", () => {
        expect(validateLearnArgs({
            memory: validArgs.memory,
            id_keyword: validArgs.id_keyword,
            alias_keywords: "",
            context_keywords: "  ",
        })).toMatchObject({
            memory: {
                aliases: [],
                context: undefined,
            },
            normalizedId: "browser tools",
            removedDuplicates: [],
        })
    })

    test("returns retry envelopes for unsafe, missing, empty, and invalid values", async () => {
        const memoryFileSystem = createMemoryFileSystem()
        const invalidArgs = [
            { ...validArgs, memory: undefined },
            { ...validArgs, memory: "  " },
            { ...validArgs, id_keyword: undefined },
            { ...validArgs, id_keyword: "  " },
            { ...validArgs, id_keyword: "x".repeat(256) },
            { ...validArgs, alias_keywords: ["Chrome"] },
            { ...validArgs, context_keywords: "UI tests, " },
            { ...validArgs, positive_example: 1 },
            { ...validArgs, negative_example: false },
            { ...validArgs, references: ["https://bun.sh", 1] },
        ]

        for (const args of invalidArgs) {
            const result = parseEnvelope(await executeLearn(memoryFileSystem.fileSystem, args))

            expect(result.failedAction).toBe("learn")
            expect(result.error).toEqual(expect.any(String))
            expect(result.instruction).toContain("Retry")
        }
        expect(memoryFileSystem.mkdirPaths).toEqual([])
    })

    test("returns abort envelope when local-memory core filesystem save fails", async () => {
        const fileSystem: LocalMemoryFileSystem = {
            async mkdir(): Promise<string | undefined> {
                throw new Error("disk unavailable")
            },
            async readFile(): Promise<string> {
                return ""
            },
            async readdir(): Promise<string[]> {
                return []
            },
            async rename(): Promise<void> {
            },
            async rm(): Promise<void> {
            },
            async writeFile(): Promise<void> {
            },
        }

        const result = parseEnvelope(await executeLearn(fileSystem, validArgs))

        expect(result).toMatchObject({
            failedAction: "learn",
            error: "LocalMemoryError: create local memory directory: disk unavailable",
        })
        expect(result.instruction).toContain("Immediately ABORT")
    })
})
