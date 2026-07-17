import type { MdHeading, MdModel } from "./markdown"
import { ownText } from "./markdown"

export function makeHeadingLine(title: string, level: number): string {
    const safeLevel = Math.max(1, Math.min(6, level))
    return `${"#".repeat(safeLevel)} ${title}`
}

export function normalizeContentBlock(text: string): string {
    return text.replace(/\r\n/g, "\n").trim()
}

export function adjustLevels(h: MdHeading, delta: number): void {
    h.level = Math.max(1, Math.min(6, h.level + delta))
    for (const c of h.children) adjustLevels(c, delta)
}

export function isDescendant(candidate: MdHeading, ancestor: MdHeading): boolean {
    let cur: MdHeading | null = candidate
    while (cur !== null) {
        if (cur === ancestor) return true
        cur = cur.parent
    }
    return false
}

export type OwnTextOverrides = Map<MdHeading, string>

export function getOwnText(model: MdModel, h: MdHeading, overrides?: OwnTextOverrides): string {
    if (overrides && overrides.has(h)) return overrides.get(h)!
    return ownText(model, h)
}

function emitHeading(h: MdHeading, model: MdModel, out: string[], overrides: OwnTextOverrides | undefined): void {
    out.push(makeHeadingLine(h.title, h.level))
    const body = getOwnText(model, h, overrides)
    if (body !== "") {
        out.push("")
        out.push(body)
    }
    for (const c of h.children) {
        out.push("")
        emitHeading(c, model, out, overrides)
    }
}

const strayHeadingPattern = /^#{1,6}[ \t]*$/

function escapeForRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function sanitizeSerializedBody(body: string, newline: string): string {
    const lines = body.split(newline)
    const kept: string[] = []
    let inFence = false
    let fenceChar = ""
    for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
            const f = trimmed.slice(0, 3)
            if (!inFence) {
                inFence = true
                fenceChar = f
            } else if (f === fenceChar) {
                inFence = false
                fenceChar = ""
            }
            kept.push(line)
            continue
        }
        if (!inFence && strayHeadingPattern.test(line)) continue
        kept.push(line)
    }
    let out = kept.join(newline)
    const tripleBlank = new RegExp("(?:" + escapeForRegex(newline) + "){3,}", "g")
    out = out.replace(tripleBlank, newline + newline)
    return out
}

export function serializeTree(model: MdModel, overrides?: OwnTextOverrides): string {
    const out: string[] = []
    for (const r of model.roots) {
        if (out.length > 0) out.push("")
        emitHeading(r, model, out, overrides)
    }
    let body = sanitizeSerializedBody(out.join(model.newline), model.newline)
    if (body !== "" && !body.endsWith(model.newline)) body += model.newline
    return body
}

export function clampIndex(index: number | undefined, defaultIndex: number, length: number): number {
    const idx = index === undefined || index === null ? defaultIndex : index
    if (idx === -1) return length
    if (idx < 0) return 0
    if (idx > length) return length
    return idx
}
