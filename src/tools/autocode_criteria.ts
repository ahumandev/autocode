import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { appendFile, mkdir, readFile, readdir, writeFile } from "fs/promises"
import { createAbortResponse, createLifecycleJobRequiredRetryResponse, createRetryResponse } from "@/utils/tools"
import { ensurePlannedJobFiles, formatPlannedJobCollision, getJobDirectoryPath, getJobFilePath, getRelativeJobFilePath, isMissingFile, normalizeReaddirEntries, resolveAgentsStorageRoot, resolvePlannedJob, resolvePlannedJobIdentity, type JobDirectory } from "@/utils/jobs"
import { createSolutionUtils, SolutionLogEvent } from "@/utils/solution"

type FileSystem = {
    mkdir?: (dirPath: string, options?: { recursive?: boolean }) => Promise<string | undefined | void>
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
    readdir?: (dirPath: string, options?: { withFileTypes?: boolean }) => Promise<string[] | import("fs").Dirent[]>
    writeFile: (filePath: string, content: string) => Promise<void>
    appendFile?: (filePath: string, content: string) => Promise<void>
}

type ResolveJobFileSystem = {
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
    readdir: (dirPath: string, options: { withFileTypes: true }) => Promise<import("fs").Dirent[]>
}

async function readDirectoryEntries(dirPath: string, options: { withFileTypes: true }): Promise<import("fs").Dirent[]> {
    return readdir(dirPath, options)
}

async function readDirectory(dirPath: string, options?: { withFileTypes?: boolean }): Promise<string[] | import("fs").Dirent[]> {
    return options?.withFileTypes ? readdir(dirPath, { withFileTypes: true }) : readdir(dirPath)
}

function createResolveJobFileSystem(fileSystem: FileSystem): ResolveJobFileSystem {
    return {
        readFile: fileSystem.readFile,
        readdir: async (dirPath: string, options: { withFileTypes: true }): Promise<import("fs").Dirent[]> => {
            const entries = await (fileSystem.readdir ?? readDirectoryEntries)(dirPath, options)
            return normalizeReaddirEntries(entries)
        },
    }
}

type CriteriaRecord = {
    id: string
    metric: string
}

type CriteriaFile = {
    criteria: Record<string, string>
}

type CriteriaJobDirectory = Exclude<JobDirectory, "concepts">

const defaultFileSystem: FileSystem = {
    appendFile,
    mkdir,
    readFile,
    readdir: readDirectory,
    writeFile,
}

function isPlannedJobNotFoundError(error: unknown): boolean {
    return (error as Error).message?.startsWith("Planned job not found:") ?? false
}

function isPlannedJobCollisionError(error: unknown): boolean {
    return (error as Error).message?.startsWith("Planned job lifecycle collision:") ?? false
}

function createCriteriaPaths(worktree: string, directory: CriteriaJobDirectory, job_name: string): {
    directory: string
    criteriaPath: string
    relativeCriteriaPath: string
    solutionPath: string
    relativeSolutionPath: string
} {
    return {
        directory,
        criteriaPath: getJobFilePath(worktree, directory, job_name, "criteria.yml"),
        relativeCriteriaPath: getRelativeJobFilePath(directory, job_name, "criteria.yml"),
        solutionPath: getJobFilePath(worktree, directory, job_name, "solution.md"),
        relativeSolutionPath: getRelativeJobFilePath(directory, job_name, "solution.md"),
    }
}

async function resolveCriteriaPaths(fileSystem: FileSystem, worktree: string, job_name: string, options: { createIfMissing?: boolean } = {}): Promise<{
    directory: string
    criteriaPath: string
    relativeCriteriaPath: string
    solutionPath: string
    relativeSolutionPath: string
}> {
    const resolved = await resolvePlannedJob(createResolveJobFileSystem(fileSystem), worktree, job_name)

    if (resolved.type !== "found") {
        if (resolved.type === "collision") {
            throw new Error(`Planned job lifecycle collision: ${formatPlannedJobCollision(resolved.collision)}`)
        }

        if (options.createIfMissing) {
            const directory: CriteriaJobDirectory = "executing"
            const absolutePath = getJobDirectoryPath(worktree, directory, job_name)
            await ensurePlannedJobFiles({
                mkdir: fileSystem.mkdir ?? (async () => undefined),
            }, absolutePath)
            return createCriteriaPaths(worktree, directory, job_name)
        }

        throw new Error(`Planned job not found: ${job_name}`)
    }

    if (resolved.job.directory === "concepts") {
        throw new Error(`Planned job not found: ${job_name}`)
    }

    await ensurePlannedJobFiles({
        mkdir: fileSystem.mkdir ?? (async () => undefined),
    }, resolved.job.absolute_path)

    return createCriteriaPaths(worktree, resolved.job.directory, job_name)
}

