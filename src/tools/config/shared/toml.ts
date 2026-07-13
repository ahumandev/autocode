import type { ConfigFormatParser } from "./types"

type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue }
type TomlObject = { [key: string]: TomlValue }

function isTomlObject(value: TomlValue): value is TomlObject {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function unescapeDoubleQuoted(input: string): string {
    let out = ""
    for (let i = 0; i < input.length; i++) {
        const ch = input[i]
        if (ch === "\\" && i + 1 < input.length) {
            const next = input[i + 1]
            if (next === "n") out += "\n"
            else if (next === "t") out += "\t"
            else if (next === '"') out += '"'
            else if (next === "\\") out += "\\"
            else out += next
            i += 1
        } else {
            out += ch
        }
    }
    return out
}

function parseScalarToken(token: string): TomlValue {
    const t = token.trim()
    if (t === "true") return true
    if (t === "false") return false
    if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
        return unescapeDoubleQuoted(t.slice(1, -1))
    }
    if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") {
        return t.slice(1, -1)
    }
    if (/^[+-]?\d+$/.test(t)) return Number.parseInt(t, 10)
    if (/^[+-]?(\d+\.\d*|\d*\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number.parseFloat(t)
    if (/^[+-]?\d+[eE][+-]?\d+$/.test(t)) return Number.parseFloat(t)
    return t
}

function splitTopLevel(input: string, separator: string): string[] {
    const parts: string[] = []
    let cur = ""
    let quote: string | undefined
    let depth = 0
    for (let i = 0; i < input.length; i++) {
        const ch = input[i]
        if (quote !== undefined) {
            cur += ch
            if (ch === "\\" && quote === '"') {
                cur += input[i + 1] ?? ""
                i += 1
                continue
            }
            if (ch === quote) quote = undefined
            continue
        }
        if (ch === '"' || ch === "'") {
            quote = ch
            cur += ch
            continue
        }
        if (ch === "[") {
            depth += 1
            cur += ch
            continue
        }
        if (ch === "]") {
            depth -= 1
            cur += ch
            continue
        }
        if (ch === separator && depth === 0) {
            parts.push(cur)
            cur = ""
            continue
        }
        cur += ch
    }
    parts.push(cur)
    return parts
}

function parseArrayValue(token: string): TomlValue[] {
    const inner = token.trim()
    const body = inner.startsWith("[") && inner.endsWith("]") ? inner.slice(1, -1) : inner
    if (body.trim() === "") return []
    return splitTopLevel(body, ",").map((part) => {
        const pt = part.trim()
        if (pt.startsWith("[") && pt.endsWith("]")) return parseArrayValue(pt)
        return parseScalarToken(pt)
    })
}

function parseValue(token: string): TomlValue {
    const t = token.trim()
    if (t.startsWith("[")) return parseArrayValue(t)
    return parseScalarToken(t)
}

function stripComment(line: string): string {
    let quote: string | undefined
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (quote !== undefined) {
            if (ch === "\\" && quote === '"') {
                i += 1
                continue
            }
            if (ch === quote) quote = undefined
            continue
        }
        if (ch === '"' || ch === "'") {
            quote = ch
            continue
        }
        if (ch === "#") return line.slice(0, i)
    }
    return line
}

function findEquals(line: string): number {
    let quote: string | undefined
    let depth = 0
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (quote !== undefined) {
            if (ch === "\\" && quote === '"') {
                i += 1
                continue
            }
            if (ch === quote) quote = undefined
            continue
        }
        if (ch === '"' || ch === "'") {
            quote = ch
            continue
        }
        if (ch === "[") depth += 1
        else if (ch === "]") depth -= 1
        else if (ch === "=" && depth === 0) return i
    }
    return -1
}

