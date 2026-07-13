import { createRetryResponse } from "@/utils/tools"
import { jsonParser } from "./json"
import { yamlParser } from "./yaml"
import { iniParser } from "./ini"
import { tomlParser } from "./toml"
import { envParser } from "./env"
import type {
    ConfigAdapter,
    ConfigFormatParser,
    ConfigMode,
    ConfigNode,
    ReadOptions,
    ReadResult,
    RemoveOutcome,
    RetryResult,
    WriteOptions,
    WriteOutcome
} from "./types"

function getParser(mode: ConfigMode): ConfigFormatParser {
    switch (mode) {
        case "json": return jsonParser
        case "yaml": return yamlParser
        case "ini": return iniParser
        case "toml": return tomlParser
        case "env": return envParser
    }
}

function parseKeyPath(input: unknown): (string | number)[] | null {
    if (input === null) return null
    if (Array.isArray(input)) {
        for (const segment of input) {
            if (typeof segment !== "string" && typeof segment !== "number") return null
        }
        return input.slice()
    }
    if (typeof input === "string") {
        if (input === "") return []
        const out: (string | number)[] = []
        // Plain tokens or [N] numeric indices
        const re = /([^.[\]]+)|\[(\d+)\]/g
        let m: RegExpExecArray | null
        while ((m = re.exec(input)) !== null) {
            out.push(m[2] !== undefined ? Number(m[2]) : m[1])
        }
        return out
    }
    return null
}

function formatPath(path: (string | number)[]): string {
    let out = ""
    for (const segment of path) {
        if (typeof segment === "number") {
            out += `[${segment}]`
        } else if (out === "") {
            out = segment
        } else {
            out += `.${segment}`
        }
    }
    return out
}

function resolvePath(root: unknown, path: (string | number)[]): { found: boolean; value: unknown } {
    let cursor: unknown = root
    for (const segment of path) {
        if (Array.isArray(cursor)) {
            if (typeof segment !== "number" || segment < 0 || segment >= cursor.length) {
                return { found: false, value: undefined }
            }
            cursor = cursor[segment]
            continue
        }
        if (cursor !== null && typeof cursor === "object") {
            const obj = cursor as Record<string, unknown>
            const key = String(segment)
            if (!Object.prototype.hasOwnProperty.call(obj, key)) {
                return { found: false, value: undefined }
            }
            cursor = obj[key]
            continue
        }
        return { found: false, value: undefined }
    }
    return { found: true, value: cursor }
}

function pathExists(root: unknown, path: (string | number)[]): boolean {
    return resolvePath(root, path).found
}

function leafMatch(value: unknown): string {
    if (value === null || value === undefined) return "null"
    if (typeof value === "string") return value
    return String(value)
}

