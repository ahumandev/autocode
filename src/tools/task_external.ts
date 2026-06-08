import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "@opencode-ai/plugin"
import { Cause, Effect, Exit } from "effect"
import { spawn as nodeSpawn } from "child_process"
import { realpath as nodeRealpath, stat as nodeStat } from "fs/promises"
import { isAbsolute, resolve } from "path"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

type RunResult = {
    stdout: string
    stderr: string
    exitCode: number | null
    signal: NodeJS.Signals | null
}

type TaskProjectDependencies = {
    stat: (path: string) => Promise<{ isDirectory(): boolean }>
    realpath?: (path: string) => Promise<string>
    spawn: (command: string, args: string[], options: { stdio: ["ignore", "pipe", "pipe"], env?: NodeJS.ProcessEnv }) => {
        stdout: {
            setEncoding(encoding: BufferEncoding): unknown
            on(event: "data", listener: (chunk: string) => void): unknown
        }
        stderr: {
            setEncoding(encoding: BufferEncoding): unknown
            on(event: "data", listener: (chunk: string) => void): unknown
        }
        on(event: "error", listener: (error: Error) => void): unknown
        on(event: "close", listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): unknown
    }
}

type ExternalDirectoryToolContext = ToolContext & {
    directory?: string
    ask?: ToolContext["ask"]
}

type ResolvedTargetDirectory = {
    resolvedTargetDirectory: string
    resolvedContextDirectory?: string
}

type ExternalDirectoryAuthorizationRequest = {
    permission: "external_directory"
    patterns: string[]
    always: string[]
    metadata: {
        tool: "task_external"
        target_directory: string
        requested_target_directory: string
        context_directory?: string
        resolved_context_directory?: string
        resolved_target_directory: string
    }
}

const TASK_EXTERNAL_AGENT = "general"

const defaultDependencies: TaskProjectDependencies = {
    stat: nodeStat,
    realpath: nodeRealpath,
    spawn: nodeSpawn as TaskProjectDependencies["spawn"],
}

const OPENCODE_ENV_ALLOWLIST = [
    "OPENCODE_BINARY",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
] as const

function createSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const spawnEnv: NodeJS.ProcessEnv = { ...env }

    delete spawnEnv.AGENT

    for (const key of Object.keys(spawnEnv)) {
        if (key.startsWith("OPENCODE_")) {
            delete spawnEnv[key]
        }
    }

    for (const key of OPENCODE_ENV_ALLOWLIST) {
        const value = env[key]
        if (value !== undefined) {
            spawnEnv[key] = value
        }
    }

    return spawnEnv
}

function runOpencode(directory: string, prompt: string, deps: TaskProjectDependencies): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const env = createSpawnEnv(process.env)
        const child = deps.spawn("opencode", ["run", "--dir", directory, "--agent", TASK_EXTERNAL_AGENT, prompt], {
            stdio: ["ignore", "pipe", "pipe"],
            env,
        })

        let stdout = ""
        let stderr = ""

        child.stdout.setEncoding("utf8")
        child.stderr.setEncoding("utf8")

        child.stdout.on("data", (chunk) => {
            stdout += chunk
        })

        child.stderr.on("data", (chunk) => {
            stderr += chunk
        })

        child.on("error", reject)
        child.on("close", (exitCode, signal) => {
            resolve({ stdout, stderr, exitCode, signal })
        })
    })
}

function createExternalDirectoryPatterns(directory: string): string[] {
    const descendantPattern = directory === "/" ? "/*" : `${directory}/*`

    return [directory, descendantPattern]
}

async function resolveTargetDirectory(
    targetDirectory: string,
    context: ExternalDirectoryToolContext,
    deps: TaskProjectDependencies,
): Promise<ResolvedTargetDirectory> {
    if (isAbsolute(targetDirectory)) {
        return { resolvedTargetDirectory: resolve(targetDirectory) }
    }

    if (!context.directory) {
        throw new Error("Tool context directory is unavailable")
    }

    const realpath = deps.realpath ?? nodeRealpath
    const resolvedContextDirectory = await realpath(context.directory)

    return {
        resolvedContextDirectory,
        resolvedTargetDirectory: resolve(resolvedContextDirectory, targetDirectory),
    }
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
    return typeof value === "object" && value !== null && typeof (value as PromiseLike<void>).then === "function"
}

