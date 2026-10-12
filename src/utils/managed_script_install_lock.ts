import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { hostname } from "node:os"
import path from "node:path"
import { isMissingFile, normalizeReaddirEntries, type JobToolFileSystem } from "./jobs"
import { resolveWindowsServiceExecutables } from "./managed_script_windows"

// Installer-only mutual exclusion requires coherent atomic directory rename that cannot replace a nonempty destination.
// Published generations and their container stay forever; mixed old/new running helper protocols are not supported.

export type InstallerLockFileSystem = Pick<JobToolFileSystem, "mkdir" | "readFile" | "readdir" | "rename" | "rm" | "stat" | "writeFile">

export type InstallerLockProcessIdentity =
    | { kind: "linux", bootId: string, startTimeTicks: string }
    | { kind: "windows", creationTimeTicks: string }

export type InstallerLockProcessProbe =
    | { state: "alive", identity: InstallerLockProcessIdentity }
    | { state: "dead" }
    | { state: "unknown" }

export type InstallerLockOwner = {
    pid: number
    host: string
    token: string
    startedAt: number
    heartbeatAt: number
    processIdentity?: InstallerLockProcessIdentity
}

export type InstallerLockRuntime = {
    now: () => number
    pid: number
    host: string
    isProcessAlive: (pid: number) => boolean
    readProcessIdentity?: (pid: number) => InstallerLockProcessProbe | Promise<InstallerLockProcessProbe>
    sleep: (milliseconds: number) => Promise<void>
    createToken: () => string
    startHeartbeat: (refresh: () => Promise<void>, intervalMs: number) => () => void
}

export type InstallerLockOptions = {
    heartbeatIntervalMs: number
    staleAfterMs: number
    waitTimeoutMs: number
    pollIntervalMs: number
    invalidOwnerGraceMs: number
}

export type InstallerLockConfig = Partial<InstallerLockRuntime & InstallerLockOptions>

// Age thresholds remain compatibility options; only proven same-host death or birth-identity mismatch authorizes takeover.
export const defaultInstallerLockOptions: InstallerLockOptions = {
    heartbeatIntervalMs: 5_000,
    staleAfterMs: 30_000,
    waitTimeoutMs: 120_000,
    pollIntervalMs: 250,
    invalidOwnerGraceMs: 5_000,
}

export type InstallerLockState =
    | { state: "free" }
    | { state: "active", owner?: InstallerLockOwner }
    | { state: "stale", reason: "dead_owner" | "heartbeat_expired" | "invalid_owner", owner?: InstallerLockOwner }

export type InstallerLockHandle = {
    token: string
    release: () => Promise<void>
}

export type InstallerLockTimeout = {
    ok: false
    reason: "timeout"
    message: string
    waitedMs: number
    owner?: InstallerLockOwner
}

export type InstallerLockAcquireResult = { ok: true, lock: InstallerLockHandle } | InstallerLockTimeout

type ResolvedInstallerLockConfig = InstallerLockRuntime & InstallerLockOptions & {
    readProcessIdentity: NonNullable<InstallerLockRuntime["readProcessIdentity"]>
}

const ownerFileName = "owner.json"
const heartbeatFileName = "heartbeat.json"
const releasedFileName = "released.json"
const legacyInstallerLockProtocol = 2
const installerLockProtocol = 3
const generationPrefix = "generation-"
const generationDigits = 16
const generationPattern = new RegExp(`^${generationPrefix}(\\d{${generationDigits}})$`)
const generationOverflowMessage = "Installer lock generation exceeds the safe integer range"
const canonicalDecimalPattern = /^(0|[1-9][0-9]*)$/
const bootIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const linuxBootIdPath = "/proc/sys/kernel/random/boot_id"
const linuxSelfStatPath = "/proc/self/stat"
const windowsIdentityTimeoutMs = 5_000
const windowsIdentityOutputCapBytes = 16_384
const windowsMaxPid = 2_147_483_647

