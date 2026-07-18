import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync } from "fs"
import { buildOutline, ownText, parseMarkdown, rebuildFile, resolveSection, slugifyHeading } from "./md/markdown"
import type { MdHeading } from "./md/markdown"
import { adjustLevels, clampIndex, isDescendant, parseContentBlocks, serializeTree } from "./md/transform"
import { validateMdPath } from "./md/validate"
import { createErrorResponse, createRetryResponse } from "@/utils/tools"

export function createAutocodeMdUpdateTool(): ReturnType<typeof tool> {
    return tool({
        description: `Update existing Markdown section in md file: rename heading, rewrite content, move under different parent, or reorder among siblings.`,
        args: {
            file_path: tool.schema.string().describe("Path to md file."),
            anchor: tool.schema.string().describe("Anchor of existing section to update. Run autocode_md_read first to find anchors if unsure. Unsure about anchors? Then call autocode_md_read first."),
            heading: tool.schema.string().optional().describe("New heading text. Omit = preserve heading."),
            content: tool.schema.string().optional().describe("New content text below heading. May include own paragraphs and/or new subsections to append after existing subsections. Omit to preserve content. Do NOT wrap in XML tags. Need to remove subsection? Then call autocode_md_remove instead."),
            parent_anchor: tool.schema.string().optional().describe("Move section under different parent via anchor. Omit/empty = keep current parent."),
            index: tool.schema.number().int().optional().describe("New sibling position under parent. 0 = first; -1 = last; N = Nth."),
        },
        execute: async (args, context) => {
            try {
                const validation = await validateMdPath(context, args.file_path, "autocode_md_update", { requireExistence: true })
                if (!validation.ok) return validation.response
                const filePath = validation.value
                const raw = readFileSync(filePath, "utf8")
                const model = parseMarkdown(raw)
                if (args.parent_anchor === "[root]") {
                    return createErrorResponse("autocode_md_update", new Error("invalid parent_anchor"), "parent_anchor \"[root]\" is not supported. To set article title or preamble, use autocode_md_h1. To move under another section, pass that section's anchor.")
                }
                if (args.index !== undefined && args.index !== null && args.index < -1) {
                    return createErrorResponse("autocode_md_update", new Error("invalid index"), `index must be >= -1, got ${args.index}`)
                }
                const hasHeading = args.heading !== undefined && args.heading !== ""
                const hasContent = args.content !== undefined && args.content !== ""
                const hasParent = args.parent_anchor !== undefined && args.parent_anchor !== ""
                const hasIndex = args.index !== undefined && args.index !== null
                if (!hasHeading && !hasContent && !hasParent && !hasIndex) {
                    return JSON.stringify({ file_path: filePath, outline: buildOutline(model) })
                }
                const res = resolveSection(model, args.anchor)
                if (!res.ok) {
                    const correctiveAction = res.reason === "none"
                        ? `Anchor '${args.anchor}' was not found in ${filePath}. Call autocode_md_read to get list of available anchors and try again.`
                        : `Anchor '${args.anchor}' matches multiple sections. Call autocode_md_read to find the exact anchor (look at the [n] postfix) and try again.`
                    return createErrorResponse("autocode_md_update", new Error(res.reason === "none" ? "anchor not found" : "anchor ambiguous"), correctiveAction)
                }
                const S = res.heading
                let newParentHeading: MdHeading | null | undefined = undefined
                if (hasParent) {
                    const parent_anchor = args.parent_anchor!
                    if (parent_anchor === args.anchor) {
                        return createRetryResponse("autocode_md_update", new Error("self parent"), "cannot move a section under itself; parent_anchor equals the section's own anchor - pick a different parent or omit parent_anchor to keep current parent.")
                    }
                    const pres = resolveSection(model, parent_anchor)
                    if (!pres.ok) {
                        return createErrorResponse("autocode_md_update", new Error("parent not found"), `parent_anchor '${args.parent_anchor}' was not found. Call autocode_md_read to list available anchors.`)
                    }
                    newParentHeading = pres.heading
                    if (newParentHeading === S || isDescendant(newParentHeading, S)) {
                        return createRetryResponse("autocode_md_update", new Error("cycle"), "parent_anchor is a descendant of anchor - this creates a cycle. Pick a parent outside this section.")
                    }
                }
                const overrides = new Map<MdHeading, string>()
                for (const h of model.headings) overrides.set(h, ownText(model, h))
                const oldList = S.parent ? S.parent.children : model.roots
                const oldIndex = oldList.indexOf(S)
                if (oldIndex >= 0) oldList.splice(oldIndex, 1)
                if (hasHeading) {
                    S.title = args.heading!
                    S.referenceId = slugifyHeading(args.heading!)
                }
                let targetList: MdHeading[]
                if (newParentHeading !== undefined) {
                    S.parent = newParentHeading
                    const newLevel = newParentHeading ? newParentHeading.level + 1 : 1
                    adjustLevels(S, newLevel - S.level)
                    targetList = newParentHeading ? newParentHeading.children : model.roots
                } else {
                    targetList = S.parent ? S.parent.children : model.roots
                }
                let insertAt: number
                if (hasIndex) {
                    insertAt = clampIndex(args.index!, -1, targetList.length)
                } else if (newParentHeading !== undefined) {
                    insertAt = targetList.length
                } else {
                    insertAt = oldIndex >= 0 ? Math.min(oldIndex, targetList.length) : targetList.length
                }
                targetList.splice(insertAt, 0, S)
                if (hasContent) {
                    const blocks = parseContentBlocks(args.content!, S.level)
                    for (const child of blocks.children) {
                        child.parent = S
                        S.children.push(child)   // append AFTER existing preserved children
                    }
                    for (const [h, text] of blocks.overrides) overrides.set(h, text)
                    overrides.set(S, blocks.intro)
                }
                const newBody = serializeTree(model, overrides)
                const out = rebuildFile(model, newBody)
                if (out !== raw) writeFileSync(filePath, out)
                return JSON.stringify({ file_path: filePath, outline: buildOutline(parseMarkdown(out)) })
            } catch (error) {
                return createErrorResponse("autocode_md_update", error, `Could not update section in ${args.file_path}. Verify path exists and is writable.`)
            }
        },
    })
}
