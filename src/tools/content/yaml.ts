import { createRetryResponse } from "@/utils/tools"
import { detectNewline } from "./shared"
import { formatJsonPath, parseJsonPath, parseJsonPathString } from "./json"
import type { ContentPosition, JsonPath, JsonPathElement, OptionalRetryResult, RetryResult, YamlModel, YamlNodeInfo } from "./types"
import { isMap, isSeq, parseDocument } from "yaml"
import type { Pair, ParsedNode, Scalar, YAMLMap, YAMLSeq } from "yaml"

export const YAML_WRITE_SIZE_LIMIT = 256 * 1024

export function parseYamlPath(input: unknown, name: string, allowOmitted: boolean): OptionalRetryResult<JsonPath> {
    return parseJsonPath(input, name, allowOmitted)
}

export function formatYamlPath(pathValue: JsonPath): string {
    return formatJsonPath(pathValue)
}

export function parseYamlDocument(raw: string): YamlModel {
    const document = parseDocument(raw, { keepSourceTokens: true })
    if (document.errors.length > 0) throw new Error(document.errors.map((error) => error.message).join("; "))
    if (!document.contents) throw new Error("YAML document is empty.")
    return { raw, document, newline: detectNewline(raw) }
}

export function parseYamlFragment(input: unknown, failedAction: string, nonEmpty: boolean): RetryResult<ParsedNode> {
    if (typeof input !== "string" || (nonEmpty && input === "")) return { ok: false, response: createRetryResponse(failedAction, `content must be a ${nonEmpty ? "non-empty " : ""}string.`, "Retry with YAML content as a string.") }
    const document = parseDocument(input, { keepSourceTokens: true })
    if (document.errors.length > 0 || !document.contents) return { ok: false, response: createRetryResponse(failedAction, "content must parse as a single YAML value.", "Retry with valid YAML content.") }
    return { ok: true, value: document.contents }
}

export function validateYamlWriteSize(model: YamlModel, failedAction: string): string | undefined {
    if (model.raw.length <= YAML_WRITE_SIZE_LIMIT) return undefined
    return createRetryResponse(failedAction, `YAML write refused because file size ${model.raw.length} bytes exceeds safe rewrite threshold ${YAML_WRITE_SIZE_LIMIT} bytes.`, "Retry on a smaller YAML file or edit manually.")
}

export function resolveYamlNode(model: YamlModel, pathValue: JsonPath): YamlNodeInfo | undefined {
    const root = model.document.contents
    if (!root) return undefined
    let current: ParsedNode = root
    let parent: ParsedNode | undefined
    let pair: Pair | undefined
    const currentPath: JsonPath = []
    for (const part of pathValue) {
        if (isParsedMap(current)) {
            const nextPair = findMapPair(current, part)
            const next: ParsedNode | undefined = nodeFromPair(nextPair)
            if (!nextPair || !next) return undefined
            parent = current
            pair = nextPair
            current = next
        }
        else if (isParsedSeq(current)) {
            const index = sequenceIndex(part)
            const next: ParsedNode | undefined = index === undefined ? undefined : current.items[index]
            if (!next) return undefined
            parent = current
            pair = undefined
            current = next
        }
        else return undefined
        currentPath.push(part)
    }
    return { node: current, path: currentPath, parent, pair }
}

export function yamlSectionInfo(model: YamlModel, info: YamlNodeInfo): Record<string, unknown> {
    const pathValue = formatYamlPath(info.path)
    return {
        title: info.path.length === 0 ? "$" : String(info.path[info.path.length - 1]),
        path: pathValue,
        level: info.path.length,
        header: pathValue === "" ? "$" : pathValue,
        parent: info.path.length === 0 ? undefined : formatYamlPath(info.path.slice(0, -1)),
        children: yamlChildNodes(model, info),
    }
}

export function yamlNodeContent(model: YamlModel, node: ParsedNode): string {
    const range = node.range
    if (range && range[0] >= 0 && range[1] >= range[0]) return model.raw.slice(range[0], range[1])
    return String(node)
}

export function buildYamlTocNode(model: YamlModel, node: ParsedNode, nodePath: JsonPath, maxDepth: number | undefined, title: string | undefined, currentDepth: number): { node: Record<string, unknown>, truncated: boolean } {
    const state: YamlTocState = { count: 0, truncated: false }
    return { node: yamlTocNode(model, node, nodePath, maxDepth, title, currentDepth, state), truncated: state.truncated }
}

