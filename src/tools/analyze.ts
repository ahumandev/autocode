import { tool, ToolDefinition, PluginInput } from "@opencode-ai/plugin"
import path from "path"

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
            const analyzeDir = path.join(context.worktree, ".autocode", "analyze")
            const { readdir, readFile } = await import("fs/promises")
            const entries = await readdir(analyzeDir).catch(() => [] as string[])
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
                        // skip unreadable files
                    }
                }),
            )

            if (results.length === 0) {
                return "No files found in .autocode/analyze/"
            }
            return JSON.stringify(results, null, 2)
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
            const analyzeDir = path.join(context.worktree, ".autocode", "analyze")
            const filePath = path.join(analyzeDir, args.file_name)
            const { readFile } = await import("fs/promises")
            try {
                const content = await readFile(filePath, "utf-8")
                // Update the current session title to the filename after a successful read
                await client.session.update({
                    path: { id: context.sessionID },
                    body: { title: args.file_name },
                    throwOnError: true,
                })
                return content
            } catch (err: any) {
                return `❌ Failed to read file '${args.file_name}': ${err.message}`
            }
        },
    })

    return { autocode_analyze_list, autocode_analyze_read }
}
