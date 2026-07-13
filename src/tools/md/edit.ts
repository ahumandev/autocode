import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync } from "fs"
import { buildOutline, ownText, parseMarkdown, rebuildFile, resolveSection, slugifyHeading } from "./shared/markdown"
import type { MdHeading } from "./shared/markdown"
import { adjustLevels, clampIndex, isDescendant, normalizeContentBlock, serializeTree } from "./shared/transform"
import { validateMdPath } from "./shared/validate"
import { createErrorResponse, createRetryResponse } from "@/utils/tools"

export function createAutocodeMdEditTool(): ReturnType<typeof tool> {
    return tool({
        description: `Create or edit Markdown sections in md file.`,
        args: {
            file_path: tool.schema.string().describe("Path to md file. Unsure? Use autocode_md_read to list available files."),
            current_anchor: tool.schema.string().optional().describe("Markdown anchor of section to edit. \"[root]\" edit preamble (content before first heading). Omit to create a new section."),
            heading: tool.schema.string().optional().describe("Heading text for section. Omit to keep same or create preamble."),
            content: tool.schema.string().optional().describe("New own-text body for the section. Sub-section content is preserved. Omit for move/rename-only operations."),
            parent_anchor: tool.schema.string().optional().describe("Move section including sub-sections under different parent by anchor. \"[root]\" moves to root of md. Default: keep current parent for existing, root for new."),
            index: tool.schema.number().int().optional().describe("Sibling section position on same level under same parent. Omit = keep current (or append on move); 0 = first; -1 = last; N = Nth."),
        },
        execute: async (args, context) => {
            try {
                const validation = await validateMdPath(context, args.file_path, "autocode_md_edit")
                if (!validation.ok) return validation.response
                const filePath = validation.value
                let raw: string
                try {
                    raw = readFileSync(filePath, "utf8")
                } catch {
                    raw = ""
                }
                const model = parseMarkdown(raw)
                if (args.current_anchor === "[root]") {
                    const newContent = normalizeContentBlock(args.content ?? "")
                    const headingsBody = serializeTree(model)
                    let newBody: string
                    if (newContent && headingsBody) {
                        newBody = newContent + "\n\n" + headingsBody
                    } else if (newContent) {
                        newBody = newContent + model.newline
                    } else {
                        newBody = headingsBody
                    }
                    const out = rebuildFile(model, newBody)
                    writeFileSync(filePath, out)
                    return JSON.stringify({ file_path: filePath, outline: buildOutline(parseMarkdown(out)) })
                }
                let S: MdHeading | undefined = undefined
                if (args.current_anchor !== undefined) {
                    const res = resolveSection(model, args.current_anchor)
                    if (!res.ok) {
                        const correctiveAction = res.reason === "none"
                            ? `Section '${args.current_anchor}' was not found in ${filePath}. Run autocode_md_read to refresh keys.`
                            : `Section '${args.current_anchor}' matches multiple sections. Run autocode_md_read and pass the exact key including the [n] postfix.`
                        return createErrorResponse("autocode_md_edit", new Error(res.reason === "none" ? "title not found" : "title ambiguous"), correctiveAction)
                    }
                    S = res.heading
                }

                let newParentHeading: MdHeading | null | undefined = undefined
                if (args.parent_anchor !== undefined) {
                    if (args.current_anchor !== undefined && args.parent_anchor === args.current_anchor) {
                        return createRetryResponse("autocode_md_edit", new Error("self parent"), "cannot move a section under itself; parent_anchor equals current_anchor - pick a different parent anchor or omit parent_anchor to keep current parent")
                    }
                    if (args.parent_anchor === "" || args.parent_anchor === "[root]") {
                        newParentHeading = null
                    } else {
                        const pres = resolveSection(model, args.parent_anchor)
                        if (!pres.ok) {
                            return createErrorResponse("autocode_md_edit", new Error("parent not found"), `new_parent '${args.parent_anchor}' was not found. Run autocode_md_read to list valid keys.`)
                        }
                        newParentHeading = pres.heading
                        if (S !== undefined && (newParentHeading === S || isDescendant(newParentHeading, S))) {
                            return createRetryResponse("autocode_md_edit", new Error("cycle"), "parent_anchor is a descendant of current_anchor - this would create a cycle; pick a parent outside this section or use '[root]' to move to top level")
                        }
                    }
                }

                const overrides = new Map<MdHeading, string>()
                for (const h of model.headings) overrides.set(h, ownText(model, h))
                if (S === undefined) {
                    if (args.heading === undefined || args.heading === "") {
                        return createErrorResponse("autocode_md_edit", new Error("missing heading"), "heading is required when adding a new section (current_anchor omitted)")
                    }
                    S = {
                        title: args.heading,
                        level: newParentHeading ? newParentHeading.level + 1 : 1,
                        start: 0,
                        headerEnd: 0,
                        spanEnd: 0,
                        children: [],
                        parent: newParentHeading ?? null,
                        referenceId: slugifyHeading(args.heading),
                        marker: "atx",
                    }
                }
                if (args.content !== undefined && args.content !== "") {
                    overrides.set(S, normalizeContentBlock(args.content))
                }

                const oldList = S.parent ? S.parent.children : model.roots
                const oldIndex = oldList.indexOf(S)
                if (oldIndex >= 0) oldList.splice(oldIndex, 1)

                if (args.heading !== undefined && args.heading !== "") {
                    S.title = args.heading
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
                if (args.index !== undefined && args.index !== null) {
                    insertAt = clampIndex(args.index, -1, targetList.length)
                } else if (newParentHeading !== undefined) {
                    insertAt = targetList.length
                } else {
                    insertAt = oldIndex >= 0 ? Math.min(oldIndex, targetList.length) : targetList.length
                }
                targetList.splice(insertAt, 0, S)

                const newBody = serializeTree(model, overrides)
                const out = rebuildFile(model, newBody)
                writeFileSync(filePath, out)
                return JSON.stringify({ file_path: filePath, outline: buildOutline(parseMarkdown(out)) })
            } catch (error) {
                return createErrorResponse("autocode_md_edit", error, `Could not replace section in ${args.file_path}. Verify the path is writable.`)
            }
        },
    })
}
