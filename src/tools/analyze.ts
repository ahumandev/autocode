import { tool, ToolDefinition, PluginInput } from "@opencode-ai/plugin"
import path from "path"
import {
    validateNonEmpty,
    retryResponse,
    abortResponse,
    successResponse,
} from "@/utils/validation"

type Client = PluginInput["client"]

/**
 * Tools for browsing and reading idea files in .autocode/analyze/.
 * The client is captured at plugin-init time and passed in here via closure.
 */
export function createAnalyzeTools(client: Client): Record<string, ToolDefinition> {

    const autocode_analyze_list: ToolDefinition = tool({
        description:
            "List all files in the .autocode/analyze/ directory, each with their name and a short description (first non-empty line, up to 100 characters)",
        args: {},
        async execute(_args, context) {
            const sid = context.sessionID
            const toolName = "autocode_analyze_list"
            const analyzeDir = path.join(context.worktree, ".autocode", "analyze")
            const { readdir, readFile } = await import("fs/promises")

            let entries: string[]
            try {
                entries = await readdir(analyzeDir)
            } catch (err: any) {
                // Directory does not exist or is unreadable — treat as empty (normal state)
                if (err.code === "ENOENT") {
                    return successResponse(sid, toolName, "No files found in .autocode/analyze/")
                }
                return abortResponse(toolName, `failed to read .autocode/analyze/ directory: ${err.message}`)
            }

            const files = entries.filter((e) => !e.startsWith("."))
            const results: { name: string; description: string }[] = []

            await Promise.all(
                files.map(async (file) => {
                    const filePath = path.join(analyzeDir, file)
                    try {
                        const content = await readFile(filePath, "utf-8")
                        const firstLine = content
                            .split("\n")
                            .map((l) => l.trim())
                            .find((l) => l.length > 0) ?? ""
                        const description = firstLine.length > 100 ? firstLine.slice(0, 100) + "..." : firstLine
                        results.push({ name: file, description })
                    } catch {
                        // skip individual unreadable files — others may still be listed
                    }
                }),
            )

            return successResponse(sid, toolName, results)
        },
    })

    const autocode_analyze_read: ToolDefinition = tool({
        description:
            "Read the content of a selected idea file from the .autocode/analyze/ directory",
        args: {
            file_name: tool.schema
                .string()
                .describe("File name to read from .autocode/analyze/"),
        },
        async execute(args, context) {
            const sid = context.sessionID
            const toolName = "autocode_analyze_read"

            // ── input validation ──────────────────────────────────────────────
            const fileNameErr = validateNonEmpty(args.file_name, sid, toolName, "file_name")
            if (fileNameErr) return fileNameErr

            const analyzeDir = path.join(context.worktree, ".autocode", "analyze")
            const filePath = path.join(analyzeDir, args.file_name)
            const { readFile } = await import("fs/promises")

            let content: string
            try {
                content = await readFile(filePath, "utf-8")
            } catch (err: any) {
                if (err.code === "ENOENT") {
                    return retryResponse(
                        sid,
                        toolName,
                        "file_name",
                        `be a file that exists in .autocode/analyze/ — '${args.file_name}' was not found; call autocode_analyze_list to see available files`,
                    )
                }
                return abortResponse(toolName, `failed to read '${args.file_name}': ${err.message}`)
            }

            // Update the current session title to the filename — non-critical, ignore failure
            client.session.update({
                path: { id: context.sessionID },
                body: { title: args.file_name },
                throwOnError: true,
            }).catch(() => {
                // Session title update is best-effort; do not surface this error
            })

            return successResponse(sid, toolName, content)
        },
    })

    return { autocode_analyze_list, autocode_analyze_read }
}
