import { createRetryResponse } from "@/utils/tools"
import { detectNewline } from "./shared"
import type { ContentPosition, Frontmatter, Heading, MarkdownModel, RetryResult } from "./types"

const headingPattern = /^(#{1,6})\s+(.+?)\s*#*\s*$/

type LineRange = { start: number, end: number, line: string }

function forEachLine(text: string, visit: (line: LineRange) => void): void {
    let start = 0
    while (start < text.length) {
        const newlineIndex = text.indexOf("\n", start)
        const end = newlineIndex === -1 ? text.length : newlineIndex + 1
        const lineEnd = newlineIndex === -1 ? text.length : newlineIndex
        visit({ start, end, line: text.slice(start, lineEnd).replace(/\r$/, "") })
        if (newlineIndex === -1) return
        start = end
    }
}

export function splitFrontmatter(raw: string): Frontmatter {
    const firstNewline = raw.indexOf("\n")
    const firstEnd = firstNewline === -1 ? raw.length : firstNewline + 1
    const firstLine = raw.slice(0, firstNewline === -1 ? raw.length : firstNewline).replace(/\r$/, "")
    if (firstLine !== "---") return { block: "", content: "", body: raw, hasFrontmatter: false }

    let closeStart = -1
    let closeEnd = -1
    let cursor = firstEnd
    while (cursor < raw.length) {
        const nextNewline = raw.indexOf("\n", cursor)
        const lineEnd = nextNewline === -1 ? raw.length : nextNewline
        const line = raw.slice(cursor, lineEnd).replace(/\r$/, "")
        if (line === "---") {
            closeStart = cursor
            closeEnd = nextNewline === -1 ? raw.length : nextNewline + 1
            break
        }
        cursor = nextNewline === -1 ? raw.length : nextNewline + 1
    }

    if (closeStart === -1 || closeEnd === -1) return { block: "", content: "", body: raw, hasFrontmatter: false }

    return {
        block: raw.slice(0, closeEnd),
        content: raw.slice(firstEnd, closeStart).replace(/\r?\n$/, ""),
        body: raw.slice(closeEnd),
        hasFrontmatter: true,
    }
}

export function lineStarts(text: string): Array<{ start: number, end: number, line: string }> {
    const lines: Array<{ start: number, end: number, line: string }> = []
    forEachLine(text, (line) => lines.push(line))
    return lines
}

export function parseMarkdown(raw: string): MarkdownModel {
    const frontmatter = splitFrontmatter(raw)
    const body = frontmatter.body
    const newline = detectNewline(raw)
    const headings: Heading[] = []
    const stack: Heading[] = []

    forEachLine(body, (line) => {
        const match = headingPattern.exec(line.line)
        if (!match) return

        const heading: Heading = {
            title: match[2].trim(),
            level: match[1].length,
            start: line.start,
            headerEnd: line.end,
            end: body.length,
            header: line.line,
            children: [],
            path: "",
        }

        while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
            const closed = stack.pop()
            if (closed) closed.end = line.start
        }
        const parent = stack[stack.length - 1]
        if (parent) {
            heading.parent = parent
            parent.children.push(heading)
        }
        stack.push(heading)
        headings.push(heading)
    })

    while (stack.length > 0) {
        const current = stack.pop()
        if (current) current.end = body.length
    }

    for (const heading of headings) {
        heading.path = [...ancestorTitles(heading), heading.title].join(".")
    }

    const roots = headings.filter((heading) => heading.level === 1)
    if (roots.length !== 1) throw new Error(`Markdown must contain exactly one H1 root; found ${roots.length}.`)

    return { frontmatter, body, headings, root: roots[0], newline }
}

export function availablePaths(model: MarkdownModel): string {
    return model.headings.map((heading) => heading.path).join(", ")
}

