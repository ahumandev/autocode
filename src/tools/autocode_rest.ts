import path from "path"
import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises"
import { createDirectoryFileSystem, deriveJobNameFromTitle, ensurePlannedJobFiles, getJobDirectoryPath, isMissingFile, resolveAgentsStorageRoot, resolvePlannedJobIdentity, type JobToolFileSystem, type SessionJobContext } from "@/utils/jobs"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

type RestToolFileSystem = Pick<JobToolFileSystem, "mkdir" | "readFile" | "readdir" | "stat"> & {
    writeFile: (file: string, data: string | Buffer | Uint8Array) => Promise<void>
}

type Scalar = string | number | boolean | null

type PlainObject = Record<string, unknown>

type HeaderMap = Record<string, string>

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

function normalizeMethod(method: unknown): { ok: true, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" } | { ok: false, error: string } {
    const normalized = typeof method === "string" ? method.trim().toUpperCase() : ""
    if (normalized === "GET" || normalized === "POST" || normalized === "PUT" || normalized === "PATCH" || normalized === "DELETE") {
        return { ok: true, method: normalized }
    }

    return { ok: false, error: `Invalid method: ${String(method)}` }
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

function findHeaderValue(headers: HeaderMap, requestedHeader: string): { key: string, value: string } | undefined {
    const target = requestedHeader.toLowerCase()
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === target) {
            return { key, value }
        }
    }

    return undefined
}

const TEXT_CONTENT_TYPE_FRAGMENTS = [
    "text/",
    "json",
    "xml",
    "yaml",
    "javascript",
    "csv",
    "html",
    "x-www-form-urlencoded",
    "svg",
    "ld+json",
    "x-sh",
] as const

function isTextContentType(contentType: string): boolean {
    const base = contentType.toLowerCase().split(";")[0]?.trim() ?? ""
    if (!base) {
        return false
    }
    return TEXT_CONTENT_TYPE_FRAGMENTS.some((fragment) => base.includes(fragment))
}

function isBinaryBuffer(buffer: ArrayBuffer): boolean {
    const bytes = new Uint8Array(buffer)
    const scanLen = Math.min(bytes.length, 1024)
    for (let index = 0; index < scanLen; index += 1) {
        if (bytes[index] === 0x00) {
            return true
        }
    }
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, scanLen))
        return false
    }
    catch {
        return true
    }
}

