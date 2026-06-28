import { readdir, stat } from "fs/promises"
import path from "path"
import type { ToolContext } from "@opencode-ai/plugin"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"
import { authorizeExternalContentPath } from "@/utils/external_directory"
import { contentModeFromExtension, type ContentAdapter } from "./local_filesystem_adapter"
import { jsonSectionInfo, parseJsonDocument, resolveJsonNode } from "./json"
import { envSectionInfo, parseEnvDocument } from "./env"
import { formatIniPath, iniSectionInfo, parseIniDocument } from "./ini"
import { parseMarkdown, sectionInfo } from "./markdown"
import { parseTomlDocument, tomlSectionInfo } from "./toml"
import { parseYamlDocument, resolveYamlNode, yamlSectionInfo } from "./yaml"
import type { ContentMode, ContentTarget, JsonPath } from "./types"

export type ContentGrepArgs = {
    pattern: string
    path?: string
    include?: string
    limit?: number
}

type ContentLocation = {
    path: string
    matches: Array<Record<string, unknown>>
    truncated: boolean
}

type SectionRange = {
    section: Record<string, unknown>
    start: number
    end: number
}

export async function createLocalContentGrepResponse(args: ContentGrepArgs, context?: ToolContext): Promise<string> {
    try {
        const validation = validateContentGrepArgs(args, true)
        if (!validation.ok) return validation.response
        const files = await listLocalContentFiles(validation.value.path, validation.value.include, context)
        return JSON.stringify(await collectContentGrep(files, validation.value.regex, validation.value.limit, async (target) => Bun.file(target.absolutePath).text()))
    }
    catch (error) {
        return createAbortResponse("grep content", error instanceof Error ? error.message : String(error))
    }
}

export function createContentGrepHandler(adapter: ContentAdapter): (args: Record<string, unknown>) => Promise<string> {
    return async (args: Record<string, unknown>): Promise<string> => {
        try {
            const validation = validateContentGrepArgs(args as ContentGrepArgs, false)
            if (!validation.ok) return validation.response
            const target = await adapter.validateContentPath(validation.value.path)
            if (!target.ok) return target.response
            const include = validation.value.include ? globToRegExp(validation.value.include) : undefined
            if (include && !includeMatches(include, target.value.inputPath)) return JSON.stringify([])
            return JSON.stringify(await collectContentGrep([target.value], validation.value.regex, validation.value.limit, (filePath) => adapter.read(filePath)))
        }
        catch (error) {
            return createAbortResponse("grep content", error instanceof Error ? error.message : String(error))
        }
    }
}

function validateContentGrepArgs(args: ContentGrepArgs, allowDirectory: boolean): { ok: true; value: { regex: RegExp; path: string; include?: string; limit: number } } | { ok: false; response: string } {
    if (typeof args.pattern !== "string" || args.pattern.trim() === "") return { ok: false, response: createRetryResponse("grep content", "pattern must be a non-empty string.", "Retry with a regex pattern string.") }
    if (args.pattern.includes("\0")) return { ok: false, response: createRetryResponse("grep content", "pattern must not contain NUL bytes.", "Retry with a safe regex pattern.") }
    if (args.include !== undefined && (typeof args.include !== "string" || args.include.includes("\0"))) return { ok: false, response: createRetryResponse("grep content", "include must be a glob string without NUL bytes.", "Retry with a valid include glob or omit it.") }
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit <= 0)) return { ok: false, response: createRetryResponse("grep content", "limit must be a positive integer.", "Retry with a positive integer limit or omit it.") }
    if (!allowDirectory && (typeof args.path !== "string" || args.path.trim() === "")) return { ok: false, response: createRetryResponse("grep content", "path must be a non-empty remote content file path.", "Retry with a supported remote content file path.") }
    try {
        return { ok: true, value: { regex: new RegExp(args.pattern), path: args.path?.trim() || ".", include: args.include?.trim() || undefined, limit: Math.min(args.limit ?? 100, 1000) } }
    }
    catch (error) {
        return { ok: false, response: createRetryResponse("grep content", error instanceof Error ? error.message : String(error), "Retry with a valid JavaScript regex pattern.") }
    }
}

async function listLocalContentFiles(inputPath: string, include?: string, context?: ToolContext): Promise<ContentTarget[]> {
    if (inputPath.includes("\0")) throw new Error("path must not contain NUL bytes")
    const cwd = process.cwd()
    const absolute = path.resolve(cwd, inputPath)
    const relative = path.relative(cwd, absolute)
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        if (!context) throw new Error("path must stay inside the current working directory")
        const auth = await authorizeExternalContentPath(context, absolute, "grep content")
        if (!auth.ok) throw new Error(JSON.parse(auth.response).error as string)
    }
    const matcher = include ? globToRegExp(include) : undefined
    const entries: ContentTarget[] = []
    await walkLocal(absolute, async (filePath) => {
        const rel = path.relative(cwd, filePath).replaceAll(path.sep, "/")
        const mode = contentModeFromExtension(rel)
        if (mode && includeMatches(matcher, rel)) entries.push({ inputPath: rel, absolutePath: filePath, mode })
    })
    return entries.sort((left, right) => left.inputPath.localeCompare(right.inputPath))
}

