import path from "path"
import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises"
import { createDirectoryFileSystem, isMissingFile, resolvePlannedJobIdentity, type JobToolFileSystem, type SessionJobContext } from "@/utils/jobs"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

type RestToolFileSystem = Pick<JobToolFileSystem, "mkdir" | "readFile" | "readdir" | "stat" | "writeFile">

type Scalar = string | number | boolean | null

type PlainObject = Record<string, unknown>

type HeaderMap = Record<string, string>

type CacheRecord = {
    url: string
    method: string
    status_code: number
    headers: HeaderMap
    body: string
    created_at: string
}

type ReadLine = {
    line: number
    text: string
}

type GrepMatch = {
    line: number
    column: number
    text: string
}

type EvalToken = string | number

async function readDirectory(dirPath: string, options?: { withFileTypes?: boolean }): Promise<string[] | import("fs").Dirent[]> {
    return options?.withFileTypes ? readdir(dirPath, { withFileTypes: true }) : readdir(dirPath)
}

const defaultFileSystem: RestToolFileSystem = {
    mkdir,
    readFile,
    readdir: readDirectory,
    stat,
    writeFile,
}

function isPlainObject(value: unknown): value is PlainObject {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false
    }

    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function isScalar(value: unknown): value is Scalar {
    return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value)
}

function isPositiveInteger(value: unknown): value is number {
    return isFiniteNumber(value) && Number.isInteger(value) && value > 0
}

function validateBodyValue(value: unknown): boolean {
    if (value === null) {
        return true
    }

    if (typeof value === "string" || typeof value === "boolean") {
        return true
    }

    if (typeof value === "number") {
        return Number.isFinite(value)
    }

    if (Array.isArray(value)) {
        return value.every((entry) => validateBodyValue(entry))
    }

    if (isPlainObject(value)) {
        return Object.values(value).every((entry) => validateBodyValue(entry))
    }

    return false
}

function normalizeHeaderMap(value: unknown): { ok: true, headers: HeaderMap } | { ok: false, error: string } {
    if (value === undefined) {
        return { ok: true, headers: {} }
    }

    if (!isPlainObject(value)) {
        return { ok: false, error: "headers must be a plain object with string or scalar values." }
    }

    const headers: HeaderMap = {}
    for (const [key, entry] of Object.entries(value)) {
        if (typeof key !== "string" || key.length === 0) {
            return { ok: false, error: "headers keys must be non-empty strings." }
        }

        if (typeof entry === "string") {
            headers[key] = entry
            continue
        }

        if (typeof entry === "number") {
            if (!Number.isFinite(entry)) {
                return { ok: false, error: `headers.${key} must be a finite scalar value.` }
            }
            headers[key] = String(entry)
            continue
        }

        if (typeof entry === "boolean") {
            headers[key] = String(entry)
            continue
        }

        return { ok: false, error: `headers.${key} must be a string, number, or boolean.` }
    }

    return { ok: true, headers }
}

function normalizeQueryObject(value: unknown): { ok: true, query: Record<string, Scalar | Scalar[]> } | { ok: false, error: string } {
    if (value === undefined) {
        return { ok: true, query: {} }
    }

    if (!isPlainObject(value)) {
        return { ok: false, error: "query must be a plain object with scalar or scalar[] values." }
    }

    const query: Record<string, Scalar | Scalar[]> = {}
    for (const [key, entry] of Object.entries(value)) {
        if (isScalar(entry)) {
            if (typeof entry === "number" && !Number.isFinite(entry)) {
                return { ok: false, error: `query.${key} must be finite.` }
            }
            query[key] = entry
            continue
        }

        if (Array.isArray(entry) && entry.every((item) => isScalar(item) && (typeof item !== "number" || Number.isFinite(item)))) {
            query[key] = entry
            continue
        }

        return { ok: false, error: `query.${key} must be scalar or scalar array.` }
    }

    return { ok: true, query }
}

function appendQueryParams(url: URL, query: Record<string, Scalar | Scalar[]>): void {
    for (const [key, value] of Object.entries(query)) {
        url.searchParams.delete(key)

        const entries = Array.isArray(value) ? value : [value]
        for (const entry of entries) {
            url.searchParams.append(key, String(entry))
        }
    }
}

