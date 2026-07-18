import { tool } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync } from "fs"
import { buildOutline, ownText, parseMarkdown, rebuildFile, slugifyHeading } from "./md/markdown"
import type { MdHeading } from "./md/markdown"
import { normalizeContentBlock, serializeTree } from "./md/transform"
import { validateMdPath } from "./md/validate"
import { createErrorResponse } from "@/utils/tools"

export function createAutocodeMdH1Tool(): ReturnType<typeof tool> {
    return tool({
        description: `Set Markdown title in md file: article title (H1 heading), preamble (text before H1), intro content (text directly after H1). If missing H1 section: creates new. If multiple H1 sections: update first H1 section. Subsections are preserved. Frontmatter untouched.`,
        args: {
            file_path: tool.schema.string().describe("Path to md file."),
            preamble: tool.schema.string().optional().describe("Text before H1 heading (file preamble). Omit = preserve existing preamble. Do NOT wrap in XML tags."),
            title: tool.schema.string().optional().describe("First H1 heading in md. Omit = preserve existing H1 heading."),
            intro: tool.schema.string().optional().describe("Intro text directly after H1 heading, before any subsections. Omit = preserve existing intro. Do NOT wrap in XML tags."),
        },
        execute: async (args, context) => {
            try {
                const validation = await validateMdPath(context, args.file_path, "autocode_md_h1")
                if (!validation.ok) return validation.response
                const filePath = validation.value
                let raw: string
                try {
                    raw = readFileSync(filePath, "utf8")
                } catch {
                    raw = ""
                }
                const model = parseMarkdown(raw)
                const hasTitle = args.title !== undefined && args.title !== ""
                const hasIntro = args.intro !== undefined && args.intro !== ""
                const hasPreamble = args.preamble !== undefined && args.preamble !== ""
                if (!hasTitle && !hasIntro && !hasPreamble) {
                    return JSON.stringify({ file_path: filePath, outline: buildOutline(model) })
                }
                const existingH1 = model.headings.filter((h) => h.level === 1)[0]
                let newPreamble: string
                if (hasPreamble) {
                    newPreamble = normalizeContentBlock(args.preamble!)
                } else {
                    const firstHeadingStart = model.roots[0]?.start ?? model.lineCount + 1
                    const preambleEndLine = Math.max(model.bodyStartLine, firstHeadingStart) - 1
                    const preambleLines = model.lines.slice(model.bodyStartLine - 1, preambleEndLine)
                    newPreamble = preambleLines.join(model.newline).trim()
                }
                let newTitle: string
                if (hasTitle) {
                    newTitle = args.title!
                } else if (existingH1) {
                    newTitle = existingH1.title
                } else {
                    return createErrorResponse("autocode_md_h1", new Error("missing title"), "title is required when there is no H1 in file yet; call autocode_md_h1 with title argument first.")
                }
                let newIntro: string
                if (hasIntro) {
                    newIntro = normalizeContentBlock(args.intro!)
                } else if (existingH1) {
                    newIntro = ownText(model, existingH1)
                } else {
                    newIntro = ""
                }
                let h1: MdHeading
                if (existingH1) {
                    existingH1.title = newTitle
                    existingH1.referenceId = slugifyHeading(newTitle)
                    h1 = existingH1
                } else {
                    h1 = {
                        title: newTitle,
                        level: 1,
                        start: 0,
                        headerEnd: 0,
                        spanEnd: 0,
                        children: [],
                        parent: null,
                        referenceId: slugifyHeading(newTitle),
                        marker: "atx",
                    }
                    model.roots.unshift(h1)
                    model.headings.push(h1)
                }
                const overrides = new Map<MdHeading, string>()
                for (const h of model.headings) overrides.set(h, ownText(model, h))
                if (hasIntro) overrides.set(h1, newIntro)
                const body = serializeTree(model, overrides)
                let newBody: string
                if (newPreamble && body) {
                    newBody = newPreamble + "\n\n" + body
                } else if (newPreamble) {
                    newBody = newPreamble + model.newline
                } else {
                    newBody = body
                }
                const out = rebuildFile(model, newBody)
                if (out !== raw) writeFileSync(filePath, out)
                return JSON.stringify({ file_path: filePath, outline: buildOutline(parseMarkdown(out)) })
            } catch (error) {
                return createErrorResponse("autocode_md_h1", error, `Could not replace article title block in ${args.file_path}. Verify path is writable.`)
            }
        },
    })
}
