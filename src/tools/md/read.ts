import { tool } from "@opencode-ai/plugin"
import { readFileSync } from "fs"
import { expandGlob } from "@/utils/glob"
import { ownText, parseMarkdown } from "./shared/markdown"
import { createRetryResponse } from "@/utils/tools"

export function createAutocodeMdReadTool(): ReturnType<typeof tool> {
    return tool({
        description: `Read markdown files by glob search pattern. Single match retrive Markdown section content, otherwise read md file outline.`,
        args: {
            glob: tool.schema.string().describe("Glob pattern for Markdown files, e.g. 'docs/**/*.md'."),
            line_start: tool.schema.number().int().min(1).default(1).optional().describe("Optional start line of md file for filtering sections. Default 1."),
            line_end: tool.schema.number().int().min(1).default(Number.MAX_SAFE_INTEGER).optional().describe("Optional end line of md file for filtering sections. Default = last line."),
            anchor_pattern: tool.schema.string().optional().describe("Regex; include sections whose anchor matches it (GitHub MD standard). Default = all."),
            content_pattern: tool.schema.string().optional().describe("Regex; include sections whose own text content matches it. Default = all."),
            max_anchors: tool.schema.number().int().min(2).optional().default(40).describe("Cap on number of anchors returned per file."),
        },
        execute: async (args, context) => {
            if (typeof args.glob !== "string" || args.glob.length === 0) {
                return createRetryResponse("Read md section", new Error("glob required"), "Provide a glob pattern.")
            }

            let anchorPattern: RegExp | null = null
            if (args.anchor_pattern !== undefined) {
                try {
                    anchorPattern = new RegExp(args.anchor_pattern)
                } catch (error) {
                    return createRetryResponse("Read md section", error, "Fix the regex pattern.")
                }
            }
            let contentPattern: RegExp | null = null
            if (args.content_pattern !== undefined) {
                try {
                    contentPattern = new RegExp(args.content_pattern)
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
            const matches = await expandGlob(String(args.glob), cwd)
            if (matches.length === 0) {
                return createRetryResponse("Read md section", new Error("no files matched glob: " + args.glob), "Check the glob pattern and path.")
            }

            const maxKeys = args.max_anchors ?? 40
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

            const total = collected.reduce((sum, c) => sum + c.filtered.length, 0)
            const includeContent = total === 1

            const file_paths: Record<string, { heading: string; anchor: string; line: number; content?: string }[]> = {}
            for (const { key, model, filtered } of collected) {
                const shown = filtered.slice(0, maxKeys)
                const entry = shown.map((h) => {
                    const obj: { heading: string; anchor: string; line: number; content?: string } = {
                        heading: h.title,
                        anchor: h.referenceId,
                        line: h.start,
                    }
                    if (includeContent) {
                        obj.content = ownText(model, h)
                    }
                    return obj
                })
                file_paths[key] = entry
            }

            if (Object.keys(file_paths).length === 0) {
                return createRetryResponse("Read md section", new Error("no readable md files/sections for glob: " + args.glob), "Check the glob pattern targets .md files with matching headers.")
            }

            return JSON.stringify({ file_paths })
        },
    })
}
