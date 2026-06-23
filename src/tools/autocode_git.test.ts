import { afterEach, describe, expect, mock, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import type { SandboxCommandResult, SandboxDependencies } from "@/utils/sandbox"
import { resetRetryCounts } from "@/utils/tools"
import { createGitTools, runGitTool, type GitToolName } from "./autocode_git"

type ParsedError = {
    error: string
    failedAction: string
    instruction: string
}

type ParsedGitResponse = {
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

const tempDirs: string[] = []

afterEach(async (): Promise<void> => {
    resetRetryCounts()
    await Promise.all(tempDirs.splice(0).map((dirPath) => fs.promises.rm(dirPath, { recursive: true, force: true })))
})

async function createRealRepoPath(): Promise<string> {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "autocode-git-"))
    tempDirs.push(tempDir)
    return fs.promises.realpath(tempDir)
}

function parseResult<T>(result: string | { output: string }): T {
    return JSON.parse(typeof result === "string" ? result : result.output) as T
}

function expectRetry(result: string): ParsedError {
    const error = parseResult<ParsedError>(result)
    expect(error.failedAction.startsWith("run git_")).toBe(true)
    expect(typeof error.error).toBe("string")
    expect(error.instruction).not.toContain("ABORT")
    return error
}

function expectAbort(result: string): ParsedError {
    const error = parseResult<ParsedError>(result)
    expect(error.failedAction.startsWith("run git_")).toBe(true)
    expect(typeof error.error).toBe("string")
    expect(error.instruction).toContain("ABORT")
    return error
}

function createDeps(spawnImpl: SandboxDependencies["spawn"]): SandboxDependencies {
    return {
        spawn: spawnImpl,
        fileSystem: {} as SandboxDependencies["fileSystem"],
        process: {} as SandboxDependencies["process"],
    }
}

function createSuccessfulDeps(realRepo: string, finalResult: SandboxCommandResult = { exitCode: 0, stdout: "ok", stderr: "" }): { deps: SandboxDependencies, spawn: ReturnType<typeof mock> } {
    const results = [{ exitCode: 0, stdout: `${realRepo}\n`, stderr: "" }, finalResult]
    const spawn = mock(async () => results.shift() ?? finalResult)
    return { deps: createDeps(spawn), spawn }
}

async function runSuccessfulTool(toolName: GitToolName, rawArgs: Record<string, unknown>, finalResult: SandboxCommandResult = { exitCode: 0, stdout: "ok", stderr: "" }): Promise<{ realRepo: string, response: ParsedGitResponse, spawn: ReturnType<typeof mock> }> {
    const realRepo = await createRealRepoPath()
    const { deps, spawn } = createSuccessfulDeps(realRepo, finalResult)
    const response = parseResult<ParsedGitResponse>(await runGitTool(toolName, { repo_path: realRepo, ...rawArgs }, deps))
    return { realRepo, response, spawn }
}

async function expectFinalArgs(toolName: GitToolName, rawArgs: Record<string, unknown>, expectedArgs: string[]): Promise<void> {
    const { realRepo, response, spawn } = await runSuccessfulTool(toolName, rawArgs)
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn).toHaveBeenNthCalledWith(2, "git", ["-C", realRepo, ...expectedArgs])
    expect(response.command.args).toEqual(["-C", realRepo, ...expectedArgs])
}

