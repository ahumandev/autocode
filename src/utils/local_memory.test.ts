import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
    applyLocalMemoryXmlBudget,
    formatLocalMemoryFilename,
    formatLocalMemoryTimestamp,
    getLocalMemoryDirectory,
    isTrustedLocalMemoryXmlBlock,
    loadLocalMemories,
    LocalMemoryError,
    localMemoryMaximumXmlCharacters,
    normalizeLocalMemoryMatchValue,
    parseLocalMemoryFilename,
    parseTrustedLocalMemoryXmlBlocks,
    renderLocalMemoryXml,
    saveLocalMemory,
    selectLocalMemories,
    trustedLocalMemoryXmlMarker,
    type LocalMemory,
    type LocalMemoryFileSystem,
    type LocalMemoryTimingCollector,
} from "./local_memory"

type FileAction = { name: string, path: string, target?: string }

function missingError(): NodeJS.ErrnoException {
    const error = new Error("missing") as NodeJS.ErrnoException
    error.code = "ENOENT"
    return error
}

function createFileSystem(): LocalMemoryFileSystem & { actions: FileAction[], files: Map<string, string>, directories: Set<string>, readdirCalls: number } {
    const files = new Map<string, string>()
    const directories = new Set<string>()
    const actions: FileAction[] = []
    let readdirCalls = 0
    return {
        actions,
        files,
        directories,
        get readdirCalls(): number {
            return readdirCalls
        },
        async mkdir(directoryPath: string): Promise<string | undefined> {
            actions.push({ name: "mkdir", path: directoryPath })
            directories.add(directoryPath)
            return undefined
        },
        async readFile(filePath: string, encoding: "utf8"): Promise<string> {
            actions.push({ name: `read:${encoding}`, path: filePath })
            const content = files.get(filePath)
            if (content === undefined) throw missingError()
            return content
        },
        async readdir(directoryPath: string): Promise<string[]> {
            readdirCalls += 1
            actions.push({ name: "readdir", path: directoryPath })
            if (!directories.has(directoryPath)) throw missingError()
            return [...files.keys()]
                .filter((filePath: string): boolean => filePath.startsWith(`${directoryPath}${path.sep}`))
                .map((filePath: string): string => filePath.slice(directoryPath.length + 1))
                .filter((name: string): boolean => !name.includes(path.sep))
        },
        async rename(oldPath: string, newPath: string): Promise<void> {
            actions.push({ name: "rename", path: oldPath, target: newPath })
            const content = files.get(oldPath)
            if (content === undefined) throw missingError()
            files.delete(oldPath)
            files.set(newPath, content)
        },
        async rm(filePath: string): Promise<void> {
            actions.push({ name: "rm", path: filePath })
            files.delete(filePath)
        },
        async writeFile(filePath: string, content: string): Promise<void> {
            actions.push({ name: "write", path: filePath })
            files.set(filePath, content)
        },
    }
}

const projectRoot = path.resolve("/workspace/project")
const context = { directory: projectRoot, worktree: projectRoot }
const directory = path.join(projectRoot, ".opencode", "autocode", "memories")

function at(timestamp: string): () => Date {
    return (): Date => new Date(`${timestamp.replace(" ", "T").replace(/(\d{2})h(\d{2})s/, "$1:$2:")}Z`)
}

async function store(fileSystem: LocalMemoryFileSystem, timestamp: string, memory: LocalMemory): Promise<void> {
    await saveLocalMemory(fileSystem, context, memory, { now: at(timestamp), temporary_suffix: (): string => `tmp-${timestamp}` })
}

function paddedMemory(id: string, renderedLength: number): LocalMemory {
    const baseLength = renderLocalMemoryXml({ id, memory: "" }, id).length
    if (renderedLength < baseLength) throw new Error("Requested XML block is too short.")
    return { id, memory: "x".repeat(renderedLength - baseLength) }
}

async function createMemoryFixture(timestamp: string, memory: LocalMemory): Promise<{ filename: string, body: string }> {
    const fileSystem = createFileSystem()
    const saved = await saveLocalMemory(fileSystem, context, memory, { now: at(timestamp), temporary_suffix: (): string => `fixture-${timestamp}` })
    const body = fileSystem.files.get(saved.path)
    if (body === undefined) throw new Error("Stored local memory fixture is missing.")
    return { filename: saved.memory.filename, body }
}

