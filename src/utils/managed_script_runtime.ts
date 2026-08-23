import { spawn as spawnChild } from "node:child_process"
import { randomBytes } from "node:crypto"
import { appendFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { isMissingFile, type SessionJobContext } from "./jobs"
import { createManagedScriptProject, createManagedScriptProjectPaths, resolveManagedScriptProjectOwner, type ManagedScriptProject, type ManagedScriptProjectFileSystem, type ManagedScriptProjectOwner, type ManagedScriptProjectOwnerResolution, type ManagedScriptProjectSpawn } from "./managed_script_project"
import { flattenError } from "./tools"

const defaultTimeoutMs = 300_000
const maximumTimeoutMs = 1_800_000
const inlineOutputCapBytes = 65_536
const terminateGraceMs = 5_000
const pollMs = 100

export type ManagedScriptRuntimeStats = {
    isDirectory: () => boolean
    isFile: () => boolean
    isSymbolicLink: () => boolean
}

export type ManagedScriptRuntimeFileSystem = Omit<ManagedScriptProjectFileSystem, "stat"> & {
    appendFile: (filePath: string, content: string | Buffer) => Promise<void>
    lstat: (filePath: string) => Promise<ManagedScriptRuntimeStats>
    realpath: (filePath: string) => Promise<string>
    stat: (filePath: string) => Promise<ManagedScriptRuntimeStats>
}

export type ManagedScriptRuntimeOutput = {
    on: (event: "data", listener: (chunk: Buffer) => void) => unknown
}

export type ManagedScriptRuntimeChild = {
    pid?: number
    stdout?: ManagedScriptRuntimeOutput
    stderr?: ManagedScriptRuntimeOutput
    on: {
        (event: "error", listener: (error: Error) => void): unknown
        (event: "close", listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): unknown
    }
}

export type ManagedScriptRuntimeSpawnOptions = {
    cwd: string
    env: NodeJS.ProcessEnv
    detached: boolean
    shell: false
    stdio: "pipe"
}

export type ManagedScriptRuntimeProcess = {
    execPath: string
    env: NodeJS.ProcessEnv
    platform: NodeJS.Platform
    spawn: (command: string, args: readonly string[], options: ManagedScriptRuntimeSpawnOptions) => ManagedScriptRuntimeChild
    kill: (pid: number, signal: NodeJS.Signals | 0) => void
}

export type ManagedScriptRunInput = { entry: string, argv?: string[], timeoutMs?: number }

export type ManagedScriptRunResult = {
    exit_code: number | null
    stdout: string
    stderr: string
    duration_ms: number
    log_path: string
    timed_out: boolean
    stdout_truncated: boolean
    stderr_truncated: boolean
}

export type ManagedScriptServiceStartResult = {
    run_id: string
    stdout_log_path: string
    stderr_log_path: string
    observed_ports?: number[]
}

export type ManagedScriptServiceActionInput = { run_id: string }

export type ManagedScriptServiceStatus = {
    run_id: string
    running: true
    entry: string
    argv: string[]
    started_at: string
    stdout_log_path: string
    stderr_log_path: string
    observed_ports?: number[]
}

export type ManagedScriptServiceStopResult = { run_id: string, stopped: true }
export type ManagedScriptServiceCleanupResult = { stopped_run_ids: string[], finalized_run_ids: string[] }

export type ManagedScriptRuntimeDependencies = {
    context: SessionJobContext
    client?: OpencodeClient
    fileSystem?: ManagedScriptRuntimeFileSystem
    process?: ManagedScriptRuntimeProcess
    project?: ManagedScriptProject
    projectSpawn?: ManagedScriptProjectSpawn
    resolveOwner?: () => Promise<ManagedScriptProjectOwnerResolution>
    now?: () => number
    randomBytes?: (size: number) => Buffer
    sleep?: (milliseconds: number) => Promise<void>
}

export type ManagedScriptRuntime = {
    run: (input: ManagedScriptRunInput) => Promise<ManagedScriptRunResult>
    start: (input: Omit<ManagedScriptRunInput, "timeoutMs">) => Promise<ManagedScriptServiceStartResult>
    status: (input: ManagedScriptServiceActionInput) => Promise<ManagedScriptServiceStatus>
    stop: (input: ManagedScriptServiceActionInput) => Promise<ManagedScriptServiceStopResult>
    cleanup: () => Promise<ManagedScriptServiceCleanupResult>
}

type ServiceState = {
    version: 1
    ownership: { job_name: string, workspace_path: string, session_id: string }
    run_id: string
    pid: number
    pgid: number
    process_start_time: string
    command: string
    entry: string
    argv: string[]
    started_at: string
    stdout_log_path: string
    stderr_log_path: string
}

type ProcessIdentity = { startTime: string, processGroup: number, state: string, command: string[] }

async function defaultReadDirectory(dirPath: string, options?: { withFileTypes?: boolean }): Promise<string[] | import("node:fs").Dirent[]> {
    return options?.withFileTypes ? await readdir(dirPath, { withFileTypes: true }) : await readdir(dirPath)
}

const defaultFileSystem: ManagedScriptRuntimeFileSystem = { appendFile, lstat, mkdir, readFile, readdir: defaultReadDirectory, realpath, rename, rm, stat, writeFile }
const defaultProcess: ManagedScriptRuntimeProcess = {
    execPath: "node",
    env: process.env,
    platform: process.platform,
    spawn: (command: string, args: readonly string[], options: ManagedScriptRuntimeSpawnOptions): ManagedScriptRuntimeChild => spawnChild(command, [...args], options),
    kill: (pid: number, signal: NodeJS.Signals | 0): void => { process.kill(pid, signal) },
}

function isInside(candidatePath: string, rootPath: string): boolean {
    const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath))
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function serviceDirectory(workspacePath: string): string {
    return path.join(createManagedScriptProjectPaths(workspacePath).scriptsRoot, "services")
}