export function resolveSection(model: MarkdownModel, input: unknown): RetryResult<Heading> {
    if (typeof input !== "string" || input.trim() === "") {
        return { ok: false, response: createRetryResponse("resolve markdown section", "section must be a non-empty string.", `Retry with an exact section path. Available paths: ${availablePaths(model)}`) }
    }

    const value = input.trim()
    const pathMatch = model.headings.find((heading) => heading.path === value)
    if (pathMatch) return { ok: true, value: pathMatch }

    const titleMatches = model.headings.filter((heading) => heading.title === value)
    if (titleMatches.length === 1) return { ok: true, value: titleMatches[0] }
    if (titleMatches.length > 1) {
        const exactPaths = titleMatches.map((heading) => heading.path).join(", ")
        return { ok: false, response: createRetryResponse("resolve markdown section", `Ambiguous section title '${value}'. Matching paths: ${exactPaths}`, `Retry with one exact path: ${exactPaths}`) }
    }

    return { ok: false, response: createRetryResponse("resolve markdown section", `Section not found: ${value}. Available paths: ${availablePaths(model)}`, "Retry with an exact path from the available paths list.") }
}

export function directBodyEnd(section: Heading): number {
    return section.children[0]?.start ?? section.end
}

export function ownBody(model: MarkdownModel, section: Heading): string {
    return model.body.slice(section.headerEnd, directBodyEnd(section))
}

export function sectionInfo(section: Heading): Record<string, unknown> {
    return {
        title: section.title,
        path: section.path,
        level: section.level,
        header: section.header,
        parent: section.parent?.path,
        children: section.children.map((child) => child.path),
    }
}

export function tocNode(section: Heading, maxDepth: number | undefined, currentDepth = 1): Record<string, unknown> {
    const children = maxDepth !== undefined && currentDepth >= maxDepth
        ? []
        : section.children.map((child) => tocNode(child, maxDepth, currentDepth + 1))
    return { title: section.title, path: section.path, level: section.level, children }
}

export function hasHeading(content: string): boolean {
    let found = false
    forEachLine(content, (line) => {
        if (!found && headingPattern.test(line.line)) found = true
    })
    return found
}

export function startsWithHeading(content: string): boolean {
    let result = false
    forEachLine(content, (line) => {
        if (result) return
        if (line.line.trim() === "") return
        result = headingPattern.test(line.line)
    })
    return result
}

export function validateHeadingBase(baseLevel: number, content: string, failedAction: string): string | undefined {
    if (baseLevel <= 6 || !hasHeading(content)) return undefined
    return createRetryResponse(failedAction, "Cannot place heading content below an H6 section.", "Use plain text content or target a section at H5 or above.")
}

export function normalizeHeadingLevels(content: string, baseLevel: number): string {
    const stack: Array<{ original: number, normalized: number }> = []
    const parts: string[] = []
    forEachLine(content, (line) => {
        const match = headingPattern.exec(line.line)
        if (!match) {
            parts.push(content.slice(line.start, line.end))
            return
        }

        const original = match[1].length
        while (stack.length > 0 && stack[stack.length - 1].original >= original) stack.pop()
        const parentLevel = stack[stack.length - 1]?.normalized ?? baseLevel - 1
        const normalized = Math.min(6, Math.max(baseLevel, parentLevel + 1))
        stack.push({ original, normalized })
        parts.push(`${"#".repeat(normalized)} ${match[2].trim()}${content.slice(line.start + line.line.length, line.end)}`)
    })
    return parts.join("")
}

export function ensureBoundary(text: string, newline: string): string {
    if (text === "") return ""
    return text.endsWith("\n") || text.endsWith("\r") ? text : `${text}${newline}`
}

export function rebuild(model: MarkdownModel, body: string): string {
    return `${model.frontmatter.block}${body}`
}

export function insertIndex(target: Heading, position: ContentPosition, headedContent: boolean): number {
    const children = target.children
    const count = children.length
    if (position === undefined || position >= count) {
        return headedContent ? target.end : directBodyEnd(target)
    }
    if (position <= 0) {
        return headedContent ? directBodyEnd(target) : target.headerEnd
    }
    if (headedContent) return children[position - 1].end
    return directBodyEnd(target)
}

export function normalizeFrontmatter(input: string): string {
    const lines = input.replace(/\r\n/g, "\n").split("\n")
    while (lines.length > 0 && lines[0].trim() === "---") lines.shift()
    while (lines.length > 0 && lines[lines.length - 1].trim() === "---") lines.pop()
    return lines.join("\n").replace(/^\n+|\n+$/g, "")
}

function ancestorTitles(heading: Heading): string[] {
    const titles: string[] = []
    let current = heading.parent
    while (current) {
        titles.unshift(current.title)
        current = current.parent
    }
    return titles
}