// This fixed read-only query retains the process handle across birth capture; only numeric PID JSON reaches stdin.
const windowsIdentityCode = `
$ErrorActionPreference = 'Stop'
$target = $null
$result = @{ state = 'unknown' }
try {
    $control = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if (($control.pid -isnot [int] -and $control.pid -isnot [long]) -or $control.pid -le 0 -or $control.pid -gt [int]::MaxValue) { throw 'Invalid PID' }
    try { $target = [System.Diagnostics.Process]::GetProcessById([int]$control.pid) }
    catch [System.ArgumentException] { $result = @{ state = 'dead' } }
    if ($null -ne $target) {
        $handle = $target.Handle
        if ($target.HasExited) { $result = @{ state = 'dead' } }
        else {
            $ticks = $target.StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture)
            if ($target.HasExited) { $result = @{ state = 'dead' } }
            else { $result = @{ state = 'alive'; identity = @{ kind = 'windows'; creationTimeTicks = $ticks } } }
        }
    }
}
catch { $result = @{ state = 'unknown' } }
finally {
    if ($null -ne $target) { try { $target.Dispose() } catch {} }
}
[Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 3 -Compress))
`

let cachedLinuxBootId: string | undefined
let cachedSelfProcessIdentity: InstallerLockProcessIdentity | undefined
let pendingSelfProcessIdentity: Promise<InstallerLockProcessProbe> | undefined

type InstallerLockClaim = {
    protocol: typeof legacyInstallerLockProtocol | typeof installerLockProtocol
    claimId: string
    token: string
}

type PublishedInstallerLockOwner = InstallerLockOwner & InstallerLockClaim

type InstallerLockCandidate = {
    path: string
    owner: PublishedInstallerLockOwner & {
        protocol: typeof installerLockProtocol
        processIdentity: InstallerLockProcessIdentity
    }
}

type InstallerLockInspection = {
    generation: number
    state: InstallerLockState
}

type InstallerLockInspectionFileSystem = Pick<InstallerLockFileSystem, "readFile" | "readdir" | "stat">

function isProcessAliveDefault(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return true
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return errorCode(error) !== "ESRCH"
    }
}

function isProcessIdentity(value: unknown): value is InstallerLockProcessIdentity {
    if (typeof value !== "object" || value === null) return false
    const identity = value as Record<string, unknown>
    if (identity.kind === "linux") {
        return typeof identity.bootId === "string" && bootIdPattern.test(identity.bootId)
            && typeof identity.startTimeTicks === "string" && canonicalDecimalPattern.test(identity.startTimeTicks)
    }
    return identity.kind === "windows"
        && typeof identity.creationTimeTicks === "string" && canonicalDecimalPattern.test(identity.creationTimeTicks)
}

function isProcessProbe(value: unknown): value is InstallerLockProcessProbe {
    if (typeof value !== "object" || value === null) return false
    const probe = value as Record<string, unknown>
    return probe.state === "dead" || probe.state === "unknown"
        || (probe.state === "alive" && isProcessIdentity(probe.identity))
}

function copyProcessIdentity(identity: InstallerLockProcessIdentity): InstallerLockProcessIdentity {
    return identity.kind === "linux"
        ? { kind: "linux", bootId: identity.bootId, startTimeTicks: identity.startTimeTicks }
        : { kind: "windows", creationTimeTicks: identity.creationTimeTicks }
}

function matchesProcessIdentity(stored: InstallerLockProcessIdentity, current: InstallerLockProcessIdentity): boolean {
    return stored.kind === "linux"
        ? current.kind === "linux" && stored.bootId === current.bootId && stored.startTimeTicks === current.startTimeTicks
        : current.kind === "windows" && stored.creationTimeTicks === current.creationTimeTicks
}