async function walkLocal(filePath: string, visitor: (filePath: string) => Promise<void>): Promise<void> {
    const fileStat = await stat(filePath)
    if (fileStat.isFile()) return visitor(filePath)
    if (!fileStat.isDirectory()) return
    for (const entry of (await readdir(filePath)).sort()) {
        if (entry === ".git") continue
        await walkLocal(path.join(filePath, entry), visitor)
    }
}

async function collectContentGrep(files: ContentTarget[], regex: RegExp, limit: number, read: (target: ContentTarget) => Promise<string>): Promise<ContentLocation[]> {
    const results: ContentLocation[] = []
    for (const file of files) {
        const raw = await read(file).catch(() => undefined)
        if (raw === undefined) continue
        const matches = grepFile(file, raw, regex, Math.max(0, limit - results.reduce((sum, result) => sum + result.matches.length, 0)))
        if (matches.length > 0) results.push({ path: file.inputPath, matches, truncated: results.reduce((sum, result) => sum + result.matches.length, matches.length) >= limit })
        if (results.reduce((sum, result) => sum + result.matches.length, 0) >= limit) break
    }
    return results
}

function grepFile(target: ContentTarget, raw: string, regex: RegExp, limit: number): Array<Record<string, unknown>> {
    const ranges = sectionRanges(target.mode, raw)
    const found = new Map<string, Record<string, unknown>>()
    for (const match of lineMatches(raw, regex)) {
        const range = mostSpecificRange(ranges, match.offset) ?? ranges[0]
        const key = String(range?.section.path ?? range?.section.title ?? "$")
        if (range && !found.has(key)) found.set(key, { ...range.section, line: match.line, text: match.text })
        if (found.size >= limit) break
    }
    return [...found.values()]
}

function mostSpecificRange(ranges: SectionRange[], offset: number): SectionRange | undefined {
    let best: SectionRange | undefined
    for (const candidate of ranges) {
        if (offset < candidate.start || offset > candidate.end) continue
        if (best === undefined || candidate.end - candidate.start < best.end - best.start) best = candidate
    }
    return best
}

function sectionRanges(mode: ContentMode, raw: string): SectionRange[] {
    try {
        if (mode === "markdown") {
            const model = parseMarkdown(raw)
            const blockOffset = model.frontmatter.block.length
            return model.headings.map((heading) => ({ section: sectionInfo(heading), start: blockOffset + heading.start, end: blockOffset + heading.end }))
        }
        if (mode === "env") return parseEnvDocument(raw).assignments.map((assignment) => ({ section: envSectionInfo(assignment), start: assignment.lineStart, end: assignment.lineEnd }))
        if (mode === "ini") return parseIniDocument(raw).assignments.map((assignment) => ({ section: iniSectionInfo({ assignment, path: formatIniPath({ section: assignment.section, key: assignment.key }) }), start: assignment.lineStart, end: assignment.lineEnd }))
        if (mode === "toml") return parseTomlDocument(raw).assignments.map((assignment) => ({ section: tomlSectionInfo(parseTomlDocument(raw), { path: assignment.path, assignment }), start: assignment.lineStart, end: assignment.lineEnd }))
        if (mode === "json") return jsonRanges(raw)
        if (mode === "yaml") return [{ section: yamlSectionInfo(parseYamlDocument(raw), resolveYamlNode(parseYamlDocument(raw), [])!), start: 0, end: raw.length }]
        return []
    }
    catch {
        return []
    }
}

function jsonRanges(raw: string): SectionRange[] {
    const model = parseJsonDocument(raw)
    const ranges: SectionRange[] = []
    const visit = (pathValue: JsonPath): void => {
        const info = resolveJsonNode(model, pathValue)
        if (!info) return
        ranges.push({ section: jsonSectionInfo(model, info), start: info.node.offset, end: info.node.offset + info.node.length })
        for (const child of info.node.children ?? []) visit([...pathValue, info.node.type === "array" ? (info.node.children ?? []).indexOf(child) : String(child.children?.[0]?.value ?? "")])
    }
    visit([])
    return ranges.sort((left, right) => (right.start - left.start) || (left.end - right.end))
}

function lineMatches(raw: string, regex: RegExp): Array<{ offset: number; line: number; text: string }> {
    const matcher = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`)
    const matches: Array<{ offset: number; line: number; text: string }> = []
    let lineStart = 0
    let line = 1
    for (let index = 0; index <= raw.length; index += 1) {
        const atEnd = index === raw.length
        if (atEnd || raw[index] === "\n") {
            const lineText = raw.slice(lineStart, index).replace(/\r$/, "")
            matcher.lastIndex = 0
            const match = matcher.exec(lineText)
            if (match) matches.push({ offset: lineStart + match.index, line, text: lineText })
            if (atEnd) break
            lineStart = index + 1
            line += 1
        }
    }
    return matches
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

function includeMatches(include: RegExp | undefined, filePath: string): boolean {
    if (!include) return true
    const normalized = filePath.replaceAll("\\", "/")
    return include.test(normalized) || include.test(path.posix.basename(normalized))
}
