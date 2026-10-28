import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { resetRetryCounts } from "@/utils/tools"
import type { CredentialKind, CredentialResolver, ResolvedCredentialProfile, RestCredentialProfile } from "../credentials/types"
import { createAutocodeRestTool } from "./autocode_rest"
import { createToolContext as baseCreateToolContext } from "./test_context"

const workspace = path.resolve("workspace")
const createToolContext = (): ReturnType<typeof baseCreateToolContext> => baseCreateToolContext({ directory: workspace, worktree: workspace })
const profileAuthorization = "Bearer resolved-authorization-marker"
const profileUsername = "resolved-username-marker"
const profilePassword = "resolved-password-marker"
const explicitAuthorization = "Bearer explicit-authorization-marker"
const basicToken = Buffer.from(`${profileUsername}:${profilePassword}`, "utf8").toString("base64")
const basicAuthorization = `Basic ${basicToken}`
const secretMarkers = [profileAuthorization, profileUsername, profilePassword, basicAuthorization, basicToken, explicitAuthorization, "resolved-authorization-marker", "explicit-authorization-marker"]
const secretDiagnosticMessage = secretMarkers.join(" | ")
const resolutionError = "Unable to resolve REST authentication credentials."
const requestFailureError = "REST request or response caching failed."
const credentialTestKey = "  my_key9  "
const normalizedCredentialTestKey = "MY_KEY9"

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

