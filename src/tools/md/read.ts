import { tool } from "@opencode-ai/plugin"
import { readFileSync } from "fs"
import { expandGlob } from "@/utils/glob"
import { ownText, parseMarkdown } from "./shared/markdown"
import { createRetryResponse } from "@/utils/tools"

const DEFAULT_MAX_ANCHORS = 40
const DEFAULT_MAX_CONTENT_CHARS = 0

export function createAutocodeMdReadTool(): ReturnType<typeof tool> {
    return tool({
        description: `Grep find content in md files or read markdown files by glob search pattern.`,
        args: {
            file_path_glob: tool.schema.string().describe("Glob pattern for Markdown files, e.g. 'docs/**/*.md'."),
            line_start: tool.schema.number().int().min(1).default(1).optional().describe("Optional filter from start line of md. Default 1."),
            line_end: tool.schema.number().int().min(1).default(Number.MAX_SAFE_INTEGER).optional().describe("Optional filter from end line of md file. Default = last line."),
            anchor_regex: tool.schema.string().optional().describe("Regex; find sections whose anchor matches it (GitHub MD standard). Default = all."),
            content_regex: tool.schema.string().optional().describe("Regex; find sections whose own text content matches it. Default = all."),
            max_anchors: tool.schema.number().int().min(2).optional().default(DEFAULT_MAX_ANCHORS).describe("Cap on number of anchors returned per file."),
            max_content_chars: tool.schema.number().int().min(0).optional().default(DEFAULT_MAX_CONTENT_CHARS).describe("Cap on number of content chars returned in total for all matches. Set to 0 to return only md outlines."),
        },
        execute: async (args, context) => {
            if (typeof args.file_path_glob !== "string" || args.file_path_glob.length === 0) {
                return createRetryResponse("Read md section", new Error("glob required"), "Provide a glob pattern.")
            }

            let anchorPattern: RegExp | null = null
            if (args.anchor_regex !== undefined) {
                try {
                    anchorPattern = new RegExp(args.anchor_regex)
                } catch (error) {
                    return createRetryResponse("Read md section", error, "Fix the regex pattern.")
                }
            }
            let contentPattern: RegExp | null = null
            if (args.content_regex !== undefined) {
                try {
                    contentPattern = new RegExp(args.content_regex)
                } catch (error) {
                    return createRetryResponse("Read md section", error, "Fix the regex pattern.")
                }
            }

            const lineStart = args.line_start ?? 1
            const lineEnd = args.line_end ?? Number.MAX_SAFE_INTEGER
            if (lineStart > lineEnd) {
                return createRetryResponse("Read md section", new Error(`line_start (${lineStart}) must be <= line_end (${lineEnd})`), "Set line_start <= line_end.")
            }

            const cwd = context.directory ?? process.cwd()
            const matches = await expandGlob(String(args.file_path_glob), cwd)
            if (matches.length === 0) {
                return createRetryResponse("Read md section", new Error("no files matched glob: " + args.file_path_glob), "Check the glob pattern and path.")
            }

            const maxKeys = args.max_anchors ?? DEFAULT_MAX_ANCHORS
            const selected = matches

            type Collected = { key: string; model: ReturnType<typeof parseMarkdown>; filtered: ReturnType<typeof parseMarkdown>["headings"] }
            const collected: Collected[] = []
            for (const { key, absolute } of selected) {
                if (!absolute.toLowerCase().endsWith(".md")) continue

                let raw: string
                try {
                    raw = readFileSync(absolute, "utf8")
                } catch {
                    continue
                }

                let model: ReturnType<typeof parseMarkdown>
                try {
                    model = parseMarkdown(raw)
                } catch {
                    continue
                }

                if (lineStart > model.lineCount) continue
                const effectiveEnd = Math.min(lineEnd, model.lineCount)

                let filtered = model.headings
                if (anchorPattern !== null) {
                    const pat = anchorPattern
                    filtered = filtered.filter((h) => pat.test(h.referenceId))
                }
                if (contentPattern !== null) {
                    const pat = contentPattern
                    filtered = filtered.filter((h) => pat.test(ownText(model, h)))
                }
                filtered = filtered.filter((h) => h.start <= effectiveEnd && h.spanEnd >= lineStart)

                if (filtered.length === 0) continue
                collected.push({ key, model, filtered })
            }

            const maxContentChars = args.max_content_chars ?? DEFAULT_MAX_CONTENT_CHARS

            const file_paths: Record<string, { heading: string; anchor: string; line: number; content?: string }[]> = {}
            if (maxContentChars <= 0) {
                for (const { key, filtered } of collected) {
                    const shown = filtered.slice(0, maxKeys)
                    file_paths[key] = shown.map((h) => ({
                        heading: h.title,
                        anchor: h.referenceId,
                        line: h.start,
                    }))
                }
            } else {
                let remaining = maxContentChars
                let stop = false
                for (const { key, model, filtered } of collected) {
                    if (stop) break
                    const shown = filtered.slice(0, maxKeys)
                    const entry: { heading: string; anchor: string; line: number; content: string }[] = []
                    for (const h of shown) {
                        if (remaining <= 0) {
                            stop = true
                            break
                        }
                        const fullContent = ownText(model, h)
                        let content: string
                        if (fullContent.length <= remaining) {
                            content = fullContent
                        } else {
                            content = fullContent.slice(0, remaining)
                            stop = true
                        }
                        remaining -= content.length
                        entry.push({
                            heading: h.title,
                            anchor: h.referenceId,
                            line: h.start,
                            content,
                        })
                        if (stop) break
                    }
                    if (entry.length > 0) {
                        file_paths[key] = entry
                    }
                }
            }

            if (Object.keys(file_paths).length === 0) {
                return createRetryResponse("Read md section", new Error("no readable md files/sections for glob: " + args.file_path_glob), "Check the glob pattern targets .md files with matching headers.")
            }

            return JSON.stringify({ file_paths })
        },
    })
}