function normalizeMethod(method: unknown): { ok: true, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" } | { ok: false, error: string } {
    const normalized = typeof method === "string" ? method.trim().toUpperCase() : ""
    if (normalized === "GET" || normalized === "POST" || normalized === "PUT" || normalized === "PATCH" || normalized === "DELETE") {
        return { ok: true, method: normalized }
    }

    return { ok: false, error: `Invalid method: ${String(method)}` }
}

function normalizeTimeout(value: unknown): { ok: true, timeout?: number } | { ok: false, error: string } {
    if (value === undefined) {
        return { ok: true }
    }

    if (!isFiniteNumber(value) || value <= 0) {
        return { ok: false, error: "timeout must be a positive finite number of milliseconds." }
    }

    return { ok: true, timeout: value }
}

function normalizeRequestBody(value: unknown): { ok: true, body?: string } | { ok: false, error: string } {
    if (value === undefined) {
        return { ok: true }
    }

    if (typeof value === "string") {
        return { ok: true, body: value }
    }

    if (!validateBodyValue(value)) {
        return { ok: false, error: "body must be a string, JSON scalar, array, or plain object." }
    }

    return { ok: true, body: JSON.stringify(value) }
}

function createTextLines(text: string): string[] {
    return text.length === 0 ? [""] : text.split(/\r?\n/)
}

function sliceLines(text: string, offset: number, limit: number): { total_lines: number, lines: ReadLine[] } {
    const allLines = createTextLines(text)
    const startIndex = offset - 1
    const selected = allLines.slice(startIndex, startIndex + limit)

    return {
        total_lines: allLines.length,
        lines: selected.map((entry, index) => ({
            line: offset + index,
            text: entry,
        })),
    }
}

function findHeaderValue(headers: HeaderMap, requestedHeader: string): { key: string, value: string } | undefined {
    const target = requestedHeader.toLowerCase()
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === target) {
            return { key, value }
        }
    }

    return undefined
}

function sanitizeFileNamePart(value: string): string {
    return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "!")
}

function decodeUrlCredentialValue(value: string): string {
    if (!value) {
        return value
    }

    try {
        return decodeURIComponent(value)
    }
    catch {
        return value
    }
}

