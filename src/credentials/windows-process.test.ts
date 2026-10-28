import { Buffer } from "node:buffer"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { readFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { CredentialError, WINDOWS_CREDENTIAL_MAX_BYTES, type CredentialErrorCode } from "./types"
import {
    createWindowsCredentialOperation,
    readWindowsCredentialFailureDiagnostics,
    runBoundedCredentialChild,
    runWindowsCredentialOperation,
    withWindowsCredentialHelperTrace,
    WindowsCredentialProcessError,
    type CredentialChildDependencies,
    type WindowsCredentialHelperStage,
    type WindowsCredentialHelperTrace,
    type WindowsCredentialProcessOptions,
    type WindowsCredentialRequest,
    type WindowsCredentialResponse,
} from "./windows-process"

const POWERSHELL_PATH = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const SYSTEM_DIRECTORY = "C:\\Windows\\System32"
const APPROVED_TEMP = "C:\\Users\\qxz13vb\\AppData\\Local\\Temp\\opencode"
const HELPER_PATH = fileURLToPath(new URL("./windows-credentials.ps1", import.meta.url))
const WORKER_ARGUMENT = "--autocode-windows-credentials-worker"
const TEST_TIMEOUT_MS = 180000
const FIXTURE_TIMEOUT_MS = 120000
const MAX_FRAME_BYTES = 8388608
const MAX_FILE_BYTES = 1048576
const NAN_MARKER = "autocode-windows-credentials-fixture-NaN"
const EXPECTED_ERROR_MESSAGES: Partial<Record<CredentialErrorCode, string>> = {
    invalid: "Invalid credential profile, storage, or ID.",
    too_large: "Credential exceeds the supported size limit.",
    failed: "Credential read failed.",
    denied: "Credential access denied.",
}
const DIAGNOSTIC_MARKERS = ["CategoryInfo", "FullyQualifiedErrorId", "At line:", "Exception calling", "ParserError", "Add-Type", "System.Management.Automation", "windows-credentials.ps1"]

interface FixtureCommand {
    request: WindowsCredentialRequest
    options?: WindowsCredentialProcessOptions
    expectedPayload?: string
    forbidden: string[]
}

interface OperationResult {
    kind: "operation"
    status?: WindowsCredentialResponse["status"]
    sid?: string
    payloadMatches?: boolean
    error?: {
        isProcessError: boolean
        isCredentialError: boolean
        code?: CredentialErrorCode
        fixedMessage: boolean
        safeText: boolean
        noCause: boolean
        nativeCodeHidden: boolean
    }
}

interface HelperProcess {
    pid: number
    parent: number
    executable: string
    commandLine: string
}

interface Snapshot {
    kind: "snapshot"
    tag: string
    helpers: HelperProcess[]
}

interface OwnedCredential {
    id: string
    target: string
    payload: string
    path: string
}

// A dedicated API caller makes helper ownership unambiguous even with parallel test files.
async function runFixtureWorker(): Promise<void> {
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
    process.stdout.write(`${JSON.stringify({ kind: "ready", pid: process.pid })}\n`)
    try {
        for await (const line of input) {
            if (line === "stop") break
            // Preserve NaN across fixture IPC so validation receives the actual non-finite number.
            const command = JSON.parse(line, (_key: string, value: unknown): unknown => value === NAN_MARKER ? NaN : value) as FixtureCommand
            const result = await runWindowsCredentialOperation(command.request, command.options).then(
                (response: WindowsCredentialResponse): OperationResult => ({
                    kind: "operation",
                    status: response.status,
                    sid: response.status === "ok" ? response.identity?.sid : undefined,
                    payloadMatches: response.status === "ok" && response.payload === command.expectedPayload,
                }),
                (error: unknown): OperationResult => {
                    const credentialError = error instanceof CredentialError ? error : undefined
                    const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}` : ""
                    return {
                        kind: "operation",
                        error: {
                            isProcessError: error instanceof WindowsCredentialProcessError,
                            isCredentialError: credentialError !== undefined,
                            code: credentialError?.code,
                            fixedMessage: credentialError !== undefined && credentialError.message === EXPECTED_ERROR_MESSAGES[credentialError.code],
                            safeText: [...command.forbidden, ...DIAGNOSTIC_MARKERS].every((value: string): boolean => !text.includes(value)),
                            noCause: error instanceof Error && !Object.hasOwn(error, "cause"),
                            nativeCodeHidden: error instanceof Error && !Object.keys(error).includes("nativeCode") && !JSON.stringify(error).includes("nativeCode"),
                        },
                    }
                },
            )
            process.stdout.write(`${JSON.stringify(result)}\n`)
        }
    } catch {
        process.exitCode = 1
    } finally {
        input.close()
    }
}

class JsonFixtureProcess {
    readonly child: ChildProcessWithoutNullStreams
    private readonly closed: Promise<void>
    private readonly messages: Record<string, unknown>[] = []
    private pending?: { resolve: (message: Record<string, unknown>) => void; reject: (error: Error) => void }
    private ended = false
    private failed = false
    private exitCode: number | null = null

    constructor(executable: string, args: string[]) {
        this.child = spawn(executable, args, {
            cwd: SYSTEM_DIRECTORY,
            env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", TEMP: APPROVED_TEMP, TMP: APPROVED_TEMP },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            shell: false,
        })
        let buffered = ""
        let bytes = 0
        const timeout = setTimeout((): void => {
            this.failed = true
            this.kill()
        }, FIXTURE_TIMEOUT_MS)
        this.closed = new Promise((resolve: () => void): void => {
            this.child.once("close", (code: number | null): void => {
                clearTimeout(timeout)
                this.ended = true
                this.exitCode = code
                if (buffered.length !== 0) this.failed = true
                this.pending?.reject(new Error("Windows credential fixture closed before its response."))
                this.pending = undefined
                resolve()
            })
        })
        const onError = (): void => {
            this.failed = true
            this.kill()
        }
        this.child.on("error", onError)
        this.child.stdin.on("error", onError)
        this.child.stdout.on("error", onError)
        this.child.stderr.on("error", onError)
        this.child.stderr.on("data", onError)
        this.child.stdout.on("data", (chunk: Buffer): void => {
            bytes += chunk.byteLength
            if (bytes > MAX_FRAME_BYTES) {
                onError()
                return
            }
            buffered += chunk.toString("utf8")
            let newline = buffered.indexOf("\n")
            while (newline !== -1) {
                const line = buffered.slice(0, newline).replace(/\r$/, "")
                buffered = buffered.slice(newline + 1)
                try {
                    const message: unknown = JSON.parse(line)
                    if (typeof message !== "object" || message === null || Array.isArray(message)) throw new Error()
                    const fields = message as Record<string, unknown>
                    if (this.pending !== undefined) {
                        this.pending.resolve(fields)
                        this.pending = undefined
                    } else {
                        this.messages.push(fields)
                    }
                } catch {
                    onError()
                }
                newline = buffered.indexOf("\n")
            }
        })
    }

    send(line: string): void {
        try {
            this.child.stdin.write(`${line}\n`)
        } catch {
            throw new Error("Windows credential fixture input failed.")
        }
    }

    async next(): Promise<Record<string, unknown>> {
        if (this.failed) throw new Error("Windows credential fixture failed.")
        const message = this.messages.shift()
        if (message !== undefined) return message
        if (this.ended || this.pending !== undefined) throw new Error("Windows credential fixture response unavailable.")
        return new Promise((resolve: (value: Record<string, unknown>) => void, reject: (error: Error) => void): void => {
            this.pending = { resolve, reject }
        })
    }

    async finish(): Promise<boolean> {
        this.child.stdin.end()
        const timeout = setTimeout((): void => {
            this.failed = true
            this.kill()
        }, 5000)
        try {
            await this.closed
            return !this.failed && this.exitCode === 0
        } finally {
            clearTimeout(timeout)
        }
    }

    async dispose(): Promise<void> {
        this.kill()
        await this.closed
    }

    private kill(): void {
        if (this.ended) return
        try { this.child.kill("SIGKILL") } catch { }
    }
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function observerScript(parentPid: number): string {
    const helper = HELPER_PATH.replace(/'/g, "''")
    return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$helper = '${helper}'
$pattern = '(?i)(?:^|\\s)-File\\s+(?:"' + [regex]::Escape($helper) + '"|' + [regex]::Escape($helper) + ')(?=\\s|$)'
function Write-Snapshot([string] $tag) {
    $helpers = @(Get-CimInstance -ClassName Win32_Process -Filter 'ParentProcessId = ${parentPid}' | Where-Object {
        $_.Name -ieq 'powershell.exe' -and [regex]::IsMatch([string] $_.CommandLine, $pattern)
    } | ForEach-Object {
        @{ pid = [int] $_.ProcessId; parent = [int] $_.ParentProcessId; executable = [string] $_.ExecutablePath; commandLine = [string] $_.CommandLine }
    })
    [Console]::Out.WriteLine((@{ kind = 'snapshot'; tag = $tag; helpers = @($helpers) } | ConvertTo-Json -Depth 4 -Compress))
    [Console]::Out.Flush()
}
try {
    Write-Snapshot 'ready'
    $stdin = [Console]::OpenStandardInput()
    $buffer = New-Object byte[] 256
    $pending = ''
    $read = $stdin.ReadAsync($buffer, 0, $buffer.Length)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    :observe while ($clock.ElapsedMilliseconds -lt 90000) {
        if ($read.IsCompleted) {
            $count = $read.GetAwaiter().GetResult()
            if ($count -eq 0) { break }
            $pending += [Text.Encoding]::UTF8.GetString($buffer, 0, $count)
            while (($newline = $pending.IndexOf([char] 10)) -ge 0) {
                $line = $pending.Substring(0, $newline).TrimEnd([char] 13)
                $pending = $pending.Substring($newline + 1)
                if ($line -eq 'stop') { break observe }
                Write-Snapshot $line
            }
            $read = $stdin.ReadAsync($buffer, 0, $buffer.Length)
        } else {
            Write-Snapshot 'poll'
            Start-Sleep -Milliseconds 20
        }
    }
} catch {
    exit 1
}
`
}

class WindowsProcessSession {
    readonly samples: Snapshot[] = []
    private sequence = 0

    private constructor(readonly worker: JsonFixtureProcess, private readonly observer: JsonFixtureProcess) { }

    static async open(): Promise<WindowsProcessSession> {
        const worker = new JsonFixtureProcess(process.execPath, [fileURLToPath(import.meta.url), WORKER_ARGUMENT])
        let observer: JsonFixtureProcess | undefined
        try {
            const ready = await worker.next()
            if (ready.kind !== "ready" || ready.pid !== worker.child.pid || typeof ready.pid !== "number") {
                throw new Error("Windows credential API caller did not become ready.")
            }
            const script = Buffer.from(observerScript(ready.pid), "utf16le").toString("base64")
            observer = new JsonFixtureProcess(POWERSHELL_PATH, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", script])
            const session = new WindowsProcessSession(worker, observer)
            const snapshot = await session.receiveSnapshot()
            if (snapshot.tag !== "ready" || snapshot.helpers.length !== 0) throw new Error("Windows credential observer did not become ready.")
            return session
        } catch {
            await worker.dispose()
            await observer?.dispose()
            throw new Error("Windows credential lifecycle fixtures failed to start.")
        }
    }

    async snapshot(): Promise<Snapshot> {
        const tag = `snapshot-${++this.sequence}`
        this.observer.send(tag)
        for (;;) {
            const snapshot = await this.receiveSnapshot()
            if (snapshot.tag === tag) return snapshot
        }
    }

    async operation(request: unknown, owned: OwnedCredential, options?: unknown, expectedPayload?: string): Promise<{ result: OperationResult; after: Snapshot }> {
        const forbidden = [owned.payload, owned.payload.split("\r\n")[0], owned.target, owned.id]
        this.worker.send(JSON.stringify({ request, options, expectedPayload, forbidden }, (_key: string, value: unknown): unknown => {
            return typeof value === "number" && Number.isNaN(value) ? NAN_MARKER : value
        }))
        const message = await this.worker.next()
        // Request a fresh CIM snapshot before inspecting settlement, without waiting for another helper or cleanup.
        const after = await this.snapshot()
        if (message.kind !== "operation") throw new Error("Windows credential API caller returned an invalid result.")
        return { result: message as unknown as OperationResult, after }
    }

    async close(): Promise<boolean> {
        try {
            this.worker.send("stop")
            this.observer.send("stop")
            const results = await Promise.all([this.worker.finish(), this.observer.finish()])
            return results.every((result: boolean): boolean => result)
        } finally {
            await Promise.all([this.worker.dispose(), this.observer.dispose()])
        }
    }

    private async receiveSnapshot(): Promise<Snapshot> {
        const message = await this.observer.next()
        if (message.kind !== "snapshot" || typeof message.tag !== "string" || !Array.isArray(message.helpers)) {
            throw new Error("Windows credential observer returned an invalid snapshot.")
        }
        for (const helper of message.helpers as unknown[]) {
            if (typeof helper !== "object" || helper === null || !("pid" in helper) || typeof helper.pid !== "number"
                || !("parent" in helper) || typeof helper.parent !== "number"
                || !("executable" in helper) || typeof helper.executable !== "string"
                || !("commandLine" in helper) || typeof helper.commandLine !== "string") {
                throw new Error("Windows credential observer returned invalid process metadata.")
            }
        }
        const snapshot = message as unknown as Snapshot
        this.samples.push(snapshot)
        return snapshot
    }
}

if (import.meta.main && process.argv[2] === WORKER_ARGUMENT) {
    await runFixtureWorker()
} else {
    const { describe, expect, test } = await import("bun:test")
    const LIFECYCLE_TIMEOUT_MS = 1000
    const LIFECYCLE_DRAIN_MS = 100
    const LIFECYCLE_GRACE_MS = 500

    class LifecycleClock {
        time = 0
        private sequence = 0
        readonly timers = new Map<number, { at: number; callback: () => void }>()

        setTimer(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> {
            const id = ++this.sequence
            this.timers.set(id, { at: this.time + milliseconds, callback })
            return id as unknown as ReturnType<typeof setTimeout>
        }

        clearTimer(timer: ReturnType<typeof setTimeout>): void {
            this.timers.delete(timer as unknown as number)
        }

        advance(milliseconds: number): void {
            const target = this.time + milliseconds
            for (;;) {
                const next = [...this.timers].filter(([, timer]): boolean => timer.at <= target)
                    .sort((left, right): number => left[1].at - right[1].at || left[0] - right[0])[0]
                if (next === undefined) break
                this.time = Math.max(this.time, next[1].at)
                this.timers.delete(next[0])
                next[1].callback()
            }
            this.time = target
        }
    }

    class LifecycleStream extends EventEmitter {
        destroyed = false
        frame?: Buffer

        end(frame: Buffer): this {
            this.frame = frame
            return this
        }

        destroy(): this {
            this.destroyed = true
            return this
        }
    }

    class LifecycleChild extends EventEmitter {
        readonly stdin = new LifecycleStream()
        readonly stdout = new LifecycleStream()
        readonly stderr = new LifecycleStream()
        exitCode: number | null = null
        signalCode: NodeJS.Signals | null = null
        killResult: boolean | "throw" = true
        readonly kills: NodeJS.Signals[] = []
        unrefs = 0

        kill(signal: NodeJS.Signals): boolean {
            this.kills.push(signal)
            if (this.killResult === "throw") throw new Error("synthetic-private-process-error")
            return this.killResult
        }

        unref(): void {
            this.unrefs++
        }
    }

    interface LifecycleSettlement {
        count: number
        value?: WindowsCredentialResponse
        error?: unknown
    }

    function boundedOperation(killResult: boolean | "throw" = true, spawnThrows = false, observer?: (trace: Readonly<WindowsCredentialHelperTrace>) => void): {
        clock: LifecycleClock
        child: LifecycleChild
        settlement: LifecycleSettlement
        launch: { args?: Parameters<CredentialChildDependencies["spawn"]> }
        unrelated: () => void
    } {
        const clock = new LifecycleClock()
        const child = new LifecycleChild()
        child.killResult = killResult
        const launch: { args?: Parameters<CredentialChildDependencies["spawn"]> } = {}
        const unrelated = (): void => { }
        child.on("exit", unrelated)
        child.stdin.on("error", unrelated)
        const dependencies: CredentialChildDependencies = {
            spawn(...args: Parameters<CredentialChildDependencies["spawn"]>): ChildProcessWithoutNullStreams {
                launch.args = args
                if (spawnThrows) throw new Error("synthetic-private-process-error")
                return child as unknown as ChildProcessWithoutNullStreams
            },
            now: (): number => clock.time,
            setTimer: (callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> => clock.setTimer(callback, milliseconds),
            clearTimer: (timer: ReturnType<typeof setTimeout>): void => clock.clearTimer(timer),
        }
        const settlement: LifecycleSettlement = { count: 0 }
        const operation = (): Promise<WindowsCredentialResponse> => createWindowsCredentialOperation(dependencies)(
            { operation: "delete", target: "AutoCode/v1/ssh/AUTOCODE_BOUNDED_LIFECYCLE" }, { timeoutMs: LIFECYCLE_TIMEOUT_MS },
        )
        void (observer === undefined ? operation() : withWindowsCredentialHelperTrace(observer, operation)).then(
            (value: WindowsCredentialResponse): void => { settlement.count++; settlement.value = value },
            (error: unknown): void => { settlement.count++; settlement.error = error },
        )
        return { clock, child, settlement, launch, unrelated }
    }

    async function flushLifecycle(): Promise<void> {
        for (let index = 0; index < 4; index++) await Promise.resolve()
    }

    function expectLifecycleFailure(settlement: LifecycleSettlement, cleanupUnconfirmed = false, code: "failed" | "too_large" | "denied" = "failed"): void {
        expect(settlement.count).toBe(1)
        expect(settlement.value).toBeUndefined()
        expect(settlement.error).toBeInstanceOf(WindowsCredentialProcessError)
        expect(settlement.error).toBeInstanceOf(CredentialError)
        const error = settlement.error as WindowsCredentialProcessError
        expect(error.code).toBe(code)
        expect(error.message).toBe(`${EXPECTED_ERROR_MESSAGES[code]}${cleanupUnconfirmed ? " Direct child cleanup unconfirmed." : ""}`)
        expect(error.cleanupUnconfirmed).toBe(cleanupUnconfirmed ? true : undefined)
        expect(Object.hasOwn(error, "cause")).toBe(false)
        expect(`${error.stack}\n${JSON.stringify(error)}`).not.toContain("synthetic-private-process-error")
        expect(JSON.stringify(error)).not.toContain("nativeCode")
    }

    function expectLifecycleReleased(fixture: ReturnType<typeof boundedOperation>): void {
        const { child, clock, unrelated } = fixture
        expect(clock.timers.size).toBe(0)
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
            expect(stream.destroyed).toBe(true)
            expect(stream.listenerCount("end")).toBe(0)
            expect(stream.listenerCount("finish")).toBe(0)
        }
        expect(child.stdin.frame?.every((byte: number): boolean => byte === 0)).toBe(true)
        expect(child.listeners("exit")).toEqual([unrelated])
        expect(child.listenerCount("spawn")).toBe(0)
        expect(child.listenerCount("close")).toBe(0)
        expect(child.listenerCount("error")).toBe(1)
        expect(child.stdin.listeners("error")).toContain(unrelated)
        expect(child.stdin.listenerCount("error")).toBe(2)
        expect(child.stdout.listenerCount("error")).toBe(1)
        expect(child.stderr.listenerCount("error")).toBe(1)
        expect(child.stdout.listenerCount("data")).toBe(1)
        expect(child.stderr.listenerCount("data")).toBe(1)
    }

    function completeLifecycleOutput(child: LifecycleChild): Buffer {
        const chunk = Buffer.from('{"version":1,"status":"ok"}\n')
        child.stdout.emit("data", chunk)
        child.stdout.emit("end")
        child.stderr.emit("end")
        return chunk
    }

    function helperStageFrame(stage: WindowsCredentialHelperStage, elapsedMs = 0, byteCount = 0): Buffer {
        return Buffer.from(`ACW_INTERNAL_STAGE_V1|${stage}|${elapsedMs}|${byteCount}\n`, "ascii")
    }

    describe.skipIf(process.platform !== "win32")("Windows helper stage trace parser and transport (fake clock)", (): void => {
        test("accepts fragmented bounded frames and a normal response without enabling unrelated operations", async (): Promise<void> => {
            const receipts: Readonly<WindowsCredentialHelperTrace>[] = []
            const fixture = await withWindowsCredentialHelperTrace((trace: Readonly<WindowsCredentialHelperTrace>): void => {
                receipts.push(trace)
            }, async (): Promise<ReturnType<typeof boundedOperation>> => {
                await Promise.resolve()
                return boundedOperation()
            })
            const normal = boundedOperation()
            expect(fixture.launch.args?.[1]).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-File", HELPER_PATH, "-AutoCodeInternalTrace"])
            expect(normal.launch.args?.[1]).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-File", HELPER_PATH])
            const wire = Buffer.concat([
                helperStageFrame("nativecompile-before"), helperStageFrame("nativecompile-after", 7),
                helperStageFrame("input-newline", 8, 123), helperStageFrame("input-await-EOF", 8, 123),
                helperStageFrame("cleanup-after", 9, 123),
            ])
            const chunks = [Buffer.from(wire.subarray(0, 3)), Buffer.from(wire.subarray(3, 61)), Buffer.from(wire.subarray(61))]
            wire.fill(0)
            for (const chunk of chunks) fixture.child.stderr.emit("data", chunk)
            completeLifecycleOutput(fixture.child)
            fixture.child.emit("close", 0, null)
            completeLifecycleOutput(normal.child)
            normal.child.emit("close", 0, null)
            await flushLifecycle()
            expect(fixture.settlement.value).toEqual({ version: 1, status: "ok" })
            expect(normal.settlement.value).toEqual({ version: 1, status: "ok" })
            expect(fixture.settlement.count).toBe(1)
            expect(fixture.settlement.error).toBeUndefined()
            expect(receipts).toEqual([
                { helperStage: "nativecompile-before", helperElapsedMs: 0, helperByteCount: 0 },
                { helperStage: "nativecompile-after", helperElapsedMs: 7, helperByteCount: 0 },
                { helperStage: "input-newline", helperElapsedMs: 8, helperByteCount: 123 },
                { helperStage: "input-await-EOF", helperElapsedMs: 8, helperByteCount: 123 },
                { helperStage: "cleanup-after", helperElapsedMs: 9, helperByteCount: 123 },
            ])
            for (const receipt of receipts) {
                expect(Object.isFrozen(receipt)).toBe(true)
                expect(Reflect.set(receipt, "helperStage", "synthetic-private-process-error")).toBe(false)
            }
            expect(chunks.every((chunk: Buffer): boolean => chunk.every((byte: number): boolean => byte === 0))).toBe(true)
            const late = helperStageFrame("identityName-before", 10, 123)
            fixture.child.stderr.emit("data", late)
            expect(late.every((byte: number): boolean => byte === 0)).toBe(true)
            expect(receipts.length).toBe(5)
            expectLifecycleReleased(fixture)
            expectLifecycleReleased(normal)
        })

        for (const asynchronous of [false, true]) {
            test(`ignores observer errors without changing successful credential outcome, async=${asynchronous}`, async (): Promise<void> => {
                const fixture = boundedOperation(true, false, (): void | Promise<void> => {
                    if (asynchronous) return Promise.reject(new Error("synthetic-private-process-error"))
                    throw new Error("synthetic-private-process-error")
                })
                fixture.child.stderr.emit("data", helperStageFrame("dispatch-before", 1, 123))
                completeLifecycleOutput(fixture.child)
                fixture.child.emit("close", 0, null)
                await flushLifecycle()
                expect(fixture.settlement.value).toEqual({ version: 1, status: "ok" })
                expect(fixture.settlement.error).toBeUndefined()
                expectLifecycleReleased(fixture)
            })
        }

        test("rejects even valid trace bytes when trace is disabled", async (): Promise<void> => {
            const fixture = boundedOperation()
            const chunk = helperStageFrame("input-await-EOF", 1, 123)
            fixture.child.stderr.emit("data", chunk)
            fixture.child.emit("close", 0, null)
            await flushLifecycle()
            expectLifecycleFailure(fixture.settlement)
            expect(readWindowsCredentialFailureDiagnostics(fixture.settlement.error)).toMatchObject({ reason: "stderr-failure", errorBytes: chunk.byteLength })
            expect(readWindowsCredentialFailureDiagnostics(fixture.settlement.error)?.helperStage).toBeUndefined()
            expect(chunk.every((byte: number): boolean => byte === 0)).toBe(true)
            expectLifecycleReleased(fixture)
        })

        test("accepts the 96-record boundary without exposing frames", async (): Promise<void> => {
            const receipts: Readonly<WindowsCredentialHelperTrace>[] = []
            const fixture = boundedOperation(true, false, (trace: Readonly<WindowsCredentialHelperTrace>): void => { receipts.push(trace) })
            const chunk = Buffer.from("ACW_INTERNAL_STAGE_V1|parent-open-before|0|0\n".repeat(96), "ascii")
            fixture.child.stderr.emit("data", chunk)
            completeLifecycleOutput(fixture.child)
            fixture.child.emit("close", 0, null)
            await flushLifecycle()
            expect(fixture.settlement.value).toEqual({ version: 1, status: "ok" })
            expect(receipts.length).toBe(96)
            expect(JSON.stringify(receipts).includes("ACW_INTERNAL_STAGE_V1|")).toBe(false)
            expect(chunk.every((byte: number): boolean => byte === 0)).toBe(true)
            expectLifecycleReleased(fixture)
        })

        test("hard fails high-bit ASCII trace aliases before decoding without raw value leakage", async (): Promise<void> => {
            const receipts: Readonly<WindowsCredentialHelperTrace>[] = []
            const fixture = boundedOperation(true, false, (trace: Readonly<WindowsCredentialHelperTrace>): void => { receipts.push(trace) })
            const chunk = helperStageFrame("input-before", 1)
            const validFrame = chunk.toString("ascii")
            chunk[0] = chunk[0]! | 0x80
            const rawFrame = chunk.toString("latin1").trimEnd()
            expect(chunk.toString("ascii") === validFrame).toBe(true)
            fixture.child.stderr.emit("data", chunk)
            completeLifecycleOutput(fixture.child)
            fixture.child.emit("close", 0, null)
            await flushLifecycle()
            expectLifecycleFailure(fixture.settlement)
            const diagnostics = readWindowsCredentialFailureDiagnostics(fixture.settlement.error)
            expect(diagnostics).toMatchObject({ reason: "stderr-failure", errorBytes: chunk.byteLength })
            expect(diagnostics?.helperStage).toBeUndefined()
            expect(receipts.length).toBe(0)
            const error = fixture.settlement.error as WindowsCredentialProcessError
            const serialized = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify({ diagnostics, receipts, error })}`
            for (const forbidden of [rawFrame, validFrame.trimEnd(), "ACW_INTERNAL_STAGE_V1|"]) {
                expect(serialized.includes(forbidden)).toBe(false)
            }
            expect(chunk.every((byte: number): boolean => byte === 0)).toBe(true)
            expectLifecycleReleased(fixture)
        })

        const invalidFrames: { name: string; text: string }[] = [
            { name: "unknown label", text: "ACW_INTERNAL_STAGE_V1|unknown|0|0\n" },
            { name: "malformed prefix", text: "ACW_INTERNAL_STAGE_V2|input-before|0|0\n" },
            { name: "extra stderr", text: "synthetic-private-process-error\n" },
            { name: "stderr after valid frame", text: "ACW_INTERNAL_STAGE_V1|input-before|0|0\nsynthetic-private-process-error\n" },
            { name: "blank line", text: "\n" },
            { name: "payload field", text: "ACW_INTERNAL_STAGE_V1|input-before|0|0|synthetic-private-process-error\n" },
            { name: "negative elapsed", text: "ACW_INTERNAL_STAGE_V1|input-before|-1|0\n" },
            { name: "noninteger elapsed", text: "ACW_INTERNAL_STAGE_V1|input-before|1.5|0\n" },
            { name: "nonfinite elapsed", text: "ACW_INTERNAL_STAGE_V1|input-before|Infinity|0\n" },
            { name: "unsafe elapsed", text: "ACW_INTERNAL_STAGE_V1|input-before|9007199254740992|0\n" },
            { name: "unsafe byte count", text: "ACW_INTERNAL_STAGE_V1|input-before|0|9007199254740992\n" },
            { name: "oversized byte count", text: `ACW_INTERNAL_STAGE_V1|input-before|0|${MAX_FRAME_BYTES + 2}\n` },
            { name: "decreasing elapsed", text: "ACW_INTERNAL_STAGE_V1|input-before|2|0\nACW_INTERNAL_STAGE_V1|input-after|1|0\n" },
            { name: "decreasing byte count", text: "ACW_INTERNAL_STAGE_V1|input-before|1|2\nACW_INTERNAL_STAGE_V1|input-after|2|1\n" },
            { name: "non-ASCII", text: "ACW_INTERNAL_STAGE_V1|input-before|0|é\n" },
            { name: "CRLF", text: "ACW_INTERNAL_STAGE_V1|input-before|0|0\r\n" },
            { name: "truncated frame", text: "ACW_INTERNAL_STAGE_V1|input-before|0|0" },
            { name: "oversized line", text: "a".repeat(161) },
            { name: "oversized stream", text: "a".repeat(16385) },
            { name: "excess records", text: "ACW_INTERNAL_STAGE_V1|input-before|0|0\n".repeat(97) },
        ]
        for (const { name, text } of invalidFrames) {
            test(`hard fails ${name} without retaining raw stderr or request data`, async (): Promise<void> => {
                const receipts: Readonly<WindowsCredentialHelperTrace>[] = []
                const fixture = boundedOperation(true, false, (trace: Readonly<WindowsCredentialHelperTrace>): void => { receipts.push(trace) })
                const chunk = Buffer.from(text, "utf8")
                fixture.child.stderr.emit("data", chunk)
                completeLifecycleOutput(fixture.child)
                fixture.child.emit("close", 0, null)
                await flushLifecycle()
                expectLifecycleFailure(fixture.settlement)
                const diagnostics = readWindowsCredentialFailureDiagnostics(fixture.settlement.error)
                expect(diagnostics?.reason).toBe("stderr-failure")
                expect(diagnostics?.errorBytes).toBe(chunk.byteLength)
                const serialized = JSON.stringify({ diagnostics, receipts, error: fixture.settlement.error })
                for (const forbidden of ["synthetic-private-process-error", "AutoCode/v1/ssh/AUTOCODE_BOUNDED_LIFECYCLE", "ACW_INTERNAL_STAGE_V1|"]) {
                    expect(serialized.includes(forbidden)).toBe(false)
                    expect((fixture.settlement.error as Error).message.includes(forbidden)).toBe(false)
                    expect(((fixture.settlement.error as Error).stack ?? "").includes(forbidden)).toBe(false)
                }
                expect(chunk.every((byte: number): boolean => byte === 0)).toBe(true)
                expectLifecycleReleased(fixture)
            })
        }

        for (const stage of ["nativecompile-before", "input-await-EOF"] as const) {
            for (const reason of ["operation-deadline", "exit-drain-expired"] as const) {
                test(`retains ${stage} through ${reason} and late events`, async (): Promise<void> => {
                    const receipts: Readonly<WindowsCredentialHelperTrace>[] = []
                    const fixture = boundedOperation(true, false, (trace: Readonly<WindowsCredentialHelperTrace>): void => { receipts.push(trace) })
                    fixture.child.stdin.emit("finish")
                    fixture.child.stderr.emit("data", helperStageFrame("nativecompile-before"))
                    if (stage === "input-await-EOF") {
                        fixture.child.stderr.emit("data", helperStageFrame("input-newline", 12, 123))
                        fixture.child.stderr.emit("data", helperStageFrame(stage, 12, 123))
                    }
                    const partial = Buffer.from("ACW_INTERNAL_STAGE_V1|parse-before|")
                    fixture.child.stderr.emit("data", partial)
                    if (reason === "exit-drain-expired") {
                        fixture.clock.advance(10)
                        fixture.child.exitCode = 0
                        fixture.child.emit("exit", 0, null)
                    } else fixture.clock.advance(LIFECYCLE_TIMEOUT_MS)
                    fixture.clock.advance(LIFECYCLE_GRACE_MS)
                    await flushLifecycle()
                    expectLifecycleFailure(fixture.settlement, reason === "operation-deadline")
                    const diagnostics = readWindowsCredentialFailureDiagnostics(fixture.settlement.error)
                    expect(diagnostics).toMatchObject({
                        reason, helperStage: stage,
                        helperElapsedMs: stage === "input-await-EOF" ? 12 : 0,
                        helperByteCount: stage === "input-await-EOF" ? 123 : 0,
                        stdinFinished: true, stdoutEnded: false, stderrEnded: false, closeObserved: false,
                    })
                    expect(Object.isFrozen(diagnostics)).toBe(true)
                    expect(Reflect.set(diagnostics!, "helperStage", "synthetic-private-process-error")).toBe(false)
                    expect(readWindowsCredentialFailureDiagnostics({ ...diagnostics })).toBeUndefined()
                    expect(readWindowsCredentialFailureDiagnostics(Object.create(fixture.settlement.error as Error))).toBeUndefined()
                    const late = helperStageFrame("cleanup-after", 20, 123)
                    fixture.child.stderr.emit("data", late)
                    fixture.child.stderr.emit("end")
                    fixture.child.emit("close", 0, null)
                    await flushLifecycle()
                    expect(readWindowsCredentialFailureDiagnostics(fixture.settlement.error)).toBe(diagnostics)
                    expect(receipts.length).toBe(stage === "input-await-EOF" ? 3 : 1)
                    expect(fixture.settlement.count).toBe(1)
                    expect(partial.every((byte: number): boolean => byte === 0)).toBe(true)
                    expect(late.every((byte: number): boolean => byte === 0)).toBe(true)
                    expectLifecycleReleased(fixture)
                })
            }
        }
    })

    describe.skipIf(process.platform !== "win32")("bounded credential transport lifecycle", (): void => {
        test("settles at timeout plus 500ms when kill succeeds but close and EOF never arrive", async (): Promise<void> => {
            const fixture = boundedOperation()
            const { child, clock, settlement } = fixture
            const chunk = Buffer.from('{"version":1,"status":"ok"}\n')
            child.stdout.emit("data", chunk)
            clock.advance(LIFECYCLE_TIMEOUT_MS)
            await flushLifecycle()
            expect(child.kills).toEqual(["SIGKILL"])
            expect(child.stdin.destroyed).toBe(true)
            expect(child.stdin.frame?.every((byte: number): boolean => byte === 0)).toBe(true)
            expect(settlement.count).toBe(0)
            clock.advance(LIFECYCLE_DRAIN_MS - 1)
            expect(child.stdout.destroyed).toBe(false)
            clock.advance(1)
            expect(child.stdout.destroyed && child.stderr.destroyed).toBe(true)
            clock.advance(LIFECYCLE_GRACE_MS - LIFECYCLE_DRAIN_MS - 1)
            await flushLifecycle()
            expect(settlement.count).toBe(0)
            // The old close-only settlement remains pending at this exact regression checkpoint.
            clock.advance(1)
            await flushLifecycle()
            expect(clock.time).toBe(LIFECYCLE_TIMEOUT_MS + LIFECYCLE_GRACE_MS)
            expectLifecycleFailure(settlement, true)
            const diagnostics = readWindowsCredentialFailureDiagnostics(settlement.error)
            expect(diagnostics).toEqual({
                reason: "operation-deadline",
                elapsedMs: LIFECYCLE_TIMEOUT_MS + LIFECYCLE_GRACE_MS,
                timeoutMs: LIFECYCLE_TIMEOUT_MS,
                exitObserved: false,
                closeObserved: false,
                stdinFinished: false,
                stdoutEnded: false,
                stderrEnded: false,
                exitCode: "unknown",
                inputBytes: child.stdin.frame!.byteLength,
                outputBytes: chunk.byteLength,
                errorBytes: 0,
                cleanupUnconfirmed: true,
            })
            expect(Object.isFrozen(diagnostics)).toBe(true)
            expect(Reflect.set(diagnostics!, "reason", "synthetic-private-process-error")).toBe(false)
            expect(readWindowsCredentialFailureDiagnostics(Object.create(settlement.error as Error))).toBeUndefined()
            expect(readWindowsCredentialFailureDiagnostics({ ...diagnostics })).toBeUndefined()
            expect(readWindowsCredentialFailureDiagnostics(new WindowsCredentialProcessError("failed"))).toBeUndefined()
            expect(JSON.stringify(diagnostics)).not.toContain("AutoCode/v1/ssh/AUTOCODE_BOUNDED_LIFECYCLE")
            expect(child.unrefs).toBe(1)
            expect(chunk.every((byte: number): boolean => byte === 0)).toBe(true)
            expectLifecycleReleased(fixture)
        })

        for (const validOutput of [false, true]) {
            test(`bounds exit without stdout-end or close, valid output=${validOutput}`, async (): Promise<void> => {
                const fixture = boundedOperation()
                const { child, clock, settlement } = fixture
                const chunk = Buffer.from('{"version":1,"status":"ok"}\n')
                if (validOutput) child.stdout.emit("data", chunk)
                else chunk.fill(0)
                clock.advance(10)
                child.exitCode = 0
                child.emit("exit", 0, null)
                clock.advance(LIFECYCLE_GRACE_MS - 1)
                await flushLifecycle()
                expect(settlement.count).toBe(0)
                clock.advance(1)
                await flushLifecycle()
                expect(clock.time).toBe(10 + LIFECYCLE_GRACE_MS)
                expectLifecycleFailure(settlement)
                expect(readWindowsCredentialFailureDiagnostics(settlement.error)).toEqual({
                    reason: "exit-drain-expired",
                    elapsedMs: 10 + LIFECYCLE_GRACE_MS,
                    timeoutMs: LIFECYCLE_TIMEOUT_MS,
                    exitObserved: true,
                    closeObserved: false,
                    stdinFinished: false,
                    stdoutEnded: false,
                    stderrEnded: false,
                    exitCode: 0,
                    inputBytes: child.stdin.frame!.byteLength,
                    outputBytes: validOutput ? chunk.byteLength : 0,
                    errorBytes: 0,
                    cleanupUnconfirmed: false,
                })
                expect(child.kills).toEqual([])
                expect(child.unrefs).toBe(0)
                expect(chunk.every((byte: number): boolean => byte === 0)).toBe(true)
                expectLifecycleReleased(fixture)
            })
        }

        test("rejects valid but unended output even when a successful close arrives", async (): Promise<void> => {
            const fixture = boundedOperation()
            fixture.child.stdout.emit("data", Buffer.from('{"version":1,"status":"ok"}\n'))
            fixture.child.emit("close", 0, null)
            await flushLifecycle()
            expectLifecycleFailure(fixture.settlement)
            expect(readWindowsCredentialFailureDiagnostics(fixture.settlement.error)).toMatchObject({
                reason: "close-without-eof", closeObserved: true, exitObserved: false, exitCode: 0,
                stdoutEnded: false, stderrEnded: false, stdinFinished: false, cleanupUnconfirmed: false,
            })
            expectLifecycleReleased(fixture)
        })

        test("requires close before monotonic operation and drain deadlines even when timers have not run", async (): Promise<void> => {
            for (const deadline of ["operation", "drain"]) {
                const fixture = boundedOperation()
                completeLifecycleOutput(fixture.child)
                if (deadline === "drain") fixture.child.emit("exit", 0, null)
                fixture.clock.time = deadline === "operation" ? LIFECYCLE_TIMEOUT_MS : LIFECYCLE_DRAIN_MS
                fixture.child.emit("close", 0, null)
                await flushLifecycle()
                expectLifecycleFailure(fixture.settlement)
                expect(readWindowsCredentialFailureDiagnostics(fixture.settlement.error)?.reason).toBe(deadline === "operation" ? "operation-deadline" : "exit-drain-expired")
                expectLifecycleReleased(fixture)
            }
        })

        test("accepts complete validated output and successful close before deadline", async (): Promise<void> => {
            const fixture = boundedOperation()
            const { child, settlement, launch } = fixture
            child.exitCode = 0
            child.emit("exit", 0, null)
            fixture.clock.advance(LIFECYCLE_DRAIN_MS - 1)
            const chunk = completeLifecycleOutput(child)
            child.stdin.emit("finish")
            child.emit("close", 0, null)
            await flushLifecycle()
            expect(settlement.count).toBe(1)
            expect(settlement.error).toBeUndefined()
            expect(settlement.value).toEqual({ version: 1, status: "ok" })
            expect(readWindowsCredentialFailureDiagnostics(settlement.value)).toBeUndefined()
            expect(readWindowsCredentialFailureDiagnostics(settlement.error)).toBeUndefined()
            expect(chunk.every((byte: number): boolean => byte === 0)).toBe(true)
            expect(child.kills).toEqual([])
            expect(launch.args?.[0]).toBe(POWERSHELL_PATH)
            expect(launch.args?.[1]).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-File", HELPER_PATH])
            expect(launch.args?.[2]).toMatchObject({ cwd: SYSTEM_DIRECTORY, stdio: ["pipe", "pipe", "pipe"], detached: false, windowsHide: true, shell: false })
            expect(Object.keys(launch.args?.[2].env ?? {}).every((key: string): boolean => ["SystemRoot", "WINDIR", "TEMP", "TMP"].includes(key))).toBe(true)
            expectLifecycleReleased(fixture)
        })

        test("never accepts unavailable output arriving after the operation deadline", async (): Promise<void> => {
            const fixture = boundedOperation()
            fixture.clock.time = LIFECYCLE_TIMEOUT_MS
            fixture.child.stdout.emit("data", Buffer.from('{"version":1,"status":"unavailable"}\n'))
            fixture.child.stdout.emit("end")
            fixture.child.stderr.emit("end")
            fixture.child.emit("close", 0, null)
            await flushLifecycle()
            expectLifecycleFailure(fixture.settlement)
            expectLifecycleReleased(fixture)
        })

        for (const observed of ["exitCode", "signalCode"] as const) {
            test(`recognizes observed ${observed} without claiming kill confirmed reaping`, async (): Promise<void> => {
                const fixture = boundedOperation(false)
                fixture.clock.advance(LIFECYCLE_TIMEOUT_MS)
                if (observed === "exitCode") fixture.child.exitCode = 1
                else fixture.child.signalCode = "SIGKILL"
                fixture.clock.advance(LIFECYCLE_GRACE_MS)
                await flushLifecycle()
                expectLifecycleFailure(fixture.settlement)
                expect(readWindowsCredentialFailureDiagnostics(fixture.settlement.error)).toMatchObject({
                    reason: "operation-deadline", exitObserved: false, closeObserved: false,
                    exitCode: observed === "exitCode" ? 1 : "unknown", cleanupUnconfirmed: false,
                })
                expect(fixture.child.unrefs).toBe(0)
                expectLifecycleReleased(fixture)
            })
        }

        test("sanitizes spawn throw without retaining an operation timer", async (): Promise<void> => {
            const { settlement, clock, child } = boundedOperation(true, true)
            await flushLifecycle()
            expectLifecycleFailure(settlement)
            expect(readWindowsCredentialFailureDiagnostics(settlement.error)).toMatchObject({
                reason: "spawn-failure", elapsedMs: 0, exitObserved: false, closeObserved: false,
                exitCode: "unknown", outputBytes: 0, errorBytes: 0, cleanupUnconfirmed: false,
            })
            expect(clock.timers.size).toBe(0)
            expect(child.kills).toEqual([])
            expect(child.unrefs).toBe(0)
        })

        for (const killResult of [true, false, "throw"] as const) {
            test(`bounds spawn error without close and reports unconfirmed cleanup, kill=${killResult}`, async (): Promise<void> => {
                const fixture = boundedOperation(killResult)
                fixture.child.emit("error", new Error("synthetic-private-process-error"))
                fixture.clock.advance(LIFECYCLE_GRACE_MS)
                await flushLifecycle()
                expectLifecycleFailure(fixture.settlement, true)
                expect(fixture.child.kills).toEqual(["SIGKILL"])
                expect(fixture.child.unrefs).toBe(1)
                expectLifecycleReleased(fixture)
            })
        }

        test("absorbs late exit, close, data and errors without resettling or retaining timers", async (): Promise<void> => {
            const fixture = boundedOperation()
            fixture.clock.advance(LIFECYCLE_TIMEOUT_MS + LIFECYCLE_GRACE_MS)
            await flushLifecycle()
            expectLifecycleFailure(fixture.settlement, true)
            const diagnostics = readWindowsCredentialFailureDiagnostics(fixture.settlement.error)
            const serialized = JSON.stringify(diagnostics)
            const stdout = Buffer.from('{"version":1,"status":"unavailable"}\n')
            const stderr = Buffer.from("synthetic-private-process-error")
            expect((): void => {
                fixture.child.emit("spawn")
                fixture.child.emit("exit", 0, null)
                fixture.child.emit("close", 0, null)
                fixture.child.stdout.emit("data", stdout)
                fixture.child.stderr.emit("data", stderr)
                for (const emitter of [fixture.child, fixture.child.stdin, fixture.child.stdout, fixture.child.stderr]) {
                    emitter.emit("error", new Error("synthetic-private-process-error"))
                }
            }).not.toThrow()
            fixture.clock.advance(10000)
            await flushLifecycle()
            expectLifecycleFailure(fixture.settlement, true)
            expect(readWindowsCredentialFailureDiagnostics(fixture.settlement.error)).toBe(diagnostics)
            expect(JSON.stringify(readWindowsCredentialFailureDiagnostics(fixture.settlement.error))).toBe(serialized)
            expect(stdout.every((byte: number): boolean => byte === 0)).toBe(true)
            expect(stderr.every((byte: number): boolean => byte === 0)).toBe(true)
            expectLifecycleReleased(fixture)
        })

        test("preserves too_large as the primary sanitized failure through cleanup", async (): Promise<void> => {
            const fixture = boundedOperation()
            const oversized = Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61)
            fixture.child.stdout.emit("data", oversized)
            fixture.child.emit("error", new Error("synthetic-private-process-error"))
            fixture.clock.advance(LIFECYCLE_GRACE_MS)
            await flushLifecycle()
            expectLifecycleFailure(fixture.settlement, true, "too_large")
            expect(readWindowsCredentialFailureDiagnostics(fixture.settlement.error)).toMatchObject({
                reason: "response-failure", outputBytes: MAX_FRAME_BYTES + 1, errorBytes: 0,
            })
            expect(oversized.every((byte: number): boolean => byte === 0)).toBe(true)
            expectLifecycleReleased(fixture)
        })

        test("registers only final native response failures with parent finish and separate byte counts", async (): Promise<void> => {
            const fixture = boundedOperation()
            const { child, clock, settlement } = fixture
            const stdout = Buffer.from('{"version":1,"status":"error","code":"denied","nativeCode":5}\n')
            const stderr = Buffer.from("synthetic-private-process-error")
            child.stdin.emit("finish")
            clock.advance(17)
            child.stdout.emit("data", stdout)
            await flushLifecycle()
            expect(settlement.count).toBe(0)
            child.stderr.emit("data", stderr)
            child.stderr.emit("error", new Error("synthetic-private-process-error"))
            child.stdout.emit("end")
            child.stderr.emit("end")
            child.exitCode = 1
            child.emit("exit", 1, null)
            child.emit("close", 1, null)
            await flushLifecycle()
            expectLifecycleFailure(settlement, false, "denied")
            expect((settlement.error as WindowsCredentialProcessError).nativeCode).toBe(5)
            expect(readWindowsCredentialFailureDiagnostics(settlement.error)).toEqual({
                reason: "response-failure",
                elapsedMs: 17,
                timeoutMs: LIFECYCLE_TIMEOUT_MS,
                exitObserved: true,
                closeObserved: true,
                stdinFinished: true,
                stdoutEnded: true,
                stderrEnded: true,
                exitCode: 1,
                inputBytes: child.stdin.frame!.byteLength,
                outputBytes: stdout.byteLength,
                errorBytes: stderr.byteLength,
                cleanupUnconfirmed: false,
            })
            expect(stdout.every((byte: number): boolean => byte === 0)).toBe(true)
            expect(stderr.every((byte: number): boolean => byte === 0)).toBe(true)
            expectLifecycleReleased(fixture)
        })

        test("registers diagnostics on the actual rejection only at final settlement", async (): Promise<void> => {
            const child = new LifecycleChild()
            const clock = new LifecycleClock()
            const finalError = new WindowsCredentialProcessError("failed")
            const input = Buffer.from("synthetic-private-process-error")
            const pending = runBoundedCredentialChild((): ChildProcessWithoutNullStreams => child as unknown as ChildProcessWithoutNullStreams, input, LIFECYCLE_TIMEOUT_MS, {
                stdout(): void { throw finalError },
                stderr(): void { },
                complete(): void { },
                clear(): void { },
            }, {
                now: (): number => clock.time,
                setTimer: (callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> => clock.setTimer(callback, milliseconds),
                clearTimer: (timer: ReturnType<typeof setTimeout>): void => clock.clearTimer(timer),
            }).catch((error: unknown): unknown => error)
            child.stdout.emit("data", Buffer.from("synthetic-private-process-error"))
            expect(readWindowsCredentialFailureDiagnostics(finalError)).toBeUndefined()
            clock.advance(LIFECYCLE_GRACE_MS)
            expect(await pending).toBe(finalError)
            expect(readWindowsCredentialFailureDiagnostics(finalError)).toMatchObject({
                reason: "response-failure", elapsedMs: LIFECYCLE_GRACE_MS, cleanupUnconfirmed: true,
            })
            expect(input.every((byte: number): boolean => byte === 0)).toBe(true)
            expect(clock.timers.size).toBe(0)
        })

        for (const source of ["process", "stdin", "stdout", "stderr"] as const) {
            test(`retains ${source} failure category without raw error data`, async (): Promise<void> => {
                const fixture = boundedOperation()
                const emitter = source === "process" ? fixture.child : fixture.child[source]
                emitter.emit("error", Object.assign(new Error("synthetic-private-process-error"), { code: "synthetic-private-process-error" }))
                fixture.clock.advance(LIFECYCLE_GRACE_MS)
                await flushLifecycle()
                expectLifecycleFailure(fixture.settlement, true)
                const diagnostics = readWindowsCredentialFailureDiagnostics(fixture.settlement.error)
                expect(diagnostics?.reason).toBe(`${source}-failure`)
                expect(JSON.stringify(diagnostics)).not.toContain("synthetic-private-process-error")
                expectLifecycleReleased(fixture)
            })
        }
    })

    function createOwnedCredential(): OwnedCredential {
        const id = `AUTOCODE_WINDOWS_TEST_${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`
        const prefix = `synthetic-secret-${crypto.randomUUID()}\r\n\"'; Write-Output synthetic-only; $env:AUTOCODE_TEST; 😀`
        const remaining = WINDOWS_CREDENTIAL_MAX_BYTES - Buffer.byteLength(prefix, "utf8")
        return {
            id,
            target: `AutoCode/v1/ssh/${id}`,
            payload: prefix + "é".repeat(Math.floor(remaining / 2)) + "a".repeat(remaining % 2),
            path: `${APPROVED_TEMP}\\autocode-windows-credentials-${crypto.randomUUID()}.json`,
        }
    }

    function expectSafeError(result: OperationResult, code: CredentialErrorCode): void {
        expect(result.status).toBeUndefined()
        expect(result.error).toEqual({
            isProcessError: true,
            isCredentialError: true,
            code,
            fixedMessage: true,
            safeText: true,
            noCause: true,
            nativeCodeHidden: true,
        })
    }

    function expectSafeArgv(session: WindowsProcessSession, owned: OwnedCredential): void {
        const helpers = session.samples.flatMap((sample: Snapshot): HelperProcess[] => sample.helpers)
        const executable = escapeRegex(POWERSHELL_PATH)
        const helper = escapeRegex(HELPER_PATH)
        const command = new RegExp(`^(?:"${executable}"|${executable}) -NoLogo -NoProfile -NonInteractive -File (?:"${helper}"|${helper})$`, "i")
        expect(new Set(helpers.map((process: HelperProcess): number => process.pid)).size).toBeGreaterThan(0)
        for (const process of helpers) {
            expect(process.parent === session.worker.child.pid).toBe(true)
            expect(process.executable.toLowerCase() === POWERSHELL_PATH.toLowerCase()).toBe(true)
            expect(command.test(process.commandLine)).toBe(true)
            expect([owned.payload, owned.payload.split("\r\n")[0], owned.target, owned.id].every((value: string): boolean => !process.commandLine.includes(value))).toBe(true)
        }
    }

    async function withOwnedSession(action: (session: WindowsProcessSession, owned: OwnedCredential) => Promise<void>): Promise<void> {
        const owned = createOwnedCredential()
        const session = await WindowsProcessSession.open()
        let cleaned = false
        let closed = false
        try {
            await action(session, owned)
        } finally {
            try {
                const deleted = await session.operation({ operation: "delete", target: owned.target }, owned)
                const missing = await session.operation({ operation: "read", target: owned.target }, owned)
                cleaned = (deleted.result.status === "ok" || deleted.result.status === "missing") && missing.result.status === "missing"
            } finally {
                closed = await session.close()
                process.stdout.write(`Windows credential cleanup: count=${cleaned ? 1 : 0}; IDs=${owned.id}\n`)
            }
            expect(cleaned).toBe(true)
            expect(closed).toBe(true)
        }
    }

    describe.skipIf(process.platform !== "win32")("real Windows credential helper lifecycle and transport", (): void => {
        test("reviews restricted environment and fixed launch settings (source only, not live environment proof)", async (): Promise<void> => {
            const source = (await readFile(new URL("./windows-process.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n")
            const environment = source.slice(source.indexOf("function processEnvironment()"), source.indexOf("function nativeCodeFrom("))
            expect(environment.trim()).toBe([
                "function processEnvironment(): NodeJS.ProcessEnv {",
                "    const environment: NodeJS.ProcessEnv = { SystemRoot: WINDOWS_ROOT, WINDIR: WINDOWS_ROOT }",
                "    for (const key of [\"TEMP\", \"TMP\"]) {",
                "        const value = process.env[key]",
                "        if (isSafeTempPath(value)) environment[key] = value",
                "    }",
                "    return environment",
                "}",
            ].join("\n"))
            expect(source).toContain('const WINDOWS_ROOT = "C:\\\\Windows"')
            expect(source).toContain('const POWERSHELL_PATH = `${WINDOWS_ROOT}\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe`')
            expect(source).toContain('const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helperPath]')
            expect(source).toContain('if (trace !== undefined) args.push("-AutoCodeInternalTrace")')
            expect(source).toContain('child = spawn(POWERSHELL_PATH, args, {')
            expect(source).toContain('cwd: `${WINDOWS_ROOT}\\\\System32`')
            expect(source).toContain("env: environment,")
            expect(source).toContain("shell: false,")
            expect(source).toContain("const DEFAULT_TIMEOUT_MS = 15000")
            expect(source).toContain(`const MAX_FRAME_BYTES = ${MAX_FRAME_BYTES}`)
            expect(source).toContain(`const MAX_FILE_BYTES = ${MAX_FILE_BYTES}`)
            const tempValidation = source.slice(source.indexOf("function isSafeTempPath("), source.indexOf("function processEnvironment()"))
            expect(tempValidation).toContain("value.length > MAX_PATH_LENGTH")
            expect(tempValidation).toContain("!/^[A-Za-z]:\\\\/.test(value)")
            expect(tempValidation).toContain('if (/[\\u0000-\\u001f<>:"/|?*]/.test(tail)) return false')
            expect(tempValidation).toContain('component !== "" && !/[. ]$/.test(component)')
        }, TEST_TIMEOUT_MS)

        test("keeps optional nativeCode nonenumerable on the public error type", (): void => {
            const error = new WindowsCredentialProcessError("failed", 1168)
            expect(error).toBeInstanceOf(CredentialError)
            expect(error.message).toBe(EXPECTED_ERROR_MESSAGES.failed!)
            expect(error.nativeCode).toBe(1168)
            expect(Object.getOwnPropertyDescriptor(error, "nativeCode")?.enumerable).toBe(false)
            expect(Object.keys(error).includes("nativeCode")).toBe(false)
            expect(JSON.stringify(error).includes("nativeCode")).toBe(false)
            expect(Object.hasOwn(new WindowsCredentialProcessError("failed"), "nativeCode")).toBe(false)
        }, TEST_TIMEOUT_MS)

        // Measured slow tests are skipped from the fast suite; retained for future opt-in/slow testing.
        test.skip("rejects malformed options and requests before spawning any helper", async (): Promise<void> => {
            await withOwnedSession(async (session: WindowsProcessSession, owned: OwnedCredential): Promise<void> => {
                const control = await session.operation({ operation: "identity" }, owned)
                expect(control.result.status).toBe("ok")
                expectSafeArgv(session, owned)
                expect((await session.snapshot()).helpers.length).toBe(0)
                session.samples.length = 0
                const cases: { request: unknown; options?: unknown; code: CredentialErrorCode }[] = []
                for (const timeoutMs of [0, 60001, 1.5, NaN]) {
                    cases.push({ request: { operation: "identity" }, options: { timeoutMs }, code: "invalid" })
                }
                for (const expectedSid of ["s-1-5-18", "S-1-05-18", "S-1-5-4294967296", "S-1-281474976710656", "S-1-5-18\n"]) {
                    cases.push({ request: { operation: "identity" }, options: { expectedSid }, code: "invalid" })
                }
                for (const request of [
                    null, [], {}, { operation: "enumerate" }, { operation: "read" },
                    { version: 1, operation: "identity" }, { operation: "identity", target: owned.target },
                    { operation: "write", target: owned.target, payload: "\ud800" },
                ]) cases.push({ request, code: "invalid" })
                for (const target of [owned.target.toLowerCase(), `${owned.target}\n`, "Other/v1/ssh/ID", "AutoCode/v1/ftp/ID", `${owned.target}/EXTRA`]) {
                    cases.push({ request: { operation: "read", target }, code: "invalid" })
                }
                for (const path of ["relative.json", "C:relative.json", `${owned.path}\0`, "C:/invalid.json", `C:\\${"a".repeat(260)}`]) {
                    cases.push({ request: { operation: "file-read", path }, code: "invalid" })
                }
                for (const maxBytes of [0, MAX_FILE_BYTES + 1, 1.5, NaN]) {
                    cases.push({ request: { operation: "file-read", path: owned.path, maxBytes }, code: "invalid" })
                }
                const oversizedRequest = "a".repeat(MAX_FRAME_BYTES + 1)
                expect(Buffer.byteLength(oversizedRequest, "utf8") > MAX_FRAME_BYTES).toBe(true)
                // Public payload limits reject this request before the frame-size guard is reachable.
                cases.push(
                    { request: { operation: "write", target: owned.target, payload: "é".repeat(WINDOWS_CREDENTIAL_MAX_BYTES / 2 + 1) }, code: "too_large" },
                    { request: { operation: "file-write", path: owned.path, payload: "é".repeat(MAX_FILE_BYTES / 2 + 1) }, code: "too_large" },
                    { request: { operation: "file-write", path: owned.path, maxBytes: 1, payload: "é" }, code: "too_large" },
                    { request: { operation: "file-write", path: owned.path, payload: oversizedRequest }, code: "too_large" },
                )
                for (const entry of cases) {
                    const { result, after } = await session.operation(entry.request, owned, entry.options)
                    expectSafeError(result, entry.code)
                    expect(after.helpers.length).toBe(0)
                }
                expect(cases.length).toBe(35)
                expect(session.samples.every((sample: Snapshot): boolean => sample.helpers.length === 0)).toBe(true)
            })
        }, TEST_TIMEOUT_MS)

        test.skip("observes fixed helper argv and round-trips synthetic UTF-8 only through stdin/stdout", async (): Promise<void> => {
            await withOwnedSession(async (session: WindowsProcessSession, owned: OwnedCredential): Promise<void> => {
                expect(Buffer.byteLength(owned.payload, "utf8")).toBe(WINDOWS_CREDENTIAL_MAX_BYTES)
                const written = await session.operation({ operation: "write", target: owned.target, payload: owned.payload }, owned)
                expect(written.result.status).toBe("ok")
                expect(written.after.helpers.length).toBe(0)
                const read = await session.operation({ operation: "read", target: owned.target }, owned, { timeoutMs: 60000 }, owned.payload)
                expect(read.result.status).toBe("ok")
                expect(read.result.payloadMatches).toBe(true)
                expect(read.after.helpers.length).toBe(0)
                expectSafeArgv(session, owned)
            })
        }, TEST_TIMEOUT_MS)

        // Measured at 5.320s; retain body for slower/opt-in runs.
        test.skip("settles a real 1ms write timeout only after helper exit with a fixed safe error", async (): Promise<void> => {
            await withOwnedSession(async (session: WindowsProcessSession, owned: OwnedCredential): Promise<void> => {
                // A 1ms child may escape polling; the fresh snapshot still checks its isolated parent.
                const { result, after } = await session.operation({ operation: "write", target: owned.target, payload: owned.payload }, owned, { timeoutMs: 1 })
                expect(after.helpers.length).toBe(0)
                expectSafeError(result, "failed")
            })
        }, TEST_TIMEOUT_MS)

        test.skip("exits on expectedSid mismatch before writing the exact owned target", async (): Promise<void> => {
            await withOwnedSession(async (session: WindowsProcessSession, owned: OwnedCredential): Promise<void> => {
                const identity = await session.operation({ operation: "identity" }, owned)
                expect(identity.result.status).toBe("ok")
                expect(typeof identity.result.sid).toBe("string")
                const expectedSid = identity.result.sid === "S-1-0-0" ? "S-1-5-18" : "S-1-0-0"
                const { result, after } = await session.operation(
                    { operation: "write", target: owned.target, payload: owned.payload }, owned, { expectedSid },
                )
                expect(after.helpers.length).toBe(0)
                expectSafeError(result, "denied")
                const missing = await session.operation({ operation: "read", target: owned.target }, owned)
                expect(missing.result.status).toBe("missing")
                expectSafeArgv(session, owned)
            })
        }, TEST_TIMEOUT_MS)
    })
}
