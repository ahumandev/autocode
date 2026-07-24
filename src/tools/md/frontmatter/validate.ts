import path from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import { createRetryResponse } from "@/utils/tools"
import { validateFilePath } from "@/utils/validate_file_path"

export type ContentMode = "markdown" | "json" | "yaml" | "env" | "ini" | "toml"

export type ContentTarget = {
    inputPath: string
    absolutePath: string
    mode: ContentMode
}

export type ContentPathValidationResult =
    | { ok: true, value: ContentTarget }
    | { ok: false, response: string }

export function contentModeFromExtension(input: string): ContentMode | undefined {
    const basename = path.basename(input).toLowerCase()
    if (basename === ".env" || basename.startsWith(".env.")) return "env"
    const extension = path.extname(input).toLowerCase()
    if (extension === ".md") return "markdown"
    if (extension === ".json" || extension === ".jsonc") return "json"
    if (extension === ".yaml" || extension === ".yml") return "yaml"
    if (extension === ".toml") return "toml"
    if (extension === ".env") return "env"
    if (extension === ".ini" || extension === ".properties" || extension === ".conf") return "ini"
    return undefined
}

export async function validateContentPath(
    input: unknown,
    context?: ToolContext,
    failedAction: string = "validate content path",
): Promise<ContentPathValidationResult> {
    if (typeof input === "string" && input.includes("\0")) {
        return { ok: false, response: createRetryResponse(failedAction, "path must not contain NUL bytes.", "Provide a relative .md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf file path within the current working directory.") }
    }
    const mode = typeof input === "string" && input.trim() !== "" ? contentModeFromExtension(input) : undefined
    if (typeof input === "string" && input.trim() !== "" && !mode) {
        return { ok: false, response: createRetryResponse(failedAction, "path must use .md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf extension/name.", "Retry with a Markdown, JSON, JSONC, YAML, TOML, .env, INI, properties, or .conf file path.") }
    }
    const result = await validateFilePath(input, {
        failedAction,
        context,
        existence: "always",
        requireContextForExternalPaths: true,
    })
    if (!result.ok) return result
    if (typeof input !== "string" || !mode) return { ok: false, response: createRetryResponse(failedAction, "path must use a supported extension/name.", "Retry with a supported content file path.") }
    return { ok: true, value: { inputPath: input, absolutePath: result.value, mode } }
}