function parseLinuxProcessStat(contents: string, pid: number, bootId: string): InstallerLockProcessProbe {
    const prefix = `${pid} (`
    const end = contents.lastIndexOf(")")
    if (!contents.startsWith(prefix) || end < prefix.length || contents[end + 1] !== " ") return { state: "unknown" }
    const fields = contents.slice(end + 2).trim().split(/\s+/)
    const state = fields[0]
    const startTimeTicks = fields[19]
    if (fields.length < 20 || startTimeTicks === undefined || !canonicalDecimalPattern.test(startTimeTicks)) return { state: "unknown" }
    if (state === "Z" || state === "X" || state === "x") return { state: "dead" }
    if (state === undefined || !/^[RSDTtWIKP]$/.test(state)) return { state: "unknown" }
    return { state: "alive", identity: { kind: "linux", bootId, startTimeTicks } }
}

async function readLinuxProcessIdentity(pid: number): Promise<InstallerLockProcessProbe> {
    if (cachedLinuxBootId === undefined) {
        const bootId = (await readFile(linuxBootIdPath, "utf8")).trim().toLowerCase()
        if (!bootIdPattern.test(bootId)) return { state: "unknown" }
        cachedLinuxBootId = bootId
    }
    const bootId = cachedLinuxBootId
    try {
        return parseLinuxProcessStat(await readFile(`/proc/${pid}/stat`, "utf8"), pid, bootId)
    } catch (error) {
        if (isMissingFile(error) || errorCode(error) === "ESRCH") {
            const evidence = parseLinuxProcessStat(await readFile(linuxSelfStatPath, "utf8"), process.pid, bootId)
            // Hidden or unavailable /proc entries are ambiguous while the PID still appears live.
            if (evidence.state === "alive" && !isProcessAliveDefault(pid)) return { state: "dead" }
        }
        return { state: "unknown" }
    }
}

async function readWindowsProcessIdentity(pid: number): Promise<InstallerLockProcessProbe> {
    if (pid > windowsMaxPid) return { state: "unknown" }
    const { powershell } = resolveWindowsServiceExecutables(process.env)
    return new Promise<InstallerLockProcessProbe>((resolve): void => {
        try {
            const child = execFile(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsIdentityCode, "utf16le").toString("base64")], {
                shell: false,
                windowsHide: true,
                timeout: windowsIdentityTimeoutMs,
                maxBuffer: windowsIdentityOutputCapBytes,
                encoding: "utf8",
            }, (error: Error | null, stdout: string): void => {
                if (error !== null) {
                    resolve({ state: "unknown" })
                    return
                }
                try {
                    const probe: unknown = JSON.parse(stdout.trim())
                    if (!isProcessProbe(probe) || (probe.state === "alive" && probe.identity.kind !== "windows")) {
                        resolve({ state: "unknown" })
                        return
                    }
                    resolve(probe)
                } catch {
                    resolve({ state: "unknown" })
                }
            })
            child.stdin?.on("error", (): void => { resolve({ state: "unknown" }) })
            child.stdin?.end(JSON.stringify({ pid }))
        } catch {
            resolve({ state: "unknown" })
        }
    })
}

async function readNativeProcessIdentity(pid: number): Promise<InstallerLockProcessProbe> {
    try {
        if (!isProcessAliveDefault(pid)) return { state: "dead" }
        return process.platform === "linux" ? await readLinuxProcessIdentity(pid) : await readWindowsProcessIdentity(pid)
    } catch {
        return { state: "unknown" }
    }
}

/** Reads process birth identity only; the Windows timeout terminates only this helper's read-only query child. */
export async function readInstallerProcessIdentity(pid: number): Promise<InstallerLockProcessProbe> {
    if (!Number.isSafeInteger(pid) || pid <= 0 || (process.platform !== "linux" && process.platform !== "win32")) return { state: "unknown" }
    if (pid !== process.pid) return readNativeProcessIdentity(pid)
    if (cachedSelfProcessIdentity !== undefined) return { state: "alive", identity: copyProcessIdentity(cachedSelfProcessIdentity) }
    pendingSelfProcessIdentity ??= readNativeProcessIdentity(pid).then((probe: InstallerLockProcessProbe): InstallerLockProcessProbe => {
        if (probe.state === "alive") cachedSelfProcessIdentity = copyProcessIdentity(probe.identity)
        return probe
    }).finally((): void => {
        pendingSelfProcessIdentity = undefined
    })
    const probe = await pendingSelfProcessIdentity
    return probe.state === "alive" ? { state: "alive", identity: copyProcessIdentity(probe.identity) } : probe
}