function normalizeCriteriaToolArgs(clientOrFileSystem?: OpencodeClient | FileSystem, maybeFileSystem?: FileSystem): { client?: OpencodeClient, fileSystem: FileSystem } {
    if (maybeFileSystem) {
        return { client: clientOrFileSystem as OpencodeClient | undefined, fileSystem: maybeFileSystem }
    }

    const candidate = clientOrFileSystem as FileSystem | OpencodeClient | undefined
    if (candidate && "readFile" in candidate && "writeFile" in candidate) {
        return { fileSystem: candidate as FileSystem }
    }

    return { client: candidate as OpencodeClient | undefined, fileSystem: defaultFileSystem }
}

async function resolveCriteriaJobName(
    client: OpencodeClient | undefined,
    fileSystem: FileSystem,
    context: { sessionID: string, directory: string, worktree: string },
    failedAction: string,
    options: { allowMissingResolvedJob?: boolean } = {},
): Promise<{ jobName?: string, retry?: string }> {
    const identity = await resolvePlannedJobIdentity(createResolveJobFileSystem(fileSystem), client, context, "")
    if (identity.mode !== "planned" || !identity.job_name) {
        if (options.allowMissingResolvedJob && !identity.explicit_override && identity.job_name && identity.resolution === "missing") {
            return { jobName: identity.job_name }
        }

        return {
            retry: createLifecycleJobRequiredRetryResponse(failedAction, identity.job_name ? `job ${identity.job_name}` : undefined),
        }
    }

    return { jobName: identity.job_name }
}

function cleanScalar(value: string) {
    const trimmed = value.trim()
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1)
    return trimmed
}

