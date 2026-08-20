import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { spawn as nodeSpawn } from "node:child_process"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"
import { assertDirectSandboxPath, assertOwnedSandboxRootPath, assertSandboxDescendantPath, defaultSandboxDependencies, detectSandboxBackend, getSandboxHomePath, getSandboxRunLockPath, normalizeSandboxName, readSandboxMetadata, resolveSandboxOwner, validateSandboxMetadata, type SandboxDependencies, type SandboxMetadata, type SandboxPaths } from "@/utils/sandbox"
import { addBubblewrapBind, addBubblewrapProxyEnv, addOptionalBubblewrapReadOnlyBind, bubblewrapHostNetworkReadOnlyBinds, bubblewrapQuickEtcReadOnlyBinds, bubblewrapQuickRootReadOnlyBinds, optionalPathExists, pathExists } from "@/utils/autocode_sandbox_helpers"

type CliRunResult = {
    stdout: string
    stderr: string
    exitCode: number | null
    signal: NodeJS.Signals | null
    timedOut: boolean
    durationMs: number
}

type SandboxCliDependencies = SandboxDependencies & {
    spawnProcess?: typeof nodeSpawn
}

const defaultTimeoutMs = 300000
const maximumTimeoutMs = 1800000
const limitationGuidance = "Sandbox uses bubblewrap (bwrap) only; proot and proot-distro metadata must be recreated."

function normalizeWorkingDir(input: unknown): { ok: true, value: string } | { ok: false, reason: string } {
    const value = typeof input === "string" && input.trim() ? input.trim() : "/home/root"
    if (!value.startsWith("/")) return { ok: false, reason: "working_dir must be an absolute guest path." }
    if (value.includes("\0")) return { ok: false, reason: "working_dir must not contain NUL bytes." }
    return { ok: true, value }
}

function normalizeTimeout(input: unknown): { ok: true, value: number } | { ok: false, reason: string } {
    if (input === undefined) return { ok: true, value: defaultTimeoutMs }
    const value = typeof input === "number" ? input : Number(input)
    if (!Number.isFinite(value) || value <= 0) return { ok: false, reason: "timeout must be a positive number of milliseconds." }
    return { ok: true, value: Math.min(Math.floor(value), maximumTimeoutMs) }
}

async function acquireLock(deps: SandboxDependencies, lockPath: string): Promise<boolean> {
    try {
        await deps.fileSystem.mkdir(lockPath)
        return true
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
        throw error
    }
}

type SandboxResolution =
    | { ok: true, paths: SandboxPaths, metadata: SandboxMetadata }
    | { ok: false, response: string }

type RootfsMetadataValidation =
    | { ok: true, rootfsPath: string }
    | { ok: false, reason: string }

async function resolveSandboxForCli(deps: SandboxDependencies, paths: SandboxPaths): Promise<SandboxResolution> {
    const safePath = assertDirectSandboxPath(paths.sandboxPath, paths.jobSandboxRoot)
    if (!safePath.ok) return { ok: false, response: JSON.stringify({ ok: false, status: "unsafe_path", reason: safePath.reason, guidance: limitationGuidance }) }

    const currentPathExists = await pathExists(deps, paths.sandboxPath)
    const metadata = currentPathExists ? await readSandboxMetadata(deps.fileSystem, paths.metadataFile) : undefined
    if (metadata !== undefined) {
        const metadataValidation = validateSandboxMetadata(paths, metadata)
        if (!metadataValidation.ok) return { ok: false, response: JSON.stringify({ ok: false, status: "invalid_metadata", reason: metadataValidation.reason, guidance: limitationGuidance }) }
        return { ok: true, paths, metadata }
    }

    return {
        ok: false,
        response: JSON.stringify({ ok: false, status: currentPathExists ? "missing_metadata" : "missing", sandbox_name: paths.sandboxName, job_name: paths.jobName, guidance: limitationGuidance }),
    }
}

async function releaseLock(deps: SandboxDependencies, lockPath: string): Promise<void> {
    if (!deps.fileSystem.rm) throw new Error("Unable to release sandbox lock: rm is unavailable")
    await deps.fileSystem.rm(lockPath, { recursive: true, force: true })
}

function getLegacyBackendDiagnostic(metadata: SandboxMetadata): string | undefined {
    if (metadata.backend !== "manual_proot" && metadata.backend !== "termux_proot_distro") return undefined

    return `Legacy sandbox backend ${metadata.backend} is unsupported. Recreate the sandbox under bubblewrap.`
}

