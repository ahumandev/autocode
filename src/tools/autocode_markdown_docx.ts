import { tool } from "@opencode-ai/plugin"
import { convertMarkdownToBuffer } from "@mohtasham/md-to-docx"
import { readFileSync, writeFileSync } from "node:fs"
import { validateMdPath } from "./md/validate"
import { createErrorResponse } from "@/utils/tools"

export function createAutocodeMdDocxTool(): ReturnType<typeof tool> {
    return tool({
        description: "Convert Markdown file to sibling docx file.",
        args: {
            file_path: tool.schema.string().describe("Path to md file to convert to docx."),
        },
        execute: async (args, context) => {
            try {
                const validation = await validateMdPath(context, args.file_path, "autocode_markdown_docx", { requireExistence: true })
                if (!validation.ok) {
                    return createErrorResponse("autocode_markdown_docx", new Error("invalid Markdown path"), "Provide an existing file_path ending in .md.")
                }
                const sourcePath = validation.value
                if (!sourcePath.toLowerCase().endsWith(".md")) {
                    return createErrorResponse("autocode_markdown_docx", new Error("invalid Markdown path"), "Provide an existing file_path ending in .md.")
                }

                const markdown = readFileSync(sourcePath, "utf8")
                const buffer = await convertMarkdownToBuffer(markdown)
                const outputPath = sourcePath.replace(/\.md$/i, ".docx")
                writeFileSync(outputPath, buffer)

                return JSON.stringify({ output_path: outputPath })
            } catch (error) {
                return createErrorResponse("autocode_markdown_docx", error, `Could not convert ${args.file_path} to DOCX. Verify the Markdown file exists and the destination is writable.`)
            }
        },
    })
}
