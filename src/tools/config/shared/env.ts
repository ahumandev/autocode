import type { ConfigFormatParser } from "./types"

const ENV_ASSIGNMENT_PATTERN = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/

function stripEnvQuotes(value: string): string {
    const trimmed = value.trim()
    if (trimmed.length >= 2) {
        const first = trimmed[0]
        const last = trimmed[trimmed.length - 1]
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return trimmed.slice(1, -1)
        }
    }
    return trimmed
}

function envParse(raw: string): unknown {
    const result: Record<string, string> = {}
    const lines = raw.split(/\r\n|\r|\n/)
    for (const rawLine of lines) {
        const line = rawLine.replace(/^[ \t]+/, "")
        if (line === "" || line.startsWith("#")) continue
        const match = ENV_ASSIGNMENT_PATTERN.exec(rawLine)
        if (match && match[1] !== undefined) {
            const key = match[1]
            const value = stripEnvQuotes(match[2] ?? "")
            result[key] = value
        }
    }
    return result
}

function envStringify(value: unknown): string {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return ""
    const obj = value as Record<string, unknown>
    return Object.entries(obj).map(([key, raw]) => {
        const coerced = typeof raw === "string" ? raw : raw === null || raw === undefined ? "" : String(raw)
        return `${key}=${coerced}`
    }).join("\n")
}

export const envParser: ConfigFormatParser = { parse: envParse, stringify: envStringify }
