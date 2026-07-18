import { detectNewline, toErrorMessage } from "./shared"

export interface MdHeading {
    title: string
    level: number
    start: number
    headerEnd: number
    spanEnd: number
    children: MdHeading[]
    parent: MdHeading | null
    referenceId: string
    marker: "atx" | "setext"
}

export interface MdModel {
    raw: string
    newline: string
    lines: string[]
    lineCount: number
    frontmatterBlock: string
    bodyStartLine: number
    headings: MdHeading[]
    roots: MdHeading[]
}

const atxPattern = /^(#{1,6})(?:\s+)(.+?)\s*#*\s*$/
const setextH1 = /^=+\s*$/
const setextH2 = /^-+\s*$/

export function slugifyHeading(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
}

export function splitFrontmatter(raw: string, newline: string): { block: string; bodyStartLine: number } {
    const lines = raw.split(newline)
    if (lines.length === 0 || lines[0] !== "---") {
        return { block: "", bodyStartLine: 1 }
    }
    let offset = lines[0].length + newline.length
    for (let i = 1; i < lines.length; i++) {
        if (lines[i] === "---" || lines[i] === "...") {
            const blockEndCharIndex = offset + lines[i].length
            const closingNewlineEnd = raw.indexOf(newline, blockEndCharIndex)
            const blockEnd = closingNewlineEnd === -1 ? raw.length : closingNewlineEnd + newline.length
            return { block: raw.slice(0, blockEnd), bodyStartLine: i + 2 }
        }
        offset += lines[i].length + newline.length
    }
    return { block: "", bodyStartLine: 1 }
}

interface RawHeading {
    title: string
    level: number
    start: number
    headerEnd: number
    marker: "atx" | "setext"
}

function scanHeadings(lines: string[], bodyStartLine: number): RawHeading[] {
    const out: RawHeading[] = []
    let inFence = false
    let fenceChar = ""
    const lastBodyLineIndex = lines.length - 1
    for (let i = bodyStartLine - 1; i <= lastBodyLineIndex; i++) {
        const line = lines[i] ?? ""
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
            continue
        }
        if (inFence) continue
        const atx = line.match(atxPattern)
        if (atx) {
            out.push({ title: atx[2].trim(), level: atx[1].length, start: i + 1, headerEnd: i + 2, marker: "atx" })
            continue
        }
        if (line.length > 0 && trimmed.length > 0 && !trimmed.startsWith("#") && i + 1 <= lastBodyLineIndex) {
            const next = lines[i + 1] ?? ""
            if (setextH1.test(next)) {
                out.push({ title: trimmed, level: 1, start: i + 1, headerEnd: i + 3, marker: "setext" })
                i += 1
                continue
            }
            if (setextH2.test(next)) {
                out.push({ title: trimmed, level: 2, start: i + 1, headerEnd: i + 3, marker: "setext" })
                i += 1
                continue
            }
        }
    }
    return out
}

function buildTree(raws: RawHeading[]): { headings: MdHeading[]; roots: MdHeading[] } {
    const headings: MdHeading[] = raws.map((r) => ({
        title: r.title,
        level: r.level,
        start: r.start,
        headerEnd: r.headerEnd,
        spanEnd: r.start,
        children: [],
        parent: null,
        referenceId: r.title,
        marker: r.marker,
    }))
    const roots: MdHeading[] = []
    const stack: MdHeading[] = []
    for (const h of headings) {
        while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop()
        if (stack.length > 0) {
            h.parent = stack[stack.length - 1]
            stack[stack.length - 1].children.push(h)
        } else {
            roots.push(h)
        }
        stack.push(h)
    }
    return { headings, roots }
}

function computeSpans(headings: MdHeading[], lineCount: number): void {
    for (let k = 0; k < headings.length; k++) {
        const h = headings[k]
        let j = k + 1
        while (j < headings.length && headings[j].level > h.level) j++
        h.spanEnd = j < headings.length ? headings[j].start - 1 : lineCount
    }
}

function assignReferenceIds(roots: MdHeading[], headings: MdHeading[]): void {
    const used = new Set<string>()
    const order: MdHeading[] = []
    const walk = (h: MdHeading) => {
        order.push(h)
        for (const c of h.children) walk(c)
    }
    for (const r of roots) walk(r)
    for (const h of order) {
        const base = slugifyHeading(h.title)
        if (!used.has(base)) {
            h.referenceId = base
        } else {
            let n = 1
            while (used.has(`${base}-${n}`)) n++
            h.referenceId = `${base}-${n}`
        }
        used.add(h.referenceId)
    }
}

export function parseMarkdown(raw: string): MdModel {
    const newline = detectNewline(raw)
    const lines = raw.length === 0 ? [] : raw.split(newline)
    const lineCount = lines.length
    const { block, bodyStartLine } = splitFrontmatter(raw, newline)
    const raws = scanHeadings(lines, bodyStartLine)
    const { headings, roots } = buildTree(raws)
    computeSpans(headings, lineCount)
    assignReferenceIds(roots, headings)
    return { raw, newline, lines, lineCount, frontmatterBlock: block, bodyStartLine, headings, roots }
}

