import { constants as fsConstants } from "node:fs"
import { access } from "node:fs/promises"
import { tool } from "@opencode-ai/plugin"
import type { Stats } from "ssh2"
import {
    createSshToolAbortResponse,
    createSshToolErrorResponse,
    execSshCommand,
    openSftp,
    resolveSshConfig,
    sftpReadFile,
    sftpReaddir,
    sftpMkdir,
    sftpStat,
    sftpWriteFile,
    SshConnectionPool,
    type SshClientLike,
    type SshConfigInput,
    type SshConfigMap,
    type SshDeps,
    type SftpLike,
} from "@/utils/ssh"

const entities = ["owner", "group", "other"] as const

type Entity = typeof entities[number]

type Permission = {
    read: Entity[]
    write: Entity[]
    execute: Entity[]
}

export type SshToolDeps = SshDeps & {
    env?: NodeJS.ProcessEnv
    pool?: SshConnectionPool
}

export type SshConnectionContext = {
    client: SshClientLike
    host: string
    port: number
}

type SshAttributes = {
    path: string
    type: string
    owner: string
    group: string
    permission: Permission
    size: number
}

type RemoteEntryType = "file" | "directory" | "symlink" | "other"

type RemoteEntry = {
    path: string
    type: RemoteEntryType
    size?: number
    modified?: string
}

type RemoteMatch = {
    path: string
    line: number
    column: number
    text: string
}

type PatchHunk = {
    oldStart: number
    oldCount: number
    newStart: number
    newCount: number
    lines: string[]
}

type PatchResult = {
    content: string
    hunks: number
    additions: number
    removals: number
}

const defaultCommandTimeoutMs = 300000
const readFileMaxCharacters = 2000
const defaultFileToolLimit = 100
const maximumFileToolLimit = 1000
const defaultSshPool = new SshConnectionPool()

export function createAutocodeSshCommandTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: "Execute shell command on SSH server.",
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            command: tool.schema.string().describe("Shell command to execute on SSH server."),
            timeout_ms: tool.schema.number().optional().describe(`Optional command timeout in milliseconds. Defaults to ${defaultCommandTimeoutMs}`),
            max_characters: tool.schema.number().optional().describe("Optional maximum characters to return from command output."),
        },
        async execute(args): Promise<string> {
            const timeoutMs = args.timeout_ms ?? defaultCommandTimeoutMs
            const maxCharacters = args.max_characters
            if (!isPositiveInteger(timeoutMs)) return createSshToolErrorResponse("execute SSH command", new Error("timeout_ms must be a positive integer"))
            if (maxCharacters !== undefined && !isPositiveInteger(maxCharacters)) return createSshToolErrorResponse("execute SSH command", new Error("max_characters must be a positive integer"))

            return withSshConnection(args.ssh_key, deps, "execute SSH command", async ({ client, host, port }) => {
                const result = await execSshCommand(client, args.command, { timeoutMs })
                const output = combineCommandOutput(result.stdout, result.stderr)
                const charTruncated = maxCharacters === undefined ? { text: output, truncated: false } : truncateByBacklog(output, maxCharacters)

                return JSON.stringify({
                    host,
                    port,
                    output: charTruncated.text,
                    output_truncated: result.stdoutTruncated || result.stderrTruncated || charTruncated.truncated,
                })
            })
        },
    })
}

export function createAutocodeSshListTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: "List SSH server files/directories.",
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            directory: tool.schema.string().describe("Dir to list."),
            name_filter: tool.schema.string().optional().describe("Optional name contains filter."),
            ext_filter: tool.schema.string().optional().describe("Optional extension filter."),
            max_items: tool.schema.number().optional().describe("Optional max items."),
        },
        async execute(args): Promise<string> {
            if (args.max_items !== undefined && !isPositiveInteger(args.max_items)) return createSshToolErrorResponse("list SSH directory", new Error("max_items must be a positive integer"))

            return withSftp(args.ssh_key, deps, "list SSH directory", async ({ sftp, host, port }) => {
                const entries = await sftpReaddir(sftp, args.directory)
                const filtered = entries
                    .map((entry) => entry.filename)
                    .filter((filename) => matchesNameFilter(filename, args.name_filter) && matchesExtFilter(filename, args.ext_filter))
                    .map((filename) => joinRemotePath(args.directory, filename))
                const list = args.max_items === undefined ? filtered : filtered.slice(0, args.max_items)

                return JSON.stringify({ host, port, list, list_truncated: filtered.length > list.length })
            })
        },
    })
}

export function createAutocodeSshReadAttributesTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: "Read remote path owner, group, permission, type, and size over SSH.",
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            path: tool.schema.string().describe("Remote path."),
        },
        async execute(args): Promise<string> {
            return withSshConnection(args.ssh_key, deps, "read SSH attributes", async ({ client, host, port }) => {
                const sftp = await openSftp(client)
                const attrs = await readAttributes(client, sftp, args.path)
                return JSON.stringify({ host, port, ...attrs })
            })
        },
    })
}

export function createAutocodeSshWriteAttributesTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: "Update remote path owner, group, or permission bits over SSH.",
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            path: tool.schema.string().describe("Remote path."),
            owner: tool.schema.string().optional().describe("New owner name."),
            group: tool.schema.string().optional().describe("New group name."),
            read: tool.schema.array(tool.schema.enum(entities)).optional().describe("Who can read."),
            write: tool.schema.array(tool.schema.enum(entities)).optional().describe("Who can write."),
            execute: tool.schema.array(tool.schema.enum(entities)).optional().describe("Who can execute."),
        },
        async execute(args): Promise<string> {
            const permissionError = validatePermissionArgs(args.read, args.write, args.execute)
            if (permissionError) return createSshToolErrorResponse("write SSH attributes", permissionError)

            return withSshConnection(args.ssh_key, deps, "write SSH attributes", async ({ client, host, port }) => {
                const sftp = await openSftp(client)
                await readAttributes(client, sftp, args.path)
                await writeAttributes(client, args.path, args)
                const updated = await readAttributes(client, sftp, args.path)

                return JSON.stringify({
                    host,
                    port,
                    path: updated.path,
                    owner: updated.owner,
                    group: updated.group,
                    permission: updated.permission,
                })
            })
        },
    })
}

export function createAutocodeSshReadFileTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: "Read UTF-8 file on SSH/SFTP server.",
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            path: tool.schema.string().describe("File path relative to SSH filesystem."),
            first_line: tool.schema.number().optional().describe("First line to read."),
            last_line: tool.schema.number().optional().describe("Last line to read."),
        },
        async execute(args): Promise<string> {
            const firstLine = args.first_line ?? 1
            const lastLine = args.last_line
            const lineError = validateLineBounds(firstLine, lastLine)
            if (lineError) return createSshToolErrorResponse("read SSH file", lineError)

            return withSftp(args.ssh_key, deps, "read SSH file", async ({ sftp, host, port }) => {
                const file = await sftpReadFile(sftp, args.path, "utf8")
                const selectedContent = selectLineRange(String(file), firstLine, lastLine)
                const contentTruncated = selectedContent.length > readFileMaxCharacters

                return JSON.stringify({
                    host,
                    port,
                    path: args.path,
                    content: selectedContent.slice(0, readFileMaxCharacters),
                    content_truncated: contentTruncated,
                })
            })
        },
    })
}

export function createAutocodeSshWriteFileTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: "Write complete UTF-8 file on SSH/SFTP server.",
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            path: tool.schema.string().describe("File path relative to SSH filesystem."),
            content: tool.schema.string().describe("File content to write."),
            create_dirs: tool.schema.boolean().optional().describe("Make parent dirs."),
        },
        async execute(args): Promise<string> {
            const inputError = validateWritableRemoteFilePath(args.path, "path") ?? validateNoNul(args.content, "content")
            if (inputError) return createSshToolErrorResponse("write SSH file", inputError)

            return withSftp(args.ssh_key, deps, "write SSH file", async ({ sftp }) => {
                const existing = await statIfExists(sftp, args.path)
                if (existing?.isDirectory()) return createSshToolErrorResponse("write SSH file", new Error("path points to a directory"))
                if (args.create_dirs === true) await mkdirParents(sftp, remoteDirname(args.path))
                else {
                    const parent = await statIfExists(sftp, remoteDirname(args.path))
                    if (!parent) return createSshToolErrorResponse("write SSH file", new Error("parent directory does not exist; set create_dirs true to create it"))
                    if (!parent.isDirectory()) return createSshToolErrorResponse("write SSH file", new Error("parent path is not a directory"))
                }
                await sftpWriteFile(sftp, args.path, args.content)
                return JSON.stringify({ operation: "write", path: args.path, bytes: Buffer.byteLength(args.content, "utf8"), existed: existing !== undefined })
            })
        },
    })
}

export function createAutocodeSshEditFileTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: "Edit UTF-8 remote file by exact string replacement on SSH/SFTP server.",
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            path: tool.schema.string().describe("File path relative to SSH filesystem."),
            oldString: tool.schema.string().describe("Text to replace."),
            newString: tool.schema.string().describe("New text."),
            replaceAll: tool.schema.boolean().optional().describe("Replace all matches."),
        },
        async execute(args): Promise<string> {
            const inputError = validateRemotePath(args.path, "path") ?? validateNoNul(args.oldString, "oldString") ?? validateNoNul(args.newString, "newString")
            if (inputError) return createSshToolErrorResponse("edit SSH file", inputError)
            if (args.oldString === args.newString) return createSshToolErrorResponse("edit SSH file", new Error("oldString and newString must differ"))

            return withSftp(args.ssh_key, deps, "edit SSH file", async ({ sftp }) => {
                const existing = await statIfExists(sftp, args.path)
                if (!existing && args.oldString !== "") return createSshToolErrorResponse("edit SSH file", new Error("file is missing and oldString is not empty"))
                if (existing?.isDirectory()) return createSshToolErrorResponse("edit SSH file", new Error("path points to a directory"))
                if (existing && args.oldString === "") return createSshToolErrorResponse("edit SSH file", new Error("oldString must not be empty when editing an existing file"))

                const current = existing ? String(await sftpReadFile(sftp, args.path, "utf8")) : ""
                const occurrences = existing ? countOccurrences(current, args.oldString) : 0
                if (existing && occurrences === 0) return createSshToolErrorResponse("edit SSH file", new Error("oldString was not found"))
                if (occurrences > 1 && args.replaceAll !== true) return createSshToolErrorResponse("edit SSH file", new Error("oldString matched multiple locations; set replaceAll true or provide a more specific oldString"))

                const content = existing ? args.replaceAll === true ? current.replaceAll(args.oldString, args.newString) : current.replace(args.oldString, args.newString) : args.newString
                const replacements = existing ? args.replaceAll === true ? occurrences : 1 : 1
                await sftpWriteFile(sftp, args.path, content)
                return JSON.stringify({ operation: "edit", path: args.path, existed: existing !== undefined, replacements, bytes: Buffer.byteLength(content, "utf8") })
            })
        },
    })
}

export function createAutocodeSshPatchFileTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: "Apply unified diff to one UTF-8 remote file over SSH/SFTP server.",
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            path: tool.schema.string().describe("File path relative to SSH filesystem."),
            patch: tool.schema.string().describe("Unified diff patch."),
        },
        async execute(args): Promise<string> {
            const inputError = validateRemotePath(args.path, "path") ?? validateNoNul(args.patch, "patch")
            if (inputError) return createSshToolErrorResponse("patch SSH file", inputError)

            return withSftp(args.ssh_key, deps, "patch SSH file", async ({ sftp }) => {
                const current = String(await sftpReadFile(sftp, args.path, "utf8"))
                const result = applyUnifiedPatch(current, args.patch)
                if (!result.ok) return createSshToolErrorResponse("patch SSH file", new Error(result.reason))
                await sftpWriteFile(sftp, args.path, result.value.content)
                return JSON.stringify({ operation: "patch", path: args.path, hunks: result.value.hunks, additions: result.value.additions, removals: result.value.removals, bytes: Buffer.byteLength(result.value.content, "utf8") })
            })
        },
    })
}

export function createAutocodeSshGlobTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: "Find remote files by glob pattern on SSH/SFTP server.",
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            pattern: tool.schema.string().describe("Glob pattern."),
            path: tool.schema.string().optional().describe("State path relative to SSH filesystem."),
            limit: tool.schema.number().optional().describe("Max matches."),
        },
        async execute(args): Promise<string> {
            const inputError = validateRemotePattern(args.pattern, "pattern") ?? validateOptionalRemotePath(args.path, "path") ?? validateLimitArg(args.limit)
            if (inputError) return createSshToolErrorResponse("glob SSH files", inputError)
            const limit = normalizeFileToolLimit(args.limit)

            return withSftp(args.ssh_key, deps, "glob SSH files", async ({ sftp }) => {
                const search = createGlobSearch(args.pattern, args.path)
                const matcher = globToRegExp(search.matchPattern)
                const results: RemoteEntry[] = []
                const rootStats = await statIfExists(sftp, search.root)
                await walkRemote(sftp, search.root, async (entry) => {
                    const candidate = search.absoluteOutput ? entry.path : stripLeadingSlash(entry.path)
                    if (globEntryMatches(matcher, search.matchRoot, entry, rootStats)) results.push(entryWithOutputPath(entry, candidate))
                    return results.length < limit
                })
                return JSON.stringify(results.sort(sortEntries).slice(0, limit))
            })
        },
    })
}

export function createAutocodeSshGrepFileTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: "Search SSH UTF-8 text files by regex on SSH/SFTP server.",
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            pattern: tool.schema.string().describe("Regex pattern."),
            path: tool.schema.string().describe("File path relative to SSH filesystem."),
            include: tool.schema.string().optional().describe("Glob include filter."),
            limit: tool.schema.number().optional().describe("Max matches."),
        },
        async execute(args): Promise<string> {
            const inputError = validateRemotePattern(args.pattern, "pattern") ?? validateRemotePath(args.path, "path") ?? validateOptionalRemotePattern(args.include, "include") ?? validateLimitArg(args.limit)
            if (inputError) return createSshToolErrorResponse("grep SSH file", inputError)
            const regex = createRegex(args.pattern)
            if (!regex.ok) return createSshToolErrorResponse("grep SSH file", new Error(regex.reason))
            const include = args.include?.trim() ? globToRegExp(args.include.trim()) : undefined
            const limit = normalizeFileToolLimit(args.limit)

            return withSftp(args.ssh_key, deps, "grep SSH file", async ({ sftp }) => {
                const rootStats = await sftpStat(sftp, args.path)
                const matches: RemoteMatch[] = []
                if (rootStats.isDirectory()) {
                    await walkRemote(sftp, args.path, async (entry) => {
                        if (entry.type !== "file" || !includeMatches(include, args.path, entry.path)) return true
                        collectRegexMatches(entry.path, String(await sftpReadFile(sftp, entry.path, "utf8")), regex.value, matches, limit)
                        return matches.length < limit
                    })
                }
                else {
                    if (includeMatches(include, remoteDirname(args.path), args.path)) {
                        collectRegexMatches(args.path, String(await sftpReadFile(sftp, args.path, "utf8")), regex.value, matches, limit)
                    }
                }
                return JSON.stringify(matches.sort(sortMatches).slice(0, limit))
            })
        },
    })
}

