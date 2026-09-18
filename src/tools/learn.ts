import { tool } from "@opencode-ai/plugin"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import type { Dirent } from "node:fs"
import {
    formatLocalMemoryFilename,
    formatLocalMemoryTimestamp,
    normalizeLocalMemoryMatchValue,
    saveLocalMemory,
    type LocalMemory,
    type LocalMemoryFileSystem,
} from "@/utils/local_memory"
import type { SessionJobContext } from "@/utils/jobs"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

const learnToolDescription = "Learn from mistakes. Invoke when corrected by user. Remember user preferences, environment-specific configuration, project conventions, safety constraints, and verified findings. Help future agents avoid repeated mistakes or investigation."

type LearnArgs = {
    memory?: unknown
    id_keyword?: unknown
    alias_keywords?: unknown
    context_keywords: unknown
    positive_example?: unknown
    negative_example?: unknown
    references?: unknown
}

type LearnContext = Pick<SessionJobContext, "directory" | "worktree">

type KeywordList = {
    values: string[]
    removedDuplicates: string[]
}

type ValidatedLearnArgs = {
    memory: LocalMemory
    normalizedId: string
    removedDuplicates: string[]
}

type LearnValidationFailure = {
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

export function validateLearnArgs(args: LearnArgs): ValidatedLearnArgs | LearnValidationFailure {
    const unexpectedArgs = Object.keys(args).filter((key: string): boolean => ![
        "memory",
        "id_keyword",
        "alias_keywords",
        "context_keywords",
        "positive_example",
        "negative_example",
        "references",
    ].includes(key))
    if (unexpectedArgs.length > 0) {
        return {
            error: `Unexpected argument(s): ${unexpectedArgs.join(", ")}.`,
            instruction: "Retry with memory, id_keyword, alias_keywords, context_keywords, positive_example, negative_example, and references only.",
        }
    }

    if (typeof args.memory !== "string" || !args.memory.trim()) {
        return {
            error: "Invalid memory. Memory must be a non-empty string.",
            instruction: "Retry with durable memory in concise Caveman English.",
        }
    }

    if (typeof args.id_keyword !== "string" || !args.id_keyword.trim()) {
        return {
            error: "Invalid id_keyword. ID keyword must be a non-empty string.",
            instruction: "Retry with one non-empty ID keyword.",
        }
    }

    const idKeyword = args.id_keyword.trim()
    const normalizedId = normalizeLocalMemoryMatchValue(idKeyword)
    if (!normalizedId) {
        return {
            error: "Invalid id_keyword. ID keyword has no matchable content.",
            instruction: "Retry with one non-empty ID keyword.",
        }
    }

    const aliases = parseKeywordList(args.alias_keywords, "alias_keywords", new Set([normalizedId]))
    if ("error" in aliases) return aliases
    const context = parseKeywordList(args.context_keywords, "context_keywords", new Set([normalizedId, ...aliases.values.map(normalizeLocalMemoryMatchValue)]))
    if ("error" in context) return context

    const positiveExample = validateOptionalText(args.positive_example, "positive_example")
    if ("error" in positiveExample) return positiveExample
    const negativeExample = validateOptionalText(args.negative_example, "negative_example")
    if ("error" in negativeExample) return negativeExample
    const references = validateOptionalReferences(args.references)
    if ("error" in references) return references

    const memory: LocalMemory = {
        id: idKeyword,
        aliases: aliases.values,
        context: context.values.length === 0 ? undefined : context.values.join(","),
        memory: args.memory,
        positive_example: positiveExample.value,
        negative_example: negativeExample.value,
        references: references.value,
    }
    const filenameValidation = validateFilenameMetadata(memory)
    if (filenameValidation !== undefined) return filenameValidation
    return {
        memory,
        normalizedId,
        removedDuplicates: [...aliases.removedDuplicates, ...context.removedDuplicates],
    }
}

export function createLearnTool(fileSystem: LocalMemoryFileSystem = nodeLocalMemoryFileSystem): ReturnType<typeof tool> {
    return tool({
        description: learnToolDescription,
        args: {
            memory: tool.schema.string().describe("Memory in Caveman English. Include all relevant facts for agent with no context."),
            id_keyword: tool.schema.string().describe("Primary memory lookup keyword."),
            alias_keywords: tool.schema.string().optional().describe("Optional comma-separated alias keywords."),
            context_keywords: tool.schema.string().describe("Comma-separated ordered context keywords. Most specific keyword first, boardest term last."),
            positive_example: tool.schema.string().optional().describe("Optional positive example."),
            negative_example: tool.schema.string().optional().describe("Optional negative example."),
            references: tool.schema.array(tool.schema.string()).optional().describe("Optional source reference links."),
        },
        async execute(args, context): Promise<string> {
            const validatedArgs = validateLearnArgs(args)
            if ("error" in validatedArgs) {
                return createRetryResponse("learn", validatedArgs.error, validatedArgs.instruction)
            }

            try {
                const learnContext = context as LearnContext
                await saveLocalMemory(fileSystem, learnContext, validatedArgs.memory)
                return "OK"
            }
            catch (error) {
                return createAbortResponse("learn", error)
            }
        },
    })
}

function parseKeywordList(value: unknown, field: "alias_keywords" | "context_keywords", seen: Set<string>): KeywordList | LearnValidationFailure {
    if (typeof value !== "string") {
        return {
            error: `Invalid ${field}. Keywords must be a comma-separated string.`,
            instruction: `Retry with ${field} as a comma-separated string; use an empty string when none apply.`,
        }
    }

    if (!value.trim()) return { values: [], removedDuplicates: [] }
    const values: string[] = []
    const removedDuplicates: string[] = []
    for (const rawKeyword of value.split(",")) {
        const keyword = rawKeyword.trim()
        const normalizedKeyword = normalizeLocalMemoryMatchValue(keyword)
        if (!keyword || !normalizedKeyword) {
            return {
                error: `Invalid ${field}. Keywords must be non-empty after trimming.`,
                instruction: `Retry with comma-separated non-empty ${field}; use an empty string when none apply.`,
            }
        }
        if (seen.has(normalizedKeyword)) {
            removedDuplicates.push(keyword)
            continue
        }
        seen.add(normalizedKeyword)
        values.push(keyword)
    }
    return { values, removedDuplicates }
}

function validateOptionalText(value: unknown, field: "positive_example" | "negative_example"): { value?: string } | LearnValidationFailure {
    if (value === undefined) return {}
    if (typeof value !== "string") {
        return {
            error: `Invalid ${field}. Value must be a string when provided.`,
            instruction: `Retry with ${field} omitted or as a string.`,
        }
    }
    return value.trim() ? { value } : {}
}

function validateOptionalReferences(value: unknown): { value?: string[] } | LearnValidationFailure {
    if (value === undefined) return {}
    if (!Array.isArray(value) || value.some((reference: unknown): boolean => typeof reference !== "string")) {
        return {
            error: "Invalid references. References must be strings when provided.",
            instruction: "Retry with references omitted or as an array of strings.",
        }
    }
    const references = value.filter((reference: string): boolean => Boolean(reference.trim()))
    return references.length === 0 ? {} : { value: references }
}

function validateFilenameMetadata(memory: Pick<LocalMemory, "id" | "aliases" | "context">): LearnValidationFailure | undefined {
    try {
        formatLocalMemoryFilename(formatLocalMemoryTimestamp(new Date()), memory)
        return undefined
    }
    catch (error) {
        return {
            error: `Invalid memory keywords: ${error instanceof Error ? error.message : String(error)}`,
            instruction: "Retry with shorter, filename-safe keywords.",
        }
    }
}