function parseKeySegments(header: string): string[] {
    const parts: string[] = []
    let i = 0
    while (i < header.length) {
        while (i < header.length && (header[i] === " " || header[i] === ".")) i += 1
        if (i >= header.length) break
        if (header[i] === '"' || header[i] === "'") {
            const q = header[i]
            let j = i + 1
            let s = ""
            while (j < header.length && header[j] !== q) {
                if (header[j] === "\\" && q === '"' && j + 1 < header.length) {
                    s += header[j + 1]
                    j += 2
                    continue
                }
                s += header[j]
                j += 1
            }
            parts.push(s)
            i = j + 1
        } else {
            let j = i
            while (j < header.length && /[A-Za-z0-9_-]/.test(header[j])) j += 1
            parts.push(header.slice(i, j))
            i = j
        }
    }
    return parts
}

function ensureTable(root: TomlObject, path: string[]): TomlObject {
    let cursor: TomlObject = root
    for (const segment of path) {
        const existing = cursor[segment]
        if (isTomlObject(existing)) {
            cursor = existing
        } else if (existing === undefined) {
            const created: TomlObject = {}
            cursor[segment] = created
            cursor = created
        } else {
            throw new Error(`cannot create table at '${segment}': existing value is not a table`)
        }
    }
    return cursor
}

function tomlParse(raw: string): TomlValue {
    const root: TomlObject = {}
    let current: TomlObject = root
    const lines = raw.replace(/\r\n?/g, "\n").split("\n")
    for (const original of lines) {
        const stripped = stripComment(original).trim()
        if (stripped === "") continue
        if (stripped.startsWith("[") && stripped.endsWith("]")) {
            const header = stripped.slice(1, -1).trim()
            current = ensureTable(root, parseKeySegments(header))
            continue
        }
        const eq = findEquals(stripped)
        if (eq === -1) continue
        const keyPath = parseKeySegments(stripped.slice(0, eq).trim())
        const valueText = stripped.slice(eq + 1).trim()
        if (keyPath.length === 0) continue
        if (keyPath.length === 1) {
            current[keyPath[0]] = parseValue(valueText)
        } else {
            const parent = ensureTable(current, keyPath.slice(0, -1))
            parent[keyPath[keyPath.length - 1]] = parseValue(valueText)
        }
    }
    return root
}

function quoteKeyOrString(s: string): string {
    if (/^[A-Za-z0-9_-]+$/.test(s)) return s
    return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'
}

function formatScalar(value: string | number | boolean): string {
    if (typeof value === "string") {
        return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t") + '"'
    }
    if (typeof value === "boolean") return value ? "true" : "false"
    return String(value)
}

function formatValue(value: TomlValue): string {
    if (Array.isArray(value)) return "[" + value.map(formatValue).join(", ") + "]"
    if (isTomlObject(value)) {
        const entries = Object.entries(value).map(([k, v]) => `${quoteKeyOrString(k)} = ${formatValue(v)}`)
        return "{ " + entries.join(", ") + " }"
    }
    return formatScalar(value)
}

function emitTable(obj: TomlObject, prefix: string[], lines: string[]): void {
    const nested: Array<[string, TomlObject]> = []
    for (const [key, value] of Object.entries(obj)) {
        if (isTomlObject(value)) {
            nested.push([key, value])
        } else {
            lines.push(`${quoteKeyOrString(key)} = ${formatValue(value)}`)
        }
    }
    for (const [key, value] of nested) {
        const path = [...prefix, key]
        lines.push("")
        lines.push(`[${path.map(quoteKeyOrString).join(".")}]`)
        emitTable(value, path, lines)
    }
}

function tomlStringify(value: unknown): string {
    if (!isTomlObject(value as TomlValue)) {
        return formatScalar(value as string | number | boolean)
    }
    const lines: string[] = []
    emitTable(value as TomlObject, [], lines)
    return lines.join("\n")
}

export const tomlParser: ConfigFormatParser = {
    parse: (raw: string) => tomlParse(raw),
    stringify: (value: unknown) => tomlStringify(value),
}
