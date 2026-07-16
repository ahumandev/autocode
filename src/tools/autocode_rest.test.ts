import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { resetRetryCounts } from "@/utils/tools"
import { createAutocodeRestTool } from "./autocode_rest"
import { createToolContext } from "./test_context"

type ParsedError = {
    error: string
    failedAction: string
    instruction: string
}

type SessionRecord = {
    id?: string
    parentID?: string | null
    title?: string | null
}

function createMissingError(): NodeJS.ErrnoException {
    const error = new Error("missing") as NodeJS.ErrnoException
    error.code = "ENOENT"
    return error
}

function createDirent(name: string, type: "file" | "directory"): import("fs").Dirent {
    return {
        name,
        isDirectory: () => type === "directory",
        isFile: () => type === "file",
    } as import("fs").Dirent
}

function parseResult<T>(result: string | { output: string }): T {
    return JSON.parse(typeof result === "string" ? result : result.output) as T
}

function parseError(result: string | { output: string }): ParsedError {
    return parseResult<ParsedError>(result)
}

function createSessionClient(sessions: Record<string, SessionRecord> = { "session-1": { title: "My Job" } }): OpencodeClient {
    return {
        session: {
            get: async ({ path: requestPath }: { path: { id: string }, query: { directory: string } }) => ({
                data: {
                    id: requestPath.id,
                    ...(sessions[requestPath.id] ?? {}),
                },
            }),
        },
    } as unknown as OpencodeClient
}

function createMemoryRestFileSystem() {
    const files = new Map<string, string>()
    const directories = new Set<string>(["/", "/workspace", "/workspace/.agents", "/workspace/.agents/jobs", "/workspace/.agents/jobs/drafts", "/workspace/.agents/jobs/drafts/my_job"])

    function normalize(targetPath: string): string {
        return path.resolve(targetPath)
    }

    function ensureDirectory(dirPath: string): void {
        let current = normalize(dirPath)
        const missing: string[] = []
        while (!directories.has(current)) {
            missing.push(current)
            const parent = path.dirname(current)
            if (parent === current) break
            current = parent
        }

        for (let index = missing.length - 1; index >= 0; index -= 1) {
            directories.add(missing[index])
        }
    }

    async function readFile(filePath: string, _encoding: "utf8"): Promise<string> {
        const normalizedPath = normalize(filePath)
        const content = files.get(normalizedPath)
        if (content === undefined) {
            throw createMissingError()
        }
        return content
    }

    async function writeFile(filePath: string, content: string | Buffer | Uint8Array): Promise<void> {
        const normalizedPath = normalize(filePath)
        ensureDirectory(path.dirname(normalizedPath))
        const stored = typeof content === "string" ? content : content.toString()
        files.set(normalizedPath, stored)
    }

    async function stat(targetPath: string): Promise<{ mtimeMs: number }> {
        const normalizedPath = normalize(targetPath)
        if (files.has(normalizedPath) || directories.has(normalizedPath)) {
            return { mtimeMs: 1 }
        }
        throw createMissingError()
    }

    async function mkdir(dirPath: string, _options?: { recursive?: boolean }): Promise<void> {
        ensureDirectory(dirPath)
    }

    async function readdir(dirPath: string, options?: { withFileTypes?: boolean }): Promise<string[] | import("fs").Dirent[]> {
        const normalizedPath = normalize(dirPath)
        if (!directories.has(normalizedPath)) {
            throw createMissingError()
        }

        const entries = new Map<string, "file" | "directory">()

        for (const directoryPath of directories) {
            if (directoryPath === normalizedPath) continue
            if (path.dirname(directoryPath) === normalizedPath) {
                entries.set(path.basename(directoryPath), "directory")
            }
        }

        for (const filePath of files.keys()) {
            if (path.dirname(filePath) === normalizedPath) {
                entries.set(path.basename(filePath), "file")
            }
        }

        return options?.withFileTypes
            ? [...entries.entries()].map(([name, type]) => createDirent(name, type))
            : [...entries.keys()]
    }

    async function seedFile(filePath: string, content: string): Promise<void> {
        await writeFile(filePath, content)
    }

    function getFile(filePath: string): string | undefined {
        return files.get(normalize(filePath))
    }

    function listFiles(): string[] {
        return [...files.keys()].sort()
    }

    return {
        mkdir,
        readFile,
        readdir,
        stat,
        writeFile,
        seedFile,
        getFile,
        listFiles,
    }
}

async function seedCurrentJobSession(fileSystem: ReturnType<typeof createMemoryRestFileSystem>): Promise<void> {
    await fileSystem.seedFile("/workspace/.agents/jobs/drafts/my_job/session.yml", "session_id: session-1\n")
}