function encodePasswordForHostSegment(password: string): string {
    const encodedPassword = Buffer.from(password, "utf8").toString("base64")
    return encodedPassword.replace(/\//g, "_")
}

function encodeHost(url: URL): string {
    const host = sanitizeFileNamePart(url.hostname)
    const portSuffix = url.port ? `-${url.port}` : ""
    const username = sanitizeFileNamePart(decodeUrlCredentialValue(url.username))
    const password = decodeUrlCredentialValue(url.password)

    if (username && password) {
        const encodedPassword = encodePasswordForHostSegment(password)
        return `${username}-${encodedPassword}@${host}${portSuffix}`
    }

    if (username) {
        return `${username}@${host}${portSuffix}`
    }

    return `${host}${portSuffix}`
}

function encodePathName(pathname: string): string {
    const replaced = (pathname || "/").replace(/\//g, "^")
    const normalized = replaced.length > 0 ? replaced : "^"
    return sanitizeFileNamePart(normalized)
}

function formatTimestamp(date: Date): string {
    const pad2 = (value: number): string => String(value).padStart(2, "0")
    const pad3 = (value: number): string => String(value).padStart(3, "0")
    return `${String(date.getFullYear()).slice(-2)}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}_${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}-${pad3(date.getMilliseconds())}`
}

async function fileExists(fileSystem: RestToolFileSystem, filePath: string): Promise<boolean> {
    try {
        await fileSystem.stat(filePath)
        return true
    }
    catch (error) {
        if (isMissingFile(error)) {
            return false
        }

        throw error
    }
}

async function createCacheFileName(fileSystem: RestToolFileSystem, restDir: string, method: string, url: URL, now: Date): Promise<string> {
    const prefix = `${formatTimestamp(now)}_${method}_${url.protocol.replace(/:$/, "")}_${encodeHost(url)}_${encodePathName(url.pathname)}`
    const firstCandidate = `${prefix}.json`
    if (!(await fileExists(fileSystem, path.join(restDir, firstCandidate)))) {
        return firstCandidate
    }

    let suffix = 2
    while (true) {
        const candidate = `${prefix}_${suffix}.json`
        if (!(await fileExists(fileSystem, path.join(restDir, candidate)))) {
            return candidate
        }
        suffix += 1
    }
}

async function resolveCurrentJobRestDirectory(action: string, fileSystem: RestToolFileSystem, client: OpencodeClient | undefined, context: SessionJobContext): Promise<{ jobName: string, restDir: string } | { error: string }> {
    const identity = await resolvePlannedJobIdentity(createDirectoryFileSystem({
        ...fileSystem,
        rename: undefined,
        rm: undefined,
    }), client, context)

    if (identity.mode !== "planned" || !identity.job_name || !identity.resolved_job) {
        return {
            error: createRetryResponse(
                action,
                "No active planned job context was found for current session.",
                `Switch to an active lifecycle job session under .agents/jobs/*, then retry ${action}.`
            )
        }
    }

    return {
        jobName: identity.job_name,
        restDir: path.join(identity.resolved_job.absolute_path, "rest"),
    }
}

function isSafeResponseName(responseName: string): boolean {
    return responseName.length > 0
        && !responseName.includes("/")
        && !responseName.includes("\\")
        && !responseName.includes("..")
        && !responseName.includes("\0")
        && !path.isAbsolute(responseName)
        && path.basename(responseName) === responseName
}

async function loadCachedResponse(fileSystem: RestToolFileSystem, client: OpencodeClient | undefined, context: SessionJobContext, action: string, responseName: unknown): Promise<{ cache: CacheRecord, responseName: string } | { response: string }> {
    const normalizedName = typeof responseName === "string" ? responseName.trim() : ""
    if (!normalizedName) {
        return {
            response: createRetryResponse(action, "response_name is required.", `Provide a cached response_name returned by autocode_rest.`)
        }
    }

    if (!isSafeResponseName(normalizedName)) {
        return {
            response: createRetryResponse(action, `Unsafe response_name: ${normalizedName}`, "Use only a basename from current job rest/ cache.")
        }
    }

    const restDirectory = await resolveCurrentJobRestDirectory(action, fileSystem, client, context)
    if ("error" in restDirectory) {
        return { response: restDirectory.error }
    }

    const rootDir = path.resolve(restDirectory.restDir)
    const filePath = path.resolve(rootDir, normalizedName)
    if (!filePath.startsWith(`${rootDir}${path.sep}`)) {
        return {
            response: createRetryResponse(action, `Unsafe response_name: ${normalizedName}`, "Use only a basename from current job rest/ cache.")
        }
    }

    let content: string
    try {
        content = await fileSystem.readFile(filePath, "utf8")
    }
    catch (error) {
        if (isMissingFile(error)) {
            return {
                response: createRetryResponse(action, `Cached response not found: ${normalizedName}`, "Use a response_name returned by autocode_rest for current job.")
            }
        }

        return { response: createAbortResponse(action, error) }
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(content)
    }
    catch (error) {
        return { response: createAbortResponse(action, error) }
    }

    if (!isPlainObject(parsed)
        || typeof parsed.url !== "string"
        || typeof parsed.method !== "string"
        || !isPositiveInteger(parsed.status_code)
        || !isPlainObject(parsed.headers)
        || typeof parsed.body !== "string"
        || typeof parsed.created_at !== "string"
        || !Object.values(parsed.headers).every((entry) => typeof entry === "string")) {
        return { response: createAbortResponse(action, `Malformed cached response: ${normalizedName}`) }
    }

    return {
        responseName: normalizedName,
        cache: {
            url: parsed.url,
            method: parsed.method,
            status_code: parsed.status_code,
            headers: parsed.headers as HeaderMap,
            body: parsed.body,
            created_at: parsed.created_at,
        }
    }
}

function createSourceText(action: string, cache: CacheRecord, header: unknown): { ok: true, source: string, text: string } | { ok: false, response: string } {
    if (header === undefined) {
        return { ok: true, source: "body", text: cache.body }
    }

    const headerName = typeof header === "string" ? header.trim() : ""
    if (!headerName) {
        return {
            ok: false,
            response: createRetryResponse(action, "header must be a non-empty string when provided.", "Provide a valid response header name or omit header to read body.")
        }
    }

    const headerValue = findHeaderValue(cache.headers, headerName)
    if (!headerValue) {
        return {
            ok: false,
            response: createRetryResponse(action, `Header not found: ${headerName}`, "Use a response header name present in cached response headers.")
        }
    }

    return { ok: true, source: headerValue.key, text: headerValue.value }
}

function parseEvalExpression(expression: string): { ok: true, tokens: EvalToken[] } | { ok: false, error: string } {
    const trimmed = expression.trim()
    if (!trimmed) {
        return { ok: false, error: "eval must be a non-empty path expression." }
    }

    const tokens: EvalToken[] = []
    let index = 0

    function readIdentifier(): string | undefined {
        const slice = trimmed.slice(index)
        const match = slice.match(/^[A-Za-z_$][A-Za-z0-9_$]*/)
        if (!match) {
            return undefined
        }
        index += match[0].length
        return match[0]
    }

    function readIndex(): number | undefined {
        const slice = trimmed.slice(index)
        const match = slice.match(/^\[(\d+)\]/)
        if (!match) {
            return undefined
        }
        index += match[0].length
        return Number(match[1])
    }

    const firstIdentifier = readIdentifier()
    if (firstIdentifier !== undefined) {
        tokens.push(firstIdentifier)
    }
    else {
        const firstIndex = readIndex()
        if (firstIndex === undefined) {
            return { ok: false, error: `Invalid eval expression: ${expression}` }
        }
        tokens.push(firstIndex)
    }

    while (index < trimmed.length) {
        if (trimmed[index] === ".") {
            index += 1
            const identifier = readIdentifier()
            if (identifier === undefined) {
                return { ok: false, error: `Invalid eval expression: ${expression}` }
            }
            tokens.push(identifier)
            continue
        }

        const arrayIndex = readIndex()
        if (arrayIndex !== undefined) {
            tokens.push(arrayIndex)
            continue
        }

        return { ok: false, error: `Invalid eval expression: ${expression}` }
    }

    return { ok: true, tokens }
}

function evaluateJsonPath(root: unknown, tokens: EvalToken[]): { found: true, value: unknown } | { found: false } {
    let current: unknown = root
    for (const token of tokens) {
        if (typeof token === "number") {
            if (!Array.isArray(current) || token < 0 || token >= current.length) {
                return { found: false }
            }
            current = current[token]
            continue
        }

        if (!isPlainObject(current) && !Array.isArray(current)) {
            return { found: false }
        }

        if (!Object.prototype.hasOwnProperty.call(current, token)) {
            return { found: false }
        }

        current = (current as Record<string, unknown>)[token]
    }

    return { found: true, value: current }
}

async function executeRestRequest(args: {
    url: string
    method: string
    headers?: unknown
    body?: unknown
    timeout?: number
    query?: unknown
}, context: SessionJobContext, client: OpencodeClient | undefined, fileSystem: RestToolFileSystem): Promise<string> {
    const methodResult = normalizeMethod(args.method)
    if (!methodResult.ok) {
        return createRetryResponse("autocode_rest", methodResult.error, "Use method as one of: GET, POST, PUT, PATCH, DELETE.")
    }

    const timeoutResult = normalizeTimeout(args.timeout)
    if (!timeoutResult.ok) {
        return createRetryResponse("autocode_rest", timeoutResult.error, "Provide timeout as a positive finite number of milliseconds.")
    }

    const headersResult = normalizeHeaderMap(args.headers)
    if (!headersResult.ok) {
        return createRetryResponse("autocode_rest", headersResult.error, "Provide headers as a plain object with string, number, or boolean values.")
    }

    const queryResult = normalizeQueryObject(args.query)
    if (!queryResult.ok) {
        return createRetryResponse("autocode_rest", queryResult.error, "Provide query as a plain object with scalar or scalar[] values.")
    }

    const bodyResult = normalizeRequestBody(args.body)
    if (!bodyResult.ok) {
        return createRetryResponse("autocode_rest", bodyResult.error, "Provide body as string or JSON-compatible scalar/object/array values only.")
    }

    let requestUrl: URL
    try {
        requestUrl = new URL(args.url)
    }
    catch {
        return createRetryResponse("autocode_rest", `Invalid url: ${args.url}`, "Provide a valid absolute http or https URL.")
    }

    if (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:") {
        return createRetryResponse("autocode_rest", `Unsupported protocol: ${requestUrl.protocol}`, "Use only http or https URLs.")
    }

    appendQueryParams(requestUrl, queryResult.query)

    const restDirectory = await resolveCurrentJobRestDirectory("autocode_rest", fileSystem, client, context)
    if ("error" in restDirectory) {
        return restDirectory.error
    }

    const controller = new AbortController()
    const timeout = timeoutResult.timeout
    const timeoutHandle = timeout === undefined ? undefined : setTimeout(() => controller.abort(), timeout)

    try {
        const response = await fetch(requestUrl, {
            method: methodResult.method,
            headers: headersResult.headers,
            body: bodyResult.body,
            signal: controller.signal,
        })

        const buffer = await response.arrayBuffer()
        const decodedBody = new TextDecoder("utf-8", { fatal: false }).decode(buffer)
        const headers: HeaderMap = Object.fromEntries(response.headers.entries())
        const truncated = decodedBody.length > 400
        const body = truncated ? decodedBody.slice(0, 400) : decodedBody

        if (!truncated) {
            return JSON.stringify({
                status_code: response.status,
                headers,
                body,
                full_response: true,
                truncated: false,
            })
        }

        const now = new Date()
        await fileSystem.mkdir(restDirectory.restDir, { recursive: true })
        const responseName = await createCacheFileName(fileSystem, restDirectory.restDir, methodResult.method, requestUrl, now)
        const cacheRecord: CacheRecord = {
            url: requestUrl.toString(),
            method: methodResult.method,
            status_code: response.status,
            headers,
            body: decodedBody,
            created_at: now.toISOString(),
        }
        await fileSystem.writeFile(path.join(restDirectory.restDir, responseName), JSON.stringify(cacheRecord, null, 2))

        return JSON.stringify({
            status_code: response.status,
            headers,
            body,
            full_response: false,
            truncated: true,
            response_name: responseName,
            job_name: restDirectory.jobName,
            guidance: "Body truncated and cached. Use autocode_rest_response_read, autocode_rest_grep, or autocode_rest_response_eval with response_name.",
        })
    }
    catch (error) {
        if (error instanceof Error && error.name === "AbortError" && timeout !== undefined) {
            return createRetryResponse("autocode_rest", `Request timed out after ${timeout}ms.`, "Retry autocode_rest with a longer timeout or a faster endpoint.")
        }

        return createAbortResponse("autocode_rest", error)
    }
    finally {
        if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle)
        }
    }
}

