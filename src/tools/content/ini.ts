import { createRetryResponse } from "@/utils/tools"
import { detectNewline } from "./shared"
import type { ContentPosition, IniAssignment, IniModel, IniPath, IniSection, OptionalRetryResult, RetryResult } from "./types"

const SECTION_PATTERN = /^[ \t]*\[([^\]\r\n]+)\][ \t]*(?:[;#].*)?$/
const ASSIGNMENT_PATTERN = /^([ \t]*)([^:=#;\s][^:=\r\n]*?)([ \t]*(?::|=)[ \t]*|[ \t]+)(.*)$/

export function parseIniDocument(raw: string): IniModel {
    const lines = splitLines(raw)
    // .conf files use this parser as INI-like when any non-comment section header exists, otherwise properties-like.
    const iniLike = lines.some((line) => SECTION_PATTERN.test(line.text))
    const sections: IniSection[] = []
    const assignments: IniAssignment[] = []
    let current: IniSection | undefined
    for (const line of lines) {
        const sectionName = iniLike ? parseSectionName(line.text) : undefined
        if (sectionName !== undefined) {
            if (current !== undefined) setSectionEnd(current, line.lineStart, line.lineStart)
            current = { name: sectionName, line: line.number, lineStart: line.lineStart, lineEnd: line.lineEnd, lineEndWithNewline: line.lineEndWithNewline, bodyStart: line.lineEndWithNewline, end: raw.length, endWithNewline: raw.length }
            sections.push(current)
            continue
        }
        addAssignment(assignments, line, current?.name)
    }
    if (current !== undefined) setSectionEnd(current, raw.length, raw.length)
    return { raw, newline: detectNewline(raw), iniLike, sections, assignments }
}

export function parseIniPath(input: unknown, model: IniModel, name: string, failedAction: string): RetryResult<IniPath> {
    if (Array.isArray(input)) return parseIniArrayPath(input, name, failedAction)
    if (typeof input !== "string" || input === "") return { ok: false, response: createRetryResponse(failedAction, `${name} must be a non-empty string or path array.`, "Retry with a config key or [section,key] path.") }
    const dot = input.indexOf(".")
    if (dot > 0) {
        const section = input.slice(0, dot)
        if (model.sections.some((candidate) => candidate.name === section)) return { ok: true, value: { section, key: input.slice(dot + 1) } }
    }
    if (model.sections.some((section) => section.name === input)) return { ok: true, value: { section: input } }
    return { ok: true, value: { key: input } }
}

export function resolveIniTarget(model: IniModel, pathValue: IniPath, failedAction: string, missingName: string): RetryResult<{ section?: IniSection, assignment?: IniAssignment, path: string }> {
    if (pathValue.key !== undefined) return resolveIniAssignment(model, pathValue, failedAction, missingName)
    if (pathValue.section !== undefined) return resolveIniSection(model, pathValue.section, failedAction, missingName)
    return { ok: false, response: createRetryResponse(failedAction, "Path must target a key or section.", "Retry with a config key or section path.") }
}

export function findIniAssignments(model: IniModel, pathValue: IniPath): IniAssignment[] {
    if (pathValue.key === undefined) return []
    return model.assignments.filter((assignment) => assignment.key === pathValue.key && assignment.section === pathValue.section)
}

export function findIniSections(model: IniModel, section: string): IniSection[] {
    return model.sections.filter((candidate) => candidate.name === section)
}

export function duplicateIniKeyResponse(failedAction: string, pathValue: IniPath, matches: IniAssignment[]): string {
    const path = formatIniPath(pathValue)
    const refs = matches.map((assignment) => `${path}:${assignment.line}`).join(", ")
    return createRetryResponse(failedAction, `Duplicate config key ${path}: ${refs}`, "Remove duplicate config key assignments, then retry.")
}

export function duplicateIniSectionResponse(failedAction: string, section: string, matches: IniSection[]): string {
    const refs = matches.map((match) => `${section}:${match.line}`).join(", ")
    return createRetryResponse(failedAction, `Duplicate config section ${section}: ${refs}`, "Remove duplicate config sections, then retry.")
}

export function iniSectionInfo(target: { section?: IniSection, assignment?: IniAssignment, path: string }): Record<string, unknown> {
    if (target.section !== undefined) return { title: target.section.name, path: target.section.name, level: 1, header: `[${target.section.name}]`, line: target.section.line, children: iniChildren(target.section.name, []) }
    return { title: target.assignment?.key ?? target.path, path: target.path, level: target.assignment?.section === undefined ? 1 : 2, header: target.path, line: target.assignment?.line, children: [] }
}

export function iniToc(model: IniModel): Array<Record<string, unknown>> {
    const root = model.assignments.filter((assignment) => assignment.section === undefined).map((assignment) => iniSectionInfo({ assignment, path: formatIniPath({ key: assignment.key }) }))
    return [...root, ...model.sections.map((section) => ({ title: section.name, path: section.name, level: 1, header: `[${section.name}]`, line: section.line, children: iniChildren(section.name, model.assignments) }))]
}

export function iniTocNode(model: IniModel, target: { section?: IniSection, assignment?: IniAssignment, path: string }): Record<string, unknown> {
    if (target.section !== undefined) return { title: target.section.name, path: target.section.name, level: 1, header: `[${target.section.name}]`, line: target.section.line, children: iniChildren(target.section.name, model.assignments) }
    return iniSectionInfo(target)
}

export function iniContent(model: IniModel, target: { section?: IniSection, assignment?: IniAssignment }): string {
    if (target.assignment !== undefined) return model.raw.slice(target.assignment.valueStart, target.assignment.valueEnd)
    if (target.section !== undefined) return model.raw.slice(target.section.bodyStart, target.section.end)
    return model.raw
}

export function replaceIniValue(model: IniModel, assignment: IniAssignment, value: string): string {
    return `${model.raw.slice(0, assignment.valueStart)}${value}${model.raw.slice(assignment.valueEnd)}`
}

export function insertIniAssignment(model: IniModel, pathValue: IniPath, value: string, position: ContentPosition): string {
    const line = `${pathValue.key}=${value}${model.newline}`
    if (pathValue.section === undefined) return insertAtContainerEdge(model, undefined, line, position)
    const section = singleSection(model, pathValue.section)
    if (section === undefined) return appendMissingSection(model, pathValue.section, line)
    return insertAtContainerEdge(model, section, line, position)
}

export function removeIniTarget(model: IniModel, target: { section?: IniSection, assignment?: IniAssignment }): string {
    if (target.assignment !== undefined) return `${model.raw.slice(0, target.assignment.lineStart)}${model.raw.slice(target.assignment.lineEndWithNewline)}`
    if (target.section !== undefined) return `${model.raw.slice(0, target.section.lineStart)}${model.raw.slice(target.section.endWithNewline)}`
    return model.raw
}

export function renameIniTarget(model: IniModel, target: { section?: IniSection, assignment?: IniAssignment }, pathValue: IniPath): string {
    if (target.assignment !== undefined && pathValue.key !== undefined) return renameIniAssignmentTarget(model, target.assignment, pathValue)
    if (target.section !== undefined && pathValue.section !== undefined) return `${model.raw.slice(0, target.section.lineStart)}${renameSectionLine(model.raw.slice(target.section.lineStart, target.section.lineEnd), pathValue.section)}${model.raw.slice(target.section.lineEnd)}`
    return model.raw
}

function renameIniAssignmentTarget(model: IniModel, assignment: IniAssignment, pathValue: IniPath): string {
    const renamedLine = `${model.raw.slice(assignment.lineStart, assignment.keyStart)}${pathValue.key ?? assignment.key}${model.raw.slice(assignment.keyEnd, assignment.lineEndWithNewline)}`
    if (pathValue.section === assignment.section) return `${model.raw.slice(0, assignment.lineStart)}${renamedLine}${model.raw.slice(assignment.lineEndWithNewline)}`
    const removed = removeIniTarget(model, { assignment })
    return insertRawIniAssignment(parseIniDocument(removed), pathValue.section, renamedLine)
}

export function moveIniTarget(model: IniModel, source: { section?: IniSection, assignment?: IniAssignment }, target: { section?: IniSection, assignment?: IniAssignment }, position: ContentPosition): string {
    const rawBlock = source.assignment !== undefined ? lineForMove(model, source.assignment) : source.section !== undefined ? model.raw.slice(source.section.lineStart, source.section.endWithNewline) : ""
    const removed = removeIniTarget(model, source)
    const removedModel = parseIniDocument(removed)
    const sectionName = target.section?.name ?? target.assignment?.section
    if (sectionName !== undefined) {
        const existing = findIniSections(removedModel, sectionName)
        if (existing.length > 0) return insertAtContainerEdge(removedModel, existing[0], rawBlock, position)
        return `${removed}${rawBlock}`
    }
    return insertAtContainerEdge(removedModel, undefined, rawBlock, position)
}

export function validateIniSingleLine(input: unknown, failedAction: string): RetryResult<string> {
    if (typeof input !== "string") return { ok: false, response: createRetryResponse(failedAction, "content must be a string.", "Retry with config value content as a string.") }
    if (input.includes("\n") || input.includes("\r")) return { ok: false, response: createRetryResponse(failedAction, "content must be a single-line config value.", "Retry with content that does not contain newlines.") }
    return { ok: true, value: input }
}

export function validateIniInsertPath(pathValue: IniPath, failedAction: string): OptionalRetryResult<IniPath> {
    if (pathValue.key !== undefined) return { ok: true, value: pathValue }
    return { ok: false, response: createRetryResponse(failedAction, "target must include a config key.", "Retry with a key path like [section,key] or section.key.") }
}

export function formatIniPath(pathValue: IniPath): string {
    if (pathValue.section !== undefined && pathValue.key !== undefined) return `${pathValue.section}.${pathValue.key}`
    return pathValue.section ?? pathValue.key ?? ""
}

function parseIniArrayPath(input: unknown[], name: string, failedAction: string): RetryResult<IniPath> {
    if (input.length === 1 && typeof input[0] === "string" && input[0] !== "") return { ok: true, value: { key: input[0] } }
    if (input.length === 2 && typeof input[0] === "string" && input[0] !== "" && typeof input[1] === "string" && input[1] !== "") return { ok: true, value: { section: input[0], key: input[1] } }
    return { ok: false, response: createRetryResponse(failedAction, `${name} array path must be [key] or [section,key].`, "Retry with string array path elements.") }
}

function resolveIniAssignment(model: IniModel, pathValue: IniPath, failedAction: string, missingName: string): RetryResult<{ assignment: IniAssignment, path: string }> {
    if (pathValue.section !== undefined) {
        const sections = findIniSections(model, pathValue.section)
        if (sections.length > 1) return { ok: false, response: duplicateIniSectionResponse(failedAction, pathValue.section, sections) }
    }
    const matches = findIniAssignments(model, pathValue)
    if (matches.length === 1) return { ok: true, value: { assignment: matches[0], path: formatIniPath(pathValue) } }
    if (matches.length > 1) return { ok: false, response: duplicateIniKeyResponse(failedAction, pathValue, matches) }
    return { ok: false, response: createRetryResponse(failedAction, `${missingName} not found: ${formatIniPath(pathValue)}`, "Retry with an existing config key or section.") }
}

function resolveIniSection(model: IniModel, section: string, failedAction: string, missingName: string): RetryResult<{ section: IniSection, path: string }> {
    const matches = findIniSections(model, section)
    if (matches.length === 1) return { ok: true, value: { section: matches[0], path: section } }
    if (matches.length > 1) return { ok: false, response: duplicateIniSectionResponse(failedAction, section, matches) }
    return { ok: false, response: createRetryResponse(failedAction, `${missingName} not found: ${section}`, "Retry with an existing config key or section.") }
}

function addAssignment(assignments: IniAssignment[], line: ParsedLine, section: string | undefined): void {
    const match = ASSIGNMENT_PATTERN.exec(line.text)
    if (!match) return
    const prefix = match[1] ?? ""
    const key = (match[2] ?? "").trimEnd()
    const separator = match[3] ?? ""
    const keyStart = line.lineStart + prefix.length
    const keyEnd = keyStart + key.length
    assignments.push({ section, key, line: line.number, lineStart: line.lineStart, lineEnd: line.lineEnd, lineEndWithNewline: line.lineEndWithNewline, keyStart, keyEnd, valueStart: keyEnd + separator.length, valueEnd: line.lineEnd })
}

type ParsedLine = { text: string, number: number, lineStart: number, lineEnd: number, lineEndWithNewline: number }

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

function parseSectionName(line: string): string | undefined {
    const match = SECTION_PATTERN.exec(line)
    return match?.[1]?.trim()
}

function renameSectionLine(line: string, section: string): string {
    const open = line.indexOf("[")
    const close = line.indexOf("]", open + 1)
    if (open < 0 || close < 0) return `[${section}]`
    return `${line.slice(0, open + 1)}${section}${line.slice(close)}`
}

function setSectionEnd(section: IniSection, end: number, endWithNewline: number): void {
    section.end = end
    section.endWithNewline = endWithNewline
}

function iniChildren(section: string, assignments: IniAssignment[]): Array<Record<string, unknown>> {
    return assignments.filter((assignment) => assignment.section === section).map((assignment) => iniSectionInfo({ assignment, path: formatIniPath({ section, key: assignment.key }) }))
}

function singleSection(model: IniModel, name: string): IniSection | undefined {
    const matches = findIniSections(model, name)
    return matches.length === 1 ? matches[0] : undefined
}

function appendMissingSection(model: IniModel, section: string, line: string): string {
    const prefix = model.raw === "" || endsWithNewline(model.raw) ? "" : model.newline
    return `${model.raw}${prefix}[${section}]${model.newline}${line}`
}

function insertAtContainerEdge(model: IniModel, section: IniSection | undefined, line: string, position: ContentPosition): string {
    const keys = section === undefined
        ? model.assignments.filter((a) => a.section === undefined)
        : model.assignments.filter((a) => a.section === section.name)
    const count = keys.length

    if (count === 0) {
        if (section === undefined) return `${line}${model.raw}`
        const prefix = section.endWithNewline === model.raw.length && !endsWithNewline(model.raw) ? model.newline : ""
        return `${model.raw.slice(0, section.endWithNewline)}${prefix}${line}${model.raw.slice(section.endWithNewline)}`
    }

    if (position === undefined || position >= count) {
        const lastKey = keys[count - 1]
        const insertAt = section === undefined ? lastKey.lineEndWithNewline : Math.max(lastKey.lineEndWithNewline, section.endWithNewline)
        const prefix = insertAt === model.raw.length && !endsWithNewline(model.raw) ? model.newline : ""
        return `${model.raw.slice(0, insertAt)}${prefix}${line}${model.raw.slice(insertAt)}`
    }

    if (position <= 0) {
        const insertAt = section === undefined ? keys[0].lineStart : section.bodyStart
        return `${model.raw.slice(0, insertAt)}${line}${model.raw.slice(insertAt)}`
    }

    const insertAt = keys[position].lineStart
    return `${model.raw.slice(0, insertAt)}${line}${model.raw.slice(insertAt)}`
}

function insertRawIniAssignment(model: IniModel, section: string | undefined, line: string): string {
    if (section === undefined) return insertAtContainerEdge(model, undefined, line, undefined)
    const existing = singleSection(model, section)
    if (existing === undefined) return appendMissingSection(model, section, line)
    return insertAtContainerEdge(model, existing, line, undefined)
}

function lineForMove(model: IniModel, assignment: IniAssignment): string {
    const rawLine = model.raw.slice(assignment.lineStart, assignment.lineEndWithNewline)
    return endsWithNewline(rawLine) ? rawLine : `${rawLine}${model.newline}`
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
