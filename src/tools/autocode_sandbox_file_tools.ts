import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { lstat, mkdir, readFile as readFileBuffer, readdir, realpath, rm, stat } from "fs/promises"
import path from "path"
import { pathExists } from "@/utils/autocode_sandbox_helpers"
import { defaultSandboxDependencies, type SandboxDependencies } from "@/utils/sandbox"
import { copyPath, resolveSafeRelativePath, resolveSandboxForFileTool, sandboxRelativePath, validateSafeWriteTarget } from "@/utils/sandbox_file_tools"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"
import { authorizeToolAsk } from "@/utils/tool_permission"

type EntryType = "file" | "directory" | "symlink"

type SandboxEntry = {
    path: string
    type: EntryType
    size?: number
    modified?: string
}

type SandboxMatch = {
    path: string
    line: number
    column: number
    text: string
}

type SandboxCopyPermissionTarget = "local_target" | "sandbox_target"

type SandboxCopyAuthorizationRequest = {
    permission: "autocode_sandbox_copy"
    patterns: SandboxCopyPermissionTarget[]
    always: SandboxCopyPermissionTarget[]
    metadata: {
        tool: "autocode_sandbox_copy"
        target_type: SandboxCopyPermissionTarget
        source: unknown
        target: unknown
    }
}

const defaultLimit = 200
const maximumLimit = 2000
const defaultReadLimit = 2000
const maximumReadLimit = 10000

function normalizeLimit(input: unknown, fallback: number, cap: number): number {
    const value = typeof input === "number" ? input : Number(input)
    if (!Number.isFinite(value) || value <= 0) return fallback
    return Math.min(Math.floor(value), cap)
}

function globToRegExp(pattern: string): RegExp {
    const normalized = pattern.replaceAll("\\", "/")
    let source = "^"
    for (let index = 0; index < normalized.length; index += 1) {
        const char = normalized[index]
        const next = normalized[index + 1]
        if (char === "*" && next === "*") {
            source += ".*"
            index += 1
        }
        else if (char === "*") source += "[^/]*"
        else if (char === "?") source += "[^/]"
        else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    }
    return new RegExp(`${source}$`)
}

function normalizePattern(input: unknown): { ok: true, value: string } | { ok: false, reason: string } {
    if (typeof input !== "string" || !input.trim()) return { ok: false, reason: "pattern must be a non-empty string." }
    if (input.includes("\0")) return { ok: false, reason: "pattern must not contain NUL bytes." }
    if (path.posix.isAbsolute(input) || path.win32.isAbsolute(input)) return { ok: false, reason: "pattern must be relative." }
    return { ok: true, value: input.trim().replaceAll("\\", "/") }
}

async function createEntry(root: string, absolutePath: string): Promise<SandboxEntry> {
    const direntStat = await lstat(absolutePath)
    const fileStat = direntStat.isSymbolicLink() ? direntStat : await stat(absolutePath).catch(() => direntStat)
    const type: EntryType = direntStat.isSymbolicLink() ? "symlink" : fileStat.isDirectory() ? "directory" : "file"
    return {
        path: sandboxRelativePath(root, absolutePath),
        type,
        size: fileStat.size,
        modified: new Date(fileStat.mtimeMs).toISOString(),
    }
}

async function isSafeDiscoveredPath(root: string, absolutePath: string): Promise<boolean> {
    const [resolvedRoot, resolvedPath] = await Promise.all([
        realpath(root),
        realpath(absolutePath).catch(() => absolutePath),
    ])
    const relative = path.relative(resolvedRoot, resolvedPath)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

async function walk(start: string, visitor: (absolutePath: string) => Promise<boolean>): Promise<void> {
    const entries = await readdir(start, { withFileTypes: true }).catch(() => [])
    const sorted = entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of sorted) {
        const absolutePath = path.join(start, entry.name)
        const shouldContinue = await visitor(absolutePath)
        if (!shouldContinue) return
        if (entry.isDirectory()) await walk(absolutePath, visitor)
    }
}

function isBinary(buffer: Buffer): boolean {
    const sample = buffer.subarray(0, Math.min(buffer.length, 8000))
    return sample.includes(0)
}

async function readTextFile(filePath: string): Promise<string | undefined> {
    const buffer = await readFileBuffer(filePath).catch(() => undefined)
    if (!buffer || isBinary(buffer)) return undefined
    return buffer.toString("utf8")
}

