import { spawn as spawnChild } from "node:child_process"
import { randomBytes } from "node:crypto"
import { appendFile, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, truncate, writeFile } from "node:fs/promises"
import path from "node:path"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { isMissingFile, type SessionJobContext } from "./jobs"
import { createManagedScriptProject, createManagedScriptProjectPaths, resolveManagedScriptProjectOwner, type ManagedScriptProject, type ManagedScriptProjectFileSystem, type ManagedScriptProjectOwner, type ManagedScriptProjectOwnerResolution, type ManagedScriptProjectSpawn } from "./managed_script_project"
import { flattenError } from "./tools"
import { createManagedScriptWindows, isWindowsServiceIdentity, ManagedScriptWindowsError, windowsServiceMessage, type WindowsServiceCleanup, type WindowsServiceIdentity } from "./managed_script_windows"

const defaultTimeoutMs = 300_000
const maximumTimeoutMs = 1_800_000
const inlineOutputCapBytes = 65_536
const logOutputCapBytes = 1_048_576
const terminateGraceMs = 5_000
const forcedSignalWaitMs = 250
const logFlushTimeoutMs = 1_000
const pollMs = 100

export type ManagedScriptRuntimeStats = {
    size?: number
    isDirectory: () => boolean
    isFile: () => boolean
    isSymbolicLink: () => boolean
}

export type ManagedScriptRuntimeFileSystem = Omit<ManagedScriptProjectFileSystem, "stat"> & {
    appendFile: (filePath: string, content: string | Buffer) => Promise<void>
    lstat: (filePath: string) => Promise<ManagedScriptRuntimeStats>
    realpath: (filePath: string) => Promise<string>
    stat: (filePath: string) => Promise<ManagedScriptRuntimeStats>
    truncate?: (filePath: string, length: number) => Promise<void>
    open?: (filePath: string, flags: "a") => Promise<Pick<Awaited<ReturnType<typeof open>>, "fd" | "close">>
}

export type ManagedScriptRuntimeOutput = {
    on: (event: "data", listener: (chunk: Buffer) => void) => unknown
    destroy?: () => unknown
}

export type ManagedScriptRuntimeChild = {
    pid?: number
    stdout?: ManagedScriptRuntimeOutput | null
    stderr?: ManagedScriptRuntimeOutput | null
    stdin?: { end: (content: string) => unknown, on?: (event: "error", listener: (error: Error) => void) => unknown, destroy?: () => unknown } | null
    kill?: (signal: NodeJS.Signals) => boolean
    unref?: () => void
    on: {
        (event: "spawn", listener: () => void): unknown
        (event: "exit", listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): unknown
        (event: "error", listener: (error: Error) => void): unknown
        (event: "close", listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): unknown
    }
}

export type ManagedScriptRuntimeSpawnOptions = {
    cwd: string
    env: NodeJS.ProcessEnv
    detached: boolean
    shell: false
    stdio: "pipe" | ["ignore", number, number]
    windowsHide?: boolean
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

export type ManagedScriptLaunchOwner = {
    readonly jobName: string
    readonly directory: string
    readonly sessionID: string
}

export type ManagedScriptServiceStartResult = {
    owner: ManagedScriptLaunchOwner
    run_id: string
    stdout_log_path: string
    stderr_log_path: string
    observed_ports?: number[]
    message?: string
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
    message?: string
}

export type ManagedScriptServiceStopResult = { run_id: string, stopped: true, windows_cleanup?: WindowsServiceCleanup, message?: string }
export type ManagedScriptServiceCleanupResult = { stopped_run_ids: string[], finalized_run_ids: string[], windows_cleanup?: ({ run_id: string } & WindowsServiceCleanup)[] }

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

export class ManagedScriptRuntimeError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
        super(message)
        this.name = "ManagedScriptRuntimeError"
        this.code = code
    }
}

type ServiceStateFields = {
    ownership: { job_name: string, workspace_path: string, session_id: string }
    run_id: string
    command: string
    entry: string
    argv: string[]
    started_at: string
    stdout_log_path: string
    stderr_log_path: string
}

type LinuxServiceState = ServiceStateFields & { version: 1, pid: number, pgid: number, process_start_time: string }
type WindowsServiceState = ServiceStateFields & { version: 2, identity: WindowsServiceIdentity }
type ServiceState = LinuxServiceState | WindowsServiceState

type ProcessIdentity = { startTime: string, processGroup: number, state: string, command: string[] }

