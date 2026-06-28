import { createRetryResponse } from "@/utils/tools"
import { detectNewline } from "./shared"
import type { ContentPosition, JsonPathElement, OptionalRetryResult, RetryResult, TomlAssignment, TomlModel, TomlNodeInfo, TomlPath, TomlTable } from "./types"

export const TOML_WRITE_SIZE_LIMIT = 256 * 1024

const TOML_TOC_NODE_LIMIT = 500

type ParsedLine = { text: string, number: number, lineStart: number, lineEnd: number, lineEndWithNewline: number }
type TocState = { count: number, truncated: boolean }
type TomlTreeNode = { title: string, path: TomlPath, level: number, children: TomlTreeNode[] }

export function parseTomlDocument(raw: string): TomlModel {
    const tables: TomlTable[] = []
    const assignments: TomlAssignment[] = []
    const arrayIndexes = new Map<string, number>()
    let currentPath: TomlPath = []
    for (const line of splitLines(raw)) {
        const header = parseTomlHeader(line, arrayIndexes)
        if (header !== undefined) {
            const table = { ...header, line: line.number, lineStart: line.lineStart, lineEnd: line.lineEnd, lineEndWithNewline: line.lineEndWithNewline, bodyStart: line.lineEndWithNewline, end: raw.length, endWithNewline: raw.length }
            currentPath = table.path
            tables.push(table)
            continue
        }
        const assignment = parseTomlAssignment(line, currentPath)
        if (assignment !== undefined) assignments.push(assignment)
    }
    setTableEnds(tables, raw.length)
    return { raw, newline: detectNewline(raw), tables, assignments }
}

export function parseTomlPath(input: unknown, name: string, allowOmitted: boolean, failedAction: string): OptionalRetryResult<TomlPath> {
    if (input === undefined && allowOmitted) return { ok: true }
    if (Array.isArray(input)) return parseTomlArrayPath(input, name, failedAction)
    if (typeof input !== "string" || input.trim() === "") return { ok: false, response: createRetryResponse(failedAction, `${name} must be a non-empty TOML path string or path array.`, `Retry with a valid ${name} path.`) }
    const path = parseTomlPathString(input)
    if (path === undefined || path.length === 0) return { ok: false, response: createRetryResponse(failedAction, `${name} is not a valid TOML path.`, `Retry with a valid ${name} path.`) }
    return { ok: true, value: path }
}

export function formatTomlPath(pathValue: TomlPath): string {
    let output = ""
    for (const part of pathValue) {
        if (typeof part === "number") output += `[${part}]`
        else output += `${output === "" || output.endsWith("]") ? "" : "."}${formatTomlKey(part)}`
    }
    return output
}

export function validateTomlWriteSize(model: TomlModel, failedAction: string): string | undefined {
    if (model.raw.length <= TOML_WRITE_SIZE_LIMIT) return undefined
    return createRetryResponse(failedAction, `TOML edit refused because file size ${model.raw.length} bytes exceeds safe line-edit threshold ${TOML_WRITE_SIZE_LIMIT} bytes.`, "Retry with a smaller file/target or make the edit manually.")
}

export function resolveTomlNode(model: TomlModel, pathValue: TomlPath, failedAction: string, missingName: string): RetryResult<TomlNodeInfo> {
    if (pathValue.length === 0) return { ok: true, value: { path: [] } }
    const assignment = findTomlAssignment(model, pathValue)
    if (assignment !== undefined) return { ok: true, value: { path: assignment.path, assignment } }
    const table = findTomlTable(model, pathValue)
    if (table !== undefined) return { ok: true, value: { path: table.path, table } }
    return { ok: false, response: createRetryResponse(failedAction, `${missingName} not found: ${formatTomlPath(pathValue)}`, "Retry with an existing TOML path.") }
}

export function tomlSectionInfo(model: TomlModel, info: TomlNodeInfo): Record<string, unknown> {
    const pathValue = formatTomlPath(info.path)
    return { title: info.path.length === 0 ? "$" : String(info.path[info.path.length - 1]), path: pathValue, level: info.path.length, header: info.table !== undefined ? tableHeader(info.table) : pathValue, line: info.table?.line ?? info.assignment?.line, children: tomlChildren(model, info.path) }
}

export function tomlNodeContent(model: TomlModel, info: TomlNodeInfo): string {
    if (info.assignment !== undefined) return model.raw.slice(info.assignment.valueStart, info.assignment.valueEnd)
    if (info.table !== undefined) return model.raw.slice(info.table.lineStart, info.table.end)
    return model.raw
}

