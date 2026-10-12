import { open } from "node:fs/promises"
import { win32 } from "node:path"
import type { ManagedScriptRuntimeChild, ManagedScriptRuntimeProcess } from "./managed_script_runtime"
import { flattenError } from "./tools"

const helperTimeoutMs = 30_000
const taskkillTimeoutMs = 10_000
const outputCapBytes = 4_096
const childExitTimeoutMs = 5_000

export type WindowsServiceIdentity = { kind: "windows", pid: number, creation_time_ticks: string }
export type WindowsServiceCleanup = {
    termination: "forced" | "none" | "unknown"
    tree_cleanup: "best_effort" | "not_attempted" | "unknown"
    descendants: "unknown"
    root_exited?: boolean
}
export const windowsServiceMessage = "Windows stop uses forced, best-effort tree cleanup; descendant exit is unknown."

export class ManagedScriptWindowsError extends Error {
    constructor(readonly code: string, message: string, readonly windows_cleanup?: WindowsServiceCleanup) {
        super(message)
        this.name = "ManagedScriptWindowsError"
    }
}

type HelperResult = { status: "running" | "missing" | "mismatch" | "stopped" | "denied" | "failed" | "timeout", creation_time_ticks?: string, taskkill_started?: boolean }
type WindowsLogHandle = Pick<Awaited<ReturnType<typeof open>>, "fd" | "close">
type WindowsLaunchInput = { entry: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv, stdout: string, stderr: string }
export type ManagedScriptWindows = {
    launch: (input: WindowsLaunchInput, persist: (identity: WindowsServiceIdentity) => Promise<void>) => Promise<void>
    inspect: (identity: WindowsServiceIdentity) => Promise<boolean>
    stop: (identity: WindowsServiceIdentity) => Promise<WindowsServiceCleanup>
}

// Only JSON control data reaches this fixed code; user entry paths and argv never reach PowerShell.
const helperCode = String.raw`
$ErrorActionPreference = 'Stop'
$target = $null
$killer = $null
$taskkillStarted = $false
$identityValidated = $false
$result = @{ status = 'failed' }
try {
    $control = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($control.action -notin @('capture', 'inspect', 'stop') -or $control.pid -le 0 -or $control.pid -gt [int]::MaxValue) { throw 'Invalid control' }
    try { $target = [System.Diagnostics.Process]::GetProcessById([int]$control.pid) }
    catch [System.ArgumentException] { $result = @{ status = 'missing' } }
    if ($null -ne $target) {
        $null = $target.Handle
        if ($target.HasExited) { $result = @{ status = 'missing' } }
        else {
            $ticks = $target.StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture)
            if ($control.action -ne 'capture' -and $ticks -cne $control.creation_time_ticks) { $result = @{ status = 'mismatch' } }
            elseif ($control.action -ne 'stop') { $result = @{ status = 'running'; creation_time_ticks = $ticks } }
            else {
                $identityValidated = $true
                $info = New-Object System.Diagnostics.ProcessStartInfo
                $info.FileName = $control.taskkill
                $info.Arguments = '/PID ' + ([int]$control.pid).ToString([System.Globalization.CultureInfo]::InvariantCulture) + ' /T /F'
                $info.UseShellExecute = $false
                $info.CreateNoWindow = $true
                $info.RedirectStandardOutput = $true
                $info.RedirectStandardError = $true
                $killer = New-Object System.Diagnostics.Process
                $killer.StartInfo = $info
                if (-not $killer.Start()) { throw 'taskkill did not start' }
                $taskkillStarted = $true
                $outBuffer = New-Object char[] 1024
                $errBuffer = New-Object char[] 1024
                $outRead = $killer.StandardOutput.ReadAsync($outBuffer, 0, $outBuffer.Length)
                $errRead = $killer.StandardError.ReadAsync($errBuffer, 0, $errBuffer.Length)
                $clock = [System.Diagnostics.Stopwatch]::StartNew()
                $timedOut = $false
                while (-not $killer.WaitForExit(50)) {
                    if ($outRead.IsCompleted -and $outRead.GetAwaiter().GetResult() -gt 0) { $outRead = $killer.StandardOutput.ReadAsync($outBuffer, 0, $outBuffer.Length) }
                    if ($errRead.IsCompleted -and $errRead.GetAwaiter().GetResult() -gt 0) { $errRead = $killer.StandardError.ReadAsync($errBuffer, 0, $errBuffer.Length) }
                    if (-not $timedOut -and $clock.ElapsedMilliseconds -ge ${taskkillTimeoutMs}) {
                        $timedOut = $true
                        $killer.Kill()
                    }
                }
                if ($timedOut) { $result = @{ status = 'timeout' } }
                elseif ($killer.ExitCode -eq 0 -and $target.WaitForExit(${childExitTimeoutMs})) { $result = @{ status = 'stopped' } }
                else { $result = @{ status = 'failed' } }
            }
        }
    }
}
catch [System.ComponentModel.Win32Exception] {
    if ($identityValidated) { $result = @{ status = 'failed' } }
    else { $result = @{ status = 'denied' } }
}
catch {
    $result = @{ status = 'failed' }
}
finally {
    try {
        if ($null -ne $killer) {
            try {
                if ($taskkillStarted) {
                    while ($true) {
                        try { if ($killer.WaitForExit(1000)) { break } } catch {}
                        try { $killer.Kill() } catch {}
                        Start-Sleep -Milliseconds 50
                    }
                }
            }
            finally { $killer.Dispose() }
        }
    }
    finally { if ($null -ne $target) { $target.Dispose() } }
}
$result.taskkill_started = $taskkillStarted
[Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
`

