import * as fs from "fs"
import path from "path"
import { tool } from "@opencode-ai/plugin"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"
import { defaultSandboxDependencies, type SandboxCommandResult, type SandboxDependencies } from "@/utils/sandbox"

export type GitToolName =
    | "git_status"
    | "git_diff_unstaged"
    | "git_diff_staged"
    | "git_diff"
    | "git_log"
    | "git_show"
    | "git_add"
    | "git_commit"
    | "git_reset"
    | "git_create_branch"
    | "git_checkout"
    | "git_branch"

type GitArgs = Record<string, unknown>
type GitValidationResult<T> = { ok: true, value: T } | { ok: false, message: string, correctiveAction: string }
type GitToolSchema = Parameters<typeof tool>[0]["args"]
type GitToolConfig = {
    description: string
    args: GitToolSchema
    keys: readonly string[]
    buildArgs: (args: GitArgs) => GitValidationResult<string[]>
}

type GitNormalResponse = {
    success: boolean
    exit_code: number | null
    stdout: string
    stderr: string
    command: {
        executable: "git"
        args: string[]
        repo_path: string
    }
}

const gitToolNames = [
    "git_status",
    "git_diff_unstaged",
    "git_diff_staged",
    "git_diff",
    "git_log",
    "git_show",
    "git_add",
    "git_commit",
    "git_reset",
    "git_create_branch",
    "git_checkout",
    "git_branch",
] as const satisfies readonly GitToolName[]

const revisionPattern = /^[A-Za-z0-9._/@{}:+~^=-]+$/
const branchNamePattern = /^[A-Za-z0-9._/-]+$/

function retry<T>(message: string, correctiveAction: string): GitValidationResult<T> {
    return { ok: false, message, correctiveAction }
}

function isPlainObject(input: unknown): input is GitArgs {
    return typeof input === "object" && input !== null && !Array.isArray(input) && Object.getPrototypeOf(input) === Object.prototype
}

function validatePlainArgs(args: unknown, keys: readonly string[]): GitValidationResult<GitArgs> {
    if (!isPlainObject(args)) return retry("Arguments must be a plain object.", "Provide a JSON object with only supported fields for this git tool.")

    const unknownKeys = Object.keys(args).filter((key) => !keys.includes(key))
    if (unknownKeys.length > 0) return retry(`Unknown argument(s): ${unknownKeys.join(", ")}.`, "Remove unsupported git tool arguments and retry.")

    return { ok: true, value: args }
}

function validateRepoPath(input: unknown): GitValidationResult<string> {
    if (typeof input !== "string") return retry("repo_path must be a string.", "Provide an absolute repository path.")

    const repoPath = input.trim()
    if (!repoPath) return retry("repo_path must be a non-empty string.", "Provide an absolute repository path.")
    if (repoPath.includes("\0")) return retry("repo_path must not contain NUL bytes.", "Provide a safe absolute repository path.")
    if (!path.isAbsolute(repoPath)) return retry("repo_path must be absolute.", "Provide an absolute repository path.")

    return { ok: true, value: repoPath }
}

function validatePathEntry(input: unknown, fieldName: string): GitValidationResult<string> {
    if (typeof input !== "string") return retry(`${fieldName} entries must be strings.`, "Provide relative file paths only.")

    const value = input.trim()
    if (!value) return retry(`${fieldName} entries must be non-empty.`, "Provide relative file paths only.")
    if (value.includes("\0")) return retry(`${fieldName} entries must not contain NUL bytes.`, "Provide safe relative file paths only.")
    if (path.isAbsolute(value)) return retry(`${fieldName} entries must be relative paths.`, "Provide relative file paths only.")
    if (value.startsWith("-")) return retry(`${fieldName} entries must not start with '-'.`, "Provide relative file paths that are not option-like.")
    if (value.startsWith(".")) return retry(`${fieldName} entries must not start with '.'.`, "Provide explicit relative file paths inside the repository.")
    if (value.split(/[\\/]+/).includes("..")) return retry(`${fieldName} entries must not contain .. segments.`, "Provide relative file paths inside the repository.")

    const normalized = path.normalize(value)
    if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) {
        return retry(`${fieldName} entries must not escape the repository.`, "Provide relative file paths inside the repository.")
    }

    return { ok: true, value }
}

