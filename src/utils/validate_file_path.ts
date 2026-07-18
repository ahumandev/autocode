import { stat } from "node:fs/promises"
import { isAbsolute, relative } from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import { createRetryResponse } from "./tools"
import { authorizeExternalContentPath } from "./external_directory"
import { resolveFilePath } from "./resolve_file_path"

/**
 * Policy controlling when a stat-based existence check is enforced.
 *
 * - "off": no existence check (use for tools that create new files).
 * - "bare-filename-only": check existence only when the input has no
 *   path separator (e.g. `config.json`); paths with a separator are
 *   trusted and may not exist.
 * - "always": check existence for every input.
 */
export type ExistencePolicy = "off" | "bare-filename-only" | "always"

export type FilePathValidationResult =
    | { ok: true, value: string }
    | { ok: false, response: string }

export type ValidateFilePathOptions = {
    failedAction: string
    context?: ToolContext
    existence?: ExistencePolicy
    /**
     * When true, reject paths outside cwd with a "must stay inside cwd" error
     * if no context is provided. When false (default), paths outside cwd
     * pass through when no context is provided (rely on downstream auth or
     * later failure). Set true for tools that require user authorization
     * for any external path.
     */
    requireContextForExternalPaths?: boolean
}

export async function validateFilePath(
    input: unknown,
    options: ValidateFilePathOptions,
): Promise<FilePathValidationResult> {
    const {
        failedAction,
        context,
        existence = "off",
        requireContextForExternalPaths = false,
    } = options

    if (typeof input !== "string" || input.length === 0) {
        return { ok: false, response: createRetryResponse(failedAction, new Error("file_path required"), "Provide a file_path.") }
    }

    if (/[*?[\]{}]/.test(input)) {
        return { ok: false, response: createRetryResponse(failedAction, new Error(`glob patterns not allowed: ${input}`), "Provide a concrete file_path without wildcard characters (* ? [ ] { }).") }
    }

    const absolutePath = await resolveFilePath(
        input,
        options.context?.directory ?? process.cwd(),
        { searchSubdirs: options.existence !== "off" },
    )

    if (existence !== "off") {
        const isBareFilename = !input.includes("/") && !input.includes("\\")
        if (existence === "always" || isBareFilename) {
            try {
                const s = await stat(absolutePath)
                if (!s.isFile()) throw new Error("not a regular file")
            } catch {
                return { ok: false, response: createRetryResponse(failedAction, new Error(`file not found: ${input}`), "Provide a file_path that exists in the current working directory or use an absolute path.") }
            }
        }
    }

    const cwd = options.context?.directory ?? process.cwd()
    const rel = relative(cwd, absolutePath)
    const isInsideCwd = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)

    if (!isInsideCwd) {
        if (!context) {
            if (requireContextForExternalPaths) {
                return { ok: false, response: createRetryResponse(failedAction, new Error("path must stay inside the current working directory."), "Provide a relative path within the current working directory.") }
            }
        } else {
            const auth = await authorizeExternalContentPath(context, absolutePath, failedAction)
            if (!auth.ok) return auth
        }
    }

    return { ok: true, value: absolutePath }
}
