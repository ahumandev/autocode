import { applyEdits, modify, parse, parseTree, type FormattingOptions, type Node, type ParseError } from "jsonc-parser"
import { createRetryResponse } from "@/utils/tools"
import { detectNewline } from "./shared"
import type { ContentPosition, JsonModel, JsonNodeInfo, JsonPath, JsonPathElement, OptionalRetryResult, RetryResult } from "./types"

export function isSafeJsonPathKey(value: string): boolean {
    return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(value)
}

export function formatJsonPath(pathValue: JsonPath): string {
    return pathValue.map((part, index) => {
        if (typeof part === "number") return `[${part}]`
        const formatted = isSafeJsonPathKey(part) ? part : `[${JSON.stringify(part)}]`
        return index === 0 || formatted.startsWith("[") ? formatted : `.${formatted}`
    }).join("")
}

export function parseJsonPath(input: unknown, name: string, allowOmitted: boolean): OptionalRetryResult<JsonPath> {
    if (input === undefined && allowOmitted) return { ok: true }
    if (Array.isArray(input)) {
        const value: JsonPath = []
        for (const part of input) {
            if (typeof part === "string") value.push(part)
            else if (typeof part === "number" && Number.isInteger(part) && part >= 0) value.push(part)
            else return { ok: false, response: createRetryResponse("parse json path", `${name} array path elements must be strings or non-negative integers.`, "Retry with object keys and array indexes only.") }
        }
        return { ok: true, value }
    }
    if (typeof input !== "string" || input === "") return { ok: false, response: createRetryResponse("parse json path", `${name} must be a non-empty string or path array.`, "Retry with a JSON path like root.items[0] or an array path.") }
    const value = parseJsonPathString(input)
    return value ? { ok: true, value } : { ok: false, response: createRetryResponse("parse json path", `Malformed JSON path: ${input}`, "Use dots for keys, [n] for indexes, or quoted bracket keys.") }
}

export function parseJsonPathString(input: string): JsonPath | undefined {
    const result: JsonPath = []
    let index = 0
    while (index < input.length) {
        if (input[index] === ".") {
            index += 1
            if (index >= input.length || input[index] === ".") return undefined
            continue
        }
        if (input[index] === "[") {
            const close = findPathBracket(input, index)
            if (close === undefined) return undefined
            const token = input.slice(index + 1, close)
            const part = parseBracketPathPart(token)
            if (part === undefined) return undefined
            result.push(part)
            index = close + 1
            continue
        }
        const start = index
        while (index < input.length && input[index] !== "." && input[index] !== "[") index += 1
        if (start === index) return undefined
        result.push(input.slice(start, index))
    }
    return result
}

export function parseJsonDocument(raw: string): JsonModel {
    const errors: ParseError[] = []
    const root = parseTree(raw, errors, { allowTrailingComma: true, disallowComments: false })
    if (!root || errors.length > 0) throw new Error("Invalid JSON/JSONC document.")
    const value = parse(raw, errors, { allowTrailingComma: true, disallowComments: false })
    if (errors.length > 0) throw new Error("Invalid JSON/JSONC document.")
    return { raw, root, value, newline: detectNewline(raw) }
}

export function parseJsonFragment(input: unknown, failedAction: string, nonEmpty: boolean): RetryResult<{ value: unknown, node: Node }> {
    if (typeof input !== "string" || (nonEmpty && input === "")) return { ok: false, response: createRetryResponse(failedAction, `content must be a ${nonEmpty ? "non-empty " : ""}string.`, "Retry with JSON/JSONC content as a string.") }
    const errors: ParseError[] = []
    const node = parseTree(input, errors, { allowTrailingComma: true, disallowComments: false })
    const value = parse(input, errors, { allowTrailingComma: true, disallowComments: false })
    if (!node || errors.length > 0) return { ok: false, response: createRetryResponse(failedAction, "content must parse as a single JSON/JSONC value.", "Retry with valid JSON/JSONC content.") }
    return { ok: true, value: { value, node } }
}

export function resolveJsonNode(model: JsonModel, pathValue: JsonPath): JsonNodeInfo | undefined {
    let current = model.root
    let currentPath: JsonPath = []
    let parent: Node | undefined
    let property: Node | undefined
    for (const part of pathValue) {
        if (typeof part === "string" && current.type === "object") {
            property = current.children?.find((child) => child.children?.[0]?.value === part)
            const next = property?.children?.[1]
            if (!next) return undefined
            parent = current
            current = next
        }
        else if (typeof part === "number" && current.type === "array") {
            const next = current.children?.[part]
            if (!next) return undefined
            parent = current
            property = undefined
            current = next
        }
        else return undefined
        currentPath = [...currentPath, part]
    }
    return { node: current, path: currentPath, parent, property }
}