function validatePaths(input: unknown, fieldName: "paths" | "files", required: boolean): GitValidationResult<string[]> {
    if (input === undefined && !required) return { ok: true, value: [] }
    if (!Array.isArray(input)) return retry(`${fieldName} must be a string array.`, `Provide ${fieldName} as an array of relative paths.`)
    if (required && input.length === 0) return retry(`${fieldName} must contain at least one path.`, `Provide at least one relative path in ${fieldName}.`)

    const values: string[] = []
    for (const entry of input) {
        const validation = validatePathEntry(entry, fieldName)
        if (!validation.ok) return validation
        values.push(validation.value)
    }

    return { ok: true, value: values }
}

function validateRevision(input: unknown, fieldName: string, required: true): GitValidationResult<string>
function validateRevision(input: unknown, fieldName: string, required: false): GitValidationResult<string | undefined>
function validateRevision(input: unknown, fieldName: string, required: boolean): GitValidationResult<string | undefined> {
    if (input === undefined && !required) return { ok: true, value: undefined }
    if (typeof input !== "string") return retry(`${fieldName} must be a string.`, `Provide a safe ${fieldName} revision string.`)

    const value = input.trim()
    if (!value) return retry(`${fieldName} must be non-empty.`, `Provide a safe ${fieldName} revision string.`)
    if (value.includes("\0") || /^-|\s|[\x00-\x1f\x7f]/.test(value) || !revisionPattern.test(value)) {
        return retry(`${fieldName} contains unsafe characters.`, `Provide a conservative ${fieldName} using only safe git revision characters.`)
    }

    return { ok: true, value }
}

function validateBranchName(input: unknown): GitValidationResult<string> {
    if (typeof input !== "string") return retry("branch_name must be a string.", "Provide a safe branch name.")

    const value = input.trim()
    if (!value) return retry("branch_name must be non-empty.", "Provide a safe branch name.")
    if (value.includes("\0") || /\s|[\x00-\x1f\x7f]/.test(value) || value.startsWith("-")) return retry("branch_name contains unsafe characters.", "Provide a safe branch name that is not option-like.")
    if (value.includes("..") || value.includes("@{") || value.includes("//") || value.includes("\\") || value.includes(":") || value.endsWith(".lock")) {
        return retry("branch_name contains unsafe git ref syntax.", "Provide a simple branch name using letters, digits, dots, underscores, slashes, or hyphens.")
    }
    if (!branchNamePattern.test(value)) return retry("branch_name contains unsupported characters.", "Provide a simple branch name using letters, digits, dots, underscores, slashes, or hyphens.")

    return { ok: true, value }
}

function validateMessage(input: unknown): GitValidationResult<string> {
    if (typeof input !== "string") return retry("message must be a string.", "Provide a non-empty commit message.")

    const value = input.trim()
    if (!value) return retry("message must be non-empty.", "Provide a non-empty commit message.")
    if (value.includes("\0")) return retry("message must not contain NUL bytes.", "Provide a safe commit message.")

    return { ok: true, value }
}

function validateMaxCount(input: unknown): GitValidationResult<number> {
    if (input === undefined) return { ok: true, value: 20 }
    if (typeof input !== "number" || !Number.isInteger(input) || input < 1 || input > 100) return retry("max_count must be an integer from 1 to 100.", "Provide max_count from 1 to 100, or omit it.")
    return { ok: true, value: input }
}

async function resolveRepoPath(deps: SandboxDependencies, repoPath: string): Promise<GitValidationResult<string>> {
    let realRepoPath: string
    try {
        realRepoPath = await fs.promises.realpath(repoPath)
    }
    catch (error) {
        return retry(`Unable to resolve repo_path: ${(error as Error).message}`, "Provide an existing absolute repository path.")
    }

    const result = await deps.spawn("git", ["-C", realRepoPath, "rev-parse", "--show-toplevel"])
    const topLevel = result.stdout.trim()
    if (result.exitCode !== 0 || !topLevel) return retry("repo_path is not inside a git repository.", "Provide a path inside an existing git repository.")

    try {
        return { ok: true, value: await fs.promises.realpath(topLevel) }
    }
    catch (error) {
        return retry(`Unable to resolve git top-level path: ${(error as Error).message}`, "Provide a repository path whose git top-level directory exists.")
    }
}

