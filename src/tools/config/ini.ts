import type { ConfigFormatParser } from "./types"

const SECTION_PATTERN = /^[ \t]*\[([^\]\r\n]+)\][ \t]*(?:[;#].*)?$/
const ASSIGNMENT_PATTERN = /^([ \t]*)([^:=#;\s][^:=\r\n]*?)([ \t]*(?::|=)[ \t]*|[ \t]+)(.*)$/

function stripQuotes(value: string): string {
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

function iniParse(raw: string): unknown {
    const result: Record<string, unknown> = {}
    let current: Record<string, string> | null = null
    const lines = raw.split(/\r\n|\r|\n/)
    for (const rawLine of lines) {
        const line = rawLine.replace(/;[^\r\n]*$/, "").replace(/^[ \t]+/, "")
        if (line.trim() === "" || line.trim().startsWith("#")) continue
        const sectionMatch = SECTION_PATTERN.exec(line)
        if (sectionMatch && sectionMatch[1] !== undefined) {
            const sectionName = sectionMatch[1].trim()
            if (!Object.hasOwn(result, sectionName)) {
                result[sectionName] = {}
            }
            const target = result[sectionName]
            if (target !== null && typeof target === "object" && !Array.isArray(target)) {
                current = target as Record<string, string>
            }
            continue
        }
        const assignmentMatch = ASSIGNMENT_PATTERN.exec(rawLine)
        if (assignmentMatch && assignmentMatch[2] !== undefined) {
            const key = assignmentMatch[2].trim()
            const valueText = assignmentMatch[4] ?? ""
            const value = stripQuotes(valueText)
            if (current === null) {
                result[key] = value
            } else {
                current[key] = value
            }
        }
    }
    return result
}

function iniStringify(value: unknown): string {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return ""
    }
    const obj = value as Record<string, unknown>
    const lines: string[] = []
    for (const [key, raw] of Object.entries(obj)) {
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
            const coerced = typeof raw === "string" ? raw : raw === null || raw === undefined ? "" : String(raw)
            lines.push(`${key}=${coerced}`)
        } else {
            lines.push(`[${key}]`)
            for (const [childKey, childRaw] of Object.entries(raw as Record<string, unknown>)) {
                const coerced = typeof childRaw === "string" ? childRaw : childRaw === null || childRaw === undefined ? "" : String(childRaw)
                lines.push(`${childKey}=${coerced}`)
            }
        }
    }
    return lines.join("\n")
}

export const iniParser: ConfigFormatParser = { parse: iniParse, stringify: iniStringify }