async function expectLocalMemoryError(operation: Promise<unknown>, code: LocalMemoryError["code"]): Promise<void> {
    try {
        await operation
        throw new Error("Expected local memory operation to reject.")
    }
    catch (error) {
        expect(error).toBeInstanceOf(LocalMemoryError)
        expect((error as LocalMemoryError).code).toBe(code)
    }
}

describe("local memory filenames and normalization", () => {
    test("resolves exact memory directory and normalizes NFKC whitespace and case", () => {
        expect(getLocalMemoryDirectory(context)).toBe(directory)
        expect(normalizeLocalMemoryMatchValue("  ＡＰＩ\u00a0\tREQUEST  ")).toBe("api request")
    })

    test("formats UTC timestamps and reversibly encodes split metadata", () => {
        const timestamp = formatLocalMemoryTimestamp(new Date("2026-02-03T04:05:06.999-07:00"))
        const metadata = { id: "ID,; %<>:\"/\\|?*", aliases: ["alias,one", "semi; %"], context: "ctx, ; %<>:\"/\\|?*" }
        const filename = formatLocalMemoryFilename(timestamp, metadata)

        expect(timestamp).toBe("2026-02-03 11h05s06")
        expect(filename).toContain("%2C")
        expect(filename).toContain("%3B")
        expect(filename).toContain("ID%2C%3B %25")
        expect(filename).not.toContain("%20")
        expect(parseLocalMemoryFilename(filename)).toEqual({ timestamp, ...metadata })
    })

    test("formats compact comma-separated context metadata", () => {
        const timestamp = "2026-09-17 12h28s52"
        const metadata = {
            id: "wsl2-windows-host",
            aliases: ["environment", "wsl", "ubuntu", "windows-11"],
            context: "wsl2,windows",
        }

        const filename = "2026-09-17 12h28s52 wsl2-windows-host,environment,wsl,ubuntu,windows-11;wsl2,windows.md"

        expect(formatLocalMemoryFilename(timestamp, metadata)).toBe(filename)
        expect(parseLocalMemoryFilename(filename)).toEqual({ timestamp, ...metadata })
    })

    test("rejects malformed filenames and never truncates platform-limited names", () => {
        const timestamp = "2026-01-01 00h00s00"
        const exact = formatLocalMemoryFilename(timestamp, { id: "a".repeat(232) })

        expect(exact).toHaveLength(255)
        expect(Buffer.byteLength(exact, "utf8")).toBe(255)
        expect((): string => formatLocalMemoryFilename(timestamp, { id: "a".repeat(233) })).toThrow(LocalMemoryError)
        expect((): { timestamp: string, id: string, aliases: string[], context: string } => parseLocalMemoryFilename(`${timestamp} id%2c.md`)).toThrow("not canonical")
        expect((): { timestamp: string, id: string, aliases: string[], context: string } => parseLocalMemoryFilename(`${timestamp} id%20part.md`)).toThrow("not canonical")
        expect((): { timestamp: string, id: string, aliases: string[], context: string } => parseLocalMemoryFilename(`${timestamp} id;ctx;again.md`)).toThrow("multiple context separators")
        expect((): { timestamp: string, id: string, aliases: string[], context: string } => parseLocalMemoryFilename("not-a-memory.txt")).toThrow(LocalMemoryError)
    })

    test("rejects UTF-8-expanded filenames without truncation", () => {
        const timestamp = "2026-01-01 00h00s00"
        const id = "é".repeat(100)
        const encodedFilename = `${timestamp} ${encodeURIComponent(id)}.md`

        expect(id.length).toBeLessThan(255)
        expect(Buffer.byteLength(encodedFilename, "utf8")).toBeGreaterThan(255)
        expect((): string => formatLocalMemoryFilename(timestamp, { id })).toThrow(LocalMemoryError)
        try {
            formatLocalMemoryFilename(timestamp, { id })
        }
        catch (error) {
            expect((error as LocalMemoryError).code).toBe("FILENAME_TOO_LONG")
        }
    })
})