function appendPaths(gitArgs: string[], paths: readonly string[]): string[] {
    return [...gitArgs, "--", ...paths]
}

function buildDiffArgs(args: GitArgs): GitValidationResult<string[]> {
    const paths = validatePaths(args.paths, "paths", false)
    if (!paths.ok) return paths

    const base = validateRevision(args.base, "base", false)
    if (!base.ok) return base
    const target = validateRevision(args.target, "target", false)
    if (!target.ok) return target
    if (target.value !== undefined && base.value === undefined) return retry("target requires base.", "Provide base with target, or omit target.")

    const revisions = [base.value, target.value].filter((value): value is string => value !== undefined)
    return { ok: true, value: appendPaths(["diff", ...revisions], paths.value) }
}

function createGitToolConfig(): Record<GitToolName, GitToolConfig> {
    const repoOnlyKeys = ["repo_path"] as const
    return {
        git_status: {
            description: "Run git status --short --branch for a local repository.",
            args: { repo_path: tool.schema.string().describe("Absolute path inside the git repository.") },
            keys: repoOnlyKeys,
            buildArgs: () => ({ ok: true, value: ["status", "--short", "--branch"] }),
        },
        git_diff_unstaged: {
            description: "Run unstaged git diff for a local repository.",
            args: { repo_path: tool.schema.string(), paths: tool.schema.array(tool.schema.string()).optional() },
            keys: ["repo_path", "paths"],
            buildArgs: (args) => {
                const paths = validatePaths(args.paths, "paths", false)
                return paths.ok ? { ok: true, value: appendPaths(["diff"], paths.value) } : paths
            },
        },
        git_diff_staged: {
            description: "Run staged git diff for a local repository.",
            args: { repo_path: tool.schema.string(), paths: tool.schema.array(tool.schema.string()).optional() },
            keys: ["repo_path", "paths"],
            buildArgs: (args) => {
                const paths = validatePaths(args.paths, "paths", false)
                return paths.ok ? { ok: true, value: appendPaths(["diff", "--cached"], paths.value) } : paths
            },
        },
        git_diff: {
            description: "Run git diff for optional revisions and paths.",
            args: { repo_path: tool.schema.string(), base: tool.schema.string().optional(), target: tool.schema.string().optional(), paths: tool.schema.array(tool.schema.string()).optional() },
            keys: ["repo_path", "base", "target", "paths"],
            buildArgs: buildDiffArgs,
        },
        git_log: {
            description: "Run git log --oneline --decorate.",
            args: { repo_path: tool.schema.string(), max_count: tool.schema.number().int().min(1).max(100).optional(), revision: tool.schema.string().optional() },
            keys: ["repo_path", "max_count", "revision"],
            buildArgs: (args) => {
                const maxCount = validateMaxCount(args.max_count)
                if (!maxCount.ok) return maxCount
                const revision = validateRevision(args.revision, "revision", false)
                if (!revision.ok) return revision
                return { ok: true, value: ["log", "--oneline", "--decorate", `--max-count=${maxCount.value}`, ...(revision.value === undefined ? [] : [revision.value])] }
            },
        },
        git_show: {
            description: "Run git show --stat --patch for a revision.",
            args: { repo_path: tool.schema.string(), revision: tool.schema.string() },
            keys: ["repo_path", "revision"],
            buildArgs: (args) => {
                const revision = validateRevision(args.revision, "revision", true)
                return revision.ok ? { ok: true, value: ["show", "--stat", "--patch", revision.value] } : revision
            },
        },
        git_add: {
            description: "Add changed files to Git, ready for commit.",
            args: { repo_path: tool.schema.string(), files: tool.schema.array(tool.schema.string()) },
            keys: ["repo_path", "files"],
            buildArgs: (args) => {
                const files = validatePaths(args.files, "files", true)
                return files.ok ? { ok: true, value: appendPaths(["add"], files.value) } : files
            },
        },
        git_commit: {
            description: "Commit added changes to Git repo.",
            args: { repo_path: tool.schema.string(), message: tool.schema.string() },
            keys: ["repo_path", "message"],
            buildArgs: (args) => {
                const message = validateMessage(args.message)
                return message.ok ? { ok: true, value: ["commit", "-m", message.value] } : message
            },
        },
        git_reset: {
            description: "Mixed reset of Git changes (index-only).",
            args: { repo_path: tool.schema.string(), paths: tool.schema.array(tool.schema.string()).optional() },
            keys: ["repo_path", "paths"],
            buildArgs: (args) => {
                const paths = validatePaths(args.paths, "paths", false)
                if (!paths.ok) return paths
                return { ok: true, value: paths.value.length > 0 ? appendPaths(["reset"], paths.value) : ["reset"] }
            },
        },
        git_create_branch: {
            description: "Create Git new branch.",
            args: { repo_path: tool.schema.string(), branch_name: tool.schema.string(), start_point: tool.schema.string().optional() },
            keys: ["repo_path", "branch_name", "start_point"],
            buildArgs: (args) => {
                const branchName = validateBranchName(args.branch_name)
                if (!branchName.ok) return branchName
                const startPoint = validateRevision(args.start_point, "start_point", false)
                if (!startPoint.ok) return startPoint
                return { ok: true, value: ["branch", branchName.value, ...(startPoint.value === undefined ? [] : [startPoint.value])] }
            },
        },
        git_checkout: {
            description: "Checkout existing Git branch.",
            args: { repo_path: tool.schema.string(), branch_name: tool.schema.string() },
            keys: ["repo_path", "branch_name"],
            buildArgs: (args) => {
                const branchName = validateBranchName(args.branch_name)
                return branchName.ok ? { ok: true, value: ["checkout", branchName.value] } : branchName
            },
        },
        git_branch: {
            description: "List available Git branches.",
            args: { repo_path: tool.schema.string().describe("Absolute path inside the git repository.") },
            keys: repoOnlyKeys,
            buildArgs: () => ({ ok: true, value: ["branch", "--list", "--verbose", "--no-abbrev"] }),
        },
    }
}

