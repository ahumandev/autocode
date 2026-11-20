import type { ToolContext } from "@opencode-ai/plugin"
import { lstat, stat } from "node:fs/promises"
import path from "node:path"
import { authorizeExternalContentPath } from "@/utils/external_directory"
import { absoluteScanCwd, expandGlob, type GlobMatch } from "@/utils/glob"
import { canonicalizeExistingOrMissingPath, classifyMemoryPath, isPathWithin } from "@/utils/memory_access"
import { resolveMemoryDirectory } from "@/utils/memory_directory"
import { createRetryResponse } from "@/utils/tools"

type Authorization = { ok: true } | { ok: false, response: string }

const GLOB_META = /[*?[{]/
const CONSERVATIVE_GLOB_META = /[*?[\]{}()!]/
const AMBIGUOUS_TRAVERSAL = /(?:^|[\\/,{}()[\]|])\.\.(?=$|[\\/,{}()[\]|])/

function retry(failedAction: string, error: string): { ok: false, response: string } {
    return { ok: false, response: createRetryResponse(failedAction, error, "Use a path with an unambiguous, authorized scan directory.") }
}

function samePath(left: string, right: string): boolean {
    return isPathWithin(left, right) && isPathWithin(right, left)
}

function compatibleStaticPrefix(pattern: string): string | undefined {
    if (path.isAbsolute(pattern) || /^[a-z]:/i.test(pattern) || /^\\\\/.test(pattern)) return undefined
    if (process.platform !== "win32" && pattern.includes("\\")) return undefined

    const segments = pattern.split(process.platform === "win32" ? /[\\/]+/ : /\/+/)
    const traversal = segments.includes("..")
    if (!traversal && pattern.includes("..")) return undefined
    if (!pattern.startsWith("!") && !pattern.includes("!(") && !traversal) return undefined

    let depth = 0
    let magicSeen = false
    let traversalAfterMagic = false
    const prefix: string[] = []
    for (const segment of segments) {
        if (segment === "" || segment === ".") continue
        if (segment === "..") {
            if (!magicSeen) return undefined
            traversalAfterMagic ||= magicSeen
            if (--depth < 0) return undefined
            continue
        }
        if (segment.includes("..") || (segment.includes("**") && segment !== "**")) return undefined
        const supported = traversal
            ? /^(?:[a-zA-Z0-9_.-]|[*?]|\[[a-zA-Z0-9_]+\])+$/.test(segment)
            : /^(?:[a-zA-Z0-9_.-]|[*?]|\[[a-zA-Z0-9_]+\]|!\([a-zA-Z0-9_.-]+\)|!)+$/.test(segment)
        if (!supported) return undefined
        if (CONSERVATIVE_GLOB_META.test(segment)) magicSeen = true
        if (!magicSeen) prefix.push(segment)
        if (segment !== "**") depth++
    }
    if (traversal && !traversalAfterMagic) return undefined
    return prefix.join(path.sep)
}

async function authorizePath(
    target: string,
    context: ToolContext,
    failedAction: string,
    memoryDirectory: string | undefined,
    canonicalProject: string,
    authorized: Set<string>,
): Promise<Authorization> {
    let canonicalTarget: string
    let memory: "outside" | "allowed" | "denied"
    try {
        canonicalTarget = await canonicalizeExistingOrMissingPath(target)
        memory = await classifyMemoryPath(context.directory, memoryDirectory, target)
    }
    catch {
        return retry(failedAction, `Path '${target}' cannot be resolved safely.`)
    }
    if ((context.agent === "query-memory" || context.agent === "learn-memory") && memory !== "allowed") return retry(failedAction, `Memory path '${target}' cannot be accessed safely.`)
    if (memory === "allowed") return { ok: true }

    const lexicalTarget = path.resolve(target)
    const paths: string[] = []
    if (!isPathWithin(context.directory, lexicalTarget)) paths.push(lexicalTarget)
    if (!isPathWithin(canonicalProject, canonicalTarget) && !paths.some((entry) => samePath(entry, canonicalTarget))) {
        paths.push(canonicalTarget)
    }
    for (const entry of paths) {
        if (authorized.has(entry)) continue
        const result = await authorizeExternalContentPath(context, entry, failedAction)
        if (!result.ok) return memory === "denied" ? retry(failedAction, `Memory path '${target}' cannot be accessed safely.`) : result
        authorized.add(entry)
    }
    return { ok: true }
}

export async function expandAuthorizedMarkdownGlob(
    pattern: string,
    context: ToolContext,
    failedAction: string,
    memoryDirectory?: string,
): Promise<{ ok: true, matches: GlobMatch[] } | { ok: false, response: string }> {
    if (pattern === "" && (context.agent === "query-memory" || context.agent === "learn-memory")) return retry(failedAction, "Glob pattern must not be empty.")
    if (pattern === "") return { ok: true, matches: await expandGlob(pattern, context.directory, { dot: true, followSymlinks: false }) }

    if ((process.platform === "win32" && /^[a-z]:[^\\/]/i.test(pattern))
        || (process.platform !== "win32" && (/^[a-z]:[\\/]/i.test(pattern) || /^\\\\/.test(pattern)))) {
        return retry(failedAction, "Glob uses ambiguous drive or UNC path semantics.")
    }
    const rawAbsolute = path.isAbsolute(pattern) ? pattern : `${context.directory}${path.sep}${pattern}`
    const absolutePattern = path.isAbsolute(pattern) ? path.resolve(pattern) : path.resolve(context.directory, pattern)
    const memoryRoot = context.agent === "query-memory" || context.agent === "learn-memory" ? resolveMemoryDirectory(context.directory, memoryDirectory) : undefined
    const exactMemoryTarget = memoryRoot !== undefined && GLOB_META.test(memoryRoot) && isPathWithin(memoryRoot, absolutePattern)
        && !CONSERVATIVE_GLOB_META.test(path.relative(memoryRoot, absolutePattern))
    if (!path.isAbsolute(pattern) && GLOB_META.test(context.directory) && !exactMemoryTarget) {
        return retry(failedAction, "Project directory contains glob metacharacters.")
    }

    const prefix = compatibleStaticPrefix(pattern)
    if (prefix !== undefined && context.agent !== "query-memory" && context.agent !== "learn-memory") {
        const staticBase = prefix ? `${context.directory}${path.sep}${prefix}` : context.directory
        let canonicalProject: string
        let canonicalCwd: string
        let canonicalBase: string
        let canonicalMemory: string
        let memory: "outside" | "allowed" | "denied"
        try {
            canonicalProject = await canonicalizeExistingOrMissingPath(context.directory)
            canonicalCwd = await canonicalizeExistingOrMissingPath(context.directory)
            canonicalBase = await canonicalizeExistingOrMissingPath(staticBase)
            memory = await classifyMemoryPath(context.directory, memoryDirectory, staticBase)
            canonicalMemory = await canonicalizeExistingOrMissingPath(resolveMemoryDirectory(context.directory, memoryDirectory))
        }
        catch {
            return retry(failedAction, "Glob scan directory cannot be resolved safely.")
        }
        if (memory !== "allowed" && isPathWithin(canonicalProject, canonicalCwd)
            && isPathWithin(canonicalProject, canonicalBase) && !isPathWithin(canonicalMemory, canonicalBase)) {
            const authorized = new Set<string>()
            const baseResult = await authorizePath(staticBase, context, failedAction, memoryDirectory, canonicalProject, authorized)
            if (!baseResult.ok) return baseResult
            const matches = await expandGlob(pattern, context.directory, { dot: true, followSymlinks: false })
            for (const match of matches) {
                const result = await authorizePath(match.absolute, context, failedAction, memoryDirectory, canonicalProject, authorized)
                if (!result.ok) return result
            }
            return { ok: true, matches }
        }
    }

    const firstMeta = pattern.search(CONSERVATIVE_GLOB_META)
    if (pattern.startsWith("!") || (firstMeta !== -1 && AMBIGUOUS_TRAVERSAL.test(pattern.slice(firstMeta)))) {
        return retry(failedAction, "Glob contains ambiguous negation or traversal after a metacharacter.")
    }

    if (exactMemoryTarget) {
        try {
            const rawMemory = await classifyMemoryPath(context.directory, memoryDirectory, rawAbsolute)
            const normalizedMemory = await classifyMemoryPath(context.directory, memoryDirectory, absolutePattern)
            const rawCanonical = await canonicalizeExistingOrMissingPath(rawAbsolute)
            const normalizedCanonical = await canonicalizeExistingOrMissingPath(absolutePattern)
            if (rawMemory !== "allowed" || normalizedMemory !== "allowed" || !samePath(rawCanonical, normalizedCanonical)) {
                return retry(failedAction, `Memory path '${pattern}' cannot be accessed safely.`)
            }
        }
        catch {
            return retry(failedAction, `Memory path '${pattern}' cannot be accessed safely.`)
        }
        try {
            if (!(await stat(absolutePattern)).isFile()) return { ok: true, matches: [] }
        }
        catch (error) {
            if (typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
                return { ok: true, matches: [] }
            }
            return retry(failedAction, `Memory path '${pattern}' cannot be accessed safely.`)
        }
        const relToCwd = path.relative(context.directory, absolutePattern)
        const outsideCwd = relToCwd === "" || relToCwd.startsWith("..") || path.isAbsolute(relToCwd)
        return { ok: true, matches: [{ key: outsideCwd ? absolutePattern : relToCwd, absolute: absolutePattern }] }
    }
    const rawMeta = rawAbsolute.search(GLOB_META)
    const lastSeparator = process.platform === "win32"
        ? Math.max(rawAbsolute.lastIndexOf("/", rawMeta), rawAbsolute.lastIndexOf("\\", rawMeta))
        : rawAbsolute.lastIndexOf("/", rawMeta)
    const rawBase = rawMeta === -1
        ? rawAbsolute
        : rawAbsolute.slice(0, lastSeparator + 1) || path.parse(rawAbsolute).root
    const scanBase = GLOB_META.test(absolutePattern) ? absoluteScanCwd(absolutePattern) : absolutePattern

    let canonicalProject: string
    try {
        canonicalProject = await canonicalizeExistingOrMissingPath(context.directory)
    }
    catch {
        return retry(failedAction, `Project directory '${context.directory}' cannot be resolved safely.`)
    }

    const authorized = new Set<string>()
    const rawResult = await authorizePath(rawBase, context, failedAction, memoryDirectory, canonicalProject, authorized)
    if (!rawResult.ok) return rawResult
    const scanResult = await authorizePath(scanBase, context, failedAction, memoryDirectory, canonicalProject, authorized)
    if (!scanResult.ok) return scanResult
    let scanCanonical: string
    try {
        const rawCanonical = await canonicalizeExistingOrMissingPath(rawBase)
        scanCanonical = await canonicalizeExistingOrMissingPath(scanBase)
        if (!samePath(rawCanonical, scanCanonical)) {
            return retry(failedAction, "Glob traversal changes meaning when normalized.")
        }
    }
    catch {
        return retry(failedAction, "Glob scan directory cannot be resolved safely.")
    }

    if (GLOB_META.test(absolutePattern)) {
        try {
            await lstat(scanBase)
        }
        catch (error) {
            if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error
            try {
                if (!samePath(scanCanonical, await canonicalizeExistingOrMissingPath(scanBase))) {
                    return retry(failedAction, "Glob scan directory cannot be resolved safely.")
                }
            }
            catch {
                return retry(failedAction, "Glob scan directory cannot be resolved safely.")
            }
            return { ok: true, matches: [] }
        }
    }

    const matches = await expandGlob(absolutePattern, context.directory, { dot: true, followSymlinks: false })
    for (const match of matches) {
        const result = await authorizePath(match.absolute, context, failedAction, memoryDirectory, canonicalProject, authorized)
        if (!result.ok) return result
    }
    return { ok: true, matches }
}