function sanitizeUrlForFileName(url: string): string {
    return url
        .replace(/:\/{2,}/g, "_")
        .replace(/\//g, "-")
        .replace(/\?/g, "_")
        .replace(/[^a-zA-Z0-9,&\-_!@#$%^()\[\]]/g, "-")
        .slice(0, 120)
}

function contentTypeToExtension(contentType: string | undefined, isText: boolean): string {
    const base = (contentType ?? "").toLowerCase().split(";")[0]?.trim() ?? ""
    if (!base) {
        return isText ? "txt" : "bin"
    }
    if (base.includes("json")) return "json"
    if (base.includes("xml")) return "xml"
    if (base.includes("yaml")) return "yml"
    if (base.includes("pdf")) return "pdf"
    if (base.includes("html")) return "html"
    if (base.includes("csv")) return "csv"
    if (base.includes("javascript")) return "js"
    if (base.includes("css")) return "css"
    if (base.includes("svg")) return "svg"
    if (base.includes("png")) return "png"
    if (base.includes("jpeg") || base.includes("jpg")) return "jpg"
    if (base.includes("gif")) return "gif"
    if (base.includes("webp")) return "webp"
    if (base.includes("zip")) return "zip"
    if (base.includes("gzip") || base.includes("x-gzip")) return "gz"
    if (base.includes("tar")) return "tar"
    if (base.includes("wasm")) return "wasm"
    return isText ? "txt" : "bin"
}

function formatResponseId(date: Date): string {
    const pad2 = (value: number): string => String(value).padStart(2, "0")
    const pad3 = (value: number): string => String(value).padStart(3, "0")
    return `${String(date.getFullYear())}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}_${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}.${pad3(date.getMilliseconds())}`
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

async function resolveCurrentJobRestDirectory(action: string, fileSystem: RestToolFileSystem, client: OpencodeClient | undefined, context: SessionJobContext): Promise<{ jobName: string, restDir: string } | { error: string }> {
    const directoryFileSystem = createDirectoryFileSystem({
        ...fileSystem,
        rename: undefined,
        rm: undefined,
    })
    const identity = await resolvePlannedJobIdentity(directoryFileSystem, client, context)

    // Ad-hoc auto-provision: when no planned job matches the session title, spin up
    // .agents/jobs/assist/<slug>/ so autocode_rest is usable without manual
    // /job-draft or /job-execute-assist setup. Other resolutions keep their retry error.
    if (identity.resolution === "missing" && identity.session_title) {
        const slug = identity.title_derived_candidate || deriveJobNameFromTitle(identity.session_title)
        if (slug) {
            const storageRoot = resolveAgentsStorageRoot(context)
            const jobDir = getJobDirectoryPath(storageRoot, "assist", slug)
            await ensurePlannedJobFiles(directoryFileSystem, jobDir)
            const restDir = path.join(jobDir, "rest")
            await ensurePlannedJobFiles(directoryFileSystem, restDir)
            await fileSystem.writeFile(path.join(jobDir, "session.yml"), `session_id: ${context.sessionID}\n`)
            return { jobName: slug, restDir }
        }
    }

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

async function executeRestRequest(args: {
    url: string
    method: string
    headers?: unknown
    body?: unknown
    timeout?: number
}, context: SessionJobContext, client: OpencodeClient | undefined, fileSystem: RestToolFileSystem): Promise<string> {
    const methodResult = normalizeMethod(args.method)
    if (!methodResult.ok) {
        return createRetryResponse("autocode_rest", methodResult.error, "Use method as one of: GET, POST, PUT, PATCH, DELETE.")
    }

    const headersResult = normalizeHeaderMap(args.headers)
    if (!headersResult.ok) {
        return createRetryResponse("autocode_rest", headersResult.error, "Provide headers as a plain object with string, number, or boolean values.")
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

    const timeout = args.timeout ?? 5000
    if (!Number.isFinite(timeout) || timeout <= 0) {
        return createRetryResponse("autocode_rest", "timeout must be a positive finite number of milliseconds.", "Provide timeout as a positive finite number of milliseconds.")
    }

    const controller = new AbortController()
    const timeoutHandle = setTimeout(() => controller.abort(), timeout)

    const restDirectory = await resolveCurrentJobRestDirectory("autocode_rest", fileSystem, client, context)
    if ("error" in restDirectory) {
        return restDirectory.error
    }

    const responseId = formatResponseId(new Date())
    const startedAt = Date.now()

    try {
        const response = await fetch(requestUrl, {
            method: methodResult.method,
            headers: headersResult.headers,
            body: bodyResult.body,
            signal: controller.signal,
        })

        const buffer = await response.arrayBuffer()
        const responseTime = Date.now() - startedAt
        const responseHeaders: HeaderMap = Object.fromEntries(response.headers.entries())
        const contentTypeEntry = findHeaderValue(responseHeaders, "content-type")
        const contentType = contentTypeEntry?.value
        let isText: boolean
        if (contentType && isTextContentType(contentType)) {
            isText = true
        }
        else {
            isText = !isBinaryBuffer(buffer)
        }
        const decodedBody = isText
            ? new TextDecoder("utf-8", { fatal: false }).decode(buffer)
            : ""
        const ext = contentTypeToExtension(contentType, isText)
        const urlSegment = sanitizeUrlForFileName(args.url)

        await fileSystem.mkdir(restDirectory.restDir, { recursive: true })
        let bodyFileName = `${responseId}_${urlSegment}.${ext}`
        let collisionSuffix = 2
        while (await fileExists(fileSystem, path.join(restDirectory.restDir, bodyFileName))) {
            bodyFileName = `${responseId}_${urlSegment}_${collisionSuffix}.${ext}`
            collisionSuffix += 1
        }
        const absoluteBodyFilePath = path.join(restDirectory.restDir, bodyFileName)
        await fileSystem.writeFile(absoluteBodyFilePath, isText ? decodedBody : Buffer.from(buffer))
        const responseBodyFilePath = path.relative(process.cwd(), absoluteBodyFilePath)

        const output: Record<string, unknown> = {
            status_code: response.status,
            response_headers: responseHeaders,
            response_time: responseTime,
            response_id: responseId,
            response_body_file_path: responseBodyFilePath,
        }
        if (isText && decodedBody.length < 400) {
            output.response_body = decodedBody
        }
        return JSON.stringify(output)
    }
    catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            const elapsed = Date.now() - startedAt
            return JSON.stringify({
                response_time: elapsed,
                response_id: responseId,
                timed_out: true,
                timeout_ms: timeout,
            })
        }
        return createAbortResponse("autocode_rest", error)
    }
    finally {
        clearTimeout(timeoutHandle)
    }
}

export function createAutocodeRestTool(client?: OpencodeClient, fileSystem: RestToolFileSystem = defaultFileSystem): ReturnType<typeof tool> {
    return tool({
        description: "Send REST API request and save response body to a file. Returns response_body inline only when text and short; otherwise use response_body_file_path to read the full body.",
        args: {
            url: tool.schema.string().describe("Absolute http or https URL."),
            method: tool.schema.string().describe("HTTP method: GET, POST, PUT, PATCH, DELETE."),
            headers: tool.schema.unknown().optional().describe("Optional object of request headers."),
            body: tool.schema.unknown().optional().describe("Optional request body."),
            timeout: tool.schema.number().optional().default(5000).describe("Optional timeout in milliseconds."),
        },
        async execute(args, context) {
            return executeRestRequest(args as {
                url: string
                method: string
                headers?: unknown
                body?: unknown
                timeout?: number
            }, context, client, fileSystem)
        },
    })
}