export function writeYamlNode(model: YamlModel, pathValue: JsonPath, fragment: ParsedNode): RetryResult<string> {
    const section = resolveYamlNode(model, pathValue)
    if (!section) return { ok: false, response: createRetryResponse("resolve yaml section", `Section not found: ${formatYamlPath(pathValue)}`, "Retry with an existing YAML path.") }
    if (section.path.length === 0) model.document.contents = cloneYamlNode(fragment)
    else if (section.pair) section.pair.value = cloneYamlNode(fragment)
    else if (isParsedSeq(section.parent)) {
        const index = sequenceIndex(section.path[section.path.length - 1])
        if (index === undefined) return { ok: false, response: createRetryResponse("write yaml content", "Sequence path element must be a number or numeric string.", "Retry with a valid YAML sequence index.") }
        section.parent.items[index] = cloneYamlNode(fragment)
    }
    return stringifyYaml(model)
}

export function insertYamlContent(model: YamlModel, target: YamlNodeInfo, fragment: ParsedNode, position: ContentPosition): RetryResult<string> {
    if (isParsedMap(target.node)) return insertYamlMapPairs(model, target.node, fragment, position, "insert yaml content")
    if (isParsedSeq(target.node)) {
        target.node.items.splice(position ?? target.node.items.length, 0, cloneYamlNode(fragment))
        return stringifyYaml(model)
    }
    return { ok: false, response: createRetryResponse("insert yaml content", "Target must be a map or sequence.", "Retry with a map or sequence target.") }
}

export function removeYamlContent(model: YamlModel, section: YamlNodeInfo): RetryResult<string> {
    if (section.path.length === 0) return { ok: false, response: createRetryResponse("remove yaml content", "Cannot remove the YAML document root.", "Remove a non-root node instead.") }
    if (isParsedMap(section.parent) && section.pair) section.parent.items = section.parent.items.filter((item) => item !== section.pair)
    else if (isParsedSeq(section.parent)) {
        const index = sequenceIndex(section.path[section.path.length - 1])
        if (index === undefined) return { ok: false, response: createRetryResponse("remove yaml content", "Sequence path element must be a number or numeric string.", "Retry with a valid YAML sequence index.") }
        section.parent.items.splice(index, 1)
    }
    return stringifyYaml(model)
}

export function moveYamlContent(model: YamlModel, section: YamlNodeInfo, target: YamlNodeInfo, position: ContentPosition): RetryResult<string> {
    if (section.path.length === 0) return { ok: false, response: createRetryResponse("move yaml content", "Cannot move the YAML document root.", "Move a non-root node instead.") }
    if (formatYamlPath(section.path) === formatYamlPath(target.path) || isDescendantPath(section.path, target.path)) return { ok: false, response: createRetryResponse("move yaml content", "Cannot move a node into itself or a descendant.", "Choose a target outside the moved subtree.") }
    const movedKey = typeof section.path[section.path.length - 1] === "string" ? String(section.path[section.path.length - 1]) : undefined
    const movedNode = cloneYamlNode(section.node)
    const removed = removeYamlContent(model, section)
    if (!removed.ok) return removed
    const removedModel = parseYamlDocument(removed.value)
    const adjustedTarget = resolveYamlNode(removedModel, adjustPathAfterRemoval(target.path, section.path))
    if (!adjustedTarget) return { ok: false, response: createRetryResponse("move yaml content", "Target changed while moving content.", "Retry the move with current YAML paths.") }
    const fragment = movedKey === undefined ? movedNode : yamlMapFromPair(removedModel, movedKey, movedNode)
    return insertYamlContent(removedModel, adjustedTarget, fragment, position)
}

function yamlChildNodes(model: YamlModel, info: YamlNodeInfo): Array<Record<string, unknown>> {
    if (isParsedMap(info.node)) {
        return info.node.items.flatMap((pair) => {
            const value = nodeFromPair(pair)
            const key = keyString(pair.key)
            return value && isCollection(value) ? [yamlTocNode(model, value, [...info.path, key], undefined, key, info.path.length + 1, { count: 0, truncated: false })] : []
        })
    }
    if (isParsedSeq(info.node)) return info.node.items.flatMap((child, index) => child && isCollection(child) ? [yamlTocNode(model, child, [...info.path, index], undefined, `[${index}]`, info.path.length + 1, { count: 0, truncated: false })] : [])
    return []
}

type YamlTocState = { count: number, truncated: boolean }

const YAML_TOC_NODE_LIMIT = 500