export async function runGitTool(toolName: GitToolName, rawArgs: unknown, deps: SandboxDependencies = defaultSandboxDependencies): Promise<string> {
    const config = createGitToolConfig()[toolName]
    const failedAction = `run ${toolName}`

    try {
        const args = validatePlainArgs(rawArgs, config.keys)
        if (!args.ok) return createRetryResponse(failedAction, args.message, args.correctiveAction)

        const repoInput = validateRepoPath(args.value.repo_path)
        if (!repoInput.ok) return createRetryResponse(failedAction, repoInput.message, repoInput.correctiveAction)

        const repoPath = await resolveRepoPath(deps, repoInput.value)
        if (!repoPath.ok) return createRetryResponse(failedAction, repoPath.message, repoPath.correctiveAction)

        const gitArgs = config.buildArgs(args.value)
        if (!gitArgs.ok) return createRetryResponse(failedAction, gitArgs.message, gitArgs.correctiveAction)

        const commandArgs = ["-C", repoPath.value, ...gitArgs.value]
        const result: SandboxCommandResult = await deps.spawn("git", commandArgs)
        const response: GitNormalResponse = {
            success: result.exitCode === 0,
            exit_code: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            command: {
                executable: "git",
                args: commandArgs,
                repo_path: repoPath.value
            },
        }

        return JSON.stringify(response)
    }
    catch (error) {
        return createAbortResponse(failedAction, error)
    }
}

export function createGitTools(deps: SandboxDependencies = defaultSandboxDependencies): Record<GitToolName, ReturnType<typeof tool>> {
    const configs = createGitToolConfig()
    return gitToolNames.reduce<Record<GitToolName, ReturnType<typeof tool>>>((tools, toolName) => {
        const config = configs[toolName]
        tools[toolName] = tool({
            description: config.description,
            args: config.args,
            async execute(args: GitArgs): Promise<string> {
                return runGitTool(toolName, args, deps)
            },
        })
        return tools
    }, {} as Record<GitToolName, ReturnType<typeof tool>>)
}
