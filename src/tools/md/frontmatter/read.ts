import { tool } from "@opencode-ai/plugin"
import { readFile } from "fs/promises"
import { createRetryResponse } from "@/utils/tools"
import { expandGlob } from "@/utils/glob"
import { configRead, formatPath } from "@/tools/config/shared/core"
import { yamlParser } from "@/tools/config/shared/yaml"

function splitFrontmatter(raw: string): { block: string; content: string; body: string; hasFrontmatter: boolean } {
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

export function createAutocodeMdFrontmatterReadTool(): ReturnType<typeof tool> {
    return tool({
        description: "Read frontmatter from local Markdown (.md) files. Optionally filter frontmatter keys and values for outline.",
        args: {
            glob: tool.schema.string().describe("Glob pattern for Markdown files, e.g. 'docs/**/*.md'."),
            key_pattern: tool.schema.string().optional().describe("Regex; include nodes whose key path has any segment matching it. Default = all."),
            value_pattern: tool.schema.string().optional().describe("Regex; include leaf nodes whose value matches it. Default = all."),
            max_keys: tool.schema.number().int().min(0).optional().default(40).describe("Cap on total output nodes across all matching files."),
            max_value_chars: tool.schema.number().int().min(0).optional().default(40).describe("Truncate string values longer than this."),
        },
        execute: async (args, context) => {
            const failedAction = "Read frontmatter"

            if (typeof args.glob !== "string" || args.glob.length === 0) {
                return createRetryResponse(failedAction, new Error("glob required"), "Provide a glob pattern.")
            }

            let keyPattern: RegExp | undefined
            let valuePattern: RegExp | undefined
            try {
                keyPattern = args.key_pattern ? new RegExp(args.key_pattern) : undefined
                valuePattern = args.value_pattern ? new RegExp(args.value_pattern) : undefined
            } catch (error) {
                return createRetryResponse(failedAction, error, "Fix the regex pattern.")
            }

            const cwd = context.directory ?? process.cwd()
            const matches = await expandGlob(String(args.glob), cwd)
            if (matches.length === 0) {
                return createRetryResponse(failedAction, new Error("no files matched glob: " + args.glob), "Check the glob pattern and path.")
            }

            const file_paths: Record<string, { key_paths: Record<string, string | null>; nodes_shown: number; nodes_total: number }> = {}

            let budget = args.max_keys ?? 40
            let globalShown = 0
            let globalTotal = 0
            let truncated = false

            for (const { key, absolute } of matches) {
                if (!absolute.toLowerCase().endsWith(".md")) continue
                if (budget <= 0) break

                let raw: string
                try {
                    raw = await readFile(absolute, "utf8")
                } catch {
                    continue
                }

                const fm = splitFrontmatter(raw)
                if (!fm.hasFrontmatter) continue

                let value: unknown
                try {
                    value = yamlParser.parse(fm.content)
                } catch {
                    continue
                }

                if (value === null || value === undefined) continue

                const result = configRead(value, {
                    keyDepth: Number.MAX_SAFE_INTEGER,
                    subkeyPattern: keyPattern,
                    valuePattern,
                    maxKeys: budget,
                    maxValueChars: args.max_value_chars ?? 40,
                })

                globalShown += result.nodesShown
                globalTotal += result.nodesTotal
                if (result.nodesTotal > result.nodesShown) truncated = true

                const key_paths: Record<string, string | null> = {}
                for (const node of result.nodes) {
                    key_paths[formatPath(node.path)] = node.value
                }

                file_paths[key] = {
                    key_paths,
                    nodes_shown: result.nodesShown,
                    nodes_total: result.nodesTotal,
                }

                budget -= result.nodesShown
            }

            if (Object.keys(file_paths).length === 0) {
                return createRetryResponse(failedAction, new Error("no files with frontmatter for glob: " + args.glob), "Check the glob pattern targets .md files with frontmatter.")
            }

            return JSON.stringify({
                file_paths,
                nodes_shown: globalShown,
                nodes_total: globalTotal,
                truncated,
            })
        },
    })
}