export function createAutocodeRestTool(client?: OpencodeClient, fileSystem: RestToolFileSystem = defaultFileSystem): ReturnType<typeof tool> {
    return tool({
        description: "Send an http or https REST API request. Full responses are cached and available to autocode_rest_response_* tools.",
        args: {
            url: tool.schema.string().describe("Absolute http or https URL."),
            method: tool.schema.string().describe("HTTP method: GET, POST, PUT, PATCH, DELETE."),
            headers: tool.schema.unknown().optional().describe("Optional plain object of request headers."),
            body: tool.schema.unknown().optional().describe("Optional request body."),
            timeout: tool.schema.number().optional().describe("Optional timeout in milliseconds."),
            query: tool.schema.unknown().optional().describe("Optional plain object of query params; provided keys replace duplicate URL params. Example: {\"page\":\"1\",\"q\":\"cats\"}"),
        },
        async execute(args, context) {
            return executeRestRequest(args as {
                url: string
                method: string
                headers?: unknown
                body?: unknown
                timeout?: number
                query?: unknown
            }, context, client, fileSystem)
        },
    })
}

export function createAutocodeRestResponseReadTool(client?: OpencodeClient, fileSystem: RestToolFileSystem = defaultFileSystem): ReturnType<typeof tool> {
    return tool({
        description: "Read cached REST response body lines or response header of previous autocode_rest tool.",
        args: {
            response_name: tool.schema.string().describe("Cached response_name returned by previous autocode_rest tool output."),
            header: tool.schema.string().optional().describe("Response header name; omit to read body."),
            offset: tool.schema.number().optional().describe("1-indexed start line."),
            limit: tool.schema.number().optional().describe("Maximum lines to return."),
        },
        async execute(args, context) {
            const offset = args.offset ?? 1
            const limit = args.limit ?? 700
            if (!isPositiveInteger(offset) || !isPositiveInteger(limit)) {
                return createRetryResponse("autocode_rest_response_read", "offset and limit must be positive integers.", "Provide offset and limit as 1-indexed positive integers.")
            }

            const loaded = await loadCachedResponse(fileSystem, client, context, "autocode_rest_response_read", args.response_name)
            if ("response" in loaded) {
                return loaded.response
            }

            const source = createSourceText("autocode_rest_response_read", loaded.cache, args.header)
            if (!source.ok) {
                return source.response
            }

            const sliced = sliceLines(source.text, offset, limit)
            return JSON.stringify({
                response_name: loaded.responseName,
                source: source.source,
                offset,
                limit,
                total_lines: sliced.total_lines,
                lines: sliced.lines,
            })
        },
    })
}