describe("local memory persistence", () => {
    test("stores raw memory text and derives metadata from filename", async () => {
        const fileSystem = createFileSystem()
        const memory: LocalMemory = {
            id: "Markdown",
            aliases: ["md"],
            context: "documentation",
            memory: "Use plain Markdown memory text.\nKeep each lesson focused.",
            positive_example: "## memory\n```json",
            negative_example: "```\n-->",
            references: ["https://example.test/?a=1&b=2", "## not a heading"],
        }

        await store(fileSystem, "2026-01-02 03h04s05", memory)
        const body = [...fileSystem.files.values()][0]
        const loaded = await loadLocalMemories(fileSystem, context)

        expect(body).toBe(memory.memory)
        expect(body).not.toContain("<!--")
        expect(body).not.toContain("## memory")
        expect(body).not.toContain("```json")
        expect(loaded.memories).toHaveLength(1)
        expect(loaded.memories[0]).toMatchObject({ id: memory.id, aliases: memory.aliases, context: memory.context, memory: memory.memory })
    })

    test("loads legacy wrapped memory with filename metadata", async () => {
        const fileSystem = createFileSystem()
        const timestamp = "2026-01-02 03h04s05"
        const filename = formatLocalMemoryFilename(timestamp, { id: "Legacy", aliases: ["old"], context: "migration" })
        const body = [
            "<!-- autocode-local-memory:v1",
            `{"timestamp":"${timestamp}","id":"Legacy","aliases":["old"],"context":"migration"}`,
            "-->",
            "## memory",
            "```json",
            '"legacy memory"',
            "```",
            "",
        ].join("\n")
        fileSystem.directories.add(directory)
        fileSystem.files.set(path.join(directory, filename), body)

        await expect(loadLocalMemories(fileSystem, context)).resolves.toMatchObject({
            memories: [{ id: "Legacy", aliases: ["old"], context: "migration", memory: "legacy memory" }],
        })
    })

    test("rejects malformed persisted bodies", async () => {
        const fileSystem = createFileSystem()
        const filename = formatLocalMemoryFilename("2026-01-02 03h04s05", { id: "Broken" })
        fileSystem.directories.add(directory)
        fileSystem.files.set(path.join(directory, filename), "<!-- autocode-local-memory:v1\n{}\n-->\n## memory\n```json\nnot-json\n```\n")

        await expect(loadLocalMemories(fileSystem, context)).rejects.toMatchObject({ code: "MALFORMED_MEMORY" })
    })

    test("rejects non-string runtime aliases as invalid memory", async () => {
        const fileSystem = createFileSystem()
        const hostileMemory = { id: "Hostile", aliases: [42], memory: "body" } as unknown as LocalMemory

        await expectLocalMemoryError(saveLocalMemory(fileSystem, context, hostileMemory), "INVALID_MEMORY")
    })

    test("loads a missing active store empty without reading or seeding archived and legacy skills", async () => {
        const fileSystem = createFileSystem()
        const archiveDirectory = path.join(projectRoot, ".opencode", "autocode", "memory-archive", "v1", "retained")
        const legacyDirectory = path.join(projectRoot, ".agents", "skills")
        const archive = await createMemoryFixture("2026-01-02 03h04s05", { id: "Archived", memory: "archive memory" })
        const archivePath = path.join(archiveDirectory, archive.filename)
        const legacyPath = path.join(legacyDirectory, "learned-legacy.md")
        const legacyContent = "# Learned legacy\n\nLegacy skill content.\n"
        fileSystem.directories.add(archiveDirectory)
        fileSystem.directories.add(legacyDirectory)
        fileSystem.files.set(archivePath, archive.body)
        fileSystem.files.set(legacyPath, legacyContent)
        const filesBeforeLoad = new Map(fileSystem.files)
        const directoriesBeforeLoad = new Set(fileSystem.directories)

        const loaded = await loadLocalMemories(fileSystem, context)

        expect(loaded).toEqual({ memories: [], trace: [] })
        expect(fileSystem.directories.has(directory)).toBe(false)
        expect(fileSystem.actions).toEqual([{ name: "readdir", path: directory }])
        expect(fileSystem.actions.filter((action: FileAction): boolean => ["mkdir", "rename", "rm", "write"].includes(action.name))).toEqual([])
        expect(fileSystem.readdirCalls).toBe(1)
        expect(fileSystem.files.get(archivePath)).toBe(archive.body)
        expect(fileSystem.files.get(legacyPath)).toBe(legacyContent)
        expect(fileSystem.files).toEqual(filesBeforeLoad)
        expect(fileSystem.directories).toEqual(directoriesBeforeLoad)
    })

    test("wraps save mkdir and readdir failures as filesystem errors", async () => {
        const mkdirFileSystem = createFileSystem()
        mkdirFileSystem.mkdir = async (): Promise<string | undefined> => {
            throw new Error("mkdir failure")
        }
        const readdirFileSystem = createFileSystem()
        readdirFileSystem.readdir = async (): Promise<string[]> => {
            throw new Error("readdir failure")
        }

        await expectLocalMemoryError(saveLocalMemory(mkdirFileSystem, context, { id: "Mkdir", memory: "body" }), "FILESYSTEM")
        await expectLocalMemoryError(saveLocalMemory(readdirFileSystem, context, { id: "Readdir", memory: "body" }), "FILESYSTEM")
    })

    test("cleans temporary files after save write, remove, and rename failures", async () => {
        const writeFileSystem = createFileSystem()
        writeFileSystem.writeFile = async (filePath: string): Promise<void> => {
            writeFileSystem.actions.push({ name: "write", path: filePath })
            throw new Error("write failure")
        }
        await expectLocalMemoryError(saveLocalMemory(writeFileSystem, context, { id: "Write", memory: "body" }, { temporary_suffix: (): string => "write" }), "FILESYSTEM")
        expect(writeFileSystem.actions.map((action: FileAction): string => action.name)).toEqual(["mkdir", "readdir", "write", "rm"])
        expect([...writeFileSystem.files.keys()].some((filePath: string): boolean => filePath.endsWith(".tmp"))).toBe(false)

        const removeFileSystem = createFileSystem()
        const existing = await createMemoryFixture("2026-01-02 03h04s05", { id: "Remove", memory: "old" })
        removeFileSystem.directories.add(directory)
        removeFileSystem.files.set(path.join(directory, existing.filename), existing.body)
        const remove = removeFileSystem.rm.bind(removeFileSystem)
        removeFileSystem.rm = async (filePath: string): Promise<void> => {
            if (filePath === path.join(directory, existing.filename)) {
                removeFileSystem.actions.push({ name: "rm", path: filePath })
                throw new Error("remove failure")
            }
            await remove(filePath)
        }
        await expectLocalMemoryError(saveLocalMemory(removeFileSystem, context, { id: "remove", memory: "replacement" }, { now: at("2026-01-02 03h04s05"), temporary_suffix: (): string => "remove" }), "FILESYSTEM")
        expect(removeFileSystem.actions.map((action: FileAction): string => action.name)).toEqual(["mkdir", "readdir", "write", "rm", "rm"])
        expect([...removeFileSystem.files.keys()].some((filePath: string): boolean => filePath.endsWith(".tmp"))).toBe(false)

        const renameFileSystem = createFileSystem()
        renameFileSystem.rename = async (oldPath: string, newPath: string): Promise<void> => {
            renameFileSystem.actions.push({ name: "rename", path: oldPath, target: newPath })
            throw new Error("rename failure")
        }
        await expectLocalMemoryError(saveLocalMemory(renameFileSystem, context, { id: "Rename", memory: "body" }, { temporary_suffix: (): string => "rename" }), "FILESYSTEM")
        expect(renameFileSystem.actions.map((action: FileAction): string => action.name)).toEqual(["mkdir", "readdir", "write", "rename", "rm"])
        expect([...renameFileSystem.files.keys()].some((filePath: string): boolean => filePath.endsWith(".tmp"))).toBe(false)
    })

    test("wraps load readdir and readFile failures as filesystem errors", async () => {
        const readdirFileSystem = createFileSystem()
        readdirFileSystem.readdir = async (): Promise<string[]> => {
            throw new Error("readdir failure")
        }
        await expectLocalMemoryError(loadLocalMemories(readdirFileSystem, context), "FILESYSTEM")

        const readFileSystem = createFileSystem()
        await store(readFileSystem, "2026-01-02 03h04s05", { id: "Read", memory: "body" })
        readFileSystem.readFile = async (): Promise<string> => {
            throw new Error("read failure")
        }
        await expectLocalMemoryError(loadLocalMemories(readFileSystem, context), "FILESYSTEM")
    })

    test("removes every same-time normalized-ID filename before replacement", async () => {
        const fileSystem = createFileSystem()
        const timestamp = "2026-01-02 03h04s05"
        const first = await createMemoryFixture(timestamp, { id: "API", aliases: ["old-one"], context: "old context", memory: "old one" })
        const second = await createMemoryFixture(timestamp, { id: " api ", aliases: ["old-two"], context: "other context", memory: "old two" })
        const distinct = await createMemoryFixture(timestamp, { id: "Other", memory: "survives" })
        fileSystem.directories.add(directory)
        fileSystem.files.set(path.join(directory, first.filename), first.body)
        fileSystem.files.set(path.join(directory, second.filename), second.body)
        fileSystem.files.set(path.join(directory, distinct.filename), distinct.body)

        const saved = await saveLocalMemory(fileSystem, context, { id: "Api", aliases: ["new"], context: "replacement context", memory: "replacement" }, {
            now: at(timestamp),
            temporary_suffix: (): string => "collision",
        })

        expect(saved.trace).toEqual([{ reason: "saved", replaced_same_timestamp_versions: 2 }])
        expect(fileSystem.files.has(path.join(directory, first.filename))).toBe(false)
        expect(fileSystem.files.has(path.join(directory, second.filename))).toBe(false)
        expect(fileSystem.files.has(path.join(directory, distinct.filename))).toBe(true)
        expect([...fileSystem.files.keys()].filter((filePath: string): boolean => filePath.startsWith(`${directory}${path.sep}`) && filePath.endsWith(".md"))).toHaveLength(2)
    })

    test("classifies malformed filenames and persisted content with exact error codes", async () => {
        const timestamp = "2026-01-02 03h04s05"
        const fixture = await createMemoryFixture(timestamp, { id: "Valid", aliases: ["alias"], context: "context", memory: "body", positive_example: "positive" })
        const legacyBody = [
            "<!-- autocode-local-memory:v1",
            '{"timestamp":"2026-01-02 03h04s05","id":"Valid","aliases":["alias"],"context":"context"}',
            "-->",
            "## memory",
            "```json",
            '"body"',
            "```",
            "## positive_example",
            "```json",
            '"positive"',
            "```",
            "",
        ].join("\n")
        const cases: Array<{ filename: string, body: string, code: LocalMemoryError["code"] }> = [
            { filename: `${timestamp} Valid%ZZ.md`, body: fixture.body, code: "INVALID_FILENAME" },
            { filename: fixture.filename, body: legacyBody.replace('"aliases":["alias"]', '"aliases":"alias"'), code: "MALFORMED_MEMORY" },
            { filename: fixture.filename, body: legacyBody.replace("## memory\n```json\n\"body\"\n```\n## positive_example\n```json\n\"positive\"\n```\n", "## positive_example\n```json\n\"positive\"\n```\n## memory\n```json\n\"body\"\n```\n"), code: "MALFORMED_MEMORY" },
            { filename: fixture.filename, body: legacyBody.replace('"id":"Valid"', '"id":"Different"'), code: "MALFORMED_MEMORY" },
            { filename: fixture.filename, body: legacyBody.replace("## memory\n```json\n\"body\"\n```\n", ""), code: "MALFORMED_MEMORY" },
        ]

        for (const malformed of cases) {
            const fileSystem = createFileSystem()
            fileSystem.directories.add(directory)
            fileSystem.files.set(path.join(directory, malformed.filename), malformed.body)
            await expectLocalMemoryError(loadLocalMemories(fileSystem, context), malformed.code)
        }
    })

    test("replaces only same normalized ID and timestamp after temporary safe write", async () => {
        const fileSystem = createFileSystem()
        await store(fileSystem, "2026-01-02 03h04s05", { id: "API", aliases: ["old"], context: "old context", memory: "old" })
        await store(fileSystem, "2026-01-02 03h04s05", { id: "Other", memory: "untouched" })
        fileSystem.actions.length = 0

        const saved = await saveLocalMemory(fileSystem, context, { id: " api ", aliases: ["new"], context: "new context", memory: "replacement" }, {
            now: at("2026-01-02 03h04s05"),
            temporary_suffix: (): string => "known-temp",
        })

        expect(saved.trace).toEqual([{ reason: "saved", replaced_same_timestamp_versions: 1 }])
        expect(fileSystem.actions.map((action: FileAction): string => action.name)).toEqual(["mkdir", "readdir", "write", "rm", "rename"])
        expect(fileSystem.actions[2].path).toBe(path.join(directory, ".autocode-memory-known-temp.tmp"))
        expect(fileSystem.actions[4].target).toBe(path.join(directory, saved.memory.filename))
        expect((await loadLocalMemories(fileSystem, context)).memories.map((memory) => [memory.id, memory.memory])).toEqual([["Other", "untouched"], [" api ", "replacement"]])
    })

    test("rescans disk, retains newest normalized IDs, and prevents old aliases reviving", async () => {
        const fileSystem = createFileSystem()
        await store(fileSystem, "2026-01-01 00h00s00", { id: "Service", aliases: ["legacy"], memory: "old" })
        await store(fileSystem, "2026-01-03 00h00s00", { id: " service ", aliases: ["current"], memory: "new" })
        await store(fileSystem, "2026-01-02 00h00s00", { id: "Different", memory: "other" })

        const first = await loadLocalMemories(fileSystem, context)
        const second = await selectLocalMemories(fileSystem, context, { prompt: "legacy", loaded_ids: [] })

        expect(first.memories.map((memory) => memory.id)).toEqual([" service ", "Different"])
        expect(first.trace).toEqual([{ reason: "duplicate_version_drop", timestamp: "2026-01-01 00h00s00", retained_timestamp: "2026-01-03 00h00s00" }])
        expect(second.memories).toEqual([])
        expect(second.trace).toContainEqual({ reason: "no_match" })
        expect(fileSystem.readdirCalls).toBeGreaterThanOrEqual(5)
    })
})