function statePath(workspacePath: string, runId: string): string {
    return path.join(serviceDirectory(workspacePath), `${runId}.json`)
}

function validateEntry(entry: string): void {
    if (typeof entry !== "string" || !entry) throw new Error("Managed script entry must be a source-relative .mjs file without traversal.")
    const segments = entry.split("/")
    if (path.isAbsolute(entry) || path.win32.isAbsolute(entry) || entry.includes("\\") || segments.includes("..") || segments[0] === "src" || !entry.endsWith(".mjs")) {
        throw new Error("Managed script entry must be a source-relative .mjs file without traversal.")
    }
}

function validateArgv(argv: string[]): void {
    if (!Array.isArray(argv) || !argv.every((argument: unknown): boolean => typeof argument === "string")) throw new Error("Managed script argv must contain only strings.")
}

function validateTimeout(timeoutMs: number | undefined): number {
    if (timeoutMs === undefined) return defaultTimeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > maximumTimeoutMs) throw new Error(`Managed script timeout must be between 1 and ${maximumTimeoutMs} milliseconds.`)
    return Math.floor(timeoutMs)
}

function validateRunId(runId: string): void {
    if (!/^[a-f0-9]{48}$/.test(runId)) throw new Error("Invalid managed script service run ID.")
}

function truncateOutput(value: Buffer): { value: string, truncated: boolean } {
    if (value.length <= inlineOutputCapBytes) return { value: value.toString("utf8"), truncated: false }
    const head = Math.floor(inlineOutputCapBytes / 2)
    return { value: Buffer.concat([value.subarray(0, head), value.subarray(value.length - (inlineOutputCapBytes - head))]).toString("utf8"), truncated: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseState(value: unknown): ServiceState | undefined {
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.ownership)) return undefined
    const owner = value.ownership
    if (
        typeof owner.job_name !== "string" || typeof owner.workspace_path !== "string" || typeof owner.session_id !== "string"
        || typeof value.run_id !== "string" || typeof value.pid !== "number" || !Number.isInteger(value.pid) || typeof value.pgid !== "number" || !Number.isInteger(value.pgid)
        || typeof value.process_start_time !== "string" || typeof value.command !== "string" || typeof value.entry !== "string"
        || !Array.isArray(value.argv) || !value.argv.every((argument: unknown): boolean => typeof argument === "string")
        || typeof value.started_at !== "string" || typeof value.stdout_log_path !== "string" || typeof value.stderr_log_path !== "string"
    ) return undefined
    return {
        version: 1,
        ownership: { job_name: owner.job_name, workspace_path: owner.workspace_path, session_id: owner.session_id },
        run_id: value.run_id,
        pid: value.pid,
        pgid: value.pgid,
        process_start_time: value.process_start_time,
        command: value.command,
        entry: value.entry,
        argv: value.argv,
        started_at: value.started_at,
        stdout_log_path: value.stdout_log_path,
        stderr_log_path: value.stderr_log_path,
    }
}