export function createAutocodeRestResponseGrepTool(client?: OpencodeClient, fileSystem: RestToolFileSystem = defaultFileSystem): ReturnType<typeof tool> {
    return tool({
        description: "Search in cached REST response body lines or response header of previous autocode_rest tool.",
        args: {
            response_name: tool.schema.string().describe("Cached response_name returned by previous autocode_rest tool output."),
            header: tool.schema.string().optional().describe("Response header name; omit to search body."),
            pattern: tool.schema.string().describe("JavaScript regular expression pattern."),
            ignore_case: tool.schema.boolean().optional().describe("Optional case-insensitive search."),
            max_matches: tool.schema.number().optional().describe("Optional positive integer limit for returned matches."),
        },
        async execute(args, context) {
            const maxMatches = args.max_matches ?? 7
            if (!isPositiveInteger(maxMatches)) {
                return createRetryResponse("autocode_rest_grep", "max_matches must be a positive integer.", "Provide max_matches as a positive integer.")
            }

            const loaded = await loadCachedResponse(fileSystem, client, context, "autocode_rest_grep", args.response_name)
            if ("response" in loaded) {
                return loaded.response
            }

            const source = createSourceText("autocode_rest_grep", loaded.cache, args.header)
            if (!source.ok) {
                return source.response
            }

            let expression: RegExp
            try {
                expression = new RegExp(args.pattern, args.ignore_case ? "gi" : "g")
            }
            catch (error) {
                return createRetryResponse("autocode_rest_grep", error instanceof Error ? error.message : String(error), "Provide a valid JavaScript regular expression pattern.")
            }

            const matches: GrepMatch[] = []
            const allLines = createTextLines(source.text)
            for (let lineIndex = 0; lineIndex < allLines.length && matches.length < maxMatches; lineIndex += 1) {
                const line = allLines[lineIndex]
                expression.lastIndex = 0
                let match = expression.exec(line)
                while (match && matches.length < maxMatches) {
                    matches.push({
                        line: lineIndex + 1,
                        column: match.index + 1,
                        text: line,
                    })

                    if (match[0].length === 0) {
                        expression.lastIndex += 1
                    }
                    match = expression.exec(line)
                }
            }

            return JSON.stringify({
                response_name: loaded.responseName,
                source: source.source,
                pattern: args.pattern,
                match_count: matches.length,
                matches,
            })
        },
    })
}