export async function withSftp(sshKey: string, deps: SshToolDeps, failedAction: string, operation: (context: SshConnectionContext & { sftp: SftpLike }) => Promise<string>): Promise<string> {
    return withSshConnection(sshKey, deps, failedAction, async (context) => {
        const sftp = await openSftp(context.client)
        return operation({ ...context, sftp })
    })
}

async function withSshConnection(sshKey: string, deps: SshToolDeps, failedAction: string, operation: (context: SshConnectionContext) => Promise<string>): Promise<string> {
    let resolved: Awaited<ReturnType<typeof resolveSshConfig>>

    try {
        const configs = await createEnvConfigMap(sshKey, deps)
        resolved = await resolveSshConfig(configs, sshKey, deps)
    }
    catch (error) {
        return createSshToolErrorResponse("resolve SSH config", error)
    }

    try {
        const pool = deps.pool ?? defaultSshPool
        const client = await pool.get(resolved)

        try {
            return await operation({ client, host: resolved.host, port: resolved.port })
        }
        finally {
            pool.release(resolved)
        }
    }
    catch (error) {
        return createSshToolAbortResponse(failedAction, error)
    }
}

export function validateRemotePath(value: string, name: string): Error | undefined {
    if (!value.trim()) return new Error(`${name} must be a non-empty string`)
    return validateNoNul(value, name)
}

export function validateWritableRemoteFilePath(value: string, name: string): Error | undefined {
    const pathError = validateRemotePath(value, name)
    if (pathError) return pathError
    const normalized = normalizeRemotePath(value.trim())
    if (normalized === "/" || normalized === ".") return new Error(`${name} must point to a file, not a root directory`)
    if (/\/$/.test(normalized)) return new Error(`${name} must point to a file, not end with a slash`)
    return undefined
}

function validateOptionalRemotePath(value: string | undefined, name: string): Error | undefined {
    if (value === undefined) return undefined
    return validateRemotePath(value, name)
}

function validateRemotePattern(value: string, name: string): Error | undefined {
    if (!value.trim()) return new Error(`${name} must be a non-empty string`)
    return validateNoNul(value, name)
}

function validateOptionalRemotePattern(value: string | undefined, name: string): Error | undefined {
    if (value === undefined) return undefined
    return validateRemotePattern(value, name)
}

function validateNoNul(value: string, name: string): Error | undefined {
    return value.includes("\0") ? new Error(`${name} must not contain NUL bytes`) : undefined
}

function validateLimitArg(value: number | undefined): Error | undefined {
    if (value !== undefined && !isPositiveInteger(value)) return new Error("limit must be a positive integer")
    return undefined
}

function normalizeFileToolLimit(value: number | undefined): number {
    return Math.min(value ?? defaultFileToolLimit, maximumFileToolLimit)
}

async function statIfExists(sftp: SftpLike, filePath: string): Promise<Stats | undefined> {
    try {
        return await sftpStat(sftp, filePath)
    }
    catch (error) {
        if (isMissingPathError(error)) return undefined
        throw error
    }
}

function isMissingPathError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    const detail = `${error.name} ${error.message}`.toLowerCase()
    return detail.includes("no such file") || detail.includes("not found") || detail.includes("enoent")
}

async function mkdirParents(sftp: SftpLike, directory: string): Promise<void> {
    if (!directory || directory === "." || directory === "/") return
    await mkdirParents(sftp, remoteDirname(directory))
    try {
        await sftpMkdir(sftp, directory)
    }
    catch (error) {
        if (!isAlreadyExistsError(error)) throw error
    }
}

function isAlreadyExistsError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    const detail = `${error.name} ${error.message}`.toLowerCase()
    return detail.includes("exists") || detail.includes("failure")
}

function countOccurrences(content: string, search: string): number {
    if (!search) return 0
    let count = 0
    let index = content.indexOf(search)
    while (index >= 0) {
        count += 1
        index = content.indexOf(search, index + search.length)
    }
    return count
}