describe("local memory selection", () => {
    test("collects optional non-overlapping timing stages without changing selection", async () => {
        const fileSystem = createFileSystem()
        await store(fileSystem, "2026-01-01 00h00s00", { id: "deploy", memory: "deploy memory" })
        const uninstrumented = await selectLocalMemories(fileSystem, context, { prompt: "deploy", loaded_ids: [] })
        const timing: LocalMemoryTimingCollector = {
            directory_listing: 0,
            body_read: 0,
            parsing_normalization: 0,
            selection_matching: 0,
            body_render_sizing: 0,
        }

        const instrumented = await selectLocalMemories(fileSystem, context, { prompt: "deploy", loaded_ids: [], timing })

        expect(instrumented).toEqual(uninstrumented)
        for (const value of Object.values(timing)) {
            expect(value).toEqual(expect.any(Number))
            expect(value).toBeGreaterThan(0)
        }
    })

    test("skips loaded IDs from fresh disk scans without caching", async () => {
        const fileSystem = createFileSystem()
        await store(fileSystem, "2026-01-02 00h00s00", { id: "Plugin", memory: "disk secret" })
        const first = await selectLocalMemories(fileSystem, context, { prompt: "plugin", loaded_ids: [" plugin "] })
        await store(fileSystem, "2026-01-03 00h00s00", { id: "Fresh", memory: "fresh" })
        const second = await selectLocalMemories(fileSystem, context, { prompt: "fresh", loaded_ids: [] })

        expect(first.memories).toEqual([])
        expect(first.trace).toContainEqual({ reason: "loaded_id_skip", timestamp: "2026-01-02 00h00s00" })
        expect(second.memories.map((selected) => selected.memory.id)).toEqual(["Fresh"])
        expect(fileSystem.readdirCalls).toBeGreaterThanOrEqual(4)
    })

    test("orders specific matches newest-first, ID before aliases, then contexts by prompt position", async () => {
        const fileSystem = createFileSystem()
        await store(fileSystem, "2026-01-01 00h00s00", { id: "Beta", aliases: ["alpha"], context: "first context", memory: "old" })
        await store(fileSystem, "2026-01-03 00h00s00", { id: "Newest", aliases: ["alpha"], context: "later context", memory: "new" })
        await store(fileSystem, "2026-01-02 00h00s00", { id: "Same", aliases: ["same"], memory: "same" })
        await store(fileSystem, "2026-01-04 00h00s00", { id: "Neutral", context: "gamma topic", memory: "context one" })
        await store(fileSystem, "2026-01-05 00h00s00", { id: "NeutralTwo", context: "delta topic", memory: "context two" })

        const result = await selectLocalMemories(fileSystem, context, { prompt: "Beta alpha same delta topic gamma topic", loaded_ids: [] })

        expect(result.memories.map((selected) => [selected.memory.id, selected.matched_keyword, selected.matched_source])).toEqual([
            ["Newest", "alpha", "alias"],
            ["Same", "Same", "id"],
            ["Beta", "Beta", "id"],
            ["NeutralTwo", "delta topic", "context"],
            ["Neutral", "gamma topic", "context"],
        ])
    })

    test("orders same-position context matches by newer timestamp first", async () => {
        const fileSystem = createFileSystem()
        await store(fileSystem, "2026-01-01 00h00s00", { id: "Older", context: "shared prompt context", memory: "old" })
        await store(fileSystem, "2026-01-02 00h00s00", { id: "Newer", context: "shared prompt context", memory: "new" })

        const result = await selectLocalMemories(fileSystem, context, { prompt: "shared prompt context", loaded_ids: [] })

        expect(result.memories.map((entry) => [entry.memory.id, entry.matched_source])).toEqual([
            ["Newer", "context"],
            ["Older", "context"],
        ])
    })

    test("does not merge distinct IDs sharing keywords and enforces phrase identifier boundaries", async () => {
        const fileSystem = createFileSystem()
        await store(fileSystem, "2026-01-01 00h00s00", { id: "API", aliases: ["shared"], memory: "api secret" })
        await store(fileSystem, "2026-01-02 00h00s00", { id: "Other", aliases: ["shared"], memory: "other secret" })
        await store(fileSystem, "2026-01-03 00h00s00", { id: "BillingService.ts", memory: "billing secret" })

        const selected = await selectLocalMemories(fileSystem, context, { prompt: "api request shared BillingService.ts", loaded_ids: [] })
        const excluded = await selectLocalMemories(fileSystem, context, { prompt: "capital BillingServiceFactory", loaded_ids: [] })

        expect(selected.memories.map((entry) => entry.memory.id)).toEqual(["BillingService.ts", "Other", "API"])
        expect(excluded.memories).toEqual([])
    })

    test("excludes underscore-delimited available_skills from word-boundary matches", async () => {
        const fileSystem = createFileSystem()
        await store(fileSystem, "2026-01-01 00h00s00", { id: "skills", memory: "skill memory" })

        const result = await selectLocalMemories(fileSystem, context, { prompt: "<available_skills>", loaded_ids: [] })

        expect(result.memories).toEqual([])
        expect(result.trace).toContainEqual({ reason: "no_match" })
    })

    test("normalizes prompt semantics and keeps prompt and memory secrets out of traces", async () => {
        const fileSystem = createFileSystem()
        const promptSecret = "PROMPT-SECRET-931"
        const bodySecret = "BODY-SECRET-932"
        await store(fileSystem, "2026-01-01 00h00s00", { id: "ＡＰＩ\u00a0request", memory: bodySecret })

        const result = await selectLocalMemories(fileSystem, context, { prompt: `  api\tREQUEST ${promptSecret}  `, loaded_ids: [] })

        expect(result.memories).toHaveLength(1)
        expect(result.trace).toContainEqual({ reason: "selected", source: "id", timestamp: "2026-01-01 00h00s00" })
        expect(JSON.stringify(result.trace)).not.toContain(promptSecret)
        expect(JSON.stringify(result.trace)).not.toContain(bodySecret)
    })
})