async function validateRootfsMetadata(deps: SandboxDependencies, paths: SandboxPaths, metadata: SandboxMetadata): Promise<RootfsMetadataValidation> {
    const rootfsPath = typeof metadata.backend_data?.rootfs_path === "string" ? metadata.backend_data.rootfs_path : undefined
    if (!rootfsPath) return { ok: false, reason: "Rootfs sandbox metadata must include backend_data.rootfs_path." }

    const safeRootfsPath = assertSandboxDescendantPath(rootfsPath, paths)
    if (!safeRootfsPath.ok) return { ok: false, reason: safeRootfsPath.reason }

    if (!await optionalPathExists(deps, safeRootfsPath.value)) return { ok: false, reason: "Rootfs path from sandbox metadata does not exist." }
    return { ok: true, rootfsPath: safeRootfsPath.value }
}

async function createCommand(deps: SandboxDependencies, paths: SandboxPaths, metadata: SandboxMetadata, projectRoot: string, workingDir: string, command: string): Promise<{ command: string, args: string[] } | undefined> {
    if (metadata.backend !== "bubblewrap") return undefined

    const sandboxHome = getSandboxHomePath(paths)
    const filesystemMode = metadata.backend_data?.filesystem_mode === "rootfs" ? "rootfs" : "quick"
    const internetEnabled = metadata.backend_data?.internet_enabled === true
    const args = [
        "--die-with-parent",
        "--unshare-all",
        "--new-session",
    ]
    if (internetEnabled) args.splice(2, 0, "--share-net")

    if (filesystemMode === "rootfs") {
        const rootfsPath = typeof metadata.backend_data?.rootfs_path === "string" ? metadata.backend_data.rootfs_path : undefined
        if (!rootfsPath) return undefined
        addBubblewrapBind(args, rootfsPath, "/", false)
    }
    else {
        for (const hostPath of bubblewrapQuickRootReadOnlyBinds) {
            await addOptionalBubblewrapReadOnlyBind(deps, args, hostPath)
        }
    }

    args.push(
        "--proc", "/proc",
        "--dev", "/dev",
        "--tmpfs", "/tmp",
        "--dir", "/home",
        "--dir", "/sandbox",
        "--setenv", "HOME", "/home/root",
        "--setenv", "PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    )
    if (internetEnabled) addBubblewrapProxyEnv(args, deps.process.env)
    if (filesystemMode === "quick") args.push("--dir", "/etc")

    if (filesystemMode === "quick") {
        for (const hostPath of bubblewrapQuickEtcReadOnlyBinds) {
            await addOptionalBubblewrapReadOnlyBind(deps, args, hostPath)
        }
    }
    else if (internetEnabled) {
        for (const hostPath of bubblewrapHostNetworkReadOnlyBinds) {
            await addOptionalBubblewrapReadOnlyBind(deps, args, hostPath)
        }
    }

    addBubblewrapBind(args, projectRoot, "/workspace", true)
    addBubblewrapBind(args, metadata.root_path, "/sandbox", false)
    if (await pathExists(deps, sandboxHome)) addBubblewrapBind(args, sandboxHome, "/home", false)
    args.push("--chdir", workingDir, "/bin/sh", "-lc", command)
    return { command: "bwrap", args }
}

function runSandboxCommand(command: string, args: string[], timeoutMs: number, deps: SandboxCliDependencies): Promise<CliRunResult> {
    return new Promise((resolve, reject) => {
        const started = Date.now()
        const child = (deps.spawnProcess ?? nodeSpawn)(command, args, { env: deps.process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
        let stdout = ""
        let stderr = ""
        let timedOut = false
        const timer = setTimeout(() => {
            timedOut = true
            if (child.pid) {
                try {
                    process.kill(-child.pid, "SIGTERM")
                }
                catch {
                    child.kill("SIGTERM")
                }
            }
        }, timeoutMs)

        child.stdout?.setEncoding("utf8")
        child.stderr?.setEncoding("utf8")
        child.stdout?.on("data", (chunk: string) => { stdout += chunk })
        child.stderr?.on("data", (chunk: string) => { stderr += chunk })
        child.on("error", reject)
        child.on("close", (exitCode, signal) => {
            clearTimeout(timer)
            resolve({ stdout, stderr, exitCode, signal, timedOut, durationMs: Date.now() - started })
        })
    })
}

export function createAutocodeSandboxCliTool(client?: OpencodeClient, deps: SandboxCliDependencies = defaultSandboxDependencies) {
    return tool({
        description: "Run shell command inside existing sandbox in current resolved job. The owner resolves exact linked session first; otherwise newest job workspace matching current session-title slug. Missing owner errors before spawning command. Sandboxes are job-local at `.agents/jobs/YYYY-MM-DD_hh-mm-ss_{title_dir}/sandboxes/{sandbox_name}`.",
        args: {
            sandbox_name: tool.schema.string().describe("Existing sandbox name inside current resolved job. Same names in other jobs are independent."),
            command: tool.schema.string().describe("Shell command to execute with /bin/sh -lc."),
            working_dir: tool.schema.string().optional().describe("Absolute guest path; defaults to /home/root."),
            timeout: tool.schema.number().optional().describe("Timeout in milliseconds; defaults to 300000."),
        },
        async execute(args, context) {
            const sandboxName = normalizeSandboxName(args.sandbox_name)
            if (!sandboxName.ok) return createRetryResponse("run sandbox command", sandboxName.reason, "Use an existing sandbox name with lowercase letters, numbers, and underscores only.")
            const commandText = typeof args.command === "string" ? args.command : ""
            if (!commandText.trim()) return createRetryResponse("run sandbox command", "command must be a non-empty string.", "Provide a shell command to execute.")
            const workingDir = normalizeWorkingDir(args.working_dir)
            if (!workingDir.ok) return createRetryResponse("run sandbox command", workingDir.reason, "Use an absolute guest path such as /home/root or /.")
            const timeout = normalizeTimeout(args.timeout)
            if (!timeout.ok) return createRetryResponse("run sandbox command", timeout.reason, "Provide a positive timeout in milliseconds.")

            try {
                const owner = await resolveSandboxOwner(deps.fileSystem, client, context, sandboxName.value)
                if (!owner.ok) return createRetryResponse("run sandbox command", owner.reason, "Start or select a timestamped job workspace before using a sandbox.")
                const sandbox = await resolveSandboxForCli(deps, owner.owner)
                if (!sandbox.ok) return sandbox.response
                const { paths, metadata } = sandbox
                const legacyDiagnostic = getLegacyBackendDiagnostic(metadata)
                if (legacyDiagnostic) return JSON.stringify({ ok: false, status: "unsupported", backend: metadata.backend, reason: legacyDiagnostic, guidance: "Recreate this sandbox with autocode_sandbox_create so it uses bubblewrap metadata." })
                const backend = await detectSandboxBackend(deps)
                if (backend.backend !== "bubblewrap") {
                    return JSON.stringify({ ok: false, status: "unsupported", backend: backend.backend, reason: backend.reason, guidance: backend.guidance ?? limitationGuidance, signals: backend.signals })
                }
                const safeRootPath = assertOwnedSandboxRootPath(metadata.root_path, paths.sandboxPath, paths.jobSandboxRoot)
                if (!safeRootPath.ok) return JSON.stringify({ ok: false, status: "unsafe_path", backend: metadata.backend, reason: safeRootPath.reason, guidance: limitationGuidance })
                if (metadata.backend_data?.filesystem_mode === "rootfs") {
                    const rootfsMetadata = await validateRootfsMetadata(deps, paths, metadata)
                    if (!rootfsMetadata.ok) return JSON.stringify({ ok: false, status: "invalid_metadata", backend: metadata.backend, reason: rootfsMetadata.reason, guidance: limitationGuidance })
                    metadata.backend_data.rootfs_path = rootfsMetadata.rootfsPath
                }
                const command = await createCommand(deps, paths, metadata, paths.storageRoot, workingDir.value, commandText)
                if (!command) return JSON.stringify({ ok: false, status: "unsupported", backend: metadata.backend, reason: "Sandbox backend metadata is unsupported or incomplete; bubblewrap metadata is required.", guidance: limitationGuidance })

                const lockPath = getSandboxRunLockPath(paths)
                if (!await acquireLock(deps, lockPath)) return JSON.stringify({ ok: false, status: "busy", sandbox_name: sandboxName.value, job_name: paths.jobName, guidance: "A sandbox command is already running for this sandbox." })
                try {
                    const result = await runSandboxCommand(command.command, command.args, timeout.value, deps)
                    return JSON.stringify({
                        ok: !result.timedOut,
                        status: result.timedOut ? "timeout" : "completed",
                        backend: metadata.backend,
                        sandbox_name: sandboxName.value,
                        job_name: paths.jobName,
                        stdout: result.stdout,
                        stderr: result.stderr,
                        output: `${result.stdout}${result.stderr}`,
                        exit_code: result.exitCode,
                        signal: result.signal,
                        success: !result.timedOut && result.exitCode === 0 && !result.signal,
                        timed_out: result.timedOut,
                        duration_ms: result.durationMs,
                        guidance: limitationGuidance,
                    })
                }
                finally {
                    await releaseLock(deps, lockPath)
                }
            }
            catch (error) {
                return createAbortResponse("run sandbox command", error)
            }
        },
    })
}
