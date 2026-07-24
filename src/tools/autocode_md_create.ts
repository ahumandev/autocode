import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync } from "node:fs"
import { buildOutline, ownText, parseMarkdown, rebuildFile, resolveSection, slugifyHeading } from "./md/markdown"
import type { MdHeading } from "./md/markdown"
import { clampIndex, parseContentBlocks, serializeTree } from "./md/transform"
import { validateMdPath } from "./md/validate"
import { createErrorResponse } from "@/utils/tools"

export function createAutocodeMdCreateTool(): ReturnType<typeof tool> {
    return tool({
        description: `Add Markdown section (heading + content text) in md file.`,
        args: {
            file_path: tool.schema.string().describe("Path to md file."),
            heading: tool.schema.string().describe("Heading text for new section."),
            content: tool.schema.string().optional().describe("Content below the heading. May include own paragraphs and/or subsections (any heading level inside content is rebased so the topmost content heading becomes a direct subsection at this section's level + 1). Do NOT wrap content in XML tags."),
            parent_anchor: tool.schema.string().optional().describe("Anchor of parent section. Omit/empty = last H1 if any, else root level. Must resolve to existing anchor. Unsure about anchors? Then call autocode_md_read first."),
            index: tool.schema.number().int().optional().describe("Section position under parent. 0 = first; -1 = last; N = Nth (shifts siblings down)."),
        },
        execute: async (args, context) => {
            try {
                const validation = await validateMdPath(context, args.file_path, "autocode_md_create")
                if (!validation.ok) return validation.response
                const filePath = validation.value
                let raw: string
                try {
                    raw = readFileSync(filePath, "utf8")
                } catch {
                    raw = ""
                }
                const model = parseMarkdown(raw)
                if (args.index !== undefined && args.index !== null && args.index < -1) {
                    return createErrorResponse("autocode_md_create", new Error("invalid index"), `index must be >= -1, got ${args.index}`)
                }
                const hasHeading = args.heading !== undefined && args.heading !== ""
                if (!hasHeading) {
                    return createErrorResponse("autocode_md_create", new Error("missing heading"), "heading is required to create a new section.")
                }
                const hasContent = args.content !== undefined && args.content !== ""
                const hasParent = args.parent_anchor !== undefined && args.parent_anchor !== ""
                const hasIndex = args.index !== undefined && args.index !== null
                let newParentHeading: MdHeading | null
                if (hasParent) {
                    const pres = resolveSection(model, args.parent_anchor ?? "")
                    if (!pres.ok) {
                        return createErrorResponse("autocode_md_create", new Error("parent not found"), `parent_anchor '${args.parent_anchor}' was not found. Run autocode_md_read to list valid anchors.`)
                    }
                    newParentHeading = pres.heading
                } else {
                    const h1s = model.headings.filter((h) => h.level === 1 && h.parent === null)
                    const lastH1 = h1s[h1s.length - 1]
                    newParentHeading = lastH1 ?? null
                }
                const level = newParentHeading ? newParentHeading.level + 1 : 2
                const S: MdHeading = {
                    title: args.heading ?? "",
                    level,
                    start: 0,
                    headerEnd: 0,
                    spanEnd: 0,
                    children: [],
                    parent: newParentHeading,
                    referenceId: slugifyHeading(args.heading ?? ""),
                    marker: "atx",
                }
                const overrides = new Map<MdHeading, string>()
                for (const h of model.headings) overrides.set(h, ownText(model, h))
                if (hasContent) {
                    const blocks = parseContentBlocks(args.content ?? "", S.level)
                    // attach rebased subsections as children of S (in order)
                    for (const child of blocks.children) {
                        child.parent = S
                        S.children.push(child)
                    }
                    // merge content overrides into main overrides map
                    for (const [h, text] of blocks.overrides) overrides.set(h, text)
                    // S's own text becomes content preamble (intro); empty string if no sub-headings present and content had none either
                    overrides.set(S, blocks.intro)
                } else {
                    overrides.set(S, "")
                }
                const targetList = newParentHeading ? newParentHeading.children : model.roots
                const insertAt = hasIndex ? clampIndex(args.index, targetList.length, targetList.length) : targetList.length
                targetList.splice(insertAt, 0, S)
                model.headings.push(S)
                const newBody = serializeTree(model, overrides)
                const out = rebuildFile(model, newBody)
                if (out !== raw) writeFileSync(filePath, out)
                return JSON.stringify({ file_path: filePath, outline: buildOutline(parseMarkdown(out)) })
            } catch (error) {
                return createErrorResponse("autocode_md_create", error, `Could not create section in ${args.file_path}. Verify path is writable.`)
            }
        },
    })
}