export function jsonChildNodes(model: JsonModel, info: JsonNodeInfo): Array<Record<string, unknown>> {
    if (info.node.type === "object") {
        return (info.node.children ?? []).map((propertyNode) => {
            const key = String(propertyNode.children?.[0]?.value ?? "")
            return jsonTocNode(model, propertyNode.children?.[1] ?? propertyNode, [...info.path, key], undefined, key)
        })
    }
    if (info.node.type === "array") return (info.node.children ?? []).map((child, index) => jsonTocNode(model, child, [...info.path, index], undefined, `[${index}]`))
    return []
}

export function buildJsonTocNode(model: JsonModel, node: Node, nodePath: JsonPath, maxDepth: number | undefined, title: string | undefined, currentDepth: number): Record<string, unknown> {
    const info: JsonNodeInfo = { node, path: nodePath }
    const children = jsonChildNodes(model, info).map((child) => {
        const childPath = parseJsonPathString(String(child.path)) ?? []
        const childInfo = resolveJsonNode(model, childPath)
        return childInfo ? buildJsonTocNode(model, childInfo.node, childPath, maxDepth, String(child.title), currentDepth + 1) : child
    }).filter(() => maxDepth === undefined || currentDepth < maxDepth)
    return { title: title ?? (nodePath.length === 0 ? "$" : String(nodePath[nodePath.length - 1])), path: formatJsonPath(nodePath), level: nodePath.length, children }
}

export function jsonSectionInfo(model: JsonModel, info: JsonNodeInfo): Record<string, unknown> {
    const pathValue = formatJsonPath(info.path)
    return {
        title: info.path.length === 0 ? "$" : String(info.path[info.path.length - 1]),
        path: pathValue,
        level: info.path.length,
        header: pathValue === "" ? "$" : pathValue,
        parent: info.path.length === 0 ? undefined : formatJsonPath(info.path.slice(0, -1)),
        children: jsonChildNodes(model, info),
    }
}

export function applyJsonModify(model: JsonModel, pathValue: JsonPath, value: unknown, isArrayInsertion = false, insertionIndex?: number): string {
    const edits = modify(model.raw, pathValue, value, { formattingOptions: jsonFormatting(model), isArrayInsertion, getInsertionIndex: insertionIndex === undefined ? undefined : () => insertionIndex })
    return applyEdits(model.raw, edits)
}

export function insertJsonContent(model: JsonModel, target: JsonNodeInfo, fragment: { value: unknown, node: Node }, position: ContentPosition): RetryResult<string> {
    if (target.node.type === "object") return insertJsonObjectProperties(model, target.node, target.path, fragment, position)
    if (target.node.type === "array") {
        const index = position === undefined ? -1 : position
        return { ok: true, value: applyJsonModify(model, [...target.path, index], fragment.value, true) }
    }
    if (target.parent?.type === "object") return insertJsonObjectProperties(model, target.parent, target.path.slice(0, -1), fragment, position)
    if (target.parent?.type === "array") {
        const index = position === undefined ? -1 : position
        return { ok: true, value: applyJsonModify(model, [...target.path.slice(0, -1), index], fragment.value, true) }
    }
    return { ok: false, response: createRetryResponse("insert json content", "Target must be an object or array.", "Retry with an object or array target.") }
}

export function moveJsonContent(model: JsonModel, section: JsonNodeInfo, target: JsonNodeInfo, position: ContentPosition): RetryResult<string> {
    if (section.path.length === 0) return { ok: false, response: createRetryResponse("move json content", "Cannot move the JSON document root.", "Move a non-root node instead.") }
    if (formatJsonPath(section.path) === formatJsonPath(target.path) || isDescendantPath(section.path, target.path)) return { ok: false, response: createRetryResponse("move json content", "Cannot move a node into itself or a descendant.", "Choose a target outside the moved subtree.") }
    const value = parse(model.raw.slice(section.node.offset, section.node.offset + section.node.length), [], { allowTrailingComma: true, disallowComments: false })
    const key = typeof section.path[section.path.length - 1] === "string" ? String(section.path[section.path.length - 1]) : undefined
    const duplicate = jsonMoveDuplicate(target, key)
    if (duplicate) return { ok: false, response: createRetryResponse("move json content", `Duplicate object key: ${duplicate}`, "Choose a target object without that key.") }
    const removedRaw = applyJsonModify(model, section.path, undefined)
    const removedModel = parseJsonDocument(removedRaw)
    const adjustedTarget = resolveJsonNode(removedModel, adjustPathAfterRemoval(target.path, section.path))
    if (!adjustedTarget) return { ok: false, response: createRetryResponse("move json content", "Target changed while moving content.", "Retry the move with current JSON paths.") }
    if (adjustedTarget.node.type === "object" && key !== undefined) return { ok: true, value: applyJsonModify(removedModel, [...adjustedTarget.path, key], value, false, position) }
    if (adjustedTarget.node.type === "array") {
        const index = position === undefined ? -1 : position
        return { ok: true, value: applyJsonModify(removedModel, [...adjustedTarget.path, index], value, true) }
    }
    return { ok: false, response: createRetryResponse("move json content", "Target must be an object or array.", "Retry with an object or array target.") }
}

