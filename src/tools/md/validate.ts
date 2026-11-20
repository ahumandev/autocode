import type { ToolContext } from "@opencode-ai/plugin"
import { stat } from "node:fs/promises"
import path from "node:path"
import { classifyMemoryPath } from "../../utils/memory_access"
import { createRetryResponse } from "../../utils/tools"
import { validateFilePath, type ValidateFilePathOptions } from "../../utils/validate_file_path"

type ValidationResult = { ok: true, value: string } | { ok: false, response: string }

export async function validateMarkdownFilePath(input: unknown, options: ValidateFilePathOptions): Promise<ValidationResult> {
    const context = options.context
    if (context?.agent === "query-memory") {
        return { ok: false, response: createRetryResponse(options.failedAction, "query-memory is read-only.", "Use learn-memory to modify Markdown files.") }
    }
    if (context?.agent !== "learn-memory" || typeof input !== "string" || input.length === 0 || /[*?[\]{}]/.test(input)) {
        return validateFilePath(input, options)
    }

    const rawAbsolute = path.isAbsolute(input) ? input : `${context.directory}${path.sep}${input}`
    const absolute = path.resolve(context.directory, input)
    const deny = (): ValidationResult => ({
        ok: false,
        response: createRetryResponse(options.failedAction, `Path '${input}' is not allowed by memory directory policy.`, "Provide a path within the configured memory directory that does not escape it."),
    })
    if (process.platform === "win32" && rawAbsolute.slice(path.parse(rawAbsolute).root.length).includes(":")) return deny()
    if (await classifyMemoryPath(context.directory, options.memory?.directory, rawAbsolute) !== "allowed"
        || await classifyMemoryPath(context.directory, options.memory?.directory, absolute) !== "allowed") return deny()

    const bareFilename = !input.includes("/") && !input.includes("\\")
    const result = await validateFilePath(absolute, {
        ...options,
        memory: options.memory ?? {},
        existence: options.existence === "bare-filename-only" && bareFilename ? "always" : options.existence,
    })
    if (!result.ok) return result
    if (await classifyMemoryPath(context.directory, options.memory?.directory, result.value) !== "allowed") return deny()
    try {
        const target = await stat(result.value)
        if (!target.isFile() || typeof target.nlink !== "number" || target.nlink !== 1) return deny()
    }
    catch (error) {
        if ((options.existence ?? "off") !== "off" || typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") return deny()
    }
    return result
}

export async function validateMdPath(
    context: ToolContext,
    filePath: string,
    failedAction: string,
    options?: { requireExistence?: boolean, memory?: { directory?: string } },
): Promise<ValidationResult> {
    const result = await validateMarkdownFilePath(filePath, {
        failedAction,
        context,
        existence: options?.requireExistence === true ? "bare-filename-only" : "off",
        memory: options?.memory,
    })
    if (!result.ok) return result
    return { ok: true, value: result.value }
}
