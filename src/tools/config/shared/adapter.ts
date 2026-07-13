import { readFile, writeFile } from "node:fs/promises"
import { basename, extname } from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import { createRetryResponse } from "@/utils/tools"
import { validateFilePath } from "@/utils/validate_file_path"
import type { ConfigAdapter, ConfigTarget, ConfigMode, RetryResult } from "./types"

export function configModeFromExtension(input: string): ConfigMode | "markdown" | undefined {
    const b = basename(input).toLowerCase()
    if (b === ".env" || b.startsWith(".env.")) return "env"
    const ext = extname(b)
    if (ext === ".md") return "markdown"
    if (ext === ".json" || ext === ".jsonc") return "json"
    if (ext === ".yaml" || ext === ".yml") return "yaml"
    if (ext === ".toml") return "toml"
    if (ext === ".env") return "env"
    if (ext === ".ini" || ext === ".properties" || ext === ".conf") return "ini"
    return undefined
}

export function createLocalConfigAdapter(context?: ToolContext): ConfigAdapter {
    return {
        async validateConfigPath(input: unknown, failedAction: string = "Read configuration file"): Promise<RetryResult<ConfigTarget>> {
            if (typeof input === "string" && input.length > 0) {
                const mode = configModeFromExtension(input)
                if (mode === "markdown") {
                    return { ok: false, response: createRetryResponse(failedAction, new Error("markdown files not supported by config tools"), "use autocode_md_* tools for markdown files") }
                }
                if (!mode) {
                    return { ok: false, response: createRetryResponse(failedAction, new Error(`unsupported file extension: ${input}`), "Use .json/.jsonc/.yaml/.yml/.toml/.ini/.properties/.conf/.env") }
                }
            }
            const result = await validateFilePath(input, {
                failedAction,
                context,
                existence: "bare-filename-only",
            })
            if (!result.ok) return result
            return { ok: true, value: { absolutePath: result.value, mode: configModeFromExtension(input as string) as ConfigMode } }
        },
        async read(target: ConfigTarget): Promise<string> {
            return readFile(target.absolutePath, "utf8")
        },
        async write(target: ConfigTarget, raw: string): Promise<void> {
            await writeFile(target.absolutePath, raw, "utf8")
        },
        parseStringContent: false
    }
}