describe("autocode git tools", () => {
    test("git_status validates repo, executes status, and returns command metadata", async () => {
        const realRepo = await createRealRepoPath()
        const finalResult = { exitCode: 0, stdout: "## main\n", stderr: "" }
        const { deps, spawn } = createSuccessfulDeps(realRepo, finalResult)

        const response = parseResult<ParsedGitResponse>(await runGitTool("git_status", { repo_path: realRepo }, deps))

        expect(spawn).toHaveBeenCalledTimes(2)
        expect(spawn).toHaveBeenNthCalledWith(1, "git", ["-C", realRepo, "rev-parse", "--show-toplevel"])
        expect(spawn).toHaveBeenNthCalledWith(2, "git", ["-C", realRepo, "status", "--short", "--branch"])
        expect(response).toEqual({
            success: true,
            exit_code: 0,
            stdout: finalResult.stdout,
            stderr: finalResult.stderr,
            command: { executable: "git", args: ["-C", realRepo, "status", "--short", "--branch"], repo_path: realRepo },
        })
    })

    test("repo_path resolves realpath before rev-parse, final command, and metadata", async () => {
        const realRepo = await createRealRepoPath()
        const linkParent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "autocode-git-link-"))
        tempDirs.push(linkParent)
        const symlinkRepo = path.join(linkParent, "repo")
        await fs.promises.symlink(realRepo, symlinkRepo, "dir")
        const finalResult = { exitCode: 0, stdout: "## main\n", stderr: "" }
        const { deps, spawn } = createSuccessfulDeps(realRepo, finalResult)

        const response = parseResult<ParsedGitResponse>(await runGitTool("git_status", { repo_path: symlinkRepo }, deps))

        expect(spawn).toHaveBeenCalledTimes(2)
        expect(spawn).toHaveBeenNthCalledWith(1, "git", ["-C", realRepo, "rev-parse", "--show-toplevel"])
        expect(spawn).toHaveBeenNthCalledWith(2, "git", ["-C", realRepo, "status", "--short", "--branch"])
        expect(response.command.args).toEqual(["-C", realRepo, "status", "--short", "--branch"])
        expect(response.command.repo_path).toBe(realRepo)
        expect(response.command.repo_path).not.toBe(symlinkRepo)
    })

    test("git_status returns normal JSON when final command exits nonzero", async () => {
        const realRepo = await createRealRepoPath()
        const finalResult = { exitCode: 2, stdout: "", stderr: "bad" }
        const { deps, spawn } = createSuccessfulDeps(realRepo, finalResult)

        const response = parseResult<ParsedGitResponse>(await runGitTool("git_status", { repo_path: realRepo }, deps))

        expect(spawn).toHaveBeenCalledTimes(2)
        expect(spawn).toHaveBeenNthCalledWith(1, "git", ["-C", realRepo, "rev-parse", "--show-toplevel"])
        expect(spawn).toHaveBeenNthCalledWith(2, "git", ["-C", realRepo, "status", "--short", "--branch"])
        expect(response).toEqual({
            success: false,
            exit_code: 2,
            stdout: finalResult.stdout,
            stderr: finalResult.stderr,
            command: { executable: "git", args: ["-C", realRepo, "status", "--short", "--branch"], repo_path: realRepo },
        })
    })

    test("git_diff_unstaged builds path-limited diff args", async () => {
        await expectFinalArgs("git_diff_unstaged", { paths: ["src/file.ts"] }, ["diff", "--", "src/file.ts"])
    })

    test("git_diff_staged builds cached path-limited diff args", async () => {
        await expectFinalArgs("git_diff_staged", { paths: ["src/file.ts"] }, ["diff", "--cached", "--", "src/file.ts"])
    })

    test("git_diff requires base with target and builds revision path-limited diff args", async () => {
        const realRepo = await createRealRepoPath()
        const { deps, spawn } = createSuccessfulDeps(realRepo)

        expectRetry(await runGitTool("git_diff", { repo_path: realRepo, target: "feature" }, deps))
        expect(spawn).toHaveBeenCalledTimes(1)

        await expectFinalArgs("git_diff", { base: "main", target: "feature", paths: ["src/file.ts"] }, ["diff", "main", "feature", "--", "src/file.ts"])
    })

    test("git_log uses default and explicit max_count and rejects max_count above 100", async () => {
        await expectFinalArgs("git_log", {}, ["log", "--oneline", "--decorate", "--max-count=20"])
        await expectFinalArgs("git_log", { max_count: 100 }, ["log", "--oneline", "--decorate", "--max-count=100"])

        const realRepo = await createRealRepoPath()
        const { deps, spawn } = createSuccessfulDeps(realRepo)
        expectRetry(await runGitTool("git_log", { repo_path: realRepo, max_count: 101 }, deps))
        expect(spawn).toHaveBeenCalledTimes(1)
    })

    test("git_show builds safe revision args and rejects option-like revisions", async () => {
        await expectFinalArgs("git_show", { revision: "HEAD" }, ["show", "--stat", "--patch", "HEAD"])

        const realRepo = await createRealRepoPath()
        const { deps } = createSuccessfulDeps(realRepo)
        expectRetry(await runGitTool("git_show", { repo_path: realRepo, revision: "-bad" }, deps))
    })

    test("git_add validates files and builds add args", async () => {
        const invalidFiles = [[], ["/tmp/file"], ["../x"], ["-x"]]
        for (const files of invalidFiles) {
            const realRepo = await createRealRepoPath()
            const { deps } = createSuccessfulDeps(realRepo)
            expectRetry(await runGitTool("git_add", { repo_path: realRepo, files }, deps))
        }

        await expectFinalArgs("git_add", { files: ["file"] }, ["add", "--", "file"])
    })

    test("git_commit validates messages and builds commit args", async () => {
        const realRepo = await createRealRepoPath()
        expectRetry(await runGitTool("git_commit", { repo_path: realRepo, message: "   " }, createSuccessfulDeps(realRepo).deps))
        expectRetry(await runGitTool("git_commit", { repo_path: realRepo, message: "bad\u0000message" }, createSuccessfulDeps(realRepo).deps))

        await expectFinalArgs("git_commit", { message: "safe message" }, ["commit", "-m", "safe message"])
    })

    test("git_reset rejects unknown modes and builds reset args with and without paths", async () => {
        const realRepo = await createRealRepoPath()
        const { deps, spawn } = createSuccessfulDeps(realRepo)
        expectRetry(await runGitTool("git_reset", { repo_path: realRepo, mode: "--hard" }, deps))
        expect(spawn).not.toHaveBeenCalled()

        await expectFinalArgs("git_reset", {}, ["reset"])
        await expectFinalArgs("git_reset", { paths: ["file"] }, ["reset", "--", "file"])
    })

    test("git_create_branch rejects unsafe refs and builds branch creation args", async () => {
        for (const branch_name of ["bad..branch", "bad@{branch"]) {
            const realRepo = await createRealRepoPath()
            const { deps } = createSuccessfulDeps(realRepo)
            expectRetry(await runGitTool("git_create_branch", { repo_path: realRepo, branch_name }, deps))
        }

        await expectFinalArgs("git_create_branch", { branch_name: "new-branch", start_point: "main" }, ["branch", "new-branch", "main"])
    })

    test("git_checkout builds checkout args", async () => {
        await expectFinalArgs("git_checkout", { branch_name: "feature" }, ["checkout", "feature"])
    })

    test("git_branch builds branch list args", async () => {
        await expectFinalArgs("git_branch", {}, ["branch", "--list", "--verbose", "--no-abbrev"])
    })

    test("unknown options return retry before repo validation", async () => {
        const realRepo = await createRealRepoPath()
        const { deps, spawn } = createSuccessfulDeps(realRepo)

        expectRetry(await runGitTool("git_status", { repo_path: realRepo, unknown: true }, deps))
        expect(spawn).not.toHaveBeenCalled()
    })

    test("repo_path must be absolute and inside a git repository", async () => {
        const deps = createDeps(mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })))
        expectRetry(await runGitTool("git_status", { repo_path: "relative/path" }, deps))
        expect(deps.spawn).not.toHaveBeenCalled()

        const realRepo = await createRealRepoPath()
        const spawn = mock(async () => ({ exitCode: 128, stdout: "", stderr: "fatal" }))
        expectRetry(await runGitTool("git_status", { repo_path: realRepo }, createDeps(spawn)))
        expect(spawn).toHaveBeenCalledTimes(1)
        expect(spawn).toHaveBeenCalledWith("git", ["-C", realRepo, "rev-parse", "--show-toplevel"])
    })

    test("unexpected spawn errors return abort JSON without normal success fields", async () => {
        const realRepo = await createRealRepoPath()
        const revParseSpawn = mock(async () => {
            throw new Error("rev-parse failed")
        })

        const revParseError = expectAbort(await runGitTool("git_status", { repo_path: realRepo }, createDeps(revParseSpawn)))
        expect(revParseError).not.toHaveProperty("success")

        const finalSpawn = mock(async (_command: string, args: readonly string[]) => {
            if (args.includes("rev-parse")) return { exitCode: 0, stdout: `${realRepo}\n`, stderr: "" }
            throw new Error("status failed")
        })

        const finalError = expectAbort(await runGitTool("git_status", { repo_path: realRepo }, createDeps(finalSpawn)))
        expect(finalError).not.toHaveProperty("success")
    })

    test("createGitTools exposes all safe local git tool names", () => {
        const tools = createGitTools(createDeps(mock(async () => ({ exitCode: 0, stdout: "", stderr: "" }))))

        expect(Object.keys(tools).sort()).toEqual([...gitToolNames].sort())
    })
})