describe("trusted local memory XML", () => {
    test("uses fixed trusted marker and escapes attributes and content", () => {
        const xml = renderLocalMemoryXml({ id: "id & < > ' \"", memory: "body & < > ' \"", references: ["ref & <"] }, "match & <")
        const parsed = parseTrustedLocalMemoryXmlBlocks(xml)

        expect(xml).toContain(`xmlns:autocode="${trustedLocalMemoryXmlMarker.namespace_uri}"`)
        expect(xml).toContain('autocode:version="1" autocode:owner="autocode"')
        expect(xml).toContain("&amp;")
        expect(parsed).toEqual([{ id_keyword: "id & < > ' \"", matched_keyword: "match & <", xml }])
        expect(isTrustedLocalMemoryXmlBlock(xml)).toBe(true)
        expect(isTrustedLocalMemoryXmlBlock("<memory id_keyword=\"id\">user content</memory>")).toBe(false)
    })

    test("round-trips escaped blocks separated by the XML block separator", () => {
        const first = renderLocalMemoryXml({
            id: "first & < > ' \"",
            memory: "memory & < > ' \"",
            positive_example: "positive & < > ' \"",
            negative_example: "negative & < > ' \"",
            references: ["reference & < > ' \""],
        }, `first & < > ' "`)
        const second = renderLocalMemoryXml({ id: "second", memory: "second memory" }, "second")
        const xml = `${first}\n${second}`

        expect(xml).toContain("&amp;")
        expect(xml).toContain("&lt;")
        expect(xml).toContain("&gt;")
        expect(xml).toContain("&apos;")
        expect(xml).toContain("&quot;")
        expect(parseTrustedLocalMemoryXmlBlocks(xml)).toEqual([
            { id_keyword: "first & < > ' \"", matched_keyword: "first & < > ' \"", xml: first },
            { id_keyword: "second", matched_keyword: "second", xml: second },
        ])
    })
})