export function buildTomlToc(model: TomlModel, rootPath: TomlPath | undefined, maxDepth: number | undefined): { toc: Record<string, unknown> | Array<Record<string, unknown>>, truncated: boolean } {
    const state: TocState = { count: 0, truncated: false }
    const roots = buildTomlTree(model)
    if (rootPath !== undefined) {
        const node = rootPath.length === 0 ? { title: "$", path: [], level: 0, children: roots } : findTreeNode(roots, rootPath)
        if (node === undefined) return { toc: [], truncated: false }
        return { toc: emitTocNode(node, maxDepth, 1, state), truncated: state.truncated }
    }
    return { toc: emitTocChildren(roots, maxDepth, 1, state), truncated: state.truncated }
}

export function writeTomlContent(model: TomlModel, sectionPath: TomlPath, content: string): RetryResult<string> {
    const sizeError = validateTomlWriteSize(model, "write toml content")
    if (sizeError) return { ok: false, response: sizeError }
    const target = resolveTomlNode(model, sectionPath, "resolve toml section", "Section")
    if (target.ok && target.value.assignment !== undefined) return { ok: true, value: replaceRange(model.raw, target.value.assignment.valueStart, target.value.assignment.valueEnd, content.trim()) }
    if (target.ok && target.value.table !== undefined) return { ok: true, value: replaceTomlTable(model, target.value.table, content) }
    return writeMissingTomlContent(model, sectionPath, content)
}

export function insertTomlContent(model: TomlModel, target: TomlNodeInfo, content: string, position: ContentPosition): RetryResult<string> {
    const sizeError = validateTomlWriteSize(model, "insert toml content")
    if (sizeError) return { ok: false, response: sizeError }
    const block = normalizeBlock(content, model.newline)
    const table = target.table
    if (table === undefined) {
        const insertAt = position !== undefined && position <= 0 ? 0 : model.raw.length
        return { ok: true, value: insertRaw(model.raw, insertAt, block, model.newline) }
    }
    const insertAt = position !== undefined && position <= 0 ? table.bodyStart : table.endWithNewline
    return { ok: true, value: insertRaw(model.raw, insertAt, block, model.newline) }
}

export function removeTomlContent(model: TomlModel, section: TomlNodeInfo): RetryResult<string> {
    const sizeError = validateTomlWriteSize(model, "remove toml content")
    if (sizeError) return { ok: false, response: sizeError }
    if (section.path.length === 0) return { ok: false, response: createRetryResponse("remove toml content", "Cannot remove the TOML document root.", "Remove a non-root path instead.") }
    if (section.assignment !== undefined) return { ok: true, value: `${model.raw.slice(0, section.assignment.lineStart)}${model.raw.slice(section.assignment.lineEndWithNewline)}` }
    if (section.table !== undefined) return { ok: true, value: `${model.raw.slice(0, section.table.lineStart)}${model.raw.slice(section.table.endWithNewline)}` }
    return { ok: false, response: createRetryResponse("remove toml content", "TOML path could not be safely removed.", "Retry with an assignment or table path.") }
}

export function moveTomlContent(model: TomlModel, section: TomlNodeInfo, target: TomlNodeInfo, position: ContentPosition): RetryResult<string> {
    const sizeError = validateTomlWriteSize(model, "move toml content")
    if (sizeError) return { ok: false, response: sizeError }
    if (section.path.length === 0) return { ok: false, response: createRetryResponse("move toml content", "Cannot move the TOML document root.", "Move a non-root path instead.") }
    if (samePath(section.path, target.path) || isDescendantPath(section.path, target.path)) return { ok: false, response: createRetryResponse("move toml content", "Cannot move a TOML path into itself or a descendant.", "Choose a target outside the moved subtree.") }
    const range = section.assignment !== undefined ? { start: section.assignment.lineStart, end: section.assignment.lineEndWithNewline } : section.table !== undefined ? { start: section.table.lineStart, end: section.table.endWithNewline } : undefined
    if (range === undefined) return { ok: false, response: createRetryResponse("move toml content", "TOML path could not be safely moved.", "Retry with an assignment or table path.") }
    const rawBlock = model.raw.slice(range.start, range.end)
    const removedRaw = `${model.raw.slice(0, range.start)}${model.raw.slice(range.end)}`
    const removedModel = parseTomlDocument(removedRaw)
    const adjustedTarget = resolveTomlNode(removedModel, target.path, "resolve toml target", "Target")
    if (!adjustedTarget.ok) return adjustedTarget
    return insertTomlContent(removedModel, adjustedTarget.value, rawBlock, position)
}