export function createAutocodeSandboxEditTool(client?: OpencodeClient, deps: SandboxDependencies = defaultSandboxDependencies): ReturnType<typeof tool> {
    return tool({
        description: "Edit or create file inside sandbox storage using host-side native file operations.",
        args: {
            sandbox_name: tool.schema.string().describe("Existing sandbox name."),
            path: tool.schema.string().describe("Sandbox-root-relative file path."),
            oldString: tool.schema.string().describe("Existing text to replace; empty creates missing file."),
            newString: tool.schema.string().describe("Replacement text."),
            replaceAll: tool.schema.boolean().optional().describe("Replace all matches instead of exactly one."),
        },
        async execute(args, context): Promise<string> {
            try {
                if (typeof args.oldString !== "string") return createRetryResponse("edit sandbox file", "oldString must be a string.", "Provide oldString text to replace.")
                if (typeof args.newString !== "string") return createRetryResponse("edit sandbox file", "newString must be a string.", "Provide newString text.")
                if (args.oldString === args.newString) return createRetryResponse("edit sandbox file", "oldString and newString must differ.", "Provide different replacement text.")
                const sandbox = await resolveSandboxForFileTool(client, context, deps, args.sandbox_name, "edit sandbox file")
                if (!sandbox.ok) return sandbox.response
                const target = await validateSafeWriteTarget(sandbox.metadata.root_path, args.path, "path", true)
                if (!target.ok) return createRetryResponse("edit sandbox file", target.reason, "Use a sandbox-root-relative file path that stays inside sandbox storage.")
                const existed = await pathExists(deps, target.value.absolutePath)
                if (!existed && args.oldString !== "") {
                    return createRetryResponse("edit sandbox file", "File is missing and oldString is not empty.", "Use empty oldString only to create a missing file.")
                }
                if (existed && args.oldString === "") return createRetryResponse("edit sandbox file", "Cannot create file because target already exists.", "Provide non-empty oldString to edit an existing file.")
                let content = ""
                let replacements = 0
                if (existed) {
                    content = await deps.fileSystem.readFile(target.value.absolutePath, "utf8")
                    const matches = content.split(args.oldString).length - 1
                    if (matches === 0) return createRetryResponse("edit sandbox file", "oldString was not found.", "Provide exact oldString from the target file.")
                    if (matches > 1 && args.replaceAll !== true) return createRetryResponse("edit sandbox file", "oldString matched multiple locations.", "Set replaceAll true or provide a more specific oldString.")
                    replacements = args.replaceAll === true ? matches : 1
                    content = args.replaceAll === true ? content.replaceAll(args.oldString, args.newString) : content.replace(args.oldString, args.newString)
                }
                else {
                    content = args.newString
                }
                await mkdir(path.dirname(target.value.absolutePath), { recursive: true })
                await deps.fileSystem.writeFile(target.value.absolutePath, content)
                return JSON.stringify({ operation: "write", target: target.value.relativePath, path: target.value.relativePath, resource: `sandbox:${sandbox.paths.sandboxName}/${target.value.relativePath}`, existed, replacements })
            }
            catch (error) {
                return createAbortResponse("edit sandbox file", error)
            }
        },
    })
}

export function createAutocodeSandboxGlobTool(client?: OpencodeClient, deps: SandboxDependencies = defaultSandboxDependencies): ReturnType<typeof tool> {
    return tool({
        description: "Find files inside sandbox storage by glob pattern.",
        args: {
            sandbox_name: tool.schema.string(),
            pattern: tool.schema.string(),
            path: tool.schema.string().optional(),
            limit: tool.schema.number().optional(),
        },
        async execute(args, context): Promise<string> {
            try {
                const pattern = normalizePattern(args.pattern)
                if (!pattern.ok) return createRetryResponse("glob sandbox files", pattern.reason, "Use a relative glob pattern.")
                const sandbox = await resolveSandboxForFileTool(client, context, deps, args.sandbox_name, "glob sandbox files")
                if (!sandbox.ok) return sandbox.response
                const base = await resolveSafeRelativePath(sandbox.metadata.root_path, args.path ?? ".", "path", true, true)
                if (!base.ok) return createRetryResponse("glob sandbox files", base.reason, "Use a sandbox-root-relative search path.")
                const matcher = globToRegExp(pattern.value)
                const limit = normalizeLimit(args.limit, defaultLimit, maximumLimit)
                const results: SandboxEntry[] = []
                await walk(base.value.absolutePath, async (absolutePath) => {
                    if (!await isSafeDiscoveredPath(sandbox.metadata.root_path, absolutePath)) return true
                    const relative = path.relative(base.value.absolutePath, absolutePath).replaceAll(path.sep, "/")
                    if (matcher.test(relative)) results.push(await createEntry(sandbox.metadata.root_path, absolutePath))
                    return results.length < limit
                })
                return JSON.stringify(results.sort((left, right) => left.path.localeCompare(right.path)))
            }
            catch (error) {
                return createAbortResponse("glob sandbox files", error)
            }
        },
    })
}