async function authorizeExternalDirectory(authorization: unknown): Promise<void> {
    if (Effect.isEffect(authorization)) {
        const exit = await Effect.runPromiseExit(authorization as Effect.Effect<void>)
        if (Exit.isSuccess(exit)) {
            return
        }

        const reason = exit.cause.reasons[0]
        if (reason && Cause.isFailReason(reason)) {
            throw reason.error
        }

        if (reason && Cause.isDieReason(reason)) {
            throw reason.defect
        }

        throw exit.cause
    }

    if (isPromiseLike(authorization)) {
        await authorization
        return
    }

    throw new Error("Tool context ask() returned a non-promise result")
}

function createExternalDirectoryAuthorizationRequest(
    canonicalTargetDirectory: string,
    requestedTargetDirectory: string,
    contextDirectory: string | undefined,
    resolvedContextDirectory: string | undefined,
    resolvedTargetDirectory: string,
): ExternalDirectoryAuthorizationRequest {
    const patterns = createExternalDirectoryPatterns(canonicalTargetDirectory)

    return {
        permission: "external_directory",
        patterns,
        always: patterns,
        metadata: {
            tool: "task_external",
            target_directory: canonicalTargetDirectory,
            requested_target_directory: requestedTargetDirectory,
            context_directory: contextDirectory,
            resolved_context_directory: resolvedContextDirectory,
            resolved_target_directory: resolvedTargetDirectory,
        },
    }
}

export function createTaskProjectTool(deps: TaskProjectDependencies = defaultDependencies) {
    return tool({
        description: "Call `task_external` tool to run a prompt in another project directory with a fresh OpenCode session.",
        args: {
            target_directory: tool.schema.string().describe("Project directory to run in."),
            prompt: tool.schema.string().describe("Prompt to send to the new external session."),
        },
        async execute(args, context) {
            const toolContext = context as ExternalDirectoryToolContext
            const targetDirectory = args.target_directory?.trim()
            const prompt = args.prompt?.trim()

            if (!targetDirectory) {
                return createRetryResponse(
                    "start project task",
                    "Missing required argument: target_directory",
                    "Provide the target project directory path."
                )
            }

            if (!prompt) {
                return createRetryResponse(
                    "start project task",
                    "Missing required argument: prompt",
                    "Provide the prompt or task to send to the spawned opencode session."
                )
            }

            let resolvedTargetDirectory: string
            let resolvedContextDirectory: string | undefined

            try {
                const resolvedTarget = await resolveTargetDirectory(targetDirectory, toolContext, deps)
                resolvedTargetDirectory = resolvedTarget.resolvedTargetDirectory
                resolvedContextDirectory = resolvedTarget.resolvedContextDirectory
            }
            catch (error) {
                return createAbortResponse("start project task", error)
            }

            let canonicalTargetDirectory: string

            try {
                const directoryStat = await deps.stat(resolvedTargetDirectory)
                if (!directoryStat.isDirectory()) {
                    return createRetryResponse(
                        "start project task",
                        `${resolvedTargetDirectory} is not a directory`,
                        "Provide an existing project directory path."
                    )
                }

                const realpath = deps.realpath ?? nodeRealpath
                canonicalTargetDirectory = await realpath(resolvedTargetDirectory)

                const canonicalDirectoryStat = await deps.stat(canonicalTargetDirectory)
                if (!canonicalDirectoryStat.isDirectory()) {
                    return createRetryResponse(
                        "start project task",
                        `${canonicalTargetDirectory} is not a directory`,
                        "Provide an existing project directory path."
                    )
                }
            }
            catch (error) {
                return createRetryResponse(
                    "start project task",
                    error,
                    "Provide an existing project directory path."
                )
            }

            if (typeof toolContext.ask !== "function") {
                return createAbortResponse("authorize external directory", "Tool context ask() is unavailable")
            }

            try {
                const authorization = toolContext.ask(createExternalDirectoryAuthorizationRequest(
                    canonicalTargetDirectory,
                    targetDirectory,
                    toolContext.directory,
                    resolvedContextDirectory,
                    resolvedTargetDirectory,
                ))

                await authorizeExternalDirectory(authorization)
            }
            catch (error) {
                return createAbortResponse("authorize external directory", error)
            }

            try {
                const result = await runOpencode(canonicalTargetDirectory, prompt, deps)

                if (result.exitCode !== 0 || result.signal) {
                    return createAbortResponse("run project task", result)
                }

                return JSON.stringify({
                    target_directory: canonicalTargetDirectory,
                    status: "completed",
                    exit_code: result.exitCode,
                    signal: result.signal,
                    // Raw subprocess passthrough output is retained for compatibility.
                    stdout: result.stdout,
                    stderr: result.stderr,
                })
            }
            catch (error) {
                return createAbortResponse("start project task", error)
            }
        },
    })
}