export function createAutocodeRestResponseEvalTool(client?: OpencodeClient, fileSystem: RestToolFileSystem = defaultFileSystem): ReturnType<typeof tool> {
    return tool({
        description: "Evaluate JSON path expression against cached REST response body from previous autocode_rest tool.",
        args: {
            response_name: tool.schema.string().describe("Cached response_name returned by autocode_rest."),
            eval: tool.schema.string().describe("Safe JSON path expression like a.b[0] or [0].id."),
        },
        async execute(args, context) {
            const loaded = await loadCachedResponse(fileSystem, client, context, "autocode_rest_response_eval", args.response_name)
            if ("response" in loaded) {
                return loaded.response
            }

            let parsedBody: unknown
            try {
                parsedBody = JSON.parse(loaded.cache.body)
            }
            catch (error) {
                return createRetryResponse("autocode_rest_response_eval", error instanceof Error ? error.message : String(error), "Use autocode_rest_response_read or autocode_rest_grep for non-JSON cached bodies.")
            }

            const expression = parseEvalExpression(args.eval)
            if (!expression.ok) {
                return createRetryResponse("autocode_rest_response_eval", expression.error, "Use only dots, identifiers, and numeric bracket indexes like a.b[0] or [0].id.")
            }

            const result = evaluateJsonPath(parsedBody, expression.tokens)
            if (!result.found) {
                return JSON.stringify({
                    response_name: loaded.responseName,
                    eval: args.eval,
                    found: false,
                })
            }

            return JSON.stringify({
                response_name: loaded.responseName,
                eval: args.eval,
                found: true,
                value: result.value,
            })
        },
    })
}