function sliceLines(model: MdModel, fromLine: number, toLine: number): string {
    if (fromLine > toLine) return ""
    if (fromLine < 1) fromLine = 1
    if (toLine > model.lineCount) toLine = model.lineCount
    const parts: string[] = []
    for (let i = fromLine - 1; i <= toLine - 1 && i < model.lines.length; i++) {
        parts.push(model.lines[i])
    }
    return parts.join(model.newline).trim()
}

interface OwnResult {
    text: string
    ownEnd: number
}

function computeOwn(model: MdModel, h: MdHeading): OwnResult {
    if (h.children.length === 0) {
        return { text: sliceLines(model, h.headerEnd, h.spanEnd), ownEnd: h.spanEnd }
    }
    const intro = sliceLines(model, h.headerEnd, h.children[0].start - 1)
    const lastChild = h.children[h.children.length - 1]
    const lc = computeOwn(model, lastChild)
    const trailing = sliceLines(model, lc.ownEnd + 1, h.spanEnd)
    const parts = [intro, trailing].filter((s) => s !== "")
    return { text: parts.join("\n\n"), ownEnd: h.spanEnd }
}

export function ownText(model: MdModel, h: MdHeading): string {
    return computeOwn(model, h).text
}

function sectionObj(model: MdModel, h: MdHeading): Record<string, unknown> {
    const obj: Record<string, unknown> = { _lines: [h.start, h.spanEnd] }
    for (const c of h.children) obj[c.referenceId] = sectionObj(model, c)
    return obj
}

export function buildOutline(model: MdModel): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const r of model.roots) result[r.referenceId] = sectionObj(model, r)
    return result
}

export type ResolveResult =
    | { ok: true; heading: MdHeading }
    | { ok: false; reason: "none" | "many"; matches: MdHeading[] }

export function resolveSection(model: MdModel, key: string): ResolveResult {
    const exact = model.headings.filter((h) => h.referenceId === key)
    if (exact.length === 1) return { ok: true, heading: exact[0] }
    if (exact.length > 1) return { ok: false, reason: "many", matches: exact }
    const bare = model.headings.filter((h) => h.title === key)
    if (bare.length === 1) return { ok: true, heading: bare[0] }
    if (bare.length === 0) return { ok: false, reason: "none", matches: [] }
    return { ok: false, reason: "many", matches: bare }
}

export function rebuildFile(model: MdModel, newBody: string): string {
    if (model.frontmatterBlock !== "" && newBody !== "") {
        const fm = model.frontmatterBlock.replace(/\n+$/, "")
        return fm + "\n\n" + newBody
    }
    return model.frontmatterBlock + newBody
}

export function bodyText(model: MdModel): string {
    if (model.bodyStartLine > model.lineCount) return ""
    return model.lines.slice(model.bodyStartLine - 1).join(model.newline)
}

export { toErrorMessage }

export function normalizeContentBlock(text: string): string {
    return text.replace(/\r\n/g, "\n").trim()
}

export function adjustLevels(h: MdHeading, delta: number): void {
    h.level = Math.max(1, Math.min(6, h.level + delta))
    for (const c of h.children) adjustLevels(c, delta)
}

export type OwnTextOverrides = Map<MdHeading, string>

export interface ContentBlocks {
    intro: string
    children: MdHeading[]
    overrides: OwnTextOverrides
}

function reparentHeading(h: MdHeading, newParent: MdHeading | null): void {
    h.parent = newParent
    for (const c of h.children) reparentHeading(c, h)
}

export function parseContentBlocks(content: string, newSectionLevel: number): ContentBlocks {
    const normalized = normalizeContentBlock(content)
    if (normalized === "") {
        return { intro: "", children: [], overrides: new Map() }
    }
    // append newline so parseMarkdown's body parsing has stable boundaries
    const contentModel = parseMarkdown(normalized + "\n")
    if (contentModel.roots.length === 0) {
        return { intro: normalized, children: [], overrides: new Map() }
    }
    // intro = content preamble (text before first content heading)
    const firstStart = contentModel.roots[0].start
    const introEndLine = Math.max(contentModel.bodyStartLine, firstStart) - 1
    const introLines = contentModel.lines.slice(contentModel.bodyStartLine - 1, introEndLine)
    const intro = introLines.join(contentModel.newline).trim()
    // rebase levels: topmost content heading becomes (newSectionLevel + 1)
    const topLevel = contentModel.roots.reduce((min, h) => h.level < min ? h.level : min, 6)
    const delta = (newSectionLevel + 1) - topLevel
    for (const r of contentModel.roots) {
        reparentHeading(r, null)
        adjustLevels(r, delta)
    }
    // overrides for each imported heading so serializeTree can fetch their body text
    const overrides: OwnTextOverrides = new Map()
    for (const h of contentModel.headings) overrides.set(h, ownText(contentModel, h))
    return { intro, children: contentModel.roots, overrides }
}