async function readConfiguredProcessIdentity(config: ResolvedInstallerLockConfig, pid: number): Promise<InstallerLockProcessProbe> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unknown" }
    try {
        const probe: unknown = await config.readProcessIdentity(pid)
        if (!isProcessProbe(probe)) return { state: "unknown" }
        return probe.state === "alive" ? { state: "alive", identity: copyProcessIdentity(probe.identity) } : { state: probe.state }
    } catch {
        return { state: "unknown" }
    }
}

function startHeartbeatDefault(refresh: () => Promise<void>, intervalMs: number): () => void {
    const timer = setInterval((): void => {
        void refresh().catch((): void => undefined)
    }, intervalMs)
    timer.unref?.()
    return (): void => clearInterval(timer)
}

function createDefaultRuntime(): InstallerLockRuntime {
    return {
        now: Date.now,
        pid: process.pid,
        host: hostname(),
        isProcessAlive: isProcessAliveDefault,
        sleep: (milliseconds: number): Promise<void> => new Promise<void>((resolve): void => {
            setTimeout(resolve, milliseconds)
        }),
        createToken: randomUUID,
        startHeartbeat: startHeartbeatDefault,
    }
}

// Undefined values are dropped so partial test doubles never erase defaults.
function resolveConfig(config: InstallerLockConfig = {}): ResolvedInstallerLockConfig {
    const defined = Object.fromEntries(Object.entries(config).filter(([, value]): boolean => value !== undefined)) as InstallerLockConfig
    return { ...createDefaultRuntime(), ...defaultInstallerLockOptions, ...defined, readProcessIdentity: defined.readProcessIdentity ?? readInstallerProcessIdentity }
}

function errorCode(error: unknown): unknown {
    return typeof error === "object" && error !== null && "code" in error ? error.code : undefined
}

function assertLockPath(lockPath: string): void {
    if (lockPath.trim().length === 0) throw new Error("Installer lock path must not be empty")
}

function ownerFilePath(lockPath: string): string {
    return path.join(lockPath, ownerFileName)
}

function isOwner(value: unknown): value is InstallerLockOwner {
    if (typeof value !== "object" || value === null) return false
    const record = value as Record<string, unknown>
    return typeof record.pid === "number"
        && Number.isSafeInteger(record.pid)
        && record.pid > 0
        && typeof record.host === "string"
        && typeof record.token === "string"
        && typeof record.startedAt === "number"
        && Number.isFinite(new Date(record.startedAt).getTime())
        && typeof record.heartbeatAt === "number"
        && Number.isFinite(record.heartbeatAt)
        && (record.processIdentity === undefined || isProcessIdentity(record.processIdentity))
}

function isPublishedOwner(value: unknown): value is PublishedInstallerLockOwner {
    return isOwner(value)
        && "protocol" in value && (value.protocol === legacyInstallerLockProtocol || value.protocol === installerLockProtocol)
        && "claimId" in value && typeof value.claimId === "string" && value.claimId.length > 0
        && (value.protocol === legacyInstallerLockProtocol || isProcessIdentity(value.processIdentity))
}

function matchesClaim(value: unknown, owner: PublishedInstallerLockOwner): value is InstallerLockClaim {
    if (typeof value !== "object" || value === null) return false
    const record = value as Record<string, unknown>
    return record.protocol === owner.protocol && record.claimId === owner.claimId && record.token === owner.token
}

async function readJson(
    fileSystem: Pick<InstallerLockFileSystem, "readFile">,
    filePath: string,
): Promise<{ missing: boolean, value?: unknown }> {
    try {
        const value: unknown = JSON.parse(await fileSystem.readFile(filePath, "utf8"))
        return { missing: false, value }
    } catch (error) {
        return { missing: isMissingFile(error) }
    }
}