describe("local memory XML budget", () => {
    test("stops at literal greedy budget overflow without bin-packing later blocks", () => {
        const first = "a".repeat(3900)
        const second = "b".repeat(150)
        const third = "c".repeat(40)

        expect(first).toHaveLength(3900)
        expect(second).toHaveLength(150)
        expect(third).toHaveLength(40)

        const result = applyLocalMemoryXmlBudget([first, second, third])

        expect(result.blocks).toEqual([first])
        expect(result.characterCount).toBe(3900)
        expect(result.stoppedAtIndex).toBe(1)
        expect(result.blocks).not.toContain(third)
    })

    test("stops at overflowing second block and does not bin-pack smallest fitting third block", async () => {
        const fileSystem = createFileSystem()
        const thirdLength = renderLocalMemoryXml({ id: "third", memory: "" }, "third").length
        const secondLength = renderLocalMemoryXml({ id: "second", memory: "" }, "second").length
        const firstLength = localMemoryMaximumXmlCharacters - 1 - thirdLength
        await store(fileSystem, "2026-01-03 00h00s00", paddedMemory("first", firstLength))
        await store(fileSystem, "2026-01-02 00h00s00", paddedMemory("second", secondLength))
        await store(fileSystem, "2026-01-01 00h00s00", paddedMemory("third", thirdLength))

        const result = await selectLocalMemories(fileSystem, context, { prompt: "first second third", loaded_ids: [] })

        expect(firstLength + 1 + secondLength).toBeGreaterThan(localMemoryMaximumXmlCharacters)
        expect(firstLength + 1 + thirdLength).toBe(localMemoryMaximumXmlCharacters)
        expect(result.memories.map((entry) => entry.memory.id)).toEqual(["first"])
        expect(result.trace).toContainEqual({ reason: "budget_stop", selected_characters: firstLength, next_block_characters: secondLength })
        expect(result.memories.map((entry) => entry.memory.id)).not.toContain("third")
    })

    test("accepts 3999 and 4000 UTF-16 blocks, then rejects 4001 and oversized first blocks", async () => {
        for (const size of [3999, 4000, 4001]) {
            const fileSystem = createFileSystem()
            const id = `item-${size}`
            await store(fileSystem, "2026-01-01 00h00s00", paddedMemory(id, size))
            const result = await selectLocalMemories(fileSystem, context, { prompt: id, loaded_ids: [] })

            if (size <= localMemoryMaximumXmlCharacters) {
                expect(result.characters).toBe(size)
                expect(result.memories).toHaveLength(1)
            }
            else {
                expect(result).toMatchObject({ characters: 0, memories: [] })
                expect(result.trace).toContainEqual({ reason: "budget_stop", selected_characters: 0, next_block_characters: size })
            }
            if (size === localMemoryMaximumXmlCharacters) {
                expect(result.trace).toContainEqual({ reason: "budget_stop", selected_characters: 4000, next_block_characters: 0 })
            }
        }
    })

    test("includes separators, supports more than seven blocks, and traces no match", async () => {
        const manyFileSystem = createFileSystem()
        const ids = Array.from({ length: 8 }, (_, index) => `many-${index}`)
        for (const [index, id] of ids.entries()) await store(manyFileSystem, `2026-01-01 00h00s${String(index).padStart(2, "0")}`, paddedMemory(id, 300))
        const many = await selectLocalMemories(manyFileSystem, context, { prompt: ids.join(" "), loaded_ids: [] })
        const none = await selectLocalMemories(manyFileSystem, context, { prompt: "no matching phrase", loaded_ids: [] })

        expect(many.memories).toHaveLength(8)
        expect(many.characters).toBe(8 * 300 + 7)
        expect(none.trace).toContainEqual({ reason: "no_match" })
    })
})
