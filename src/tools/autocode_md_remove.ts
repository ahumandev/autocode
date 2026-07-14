import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync } from "fs"
import { buildOutline, ownText, parseMarkdown, rebuildFile, resolveSection } from "./md/markdown"
import type { MdHeading } from "./md/markdown"
import { serializeTree } from "./md/transform"
import { validateMdPath } from "./md/validate"
import { createErrorResponse } from "@/utils/tools"

export function createAutocodeMdRemoveTool(): ReturnType<typeof tool> {
    return tool({
        description: `Remove markdown section together with its entire subtree.
        
Unsure about file_path or anchors? Call autocode_md_read first to read outline.`,
        args: {
            file_path: tool.schema.string().describe("Path to md file."),
            anchor: tool.schema.string().describe("MD heading anchor of section to remove."),
        },
        execute: async (args, context) => {
            try {
                const validation = await validateMdPath(context, args.file_path, "autocode_md_remove", { requireExistence: true })
                if (!validation.ok) return validation.response
                const filePath = validation.value
                const raw = readFileSync(filePath, "utf8")
                const model = parseMarkdown(raw)
                const res = resolveSection(model, args.anchor)
                if (!res.ok) {
                    const correctiveAction = res.reason === "none"
                        ? `Section '${args.anchor}' was not found in ${filePath}. Run autocode_md_read to refresh keys.`
                        : `Section '${args.anchor}' matches multiple sections. Run autocode_md_read and pass the exact key including the [n] postfix.`
                    return createErrorResponse("autocode_md_remove", new Error(res.reason === "none" ? "anchor not found" : "anchor ambiguous"), correctiveAction)
                }
                const S = res.heading

                const list = S.parent ? S.parent.children : model.roots
                const idx = list.indexOf(S)

                const overrides = new Map<MdHeading, string>()
                for (const h of model.headings) overrides.set(h, ownText(model, h))

                if (idx >= 0) list.splice(idx, 1)

                const newBody = serializeTree(model, overrides)
                const out = rebuildFile(model, newBody)
                writeFileSync(filePath, out)
                return JSON.stringify({ file_path: filePath, outline: buildOutline(parseMarkdown(out)) })
            } catch (error) {
                return createErrorResponse("autocode_md_remove", error, `Could not remove section in ${args.file_path}. Verify the path exists and is writable.`)
            }
        },
    })
}