function belongsToOwner(state: ServiceState, owner: ManagedScriptProjectOwner, sessionId: string): boolean {
    return state.ownership.job_name === owner.jobName && state.ownership.workspace_path === owner.workspacePath && state.ownership.session_id === sessionId
}

function parseProcStat(content: string): { startTime: string, processGroup: number, state: string } | undefined {
    const close = content.lastIndexOf(")")
    if (close === -1) return undefined
    const fields = content.slice(close + 1).trim().split(/\s+/)
    if (fields.length < 20 || !/^\d+$/.test(fields[2] ?? "") || !/^\d+$/.test(fields[19] ?? "")) return undefined
    return { state: fields[0] ?? "", processGroup: Number(fields[2]), startTime: fields[19] ?? "" }
}

function isMissingProcess(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
}

function defaultSleep(milliseconds: number): Promise<void> {
    return new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, milliseconds)
    })
}

async function writeAtomically(fileSystem: Pick<ManagedScriptRuntimeFileSystem, "mkdir" | "rename" | "writeFile">, filePath: string, content: string, random: (size: number) => Buffer): Promise<void> {
    const temporaryPath = `${filePath}.autocode-tmp-${random(8).toString("hex")}`
    await fileSystem.mkdir(path.dirname(filePath), { recursive: true })
    await fileSystem.writeFile(temporaryPath, content)
    await fileSystem.rename(temporaryPath, filePath)
}

async function resolveEntry(fileSystem: Pick<ManagedScriptRuntimeFileSystem, "lstat" | "realpath">, owner: ManagedScriptProjectOwner, entry: string): Promise<string> {
    validateEntry(entry)
    const paths = createManagedScriptProjectPaths(owner.workspacePath)
    const candidate = path.resolve(paths.sourceRoot, entry)
    if (!isInside(candidate, paths.sourceRoot)) throw new Error("Managed script entry must stay inside current job source root.")
    let root: string
    let resolved: string
    try {
        [root, resolved] = await Promise.all([fileSystem.realpath(paths.sourceRoot), fileSystem.realpath(candidate)])
    }
    catch (error) {
        if (isMissingFile(error)) throw new Error("Managed script entry must be an existing regular file.")
        throw error
    }
    if (!isInside(resolved, root)) throw new Error("Managed script entry symlink resolves outside current job source root.")
    if (!(await fileSystem.lstat(resolved)).isFile()) throw new Error("Managed script entry must be an existing regular file.")
    return resolved
}