function yamlScalar(value: string) {
    if (!value.length || /[:#\n\[\]{}&*!,>|%@`"']|^\s|\s$|^[-?:]|^(?:true|false|null|yes|no|on|off|[-+]?\d+(?:\.\d+)?)$/i.test(value)) return JSON.stringify(value)
    return value
}

function isCriteriaId(id: string): boolean {
    return /^C\d+$/.test(id)
}

function parseInlineValue(value: string) {
    const trimmed = value.trim()
    if (!trimmed) return ""

    try {
        return String(JSON.parse(trimmed))
    }
    catch {
        return cleanScalar(trimmed)
    }
}

function parseCriteria(content: string): CriteriaFile {
    const criteria: Record<string, string> = {}
    const lines = content.split(/\r?\n/)
    let inCriteria = false
    let current: Partial<CriteriaRecord & { action: string, proof: string }> | undefined

    function commitCurrent() {
        if (!current?.id) return
        if (isCriteriaId(current.id) && !(current.proof ?? "").trim()) criteria[current.id] = current.metric ?? ""
    }

    function splitMapping(line: string) {
        let inString = false
        let escaped = false
        for (let index = 0; index < line.length; index++) {
            const char = line[index]
            if (escaped) {
                escaped = false
                continue
            }
            if (char === "\\") {
                escaped = true
                continue
            }
            if (char === '"') {
                inString = !inString
                continue
            }
            if (char === ":" && !inString) {
                return [line.slice(0, index), line.slice(index + 1)] as const
            }
        }

        return undefined
    }

    for (const line of lines) {
        if (!line.trim()) continue

        if (line.match(/^criteria:\s*$/)) {
            commitCurrent()
            current = undefined
            inCriteria = true
            continue
        }

        if (!inCriteria) {
            if (!/^\s/.test(line)) {
                const mapping = splitMapping(line)
                if (mapping) {
                    const id = parseInlineValue(mapping[0])
                    const metric = parseInlineValue(mapping[1])
                    if (isCriteriaId(id)) criteria[id] = metric
                }
            }
            continue
        }


        const listItem = line.match(/^\s{2}-\s+id:\s*(.*)$/)
        if (listItem) {
            commitCurrent()
            current = { id: parseInlineValue(listItem[1]) }
            continue
        }

        const field = line.match(/^\s{4}(id|metric|action|proof):\s*(.*)$/)
        if (field && current) {
            const value = parseInlineValue(field[2])
            if (field[1] === "id") current.id = value
            if (field[1] === "metric") current.metric = value
            if (field[1] === "action") current.action = value
            if (field[1] === "proof") current.proof = value
            continue
        }
    }

    commitCurrent()
    return { criteria }
}

function serializeCriteria(file: CriteriaFile) {
    const lines: string[] = []
    for (const [id, metric] of Object.entries(file.criteria)) {
        if (!isCriteriaId(id)) continue
        lines.push(`${yamlScalar(id)}: ${yamlScalar(metric)}`)
    }

    return `${lines.join("\n")}\n`
}

async function readCriteriaOrEmpty(fileSystem: FileSystem, worktree: string, job_name: string, options: { createIfMissing?: boolean } = {}): Promise<{ file: CriteriaFile, paths: Awaited<ReturnType<typeof resolveCriteriaPaths>> }> {
    try {
        const paths = await resolveCriteriaPaths(fileSystem, worktree, job_name, options)
        return { file: parseCriteria(await fileSystem.readFile(paths.criteriaPath, "utf8")), paths }
    }
    catch (error) {
        if (isMissingFile(error)) {
            const paths = await resolveCriteriaPaths(fileSystem, worktree, job_name, options)
            return { file: { criteria: {} }, paths }
        }
        throw error
    }
}

async function writeCriteria(fileSystem: FileSystem, criteriaPath: string, file: CriteriaFile) {
    const content = serializeCriteria(file)
    await fileSystem.writeFile(criteriaPath, content)
    return content
}

function stripCriteriaNarrativeLines(value: string | undefined): string {
    return (value ?? "")
        .split(/\r?\n/)
        .filter((line) => line.trim() && !line.match(/^\s*#/))
        .join("\n")
}

function criteriaEntries(file: CriteriaFile): CriteriaRecord[] {
    return Object.entries(file.criteria).map(([id, metric]) => ({ id, metric }))
}

function hasUnder40Words(value: string) {
    return value.trim().split(/\s+/).filter(Boolean).length < 40
}

function sanitizeCriteriaActions(actions: string[]): string[] {
    return actions
        .map((action) => stripCriteriaNarrativeLines(action))
        .filter((action) => action.trim().length > 0)
}

export function createAutocodeCriteriaSetTool(clientOrFileSystem?: OpencodeClient | FileSystem, maybeFileSystem?: FileSystem) {
    const { client, fileSystem } = normalizeCriteriaToolArgs(clientOrFileSystem, maybeFileSystem)
    return tool({
        description: "Add/update acceptance criteria.",
        args: {
            id: tool.schema.string().describe("Criterion ID, for example C1."),
            metric: tool.schema.string().describe("Acceptance metric text."),
        },
        async execute(args, context): Promise<string> {
            const storageRoot = resolveAgentsStorageRoot(context)
            const resolvedJob = await resolveCriteriaJobName(client, fileSystem, context, "autocode_criteria_set", { allowMissingResolvedJob: true })
            if (resolvedJob.retry) return resolvedJob.retry
            const jobName = resolvedJob.jobName as string
            if (!args.id?.trim()) return createRetryResponse("autocode_criteria_set", "Missing required field: id", "Provide a criterion id.")
            if (!isCriteriaId(args.id)) return createRetryResponse("autocode_criteria_set", `Invalid criterion id: ${args.id}`, "Use canonical criterion IDs like C1, C2.")
            if (!args.metric.trim()) return createRetryResponse("autocode_criteria_set", `Missing required field: metric for ${args.id}`, "Provide a non-empty metric.")

            try {
                const { file, paths } = await readCriteriaOrEmpty(fileSystem, storageRoot, jobName, { createIfMissing: true })
                file.criteria[args.id] = args.metric
                const content = await writeCriteria(fileSystem, paths.criteriaPath, file)

                return JSON.stringify({ job_name: jobName, criteria_path: paths.relativeCriteriaPath, id: args.id, criteria: criteriaEntries(file), track: content /* Serialized criteria.yml retained for compatibility/manual inspection. */ })
            }
            catch (error) {
                if (isPlannedJobCollisionError(error)) return createRetryResponse("autocode_criteria_set", (error as Error).message, "Resolve the duplicate active lifecycle directories for this job, then retry or abort this update.")
                if (isPlannedJobNotFoundError(error)) return createLifecycleJobRequiredRetryResponse("autocode_criteria_set", `job ${jobName}`)
                return createAbortResponse("autocode_criteria_set", error)
            }
        },
    })
}

export function createAutocodeCriteriaListTool(clientOrFileSystem?: OpencodeClient | FileSystem, maybeFileSystem?: FileSystem) {
    const { client, fileSystem } = normalizeCriteriaToolArgs(clientOrFileSystem, maybeFileSystem)
    return tool({
        description: "List unmet criteria for the planned job resolved from the current session context.",
        args: {},
        async execute(_args, context): Promise<string> {
            const storageRoot = resolveAgentsStorageRoot(context)
            const resolvedJob = await resolveCriteriaJobName(client, fileSystem, context, "autocode_criteria_list", { allowMissingResolvedJob: true })
            if (resolvedJob.retry) return resolvedJob.retry
            const jobName = resolvedJob.jobName as string

            try {
                const { file, paths } = await readCriteriaOrEmpty(fileSystem, storageRoot, jobName, { createIfMissing: true })
                const criteria = criteriaEntries(file)

                return JSON.stringify({ job_name: jobName, criteria_path: paths.relativeCriteriaPath, empty: criteria.length === 0, criteria })
            }
            catch (error) {
                if (isPlannedJobCollisionError(error)) return createRetryResponse("autocode_criteria_list", (error as Error).message, "Resolve the duplicate active lifecycle directories for this job, then retry or abort this read.")
                if (isPlannedJobNotFoundError(error)) return createLifecycleJobRequiredRetryResponse("autocode_criteria_list", `job ${jobName}`)
                return createAbortResponse("autocode_criteria_list", error)
            }
        },
    })
}

export function createAutocodeCriteriaAcceptTool(clientOrFileSystem?: OpencodeClient | FileSystem, maybeFileSystem?: FileSystem) {
    const { client, fileSystem } = normalizeCriteriaToolArgs(clientOrFileSystem, maybeFileSystem)
    return tool({
        description: "Accept one planned-job criterion, remove it from criteria.yml, and append evidence to solution.md.",
        args: {
            id: tool.schema.string().describe("Criterion ID to accept."),
            actions: tool.schema.array(tool.schema.string()).describe("Short factual actions already taken. Do not restate proof/reason here."),
            proof: tool.schema.string().describe("Short factual proof that the criterion is satisfied, not a restatement of actions."),
        },
        async execute(args, context): Promise<string> {
            const storageRoot = resolveAgentsStorageRoot(context)
            const resolvedJob = await resolveCriteriaJobName(client, fileSystem, context, "autocode_criteria_accept", { allowMissingResolvedJob: true })
            if (resolvedJob.retry) return resolvedJob.retry
            const jobName = resolvedJob.jobName as string
            const proof = stripCriteriaNarrativeLines(args.proof)
            const actions = sanitizeCriteriaActions(args.actions)
            if (!args.id?.trim()) return createRetryResponse("autocode_criteria_accept", "Missing required field: id", "Provide a criterion id.")
            if (!isCriteriaId(args.id)) return createRetryResponse("autocode_criteria_accept", `Invalid criterion id: ${args.id}`, "Use canonical criterion IDs like C1, C2.")
            if (actions.length === 0) return createRetryResponse("autocode_criteria_accept", `Missing required field: actions for ${args.id}`, "Provide at least one non-empty action.")
            if (actions.some((action) => !hasUnder40Words(action))) return createRetryResponse("autocode_criteria_accept", `Action must be under 40 words for ${args.id}`, "Shorten each action to under 40 words.")
            if (!proof.trim()) return createRetryResponse("autocode_criteria_accept", `Missing required field: proof for ${args.id}`, "Provide non-empty proof.")

            try {
                const { file, paths } = await readCriteriaOrEmpty(fileSystem, storageRoot, jobName, { createIfMissing: true })
                const metric = file.criteria[args.id]
                if (!metric?.trim()) return createRetryResponse("autocode_criteria_accept", `Criterion not found: ${args.id}`, `Set ${args.id} before accepting it.`)
                delete file.criteria[args.id]
                const solution = createSolutionUtils(fileSystem, storageRoot, { getDirectory: async () => paths.directory })
                await solution.log(jobName, SolutionLogEvent.AcceptedCriteria, args.id, actions.join("\n"), proof.trim())
                const content = await writeCriteria(fileSystem, paths.criteriaPath, file)

                return JSON.stringify({ job_name: jobName, criteria_path: paths.relativeCriteriaPath, solution_path: paths.relativeSolutionPath, id: args.id, completed: true, criteria: criteriaEntries(file), track: content /* Serialized criteria.yml retained for compatibility/manual inspection. */ })
            }
            catch (error) {
                if (isPlannedJobCollisionError(error)) return createRetryResponse("autocode_criteria_accept", (error as Error).message, "Resolve the duplicate active lifecycle directories for this job, then retry or abort this acceptance.")
                if (isPlannedJobNotFoundError(error)) return createLifecycleJobRequiredRetryResponse("autocode_criteria_accept", `job ${jobName}`)
                return createAbortResponse("autocode_criteria_accept", error)
            }
        },
    })
}

export function createAutocodeCriteriaRemoveTool(clientOrFileSystem?: OpencodeClient | FileSystem, maybeFileSystem?: FileSystem) {
    const { client, fileSystem } = normalizeCriteriaToolArgs(clientOrFileSystem, maybeFileSystem)
    return tool({
        description: "Remove one planned-job criterion from the current session context's planned job.",
        args: {
            id: tool.schema.string().describe("Criterion ID to remove."),
        },
        async execute(args, context): Promise<string> {
            const storageRoot = resolveAgentsStorageRoot(context)
            const resolvedJob = await resolveCriteriaJobName(client, fileSystem, context, "autocode_criteria_remove", { allowMissingResolvedJob: true })
            if (resolvedJob.retry) return resolvedJob.retry
            const jobName = resolvedJob.jobName as string
            if (!args.id?.trim()) return createRetryResponse("autocode_criteria_remove", "Missing required field: id", "Provide a criterion id to remove.")
            if (!isCriteriaId(args.id)) return createRetryResponse("autocode_criteria_remove", `Invalid criterion id: ${args.id}`, "Use canonical criterion IDs like C1, C2.")

            try {
                const { file, paths } = await readCriteriaOrEmpty(fileSystem, storageRoot, jobName, { createIfMissing: true })
                const hadCriterion = Object.prototype.hasOwnProperty.call(file.criteria, args.id)
                delete file.criteria[args.id]
                const content = await writeCriteria(fileSystem, paths.criteriaPath, file)

                return JSON.stringify({ job_name: jobName, criteria_path: paths.relativeCriteriaPath, removed: hadCriterion ? args.id : undefined, criteria: criteriaEntries(file), track: content /* Serialized criteria.yml retained for compatibility/manual inspection. */ })
            }
            catch (error) {
                if (isPlannedJobCollisionError(error)) return createRetryResponse("autocode_criteria_remove", (error as Error).message, "Resolve the duplicate active lifecycle directories for this job, then retry or abort this removal.")
                if (isPlannedJobNotFoundError(error)) return createLifecycleJobRequiredRetryResponse("autocode_criteria_remove", `job ${jobName}`)
                return createAbortResponse("autocode_criteria_remove", error)
            }
        },
    })
}