export function createAutocodeSandboxGrepTool(client?: OpencodeClient, deps: SandboxDependencies = defaultSandboxDependencies): ReturnType<typeof tool> {
    return tool({
        description: "Search text files inside sandbox storage by regex pattern.",
        args: {
            sandbox_name: tool.schema.string(),
            pattern: tool.schema.string(),
            path: tool.schema.string().optional(),
            include: tool.schema.string().optional(),
            limit: tool.schema.number().optional(),
        },
        async execute(args, context): Promise<string> {
            try {
                if (typeof args.pattern !== "string" || !args.pattern) return createRetryResponse("grep sandbox files", "pattern must be a non-empty regex string.", "Provide a regex pattern.")
                const regex = createRegex(args.pattern)
                if (!regex.ok) return createRetryResponse("grep sandbox files", regex.reason, "Provide a valid JavaScript regex pattern.")
                const include = typeof args.include === "string" && args.include.trim() ? globToRegExp(args.include.trim()) : undefined
                const sandbox = await resolveSandboxForFileTool(client, context, deps, args.sandbox_name, "grep sandbox files")
                if (!sandbox.ok) return sandbox.response
                const base = await resolveSafeRelativePath(sandbox.metadata.root_path, args.path ?? ".", "path", true, true)
                if (!base.ok) return createRetryResponse("grep sandbox files", base.reason, "Use a sandbox-root-relative search path.")
                const limit = normalizeLimit(args.limit, defaultLimit, maximumLimit)
                const matches: SandboxMatch[] = []
                await walk(base.value.absolutePath, async (absolutePath) => {
                    if (!await isSafeDiscoveredPath(sandbox.metadata.root_path, absolutePath)) return true
                    const fileStat = await stat(absolutePath).catch(() => undefined)
                    if (!fileStat?.isFile()) return true
                    const relative = sandboxRelativePath(sandbox.metadata.root_path, absolutePath)
                    if (include && !include.test(relative)) return true
                    const content = await readTextFile(absolutePath)
                    if (content === undefined) return true
                    const lines = content.split(/\r?\n/)
                    for (let index = 0; index < lines.length; index += 1) {
                        const match = regex.value.exec(lines[index])
                        regex.value.lastIndex = 0
                        if (match?.index !== undefined) matches.push({ path: relative, line: index + 1, column: match.index + 1, text: lines[index] })
                        if (matches.length >= limit) return false
                    }
                    return true
                })
                return JSON.stringify(matches.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column))
            }
            catch (error) {
                return createAbortResponse("grep sandbox files", error)
            }
        },
    })
}

function createRegex(pattern: string): { ok: true, value: RegExp } | { ok: false, reason: string } {
    try {
        return { ok: true, value: new RegExp(pattern) }
    }
    catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
}

function getSandboxCopyPermissionTarget(args: { local_target?: unknown, sandbox_target?: unknown }): SandboxCopyPermissionTarget {
    return args.local_target !== undefined ? "local_target" : "sandbox_target"
}

function createSandboxCopyAuthorizationRequest(targetType: SandboxCopyPermissionTarget, args: { local_source?: unknown, local_target?: unknown, sandbox_source?: unknown, sandbox_target?: unknown }): SandboxCopyAuthorizationRequest {
    return {
        permission: "autocode_sandbox_copy",
        patterns: [targetType],
        always: [targetType],
        metadata: {
            tool: "autocode_sandbox_copy",
            target_type: targetType,
            source: args.local_source ?? args.sandbox_source,
            target: args.local_target ?? args.sandbox_target,
        },
    }
}

export function createAutocodeSandboxReadTool(client?: OpencodeClient, deps: SandboxDependencies = defaultSandboxDependencies): ReturnType<typeof tool> {
    return tool({
        description: "Read file or directory from sandbox storage.",
        args: {
            sandbox_name: tool.schema.string(),
            path: tool.schema.string(),
            offset: tool.schema.number().optional(),
            limit: tool.schema.number().optional(),
        },
        async execute(args, context): Promise<string> {
            try {
                const sandbox = await resolveSandboxForFileTool(client, context, deps, args.sandbox_name, "read sandbox path")
                if (!sandbox.ok) return sandbox.response
                const target = await resolveSafeRelativePath(sandbox.metadata.root_path, args.path, "path", true, true)
                if (!target.ok) return createRetryResponse("read sandbox path", target.reason, "Use a sandbox-root-relative path.")
                const fileStat = await stat(target.value.absolutePath)
                if (fileStat.isDirectory()) {
                    const entries = await readdir(target.value.absolutePath)
                    const listed = await Promise.all(entries.sort((left, right) => left.localeCompare(right)).slice(0, normalizeLimit(args.limit, defaultLimit, maximumLimit)).map((entry) => createEntry(sandbox.metadata.root_path, path.join(target.value.absolutePath, entry))))
                    return JSON.stringify({ path: target.value.relativePath, type: "directory", entries: listed })
                }
                const content = await deps.fileSystem.readFile(target.value.absolutePath, "utf8")
                const lines = content.split(/\r?\n/)
                const offset = Math.max(1, normalizeLimit(args.offset, 1, Number.MAX_SAFE_INTEGER))
                const limit = normalizeLimit(args.limit, defaultReadLimit, maximumReadLimit)
                const page = lines.slice(offset - 1, offset - 1 + limit)
                return JSON.stringify({ path: target.value.relativePath, type: "file", content: page.join("\n"), offset, limit, lines: page.length, truncated: offset - 1 + limit < lines.length })
            }
            catch (error) {
                return createAbortResponse("read sandbox path", error)
            }
        },
    })
}