async function defaultReadDirectory(dirPath: string, options?: { withFileTypes?: boolean }): Promise<string[] | import("node:fs").Dirent[]> {
    return options?.withFileTypes ? await readdir(dirPath, { withFileTypes: true }) : await readdir(dirPath)
}

const defaultFileSystem: ManagedScriptRuntimeFileSystem = { appendFile, link, lstat, mkdir, open, readFile, readdir: defaultReadDirectory, realpath, rename, rm, stat, truncate, writeFile }
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

function serviceDirectory(owner: ManagedScriptProjectOwner): string {
    return createManagedScriptProjectPaths(owner.directory, owner.jobName).servicesRoot
}

function statePath(owner: ManagedScriptProjectOwner, runId: string): string {
    return path.join(serviceDirectory(owner), `${runId}.json`)
}

function validateEntry(entry: string): void {
    if (typeof entry !== "string" || !entry) throw new Error("Managed script entry must be a source-relative .mjs file without traversal.")
    const segments = entry.split("/")
    if (path.isAbsolute(entry) || path.win32.isAbsolute(entry) || entry.includes("\\") || segments.includes("..") || !entry.endsWith(".mjs")) {
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

function createOutputCollector(): { append: (chunk: Buffer) => void, result: () => { value: string, truncated: boolean, bytes: number } } {
    const storage = Buffer.alloc(inlineOutputCapBytes)
    const head = storage.subarray(0, Math.floor(inlineOutputCapBytes / 2))
    const tail = storage.subarray(head.length)
    let headLength = 0
    let tailLength = 0
    let tailOffset = 0
    let bytes = 0
    return {
        append: (chunk: Buffer): void => {
            bytes += chunk.length
            const headBytes = Math.min(chunk.length, head.length - headLength)
            chunk.copy(head, headLength, 0, headBytes)
            headLength += headBytes
            const remaining = chunk.subarray(headBytes)
            if (remaining.length >= tail.length) {
                remaining.copy(tail, 0, remaining.length - tail.length)
                tailLength = tail.length
                tailOffset = 0
                return
            }
            const firstBytes = Math.min(remaining.length, tail.length - tailOffset)
            remaining.copy(tail, tailOffset, 0, firstBytes)
            remaining.copy(tail, 0, firstBytes)
            tailOffset = (tailOffset + remaining.length) % tail.length
            tailLength = Math.min(tail.length, tailLength + remaining.length)
        },
        result: (): { value: string, truncated: boolean, bytes: number } => {
            const start = tailLength === tail.length ? tailOffset : 0
            const value = Buffer.concat([head.subarray(0, headLength), tail.subarray(start, tailLength), tail.subarray(0, start)])
            return { value: value.toString("utf8"), truncated: bytes > inlineOutputCapBytes, bytes }
        },
    }
}

function boundedErrorMessage(error: unknown): string {
    try { return flattenError(error).slice(0, inlineOutputCapBytes) || "Unknown error" }
    catch { return "Unable to format managed script error." }
}

function waitWithin<T>(pending: Promise<T>, milliseconds: number): Promise<{ completed: false } | { completed: true, value: T } | { completed: true, error: unknown }> {
    return new Promise((resolve): void => {
        let settled = false
        const finish = (result: { completed: false } | { completed: true, value: T } | { completed: true, error: unknown }): void => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            resolve(result)
        }
        const timeout = setTimeout((): void => { finish({ completed: false }) }, milliseconds)
        void pending.then((value: T): void => { finish({ completed: true, value }) }, (error: unknown): void => { finish({ completed: true, error }) })
    })
}

function createCappedLogAppender(append: (content: Buffer) => Promise<void>, initialBytes = 0): { append: (chunk: Buffer) => void, flush: () => Promise<string | undefined> } {
    const storage = Buffer.alloc(logOutputCapBytes - initialBytes)
    let reserved = 0
    let written = 0
    let active = false
    let failure: string | undefined
    let pending = Promise.resolve<string | undefined>(undefined)
    const drain = async (): Promise<string | undefined> => {
        try {
            while (written < reserved) {
                const end = reserved
                await append(storage.subarray(written, end))
                written = end
            }
        }
        catch (error) { failure = boundedErrorMessage(error) }
        active = false
        return failure
    }
    return {
        append: (chunk: Buffer): void => {
            if (failure !== undefined) return
            const length = Math.min(chunk.length, storage.length - reserved)
            if (!length) return
            chunk.copy(storage, reserved, 0, length)
            // Reserve before scheduling so concurrent data events cannot exceed the disk budget.
            reserved += length
            if (!active) {
                active = true
                pending = Promise.resolve().then(drain)
            }
        },
        flush: (): Promise<string | undefined> => pending,
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseState(value: unknown): ServiceState | undefined {
    if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !isRecord(value.ownership)) return undefined
    const owner = value.ownership
    if (
        typeof owner.job_name !== "string" || typeof owner.workspace_path !== "string" || typeof owner.session_id !== "string"
        || typeof value.run_id !== "string" || typeof value.command !== "string" || typeof value.entry !== "string"
        || !Array.isArray(value.argv) || !value.argv.every((argument: unknown): boolean => typeof argument === "string")
        || typeof value.started_at !== "string" || typeof value.stdout_log_path !== "string" || typeof value.stderr_log_path !== "string"
    ) return undefined
    if (value.version === 2 && (!owner.job_name || !owner.workspace_path || !owner.session_id || !/^[a-f0-9]{48}$/.test(value.run_id) || !isWindowsServiceIdentity(value.identity))) return undefined
    if (value.version === 1 && (typeof value.pid !== "number" || !Number.isInteger(value.pid) || typeof value.pgid !== "number" || !Number.isInteger(value.pgid) || typeof value.process_start_time !== "string")) return undefined
    const fields: ServiceStateFields = {
        ownership: { job_name: owner.job_name, workspace_path: owner.workspace_path, session_id: owner.session_id },
        run_id: value.run_id,
        command: value.command,
        entry: value.entry,
        argv: value.argv,
        started_at: value.started_at,
        stdout_log_path: value.stdout_log_path,
        stderr_log_path: value.stderr_log_path,
    }
    if (value.version === 2) {
        const identity = value.identity as WindowsServiceIdentity
        return { ...fields, version: 2, identity: { kind: "windows", pid: identity.pid, creation_time_ticks: identity.creation_time_ticks } }
    }
    return { ...fields, version: 1, pid: value.pid as number, pgid: value.pgid as number, process_start_time: value.process_start_time as string }
}

function belongsToOwner(state: ServiceState, owner: ManagedScriptProjectOwner, sessionId: string): boolean {
    return state.ownership.job_name === owner.jobName && state.ownership.workspace_path === owner.directory && state.ownership.session_id === sessionId
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
    const paths = createManagedScriptProjectPaths(owner.directory, owner.jobName)
    const candidate = path.resolve(paths.sourceRoot, entry)
    if (!isInside(candidate, paths.sourceRoot)) throw new Error("Managed script entry must stay inside current job source root.")
    let directory: string
    let scriptsRoot: string
    let root: string
    let resolved: string
    try {
        [directory, scriptsRoot, root, resolved] = await Promise.all([fileSystem.realpath(owner.directory), fileSystem.realpath(paths.scriptsRoot), fileSystem.realpath(paths.sourceRoot), fileSystem.realpath(candidate)])
    }
    catch (error) {
        if (isMissingFile(error)) throw new Error("Managed script entry must be an existing regular file.")
        throw error
    }
    if (
        path.relative(path.resolve(directory, ".opencode", "autocode", "scripts"), scriptsRoot) !== ""
        || path.relative(path.resolve(scriptsRoot, path.basename(paths.sourceRoot)), root) !== ""
        || !isInside(resolved, root)
    ) throw new ManagedScriptRuntimeError("invalid_entry", "Managed script entry must remain confined to the current job source root under the real project directory; managed root and job-source symlink aliases are not allowed.")
    if (!(await fileSystem.lstat(resolved)).isFile()) throw new Error("Managed script entry must be an existing regular file.")
    return resolved
}

function createEnvironment(runtimeProcess: ManagedScriptRuntimeProcess, owner: ManagedScriptProjectOwner): NodeJS.ProcessEnv {
    const paths = createManagedScriptProjectPaths(owner.directory, owner.jobName)
    const environment = { ...runtimeProcess.env }
    for (const key of Object.keys(environment)) {
        if (key.toUpperCase() === "NODE_OPTIONS" || key.toUpperCase() === "NODE_PATH") delete environment[key]
    }
    environment.AUTOCODE_SCRIPT_ROOT = paths.scriptsRoot
    environment.AUTOCODE_WORKSPACE_ROOT = owner.directory
    return environment
}

function serviceLogs(owner: ManagedScriptProjectOwner, runId: string): { stdout: string, stderr: string } {
    const paths = createManagedScriptProjectPaths(owner.directory, owner.jobName)
    return { stdout: path.join(paths.logsRoot, `service-${runId}.stdout.log`), stderr: path.join(paths.logsRoot, `service-${runId}.stderr.log`) }
}

export function createManagedScriptRuntime(dependencies: ManagedScriptRuntimeDependencies): ManagedScriptRuntime {
    const fileSystem = dependencies.fileSystem ?? defaultFileSystem
    const runtimeProcess = dependencies.process ?? defaultProcess
    const now = dependencies.now ?? Date.now
    const random = dependencies.randomBytes ?? randomBytes
    const sleep = dependencies.sleep ?? defaultSleep
    const windows = createManagedScriptWindows(runtimeProcess, fileSystem.open)
    const resolveOwner = dependencies.resolveOwner ?? (async (): Promise<ManagedScriptProjectOwnerResolution> => await resolveManagedScriptProjectOwner({ context: dependencies.context, client: dependencies.client, fileSystem }))
    const project = dependencies.project ?? createManagedScriptProject({ context: dependencies.context, client: dependencies.client, fileSystem, ...(dependencies.projectSpawn ? { spawn: dependencies.projectSpawn } : {}), runtime: { env: runtimeProcess.env }, resolveOwner })

    const requireOwner = async (): Promise<ManagedScriptProjectOwner> => {
        let resolution: ManagedScriptProjectOwnerResolution
        try {
            resolution = await resolveOwner()
        }
        catch (error) {
            throw new Error(`Unable to resolve current managed script job: ${flattenError(error)}`)
        }
        if (!resolution.ok) throw new Error(resolution.reason)
        const owner = { jobName: resolution.owner.jobName, directory: resolution.owner.directory }
        if (owner.directory !== dependencies.context.directory) throw new Error("Managed script owner directory must equal context.directory.")
        return owner
    }

    const verifyProject = async (): Promise<void> => {
        const result = await project.verify()
        if (!result.ok) throw new ManagedScriptRuntimeError("project_not_ready", `Managed script project is not ready: ${result.blocker?.message || result.error?.message || "Project readiness verification failed."} Call autocode_script_project to prepare the project and autocode_script_install for explicit dependency install or repair.`)
    }

    const readOwnedState = async (owner: ManagedScriptProjectOwner, runId: string): Promise<{ state: ServiceState, filePath: string }> => {
        validateRunId(runId)
        const filePath = statePath(owner, runId)
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
            // Remove only the proc terminator; empty fields are real argv elements.
            return parsed ? { ...parsed, command: cmdline === "" ? [] : (cmdline.endsWith("\0") ? cmdline.slice(0, -1) : cmdline).split("\0") } : undefined
        }
        catch (error) {
            if (isMissingFile(error)) return undefined
            throw new Error(`Unable to inspect managed script process: ${flattenError(error)}`)
        }
    }

    const requireServicePlatform = (): void => {
        if (runtimeProcess.platform !== "linux") throw new Error("Managed script services are supported only on Linux.")
    }

    const prepareServiceLog = async (filePath: string): Promise<number> => {
        await fileSystem.appendFile(filePath, "")
        const size = (await fileSystem.stat(filePath)).size
        if (size === undefined || !Number.isSafeInteger(size) || size < 0) throw new Error("Unable to inspect managed script log size.")
        if (size > logOutputCapBytes) await (fileSystem.truncate ?? truncate)(filePath, logOutputCapBytes)
        return Math.min(size, logOutputCapBytes)
    }

    const requireStatePlatform = (state: ServiceState): void => {
        if ((state.version === 1 && runtimeProcess.platform !== "linux") || (state.version === 2 && runtimeProcess.platform !== "win32")) throw new Error("Managed script service state belongs to a different operating system; refusing process management.")
    }

    const validateProcess = async (state: LinuxServiceState): Promise<boolean> => {
        const processIdentity = await readProcess(state.pid)
        if (!processIdentity || processIdentity.state === "Z") return false
        if (processIdentity.startTime !== state.process_start_time || processIdentity.processGroup !== state.pgid) throw new Error("Managed script service process identity changed; refusing to signal it.")
        if (processIdentity.command[0] !== state.command || processIdentity.command[1] !== state.entry || JSON.stringify(processIdentity.command.slice(2)) !== JSON.stringify(state.argv)) throw new Error("Managed script service command does not match owned state; refusing to signal it.")
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

    const stopState = async (state: ServiceState, filePath: string): Promise<WindowsServiceCleanup | undefined> => {
        requireStatePlatform(state)
        if (state.version === 2) {
            let result: WindowsServiceCleanup
            try { result = await windows.stop(state.identity) }
            catch (error) {
                if (error instanceof ManagedScriptWindowsError && error.code === "windows_root_missing") await fileSystem.rm(filePath, { force: true })
                throw error
            }
            await fileSystem.rm(filePath, { force: true })
            return result
        }
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
        validateEntry(input.entry)
        const argv = input.argv ?? []
        validateArgv(argv)
        const timeoutMs = validateTimeout(input.timeoutMs)
        const owner = await requireOwner()
        await verifyProject()
        const entry = await resolveEntry(fileSystem, owner, input.entry)
        const paths = createManagedScriptProjectPaths(owner.directory, owner.jobName)
        const logPath = path.join(paths.logsRoot, `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${random(8).toString("hex")}.log`)
        await fileSystem.mkdir(paths.logsRoot, { recursive: true })
        await fileSystem.writeFile(logPath, "stdout/stderr (interleaved):\n")
        const appendLog = (content: Buffer): Promise<void> => fileSystem.appendFile(logPath, content)
        const stdoutLog = createCappedLogAppender(appendLog)
        const stderrLog = createCappedLogAppender(appendLog)
        const stdout = createOutputCollector()
        const stderr = createOutputCollector()
        const started = now()
        const execution = await new Promise<{ exitCode: number | null, timedOut: boolean }>((resolve: (result: { exitCode: number | null, timedOut: boolean }) => void): void => {
            let timedOut = false
            let settled = false
            let rootExited = false
            let rootIdentity: ProcessIdentity | undefined
            let terminationGeneration = 0
            let timeout: ReturnType<typeof setTimeout> | undefined
            let forceKill: ReturnType<typeof setTimeout> | undefined
            let forceSignalTimeout: ReturnType<typeof setTimeout> | undefined
            const capture = (collector: typeof stdout, log: typeof stdoutLog, chunk: Buffer): void => {
                if (settled) return
                collector.append(chunk)
                log.append(chunk)
            }
            const captureError = (error: unknown): void => {
                if (!settled) capture(stderr, stderrLog, Buffer.from(boundedErrorMessage(error)))
            }
            const finish = (exitCode: number | null): void => {
                if (settled) return
                settled = true
                terminationGeneration += 1
                if (timeout) clearTimeout(timeout)
                if (forceKill) clearTimeout(forceKill)
                if (forceSignalTimeout) clearTimeout(forceSignalTimeout)
                resolve({ exitCode: timedOut ? null : exitCode, timedOut })
            }
            let child: ManagedScriptRuntimeChild
            try {
                child = runtimeProcess.spawn(runtimeProcess.execPath, [entry, ...argv], { cwd: paths.scriptsRoot, env: createEnvironment(runtimeProcess, owner), detached: true, shell: false, stdio: "pipe" })
            }
            catch (error) {
                captureError(error)
                finish(null)
                return
            }
            const destroyOutput = (): void => {
                for (const stream of [child.stdout, child.stderr]) {
                    try { void Promise.resolve(stream?.destroy?.()).catch(captureError) }
                    catch (error) { captureError(error) }
                }
            }
            const signalChild = (signal: NodeJS.Signals): void => {
                if (settled || rootExited || runtimeProcess.platform === "linux") return
                try {
                    if (!child.kill) { captureError("Managed script process handle does not support termination."); return }
                    if (!child.kill(signal)) captureError("Managed script owned process handle declined termination.")
                }
                catch (error) { captureError(error) }
            }
            const terminate = async (signal: NodeJS.Signals, generation: number): Promise<void> => {
                if (settled || generation !== terminationGeneration) return
                if (rootExited) { captureError("Managed script root has exited; descendant cleanup was not attempted."); return }
                if (runtimeProcess.platform !== "linux") { signalChild(signal); return }
                const ownedIdentity = rootIdentity
                const pid = child.pid
                if (!ownedIdentity || !pid) { captureError("Managed script Linux cleanup declined: root ownership could not be verified."); return }
                try {
                    const identity = await readProcess(pid)
                    if (settled || rootExited || generation !== terminationGeneration) return
                    if (!identity || identity.state === "Z" || identity.startTime !== ownedIdentity.startTime || identity.processGroup !== ownedIdentity.processGroup || identity.processGroup !== pid) {
                        captureError("Managed script Linux cleanup declined: root identity no longer matches launched process.")
                        return
                    }
                    if (settled || rootExited || generation !== terminationGeneration) return
                    if (!signalGroup(identity.processGroup, signal)) captureError("Managed script process group no longer exists; cleanup was not attempted.")
                }
                catch (error) {
                    if (!settled && !rootExited && generation === terminationGeneration) captureError(`Managed script Linux cleanup declined: ${boundedErrorMessage(error)}`)
                }
            }
            child.stdout?.on("data", (chunk: Buffer): void => { capture(stdout, stdoutLog, chunk) })
            child.stderr?.on("data", (chunk: Buffer): void => { capture(stderr, stderrLog, chunk) })
            child.on("exit", (): void => { rootExited = true; terminationGeneration += 1 })
            child.on("error", (error: Error): void => {
                if (settled) return
                captureError(error.message)
                if (!timedOut) { destroyOutput(); finish(null) }
            })
            child.on("close", (exitCode: number | null, signal: NodeJS.Signals | null): void => {
                rootExited = true
                finish(signal ? null : exitCode)
            })
            if (!child.pid || child.pid < 1) {
                captureError("Managed script process did not provide a PID.")
                destroyOutput()
                finish(null)
                return
            }
            if (runtimeProcess.platform === "linux") {
                void readProcess(child.pid).then((identity: ProcessIdentity | undefined): void => {
                    if (settled || rootExited) return
                    if (identity && identity.state !== "Z" && identity.processGroup === child.pid) rootIdentity = identity
                }).catch(captureError)
            }
            timeout = setTimeout((): void => {
                if (settled) return
                timedOut = true
                // Reserve identity-check time inside the existing termination grace period.
                forceKill = setTimeout((): void => {
                    if (settled) return
                    const generation = ++terminationGeneration
                    const complete = (): void => {
                        if (settled) return
                        terminationGeneration += 1
                        if (forceSignalTimeout) clearTimeout(forceSignalTimeout)
                        destroyOutput()
                        finish(null)
                    }
                    forceSignalTimeout = setTimeout((): void => {
                        captureError(`Managed script forced cleanup did not finish within ${forcedSignalWaitMs} milliseconds; late signals were cancelled.`)
                        complete()
                    }, forcedSignalWaitMs)
                    void terminate("SIGKILL", generation).then(complete, (error: unknown): void => { captureError(error); complete() })
                }, terminateGraceMs - forcedSignalWaitMs)
                void terminate("SIGTERM", ++terminationGeneration).catch(captureError)
            }, timeoutMs)
        })
        const stdoutResult = stdout.result()
        const durationMs = Math.max(0, now() - started)
        let flushCancelled = false
        const pendingLogs = (async (): Promise<string | undefined> => {
            const failures = await Promise.all([stdoutLog.flush(), stderrLog.flush()])
            if (flushCancelled) return undefined
            const failure = failures.filter((value: string | undefined): boolean => value !== undefined).join("\n")
            if (failure) return failure
            await fileSystem.appendFile(logPath, `\n\n${JSON.stringify({ exit_code: execution.exitCode, duration_ms: durationMs, timed_out: execution.timedOut, stdout_bytes: stdoutResult.bytes, stderr_bytes: stderr.result().bytes }, undefined, 2)}\n`)
            return undefined
        })()
        const flushed = await waitWithin(pendingLogs, logFlushTimeoutMs)
        if (!flushed.completed) {
            flushCancelled = true
            stderr.append(Buffer.from(`Managed script logging did not finish within ${logFlushTimeoutMs} milliseconds; logs may be incomplete.`))
        }
        else if ("error" in flushed) stderr.append(Buffer.from(`Managed script logging failed: ${boundedErrorMessage(flushed.error)}`))
        else if (flushed.value !== undefined) stderr.append(Buffer.from(`Managed script logging failed: ${boundedErrorMessage(flushed.value)}`))
        const stderrResult = stderr.result()
        return { exit_code: execution.exitCode, stdout: stdoutResult.value, stderr: stderrResult.value, duration_ms: durationMs, log_path: logPath, timed_out: execution.timedOut, stdout_truncated: stdoutResult.truncated, stderr_truncated: stderrResult.truncated }
    }

    const start = async (input: Omit<ManagedScriptRunInput, "timeoutMs">): Promise<ManagedScriptServiceStartResult> => {
        requireServicePlatform()
        validateEntry(input.entry)
        const argv = input.argv ?? []
        validateArgv(argv)
        const owner = await requireOwner()
        const launchOwner: ManagedScriptLaunchOwner = Object.freeze({ jobName: owner.jobName, directory: owner.directory, sessionID: dependencies.context.sessionID })
        await verifyProject()
        const entry = await resolveEntry(fileSystem, owner, input.entry)
        const runId = random(24).toString("hex")
        const paths = createManagedScriptProjectPaths(owner.directory, owner.jobName)
        const logs = serviceLogs(owner, runId)
        await fileSystem.mkdir(paths.logsRoot, { recursive: true })
        if (runtimeProcess.platform === "win32") {
            await windows.launch({ entry, argv, cwd: paths.scriptsRoot, env: createEnvironment(runtimeProcess, owner), stdout: logs.stdout, stderr: logs.stderr }, async (identity: WindowsServiceIdentity): Promise<void> => {
                const state: WindowsServiceState = {
                    version: 2,
                    identity,
                    ownership: { job_name: launchOwner.jobName, workspace_path: launchOwner.directory, session_id: launchOwner.sessionID },
                    run_id: runId,
                    command: runtimeProcess.execPath,
                    entry,
                    argv: [...argv],
                    started_at: new Date(now()).toISOString(),
                    stdout_log_path: logs.stdout,
                    stderr_log_path: logs.stderr,
                }
                await writeAtomically(fileSystem, statePath(launchOwner, runId), `${JSON.stringify(state, undefined, 2)}\n`, random)
            })
            return { owner: launchOwner, run_id: runId, stdout_log_path: logs.stdout, stderr_log_path: logs.stderr, message: windowsServiceMessage }
        }
        const [stdoutBytes, stderrBytes] = await Promise.all([prepareServiceLog(logs.stdout), prepareServiceLog(logs.stderr)])
        const stdoutLog = createCappedLogAppender((content: Buffer): Promise<void> => fileSystem.appendFile(logs.stdout, content), stdoutBytes)
        const stderrLog = createCappedLogAppender((content: Buffer): Promise<void> => fileSystem.appendFile(logs.stderr, content), stderrBytes)
        let child: ManagedScriptRuntimeChild
        try {
            child = runtimeProcess.spawn(runtimeProcess.execPath, [entry, ...argv], { cwd: paths.scriptsRoot, env: createEnvironment(runtimeProcess, owner), detached: true, shell: false, stdio: "pipe" })
        }
        catch (error) {
            throw new Error(`Unable to start managed script service: ${flattenError(error)}`)
        }
        if (!child.pid || child.pid < 1) throw new Error("Managed script service did not provide a PID.")
        child.stdout?.on("data", stdoutLog.append)
        child.stderr?.on("data", stderrLog.append)
        const identity = await readProcess(child.pid)
        if (!identity || identity.state === "Z" || identity.processGroup !== child.pid || identity.command[0] !== runtimeProcess.execPath || identity.command[1] !== entry || JSON.stringify(identity.command.slice(2)) !== JSON.stringify(argv)) {
            signalGroup(child.pid, "SIGKILL")
            throw new Error("Managed script service process identity could not be verified.")
        }
        const state: ServiceState = {
            version: 1,
            ownership: { job_name: launchOwner.jobName, workspace_path: launchOwner.directory, session_id: launchOwner.sessionID },
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
            await writeAtomically(fileSystem, statePath(launchOwner, runId), `${JSON.stringify(state, undefined, 2)}\n`, random)
            const flushed = await waitWithin(Promise.all([stdoutLog.flush(), stderrLog.flush()]), logFlushTimeoutMs)
            if (!flushed.completed) throw new Error(`Managed script service logging did not finish within ${logFlushTimeoutMs} milliseconds.`)
            if ("error" in flushed) throw flushed.error
            for (const failure of flushed.value) if (failure !== undefined) throw new Error(`Unable to write managed script log: ${failure}`)
        }
        catch (error) {
            signalGroup(child.pid, "SIGKILL")
            throw new Error(`Unable to persist managed script service state: ${flattenError(error)}`)
        }
        return { owner: launchOwner, run_id: runId, stdout_log_path: logs.stdout, stderr_log_path: logs.stderr }
    }

    const status = async (input: ManagedScriptServiceActionInput): Promise<ManagedScriptServiceStatus> => {
        requireServicePlatform()
        const owner = await requireOwner()
        const { state, filePath } = await readOwnedState(owner, input.run_id)
        requireStatePlatform(state)
        if (!(state.version === 2 ? await windows.inspect(state.identity) : await validateProcess(state))) {
            await fileSystem.rm(filePath, { force: true })
            if (state.version === 2) throw new ManagedScriptWindowsError("windows_root_missing", "Managed script service root has already exited; tree cleanup was not attempted and live descendants may remain.", { termination: "none", tree_cleanup: "not_attempted", descendants: "unknown", root_exited: true })
            throw new Error("Managed script service has already exited.")
        }
        return { run_id: state.run_id, running: true, entry: state.entry, argv: state.argv, started_at: state.started_at, stdout_log_path: state.stdout_log_path, stderr_log_path: state.stderr_log_path, ...(state.version === 2 ? { message: windowsServiceMessage } : {}) }
    }

    const stop = async (input: ManagedScriptServiceActionInput): Promise<ManagedScriptServiceStopResult> => {
        requireServicePlatform()
        const owner = await requireOwner()
        const { state, filePath } = await readOwnedState(owner, input.run_id)
        const windowsCleanup = await stopState(state, filePath)
        return { run_id: state.run_id, stopped: true, ...(windowsCleanup ? { windows_cleanup: windowsCleanup, message: "Root exit confirmed. Forced tree cleanup was best-effort; descendant exit is unknown." } : {}) }
    }

    const cleanup = async (): Promise<ManagedScriptServiceCleanupResult> => {
        requireServicePlatform()
        const owner = await requireOwner()
        let entries: string[]
        try {
            entries = await fileSystem.readdir(serviceDirectory(owner)) as string[]
        }
        catch (error) {
            if (isMissingFile(error)) return { stopped_run_ids: [], finalized_run_ids: [] }
            throw new Error(`Unable to list managed script services: ${flattenError(error)}`)
        }
        const stoppedRunIds: string[] = []
        const finalizedRunIds: string[] = []
        const windowsCleanup: ({ run_id: string } & WindowsServiceCleanup)[] = []
        for (const entry of entries) {
            const runId = entry.endsWith(".json") ? entry.slice(0, -5) : ""
            if (!/^[a-f0-9]{48}$/.test(runId)) continue
            let state: ServiceState | undefined
            const filePath = statePath(owner, runId)
            try {
                state = parseState(JSON.parse(await fileSystem.readFile(filePath, "utf8")) as unknown)
            }
            catch {
                continue
            }
            if (!state || (state.version === 2 && state.run_id !== runId) || !belongsToOwner(state, owner, dependencies.context.sessionID)) continue
            requireStatePlatform(state)
            if (state.version === 2) {
                try {
                    const result = await stopState(state, filePath)
                    if (result) windowsCleanup.push({ run_id: runId, ...result })
                    stoppedRunIds.push(runId)
                }
                catch (error) {
                    if (!(error instanceof ManagedScriptWindowsError) || (error.code !== "windows_root_missing" && error.code !== "windows_identity_mismatch")) throw error
                    await fileSystem.rm(filePath, { force: true })
                    finalizedRunIds.push(runId)
                    if (error.windows_cleanup) windowsCleanup.push({ run_id: runId, ...error.windows_cleanup })
                }
                continue
            }
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
        return { stopped_run_ids: stoppedRunIds, finalized_run_ids: finalizedRunIds, ...(runtimeProcess.platform === "win32" ? { windows_cleanup: windowsCleanup } : {}) }
    }

    return { run, start, status, stop, cleanup }
}

export async function cleanupManagedScriptServices(runtime: Pick<ManagedScriptRuntime, "cleanup">): Promise<ManagedScriptServiceCleanupResult> {
    const result = await runtime.cleanup()
    const unconfirmed = result.windows_cleanup?.filter((cleanup): boolean => cleanup.tree_cleanup === "not_attempted")
    // Lifecycle callers discard results, so finalized Windows roots must surface descendant uncertainty as a failure.
    if (unconfirmed?.length) throw new ManagedScriptWindowsError("windows_cleanup_incomplete", `Windows service records finalized without tree cleanup: ${unconfirmed.map((cleanup): string => cleanup.run_id).join(", ")}. Live descendants may remain.`, { termination: "none", tree_cleanup: "not_attempted", descendants: "unknown" })
    return result
}