function createEnvironment(runtimeProcess: ManagedScriptRuntimeProcess, owner: ManagedScriptProjectOwner): NodeJS.ProcessEnv {
    const paths = createManagedScriptProjectPaths(owner.workspacePath)
    const environment = { ...runtimeProcess.env }
    for (const key of Object.keys(environment)) {
        if (key.toUpperCase() === "NODE_OPTIONS" || key.toUpperCase() === "NODE_PATH") delete environment[key]
    }
    environment.AUTOCODE_SCRIPT_ROOT = paths.scriptsRoot
    environment.AUTOCODE_WORKSPACE_ROOT = owner.workspacePath
    return environment
}

function serviceLogs(workspacePath: string, runId: string): { stdout: string, stderr: string } {
    const paths = createManagedScriptProjectPaths(workspacePath)
    return { stdout: path.join(paths.logsPath, `service-${runId}.stdout.log`), stderr: path.join(paths.logsPath, `service-${runId}.stderr.log`) }
}

export function createManagedScriptRuntime(dependencies: ManagedScriptRuntimeDependencies): ManagedScriptRuntime {
    const fileSystem = dependencies.fileSystem ?? defaultFileSystem
    const runtimeProcess = dependencies.process ?? defaultProcess
    const now = dependencies.now ?? Date.now
    const random = dependencies.randomBytes ?? randomBytes
    const sleep = dependencies.sleep ?? defaultSleep
    const resolveOwner = dependencies.resolveOwner ?? (async (): Promise<ManagedScriptProjectOwnerResolution> => await resolveManagedScriptProjectOwner({ context: dependencies.context, client: dependencies.client, fileSystem }))
    const project = dependencies.project ?? createManagedScriptProject({ context: dependencies.context, client: dependencies.client, fileSystem, ...(dependencies.projectSpawn ? { spawn: dependencies.projectSpawn } : {}), runtime: { env: runtimeProcess.env }, resolveOwner })

    const requireOwner = async (): Promise<ManagedScriptProjectOwner> => {
        let resolution: ManagedScriptProjectOwnerResolution
        try {
            resolution = await resolveOwner()
        }
        catch (error) {
            throw new Error(`Unable to resolve current job workspace: ${flattenError(error)}`)
        }
        if (!resolution.ok) throw new Error(resolution.reason)
        return resolution.owner
    }

    const reconcile = async (owner: ManagedScriptProjectOwner): Promise<void> => {
        const result = await project.reconcile()
        if (!result.ok) throw new Error(result.blocker?.message ?? result.error?.message ?? "Managed script dependency reconciliation failed.")
        if (result.paths.workspacePath !== owner.workspacePath) throw new Error("Managed script ownership changed during dependency reconciliation.")
    }

    const readOwnedState = async (owner: ManagedScriptProjectOwner, runId: string): Promise<{ state: ServiceState, filePath: string }> => {
        validateRunId(runId)
        const filePath = statePath(owner.workspacePath, runId)
        let content: string
        try {
            content = await fileSystem.readFile(filePath, "utf8")
        }
        catch (error) {
            if (isMissingFile(error)) throw new Error("Managed script service run ID does not exist.")
            throw new Error(`Unable to read managed script service state: ${flattenError(error)}`)
        }
        let state: ServiceState | undefined
        try {
            state = parseState(JSON.parse(content) as unknown)
        }
        catch {
            state = undefined
        }
        if (!state || state.run_id !== runId) throw new Error("Managed script service state is malformed.")
        if (!belongsToOwner(state, owner, dependencies.context.sessionID)) throw new Error("Managed script service run ID belongs to another job or session.")
        return { state, filePath }
    }

    const readProcess = async (pid: number): Promise<ProcessIdentity | undefined> => {
        try {
            const [statContent, cmdline] = await Promise.all([fileSystem.readFile(`/proc/${pid}/stat`, "utf8"), fileSystem.readFile(`/proc/${pid}/cmdline`, "utf8")])
            const parsed = parseProcStat(statContent)
            return parsed ? { ...parsed, command: cmdline.split("\0").filter((part: string): boolean => Boolean(part)) } : undefined
        }
        catch (error) {
            if (isMissingFile(error)) return undefined
            throw new Error(`Unable to inspect managed script process: ${flattenError(error)}`)
        }
    }

    const validateProcess = async (state: ServiceState): Promise<boolean> => {
        const processIdentity = await readProcess(state.pid)
        if (!processIdentity || processIdentity.state === "Z") return false
        if (processIdentity.startTime !== state.process_start_time || processIdentity.processGroup !== state.pgid) throw new Error("Managed script service process identity changed; refusing to signal it.")
        if (processIdentity.command[0] !== state.command || processIdentity.command[1] !== state.entry || processIdentity.command.slice(2).join("\0") !== state.argv.join("\0")) throw new Error("Managed script service command does not match owned state; refusing to signal it.")
        return true
    }

    const signalGroup = (pgid: number, signal: NodeJS.Signals): boolean => {
        try {
            runtimeProcess.kill(-pgid, signal)
            return true
        }
        catch (error) {
            if (isMissingProcess(error)) return false
            throw new Error(`Unable to signal managed script process group: ${flattenError(error)}`)
        }
    }

    const groupAlive = (pgid: number): boolean => {
        try {
            runtimeProcess.kill(-pgid, 0)
            return true
        }
        catch (error) {
            if (isMissingProcess(error)) return false
            throw new Error(`Unable to inspect managed script process group: ${flattenError(error)}`)
        }
    }

    const waitForGroup = async (pgid: number): Promise<boolean> => {
        const deadline = now() + terminateGraceMs
        while (groupAlive(pgid)) {
            if (now() >= deadline) return false
            await sleep(pollMs)
        }
        return true
    }

    const stopState = async (state: ServiceState, filePath: string): Promise<void> => {
        if (!await validateProcess(state)) {
            await fileSystem.rm(filePath, { force: true })
            throw new Error("Managed script service has already exited.")
        }
        signalGroup(state.pgid, "SIGTERM")
        if (!await waitForGroup(state.pgid)) {
            signalGroup(state.pgid, "SIGKILL")
            if (!await waitForGroup(state.pgid)) throw new Error("Managed script service process group did not exit after SIGKILL.")
        }
        await fileSystem.rm(filePath, { force: true })
    }

    const run = async (input: ManagedScriptRunInput): Promise<ManagedScriptRunResult> => {
        const owner = await requireOwner()
        const argv = input.argv ?? []
        validateArgv(argv)
        const timeoutMs = validateTimeout(input.timeoutMs)
        await reconcile(owner)
        const entry = await resolveEntry(fileSystem, owner, input.entry)
        const paths = createManagedScriptProjectPaths(owner.workspacePath)
        const logPath = path.join(paths.logsPath, `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${random(8).toString("hex")}.log`)
        const started = now()
        const execution = await new Promise<{ exitCode: number | null, stdout: Buffer, stderr: Buffer, timedOut: boolean }>((resolve: (result: { exitCode: number | null, stdout: Buffer, stderr: Buffer, timedOut: boolean }) => void): void => {
            const stdout: Buffer[] = []
            const stderr: Buffer[] = []
            let timedOut = false
            let settled = false
            let timeout: ReturnType<typeof setTimeout> | undefined
            let forceKill: ReturnType<typeof setTimeout> | undefined
            const finish = (exitCode: number | null): void => {
                if (settled) return
                settled = true
                if (timeout) clearTimeout(timeout)
                if (forceKill) clearTimeout(forceKill)
                resolve({ exitCode: timedOut ? null : exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut })
            }
            let child: ManagedScriptRuntimeChild
            try {
                child = runtimeProcess.spawn(runtimeProcess.execPath, [entry, ...argv], { cwd: paths.scriptsRoot, env: createEnvironment(runtimeProcess, owner), detached: true, shell: false, stdio: "pipe" })
            }
            catch (error) {
                stderr.push(Buffer.from(flattenError(error)))
                finish(null)
                return
            }
            if (!child.pid || child.pid < 1) {
                stderr.push(Buffer.from("Managed script process did not provide a PID."))
                finish(null)
                return
            }
            child.stdout?.on("data", (chunk: Buffer): void => { stdout.push(Buffer.from(chunk)) })
            child.stderr?.on("data", (chunk: Buffer): void => { stderr.push(Buffer.from(chunk)) })
            const pgid = child.pid
            child.on("error", (error: Error): void => { stderr.push(Buffer.from(error.message)); finish(null) })
            child.on("close", (exitCode: number | null, signal: NodeJS.Signals | null): void => finish(signal ? null : exitCode))
            timeout = setTimeout((): void => {
                timedOut = true
                signalGroup(pgid, "SIGTERM")
                forceKill = setTimeout((): void => { if (!settled) signalGroup(pgid, "SIGKILL") }, terminateGraceMs)
            }, timeoutMs)
        })
        const stdout = truncateOutput(execution.stdout)
        const stderr = truncateOutput(execution.stderr)
        const durationMs = Math.max(0, now() - started)
        await fileSystem.writeFile(logPath, `${JSON.stringify({ exit_code: execution.exitCode, duration_ms: durationMs, timed_out: execution.timedOut, stdout_bytes: execution.stdout.length, stderr_bytes: execution.stderr.length }, undefined, 2)}\n\nstdout:\n${execution.stdout.toString("utf8")}\n\nstderr:\n${execution.stderr.toString("utf8")}\n`)
        return { exit_code: execution.exitCode, stdout: stdout.value, stderr: stderr.value, duration_ms: durationMs, log_path: logPath, timed_out: execution.timedOut, stdout_truncated: stdout.truncated, stderr_truncated: stderr.truncated }
    }

    const start = async (input: Omit<ManagedScriptRunInput, "timeoutMs">): Promise<ManagedScriptServiceStartResult> => {
        const owner = await requireOwner()
        if (runtimeProcess.platform !== "linux") throw new Error("Managed script services are supported only on Linux.")
        const argv = input.argv ?? []
        validateArgv(argv)
        await reconcile(owner)
        const entry = await resolveEntry(fileSystem, owner, input.entry)
        const runId = random(24).toString("hex")
        const paths = createManagedScriptProjectPaths(owner.workspacePath)
        const logs = serviceLogs(owner.workspacePath, runId)
        await fileSystem.mkdir(paths.logsPath, { recursive: true })
        await fileSystem.writeFile(logs.stdout, "")
        await fileSystem.writeFile(logs.stderr, "")
        let child: ManagedScriptRuntimeChild
        try {
            child = runtimeProcess.spawn(runtimeProcess.execPath, [entry, ...argv], { cwd: paths.scriptsRoot, env: createEnvironment(runtimeProcess, owner), detached: true, shell: false, stdio: "pipe" })
        }
        catch (error) {
            throw new Error(`Unable to start managed script service: ${flattenError(error)}`)
        }
        if (!child.pid || child.pid < 1) throw new Error("Managed script service did not provide a PID.")
        child.stdout?.on("data", (chunk: Buffer): void => { void fileSystem.appendFile(logs.stdout, chunk) })
        child.stderr?.on("data", (chunk: Buffer): void => { void fileSystem.appendFile(logs.stderr, chunk) })
        const identity = await readProcess(child.pid)
        if (!identity || identity.state === "Z" || identity.processGroup !== child.pid || identity.command[0] !== runtimeProcess.execPath || identity.command[1] !== entry || identity.command.slice(2).join("\0") !== argv.join("\0")) {
            signalGroup(child.pid, "SIGKILL")
            throw new Error("Managed script service process identity could not be verified.")
        }
        const state: ServiceState = {
            version: 1,
            ownership: { job_name: owner.jobName, workspace_path: owner.workspacePath, session_id: dependencies.context.sessionID },
            run_id: runId,
            pid: child.pid,
            pgid: identity.processGroup,
            process_start_time: identity.startTime,
            command: runtimeProcess.execPath,
            entry,
            argv: [...argv],
            started_at: new Date(now()).toISOString(),
            stdout_log_path: logs.stdout,
            stderr_log_path: logs.stderr,
        }
        try {
            await writeAtomically(fileSystem, statePath(owner.workspacePath, runId), `${JSON.stringify(state, undefined, 2)}\n`, random)
        }
        catch (error) {
            signalGroup(child.pid, "SIGKILL")
            throw new Error(`Unable to persist managed script service state: ${flattenError(error)}`)
        }
        return { run_id: runId, stdout_log_path: logs.stdout, stderr_log_path: logs.stderr }
    }

    const status = async (input: ManagedScriptServiceActionInput): Promise<ManagedScriptServiceStatus> => {
        const owner = await requireOwner()
        if (runtimeProcess.platform !== "linux") throw new Error("Managed script services are supported only on Linux.")
        const { state, filePath } = await readOwnedState(owner, input.run_id)
        if (!await validateProcess(state)) {
            await fileSystem.rm(filePath, { force: true })
            throw new Error("Managed script service has already exited.")
        }
        return { run_id: state.run_id, running: true, entry: state.entry, argv: state.argv, started_at: state.started_at, stdout_log_path: state.stdout_log_path, stderr_log_path: state.stderr_log_path }
    }

    const stop = async (input: ManagedScriptServiceActionInput): Promise<ManagedScriptServiceStopResult> => {
        const owner = await requireOwner()
        if (runtimeProcess.platform !== "linux") throw new Error("Managed script services are supported only on Linux.")
        const { state, filePath } = await readOwnedState(owner, input.run_id)
        await stopState(state, filePath)
        return { run_id: state.run_id, stopped: true }
    }

    const cleanup = async (): Promise<ManagedScriptServiceCleanupResult> => {
        const owner = await requireOwner()
        if (runtimeProcess.platform !== "linux") throw new Error("Managed script services are supported only on Linux.")
        let entries: string[]
        try {
            entries = await fileSystem.readdir(serviceDirectory(owner.workspacePath)) as string[]
        }
        catch (error) {
            if (isMissingFile(error)) return { stopped_run_ids: [], finalized_run_ids: [] }
            throw new Error(`Unable to list managed script services: ${flattenError(error)}`)
        }
        const stoppedRunIds: string[] = []
        const finalizedRunIds: string[] = []
        for (const entry of entries) {
            const runId = entry.endsWith(".json") ? entry.slice(0, -5) : ""
            if (!/^[a-f0-9]{48}$/.test(runId)) continue
            let state: ServiceState | undefined
            const filePath = statePath(owner.workspacePath, runId)
            try {
                state = parseState(JSON.parse(await fileSystem.readFile(filePath, "utf8")) as unknown)
            }
            catch {
                continue
            }
            if (!state || !belongsToOwner(state, owner, dependencies.context.sessionID)) continue
            let running: boolean
            try {
                running = await validateProcess(state)
            }
            catch (error) {
                if (!(error instanceof Error) || (!error.message.startsWith("Managed script service process identity changed") && !error.message.startsWith("Managed script service command does not match"))) throw error
                await fileSystem.rm(filePath, { force: true })
                finalizedRunIds.push(runId)
                continue
            }
            if (!running) {
                await fileSystem.rm(filePath, { force: true })
                finalizedRunIds.push(runId)
                continue
            }
            await stopState(state, filePath)
            stoppedRunIds.push(runId)
        }
        return { stopped_run_ids: stoppedRunIds, finalized_run_ids: finalizedRunIds }
    }

    return { run, start, status, stop, cleanup }
}

export async function cleanupManagedScriptServices(runtime: Pick<ManagedScriptRuntime, "cleanup">): Promise<ManagedScriptServiceCleanupResult> {
    return await runtime.cleanup()
}