function parseTomlHeader(line: ParsedLine, arrayIndexes: Map<string, number>): Pick<TomlTable, "path" | "array"> | undefined {
    const trimmed = stripComment(line.text).trim()
    const array = trimmed.startsWith("[[") && trimmed.endsWith("]]")
    const normal = trimmed.startsWith("[") && trimmed.endsWith("]") && !array
    if (!array && !normal) return undefined
    const inner = array ? trimmed.slice(2, -2).trim() : trimmed.slice(1, -1).trim()
    const basePath = parseTomlPathString(inner)
    if (basePath === undefined || basePath.length === 0) return undefined
    if (!array) return { path: basePath, array: false }
    const key = formatTomlPath(basePath)
    const index = arrayIndexes.get(key) ?? 0
    arrayIndexes.set(key, index + 1)
    return { path: [...basePath, index], array: true }
}

function parseTomlAssignment(line: ParsedLine, currentPath: TomlPath): TomlAssignment | undefined {
    const equalIndex = findTopLevelChar(line.text, "=")
    if (equalIndex <= 0) return undefined
    const rawKey = line.text.slice(0, equalIndex).trim()
    const keyPath = parseTomlPathString(rawKey)
    if (keyPath === undefined || keyPath.length === 0) return undefined
    const valueSlice = line.text.slice(equalIndex + 1)
    const valueOffset = firstNonWhitespace(valueSlice)
    const comment = findInlineComment(valueSlice)
    const valueEndInSlice = trimEndIndex(valueSlice, comment ?? valueSlice.length)
    const keyStart = line.lineStart + line.text.indexOf(rawKey)
    return { path: [...currentPath, ...keyPath], line: line.number, lineStart: line.lineStart, lineEnd: line.lineEnd, lineEndWithNewline: line.lineEndWithNewline, keyStart, keyEnd: keyStart + rawKey.length, valueStart: line.lineStart + equalIndex + 1 + valueOffset, valueEnd: line.lineStart + equalIndex + 1 + valueEndInSlice }
}

function parseTomlPathString(input: string): TomlPath | undefined {
    const path: TomlPath = []
    let offset = 0
    while (offset < input.length) {
        if (input[offset] === ".") return undefined
        const parsed = input[offset] === '"' || input[offset] === "'" ? readQuotedKey(input, offset) : readBareKey(input, offset)
        if (parsed === undefined || parsed.key === "") return undefined
        path.push(parsed.key)
        offset = parsed.end
        while (input[offset] === "[") {
            const close = input.indexOf("]", offset + 1)
            if (close < 0) return undefined
            const indexText = input.slice(offset + 1, close)
            if (!/^\d+$/.test(indexText)) return undefined
            path.push(Number(indexText))
            offset = close + 1
        }
        if (offset === input.length) break
        if (input[offset] !== ".") return undefined
        offset += 1
    }
    return path
}

function parseTomlArrayPath(input: unknown[], name: string, failedAction: string): OptionalRetryResult<TomlPath> {
    if (input.length === 0) return { ok: false, response: createRetryResponse(failedAction, `${name} array path must not be empty.`, `Retry with a valid ${name} path array.`) }
    const path: TomlPath = []
    for (const part of input) {
        if (typeof part === "string" && part !== "") path.push(part)
        else if (typeof part === "number" && Number.isInteger(part) && part >= 0) path.push(part)
        else return { ok: false, response: createRetryResponse(failedAction, `${name} array path elements must be non-empty strings or non-negative integers.`, `Retry with a valid ${name} path array.`) }
    }
    return { ok: true, value: path }
}

function splitLines(raw: string): ParsedLine[] {
    const lines: ParsedLine[] = []
    let offset = 0
    let number = 1
    while (offset < raw.length) {
        const next = findLineEnd(raw, offset)
        lines.push({ text: raw.slice(offset, next.index), number, lineStart: offset, lineEnd: next.index, lineEndWithNewline: next.index + next.newlineLength })
        offset = next.index + next.newlineLength
        number += 1
    }
    return lines
}

