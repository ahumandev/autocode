import { tool } from "@opencode-ai/plugin"
import { readFile } from "fs/promises"
import { createRetryResponse } from "@/utils/tools"
import { expandGlob } from "@/utils/glob"
import { configRead, formatPath } from "@/tools/config/core"
import { yamlParser } from "@/tools/config/yaml"

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
        description: "Grep find frontmatter values in local Markdown (.md) files or read frontmatter by glob.",
        args: {
            file_path_glob: tool.schema.string().describe("Glob pattern for Markdown files, e.g. 'docs/**/*.md'."),
            key_regex: tool.schema.string().optional().describe("Regex; find nodes with matching key paths. Default = all."),
            value_regex: tool.schema.string().optional().describe("Regex; find leaf nodes with matching values. Default = all."),
            max_keys: tool.schema.number().int().min(0).optional().default(40).describe("Cap on total output nodes across all matching files. Default = 40."),
            max_value_chars: tool.schema.number().int().min(0).optional().default(40).describe("Truncate string values exceeding max_value_chars by appending '...'. Default = 40."),
        },
        execute: async (args, context) => {
            const failedAction = "Read frontmatter"

            if (typeof args.file_path_glob !== "string" || args.file_path_glob.length === 0) {
                return createRetryResponse(failedAction, new Error("glob required"), "Provide a glob pattern.")
            }

            let keyPattern: RegExp | undefined
            let valuePattern: RegExp | undefined
            try {
                keyPattern = args.key_regex ? new RegExp(args.key_regex) : undefined
                valuePattern = args.value_regex ? new RegExp(args.value_regex) : undefined
            } catch (error) {
                return createRetryResponse(failedAction, error, "Fix the regex pattern.")
            }

            if (!context.directory) {
                throw new Error("autocode_md_frontmatter_read: context.directory (project directory) is required but was not provided by host")
            }
            const cwd = context.directory
            const matches = await expandGlob(String(args.file_path_glob), cwd, { accessHidden: true })
            if (matches.length === 0) {
                return createRetryResponse(failedAction, new Error("no files matched glob: " + args.file_path_glob), "Check the glob pattern and path.")
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
                return createRetryResponse(failedAction, new Error("no files with frontmatter for glob: " + args.file_path_glob), "Check the glob pattern targets .md files with frontmatter.")
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