function yamlTocNode(model: YamlModel, node: ParsedNode, nodePath: JsonPath, maxDepth: number | undefined, title: string | undefined, currentDepth: number, state: YamlTocState): Record<string, unknown> {
    state.count += 1
    if (state.count > YAML_TOC_NODE_LIMIT) {
        state.truncated = true
        return { title: title ?? (nodePath.length === 0 ? "$" : String(nodePath[nodePath.length - 1])), path: formatYamlPath(nodePath), level: nodePath.length, children: [] }
    }
    const children = maxDepth !== undefined && currentDepth >= maxDepth ? [] : collectionChildren(model, node, nodePath, maxDepth, currentDepth, state)
    return { title: title ?? (nodePath.length === 0 ? "$" : String(nodePath[nodePath.length - 1])), path: formatYamlPath(nodePath), level: nodePath.length, children }
}

function collectionChildren(model: YamlModel, node: ParsedNode, maxPath: JsonPath, maxDepth: number | undefined, currentDepth: number, state: YamlTocState): Array<Record<string, unknown>> {
    if (state.truncated || (maxDepth !== undefined && currentDepth >= maxDepth)) return []
    if (isParsedMap(node)) {
        return node.items.flatMap((pair) => {
            const value = nodeFromPair(pair)
            const key = keyString(pair.key)
            return value && isCollection(value) ? [yamlTocNode(model, value, [...maxPath, key], maxDepth, key, currentDepth + 1, state)] : []
        })
    }
    if (isParsedSeq(node)) return node.items.flatMap((child, index) => child && isCollection(child) ? [yamlTocNode(model, child, [...maxPath, index], maxDepth, `[${index}]`, currentDepth + 1, state)] : [])
    return []
}

function findMapPair(map: YAMLMap.Parsed, part: JsonPathElement): Pair | undefined {
    const key = String(part)
    return map.items.find((pair) => keyString(pair.key) === key)
}

function keyString(key: unknown): string {
    const scalar = key as Scalar | undefined
    return scalar && "value" in scalar ? String(scalar.value) : String(key)
}

function nodeFromPair(pair: Pair | undefined): ParsedNode | undefined {
    return pair?.value && typeof pair.value === "object" ? pair.value as ParsedNode : undefined
}

function sequenceIndex(part: JsonPathElement): number | undefined {
    if (typeof part === "number") return part
    return /^\d+$/.test(part) ? Number(part) : undefined
}

function isCollection(node: ParsedNode): boolean {
    return isParsedMap(node) || isParsedSeq(node)
}

function isParsedMap(node: ParsedNode | null | undefined): node is YAMLMap.Parsed {
    return isMap(node)
}

function isParsedSeq(node: ParsedNode | null | undefined): node is YAMLSeq.Parsed {
    return isSeq(node)
}

function cloneYamlNode(node: ParsedNode): ParsedNode {
    return node
}

function stringifyYaml(model: YamlModel): RetryResult<string> {
    const raw = model.document.toString({ lineWidth: 0 })
    parseYamlDocument(raw)
    return { ok: true, value: model.newline === "\r\n" ? raw.replace(/\n/g, "\r\n") : raw }
}

function insertYamlMapPairs(model: YamlModel, map: YAMLMap.Parsed, fragment: ParsedNode, insertionIndex: number | undefined, failedAction: string): RetryResult<string> {
    if (!isParsedMap(fragment)) return { ok: false, response: createRetryResponse(failedAction, "Map target inserts require content to parse as a YAML map.", "Retry with YAML map content.") }
    const existing = new Set(map.items.map((pair) => keyString(pair.key)))
    const duplicate = fragment.items.map((pair) => keyString(pair.key)).find((key) => existing.has(key))
    if (duplicate) return { ok: false, response: createRetryResponse(failedAction, `Duplicate map key: ${duplicate}`, "Retry with unique map keys.") }
    const pairs = fragment.items.map((pair) => pair)
    map.items.splice(insertionIndex ?? map.items.length, 0, ...pairs)
    return stringifyYaml(model)
}

function yamlMapFromPair(model: YamlModel, key: string, value: ParsedNode): YAMLMap.Parsed {
    const map = model.document.createNode({ [key]: null }) as YAMLMap.Parsed
    const pair = map.items[0]
    if (pair !== undefined) pair.value = value
    return map
}

function isDescendantPath(parent: JsonPath, child: JsonPath): boolean {
    return child.length > parent.length && parent.every((part, index) => part === child[index])
}

function adjustPathAfterRemoval(target: JsonPath, removed: JsonPath): JsonPath {
    if (target.length !== removed.length || target.length === 0) return target
    const targetLast = sequenceIndex(target[target.length - 1])
    const removedLast = sequenceIndex(removed[removed.length - 1])
    const sameArrayParent = targetLast !== undefined && removedLast !== undefined && target.slice(0, -1).every((part, index) => part === removed[index])
    return sameArrayParent && targetLast > removedLast ? [...target.slice(0, -1), targetLast - 1] : target
}

export { parseJsonPathString as parseYamlPathString }