function globToRegExp(pattern: string): RegExp {
    const normalized = pattern.replaceAll("\\", "/")
    let source = "^"
    for (let index = 0; index < normalized.length; index += 1) {
        const char = normalized[index]
        const next = normalized[index + 1]
        if (char === "*" && next === "*" && normalized[index + 2] === "/") {
            source += "(?:.*/)?"
            index += 2
        }
        else if (char === "*" && next === "*") {
            source += ".*"
            index += 1
        }
        else if (char === "*") source += "[^/]*"
        else if (char === "?") source += "[^/]"
        else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    }
    return new RegExp(`${source}$`)
}

function createGlobSearch(pattern: string, basePath?: string): { root: string; matchRoot: string; matchPattern: string; absoluteOutput: boolean } {
    const normalizedPattern = pattern.trim().replaceAll("\\", "/")
    if (basePath) {
        const root = normalizeRemotePath(basePath)
        return { root, matchRoot: root, matchPattern: normalizedPattern, absoluteOutput: true }
    }
    const prefix = nonGlobPrefix(normalizedPattern)
    const root = prefix ? normalizeRemotePath(prefix) : normalizedPattern.startsWith("/") ? "/" : "."
    return { root, matchRoot: root, matchPattern: remoteRelative(root, normalizedPattern), absoluteOutput: normalizedPattern.startsWith("/") }
}

function nonGlobPrefix(pattern: string): string {
    const firstGlob = pattern.search(/[*?]/)
    if (firstGlob < 0) return remoteDirname(pattern)
    const slash = pattern.slice(0, firstGlob).lastIndexOf("/")
    if (slash < 0) return ""
    return pattern.slice(0, slash) || "/"
}

async function walkRemote(sftp: SftpLike, start: string, visitor: (entry: RemoteEntry) => Promise<boolean> | boolean): Promise<boolean> {
    const startStats = await statIfExists(sftp, start)
    if (!startStats) return true
    if (!startStats.isDirectory()) {
        return visitor(createRemoteEntry(start, startStats))
    }

    const entries = await sftpReaddir(sftp, start)
    for (const entry of entries.sort((left, right) => left.filename.localeCompare(right.filename))) {
        const entryPath = remoteJoin(start, entry.filename)
        const remoteEntry = createRemoteEntry(entryPath, entry.attrs)
        const shouldContinue = await visitor(remoteEntry)
        if (!shouldContinue) return false
        if (entry.attrs.isDirectory()) {
            const subtreeShouldContinue = await walkRemote(sftp, entryPath, visitor)
            if (!subtreeShouldContinue) return false
        }
    }
    return true
}

function createRemoteEntry(filePath: string, attrs: Stats): RemoteEntry {
    const modified = attrs.mtime ? new Date(attrs.mtime * 1000).toISOString() : undefined
    return modified ? { path: filePath, type: attrsToType(attrs), size: attrs.size, modified } : { path: filePath, type: attrsToType(attrs), size: attrs.size }
}

function attrsToType(attrs: Stats): RemoteEntryType {
    if (attrs.isDirectory()) return "directory"
    if (attrs.isFile()) return "file"
    if (attrs.isSymbolicLink()) return "symlink"
    return "other"
}

function entryWithOutputPath(entry: RemoteEntry, filePath: string): RemoteEntry {
    return { ...entry, path: filePath }
}

function globEntryMatches(matcher: RegExp, root: string, entry: RemoteEntry, rootStats?: Stats): boolean {
    if (rootStats?.isFile()) return matcher.test(remoteBasename(entry.path)) || matcher.test(entry.path)
    return matcher.test(remoteRelative(root, entry.path))
}

function includeMatches(include: RegExp | undefined, root: string, filePath: string): boolean {
    if (!include) return true
    return include.test(remoteRelative(root, filePath)) || include.test(remoteBasename(filePath)) || include.test(filePath)
}