function validPid(pid: number): boolean {
    return Number.isSafeInteger(pid) && pid > 0 && pid <= 2_147_483_647
}

export function isWindowsServiceIdentity(value: unknown): value is WindowsServiceIdentity {
    if (typeof value !== "object" || value === null) return false
    const identity = value as Record<string, unknown>
    return identity.kind === "windows" && typeof identity.pid === "number" && validPid(identity.pid)
        && typeof identity.creation_time_ticks === "string" && /^[0-9]{1,19}$/.test(identity.creation_time_ticks)
}

export function resolveWindowsServiceExecutables(env: NodeJS.ProcessEnv): { powershell: string, taskkill: string } {
    const root = Object.entries(env).find(([key]: [string, string | undefined]): boolean => key.toUpperCase() === "SYSTEMROOT")?.[1]
    if (!root || !/^[a-z]:\\/i.test(root) || root.includes("\0") || root.split(/[\\/]/).some((component: string): boolean => /[ .]$/.test(component)) || /["<>|?*]/.test(root.slice(2)) || root.slice(2).includes(":")) {
        throw new ManagedScriptWindowsError("windows_system_root", "Windows service management requires a validated absolute SystemRoot path; PATH lookup is not allowed.")
    }
    const redirected = Object.entries(env).some(([key, value]: [string, string | undefined]): boolean => key.toUpperCase() === "PROCESSOR_ARCHITEW6432" && Boolean(value))
    const system = win32.join(root, redirected ? "Sysnative" : "System32")
    // Sysnative starts native PowerShell, where the taskkill path must use System32 rather than the WOW64 alias.
    return { powershell: win32.join(system, "WindowsPowerShell", "v1.0", "powershell.exe"), taskkill: win32.join(root, "System32", "taskkill.exe") }
}

function noTreeCleanup(rootExited?: boolean): WindowsServiceCleanup {
    return { termination: "none", tree_cleanup: "not_attempted", descendants: "unknown", ...(rootExited === undefined ? {} : { root_exited: rootExited }) }
}

function unknownCleanup(): WindowsServiceCleanup {
    return { termination: "unknown", tree_cleanup: "unknown", descendants: "unknown" }
}

function refusal(result: HelperResult): ManagedScriptWindowsError {
    if (result.status === "missing") return new ManagedScriptWindowsError("windows_root_missing", "Managed script service root has already exited; tree cleanup was not attempted and live descendants may remain.", noTreeCleanup(true))
    if (result.status === "mismatch") return new ManagedScriptWindowsError("windows_identity_mismatch", "Managed script service process identity changed; refusing to terminate it. Descendant state is unknown.", noTreeCleanup())
    if (result.status === "denied") return new ManagedScriptWindowsError("windows_identity_denied", "Unable to access managed script process identity; termination is not authorized. Descendant state is unknown.", noTreeCleanup())
    return new ManagedScriptWindowsError("windows_operation_uncertain", `Windows service operation ${result.status}; root and descendant exit are unconfirmed.`, result.taskkill_started ? { termination: "forced", tree_cleanup: "best_effort", descendants: "unknown" } : noTreeCleanup())
}

export function createManagedScriptWindows(runtimeProcess: ManagedScriptRuntimeProcess, openLog: (filePath: string, flags: "a") => Promise<WindowsLogHandle> = open): ManagedScriptWindows {
    const control = async (action: "capture" | "inspect" | "stop", pid: number, ticks?: string): Promise<HelperResult> => {
        if (!validPid(pid)) throw new ManagedScriptWindowsError("windows_invalid_pid", "Windows service PID must be a positive safe process ID.")
        const executables = resolveWindowsServiceExecutables(runtimeProcess.env)
        return await new Promise<HelperResult>((resolve, reject): void => {
            let child: ManagedScriptRuntimeChild
            try {
                child = runtimeProcess.spawn(executables.powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(helperCode, "utf16le").toString("base64")], { cwd: win32.dirname(executables.taskkill), env: runtimeProcess.env, detached: false, windowsHide: true, shell: false, stdio: "pipe" })
            }
            catch (error) { reject(new ManagedScriptWindowsError("windows_helper_failed", `Unable to launch Windows service helper: ${flattenError(error)}`)); return }
            let settled = false
            let stdout = Buffer.alloc(0)
            let stderrBytes = 0
            const finish = (error?: Error, result?: HelperResult): void => {
                if (settled) return
                settled = true
                clearTimeout(watchdog)
                if (error) reject(error)
                else if (result) resolve(result)
            }
            const abandon = (reason: string): void => {
                if (settled) return
                // A stop helper must retain its pinned root until its owned taskkill process exits.
                if (action !== "stop") child.kill?.("SIGKILL")
                child.stdin?.destroy?.()
                child.stdout?.destroy?.()
                child.stderr?.destroy?.()
                child.unref?.()
                finish(new ManagedScriptWindowsError("windows_helper_uncertain", `${reason}; root and descendant exit are unconfirmed.${action === "stop" ? " Stop helper is not forcibly killed; it remains responsible for retaining any root handle until taskkill exits." : ""}`, action === "stop" ? unknownCleanup() : noTreeCleanup()))
            }
            const watchdog = setTimeout((): void => abandon("Windows service helper exceeded its watchdog"), helperTimeoutMs)
            child.stdout?.on("data", (chunk: Buffer): void => {
                if (settled) return
                if (stdout.length + chunk.length > outputCapBytes) { abandon("Windows service helper output exceeded its limit"); return }
                stdout = Buffer.concat([stdout, chunk])
            })
            child.stderr?.on("data", (chunk: Buffer): void => {
                stderrBytes += chunk.length
                if (stderrBytes > outputCapBytes && !settled) abandon("Windows service helper error output exceeded its limit")
            })
            child.on("error", (error: Error): void => abandon(`Windows service helper failed: ${flattenError(error)}`))
            child.on("close", (code: number | null): void => {
                if (settled) return
                try {
                    const result = JSON.parse(stdout.toString("utf8").replace(/^\uFEFF/, "").trim()) as unknown
                    if (code !== 0 || typeof result !== "object" || result === null || !("status" in result) || !["running", "missing", "mismatch", "stopped", "denied", "failed", "timeout"].includes(String(result.status))) throw new Error("Invalid helper result")
                    const parsed = result as HelperResult
                    if (parsed.status === "stopped" && parsed.taskkill_started !== true) throw new Error("Taskkill completion is unconfirmed")
                    if (parsed.status === "running" && !isWindowsServiceIdentity({ kind: "windows", pid, creation_time_ticks: parsed.creation_time_ticks })) throw new Error("Invalid helper identity")
                    if (parsed.status === "running" && ticks !== undefined && parsed.creation_time_ticks !== ticks) throw new Error("Helper returned a different identity")
                    finish(undefined, parsed)
                }
                catch { finish(new ManagedScriptWindowsError("windows_helper_uncertain", "Windows service helper returned no valid single JSON result; root and descendant exit are unconfirmed.", action === "stop" ? unknownCleanup() : noTreeCleanup())) }
            })
            child.stdin?.on?.("error", (error: Error): void => abandon(`Unable to send Windows service control: ${flattenError(error)}`))
            try {
                if (!child.stdin) throw new Error("Helper stdin is unavailable")
                child.stdin.end(JSON.stringify({ action, pid, ...(ticks === undefined ? {} : { creation_time_ticks: ticks }), taskkill: executables.taskkill }))
            }
            catch (error) { abandon(`Unable to send Windows service control: ${flattenError(error)}`) }
        })
    }

    const inspect = async (identity: WindowsServiceIdentity): Promise<boolean> => {
        if (!isWindowsServiceIdentity(identity)) throw new ManagedScriptWindowsError("windows_invalid_identity", "Windows service identity is malformed; refusing inspection.")
        const result = await control("inspect", identity.pid, identity.creation_time_ticks)
        if (result.status === "missing") return false
        if (result.status !== "running") throw refusal(result)
        return true
    }

    const stop = async (identity: WindowsServiceIdentity): Promise<WindowsServiceCleanup> => {
        if (!isWindowsServiceIdentity(identity)) throw new ManagedScriptWindowsError("windows_invalid_identity", "Windows service identity is malformed; refusing termination.")
        const result = await control("stop", identity.pid, identity.creation_time_ticks)
        if (result.status !== "stopped") throw refusal(result)
        return { termination: "forced", tree_cleanup: "best_effort", descendants: "unknown", root_exited: true }
    }

    const launch = async (input: WindowsLaunchInput, persist: (identity: WindowsServiceIdentity) => Promise<void>): Promise<void> => {
        resolveWindowsServiceExecutables(runtimeProcess.env)
        const handles: WindowsLogHandle[] = []
        let child: ManagedScriptRuntimeChild | undefined
        let identity: WindowsServiceIdentity | undefined
        let exited = false
        let failure: unknown
        let exitPromise: Promise<void> | undefined
        try {
            handles.push(await openLog(input.stdout, "a"))
            handles.push(await openLog(input.stderr, "a"))
            child = runtimeProcess.spawn(runtimeProcess.execPath, [input.entry, ...input.argv], { cwd: input.cwd, env: input.env, detached: true, windowsHide: true, shell: false, stdio: ["ignore", handles[0]!.fd, handles[1]!.fd] })
            const spawnedChild = child
            exitPromise = new Promise<void>((resolve): void => { spawnedChild.on("exit", (): void => { exited = true; resolve() }) })
            await new Promise<void>((resolve, reject): void => {
                spawnedChild.on("spawn", (): void => resolve())
                spawnedChild.on("error", (error: Error): void => { failure = error; reject(error) })
            })
            if (!child.pid || !validPid(child.pid)) throw new Error("Managed script service did not provide a valid PID.")
            const captured = await control("capture", child.pid)
            if (captured.status !== "running") throw refusal(captured)
            identity = { kind: "windows", pid: child.pid, creation_time_ticks: captured.creation_time_ticks! }
            if (exited || failure) throw new Error("Managed script service exited during identity capture.")
            await persist(identity)
            if (exited || failure || !await inspect(identity)) throw new Error("Managed script service exited before start completed.")
        }
        catch (error) { failure = error }
        finally {
            const closed = await Promise.allSettled(handles.map(async (handle: WindowsLogHandle): Promise<void> => { await handle.close() }))
            const closeFailure = closed.find((result): boolean => result.status === "rejected")
            if (closeFailure?.status === "rejected") failure = new Error(`${failure ? `${flattenError(failure)}; ` : ""}Unable to close parent service log handles: ${flattenError(closeFailure.reason)}`)
        }
        if (failure) {
            let cleanup = noTreeCleanup(exited ? true : undefined)
            let cleanupError = ""
            try {
                if (identity && !exited) cleanup = await stop(identity)
                else if (child && !exited) {
                    if (!child.kill?.("SIGKILL")) throw new Error("Owned child termination could not be requested")
                    cleanup = { ...noTreeCleanup(), termination: "forced" }
                    let timeout: ReturnType<typeof setTimeout> | undefined
                    try {
                        await Promise.race([exitPromise, new Promise<never>((_resolve, reject): void => { timeout = setTimeout((): void => reject(new Error("Owned child exit is unconfirmed")), childExitTimeoutMs) })])
                    }
                    finally { if (timeout) clearTimeout(timeout) }
                    cleanup = { ...noTreeCleanup(true), termination: "forced" }
                }
            }
            catch (error) { cleanupError = ` Cleanup uncertain: ${flattenError(error)}.`; if (error instanceof ManagedScriptWindowsError && error.windows_cleanup) cleanup = error.windows_cleanup }
            child?.unref?.()
            throw new ManagedScriptWindowsError("windows_start_failed", `Unable to start managed script service: ${flattenError(failure)}.${cleanupError} Descendant exit is unknown.`, cleanup)
        }
        child?.unref?.()
    }

    return { launch, inspect, stop }
}