function generationPath(lockPath: string, generation: number): string {
    return path.join(lockPath, `${generationPrefix}${String(generation).padStart(generationDigits, "0")}`)
}

async function classifyValidOwner(owner: InstallerLockOwner, config: ResolvedInstallerLockConfig): Promise<InstallerLockState> {
    if (owner.host !== config.host) return { state: "active", owner }
    const probe = await readConfiguredProcessIdentity(config, owner.pid)
    if (probe.state === "dead"
        || (probe.state === "alive" && owner.processIdentity !== undefined && !matchesProcessIdentity(owner.processIdentity, probe.identity))) {
        return { state: "stale", reason: "dead_owner", owner }
    }
    return { state: "active", owner }
}

async function readLatestGeneration(
    fileSystem: Pick<InstallerLockFileSystem, "readdir">,
    lockPath: string,
): Promise<number | undefined> {
    let names: string[]
    try {
        names = normalizeReaddirEntries(await fileSystem.readdir(lockPath, { withFileTypes: true }))
    } catch (error) {
        if (isMissingFile(error)) return undefined
        throw error
    }
    let latest = 0
    for (const name of names) {
        const match = generationPattern.exec(name)
        if (match === null) continue
        const generation = Number(match[1])
        if (!Number.isSafeInteger(generation)) throw new Error(generationOverflowMessage)
        if (generation > latest) latest = generation
    }
    return latest
}

async function inspectCurrentLock(
    fileSystem: InstallerLockInspectionFileSystem,
    lockPath: string,
    config: ResolvedInstallerLockConfig,
): Promise<InstallerLockInspection> {
    const generation = await readLatestGeneration(fileSystem, lockPath)
    if (generation === undefined) return { generation: 0, state: { state: "free" } }
    if (generation === 0) {
        const legacy = await readJson(fileSystem, ownerFilePath(lockPath))
        const state: InstallerLockState = legacy.missing ? { state: "free" }
            : isOwner(legacy.value) ? await classifyValidOwner(legacy.value, config) : { state: "active" }
        return { generation, state }
    }
    const publishedPath = generationPath(lockPath, generation)
    const { value: owner } = await readJson(fileSystem, ownerFilePath(publishedPath))
    if (!isPublishedOwner(owner)) return { generation, state: { state: "active" } }
    const released = await readJson(fileSystem, path.join(publishedPath, releasedFileName))
    if (matchesClaim(released.value, owner)) return { generation, state: { state: "free" } }
    const heartbeat = (await readJson(fileSystem, path.join(publishedPath, heartbeatFileName))).value
    const reportedOwner = matchesClaim(heartbeat, owner)
        && "heartbeatAt" in heartbeat && typeof heartbeat.heartbeatAt === "number" && Number.isFinite(heartbeat.heartbeatAt)
        ? { ...owner, heartbeatAt: heartbeat.heartbeatAt } : owner
    return { generation, state: await classifyValidOwner(reportedOwner, config) }
}

/** Read-only lock inspection; never waits and never mutates. */
export async function inspectInstallerLock(
    fileSystem: InstallerLockInspectionFileSystem,
    lockPath: string,
    config?: InstallerLockConfig,
): Promise<InstallerLockState> {
    assertLockPath(lockPath)
    return (await inspectCurrentLock(fileSystem, lockPath, resolveConfig(config))).state
}

async function cleanupPrivatePath(
    fileSystem: Pick<InstallerLockFileSystem, "rm">,
    privatePath: string,
    recursive: boolean = false,
): Promise<void> {
    try {
        await fileSystem.rm(privatePath, { recursive, force: true })
    } catch {
        // Cleanup failures leave only ignored private debris.
    }
}