function collectRegexMatches(filePath: string, content: string, regex: RegExp, matches: RemoteMatch[], limit: number): void {
    const lineRegex = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`)
    const lines = content.split(/\r?\n/)
    for (let lineIndex = 0; lineIndex < lines.length && matches.length < limit; lineIndex += 1) {
        lineRegex.lastIndex = 0
        let match = lineRegex.exec(lines[lineIndex])
        while (match && matches.length < limit) {
            matches.push({ path: filePath, line: lineIndex + 1, column: match.index + 1, text: lines[lineIndex] })
            lineRegex.lastIndex = match[0].length === 0 ? lineRegex.lastIndex + 1 : lineRegex.lastIndex
            match = lineRegex.exec(lines[lineIndex])
        }
    }
}

function createRegex(pattern: string): { ok: true; value: RegExp } | { ok: false; reason: string } {
    try {
        return { ok: true, value: new RegExp(pattern) }
    }
    catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
}

function applyUnifiedPatch(content: string, patch: string): { ok: true; value: PatchResult } | { ok: false; reason: string } {
    const parsed = parseUnifiedPatch(patch)
    if (!parsed.ok) return parsed
    const hadFinalNewline = content.endsWith("\n")
    const originalLines = splitPatchContent(content)
    const output: string[] = []
    let cursor = 0
    let additions = 0
    let removals = 0
    for (let index = 0; index < parsed.value.length; index += 1) {
        const hunk = parsed.value[index]
        const targetIndex = Math.max(hunk.oldStart - 1, 0)
        output.push(...originalLines.slice(cursor, targetIndex))
        const applied = applyPatchHunk(originalLines, targetIndex, hunk, index + 1)
        if (!applied.ok) return applied
        output.push(...applied.value.lines)
        cursor = applied.value.cursor
        additions += applied.value.additions
        removals += applied.value.removals
    }
    output.push(...originalLines.slice(cursor))
    return { ok: true, value: { content: `${output.join("\n")}${hadFinalNewline && output.length > 0 ? "\n" : ""}`, hunks: parsed.value.length, additions, removals } }
}

function parseUnifiedPatch(patch: string): { ok: true; value: PatchHunk[] } | { ok: false; reason: string } {
    const lines = patch.split(/\r?\n/)
    const hunks: PatchHunk[] = []
    for (let index = 0; index < lines.length; index += 1) {
        if (isUnsupportedPatchFileOperation(lines[index])) return { ok: false, reason: `unsupported patch file operation: ${lines[index]}` }
        if (lines[index].startsWith("@@")) {
            const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index])
            if (!header) return { ok: false, reason: `malformed hunk header: ${lines[index]}` }
            const hunkLines: string[] = []
            index += 1
            while (index < lines.length && !lines[index].startsWith("@@")) {
                if (lines[index] === "" && index === lines.length - 1) break
                if (!isPatchBodyLine(lines[index])) return { ok: false, reason: `malformed patch line: ${lines[index]}` }
                if (!lines[index].startsWith("\\ No newline")) hunkLines.push(lines[index])
                index += 1
            }
            index -= 1
            const hunk = { oldStart: Number(header[1]), oldCount: Number(header[2] ?? "1"), newStart: Number(header[3]), newCount: Number(header[4] ?? "1"), lines: hunkLines }
            const countError = validatePatchHunkCounts(hunk)
            if (countError) return { ok: false, reason: countError }
            hunks.push(hunk)
        }
    }
    if (hunks.length === 0) return { ok: false, reason: "patch contains no hunks" }
    return { ok: true, value: hunks }
}

function isUnsupportedPatchFileOperation(line: string): boolean {
    return line === "--- /dev/null" || line === "+++ /dev/null" || line.startsWith("new file mode ") || line.startsWith("deleted file mode ") || line.startsWith("rename from ") || line.startsWith("rename to ")
}

function isPatchBodyLine(line: string): boolean {
    return line.startsWith(" ") || line.startsWith("-") || line.startsWith("+") || line.startsWith("\\ No newline")
}

function validatePatchHunkCounts(hunk: PatchHunk): string | undefined {
    const oldLines = hunk.lines.filter((line) => line.startsWith(" ") || line.startsWith("-")).length
    const newLines = hunk.lines.filter((line) => line.startsWith(" ") || line.startsWith("+")).length
    if (oldLines !== hunk.oldCount) return `hunk at -${hunk.oldStart} has ${oldLines} old lines, expected ${hunk.oldCount}`
    if (newLines !== hunk.newCount) return `hunk at +${hunk.newStart} has ${newLines} new lines, expected ${hunk.newCount}`
    return undefined
}

function applyPatchHunk(original: string[], start: number, hunk: PatchHunk, hunkNumber: number): { ok: true; value: { lines: string[]; cursor: number; additions: number; removals: number } } | { ok: false; reason: string } {
    const lines: string[] = []
    let cursor = start
    let additions = 0
    let removals = 0
    for (const patchLine of hunk.lines) {
        const marker = patchLine[0]
        const text = patchLine.slice(1)
        if (marker === "+") {
            lines.push(text)
            additions += 1
            continue
        }
        const actual = original[cursor]
        if (actual !== text) return { ok: false, reason: `hunk ${hunkNumber} mismatch at line ${cursor + 1}: expected ${JSON.stringify(text)}, actual ${JSON.stringify(actual ?? "")}` }
        if (marker === " ") lines.push(actual)
        if (marker === "-") removals += 1
        cursor += 1
    }
    return { ok: true, value: { lines, cursor, additions, removals } }
}

function splitPatchContent(content: string): string[] {
    const lines = content.split(/\r?\n/)
    return content.endsWith("\n") ? lines.slice(0, -1) : lines
}

function remoteJoin(directory: string, name: string): string {
    if (!directory || directory === ".") return name
    if (directory === "/") return `/${name}`
    return `${directory.replace(/\/+$/, "")}/${name}`
}

function remoteDirname(filePath: string): string {
    const normalized = normalizeRemotePath(filePath)
    const trimmed = normalized.replace(/\/+$/, "")
    const index = trimmed.lastIndexOf("/")
    if (index < 0) return "."
    if (index === 0) return "/"
    return trimmed.slice(0, index)
}

function remoteBasename(filePath: string): string {
    const normalized = normalizeRemotePath(filePath).replace(/\/+$/, "")
    const index = normalized.lastIndexOf("/")
    return index < 0 ? normalized : normalized.slice(index + 1)
}

function remoteRelative(root: string, filePath: string): string {
    const normalizedRoot = normalizeRemotePath(root).replace(/\/+$/, "")
    const normalizedPath = normalizeRemotePath(filePath)
    if (normalizedRoot === "." || normalizedRoot === "") return stripLeadingSlash(normalizedPath)
    if (normalizedPath === normalizedRoot) return ""
    return normalizedPath.startsWith(`${normalizedRoot}/`) ? normalizedPath.slice(normalizedRoot.length + 1) : stripLeadingSlash(normalizedPath)
}

function normalizeRemotePath(filePath: string): string {
    const normalized = filePath.replaceAll("\\", "/")
    return normalized === "" ? "." : normalized
}

function stripLeadingSlash(filePath: string): string {
    return filePath.replace(/^\/+/, "")
}

function sortEntries(left: RemoteEntry, right: RemoteEntry): number {
    return left.path.localeCompare(right.path)
}

function sortMatches(left: RemoteMatch, right: RemoteMatch): number {
    return left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column
}

async function createEnvConfigMap(sshKey: string, deps: SshToolDeps): Promise<SshConfigMap> {
    const suffix = normalizeEnvSuffix(sshKey)
    const env = deps.env ?? process.env
    const host = env[`AUTOCODE_SSH_${suffix}_HOST`]

    if (!host) throw new Error(`Wrong ssh_key or missing AUTOCODE_SSH_${suffix}_HOST var`)

    const username = env[`AUTOCODE_SSH_${suffix}_USERNAME`] || "root"
    const keyfile = env[`AUTOCODE_SSH_${suffix}_KEYFILE`]
    const password = env[`AUTOCODE_SSH_${suffix}_PASSWORD`]
    const keypass = env[`AUTOCODE_SSH_${suffix}_KEYPASS`]
    const agent = env[`AUTOCODE_SSH_${suffix}_AGENT`]
    const port = parseEnvPort(env[`AUTOCODE_SSH_${suffix}_PORT`])
    const config: SshConfigInput = { host, username }

    if (port !== undefined) config.port = port

    if (keyfile && await canReadFile(keyfile)) {
        config.privateKeyPath = keyfile
        if (keypass?.trim()) config.passphrase = keypass
        if (password) config.password = password
    }
    else if (password) {
        config.password = password
    }
    else if (agent) {
        config.agent = agent
    }

    return { [sshKey]: config }
}

function parseEnvPort(value: string | undefined): number | undefined {
    if (value === undefined) return undefined
    const trimmed = value.trim()
    if (!/^\d+$/.test(trimmed)) throw new Error("SSH port must be an integer")

    const port = Number(trimmed)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SSH port must be between 1 and 65535")
    return port
}

function normalizeEnvSuffix(sshKey: string): string {
    if (!sshKey || !/^[A-Za-z0-9_-]+$/.test(sshKey)) {
        throw new Error("ssh_key must contain only letters, digits, underscore, or hyphen")
    }

    return sshKey.replaceAll("-", "_").toUpperCase()
}

async function canReadFile(filePath: string): Promise<boolean> {
    try {
        await access(filePath, fsConstants.R_OK)
        return true
    }
    catch {
        return false
    }
}

function combineCommandOutput(stdout: string, stderr: string): string {
    if (!stdout) return stderr
    if (!stderr) return stdout
    return `${stdout}${stdout.endsWith("\n") ? "" : "\n"}${stderr}`
}

function truncateByBacklog(output: string, maxCharacters: number): { text: string; truncated: boolean } {
    if (output.length <= maxCharacters) return { text: output, truncated: false }

    let remaining = output
    while (remaining.length > maxCharacters) {
        const newlineIndex = remaining.indexOf("\n")
        if (newlineIndex < 0) return { text: remaining.slice(0, maxCharacters), truncated: true }
        remaining = remaining.slice(newlineIndex + 1)
    }

    return { text: remaining, truncated: true }
}

function matchesNameFilter(filename: string, nameFilter?: string): boolean {
    return !nameFilter || filename.includes(nameFilter)
}

function matchesExtFilter(filename: string, extFilter?: string): boolean {
    if (!extFilter) return true
    const extension = extFilter.startsWith(".") ? extFilter : `.${extFilter}`
    return filename.endsWith(extension)
}

function joinRemotePath(directory: string, filename: string): string {
    return `${directory.replace(/\/+$/, "")}/${filename}`
}

async function readAttributes(client: SshClientLike, sftp: SftpLike, filePath: string): Promise<SshAttributes> {
    const [stats, statOutput] = await Promise.all([
        sftpStat(sftp, filePath),
        execRequiredCommand(client, `stat -c '%U\t%G\t%F\t%a\t%s' -- ${shellQuote(filePath)}`),
    ])
    const parsed = parseStatOutput(statOutput, stats)

    return { path: filePath, ...parsed }
}

async function execRequiredCommand(client: SshClientLike, command: string): Promise<string> {
    const result = await execSshCommand(client, command, { timeoutMs: defaultCommandTimeoutMs })
    if (result.exitCode !== undefined && result.exitCode !== 0) throw new Error(combineCommandOutput(result.stdout, result.stderr) || `SSH command failed with exit code ${result.exitCode}`)
    return result.stdout.trim()
}

function parseStatOutput(output: string, stats: Stats): Omit<SshAttributes, "path"> {
    const [owner = "", group = "", typeText = "", modeText = "", sizeText = ""] = output.split("\t")
    const mode = Number.parseInt(modeText, 8)
    const fallbackMode = typeof stats.mode === "number" ? stats.mode : 0
    const size = Number.parseInt(sizeText, 10)

    return {
        type: parseType(typeText, stats),
        owner,
        group,
        permission: permissionFromMode(Number.isFinite(mode) ? mode : fallbackMode),
        size: Number.isFinite(size) ? size : stats.size,
    }
}

function parseType(typeText: string, stats: Stats): string {
    const normalized = typeText.toLowerCase()
    if (normalized.includes("directory")) return "directory"
    if (normalized.includes("symbolic link")) return "link"
    if (stats.isDirectory()) return "directory"
    if (stats.isSymbolicLink()) return "link"
    return "file"
}

function permissionFromMode(mode: number): Permission {
    return {
        read: entities.filter((entity) => (mode & permissionBit(entity, "read")) !== 0),
        write: entities.filter((entity) => (mode & permissionBit(entity, "write")) !== 0),
        execute: entities.filter((entity) => (mode & permissionBit(entity, "execute")) !== 0),
    }
}

function permissionBit(entity: Entity, category: keyof Permission): number {
    const base = category === "read" ? 4 : category === "write" ? 2 : 1
    const shift = entity === "owner" ? 6 : entity === "group" ? 3 : 0
    return base << shift
}

async function writeAttributes(client: SshClientLike, filePath: string, args: { owner?: string; group?: string; read?: Entity[]; write?: Entity[]; execute?: Entity[] }): Promise<void> {
    if (args.owner) await execRequiredCommand(client, `chown -- ${shellQuote(args.owner)} ${shellQuote(filePath)}`)
    if (args.group) await execRequiredCommand(client, `chgrp -- ${shellQuote(args.group)} ${shellQuote(filePath)}`)
    const chmodSpec = buildChmodSpec(args)
    if (chmodSpec) await execRequiredCommand(client, `chmod ${chmodSpec} -- ${shellQuote(filePath)}`)
}

function buildChmodSpec(args: { read?: Entity[]; write?: Entity[]; execute?: Entity[] }): string | undefined {
    const specs: string[] = []
    addChmodSpecs(specs, "r", args.read)
    addChmodSpecs(specs, "w", args.write)
    addChmodSpecs(specs, "x", args.execute)
    return specs.length > 0 ? specs.join(",") : undefined
}

function addChmodSpecs(specs: string[], flag: "r" | "w" | "x", value?: Entity[]): void {
    if (value === undefined) return
    for (const entity of entities) {
        specs.push(`${chmodEntity(entity)}${value.includes(entity) ? "+" : "-"}${flag}`)
    }
}

function chmodEntity(entity: Entity): "u" | "g" | "o" {
    if (entity === "owner") return "u"
    if (entity === "group") return "g"
    return "o"
}

function validatePermissionArgs(...values: Array<Entity[] | undefined>): Error | undefined {
    for (const value of values) {
        if (value === undefined) continue
        for (const entity of value) {
            if (!entities.includes(entity)) return new Error("permission entities must be owner, group, or other")
        }
    }

    return undefined
}

function validateLineBounds(firstLine: number, lastLine?: number): Error | undefined {
    if (!isPositiveInteger(firstLine)) return new Error("first_line must be a positive integer")
    if (lastLine !== undefined && !isPositiveInteger(lastLine)) return new Error("last_line must be a positive integer")
    if (lastLine !== undefined && lastLine < firstLine) return new Error("last_line must be greater than or equal to first_line")
    return undefined
}

function selectLineRange(content: string, firstLine: number, lastLine?: number): string {
    const lines = content.split(/(?<=\n)/)
    return lines.slice(firstLine - 1, lastLine).join("")
}

function isPositiveInteger(value: number): boolean {
    return Number.isInteger(value) && value > 0
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`
}