async function withFixedDate<T>(isoDate: string, fn: () => Promise<T>): Promise<T> {
    const RealDate = Date
    const fixedMs = new RealDate(isoDate).valueOf()
    class FixedDate extends RealDate {
        constructor(value?: string | number | Date) {
            super(value === undefined ? fixedMs : value)
        }

        static now(): number {
            return fixedMs
        }
    }

    ;(globalThis as typeof globalThis & { Date: DateConstructor }).Date = FixedDate as unknown as DateConstructor
    try {
        return await fn()
    }
    finally {
        ;(globalThis as typeof globalThis & { Date: DateConstructor }).Date = RealDate
    }
}

describe("autocode_rest tools", () => {
    const originalFetch = globalThis.fetch

    beforeEach(() => {
        resetRetryCounts()
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    test("validates method and protocol and serializes headers", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const client = createSessionClient()
        const tool = createAutocodeRestTool(client, fileSystem)

        await seedCurrentJobSession(fileSystem)

        const invalidMethod = parseError(await tool.execute({ url: "http://example.com", method: "trace" } as never, createToolContext()))
        expect(invalidMethod.failedAction).toBe("autocode_rest")
        expect(invalidMethod.error).toContain("Invalid method: trace")
        expect(invalidMethod.instruction).toContain("Use method as one of")

        const invalidProtocol = parseError(await tool.execute({ url: "ftp://example.com", method: "get" } as never, createToolContext()))
        expect(invalidProtocol.failedAction).toBe("autocode_rest")
        expect(invalidProtocol.error).toContain("Unsupported protocol: ftp:")
        expect(invalidProtocol.instruction).toContain("Use only http or https URLs")

        const requests: Array<{ init?: RequestInit, url: URL }> = []
        globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
            requests.push({ init, url: new URL(String(input)) })
            return new Response("ok", {
                status: 201,
                headers: {
                    "Content-Type": "text/plain",
                    "X-Bool": "true",
                    "X-Number": "42",
                },
            })
        }) as unknown as typeof fetch

        const parsed = parseResult<{ response_body: string, response_body_file_path: string, response_headers: Record<string, string>, status_code: number, response_id: string, response_time: number }>(await tool.execute({
            url: "http://example.com/path?a=old&keep=1",
            method: "post",
            headers: { "X-Bool": true, "X-Number": 42 },
        } as never, createToolContext()))

        expect(requests).toHaveLength(1)
        expect(requests[0]?.url.search).toBe("?a=old&keep=1")
        expect(requests[0]?.init?.method).toBe("POST")
        expect(requests[0]?.init?.headers).toEqual({ "X-Bool": "true", "X-Number": "42" })
        expect(parsed.status_code).toBe(201)
        expect(parsed.response_headers).toEqual({
            "content-type": "text/plain",
            "x-bool": "true",
            "x-number": "42",
        })
        expect(parsed.response_body).toBe("ok")
        expect(parsed.response_body_file_path).toBeTruthy()
        expect(parsed.response_id).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.\d{3}$/)
        expect(typeof parsed.response_time).toBe("number")
        expect(parsed.response_time).toBeGreaterThanOrEqual(0)
    })

    test("saves body to file always, omits inline response_body when large, uses collision suffix", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem)
        const smallBody = "hello world"
        const longBody = "b".repeat(500)

        await seedCurrentJobSession(fileSystem)

        globalThis.fetch = (async () => new Response(smallBody, { status: 200, headers: { "Content-Type": "text/plain" } })) as unknown as typeof fetch
        const exactResult = parseResult<Record<string, unknown>>(await tool.execute({
            url: "http://example.com/exact",
            method: "GET",
        } as never, createToolContext()))

        expect(exactResult.response_body).toBe(smallBody)
        expect(exactResult.response_body_file_path).toBeTruthy()
        expect(String(exactResult.response_id)).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.\d{3}$/)
        expect(typeof exactResult.response_time).toBe("number")

        await withFixedDate("2026-06-15T12:34:56.789Z", async () => {
            globalThis.fetch = (async () => new Response(longBody, { status: 401, headers: { "X-Test": "value" } })) as unknown as typeof fetch
            const firstLarge = parseResult<Record<string, unknown>>(await tool.execute({
                url: "http://example.com/api/v1",
                method: "GET",
            } as never, createToolContext()))

            expect(firstLarge.response_body).toBeUndefined()
            expect(firstLarge.response_body_file_path).toBeTruthy()
            expect(String(firstLarge.response_id)).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.\d{3}$/)

            const firstBodyFilePath = String(firstLarge.response_body_file_path)
            const firstAbsolute = path.isAbsolute(firstBodyFilePath) ? firstBodyFilePath : path.join(process.cwd(), firstBodyFilePath)
            expect(fileSystem.getFile(firstAbsolute)).toBe(longBody)

            globalThis.fetch = (async () => new Response("c".repeat(500), { status: 500 })) as unknown as typeof fetch
            const secondLarge = parseResult<Record<string, unknown>>(await tool.execute({
                url: "http://example.com/api/v1",
                method: "GET",
            } as never, createToolContext()))

            expect(secondLarge.response_id).toBe(firstLarge.response_id)
            const secondBodyFilePath = String(secondLarge.response_body_file_path)
            expect(secondBodyFilePath).not.toBe(firstBodyFilePath)
            expect(secondBodyFilePath).toContain("_2.")
            const secondAbsolute = path.isAbsolute(secondBodyFilePath) ? secondBodyFilePath : path.join(process.cwd(), secondBodyFilePath)
            expect(fileSystem.getFile(secondAbsolute)).toBe("c".repeat(500))
        })
    })

    test("decodes non-utf8 bytes with replacement chars", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem)

        await seedCurrentJobSession(fileSystem)
        globalThis.fetch = (async () => new Response(new Uint8Array([0xff, 0xfe, 65]), { status: 200, headers: { "content-type": "text/plain" } })) as unknown as typeof fetch

        const parsed = parseResult<{ response_body: string, response_body_file_path: string, response_id: string, response_time: number }>(await tool.execute({
            url: "http://example.com/binary",
            method: "GET",
        } as never, createToolContext()))

        expect(parsed.response_body).toContain("�")
        expect(parsed.response_body.endsWith("A")).toBe(true)
        expect(parsed.response_body_file_path).toBeTruthy()
        expect(parsed.response_id).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.\d{3}$/)
        expect(typeof parsed.response_time).toBe("number")
        expect(parsed.response_time).toBeGreaterThanOrEqual(0)
    })

    test("returns timed_out json with actual response_time when request exceeds timeout", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem)

        await seedCurrentJobSession(fileSystem)

        let abortReceived: Error | undefined
        globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) => {
            return new Promise((_resolve, reject) => {
                const signal = init?.signal
                if (!signal) {
                    reject(new Error("no signal"))
                    return
                }
                if (signal.aborted) {
                    reject(new DOMException("aborted", "AbortError"))
                    return
                }
                signal.addEventListener("abort", () => {
                    const err = new Error("aborted")
                    err.name = "AbortError"
                    abortReceived = err
                    reject(err)
                })
            })
        }) as unknown as typeof fetch

        const result = parseResult<Record<string, unknown>>(await tool.execute({
            url: "http://example.com/slow",
            method: "GET",
            timeout: 50,
        } as never, createToolContext()))

        expect(result.timed_out).toBe(true)
        expect(result.timeout_ms).toBe(50)
        expect(typeof result.response_time).toBe("number")
        expect(result.response_time).toBeGreaterThanOrEqual(50)
        expect(typeof result.response_id).toBe("string")
        expect(String(result.response_id)).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.\d{3}$/)
        expect(result.status_code).toBeUndefined()
        expect(result.response_body).toBeUndefined()
        expect(abortReceived).toBeDefined()
        expect(abortReceived?.name).toBe("AbortError")
    })

    test("auto-creates assist job dir when no planned job matches the session title", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestTool(createSessionClient({ "session-1": { title: "My REST Query" } }), fileSystem)

        globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch

        const parsed = parseResult<{ response_body: string, response_body_file_path: string, status_code: number, response_id: string, response_time: number }>(await tool.execute({
            url: "http://example.com/api",
            method: "GET",
        } as never, createToolContext()))

        expect(parsed.status_code).toBe(200)
        expect(parsed.response_body).toBe("ok")
        expect(parsed.response_body_file_path).toBeTruthy()
        expect(parsed.response_id).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.\d{3}$/)
        expect(typeof parsed.response_time).toBe("number")

        const jobDir = "/workspace/.agents/jobs/assist/my_rest_query"
        expect(fileSystem.getFile(`${jobDir}/session.yml`)).toBe("session_id: session-1\n")
        await expect(fileSystem.stat(`${jobDir}/rest`)).resolves.toEqual({ mtimeMs: 1 })
    })

    test("still errors when session title yields empty slug", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestTool(createSessionClient({ "session-1": { title: "!!!" } }), fileSystem)

        const errored = parseError(await tool.execute({
            url: "http://example.com/api",
            method: "GET",
        } as never, createToolContext()))

        expect(errored.failedAction).toBe("autocode_rest")
        expect(errored.error).toContain("No active planned job context was found for current session.")

        await expect(fileSystem.stat("/workspace/.agents/jobs/assist")).rejects.toMatchObject({ code: "ENOENT" })
    })

    test("does not auto-create assist dir when an existing planned job is resolved", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem)

        await seedCurrentJobSession(fileSystem)
        globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch

        const parsed = parseResult<{ status_code: number, response_id: string, response_time: number }>(await tool.execute({
            url: "http://example.com/api",
            method: "GET",
        } as never, createToolContext()))

        expect(parsed.status_code).toBe(200)
        expect(parsed.response_id).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.\d{3}$/)
        expect(typeof parsed.response_time).toBe("number")
        const allFiles = fileSystem.listFiles()
        expect(allFiles).toContain("/workspace/.agents/jobs/drafts/my_job/session.yml")
        expect(allFiles.some(f => f.includes("/assist/"))).toBe(false)
        await expect(fileSystem.stat("/workspace/.agents/jobs/assist")).rejects.toMatchObject({ code: "ENOENT" })
    })
})