function renderConfigValue(value: unknown, maxValueChars: number): string | null {
    if (value === null || value === undefined) return null
    if (typeof value === "boolean") return String(value)
    if (typeof value === "number") return String(value)
    if (typeof value === "string") {
        if (value.length === 0) return "\"\""
        if (value.length <= maxValueChars) return value
        return value.slice(0, maxValueChars) + "..."
    }
    if (Array.isArray(value)) return `[${value.length} items]`
    if (typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).length} keys}`
    return null
}

function renderObjectMap(value: unknown): string | null | Record<string, string | null> {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>
        const result: Record<string, string | null> = {}
        for (const key of Object.keys(obj)) result[key] = renderConfigValue(obj[key], 60)
        return result
    }
    return renderConfigValue(value, 60)
}

function configRead(root: unknown, opts: ReadOptions): ReadResult {
    const all: ConfigNode[] = []
    const subkeyPattern = opts.subkeyPattern
    const valuePattern = opts.valuePattern

    function walk(value: unknown, path: (string | number)[], depth: number): void {
        const rendered = renderConfigValue(value, opts.maxValueChars)
        const isLeaf = value === null || value === undefined || typeof value !== "object"
        const passSub = !subkeyPattern || path.some((segment) => subkeyPattern.test(String(segment)))
        const passVal = !valuePattern || (isLeaf ? valuePattern.test(leafMatch(value)) : true)
        if (passSub && passVal) all.push({ path, value: rendered })
        if (depth >= opts.keyDepth || isLeaf) return
        if (Array.isArray(value)) {
            value.forEach((item, index) => walk(item, [...path, index], depth + 1))
            return
        }
        if (value !== null && typeof value === "object") {
            const obj = value as Record<string, unknown>
            for (const key of Object.keys(obj)) walk(obj[key], [...path, key], depth + 1)
        }
    }

    walk(root, [], 0)
    const total = all.length
    const truncated = total > opts.maxKeys
    const shown = truncated ? all.slice(0, opts.maxKeys) : all
    return { nodes: shown, truncated, nodesShown: shown.length, nodesTotal: total }
}

function parseContent(content: unknown): unknown {
    if (typeof content !== "string") return content
    try { return JSON.parse(content) } catch { return content }
}

function err(failedAction: string, msg: string, corrective: string): { ok: false; response: string } {
    return { ok: false, response: createRetryResponse(failedAction, new Error(msg), corrective) }
}

function setValueAt(root: unknown, path: (string | number)[], value: unknown): void {
    const parentPath = path.slice(0, -1)
    const last = path[path.length - 1]
    const parent = resolvePath(root, parentPath).value
    if (parent === undefined || parent === null) throw new Error("setValueAt: parent not found")
    if (Array.isArray(parent)) {
        if (typeof last !== "number") throw new Error("setValueAt: array index must be number")
        parent[last] = value
        return
    }
    if (typeof parent === "object") {
        const obj = parent as Record<string, unknown>
        obj[String(last)] = value
        return
    }
    throw new Error("setValueAt: parent is not a container")
}

function deleteAt(root: unknown, path: (string | number)[]): void {
    const parentPath = path.slice(0, -1)
    const last = path[path.length - 1]
    const parent = resolvePath(root, parentPath).value
    if (parent === undefined || parent === null) throw new Error("deleteAt: parent not found")
    if (Array.isArray(parent)) {
        if (typeof last !== "number") throw new Error("deleteAt: array index must be number")
        parent.splice(last, 1)
        return
    }
    if (typeof parent === "object") {
        const obj = parent as Record<string, unknown>
        delete obj[String(last)]
        return
    }
    throw new Error("deleteAt: parent is not a container")
}

function vivify(root: unknown, parentPath: (string | number)[]): unknown {
    let cursor: unknown = root
    for (const segment of parentPath) {
        if (cursor === null || typeof cursor !== "object") {
            throw new Error("cannot create path through scalar")
        }
        const isArray = Array.isArray(cursor)
        let exists: boolean
        if (isArray) {
            exists = typeof segment === "number" && segment >= 0 && segment < (cursor as unknown[]).length
        } else {
            exists = typeof segment === "string" && Object.prototype.hasOwnProperty.call(cursor as object, segment)
        }
        if (exists) {
            const record = cursor as Record<string | number, unknown>
            cursor = record[segment as string]
            if (cursor === null || typeof cursor !== "object") {
                throw new Error("cannot create path through scalar")
            }
            continue
        }
        const child: unknown = typeof segment === "number" ? [] : {}
        if (isArray) {
            ;(cursor as unknown[]).push(child as never)
        } else {
            ;(cursor as Record<string, unknown>)[String(segment)] = child
        }
        cursor = child
    }
    return cursor
}

function validateCreatable(root: unknown, path: (string | number)[]): { ok: boolean; error?: string } {
    const parentPath = path.slice(0, -1)
    let cursor: unknown = root
    for (const segment of parentPath) {
        if (cursor === null || typeof cursor !== "object") {
            return { ok: false, error: "cannot create key through existing scalar value" }
        }
        if (Array.isArray(cursor)) {
            if (typeof segment !== "number" || segment < 0 || segment >= cursor.length) {
                return { ok: true }
            }
            cursor = cursor[segment]
            continue
        }
        const obj = cursor as Record<string, unknown>
        if (!Object.prototype.hasOwnProperty.call(obj, segment)) {
            return { ok: true }
        }
        cursor = obj[String(segment)]
    }
    return { ok: true }
}

function insertAt(root: unknown, path: (string | number)[], value: unknown, newIndex: number | null): void {
    if (path.length === 0) throw new Error("cannot insert at root")
    const parentPath = path.slice(0, -1)
    const last = path[path.length - 1]
    const parent = vivify(root, parentPath)
    if (parent === null || parent === undefined) throw new Error("insertAt: parent not found")
    if (Array.isArray(parent)) {
        let position: number
        if (newIndex !== null) {
            position = newIndex === -1 ? parent.length : Math.max(0, Math.min(newIndex, parent.length))
        } else {
            position = parent.length
        }
        parent.splice(position, 0, value)
        return
    }
    if (typeof parent === "object") {
        const obj = parent as Record<string, unknown>
        obj[String(last)] = value
        return
    }
    throw new Error("insertAt: parent is not a container")
}

function renameInPlace(root: unknown, cur: (string | number)[], neu: (string | number)[], value: unknown, newIndex: number | null): void {
    const parentPath = cur.slice(0, -1)
    const oldLast = cur[cur.length - 1]
    const newLast = neu[neu.length - 1]
    const parent = resolvePath(root, parentPath).value
    if (parent === undefined || parent === null || typeof parent !== "object") {
        throw new Error("renameInPlace: parent not found")
    }
    if (Array.isArray(parent)) {
        const oldIndex = Number(oldLast)
        parent.splice(oldIndex, 1)
        let position: number
        if (newIndex !== null) {
            position = newIndex === -1 ? parent.length : Math.max(0, Math.min(newIndex, parent.length))
        } else {
            position = oldIndex
        }
        parent.splice(position, 0, value)
        return
    }
    const obj = parent as Record<string, unknown>
    const entries = Object.entries(obj)
    for (const key of Object.keys(obj)) delete obj[key]
    for (const [k, v] of entries) {
        if (k === String(oldLast)) {
            obj[String(newLast)] = value
        } else {
            obj[k] = v
        }
    }
}

function configEdit(root: unknown, opts: WriteOptions, failedAction: string): RetryResult<WriteOutcome> {
    const cur = opts.currentKey
    const neu = opts.newKey
    const content = opts.content
    const newIndex = opts.newIndex
    const resolveContent = (c: unknown) => opts.parseStringContent ? parseContent(c) : c

    if (cur === null && neu === null) {
        return err(failedAction, "must specify current_key and/or new_key", "Provide current_key and/or new_key.")
    }

    const curExists = cur !== null && pathExists(root, cur)
    const newExists = neu !== null && pathExists(root, neu)

    if (cur !== null && !curExists) {
        return err(failedAction, "current_key not found", "Use an existing current_key.")
    }

    if (cur !== null && neu === null) {
        if (content === undefined) {
            return err(failedAction, "content required to replace value", "Provide content.")
        }
        setValueAt(root, cur, resolveContent(content))
        return { ok: true, value: { value: root, action: "replace" } }
    }

    if (cur === null && neu !== null) {
        if (newExists) {
            return err(failedAction, "new_key already exists", "Use a unique new_key.")
        }
        if (content === undefined) {
            return err(failedAction, "content required to create value", "Provide content.")
        }
        const validation = validateCreatable(root, neu)
        if (!validation.ok) {
            return err(failedAction, validation.error ?? "cannot create path", validation.error ?? "Use a creatable path.")
        }
        insertAt(root, neu, resolveContent(content), newIndex)
        return { ok: true, value: { value: root, action: "create" } }
    }

    if (newExists) {
        return err(failedAction, "new_key already exists", "Use a unique new_key.")
    }
    const existing = resolvePath(root, cur as (string | number)[]).value
    const nextValue = content !== undefined ? resolveContent(content) : existing
    const validation = validateCreatable(root, neu as (string | number)[])
    if (!validation.ok) {
        return err(failedAction, validation.error ?? "cannot create path", validation.error ?? "Use a creatable path.")
    }
    const curParent = (cur as (string | number)[]).slice(0, -1)
    const neuParent = (neu as (string | number)[]).slice(0, -1)
    const sameParent = curParent.length === neuParent.length && curParent.every((segment, index) => segment === neuParent[index])
    if (sameParent) {
        renameInPlace(root, cur as (string | number)[], neu as (string | number)[], nextValue, newIndex)
    } else {
        deleteAt(root, cur as (string | number)[])
        insertAt(root, neu as (string | number)[], nextValue, newIndex)
    }
    return { ok: true, value: { value: root, action: "rename" } }
}

function configRemove(root: unknown, keyPath: (string | number)[], failedAction: string): RetryResult<RemoveOutcome> {
    if (keyPath.length === 0) {
        return err(failedAction, "cannot remove root key", "Target a non-root key.")
    }
    if (!pathExists(root, keyPath)) {
        return err(failedAction, "key_path not found", "Use an existing key_path.")
    }
    const parentPath = keyPath.slice(0, -1)
    deleteAt(root, keyPath)
    let parentNow: string | null | Record<string, string | null>
    if (parentPath.length === 0) {
        parentNow = renderObjectMap(root)
    } else {
        const parentNode = resolvePath(root, parentPath).value
        const lastParentKey = String(parentPath[parentPath.length - 1])
        parentNow = { [lastParentKey]: renderConfigValue(parentNode, 60) }
    }
    return { ok: true, value: { value: root, removed: keyPath, parentNow } }
}

async function configReadFlow(adapter: ConfigAdapter, args: any): Promise<string> {
    const failedAction = "Read configuration file"
    const target = await adapter.validateConfigPath(args.file_path)
    if (!target.ok) return target.response
    let raw: string
    try {
        raw = await adapter.read(target.value)
    } catch (error) {
        return createRetryResponse(failedAction, error, "Ensure the file exists and is readable.")
    }
    const parser = getParser(target.value.mode)
    let value: unknown
    try {
        value = parser.parse(raw)
    } catch (error) {
        return createRetryResponse(failedAction, error, "Fix the file syntax and retry.")
    }
    const keyPath = parseKeyPath(args.key_path)
    if (keyPath !== null) {
        const resolved = resolvePath(value, keyPath)
        if (!resolved.found) {
            return createRetryResponse(failedAction, new Error(`key_path not found: ${formatPath(keyPath)}`), "Check key_path.")
        }
        value = resolved.value
    }
    let subkeyPattern: RegExp | undefined
    let valuePattern: RegExp | undefined
    try {
        subkeyPattern = args.subkey_pattern ? new RegExp(args.subkey_pattern) : undefined
        valuePattern = args.value_pattern ? new RegExp(args.value_pattern) : undefined
    } catch (error) {
        return createRetryResponse(failedAction, error, "Fix the regex pattern.")
    }
    const result = configRead(value, {
        keyDepth: typeof args.key_depth === "number" ? args.key_depth : 100,
        subkeyPattern,
        valuePattern,
        maxKeys: typeof args.max_keys === "number" ? args.max_keys : 100,
        maxValueChars: typeof args.max_value_chars === "number" ? args.max_value_chars : 60
    })
    return JSON.stringify({
        file_path: args.file_path,
        key_path: args.key_path ?? null,
        truncated: result.truncated,
        nodes_shown: result.nodesShown,
        nodes_total: result.nodesTotal,
        nodes: result.nodes
    })
}

async function configEditFlow(adapter: ConfigAdapter, args: any): Promise<string> {
    const failedAction = "Write configuration file"
    const target = await adapter.validateConfigPath(args.file_path, failedAction)
    if (!target.ok) return target.response
    let raw: string
    try {
        raw = await adapter.read(target.value)
    } catch (error) {
        return createRetryResponse(failedAction, error, "Ensure the file exists and is readable.")
    }
    const parser = getParser(target.value.mode)
    let value: unknown
    try {
        value = parser.parse(raw)
    } catch (error) {
        return createRetryResponse(failedAction, error, "Fix the file syntax and retry.")
    }
    const currentKey = parseKeyPath(args.current_key)
    const newKey = parseKeyPath(args.new_key)
    const content = args.content !== undefined ? args.content : undefined
    const newIndex = typeof args.new_index === "number" ? args.new_index : null
    const result = configEdit(value, { currentKey, newKey, content, newIndex, parseStringContent: adapter.parseStringContent !== false }, failedAction)
    if (!result.ok) return result.response
    const newRaw = parser.stringify(result.value.value)
    await adapter.write(target.value, newRaw)
    return JSON.stringify({
        file_path: args.file_path,
        action: result.value.action,
        current_key: args.current_key ?? null,
        new_key: args.new_key ?? null
    })
}

async function configRemoveFlow(adapter: ConfigAdapter, args: any): Promise<string> {
    const failedAction = "Remove configuration key"
    const target = await adapter.validateConfigPath(args.file_path, failedAction)
    if (!target.ok) return target.response
    let raw: string
    try {
        raw = await adapter.read(target.value)
    } catch (error) {
        return createRetryResponse(failedAction, error, "Ensure the file exists and is readable.")
    }
    const parser = getParser(target.value.mode)
    let value: unknown
    try {
        value = parser.parse(raw)
    } catch (error) {
        return createRetryResponse(failedAction, error, "Fix the file syntax and retry.")
    }
    const keyPath = parseKeyPath(args.key_path)
    if (keyPath === null) {
        return createRetryResponse(failedAction, new Error("key_path required"), "Provide key_path.")
    }
    const result = configRemove(value, keyPath, failedAction)
    if (!result.ok) return result.response
    const newRaw = parser.stringify(result.value.value)
    await adapter.write(target.value, newRaw)
    return JSON.stringify({
        file_path: args.file_path,
        removed: result.value.removed,
        parent_now: result.value.parentNow
    })
}

export {
    configRead,
    configRemove,
    configEdit,
    configReadFlow,
    configRemoveFlow,
    configEditFlow,
    formatPath,
    getParser,
    parseKeyPath,
    pathExists,
    renderConfigValue,
    resolvePath
}

export type {
    ConfigNode,
    ReadOptions,
    ReadResult
}
