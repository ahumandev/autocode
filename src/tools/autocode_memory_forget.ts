import { tool } from "@opencode-ai/plugin"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import type { Dirent } from "node:fs"
import {
    forgetLocalMemory,
    normalizeLocalMemoryMatchValue,
    type DeletedLocalMemory,
    type FailedLocalMemoryDeletion,
    type ForgetLocalMemoryResult,
    type LocalMemoryFileSystem,
} from "@/utils/local_memory"
import type { SessionJobContext } from "@/utils/jobs"
import { createAbortResponse, createRetryResponse, flattenError } from "@/utils/tools"

const autocodeMemoryForgetToolDescription = "Forget outdated or wrong memory."

type AutocodeMemoryForgetArgs = {
    id_keyword?: unknown
}

type AutocodeMemoryForgetContext = Pick<SessionJobContext, "directory" | "worktree">

type AutocodeMemoryForgetValidationFailure = {
    error: string
    instruction: string
}

const nodeLocalMemoryFileSystem: LocalMemoryFileSystem = {
    async mkdir(directoryPath: string, options?: { recursive?: boolean }): Promise<string | undefined> {
        return await mkdir(directoryPath, options)
    },
    async readFile(filePath: string, encoding: "utf8"): Promise<string> {
        return await readFile(filePath, encoding)
    },
    async readdir(directoryPath: string, options?: { withFileTypes?: boolean }): Promise<string[] | Dirent[]> {
        if (options?.withFileTypes) return await readdir(directoryPath, { withFileTypes: true })
        return await readdir(directoryPath)
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
        await rename(oldPath, newPath)
    },
    async rm(filePath: string, options?: { recursive?: boolean, force?: boolean }): Promise<void> {
        await rm(filePath, options)
    },
    async writeFile(filePath: string, content: string): Promise<void> {
        await writeFile(filePath, content)
    },
}

export function createAutocodeMemoryForgetTool(fileSystem: LocalMemoryFileSystem = nodeLocalMemoryFileSystem): ReturnType<typeof tool> {
    return tool({
        description: autocodeMemoryForgetToolDescription,
        args: {
            id_keyword: tool.schema.string().describe("Exact primary memory ID to remove."),
        },
        async execute(args, context): Promise<string> {
            const normalizedId = validateAutocodeMemoryForgetArgs(args)
            if (typeof normalizedId !== "string") {
                return createRetryResponse("autocode_memory_forget", normalizedId.error, normalizedId.instruction)
            }

            try {
                const forgetContext = context as AutocodeMemoryForgetContext
                const result = await forgetLocalMemory(fileSystem, forgetContext, normalizedId)
                if (result.failed.length > 0) {
                    return createAbortResponse(
                        "autocode_memory_forget",
                        formatPartialDeletionReport(result),
                        "Retry with same exact ID; completed deletions remain deleted and retry safely removes remaining versions.",
                    )
                }
                return formatDeletionReport(result)
            }
            catch (error) {
                return createAbortResponse("autocode_memory_forget", error)
            }
        },
    })
}

function validateAutocodeMemoryForgetArgs(args: AutocodeMemoryForgetArgs): string | AutocodeMemoryForgetValidationFailure {
    if (typeof args.id_keyword !== "string") {
        return {
            error: "Invalid id_keyword. ID keyword must be a string.",
            instruction: "Retry with one non-empty ID keyword.",
        }
    }

    const normalizedId = normalizeLocalMemoryMatchValue(args.id_keyword)
    if (!normalizedId) {
        return {
            error: "Invalid id_keyword. ID keyword has no matchable content.",
            instruction: "Retry with one non-empty ID keyword.",
        }
    }
    return normalizedId
}

function formatDeletionReport(result: ForgetLocalMemoryResult): string {
    return [
        `Normalized ID: ${result.normalized_id}`,
        `Deleted: ${result.deleted.length}`,
        `Locations: ${formatDeletedLocations(result.deleted)}`,
    ].join("\n")
}

function formatPartialDeletionReport(result: ForgetLocalMemoryResult): string {
    return [
        `Partial deletion. Normalized ID: ${result.normalized_id}`,
        `Deleted: ${result.deleted.length} (${formatDeletedLocations(result.deleted)})`,
        `Failed: ${result.failed.length} (${formatFailedLocations(result.failed)})`,
    ].join(" ")
}

function formatDeletedLocations(files: readonly DeletedLocalMemory[]): string {
    return files.length === 0 ? "none" : files.map((file: DeletedLocalMemory): string => `${file.filename}: ${file.path}`).join(", ")
}

function formatFailedLocations(files: readonly FailedLocalMemoryDeletion[]): string {
    return files.map((file: FailedLocalMemoryDeletion): string => `${file.filename}: ${file.path} (${flattenError(file.error)})`).join(", ")
}