export function createAutocodeSandboxCopyTool(client?: OpencodeClient, deps: SandboxDependencies = defaultSandboxDependencies): ReturnType<typeof tool> {
    return tool({
        description: "Copy files between project root and sandbox storage using host-side native file operations.",
        args: {
            sandbox_name: tool.schema.string(),
            local_source: tool.schema.string().optional(),
            local_target: tool.schema.string().optional(),
            sandbox_source: tool.schema.string().optional(),
            sandbox_target: tool.schema.string().optional(),
        },
        async execute(args, context): Promise<string> {
            try {
                const sourceCount = [args.local_source, args.sandbox_source].filter((value) => value !== undefined).length
                const targetCount = [args.local_target, args.sandbox_target].filter((value) => value !== undefined).length
                if (sourceCount !== 1 || targetCount !== 1) return createRetryResponse("copy sandbox path", "Exactly one source and exactly one target are required.", "Use one of local_source or sandbox_source, and one of local_target or sandbox_target.")
                if (args.local_source !== undefined && args.local_target !== undefined) return createRetryResponse("copy sandbox path", "local to local copy is not supported here.", "Use another local copy tool for local to local copies.")
                if (typeof context.ask !== "function") return createAbortResponse("authorize sandbox copy", "Tool context ask() is unavailable")
                const targetType = getSandboxCopyPermissionTarget(args)
                try {
                    await authorizeToolAsk(context.ask(createSandboxCopyAuthorizationRequest(targetType, args)))
                }
                catch (error) {
                    return createAbortResponse("authorize sandbox copy", error)
                }
                const sandbox = await resolveSandboxForFileTool(client, context, deps, args.sandbox_name, "copy sandbox path")
                if (!sandbox.ok) return sandbox.response
                const sourceRoot = args.local_source !== undefined ? sandbox.storageRoot : sandbox.metadata.root_path
                const targetRoot = args.local_target !== undefined ? sandbox.storageRoot : sandbox.metadata.root_path
                const source = await resolveSafeRelativePath(sourceRoot, args.local_source ?? args.sandbox_source, "source", args.sandbox_source !== undefined, true)
                if (!source.ok) return createRetryResponse("copy sandbox path", source.reason, "Use a safe source path inside project root or sandbox storage.")
                const target = await validateSafeWriteTarget(targetRoot, args.local_target ?? args.sandbox_target, "target", args.sandbox_target !== undefined)
                if (!target.ok) return createRetryResponse("copy sandbox path", target.reason, "Use a safe target path inside project root or sandbox storage.")
                const sourceStat = await stat(source.value.absolutePath)
                const targetStat = await stat(target.value.absolutePath).catch(() => undefined)
                if (sourceStat.isDirectory() && targetStat?.isFile()) return createRetryResponse("copy sandbox path", "Cannot copy directory onto existing file.", "Choose a directory target or remove the file first.")
                if (sourceStat.isFile() && targetStat?.isDirectory()) return createRetryResponse("copy sandbox path", "Cannot copy file onto existing directory.", "Choose a file target or remove the directory first.")
                await mkdir(path.dirname(target.value.absolutePath), { recursive: true })
                if (sourceStat.isFile() && targetStat?.isFile()) await rm(target.value.absolutePath, { force: true })
                await copyPath(source.value.absolutePath, target.value.absolutePath)
                return JSON.stringify({ operation: "copy", source: source.value.relativePath, target: target.value.relativePath, resource: args.sandbox_target !== undefined ? `sandbox:${sandbox.paths.sandboxName}/${target.value.relativePath}` : `local:${target.value.relativePath}` })
            }
            catch (error) {
                return createAbortResponse("copy sandbox path", error)
            }
        },
    })
}