async function publishClaimFile(
    fileSystem: InstallerLockFileSystem,
    publishedPath: string,
    fileName: string,
    value: InstallerLockClaim & { heartbeatAt?: number },
): Promise<void> {
    const temporaryPath = path.join(publishedPath, `${fileName}.${randomUUID()}.tmp`)
    try {
        await fileSystem.writeFile(temporaryPath, JSON.stringify(value))
        await fileSystem.rename(temporaryPath, path.join(publishedPath, fileName))
    } finally {
        await cleanupPrivatePath(fileSystem, temporaryPath)
    }
}

async function refreshHeartbeat(
    fileSystem: InstallerLockFileSystem,
    publishedPath: string,
    owner: PublishedInstallerLockOwner,
    config: ResolvedInstallerLockConfig,
): Promise<void> {
    try {
        await publishClaimFile(fileSystem, publishedPath, heartbeatFileName, {
            protocol: owner.protocol,
            claimId: owner.claimId,
            token: owner.token,
            heartbeatAt: config.now(),
        })
    } catch {
        // Heartbeats are advisory; a failed refresh never permits takeover.
    }
}

async function publishRelease(
    fileSystem: InstallerLockFileSystem,
    publishedPath: string,
    owner: PublishedInstallerLockOwner,
): Promise<boolean> {
    const releasedPath = path.join(publishedPath, releasedFileName)
    if (matchesClaim((await readJson(fileSystem, releasedPath)).value, owner)) return true
    try {
        await publishClaimFile(fileSystem, publishedPath, releasedFileName, {
            protocol: owner.protocol,
            claimId: owner.claimId,
            token: owner.token,
        })
        return true
    } catch (error) {
        if (matchesClaim((await readJson(fileSystem, releasedPath)).value, owner)) return true
        throw error
    }
}

async function createHandle(
    fileSystem: InstallerLockFileSystem,
    publishedPath: string,
    owner: PublishedInstallerLockOwner,
    config: ResolvedInstallerLockConfig,
): Promise<InstallerLockHandle> {
    let stopped = false
    let released = false
    let refreshing: Promise<void> | undefined
    let releasing: Promise<void> | undefined
    let stopHeartbeat: (() => void) | undefined
    const refresh = (): Promise<void> => {
        if (stopped) return Promise.resolve()
        refreshing ??= refreshHeartbeat(fileSystem, publishedPath, owner, config).finally((): void => {
            refreshing = undefined
        })
        return refreshing
    }
    const release = (): Promise<void> => {
        if (releasing !== undefined) return releasing
        if (released) return Promise.resolve()
        stopped = true
        releasing = Promise.resolve().then(async (): Promise<void> => {
            const stop = stopHeartbeat
            stopHeartbeat = undefined
            try {
                stop?.()
            } catch {
                // The stopped flag also prevents writes if an injected timer cannot be stopped.
            }
            await refreshing
            released = await publishRelease(fileSystem, publishedPath, owner)
        }).finally((): void => {
            releasing = undefined
        })
        return releasing
    }
    try {
        stopHeartbeat = config.startHeartbeat(refresh, config.heartbeatIntervalMs)
    } catch (error) {
        // Preserve the setup failure if releasing this generation also fails.
        await release().catch((): void => undefined)
        throw error
    }
    return { token: owner.token, release }
}

async function prepareCandidate(
    fileSystem: InstallerLockFileSystem,
    lockPath: string,
    config: ResolvedInstallerLockConfig,
): Promise<InstallerLockCandidate> {
    const startedAt = config.now()
    const probe = await readConfiguredProcessIdentity(config, config.pid)
    if (probe.state !== "alive") throw new Error(`Unable to read reliable managed script installer process identity for pid ${config.pid}`)
    const claimId = randomUUID()
    const candidatePath = path.join(lockPath, `.candidate-${claimId}`)
    await fileSystem.mkdir(candidatePath)
    try {
        const owner: InstallerLockCandidate["owner"] = {
            pid: config.pid,
            host: config.host,
            token: config.createToken(),
            startedAt,
            heartbeatAt: startedAt,
            protocol: installerLockProtocol,
            claimId,
            processIdentity: probe.identity,
        }
        await fileSystem.writeFile(ownerFilePath(candidatePath), JSON.stringify(owner))
        return { path: candidatePath, owner }
    } catch (error) {
        await cleanupPrivatePath(fileSystem, candidatePath, true)
        throw error
    }
}

