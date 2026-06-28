import { readFile, stat, writeFile } from "fs/promises"
import path from "path"
import type { ToolContext } from "@opencode-ai/plugin"
import { createRetryResponse } from "@/utils/tools"
import { authorizeExternalContentPath } from "@/utils/external_directory"
import type { ContentMode, ContentTarget, RetryResult } from "./types"

export type ContentAdapter = {
    validateContentPath(input: unknown): Promise<RetryResult<ContentTarget>>
    validateMarkdownPath(input: unknown): Promise<RetryResult<ContentTarget>>
    read(target: ContentTarget): Promise<string>
    write(target: ContentTarget, raw: string): Promise<void>
}

export function createLocalFilesystemContentAdapter(context?: ToolContext): ContentAdapter {
    return {
        validateContentPath: (input) => validateContentPath(input, context),
        validateMarkdownPath,
        async read(target: ContentTarget): Promise<string> {
            return readFile(target.absolutePath, "utf8")
        },
        async write(target: ContentTarget, raw: string): Promise<void> {
            await writeFile(target.absolutePath, raw, "utf8")
        },
    }
}

async function validateContentPath(input: unknown, context?: ToolContext): Promise<RetryResult<ContentTarget>> {
    const failedAction = "validate content path"
    if (typeof input !== "string" || input.trim() === "") {
        return { ok: false, response: createRetryResponse(failedAction, "path must be a non-empty string.", "Provide a relative .md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf file path within the current working directory.") }
    }

    if (input.includes("\0")) {
        return { ok: false, response: createRetryResponse(failedAction, "path must not contain NUL bytes.", "Provide a relative .md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf file path within the current working directory.") }
    }

    const mode = contentModeFromExtension(input)
    if (!mode) return { ok: false, response: createRetryResponse(failedAction, "path must use .md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf extension/name.", "Retry with a Markdown, JSON, JSONC, YAML, TOML, .env, INI, properties, or .conf file path.") }

    const cwd = process.cwd()
    const absolutePath = path.resolve(cwd, input)
    const relative = path.relative(cwd, absolutePath)
    if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        const fileStat = await stat(absolutePath).catch(() => undefined)
        if (!fileStat?.isFile()) {
            return { ok: false, response: createRetryResponse(failedAction, `Content file not found: ${input}`, "Retry with an existing .md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf file path.") }
        }
        return { ok: true, value: { inputPath: input, absolutePath, mode } }
    }

    if (!context) {
        return { ok: false, response: createRetryResponse(failedAction, "path must stay inside the current working directory.", "Provide a relative .md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf file path without escaping via '..'.") }
    }

    const auth = await authorizeExternalContentPath(context, absolutePath, failedAction)
    if (!auth.ok) return auth

    const fileStat = await stat(absolutePath).catch(() => undefined)
    if (!fileStat?.isFile()) {
        return { ok: false, response: createRetryResponse(failedAction, `Content file not found: ${input}`, "Retry with an existing .md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf file path.") }
    }
    return { ok: true, value: { inputPath: input, absolutePath, mode } }
}

async function validateMarkdownPath(input: unknown): Promise<RetryResult<ContentTarget>> {
    const target = await validateContentPath(input)
    if (!target.ok) return target
    if (target.value.mode !== "markdown") return { ok: false, response: createRetryResponse("validate content path", "path must use .md extension.", "Retry with a Markdown file path ending in .md.") }
    return target
}

export function contentModeFromExtension(input: string): ContentMode | undefined {
    const basename = path.basename(input).toLowerCase()
    if (basename === ".env" || basename.startsWith(".env.")) return "env"
    const extension = path.extname(input).toLowerCase()
    if (extension === ".md") return "markdown"
    if (extension === ".json" || extension === ".jsonc") return "json"
    if (extension === ".yaml" || extension === ".yml") return "yaml"
    if (extension === ".toml") return "toml"
    if (extension === ".env") return "env"
    // .conf files are parsed as INI-like when any non-comment section header exists, otherwise properties-like.
    if (extension === ".ini" || extension === ".properties" || extension === ".conf") return "ini"
    return undefined
}
