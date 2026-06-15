import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { resetRetryCounts } from "@/utils/tools"
import { createAutocodeRestResponseEvalTool, createAutocodeRestResponseGrepTool, createAutocodeRestResponseReadTool, createAutocodeRestTool } from "./autocode_rest"
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

type CacheRecord = {
    url: string
    method: string
    status_code: number
    headers: Record<string, string>
    body: string
    created_at: string
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

    async function writeFile(filePath: string, content: string): Promise<void> {
        const normalizedPath = normalize(filePath)
        ensureDirectory(path.dirname(normalizedPath))
        files.set(normalizedPath, content)
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

async function seedCachedResponse(fileSystem: ReturnType<typeof createMemoryRestFileSystem>, responseName: string, cache: Partial<CacheRecord> = {}): Promise<void> {
    await seedCurrentJobSession(fileSystem)
    await fileSystem.mkdir("/workspace/.agents/jobs/drafts/my_job/rest", { recursive: true })
    await fileSystem.writeFile(`/workspace/.agents/jobs/drafts/my_job/rest/${responseName}`, JSON.stringify({
        url: "http://example.com/api",
        method: "GET",
        status_code: 200,
        headers: { "Content-Type": "application/json" },
        body: "",
        created_at: "2026-06-15T00:00:00.000Z",
        ...cache,
    }, null, 2))
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

    test("validates method and protocol, overrides duplicate query params, and serializes headers", async () => {
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

        const parsed = parseResult<{ body: string, full_response: boolean, headers: Record<string, string>, status_code: number, truncated: boolean }>(await tool.execute({
            url: "http://example.com/path?a=old&keep=1",
            method: "post",
            headers: { "X-Bool": true, "X-Number": 42 },
            query: { a: "new", b: ["x", "y"] },
        } as never, createToolContext()))

        expect(requests).toHaveLength(1)
        expect(requests[0]?.url.search).toBe("?keep=1&a=new&b=x&b=y")
        expect(requests[0]?.url.searchParams.getAll("a")).toEqual(["new"])
        expect(requests[0]?.url.searchParams.getAll("b")).toEqual(["x", "y"])
        expect(requests[0]?.init?.method).toBe("POST")
        expect(requests[0]?.init?.headers).toEqual({ "X-Bool": "true", "X-Number": "42" })
        expect(parsed).toEqual({
            status_code: 201,
            headers: {
                "content-type": "text/plain",
                "x-bool": "true",
                "x-number": "42",
            },
            body: "ok",
            full_response: true,
            truncated: false,
        })
    })

    test("ignores excerpt_size and still truncates to 400 chars", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem)
        const longBody = "x".repeat(500)

        await seedCurrentJobSession(fileSystem)
        globalThis.fetch = (async () => new Response(longBody, { status: 200 })) as unknown as typeof fetch

        const parsed = parseResult<{ body: string, full_response: boolean, truncated: boolean }>(await tool.execute({
            url: "http://example.com/long",
            method: "GET",
            excerpt_size: 10,
        } as never, createToolContext()))

        expect(parsed.body).toHaveLength(400)
        expect(parsed.full_response).toBe(false)
        expect(parsed.truncated).toBe(true)
    })

    test("returns full 400-char body without cache and caches truncated larger bodies with stable naming and collision suffix", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem)
        const exactBody = "a".repeat(400)
        const longBody = "b".repeat(401)

        await seedCurrentJobSession(fileSystem)

        globalThis.fetch = (async () => new Response(exactBody, { status: 200, headers: { "Content-Type": "text/plain" } })) as unknown as typeof fetch
        const exactResult = parseResult<Record<string, unknown>>(await tool.execute({
            url: "http://example.com/exact",
            method: "GET",
        } as never, createToolContext()))

        expect(exactResult.body).toBe(exactBody)
        expect(exactResult.full_response).toBe(true)
        expect(exactResult.truncated).toBe(false)
        expect(exactResult.response_name).toBeUndefined()
        expect(exactResult.job_name).toBeUndefined()
        expect(fileSystem.listFiles()).toEqual(["/workspace/.agents/jobs/drafts/my_job/session.yml"])

        await withFixedDate("2026-06-15T12:34:56.789Z", async () => {
            globalThis.fetch = (async () => new Response(longBody, { status: 401, headers: { "X-Test": "value" } })) as unknown as typeof fetch
            const firstLarge = parseResult<Record<string, unknown>>(await tool.execute({
                url: "http://example.com/api/v1?q=hidden",
                method: "GET",
            } as never, createToolContext()))

            expect(String(firstLarge.body)).toBe(longBody.slice(0, 400))
            expect(firstLarge.full_response).toBe(false)
            expect(firstLarge.truncated).toBe(true)
            expect(firstLarge.job_name).toBe("my_job")
            expect(firstLarge.guidance).toBe("Body truncated and cached. Use autocode_rest_response_read, autocode_rest_grep, or autocode_rest_response_eval with response_name.")
            expect(firstLarge.response_name).toMatch(/^26-06-15_12-34-56-789_GET_http_example\.com_/)
            expect(String(firstLarge.response_name)).toContain("_GET_http_example.com_")
            expect(String(firstLarge.response_name)).toContain("_^api^v1")
            expect(String(firstLarge.response_name)).not.toContain("hidden")

            const cachedFirst = JSON.parse(fileSystem.getFile(`/workspace/.agents/jobs/drafts/my_job/rest/${String(firstLarge.response_name)}`) ?? "null") as CacheRecord
            expect(cachedFirst.body).toBe(longBody)
            expect(cachedFirst.url).toBe("http://example.com/api/v1?q=hidden")

            globalThis.fetch = (async () => new Response("c".repeat(500), { status: 500 })) as unknown as typeof fetch
            const secondLarge = parseResult<Record<string, unknown>>(await tool.execute({
                url: "http://example.com/api/v1?q=other",
                method: "GET",
            } as never, createToolContext()))

            expect(String(secondLarge.response_name)).toContain("_GET_http_example.com_")
            expect(String(secondLarge.response_name)).toContain("_^api^v1")
            expect(String(secondLarge.response_name)).toMatch(/_2\.json$/)
        })
    })

    test("caches long response filename with credential password host port and encoded path", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem)

        await seedCurrentJobSession(fileSystem)

        await withFixedDate("2026-06-15T12:34:56.789Z", async () => {
            globalThis.fetch = (async () => new Response("x".repeat(401), { status: 200 })) as unknown as typeof fetch

            const result = parseResult<Record<string, unknown>>(await tool.execute({
                url: "http://username:password@subdomain.host:8000/api/v1",
                method: "GET",
            } as never, createToolContext()))

            expect(result.response_name).toMatch(/^26-06-15_12-34-56-789_GET_http_username-cGFzc3dvcmQ=@subdomain\.host-8000_\^api\^v1\.json$/)
            expect(String(result.response_name)).toContain("username-cGFzc3dvcmQ=@subdomain.host-8000")
            expect(String(result.response_name)).not.toContain(":8000")
            expect(String(result.response_name)).toContain("^api^v1")
        })
    })

    test("encodes credential password with standard base64 padding in cache filename", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem)
        const expected = Buffer.from("password", "utf8").toString("base64")

        await seedCurrentJobSession(fileSystem)

        expect(expected).toBe("cGFzc3dvcmQ=")

        await withFixedDate("2026-06-15T12:34:56.789Z", async () => {
            globalThis.fetch = (async () => new Response("x".repeat(401), { status: 200 })) as unknown as typeof fetch

            const result = parseResult<Record<string, unknown>>(await tool.execute({
                url: "http://username:password@example.com/api",
                method: "GET",
            } as never, createToolContext()))

            expect(String(result.response_name)).toContain(`username-${expected}@example.com`)
            expect(String(result.response_name)).not.toContain("username-cGFzc3dvcmQ@example.com")
            expect(String(result.response_name)).not.toContain("password@example.com")
        })
    })

    test("replaces explicit port colon with hyphen in cache filename host segment", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem)

        await seedCurrentJobSession(fileSystem)

        await withFixedDate("2026-06-15T12:34:56.789Z", async () => {
            globalThis.fetch = (async () => new Response("x".repeat(401), { status: 200 })) as unknown as typeof fetch

            const result = parseResult<Record<string, unknown>>(await tool.execute({
                url: "http://example.com:8000/api",
                method: "GET",
            } as never, createToolContext()))
            const responseName = String(result.response_name)
            const hostSegment = responseName.split("_GET_http_")[1]?.split("_^api")[0]

            expect(responseName).toContain("_GET_http_example.com-8000_")
            expect(responseName).not.toContain(":8000")
            expect(String(hostSegment)).not.toContain(":")
        })
    })

    test("converts password base64 slash to underscore without bang sanitizing credential segment", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem)
        const password = "࿿a"
        const encoded = Buffer.from(password, "utf8").toString("base64")
        const expectedPassword = encoded.replaceAll("/", "_")

        await seedCurrentJobSession(fileSystem)

        expect(encoded).toContain("/")
        expect(encoded).toContain("+")
        expect(encoded.endsWith("==")).toBe(true)

        await withFixedDate("2026-06-15T12:34:56.789Z", async () => {
            globalThis.fetch = (async () => new Response("x".repeat(401), { status: 200 })) as unknown as typeof fetch

            const result = parseResult<Record<string, unknown>>(await tool.execute({
                url: `http://username:${encodeURIComponent(password)}@example.com/api`,
                method: "GET",
            } as never, createToolContext()))
            const responseName = String(result.response_name)
            const hostSegment = responseName.split("_GET_http_")[1]?.split("_^api")[0]

            expect(responseName).toContain(`username-${expectedPassword}@example.com`)
            expect(String(hostSegment)).not.toContain("!")
            expect(responseName).not.toContain(encoded)
            expect(responseName).toContain("+")
            expect(responseName).toContain("==")
        })
    })

    test("returns retry json on timeout with longer-timeout guidance", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem)

        await seedCurrentJobSession(fileSystem)
        globalThis.fetch = ((_: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
                const error = new Error("aborted")
                error.name = "AbortError"
                reject(error)
            }, { once: true })
        })) as unknown as typeof fetch

        const parsed = parseError(await tool.execute({
            url: "http://example.com/slow",
            method: "GET",
            timeout: 5,
        } as never, createToolContext()))

        expect(parsed.failedAction).toBe("autocode_rest")
        expect(parsed.error).toContain("Request timed out after 5ms")
        expect(parsed.instruction).toContain("longer timeout")
    })

    test("decodes non-utf8 bytes with replacement chars", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem)

        await seedCurrentJobSession(fileSystem)
        globalThis.fetch = (async () => new Response(new Uint8Array([0xff, 0xfe, 65]), { status: 200 })) as unknown as typeof fetch

        const parsed = parseResult<{ body: string, full_response: boolean, truncated: boolean }>(await tool.execute({
            url: "http://example.com/binary",
            method: "GET",
        } as never, createToolContext()))

        expect(parsed.body).toContain("�")
        expect(parsed.body.endsWith("A")).toBe(true)
        expect(parsed.full_response).toBe(true)
        expect(parsed.truncated).toBe(false)
    })

    test("reads cached body lines and headers with paging", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const bodyReadTool = createAutocodeRestResponseReadTool(createSessionClient(), fileSystem)

        await seedCachedResponse(fileSystem, "cached.json", {
            headers: { "X-Test": "alpha\nbeta" },
            body: "line 1\nline 2\nline 3\nline 4",
        })

        const bodyResult = parseResult<{ lines: Array<{ line: number, text: string }>, offset: number, total_lines: number, source: string }>(await bodyReadTool.execute({
            response_name: "cached.json",
            offset: 2,
            limit: 2,
        } as never, createToolContext()))

        expect(bodyResult.source).toBe("body")
        expect(bodyResult.offset).toBe(2)
        expect(bodyResult.total_lines).toBe(4)
        expect(bodyResult.lines).toEqual([
            { line: 2, text: "line 2" },
            { line: 3, text: "line 3" },
        ])

        const headerResult = parseResult<{ lines: Array<{ line: number, text: string }>, source: string }>(await bodyReadTool.execute({
            response_name: "cached.json",
            header: "x-test",
        } as never, createToolContext()))

        expect(headerResult.source).toBe("X-Test")
        expect(headerResult.lines).toEqual([
            { line: 1, text: "alpha" },
            { line: 2, text: "beta" },
        ])
    })

    test("retries on invalid read paging, missing response, and traversal", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestResponseReadTool(createSessionClient(), fileSystem)

        await seedCurrentJobSession(fileSystem)

        const invalidPaging = parseError(await tool.execute({ response_name: "cached.json", offset: 0, limit: 1 } as never, createToolContext()))
        expect(invalidPaging.failedAction).toBe("autocode_rest_response_read")
        expect(invalidPaging.error).toContain("offset and limit must be positive integers")

        const missingResponse = parseError(await tool.execute({ response_name: "missing.json" } as never, createToolContext()))
        expect(missingResponse.error).toContain("Cached response not found")

        const traversal = parseError(await tool.execute({ response_name: "../x" } as never, createToolContext()))
        expect(traversal.error).toContain("Unsafe response_name")
    })

    test("greps cached body and returns line, column, and match counts", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestResponseGrepTool(createSessionClient(), fileSystem)

        await seedCachedResponse(fileSystem, "grep.json", {
            body: "zero\nalpha beta\nbeta",
        })

        const matches = parseResult<{ match_count: number, matches: Array<{ column: number, line: number, text: string }>, source: string }>(await tool.execute({
            response_name: "grep.json",
            pattern: "beta",
        } as never, createToolContext()))

        expect(matches.source).toBe("body")
        expect(matches.match_count).toBe(2)
        expect(matches.matches).toEqual([
            { line: 2, column: 7, text: "alpha beta" },
            { line: 3, column: 1, text: "beta" },
        ])

        const noMatches = parseResult<{ match_count: number, matches: unknown[] }>(await tool.execute({
            response_name: "grep.json",
            pattern: "gamma",
        } as never, createToolContext()))

        expect(noMatches.match_count).toBe(0)
        expect(noMatches.matches).toEqual([])
    })

    test("retries on invalid grep regex, missing response, and traversal", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestResponseGrepTool(createSessionClient(), fileSystem)

        await seedCurrentJobSession(fileSystem)
        await seedCachedResponse(fileSystem, "grep.json", { body: "alpha" })

        const invalidRegex = parseError(await tool.execute({ response_name: "grep.json", pattern: "[" } as never, createToolContext()))
        expect(invalidRegex.failedAction).toBe("autocode_rest_grep")
        expect(invalidRegex.instruction).toContain("valid JavaScript regular expression")

        const missingResponse = parseError(await tool.execute({ response_name: "missing.json", pattern: "alpha" } as never, createToolContext()))
        expect(missingResponse.error).toContain("Cached response not found")

        const traversal = parseError(await tool.execute({ response_name: "../x", pattern: "alpha" } as never, createToolContext()))
        expect(traversal.error).toContain("Unsafe response_name")
    })

    test("evaluates cached json paths for objects, arrays, and missing values", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestResponseEvalTool(createSessionClient(), fileSystem)

        await seedCachedResponse(fileSystem, "eval.json", {
            body: JSON.stringify({ alpha: { beta: [{ id: 7 }] }, list: ["x", "y"] }),
        })

        const objectPath = parseResult<{ response_name: string, eval: string, found: boolean, value: unknown }>(await tool.execute({
            response_name: "eval.json",
            eval: "alpha.beta[0].id",
        } as never, createToolContext()))
        expect(objectPath).toEqual({ response_name: "eval.json", eval: "alpha.beta[0].id", found: true, value: 7 })

        const arrayPath = parseResult<{ response_name: string, eval: string, found: boolean, value: unknown }>(await tool.execute({
            response_name: "eval.json",
            eval: "list[1]",
        } as never, createToolContext()))
        expect(arrayPath).toEqual({ response_name: "eval.json", eval: "list[1]", found: true, value: "y" })

        const missingPath = parseResult<{ response_name: string, eval: string, found: boolean }>(await tool.execute({
            response_name: "eval.json",
            eval: "alpha.beta[1]",
        } as never, createToolContext()))
        expect(missingPath).toEqual({ response_name: "eval.json", eval: "alpha.beta[1]", found: false })
    })

    test("retries on invalid cached json, invalid eval, missing response, and traversal", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestResponseEvalTool(createSessionClient(), fileSystem)

        await seedCurrentJobSession(fileSystem)
        await seedCachedResponse(fileSystem, "text.json", { body: "not json" })
        await seedCachedResponse(fileSystem, "json.json", { body: JSON.stringify({ alpha: 1 }) })

        const invalidJson = parseError(await tool.execute({ response_name: "text.json", eval: "alpha" } as never, createToolContext()))
        expect(invalidJson.failedAction).toBe("autocode_rest_response_eval")
        expect(invalidJson.instruction).toContain("non-JSON cached bodies")

        const invalidEval = parseError(await tool.execute({ response_name: "json.json", eval: "alpha..beta" } as never, createToolContext()))
        expect(invalidEval.error).toContain("Invalid eval expression")
        expect(invalidEval.instruction).toContain("Use only dots, identifiers, and numeric bracket indexes")

        const missingResponse = parseError(await tool.execute({ response_name: "missing.json", eval: "alpha" } as never, createToolContext()))
        expect(missingResponse.error).toContain("Cached response not found")

        const traversal = parseError(await tool.execute({ response_name: "../x", eval: "alpha" } as never, createToolContext()))
        expect(traversal.error).toContain("Unsafe response_name")
    })
})