async function tryPublishCandidate(
    fileSystem: InstallerLockFileSystem,
    candidate: InstallerLockCandidate,
    publishedPath: string,
): Promise<boolean> {
    try {
        // Every published destination remains nonempty, so simultaneous publishers have exactly one winner.
        await fileSystem.rename(candidate.path, publishedPath)
        return true
    } catch (error) {
        try {
            await fileSystem.stat(publishedPath)
        } catch {
            throw error
        }
        const { value: owner } = await readJson(fileSystem, ownerFilePath(publishedPath))
        if (isPublishedOwner(owner) && matchesClaim(owner, candidate.owner)) return true
        const code = errorCode(error)
        if (code === "EPERM" || code === "ENOTEMPTY" || code === "EEXIST") return false
        throw error
    }
}

function describeOwner(owner: InstallerLockOwner | undefined): string {
    if (owner === undefined) return "unknown owner"
    return `pid ${owner.pid} on ${owner.host}, started ${new Date(owner.startedAt).toISOString()}`
}

function createTimeout(waitedMs: number, owner: InstallerLockOwner | undefined): InstallerLockTimeout {
    const seconds = Math.round(waitedMs / 1000)
    return {
        ok: false,
        reason: "timeout",
        message: `Timed out after ${seconds}s waiting for another managed script installer (${describeOwner(owner)}). Retry later.`,
        waitedMs,
        ...(owner === undefined ? {} : { owner }),
    }
}

/** Acquires a new immutable generation, waiting up to `waitTimeoutMs` for active installers. */
export async function acquireInstallerLock(
    fileSystem: InstallerLockFileSystem,
    lockPath: string,
    config?: InstallerLockConfig,
): Promise<InstallerLockAcquireResult> {
    assertLockPath(lockPath)
    const resolved = resolveConfig(config)
    const start = resolved.now()
    await fileSystem.mkdir(lockPath, { recursive: true })
    const candidate = await prepareCandidate(fileSystem, lockPath, resolved)
    let published = false
    try {
        for (;;) {
            const inspected = await inspectCurrentLock(fileSystem, lockPath, resolved)
            let state = inspected.state
            if (state.state !== "active") {
                if (inspected.generation === Number.MAX_SAFE_INTEGER) throw new Error(generationOverflowMessage)
                const publishedPath = generationPath(lockPath, inspected.generation + 1)
                if (await tryPublishCandidate(fileSystem, candidate, publishedPath)) {
                    published = true
                    return { ok: true, lock: await createHandle(fileSystem, publishedPath, candidate.owner, resolved) }
                }
                state = (await inspectCurrentLock(fileSystem, lockPath, resolved)).state
            }
            const waited = resolved.now() - start
            if (waited >= resolved.waitTimeoutMs) return createTimeout(waited, state.state === "free" ? undefined : state.owner)
            await resolved.sleep(Math.max(1, Math.min(resolved.pollIntervalMs, resolved.waitTimeoutMs - waited)))
        }
    } finally {
        if (!published) await cleanupPrivatePath(fileSystem, candidate.path, true)
    }
}

/** Runs `run` while holding the installer lock; always releases it. */
export async function withInstallerLock<T>(
    fileSystem: InstallerLockFileSystem,
    lockPath: string,
    config: InstallerLockConfig | undefined,
    run: () => Promise<T>,
): Promise<{ ok: true, value: T } | InstallerLockTimeout> {
    const acquired = await acquireInstallerLock(fileSystem, lockPath, config)
    if (!acquired.ok) return acquired
    try {
        return { ok: true, value: await run() }
    } finally {
        await acquired.lock.release()
    }
}