function findLineEnd(raw: string, offset: number): { index: number, newlineLength: number } {
    const nextN = raw.indexOf("\n", offset)
    if (nextN < 0) return { index: raw.length, newlineLength: 0 }
    return { index: raw[nextN - 1] === "\r" ? nextN - 1 : nextN, newlineLength: raw[nextN - 1] === "\r" ? 2 : 1 }
}

function findTopLevelChar(value: string, char: string): number {
    let quote: string | undefined
    let bracketDepth = 0
    for (let index = 0; index < value.length; index += 1) {
        const current = value[index]
        if (quote !== undefined) {
            if (current === "\\") index += 1
            else if (current === quote) quote = undefined
        }
        else if (current === '"' || current === "'") quote = current
        else if (current === "[" || current === "{") bracketDepth += 1
        else if (current === "]" || current === "}") bracketDepth -= 1
        else if (current === char && bracketDepth === 0) return index
    }
    return -1
}

function findInlineComment(value: string): number | undefined {
    const index = findTopLevelChar(value, "#")
    return index >= 0 ? index : undefined
}

function stripComment(value: string): string {
    const index = findInlineComment(value)
    return index === undefined ? value : value.slice(0, index)
}

function firstNonWhitespace(value: string): number {
    const match = /\S/.exec(value)
    return match?.index ?? value.length
}

function trimEndIndex(value: string, end: number): number {
    let index = end
    while (index > 0 && /[ \t]/.test(value[index - 1] ?? "")) index -= 1
    return index
}

function readBareKey(value: string, offset: number): { key: string, end: number } | undefined {
    const match = /^[A-Za-z0-9_-]+/.exec(value.slice(offset))
    if (!match?.[0]) return undefined
    return { key: match[0], end: offset + match[0].length }
}

function readQuotedKey(value: string, offset: number): { key: string, end: number } | undefined {
    const quote = value[offset]
    let key = ""
    for (let index = offset + 1; index < value.length; index += 1) {
        const current = value[index]
        if (current === "\\") {
            key += value[index + 1] ?? ""
            index += 1
        }
        else if (current === quote) return { key, end: index + 1 }
        else key += current
    }
    return undefined
}

function formatTomlKey(key: string): string {
    return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
}

function findTomlAssignment(model: TomlModel, pathValue: TomlPath): TomlAssignment | undefined {
    return model.assignments.find((assignment) => samePath(assignment.path, pathValue))
}

function findTomlTable(model: TomlModel, pathValue: TomlPath): TomlTable | undefined {
    return model.tables.find((table) => samePath(table.path, pathValue))
}

function samePath(left: TomlPath, right: TomlPath): boolean {
    return left.length === right.length && left.every((part, index) => part === right[index])
}

function isDescendantPath(parent: TomlPath, child: TomlPath): boolean {
    return child.length > parent.length && parent.every((part, index) => part === child[index])
}

function setTableEnd(table: TomlTable, end: number, endWithNewline: number): void {
    table.end = end
    table.endWithNewline = endWithNewline
}

function setTableEnds(tables: TomlTable[], rawLength: number): void {
    for (let index = 0; index < tables.length; index += 1) {
        const table = tables[index]
        if (table === undefined) continue
        const next = tables.slice(index + 1).find((candidate) => !isDescendantPath(table.path, candidate.path))
        setTableEnd(table, next?.lineStart ?? rawLength, next?.lineStart ?? rawLength)
    }
}

function tableHeader(table: TomlTable): string {
    const path = table.array ? table.path.slice(0, -1) : table.path
    return table.array ? `[[${formatTomlPath(path)}]]` : `[${formatTomlPath(path)}]`
}

function tomlChildren(model: TomlModel, parentPath: TomlPath): Array<Record<string, unknown>> {
    const roots = buildTomlTree(model)
    const children = parentPath.length === 0 ? roots : findTreeNode(roots, parentPath)?.children ?? []
    return children.map((node) => emitTocNode(node, undefined, 1, { count: 0, truncated: false }))
}

function buildTomlTree(model: TomlModel): TomlTreeNode[] {
    const roots: TomlTreeNode[] = []
    for (const pathValue of [...model.tables.map((table) => table.path), ...model.assignments.map((assignment) => assignment.path)]) addTreePath(roots, pathValue)
    return roots
}

