import type { ToolContext } from "@opencode-ai/plugin"
import { validateFilePath } from "../../utils/validate_file_path"

type ValidationResult = { ok: true, value: string } | { ok: false, response: string }

export async function validateMdPath(
    context: ToolContext,
    filePath: string,
    failedAction: string,
    options?: { requireExistence?: boolean },
): Promise<ValidationResult> {
    const result = await validateFilePath(filePath, {
        failedAction,
        context,
        existence: options?.requireExistence === true ? "bare-filename-only" : "off",
    })
    if (!result.ok) return result
    return { ok: true, value: result.value }
}
