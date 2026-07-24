import { tool } from "@opencode-ai/plugin"
import { readFile, writeFile } from "node:fs/promises"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"
import { validateContentPath } from "./md/frontmatter/validate"
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

function normalizeFrontmatter(input: string): string {
    const lines = input.replace(/\r\n/g, "\n").split("\n")
    while (lines.length > 0 && lines[0].trim() === "---") lines.shift()
    while (lines.length > 0 && lines[lines.length - 1].trim() === "---") lines.pop()
    return lines.join("\n").replace(/^\n+|\n+$/g, "")
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

export function createAutocodeMdFrontmatterEditTool(): ReturnType<typeof tool> {
    return tool({
        description: `Write or remove raw Markdown frontmatter text to local file.`,
        args: {
            path: tool.schema.string().describe("File path. Resolution: cwd-relative match first, then absolute if has separator, then BFS by filename (depth 7, follows symlinks). Wildcard characters (* ? [ ] { }) are not allowed."),
            frontmatter: tool.schema.union([
                tool.schema.string(),
                tool.schema.object({}).loose(),
            ]).describe("Raw frontmatter text OR object serialized to YAML. Empty string/object removes frontmatter."),
        },
        execute: async (args, context) => {
            try {
                if (typeof args.frontmatter !== "string" && (typeof args.frontmatter !== "object" || args.frontmatter === null || Array.isArray(args.frontmatter))) {
                    return createRetryResponse("write markdown frontmatter", "frontmatter must be a string or object.", "Retry with raw frontmatter text or an object.")
                }
                const target = await validateContentPath(args.path, context, "write markdown frontmatter")
                if (!target.ok) return target.response
                if (target.value.mode === "json") return createRetryResponse("write markdown frontmatter", "frontmatter is not supported for JSON/JSONC files.", "Use JSON content tools to edit JSON/JSONC files.")
                if (target.value.mode === "yaml") return createRetryResponse("write markdown frontmatter", "frontmatter is not supported for YAML files.", "Use YAML content tools to edit YAML files.")
                if (target.value.mode === "toml") return createRetryResponse("write markdown frontmatter", "frontmatter is not supported for TOML files.", "Use TOML content tools to edit TOML files.")
                if (target.value.mode === "env") return createRetryResponse("write markdown frontmatter", "frontmatter only supported for Markdown files.", "Use content tools to edit .env files.")
                if (target.value.mode === "ini") return createRetryResponse("write markdown frontmatter", "frontmatter only supported for Markdown files.", "Use content tools to edit config files.")
                const raw = await readFile(target.value.absolutePath, "utf8")
                const frontmatter = splitFrontmatter(raw)
                let normalized: string
                if (typeof args.frontmatter === "string") {
                    normalized = normalizeFrontmatter(args.frontmatter)
                } else {
                    const obj = args.frontmatter as Record<string, unknown>
                    normalized = Object.keys(obj).length === 0 ? "" : yamlParser.stringify(obj).replace(/\n+$/, "")
                }
                const bodyContent = frontmatter.body.replace(/^\n+/, "")
                const nextRaw = normalized.trim() === ""
                    ? frontmatter.body
                    : `---\n${normalized}\n---\n\n${bodyContent}`
                await writeFile(target.value.absolutePath, nextRaw, "utf8")
                return JSON.stringify({ path: target.value.inputPath, hasFrontmatter: normalized.trim() !== "", changed: true, truncated: false })
            }
            catch (error) {
                return createAbortResponse("write markdown frontmatter", toErrorMessage(error))
            }
        },
    })
}
