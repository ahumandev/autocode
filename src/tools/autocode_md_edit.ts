import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync } from "fs"
import path from "path"
import { buildOutline, ownText, parseMarkdown, rebuildFile, resolveSection, slugifyHeading } from "./md/markdown"
import type { MdHeading } from "./md/markdown"
import { adjustLevels, clampIndex, isDescendant, normalizeContentBlock, serializeTree } from "./md/transform"
import { validateMdPath } from "./md/validate"
import { createErrorResponse, createRetryResponse } from "@/utils/tools"
import { formatJobSessionTitle } from "@/utils/jobs"

export function createAutocodeMdEditTool(): ReturnType<typeof tool> {
    return tool({
        description: `Create or edit Markdown sections in md file.
        
Unsure about file_path, anchors or index? Then call autocode_md_read first to read md file outline.`,
        args: {
            file_path: tool.schema.string().describe("Path to md file."),
            current_anchor: tool.schema.string().optional().describe("Determines *create* or *edit*. To *create*: omit current_anchor. To *edit*: provide existing anchor of section to edit. Preamble section (content before first heading) anchor=\"[root]\"."),
            heading: tool.schema.string().optional().describe("Heading text for section. Omit preserve heading."),
            content: tool.schema.string().optional().describe("Content below heading (body text). Omit to preserve content. Sub-sections are always preserved. Do NOT wrap content in XML tags."),
            parent_anchor: tool.schema.string().optional().describe("Move section including sub-sections under different parent by anchor. root anchor = \"[root]\". Set parent_anchor = \"[root]\" and index=0 to set md document main H1 heading. Multiple H1 sections is possible, but ideally md [root] must have only 1 child (only 1 H1 heading). Default for *create*: append to last H1 section as H2 child (preferred for main sections). Default for *edit*: keep parent same."),
            index: tool.schema.number().int().optional().describe("Section position under parent. Omit to preserve position. 0 = first; -1 = last; N = Nth (shift remaining siblings down)."),
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
                if (args.index !== undefined && args.index !== null && args.index < -1) {
                    return createErrorResponse("autocode_md_edit", new Error("invalid index"), `index must be >= -1, got ${args.index}`)
                }
                const hasHeading = args.heading !== undefined && args.heading !== ""
                const hasContent = args.content !== undefined && args.content !== ""
                const hasParent = args.parent_anchor !== undefined && args.parent_anchor !== ""
                const hasIndex = args.index !== undefined && args.index !== null
                const isEdit = args.current_anchor !== undefined
                if (args.current_anchor === "[root]") {
                    const headingsBody = serializeTree(model)
                    let preamble: string
                    if (args.content !== undefined && args.content !== "") {
                        preamble = normalizeContentBlock(args.content)
                    }
                    else {
                        // Preserve existing preamble: text from body start up to first heading.
                        const firstHeadingStart = model.roots[0]?.start ?? model.lineCount + 1
                        const preambleEndLine = Math.max(model.bodyStartLine, firstHeadingStart) - 1
                        const preambleLines = model.lines.slice(model.bodyStartLine - 1, preambleEndLine)
                        preamble = preambleLines.join(model.newline).trim()
                    }
                    let newBody: string
                    if (preamble && headingsBody) {
                        newBody = preamble + "\n\n" + headingsBody
                    } else if (preamble) {
                        newBody = preamble + model.newline
                    } else {
                        newBody = headingsBody
                    }
                    const out = rebuildFile(model, newBody)
                    if (out !== raw) writeFileSync(filePath, out)
                    return JSON.stringify({ file_path: filePath, outline: buildOutline(parseMarkdown(out)) })
                }
                let S: MdHeading | undefined
                if (isEdit) {
                    const current_anchor = args.current_anchor!
                    const res = resolveSection(model, current_anchor)
                    if (!res.ok) {
                        const correctiveAction = res.reason === "none"
                            ? `Section '${args.current_anchor}' was not found in ${filePath}. Run autocode_md_read to refresh keys.`
                            : `Section '${args.current_anchor}' matches multiple sections. Run autocode_md_read and pass the exact key including the [n] postfix.`
                        return createErrorResponse("autocode_md_edit", new Error(res.reason === "none" ? "title not found" : "title ambiguous"), correctiveAction)
                    }
                    S = res.heading

                    // Early no-op: in EDIT mode, when caller provided no field that
                    // changes the section, return success without writing the file.
                    // serializeTree emits a trailing newline that may differ from raw,
                    // so the post-splice `out === raw` byte check cannot be relied on.
                    if (!hasHeading && !hasContent && !hasParent && !hasIndex) {
                        return JSON.stringify({ file_path: filePath, outline: buildOutline(model) })
                    }
                }

                // parent_anchor resolution:
                //   hasParent:
                //     - "[root]" -> root level target (newParentHeading = null)
                //     - other    -> resolve via resolveSection
                //   not provided (undefined or ""):
                //     - CREATE (!isEdit) -> last H1, or placeholder H1 derived from filename if none
                //     - EDIT  (isEdit)   -> keep same parent (newParentHeading stays undefined)
                let newParentHeading: MdHeading | null | undefined = undefined
                if (hasParent) {
                    const parent_anchor = args.parent_anchor!
                    if (isEdit && parent_anchor === args.current_anchor) {
                        return createRetryResponse("autocode_md_edit", new Error("self parent"), "cannot move a section under itself; parent_anchor equals current_anchor - pick a different parent anchor or omit parent_anchor to keep current parent")
                    }
                    if (parent_anchor === "[root]") {
                        newParentHeading = null
                    } else {
                        const pres = resolveSection(model, parent_anchor)
                        if (!pres.ok) {
                            return createErrorResponse("autocode_md_edit", new Error("parent not found"), `new_parent '${args.parent_anchor}' was not found. Run autocode_md_read to list valid keys.`)
                        }
                        newParentHeading = pres.heading
                        if (isEdit && S !== undefined && (newParentHeading === S || isDescendant(newParentHeading, S))) {
                            return createRetryResponse("autocode_md_edit", new Error("cycle"), "parent_anchor is a descendant of current_anchor - this would create a cycle; pick a parent outside this section or use '[root]' to move to top level")
                        }
                    }
                } else if (!isEdit) {
                    const h1Headings = model.headings.filter((h) => h.level === 1 && h.parent === null)
                    const lastH1 = h1Headings[h1Headings.length - 1]
                    if (lastH1) {
                        newParentHeading = lastH1
                    } else {
                        const baseName = path.basename(filePath).replace(/\.md$/i, "")
                        const titleText = formatJobSessionTitle(baseName.replace(/-/g, "_"))
                        const placeholderH1: MdHeading = {
                            title: titleText,
                            level: 1,
                            start: 0,
                            headerEnd: 0,
                            spanEnd: 0,
                            children: [],
                            parent: null,
                            referenceId: slugifyHeading(titleText),
                            marker: "atx",
                        }
                        model.roots.push(placeholderH1)
                        model.headings.push(placeholderH1)
                        newParentHeading = placeholderH1
                    }
                }

                const overrides = new Map<MdHeading, string>()
                for (const h of model.headings) overrides.set(h, ownText(model, h))
                if (!isEdit) {
                    if (!hasHeading) {
                        return createErrorResponse("autocode_md_edit", new Error("missing heading"), "heading is required when adding a new section (current_anchor omitted)")
                    }
                    const heading = args.heading!
                    S = {
                        title: heading,
                        level: newParentHeading ? newParentHeading.level + 1 : 1,
                        start: 0,
                        headerEnd: 0,
                        spanEnd: 0,
                        children: [],
                        parent: newParentHeading ?? null,
                        referenceId: slugifyHeading(heading),
                        marker: "atx",
                    }
                }
                if (S === undefined) {
                    return createErrorResponse("autocode_md_edit", new Error("internal: section not initialized"), "section not initialized; this is a bug")
                }
                if (hasContent) {
                    overrides.set(S, normalizeContentBlock(args.content!))
                }

                const oldList = S.parent ? S.parent.children : model.roots
                const oldIndex = oldList.indexOf(S)
                if (oldIndex >= 0) oldList.splice(oldIndex, 1)

                if (hasHeading) {
                    S.title = args.heading!
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

                const newBody = serializeTree(model, overrides)
                const out = rebuildFile(model, newBody)
                if (out !== raw) writeFileSync(filePath, out)
                return JSON.stringify({ file_path: filePath, outline: buildOutline(parseMarkdown(out)) })
            } catch (error) {
                return createErrorResponse("autocode_md_edit", error, `Could not replace section in ${args.file_path}. Verify the path is writable.`)
            }
        },
    })
}
