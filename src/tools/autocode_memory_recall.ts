import { tool } from "@opencode-ai/plugin"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import type { Dirent } from "node:fs"
import {
    normalizeLocalMemoryMatchValue,
    recallLocalMemories,
    type LocalMemoryFileSystem,
} from "@/utils/local_memory"
import type { SessionJobContext } from "@/utils/jobs"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

const autocodeMemoryRecallToolDescription = "Avoid duplicate work. Recall previous solutions, discoveries, user preferences."

type AutocodeMemoryRecallArgs = {
    keywords?: unknown
}

type AutocodeMemoryRecallContext = Pick<SessionJobContext, "directory" | "worktree">

type AutocodeMemoryRecallValidationFailure = {
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

export function createAutocodeMemoryRecallTool(fileSystem: LocalMemoryFileSystem = nodeLocalMemoryFileSystem): ReturnType<typeof tool> {
    return tool({
        description: autocodeMemoryRecallToolDescription,
        args: {
            keywords: tool.schema.string().describe("Ordered comma-separated recall terms. Most specific first, broadest term last."),
        },
        async execute(args, context): Promise<string> {
            const terms = validateAutocodeMemoryRecallArgs(args)
            if ("error" in terms) {
                return createRetryResponse("autocode_memory_recall", terms.error, terms.instruction)
            }

            try {
                const recallContext = context as AutocodeMemoryRecallContext
                const recalled = await recallLocalMemories(fileSystem, recallContext, terms)
                return recalled.xml
            }
            catch (error) {
                return createAbortResponse("autocode_memory_recall", error)
            }
        },
    })
}

function validateAutocodeMemoryRecallArgs(args: AutocodeMemoryRecallArgs): string[] | AutocodeMemoryRecallValidationFailure {
    if (typeof args.keywords !== "string") {
        return {
            error: "Invalid keywords. Keywords must be a comma-separated string.",
            instruction: "Retry with keywords as comma-separated non-empty terms.",
        }
    }

    if (!args.keywords.trim()) {
        return {
            error: "Invalid keywords. Keywords must contain at least one term.",
            instruction: "Retry with keywords as comma-separated non-empty terms.",
        }
    }

    const terms: string[] = []
    const seen = new Set<string>()
    for (const keyword of args.keywords.split(",")) {
        const normalizedKeyword = normalizeLocalMemoryMatchValue(keyword)
        if (!normalizedKeyword) {
            return {
                error: "Invalid keywords. Each comma-separated term must be non-empty after normalization.",
                instruction: "Retry with keywords as comma-separated non-empty terms without leading, trailing, or doubled commas.",
            }
        }
        if (seen.has(normalizedKeyword)) continue
        seen.add(normalizedKeyword)
        terms.push(normalizedKeyword)
    }

    if (terms.length === 0) {
        return {
            error: "Invalid keywords. Keywords must contain at least one term.",
            instruction: "Retry with keywords as comma-separated non-empty terms.",
        }
    }
    return terms
}
