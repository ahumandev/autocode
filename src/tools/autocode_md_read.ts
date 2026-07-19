import { tool } from "@opencode-ai/plugin"
import { readFileSync } from "fs"
import { expandGlob } from "@/utils/glob"
import { ownText, parseMarkdown } from "./md/markdown"
import { createRetryResponse } from "@/utils/tools"

const DEFAULT_MAX_ANCHORS = 40
const DEFAULT_MAX_CONTENT_CHARS = 0

export function createAutocodeMdReadTool(): ReturnType<typeof tool> {
    return tool({
        description: `Grep find content in md files or read markdown files by glob search pattern.
        
## autocode_md_read USAGE:

ALWAYS avoid reading too much md text!

1. Discover md read filters:
    - file path known? → Set file_path_glob = exact path (no globs)
    - line number/range known? → Set \`line_start\`, \`line_end\` args
    - context text to lookup is known? → Set context_regex
    - heading or anchor known? → Set anchor_regex
2. Call \`autocode_md_read\` with \`max_content_chars=0\` (and filters if known) → You only receive headings, anchors, and line numbers without body content.
3. No anchors? → Drop/Widen filters and try again.
4. To many anchors (5+)? → Add/Narrow filters and try again.
5. < 5 results? → Call \`autocode_md_read\` with same args except max_content_chars = 4000 to preview content.
6. Content truncated? → Call \`autocode_md_read\` with more strict filters and larger max_content_chars
7. Found content? → Use anchor in followup \`autocode_md_*\` tools

## autocode_md_read OUTPUT:

Returns JSON: \`{ file_paths: { [fileKey: string]: Section[] } }\`. Each Section has:

1. \`anchor\` (string): GitHub MD anchor (lowercase, dashes).
2. \`line_of_heading\` (number): 1-based start line of section heading in the md file.
3. \`line_count\` (number): total lines from heading line up to (not including) the first subsection heading. If section has no subsections, returns lines from heading to end of file.
4. \`index\` (number): sibling position under same parent.
5. \`content\` (string, optional): content text (excludes subsections); Truncated content replaced by "...".

Example:
\`\`\`json
{ "file_paths": { "docs/api.md": [{ "anchor": "auth", "line_of_heading": 12, "line_count": 4, "index": 0 }] } }
\`\`\`
`,
        args: {
            file_path_glob: tool.schema.string().describe("Glob pattern for Markdown files, e.g. 'docs/**/*.md'."),
            line_start: tool.schema.number().int().min(1).default(1).optional().describe("Optional filter from start line of md. Default 1."),
            line_end: tool.schema.number().int().min(1).default(Number.MAX_SAFE_INTEGER).optional().describe("Optional filter from end line of md file. Default = last line."),
            anchor_regex: tool.schema.string().optional().describe("Regex; find sections whose anchor matches it (GitHub MD standard). Default = all."),
            content_regex: tool.schema.string().optional().describe("Regex; find sections whose own text content matches it. Default = all."),
            max_anchors: tool.schema.number().int().min(2).max(100).optional().default(DEFAULT_MAX_ANCHORS).describe("Cap on number of anchors returned per file."),
            max_content_chars: tool.schema.number().int().min(0).max(20000).optional().default(DEFAULT_MAX_CONTENT_CHARS).describe("Cap on number of content chars returned in total for all matches. Set to 0 to return only md outlines."),
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

            if (!context.directory) {
                throw new Error("autocode_md_read: context.directory (project directory) is required but was not provided by host")
            }
            const cwd = context.directory
            const matches = await expandGlob(String(args.file_path_glob), cwd, { accessHidden: true })
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

            const file_paths: Record<string, { anchor: string; line_of_heading: number; line_count: number; index: number; content?: string }[]> = {}
            if (maxContentChars <= 0) {
                for (const { key, model, filtered } of collected) {
                    const shown = filtered.slice(0, maxKeys)
                    file_paths[key] = shown.map((h) => {
                        const siblingList = h.parent ? h.parent.children : model.roots
                        return {
                            anchor: h.referenceId,
                            line_of_heading: h.start,
                            line_count: h.children.length > 0 ? h.children[0].start - h.start : model.lineCount - h.start + 1,
                            index: siblingList.indexOf(h),
                        }
                    })
                }
            } else {
                // Pass 1: flatten all shown sections across files into one list (file then heading order preserved).
                type Section = {
                    key: string
                    anchor: string
                    line_of_heading: number
                    line_count: number
                    index: number
                    full: string
                    final: string
                    settled: boolean
                }
                const sections: Section[] = []
                for (const { key, model, filtered } of collected) {
                    const shown = filtered.slice(0, maxKeys)
                    for (const h of shown) {
                        const siblingList = h.parent ? h.parent.children : model.roots
                        sections.push({
                            key,
                            anchor: h.referenceId,
                            line_of_heading: h.start,
                            line_count: h.children.length > 0 ? h.children[0].start - h.start : model.lineCount - h.start + 1,
                            index: siblingList.indexOf(h),
                            full: ownText(model, h),
                            final: "",
                            settled: false,
                        })
                    }
                }

                // Pass 2: water-filling fair distribution. Small sections keep full content and free leftover share; large ones get capped at share.
                if (sections.length > 0) {
                    let budget = maxContentChars
                    let progressed = true
                    while (progressed && sections.some((s) => !s.settled) && budget > 0) {
                        const unsettled = sections.filter((s) => !s.settled)
                        const share = Math.floor(budget / unsettled.length)
                        if (share <= 0) break

                        // Sub-pass 1: sections fitting entirely within share keep full
                        // content, settle, and free leftover budget for remaining larger sections.
                        progressed = false
                        for (const s of unsettled) {
                            if (s.full.length <= share) {
                                s.final = s.full
                                s.settled = true
                                budget -= s.full.length
                                progressed = true
                            }
                        }
                        // Sub-pass 2: only when no small section settled this round -> every
                        // remaining section exceeds share, so cap each to share and settle.
                        if (!progressed) {
                            for (const s of unsettled) {
                                if (!s.settled) {
                                    s.final = s.full.slice(0, share)
                                    s.settled = true
                                    budget -= s.final.length
                                }
                            }
                        }
                    }

                    // Group into file_paths preserving section order (file then heading).
                    for (const s of sections) {
                        if (!file_paths[s.key]) file_paths[s.key] = []
                        file_paths[s.key].push({
                            anchor: s.anchor,
                            line_of_heading: s.line_of_heading,
                            line_count: s.line_count,
                            index: s.index,
                            content: s.final,
                        })
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
