import { createRetryResponse } from "@/utils/tools"
import { detectNewline } from "./shared"
import type { ContentPosition, EnvAssignment, EnvModel, RetryResult } from "./types"

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENV_ASSIGNMENT_PATTERN = /^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)(.*)$/

export function parseEnvDocument(raw: string): EnvModel {
    const assignments: EnvAssignment[] = []
    let offset = 0
    let line = 1
    while (offset < raw.length) {
        const nextNewline = findLineEnd(raw, offset)
        const lineEnd = nextNewline.index
        const lineEndWithNewline = nextNewline.index + nextNewline.newlineLength
        addAssignment(assignments, raw.slice(offset, lineEnd), offset, lineEnd, lineEndWithNewline, line)
        offset = lineEndWithNewline
        line += 1
    }
    return { raw, newline: detectNewline(raw), assignments }
}

export function validateEnvKey(input: unknown, name: string, failedAction: string): RetryResult<string> {
    if (typeof input !== "string" || input === "") return { ok: false, response: createRetryResponse(failedAction, `${name} must be a non-empty env key.`, "Retry with an env key like API_KEY.") }
    if (!ENV_KEY_PATTERN.test(input)) return { ok: false, response: createRetryResponse(failedAction, `${name} must match [A-Za-z_][A-Za-z0-9_]*.`, "Retry with a valid env key.") }
    return { ok: true, value: input }
}

export function resolveEnvAssignment(model: EnvModel, key: string, failedAction: string, missingName: string): RetryResult<EnvAssignment> {
    const matches = model.assignments.filter((assignment) => assignment.key === key)
    if (matches.length === 1) return { ok: true, value: matches[0] }
    if (matches.length > 1) return { ok: false, response: duplicateEnvKeyResponse(failedAction, key, matches) }
    return { ok: false, response: createRetryResponse(failedAction, `${missingName} not found: ${key}`, "Retry with an existing env key.") }
}

export function findEnvAssignments(model: EnvModel, key: string): EnvAssignment[] {
    return model.assignments.filter((assignment) => assignment.key === key)
}

export function duplicateEnvKeyResponse(failedAction: string, key: string, matches: EnvAssignment[]): string {
    const refs = matches.map((assignment) => `${assignment.key}:${assignment.line}`).join(", ")
    return createRetryResponse(failedAction, `Duplicate env key ${key}: ${refs}`, "Remove duplicate env key assignments, then retry.")
}

export function envSectionInfo(assignment: EnvAssignment): Record<string, unknown> {
    return { title: assignment.key, path: assignment.key, level: 1, header: assignment.key, line: assignment.line, children: [] }
}

export function envTocNode(assignment: EnvAssignment): Record<string, unknown> {
    return envSectionInfo(assignment)
}

export function replaceEnvValue(model: EnvModel, assignment: EnvAssignment, value: string): string {
    return `${model.raw.slice(0, assignment.valueStart)}${value}${model.raw.slice(assignment.valueEnd)}`
}

export function insertEnvAssignment(model: EnvModel, key: string, value: string, position: ContentPosition): string {
    const line = `${key}=${value}${model.newline}`
    const count = model.assignments.length
    if (count === 0) return line
    if (position === undefined || position >= count) {
        // Append at end
        if (endsWithNewline(model.raw)) return `${model.raw}${line}`
        return `${model.raw}${model.newline}${line}`
    }
    if (position <= 0) {
        const insertAt = model.assignments[0]?.lineStart ?? 0
        return `${model.raw.slice(0, insertAt)}${line}${model.raw.slice(insertAt)}`
    }
    // Insert at specific index
    const insertAt = model.assignments[position].lineStart
    return `${model.raw.slice(0, insertAt)}${line}${model.raw.slice(insertAt)}`
}

export function removeEnvAssignment(model: EnvModel, assignment: EnvAssignment): string {
    return `${model.raw.slice(0, assignment.lineStart)}${model.raw.slice(assignment.lineEndWithNewline)}`
}

export function renameEnvAssignment(model: EnvModel, assignment: EnvAssignment, key: string): string {
    return `${model.raw.slice(0, assignment.lineStart)}${model.raw.slice(assignment.lineStart, assignment.valueStart).replace(assignment.key, key)}${model.raw.slice(assignment.valueStart)}`
}

export function moveEnvAssignment(model: EnvModel, section: EnvAssignment, _target: EnvAssignment, position: ContentPosition): string {
    const movedLine = envLineForMove(model, section)
    const removedRaw = removeEnvAssignment(model, section)
    const removedModel = parseEnvDocument(removedRaw)
    const count = removedModel.assignments.length
    if (count === 0) return `${movedLine}`
    if (position === undefined || position >= count) {
        const prefix = removedRaw.endsWith("\n") || removedRaw.endsWith("\r") ? "" : model.newline
        return `${removedRaw}${prefix}${movedLine}`
    }
    if (position <= 0) {
        const insertAt = removedModel.assignments[0]?.lineStart ?? 0
        return `${removedRaw.slice(0, insertAt)}${movedLine}${removedRaw.slice(insertAt)}`
    }
    const insertAt = removedModel.assignments[position].lineStart
    return `${removedRaw.slice(0, insertAt)}${movedLine}${removedRaw.slice(insertAt)}`
}

export function validateEnvSingleLine(input: unknown, failedAction: string): RetryResult<string> {
    if (typeof input !== "string") return { ok: false, response: createRetryResponse(failedAction, "content must be a string.", "Retry with env value content as a string.") }
    if (input.includes("\n") || input.includes("\r")) return { ok: false, response: createRetryResponse(failedAction, "content must be a single-line env value.", "Retry with content that does not contain newlines.") }
    return { ok: true, value: input }
}

function addAssignment(assignments: EnvAssignment[], lineText: string, lineStart: number, lineEnd: number, lineEndWithNewline: number, line: number): void {
    const match = ENV_ASSIGNMENT_PATTERN.exec(lineText)
    if (!match) return
    const prefix = match[1] ?? ""
    const key = match[2]
    const separator = match[3] ?? ""
    if (key === undefined) return
    const valueStart = lineStart + prefix.length + key.length + separator.length
    assignments.push({ key, line, lineStart, lineEnd, lineEndWithNewline, valueStart, valueEnd: lineEnd })
}

function findLineEnd(raw: string, offset: number): { index: number, newlineLength: number } {
    for (let index = offset; index < raw.length; index += 1) {
        if (raw[index] === "\n") return { index, newlineLength: 1 }
        if (raw[index] === "\r") return { index, newlineLength: raw[index + 1] === "\n" ? 2 : 1 }
    }
    return { index: raw.length, newlineLength: 0 }
}

function endsWithNewline(raw: string): boolean {
    return raw.endsWith("\n") || raw.endsWith("\r")
}

function envLineForMove(model: EnvModel, assignment: EnvAssignment): string {
    const rawLine = model.raw.slice(assignment.lineStart, assignment.lineEndWithNewline)
    return endsWithNewline(rawLine) ? rawLine : `${rawLine}${model.newline}`
}