type HostileDiagnostic = {
    value: unknown
    hookCalls: string[]
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

function expectSafeError(result: string | { output: string }, message: string, markers: readonly string[] = secretMarkers): void {
    const error = parseError(result)
    expect(error.failedAction).toBe("autocode_rest")
    expect(error.error).toBe(message)
    expect(error.instruction).toEqual(expect.any(String))
    expect(error.instruction.length).toBeGreaterThan(0)
    const envelope = JSON.stringify(result)
    for (const marker of markers) {
        expect(envelope).not.toContain(marker)
    }
}

function createFakeCredentialResolver(options: { profile: RestCredentialProfile } | { error: unknown } = { error: new Error("Unexpected credential lookup") }): {
    resolver: CredentialResolver
    calls: Array<{ kind: CredentialKind, id: string }>
} {
    const calls: Array<{ kind: CredentialKind, id: string }> = []
    const profiles: { [K in CredentialKind]?: ResolvedCredentialProfile<K> } = {}
    if ("profile" in options) {
        profiles.rest = { kind: "rest", provider: "plaintext", profile: options.profile }
    }
    const resolver: CredentialResolver = {
        async resolve<K extends CredentialKind>(kind: K, id: string): Promise<ResolvedCredentialProfile<K>> {
            calls.push({ kind, id })
            if ("error" in options) throw options.error
            const result = profiles[kind]
            if (result === undefined) throw new Error("Unexpected credential kind")
            return result
        },
    }
    return { resolver, calls }
}

function captureRestRequests(): Headers[] {
    const requests: Headers[] = []
    globalThis.fetch = (async (_input, init): Promise<Response> => {
        requests.push(new Headers(init?.headers))
        return new Response("ok")
    }) as typeof fetch
    return requests
}

function createSecretDiagnosticFields(): Record<string, unknown> {
    return {
        authorization: profileAuthorization,
        username: profileUsername,
        password: profilePassword,
        basicToken,
        basicAuthorization,
        explicitAuthorization,
        profile: { authorization: profileAuthorization, username: profileUsername, password: profilePassword },
    }
}

const hostileDiagnosticCases = [
    {
        name: "secret string",
        create(): HostileDiagnostic {
            return { value: secretDiagnosticMessage, hookCalls: [] }
        },
    },
    {
        name: "plain object",
        create(): HostileDiagnostic {
            return { value: createSecretDiagnosticFields(), hookCalls: [] }
        },
    },
    {
        name: "null-prototype object",
        create(): HostileDiagnostic {
            return { value: Object.assign(Object.create(null), createSecretDiagnosticFields()), hookCalls: [] }
        },
    },
    {
        name: "non-Error class with cause",
        create(): HostileDiagnostic {
            class DiagnosticWithCause {
                readonly cause = createSecretDiagnosticFields()
            }
            return { value: new DiagnosticWithCause(), hookCalls: [] }
        },
    },
    {
        name: "toJSON hook",
        create(): HostileDiagnostic {
            const hookCalls: string[] = []
            return {
                value: {
                    ...createSecretDiagnosticFields(),
                    toJSON(): Record<string, unknown> {
                        hookCalls.push("toJSON")
                        return createSecretDiagnosticFields()
                    },
                },
                hookCalls,
            }
        },
    },
    {
        name: "toString hook",
        create(): HostileDiagnostic {
            const hookCalls: string[] = []
            return {
                value: {
                    ...createSecretDiagnosticFields(),
                    toString(): string {
                        hookCalls.push("toString")
                        return secretDiagnosticMessage
                    },
                },
                hookCalls,
            }
        },
    },
    {
        name: "credential getters and primitive hook",
        create(): HostileDiagnostic {
            const hookCalls: string[] = []
            const rejectInspection = (property: string): never => {
                hookCalls.push(property)
                throw new Error(secretDiagnosticMessage)
            }
            return {
                value: {
                    ...createSecretDiagnosticFields(),
                    get message(): never {
                        return rejectInspection("message")
                    },
                    get name(): never {
                        return rejectInspection("name")
                    },
                    get cause(): never {
                        return rejectInspection("cause")
                    },
                    get authorization(): never {
                        return rejectInspection("authorization")
                    },
                    get username(): never {
                        return rejectInspection("username")
                    },
                    get password(): never {
                        return rejectInspection("password")
                    },
                    get profile(): never {
                        return rejectInspection("profile")
                    },
                    [Symbol.toPrimitive](): never {
                        return rejectInspection("Symbol.toPrimitive")
                    },
                },
                hookCalls,
            }
        },
    },
]

async function withRestEnvironmentReadTrap(fn: (reads: readonly string[]) => Promise<void>): Promise<void> {
    const originalEnvironment = process.env
    const reads: string[] = []
    const sentinel = new Error("REST credential environment reads are forbidden.")
    const probeKey = "AUTOCODE_REST___READ_TRAP_PROBE__"
    const trappedEnvironment = new Proxy(originalEnvironment, {
        get(target: NodeJS.ProcessEnv, property: string | symbol, receiver: unknown): unknown {
            if (typeof property === "string" && property.startsWith("AUTOCODE_REST_")) {
                reads.push(property)
                throw sentinel
            }
            return Reflect.get(target, property, receiver)
        },
    })
    try {
        process.env = trappedEnvironment
        expect(process.env === trappedEnvironment).toBe(true)
        let sentinelMatched = false
        try {
            Reflect.get(process.env, probeKey)
        }
        catch (error: unknown) {
            sentinelMatched = error === sentinel
        }
        expect(sentinelMatched).toBe(true)
        expect(reads.length === 1 && reads[0] === probeKey).toBe(true)
        reads.length = 0
        await fn(reads)
        expect(reads).toEqual([])
    }
    finally {
        process.env = originalEnvironment
        expect(process.env === originalEnvironment).toBe(true)
    }
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

function createMemoryRestFileSystem(options: { includeCurrentWorkspace?: boolean } = {}) {
    const files = new Map<string, string>()
    const directories = new Set<string>([
        workspace,
        path.join(workspace, ".agents"),
        path.join(workspace, ".agents", "jobs"),
        ...(options.includeCurrentWorkspace === false ? [] : [path.join(workspace, ".agents", "jobs", "2026-08-20_10-30-00_my_job")]),
    ])

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

    async function mkdir(dirPath: string, _options?: { recursive?: boolean }): Promise<string | undefined> {
        ensureDirectory(dirPath)
        return undefined
    }

    async function rename(oldPath: string, newPath: string): Promise<void> {
        const content = await readFile(oldPath, "utf8")
        files.delete(normalize(oldPath))
        await writeFile(newPath, content)
    }

    async function rm(targetPath: string): Promise<void> {
        const normalizedPath = normalize(targetPath)
        for (const filePath of files.keys()) {
            if (filePath === normalizedPath || filePath.startsWith(`${normalizedPath}${path.sep}`)) files.delete(filePath)
        }
        for (const directoryPath of directories) {
            if (directoryPath === normalizedPath || directoryPath.startsWith(`${normalizedPath}${path.sep}`)) directories.delete(directoryPath)
        }
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
        rename,
        rm,
        stat,
        writeFile,
        seedFile,
        getFile,
        listFiles,
    }
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

        const invalidMethod = parseError(await tool.execute({ url: "http://example.com", method: "trace" } as never, createToolContext()))
        expect(invalidMethod.failedAction).toBe("autocode_rest")
        expect(invalidMethod.error).toBe("Invalid method.")
        expect(invalidMethod.instruction).toContain("Use method as one of")

        const invalidProtocol = parseError(await tool.execute({ url: "ftp://example.com", method: "get" } as never, createToolContext()))
        expect(invalidProtocol.failedAction).toBe("autocode_rest")
        expect(invalidProtocol.error).toBe("Unsupported protocol.")
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

    test("bypasses TLS validation by default and validates when check_tls is true", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem)
        const requests: Array<{ tls?: { rejectUnauthorized?: boolean } }> = []

        globalThis.fetch = (async (_input: URL | RequestInfo, init?: RequestInit & { tls?: { rejectUnauthorized?: boolean } }): Promise<Response> => {
            requests.push({ tls: init?.tls })
            return new Response("ok")
        }) as unknown as typeof fetch

        await tool.execute({ url: "https://example.com", method: "GET" } as never, createToolContext())
        await tool.execute({ url: "https://example.com", method: "GET", check_tls: true } as never, createToolContext())

        expect(requests[0]?.tls).toEqual({ rejectUnauthorized: false })
        expect(requests[1]?.tls).toEqual({ rejectUnauthorized: true })
    })

    test("saves body to file always, omits inline response_body when large, uses collision suffix", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem)
        const smallBody = "hello world"
        const longBody = "b".repeat(500)

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

    test("returns job-name error when session title has no usable candidate", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestTool(createSessionClient({ "session-1": { title: "!!!" } }), fileSystem)

        const errored = parseError(await tool.execute({
            url: "http://example.com/api",
            method: "GET",
        } as never, createToolContext()))

        expect(errored.failedAction).toBe("autocode_rest")
        expect(errored.error).toBe("Unable to prepare REST response directory.")
    })

    test("writes REST artifacts in the resolved timestamped workspace", async () => {
        const fileSystem = createMemoryRestFileSystem()
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem)

        globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch

        const parsed = parseResult<{ status_code: number, response_id: string, response_time: number }>(await tool.execute({
            url: "http://example.com/api",
            method: "GET",
        } as never, createToolContext()))

        expect(parsed.status_code).toBe(200)
        expect(parsed.response_id).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.\d{3}$/)
        expect(typeof parsed.response_time).toBe("number")
        const allFiles = fileSystem.listFiles()
        expect(allFiles.some((filePath) => filePath.includes(`${path.sep}2026-08-20_10-30-00_my_job${path.sep}rest${path.sep}`))).toBe(true)
    })

    test("creates current title workspace before writing REST artifact", async () => {
        const fileSystem = createMemoryRestFileSystem({ includeCurrentWorkspace: false })
        const tool = createAutocodeRestTool(createSessionClient({
            "session-1": { parentID: "middle-session", title: "Child Job" },
            "middle-session": { parentID: "root-session", title: "Middle Job" },
            "root-session": { title: "Root Job" },
        }), fileSystem)
        globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch

        const parsed = parseResult<{ status_code: number }>(await tool.execute({
            url: "http://example.com/api",
            method: "GET",
        } as never, createToolContext()))

        expect(parsed.status_code).toBe(200)
        const allFiles = fileSystem.listFiles()
        expect(allFiles.some((filePath) => filePath.includes(`_child_job${path.sep}rest${path.sep}`))).toBe(true)
    })

    test("creates current title workspace when root lookup is unavailable", async () => {
        const fileSystem = createMemoryRestFileSystem({ includeCurrentWorkspace: false })
        let lookups = 0
        const client = {
            session: {
                get: async () => {
                    lookups += 1
                    return lookups === 1 ? { data: { title: "My Job" } } : { error: "unavailable" }
                },
            },
        } as unknown as OpencodeClient
        const tool = createAutocodeRestTool(client, fileSystem)
        globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch

        const parsed = parseResult<{ status_code: number }>(await tool.execute({
            url: "http://example.com/api",
            method: "GET",
        } as never, createToolContext()))

        expect(parsed.status_code).toBe(200)
        const allFiles = fileSystem.listFiles()
        expect(allFiles.some((filePath) => filePath.includes(`_my_job${path.sep}rest${path.sep}`))).toBe(true)
    })

    test("uses resolved profile Authorization", async (): Promise<void> => {
        const fileSystem = createMemoryRestFileSystem()
        const { resolver, calls } = createFakeCredentialResolver({ profile: { authorization: profileAuthorization } })
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem, resolver)
        const requests = captureRestRequests()

        const result = parseResult<{ status_code: number }>(await tool.execute({ url: "http://example.com/api", method: "GET", rest_key: "api" } as never, createToolContext()))

        expect(result.status_code).toBe(200)
        expect(requests).toHaveLength(1)
        expect(requests[0]?.get("authorization")).toBe(profileAuthorization)
        expect(calls).toEqual([{ kind: "rest", id: "API" }])
    })

    test.each([
        { name: "nonempty", authorization: profileAuthorization },
        { name: "empty", authorization: "" },
    ])("uses $name profile Authorization before complete Basic credentials", async ({ authorization }): Promise<void> => {
        const fileSystem = createMemoryRestFileSystem()
        const { resolver, calls } = createFakeCredentialResolver({ profile: { authorization, username: profileUsername, password: profilePassword } })
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem, resolver)
        const requests = captureRestRequests()

        const result = parseResult<{ status_code: number }>(await tool.execute({ url: "http://example.com/api", method: "GET", rest_key: "api" } as never, createToolContext()))

        expect(result.status_code).toBe(200)
        expect(requests).toHaveLength(1)
        expect(requests[0]?.has("authorization")).toBe(true)
        expect(requests[0]?.get("authorization")).toBe(authorization)
        expect(calls).toEqual([{ kind: "rest", id: "API" }])
    })

    test("generates UTF-8 Basic Authorization from resolved credentials", async (): Promise<void> => {
        const fileSystem = createMemoryRestFileSystem()
        const { resolver, calls } = createFakeCredentialResolver({ profile: { username: "usér", password: "päss" } })
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem, resolver)
        const requests = captureRestRequests()

        const result = parseResult<{ status_code: number }>(await tool.execute({ url: "http://example.com/api", method: "GET", rest_key: "api" } as never, createToolContext()))

        expect(result.status_code).toBe(200)
        expect(requests).toHaveLength(1)
        expect(requests[0]?.get("authorization")).toBe("Basic dXPDqXI6cMOkc3M=")
        expect(calls).toEqual([{ kind: "rest", id: "API" }])
    })

    test.each([
        { name: "both empty", profile: { username: "", password: "" }, authorization: "Basic Og==" },
        { name: "empty username", profile: { username: "", password: "password" }, authorization: "Basic OnBhc3N3b3Jk" },
        { name: "empty password", profile: { username: "user", password: "" }, authorization: "Basic dXNlcjo=" },
        { name: "undefined authorization", profile: { authorization: undefined, username: "user", password: "password" }, authorization: "Basic dXNlcjpwYXNzd29yZA==" },
    ])("generates exact Basic Authorization with $name", async ({ profile, authorization }): Promise<void> => {
        const fileSystem = createMemoryRestFileSystem()
        const { resolver, calls } = createFakeCredentialResolver({ profile })
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem, resolver)
        const requests = captureRestRequests()

        const result = parseResult<{ status_code: number }>(await tool.execute({ url: "http://example.com/api", method: "GET", rest_key: "api" } as never, createToolContext()))

        expect(result.status_code).toBe(200)
        expect(requests).toHaveLength(1)
        expect(requests[0]?.get("authorization")).toBe(authorization)
        expect(calls).toEqual([{ kind: "rest", id: "API" }])
    })

    test.each([
        { name: "undefined", profile: undefined },
        { name: "null", profile: null },
        { name: "empty", profile: {} },
        { name: "username-only", profile: { username: profileUsername } },
        { name: "password-only", profile: { password: profilePassword } },
    ])("rejects $name profile without fallback reads or exposed secrets", async ({ profile }): Promise<void> => {
        const fileSystem = createMemoryRestFileSystem()
        const { resolver, calls } = createFakeCredentialResolver({ profile: profile as RestCredentialProfile })
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem, resolver)
        const requests = captureRestRequests()

        const result = await tool.execute({ url: "http://example.com/api", method: "GET", rest_key: "api" } as never, createToolContext())

        expectSafeError(result, resolutionError)
        expect(calls).toEqual([{ kind: "rest", id: "API" }])
        expect(requests).toHaveLength(0)
    })

    test("hides rejected resolver diagnostics without fallback reads", async (): Promise<void> => {
        const fileSystem = createMemoryRestFileSystem()
        const { resolver, calls } = createFakeCredentialResolver({ error: new Error(secretDiagnosticMessage) })
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem, resolver)
        const requests = captureRestRequests()

        const result = await tool.execute({ url: "http://example.com/api", method: "GET", rest_key: "api" } as never, createToolContext())

        expectSafeError(result, resolutionError)
        expect(calls).toEqual([{ kind: "rest", id: "API" }])
        expect(requests).toHaveLength(0)
    })

    for (const { name, create } of hostileDiagnosticCases) {
        test(`hides ${name} resolver diagnostics without inspection`, async (): Promise<void> => {
            const fileSystem = createMemoryRestFileSystem()
            const { value, hookCalls } = create()
            const { resolver, calls } = createFakeCredentialResolver({ error: value })
            const tool = createAutocodeRestTool(createSessionClient(), fileSystem, resolver)
            const requests = captureRestRequests()

            const result = await tool.execute({ url: "http://example.com/api", method: "GET", rest_key: credentialTestKey } as never, createToolContext())

            expect(hookCalls).toEqual([])
            expectSafeError(result, resolutionError)
            expect(hookCalls).toEqual([])
            expect(calls).toEqual([{ kind: "rest", id: normalizedCredentialTestKey }])
            expect(requests).toHaveLength(0)
        })
    }

    test.each([
        { restKey: "  my_key  ", id: "MY_KEY" },
        { restKey: "_", id: "_" },
        { restKey: "0", id: "0" },
        { restKey: " a0_9z ", id: "A0_9Z" },
        { restKey: "_0a_", id: "_0A_" },
        { restKey: "123", id: "123" },
    ])("normalizes rest_key $restKey exactly once to $id", async ({ restKey, id }): Promise<void> => {
        const fileSystem = createMemoryRestFileSystem()
        const { resolver, calls } = createFakeCredentialResolver({ profile: { authorization: profileAuthorization } })
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem, resolver)
        const requests = captureRestRequests()

        const result = parseResult<{ status_code: number }>(await tool.execute({ url: "http://example.com/api", method: "GET", rest_key: restKey } as never, createToolContext()))

        expect(result.status_code).toBe(200)
        expect(calls).toEqual([{ kind: "rest", id }])
        expect(requests).toHaveLength(1)
        expect(requests[0]?.get("authorization")).toBe(profileAuthorization)
    })

    test.each([
        { name: "blank", restKey: "" },
        { name: "whitespace", restKey: " \t\r\n " },
        { name: "hyphen", restKey: "bad-key" },
        { name: "slash", restKey: "bad/key" },
        { name: "accented", restKey: "café" },
        { name: "non-ASCII", restKey: "キー" },
        { name: "fullwidth", restKey: "ＫＥＹ" },
    ])("rejects $name rest_key without lookup or request", async ({ restKey }): Promise<void> => {
        const fileSystem = createMemoryRestFileSystem()
        const { resolver, calls } = createFakeCredentialResolver()
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem, resolver)
        const requests = captureRestRequests()

        const result = await tool.execute({ url: "http://example.com/api", method: "GET", rest_key: restKey } as never, createToolContext())

        expectSafeError(result, "Invalid rest_key. Use only ASCII letters, digits, and underscores.")
        expect(calls).toHaveLength(0)
        expect(requests).toHaveLength(0)
    })

    for (const header of ["Authorization", "authorization", "aUtHoRiZaTiOn"]) {
        test.each([
            { name: "nonempty with valid key", authorization: explicitAuthorization, restKey: "api" },
            { name: "empty with valid key", authorization: "", restKey: "api" },
            { name: "nonempty with invalid key", authorization: explicitAuthorization, restKey: "bad-key" },
            { name: "empty with invalid key", authorization: "", restKey: "bad-key" },
            { name: "nonempty without key", authorization: explicitAuthorization, restKey: undefined },
            { name: "empty without key", authorization: "", restKey: undefined },
        ])(`explicit ${header} $name skips credential lookup`, async ({ authorization, restKey }): Promise<void> => {
            const fileSystem = createMemoryRestFileSystem()
            const { resolver, calls } = createFakeCredentialResolver()
            const tool = createAutocodeRestTool(createSessionClient(), fileSystem, resolver)
            const requests = captureRestRequests()

            const result = parseResult<{ status_code: number }>(await tool.execute({
                url: "http://example.com/api",
                method: "GET",
                headers: { [header]: authorization },
                rest_key: restKey,
            } as never, createToolContext()))

            expect(result.status_code).toBe(200)
            expect(calls).toHaveLength(0)
            expect(requests).toHaveLength(1)
            expect(requests[0]?.has("authorization")).toBe(true)
            expect(requests[0]?.get("authorization")).toBe(authorization)
        })
    }

    test("omitting rest_key sends unauthenticated request without lookup", async (): Promise<void> => {
        const fileSystem = createMemoryRestFileSystem()
        const { resolver, calls } = createFakeCredentialResolver()
        const tool = createAutocodeRestTool(createSessionClient(), fileSystem, resolver)
        const requests = captureRestRequests()

        const result = parseResult<{ status_code: number }>(await tool.execute({ url: "http://example.com/api", method: "GET" } as never, createToolContext()))

        expect(result.status_code).toBe(200)
        expect(calls).toHaveLength(0)
        expect(requests).toHaveLength(1)
        expect(requests[0]?.has("authorization")).toBe(false)
        expect(requests[0]?.get("authorization")).toBeNull()
    })

    test("uses whole resolved profile without REST credential environment reads", async (): Promise<void> => {
        await withRestEnvironmentReadTrap(async (reads): Promise<void> => {
            const fileSystem = createMemoryRestFileSystem()
            const { resolver, calls } = createFakeCredentialResolver({ profile: { authorization: profileAuthorization, username: profileUsername, password: profilePassword } })
            const tool = createAutocodeRestTool(createSessionClient(), fileSystem, resolver)
            const requests = captureRestRequests()

            const result = parseResult<{ status_code: number }>(await tool.execute({ url: "http://example.com/api", method: "GET", rest_key: credentialTestKey } as never, createToolContext()))

            expect(result.status_code).toBe(200)
            expect(requests).toHaveLength(1)
            expect(requests[0]?.get("authorization")).toBe(profileAuthorization)
            expect(calls).toEqual([{ kind: "rest", id: normalizedCredentialTestKey }])
            expect(reads).toEqual([])
        })
    })

    test("rejects resolver failure without REST credential environment fallback reads", async (): Promise<void> => {
        await withRestEnvironmentReadTrap(async (reads): Promise<void> => {
            const fileSystem = createMemoryRestFileSystem()
            const { resolver, calls } = createFakeCredentialResolver({ error: new Error(secretDiagnosticMessage) })
            const tool = createAutocodeRestTool(createSessionClient(), fileSystem, resolver)
            const requests = captureRestRequests()

            const result = await tool.execute({ url: "http://example.com/api", method: "GET", rest_key: credentialTestKey } as never, createToolContext())

            expectSafeError(result, resolutionError)
            expect(calls).toEqual([{ kind: "rest", id: normalizedCredentialTestKey }])
            expect(requests).toHaveLength(0)
            expect(reads).toEqual([])
        })
    })

    const authenticationCases = [
        { name: "profile Authorization over Basic", profile: { authorization: profileAuthorization, username: profileUsername, password: profilePassword }, headers: undefined, authorization: profileAuthorization },
        { name: "Basic", profile: { username: profileUsername, password: profilePassword }, headers: undefined, authorization: basicAuthorization },
        { name: "explicit Authorization", profile: undefined, headers: { aUtHoRiZaTiOn: explicitAuthorization }, authorization: explicitAuthorization },
    ]

    for (const { name, profile, headers, authorization } of authenticationCases) {
        for (const { name: variant, create } of hostileDiagnosticCases) {
            test.each(["fetch", "cache writeFile"])(`hides ${variant} %s diagnostics with ${name} without inspection`, async (failurePoint): Promise<void> => {
                const memoryFileSystem = createMemoryRestFileSystem()
                const { value, hookCalls } = create()
                let cacheWrites = 0
                const fileSystem = {
                    ...memoryFileSystem,
                    async writeFile(filePath: string, content: string | Buffer | Uint8Array): Promise<void> {
                        cacheWrites += 1
                        if (failurePoint === "cache writeFile") throw value
                        return memoryFileSystem.writeFile(filePath, content)
                    },
                }
                const { resolver, calls } = profile === undefined ? createFakeCredentialResolver() : createFakeCredentialResolver({ profile })
                const tool = createAutocodeRestTool(createSessionClient(), fileSystem, resolver)
                const requests: Headers[] = []
                globalThis.fetch = (async (_input, init): Promise<Response> => {
                    requests.push(new Headers(init?.headers))
                    if (failurePoint === "fetch") throw value
                    return new Response("ok")
                }) as typeof fetch

                const result = await tool.execute({ url: "http://example.com/api", method: "GET", headers, rest_key: credentialTestKey } as never, createToolContext())

                expect(hookCalls).toEqual([])
                expectSafeError(result, requestFailureError)
                expect(hookCalls).toEqual([])
                expect(requests).toHaveLength(1)
                expect(requests[0]?.get("authorization")).toBe(authorization)
                expect(calls).toEqual(profile === undefined ? [] : [{ kind: "rest", id: normalizedCredentialTestKey }])
                expect(cacheWrites).toBe(failurePoint === "cache writeFile" ? 1 : 0)
            })
        }

        test.each(["fetch", "response body", "cache mkdir", "cache stat", "cache writeFile"])(`hides secrets when %s fails with ${name}`, async (failurePoint): Promise<void> => {
            const memoryFileSystem = createMemoryRestFileSystem()
            const failure = new Error(secretDiagnosticMessage)
            const fileSystem = {
                ...memoryFileSystem,
                async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<string | undefined> {
                    if (failurePoint === "cache mkdir" && path.basename(dirPath) === "rest") throw failure
                    return memoryFileSystem.mkdir(dirPath, options)
                },
                async stat(targetPath: string): Promise<{ mtimeMs: number }> {
                    if (failurePoint === "cache stat" && path.basename(path.dirname(targetPath)) === "rest") throw failure
                    return memoryFileSystem.stat(targetPath)
                },
                async writeFile(filePath: string, content: string | Buffer | Uint8Array): Promise<void> {
                    if (failurePoint === "cache writeFile") throw failure
                    return memoryFileSystem.writeFile(filePath, content)
                },
            }
            const { resolver, calls } = profile === undefined ? createFakeCredentialResolver() : createFakeCredentialResolver({ profile })
            const tool = createAutocodeRestTool(createSessionClient(), fileSystem, resolver)
            const requests: Headers[] = []
            globalThis.fetch = (async (_input, init): Promise<Response> => {
                requests.push(new Headers(init?.headers))
                if (failurePoint === "fetch") throw failure
                if (failurePoint === "response body") {
                    return new Response(new ReadableStream<Uint8Array>({
                        start(controller): void {
                            controller.error(failure)
                        },
                    }))
                }
                return new Response("ok")
            }) as typeof fetch

            const result = await tool.execute({ url: "http://example.com/api", method: "GET", headers, rest_key: "api" } as never, createToolContext())

            expectSafeError(result, requestFailureError)
            expect(requests).toHaveLength(1)
            expect(requests[0]?.get("authorization")).toBe(authorization)
            expect(calls).toEqual(profile === undefined ? [] : [{ kind: "rest", id: "API" }])
        })

        test(`hides filesystem preparation diagnostics with ${name}`, async (): Promise<void> => {
            const fileSystem = {
                ...createMemoryRestFileSystem(),
                async readdir(): Promise<never> {
                    throw new Error(secretDiagnosticMessage)
                },
            }
            const { resolver, calls } = profile === undefined ? createFakeCredentialResolver() : createFakeCredentialResolver({ profile })
            const tool = createAutocodeRestTool(createSessionClient(), fileSystem, resolver)
            const requests = captureRestRequests()

            const result = await tool.execute({ url: "http://example.com/api", method: "GET", headers, rest_key: "api" } as never, createToolContext())

            expectSafeError(result, "Unable to prepare REST response directory.")
            expect(requests).toHaveLength(0)
            expect(calls).toEqual(profile === undefined ? [] : [{ kind: "rest", id: "API" }])
        })

        test(`hides outer preparation diagnostics with ${name}`, async (): Promise<void> => {
            const fileSystem = createMemoryRestFileSystem()
            const { resolver, calls } = profile === undefined ? createFakeCredentialResolver() : createFakeCredentialResolver({ profile })
            const tool = createAutocodeRestTool(createSessionClient(), fileSystem, resolver)
            const requests = captureRestRequests()

            const result = await tool.execute({
                url: "http://example.com/api",
                method: "GET",
                headers,
                rest_key: "api",
                body: {
                    get value(): string {
                        throw new Error(secretDiagnosticMessage)
                    },
                },
            } as never, createToolContext())

            expectSafeError(result, "Unable to prepare REST request.")
            expect(requests).toHaveLength(0)
            expect(calls).toEqual(profile === undefined ? [] : [{ kind: "rest", id: "API" }])
        })
    }
})