function findPathBracket(input: string, start: number): number | undefined {
    let quoted = false
    let escaped = false
    for (let index = start + 1; index < input.length; index += 1) {
        const char = input[index]
        if (escaped) {
            escaped = false
            continue
        }
        if (char === "\\" && quoted) {
            escaped = true
            continue
        }
        if (char === '"') quoted = !quoted
        if (char === "]" && !quoted) return index
    }
    return undefined
}

function parseBracketPathPart(token: string): JsonPathElement | undefined {
    if (/^\d+$/.test(token)) return Number(token)
    if (!token.startsWith('"')) return undefined
    const errors: ParseError[] = []
    const value = parse(token, errors, { allowTrailingComma: false, disallowComments: true })
    return errors.length === 0 && typeof value === "string" ? value : undefined
}

function jsonTocNode(model: JsonModel, node: Node, nodePath: JsonPath, maxDepth: number | undefined, title?: string, currentDepth = 1): Record<string, unknown> {
    const childInfo: JsonNodeInfo = { node, path: nodePath }
    const children = maxDepth !== undefined && currentDepth >= maxDepth ? [] : jsonChildNodes(model, childInfo).map((child) => child)
    if (maxDepth !== undefined && currentDepth < maxDepth) return buildJsonTocNode(model, node, nodePath, maxDepth, title, currentDepth)
    return { title: title ?? (nodePath.length === 0 ? "$" : String(nodePath[nodePath.length - 1])), path: formatJsonPath(nodePath), level: nodePath.length, children }
}

function jsonFormatting(model: JsonModel): FormattingOptions {
    return { insertSpaces: true, tabSize: 2, eol: model.newline }
}

function jsonObjectEntries(fragment: { value: unknown, node: Node }): Array<{ key: string, value: unknown }> | undefined {
    if (fragment.node.type !== "object" || typeof fragment.value !== "object" || fragment.value === null || Array.isArray(fragment.value)) return undefined
    const value = fragment.value as Record<string, unknown>
    return (fragment.node.children ?? []).map((propertyNode) => String(propertyNode.children?.[0]?.value ?? "")).map((key) => ({ key, value: value[key] }))
}

function jsonObjectKeys(node: Node): string[] {
    if (node.type !== "object") return []
    return (node.children ?? []).map((propertyNode) => String(propertyNode.children?.[0]?.value ?? ""))
}

function hasDuplicateKey(target: Node, keys: string[], exceptKey?: string): string | undefined {
    const existing = new Set(jsonObjectKeys(target).filter((key) => key !== exceptKey))
    return keys.find((key) => existing.has(key))
}

function isDescendantPath(parent: JsonPath, child: JsonPath): boolean {
    return child.length > parent.length && parent.every((part, index) => part === child[index])
}

function insertJsonObjectProperties(model: JsonModel, objectNode: Node, objectPath: JsonPath, fragment: { value: unknown, node: Node }, insertionIndex?: number): RetryResult<string> {
    const entries = jsonObjectEntries(fragment)
    if (!entries) return { ok: false, response: createRetryResponse("insert json content", "Object target inserts require content to parse as a JSON object.", "Retry with JSON object content.") }
    const duplicate = hasDuplicateKey(objectNode, entries.map((entry) => entry.key))
    if (duplicate) return { ok: false, response: createRetryResponse("insert json content", `Duplicate object key: ${duplicate}`, "Retry with unique property keys.") }
    let raw = model.raw
    let index = insertionIndex
    for (const entry of entries) {
        const currentModel = parseJsonDocument(raw)
        raw = applyJsonModify(currentModel, [...objectPath, entry.key], entry.value, false, index)
        if (index !== undefined) index += 1
    }
    return { ok: true, value: raw }
}

function jsonMoveDuplicate(target: JsonNodeInfo, key: string | undefined): string | undefined {
    if (key === undefined) return undefined
    if (target.node.type !== "object") return undefined
    return hasDuplicateKey(target.node, [key], undefined)
}

function adjustPathAfterRemoval(target: JsonPath, removed: JsonPath): JsonPath {
    if (target.length !== removed.length || target.length === 0) return target
    const targetLast = target[target.length - 1]
    const removedLast = removed[removed.length - 1]
    const sameArrayParent = typeof targetLast === "number" && typeof removedLast === "number" && target.slice(0, -1).every((part, index) => part === removed[index])
    return sameArrayParent && targetLast > removedLast ? [...target.slice(0, -1), targetLast - 1] : target
}