function addTreePath(roots: TomlTreeNode[], pathValue: TomlPath): void {
    let children = roots
    const currentPath: TomlPath = []
    for (const part of pathValue) {
        currentPath.push(part)
        const title = typeof part === "number" ? `[${part}]` : part
        let node = children.find((candidate) => samePath(candidate.path, currentPath))
        if (node === undefined) {
            node = { title, path: [...currentPath], level: currentPath.length, children: [] }
            children.push(node)
        }
        children = node.children
    }
}

function findTreeNode(nodes: TomlTreeNode[], pathValue: TomlPath): TomlTreeNode | undefined {
    for (const node of nodes) {
        if (samePath(node.path, pathValue)) return node
        const child = findTreeNode(node.children, pathValue)
        if (child !== undefined) return child
    }
    return undefined
}

function emitTocNode(node: TomlTreeNode, maxDepth: number | undefined, currentDepth: number, state: TocState): Record<string, unknown> {
    state.count += 1
    if (state.count > TOML_TOC_NODE_LIMIT) {
        state.truncated = true
        return { title: node.title, path: formatTomlPath(node.path), level: node.level, children: [] }
    }
    const children = state.truncated || (maxDepth !== undefined && currentDepth >= maxDepth) ? [] : emitTocChildren(node.children, maxDepth, currentDepth + 1, state)
    return { title: node.title, path: formatTomlPath(node.path), level: node.level, children }
}

function emitTocChildren(nodes: TomlTreeNode[], maxDepth: number | undefined, currentDepth: number, state: TocState): Array<Record<string, unknown>> {
    const children: Array<Record<string, unknown>> = []
    for (const child of nodes) {
        if (state.truncated || state.count >= TOML_TOC_NODE_LIMIT) {
            state.truncated = true
            break
        }
        children.push(emitTocNode(child, maxDepth, currentDepth, state))
    }
    return children
}

function replaceTomlTable(model: TomlModel, table: TomlTable, content: string): string {
    const normalized = normalizeBlock(content, model.newline)
    if (content.trimStart().startsWith("[")) return `${model.raw.slice(0, table.lineStart)}${normalized}${model.raw.slice(table.endWithNewline)}`
    return `${model.raw.slice(0, table.bodyStart)}${normalized}${model.raw.slice(table.end)}`
}

function writeMissingTomlContent(model: TomlModel, pathValue: TomlPath, content: string): RetryResult<string> {
    if (pathValue.length === 0) return { ok: false, response: createRetryResponse("write toml content", "Cannot safely rewrite the TOML document root.", "Target an assignment or table path.") }
    const parentPath = pathValue.slice(0, -1)
    const finalKey = pathValue[pathValue.length - 1]
    if (typeof finalKey !== "string") return { ok: false, response: createRetryResponse("write toml content", "Missing TOML assignment path must end with a string key.", "Retry with a path ending in a key name.") }
    const line = `${formatTomlKey(finalKey)} = ${content.trim()}${model.newline}`
    const parent = parentPath.length === 0 ? undefined : findTomlTable(model, parentPath)
    if (parentPath.length === 0) return { ok: true, value: insertRaw(model.raw, model.raw.length, line, model.newline) }
    if (parent !== undefined) return { ok: true, value: insertRaw(model.raw, parent.endWithNewline, line, model.newline) }
    const trimmed = content.trimStart()
    if (trimmed.startsWith("[")) return { ok: true, value: insertRaw(model.raw, model.raw.length, normalizeBlock(content, model.newline), model.newline) }
    if (content.split(/\r\n|\r|\n/).some((lineContent) => findTopLevelChar(lineContent, "=") > 0)) {
        return { ok: true, value: insertRaw(model.raw, model.raw.length, `[${formatTomlPath(pathValue)}]${model.newline}${normalizeBlock(content, model.newline)}`, model.newline) }
    }
    return { ok: false, response: createRetryResponse("write toml content", `Parent table not found: ${formatTomlPath(parentPath)}`, "Retry with an existing parent table or TOML table body content.") }
}

function replaceRange(raw: string, start: number, end: number, content: string): string {
    return `${raw.slice(0, start)}${content}${raw.slice(end)}`
}

function normalizeBlock(content: string, newline: string): string {
    const normalized = content.replace(/\r\n|\r|\n/g, newline)
    return normalized.endsWith(newline) ? normalized : `${normalized}${newline}`
}

function insertRaw(raw: string, index: number, block: string, newline: string): string {
    const prefix = index > 0 && !raw.slice(0, index).endsWith("\n") ? newline : ""
    return `${raw.slice(0, index)}${prefix}${block}${raw.slice(index)}`
}
