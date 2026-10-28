import { AsyncLocalStorage } from "node:async_hooks"
import { Buffer } from "node:buffer"
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithStdioTuple } from "node:child_process"
import { fileURLToPath } from "node:url"
import { CredentialError, WINDOWS_CREDENTIAL_MAX_BYTES, type CredentialErrorCode } from "./types"

export interface WindowsCredentialIdentity {
    sid: string
    account: string
}

export type WindowsCredentialRequest =
    | { operation: "identity" }
    | { operation: "enumerate"; kind: "ssh" | "db" | "rest" }
    | { operation: "read" | "delete"; target: string }
    | { operation: "write"; target: string; payload: string }
    | { operation: "file-read"; path: string; maxBytes?: number }
    | { operation: "file-write"; path: string; payload: string; maxBytes?: number }

export type WindowsCredentialResponse =
    | { version: 1; status: "ok"; payload?: string; identity?: WindowsCredentialIdentity; ids?: string[] }
    | { version: 1; status: "missing" | "unavailable"; nativeCode?: number }

export interface WindowsCredentialProcessOptions {
    timeoutMs?: number
    // expectedSid asserts the helper's current token; it never selects an interactive desktop account.
    expectedSid?: string
}

export class WindowsCredentialProcessError extends CredentialError {
    declare readonly nativeCode?: number
    declare readonly cleanupUnconfirmed?: true

    constructor(code: CredentialErrorCode, nativeCode?: number) {
        super(code)
        this.name = "WindowsCredentialProcessError"
        if (nativeCode !== undefined) {
            Object.defineProperty(this, "nativeCode", { value: nativeCode, enumerable: false })
        }
    }
}

export interface WindowsCredentialFailureDiagnostics {
    readonly reason: "operation-deadline" | "exit-drain-expired" | "close-without-eof" | "spawn-failure" | "process-failure" | "stdin-failure" | "stdout-failure" | "stderr-failure" | "response-failure" | "unknown"
    readonly elapsedMs: number | "unknown"
    readonly timeoutMs: number | "unknown"
    readonly exitObserved: boolean
    readonly closeObserved: boolean
    readonly stdinFinished: boolean
    readonly stdoutEnded: boolean
    readonly stderrEnded: boolean
    readonly exitCode: number | "unknown"
    readonly inputBytes: number
    readonly outputBytes: number
    readonly errorBytes: number
    readonly cleanupUnconfirmed: boolean
    readonly helperStage?: WindowsCredentialHelperStage
    readonly helperElapsedMs?: number
    readonly helperByteCount?: number
}

const FAILURE_DIAGNOSTICS = new WeakMap<object, Readonly<WindowsCredentialFailureDiagnostics>>()

const HELPER_STAGES = [
    "nativecompile-before", "nativecompile-after", "input-before", "input-newline", "input-await-EOF", "input-after",
    "parse-before", "parse-after", "tokenSID-before", "tokenSID-after", "identityName-before", "identityName-after",
    "dispatch-before", "dispatch-after", "response-before", "response-after", "cleanup-before", "cleanup-after",
    "parent-open-before", "parent-open-after", "parent-verify-before", "parent-verify-after",
    "file-open-before", "file-open-after", "file-read-before", "file-read-after",
] as const

export type WindowsCredentialHelperStage = (typeof HELPER_STAGES)[number]

export interface WindowsCredentialHelperTrace {
    readonly helperStage: WindowsCredentialHelperStage
    readonly helperElapsedMs: number
    readonly helperByteCount: number
}

const HELPER_TRACE_CONTEXT = new AsyncLocalStorage<(trace: Readonly<WindowsCredentialHelperTrace>) => void>()
const MAX_TRACE_RECORDS = 96
const MAX_TRACE_BYTES = 16384
const MAX_TRACE_LINE_BYTES = 160

// Internal test seam only; no credential options, environment, or user configuration enable tracing.
export function withWindowsCredentialHelperTrace<T>(observer: (trace: Readonly<WindowsCredentialHelperTrace>) => void, action: () => Promise<T>): Promise<T> {
    return HELPER_TRACE_CONTEXT.run(observer, action)
}

// Only errors actually rejected by this transport have registered, immutable diagnostics.
export function readWindowsCredentialFailureDiagnostics(error: unknown): Readonly<WindowsCredentialFailureDiagnostics> | undefined {
    return typeof error === "object" && error !== null ? FAILURE_DIAGNOSTICS.get(error) : undefined
}

const WINDOWS_ROOT = "C:\\Windows"
const POWERSHELL_PATH = `${WINDOWS_ROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
const MAX_FRAME_BYTES = 8388608
const MAX_FILE_BYTES = 1048576
const MAX_PATH_LENGTH = 259
const DEFAULT_TIMEOUT_MS = 15000
const MAX_TIMEOUT_MS = 60000
const DRAIN_GRACE_MS = 100
const REAP_GRACE_MS = 400
const ERROR_CODES: readonly CredentialErrorCode[] = [
    "locked", "denied", "invalid", "too_large", "failed", "missing", "incomplete", "unavailable", "unsupported",
]

// Internal transport seam; credential provider options never control process or clock dependencies.
export interface CredentialChildDependencies {
    spawn: (command: string, args: string[], options: SpawnOptionsWithStdioTuple<"pipe", "pipe", "pipe">) => ChildProcessWithoutNullStreams
    now: () => number
    setTimer: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>
    clearTimer: (timer: ReturnType<typeof setTimeout>) => void
}

const CHILD_DEPENDENCIES: CredentialChildDependencies = {
    spawn,
    now: (): number => performance.now(),
    setTimer: (callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> => setTimeout(callback, milliseconds),
    clearTimer: (timer: ReturnType<typeof setTimeout>): void => clearTimeout(timer),
}

function absorbLateChildError(): void { }

function discardLateChildOutput(chunk: Buffer): void {
    chunk.fill(0)
}

// Only the direct child is owned; a successful kill request does not confirm exit or descendant cleanup.
export function runBoundedCredentialChild<T>(
    start: () => ChildProcessWithoutNullStreams,
    input: Buffer,
    timeoutMs: number,
    output: {
        stdout: (chunk: Buffer) => void
        stderr: (chunk: Buffer) => void
        stdoutEnd?: () => void
        stderrEnd?: () => void
        helperTrace?: () => Readonly<WindowsCredentialHelperTrace> | undefined
        complete: (code: number | null, signal: NodeJS.Signals | null) => T
        clear: () => void
        ignoreInputError?: (error: unknown) => boolean
    },
    dependencies: Pick<CredentialChildDependencies, "now" | "setTimer" | "clearTimer"> = CHILD_DEPENDENCIES,
): Promise<T> {
    const startedAt = dependencies.now()
    const deadline = startedAt + timeoutMs
    // Input bytes measure the supplied frame, not helper consumption; finish is parent-side only.
    const inputBytes = input.byteLength
    return new Promise((resolve: (result: T) => void, reject: (error: WindowsCredentialProcessError) => void): void => {
        let child: ChildProcessWithoutNullStreams | undefined
        let operationTimer: ReturnType<typeof setTimeout> | undefined
        let drainTimer: ReturnType<typeof setTimeout> | undefined
        let reapTimer: ReturnType<typeof setTimeout> | undefined
        let failure: WindowsCredentialProcessError | undefined
        let failureReason: WindowsCredentialFailureDiagnostics["reason"] = "unknown"
        let settled = false
        let closed = false
        let exited = false
        let draining = false
        let drainDeadline: number | undefined
        let stdoutEnded = false
        let stderrEnded = false
        let stdinFinished = false
        let exitCode: number | "unknown" = "unknown"
        let outputBytes = 0
        let errorBytes = 0

        function reaped(): boolean {
            return closed || exited || typeof child?.exitCode === "number" || typeof child?.signalCode === "string"
        }

        function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
            if (timer !== undefined) dependencies.clearTimer(timer)
        }

        function destroyInput(): void {
            try { child?.stdin.destroy() } catch { }
            input.fill(0)
        }

        function destroyPipes(): void {
            destroyInput()
            try { child?.stdout.destroy() } catch { }
            try { child?.stderr.destroy() } catch { }
        }

        function killChild(): void {
            if (child === undefined || reaped()) return
            try { child.kill("SIGKILL") } catch { }
        }

        function finish(result?: T): void {
            if (settled) return
            settled = true
            clearTimer(operationTimer)
            clearTimer(drainTimer)
            clearTimer(reapTimer)
            let cleanupUnconfirmed = false
            if (child !== undefined) {
                // Static sinks absorb late errors/data without retaining request or response state.
                for (const emitter of [child, child.stdin, child.stdout, child.stderr]) emitter.on("error", absorbLateChildError)
                child.stdout.on("data", discardLateChildOutput)
                child.stderr.on("data", discardLateChildOutput)
                child.removeListener("error", onProcessFailure)
                child.removeListener("spawn", onSpawn)
                child.removeListener("exit", onExit)
                child.removeListener("close", onClose)
                child.stdin.removeListener("error", onInputError)
                child.stdin.removeListener("finish", onInputFinished)
                child.stdout.removeListener("error", onStdoutFailure)
                child.stderr.removeListener("error", onStderrFailure)
                child.stdout.removeListener("data", onStdout)
                child.stderr.removeListener("data", onStderr)
                child.stdout.removeListener("end", onStdoutEnd)
                child.stderr.removeListener("end", onStderrEnd)
                if (failure !== undefined && !reaped()) {
                    cleanupUnconfirmed = true
                    Object.defineProperty(failure, "cleanupUnconfirmed", { value: true, enumerable: false })
                    failure.message += " Direct child cleanup unconfirmed."
                    try { child.unref() } catch { }
                }
            }
            destroyPipes()
            const helperTrace = output.helperTrace?.()
            output.clear()
            if (failure !== undefined) {
                const elapsedMs = dependencies.now() - startedAt
                const observedCode = child?.exitCode
                if (typeof observedCode === "number" && Number.isInteger(observedCode)) exitCode = observedCode
                FAILURE_DIAGNOSTICS.set(failure, Object.freeze({
                    reason: failureReason,
                    elapsedMs: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : "unknown",
                    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : "unknown",
                    exitObserved: exited,
                    closeObserved: closed,
                    stdinFinished,
                    stdoutEnded,
                    stderrEnded,
                    exitCode,
                    inputBytes,
                    outputBytes,
                    errorBytes,
                    cleanupUnconfirmed,
                    ...helperTrace,
                }))
                reject(failure)
            }
            else resolve(result as T)
        }

        function startCleanup(): void {
            if (draining || settled) return
            draining = true
            drainDeadline = dependencies.now() + DRAIN_GRACE_MS
            drainTimer = dependencies.setTimer((): void => {
                fail(new WindowsCredentialProcessError("failed"), "exit-drain-expired")
                destroyPipes()
            }, DRAIN_GRACE_MS)
            reapTimer = dependencies.setTimer((): void => {
                fail(new WindowsCredentialProcessError("failed"), "exit-drain-expired")
                finish()
            }, DRAIN_GRACE_MS + REAP_GRACE_MS)
        }

        function fail(error: WindowsCredentialProcessError, reason: WindowsCredentialFailureDiagnostics["reason"]): void {
            if (settled || failure !== undefined) return
            failure = error
            failureReason = reason
            clearTimer(operationTimer)
            output.clear()
            startCleanup()
            destroyInput()
            killChild()
            if (closed) finish()
        }

        function beforeDeadline(): boolean {
            const now = dependencies.now()
            if (!settled && failure === undefined && (now >= deadline || (drainDeadline !== undefined && now >= drainDeadline))) {
                fail(new WindowsCredentialProcessError("failed"), now >= deadline ? "operation-deadline" : "exit-drain-expired")
            }
            return !settled && failure === undefined
        }

        function onDeadline(): void {
            if (beforeDeadline()) operationTimer = dependencies.setTimer(onDeadline, deadline - dependencies.now())
        }

        function onProcessFailure(): void {
            fail(new WindowsCredentialProcessError("failed"), "process-failure")
        }

        function onStdoutFailure(): void {
            fail(new WindowsCredentialProcessError("failed"), "stdout-failure")
        }

        function onStderrFailure(): void {
            fail(new WindowsCredentialProcessError("failed"), "stderr-failure")
        }

        function onInputError(error: unknown): void {
            if (!output.ignoreInputError?.(error)) fail(new WindowsCredentialProcessError("failed"), "stdin-failure")
        }

        function onInputFinished(): void {
            stdinFinished = true
            input.fill(0)
        }

        function onSpawn(): void {
            if (!beforeDeadline()) killChild()
        }

        function capture(chunk: Buffer, receive: (chunk: Buffer) => void, reason: "response-failure" | "stderr-failure"): void {
            try {
                if (beforeDeadline()) receive(chunk)
            } catch (error: unknown) {
                fail(error instanceof WindowsCredentialProcessError ? error : new WindowsCredentialProcessError("failed"), reason)
            } finally {
                chunk.fill(0)
            }
        }

        function onStdout(chunk: Buffer): void {
            outputBytes = Math.min(Number.MAX_SAFE_INTEGER, outputBytes + chunk.byteLength)
            capture(chunk, output.stdout, "response-failure")
        }

        function onStderr(chunk: Buffer): void {
            errorBytes = Math.min(Number.MAX_SAFE_INTEGER, errorBytes + chunk.byteLength)
            capture(chunk, output.stderr, "stderr-failure")
        }

        function onStdoutEnd(): void {
            stdoutEnded = true
            if (!beforeDeadline()) return
            try { output.stdoutEnd?.() } catch (error: unknown) {
                fail(error instanceof WindowsCredentialProcessError ? error : new WindowsCredentialProcessError("failed"), "response-failure")
            }
        }

        function onStderrEnd(): void {
            stderrEnded = true
            if (output.stderrEnd === undefined || !beforeDeadline()) return
            try { output.stderrEnd() } catch {
                fail(new WindowsCredentialProcessError("failed"), "stderr-failure")
            }
        }

        function onExit(code: number | null): void {
            exited = true
            if (typeof code === "number" && Number.isInteger(code)) exitCode = code
            if (beforeDeadline()) startCleanup()
        }

        function onClose(code: number | null, signal: NodeJS.Signals | null): void {
            closed = true
            if (typeof code === "number" && Number.isInteger(code)) exitCode = code
            if (!beforeDeadline()) {
                finish()
                return
            }
            if (!stdoutEnded || !stderrEnded) {
                fail(new WindowsCredentialProcessError("failed"), "close-without-eof")
                return
            }
            try {
                const result = output.complete(code, signal)
                if (beforeDeadline()) finish(result)
            } catch (error: unknown) {
                fail(error instanceof WindowsCredentialProcessError ? error : new WindowsCredentialProcessError("failed"), "response-failure")
            }
        }

        operationTimer = dependencies.setTimer(onDeadline, Math.max(0, deadline - dependencies.now()))
        try {
            child = start()
        } catch {
            failure = new WindowsCredentialProcessError("failed")
            failureReason = "spawn-failure"
            finish()
            return
        }
        child.on("error", onProcessFailure)
        child.stdin.on("error", onInputError)
        child.stdin.once("finish", onInputFinished)
        child.stdout.on("error", onStdoutFailure)
        child.stderr.on("error", onStderrFailure)
        child.once("spawn", onSpawn)
        child.once("exit", onExit)
        child.once("close", onClose)
        child.stdout.on("data", onStdout)
        child.stderr.on("data", onStderr)
        child.stdout.once("end", onStdoutEnd)
        child.stderr.once("end", onStderrEnd)
        try {
            if (beforeDeadline()) child.stdin.end(input)
        } catch {
            fail(new WindowsCredentialProcessError("failed"), "stdin-failure")
        }
    })
}

function readFields(value: unknown, allowed: readonly string[], code: CredentialErrorCode): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new WindowsCredentialProcessError(code)
    }
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
        throw new WindowsCredentialProcessError(code)
    }
    const fields: Record<string, unknown> = {}
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (typeof key !== "string" || !allowed.includes(key) || !descriptor?.enumerable || !("value" in descriptor)) {
            throw new WindowsCredentialProcessError(code)
        }
        fields[key] = descriptor.value
    }
    return fields
}

function isSid(value: unknown): value is string {
    if (typeof value !== "string" || value.length > 184) return false
    const parts = value.split("-")
    if (parts[0] !== "S" || parts[1] !== "1" || parts.length < 3 || parts.length > 18) return false
    return parts.slice(2).every((part: string, index: number): boolean => {
        if (/^(?:0|[1-9][0-9]*)$/.exec(part)?.[0] !== part) return false
        return Number(part) <= (index === 0 ? 281474976710655 : 4294967295)
    })
}

function requireString(value: unknown, code: CredentialErrorCode): string {
    if (typeof value !== "string" || !value.isWellFormed()) throw new WindowsCredentialProcessError(code)
    return value
}

function validateOptions(options: WindowsCredentialProcessOptions): WindowsCredentialProcessOptions & { timeoutMs: number } {
    const fields = readFields(options, ["timeoutMs", "expectedSid"], "invalid")
    const timeoutMs = fields.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : fields.timeoutMs
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
        throw new WindowsCredentialProcessError("invalid")
    }
    if (fields.expectedSid !== undefined && !isSid(fields.expectedSid)) throw new WindowsCredentialProcessError("invalid")
    return { timeoutMs, expectedSid: fields.expectedSid }
}

function validateRequest(request: WindowsCredentialRequest): WindowsCredentialRequest {
    const fields = readFields(request, ["operation", "kind", "target", "payload", "path", "maxBytes"], "invalid")
    const operation = fields.operation
    if (operation === "identity") {
        readFields(fields, ["operation"], "invalid")
        return { operation }
    }
    if (operation === "enumerate") {
        readFields(fields, ["operation", "kind"], "invalid")
        const kind = fields.kind
        if (kind !== "ssh" && kind !== "db" && kind !== "rest") {
            throw new WindowsCredentialProcessError("invalid")
        }
        return { operation, kind }
    }
    if (operation === "read" || operation === "write" || operation === "delete") {
        readFields(fields, operation === "write" ? ["operation", "target", "payload"] : ["operation", "target"], "invalid")
        const target = requireString(fields.target, "invalid")
        if (target.length > 32767 || /^AutoCode\/v1\/(?:ssh|db|rest)\/[A-Z0-9_]+$/.exec(target)?.[0] !== target) {
            throw new WindowsCredentialProcessError("invalid")
        }
        if (operation !== "write") return { operation, target }
        const payload = requireString(fields.payload, "invalid")
        if (Buffer.byteLength(payload, "utf8") > WINDOWS_CREDENTIAL_MAX_BYTES) throw new WindowsCredentialProcessError("too_large")
        return { operation, target, payload }
    }
    if (operation !== "file-read" && operation !== "file-write") throw new WindowsCredentialProcessError("invalid")
    readFields(fields, operation === "file-write" ? ["operation", "path", "maxBytes", "payload"] : ["operation", "path", "maxBytes"], "invalid")
    const path = requireString(fields.path, "invalid")
    if (path.length < 4 || path.length > MAX_PATH_LENGTH || !/^[A-Za-z]:\\/.test(path) || path.includes("\0")) {
        throw new WindowsCredentialProcessError("invalid")
    }
    const maxBytes = fields.maxBytes === undefined ? MAX_FILE_BYTES : fields.maxBytes
    if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FILE_BYTES) {
        throw new WindowsCredentialProcessError("invalid")
    }
    if (operation === "file-read") return { operation, path, maxBytes }
    const payload = requireString(fields.payload, "invalid")
    if (Buffer.byteLength(payload, "utf8") > maxBytes) throw new WindowsCredentialProcessError("too_large")
    return { operation, path, maxBytes, payload }
}

function createFrame(request: WindowsCredentialRequest, expectedSid: string | undefined): Buffer {
    const frame = `${JSON.stringify({ version: 1, ...request, expectedSid })}\n`
    if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) throw new WindowsCredentialProcessError("too_large")
    return Buffer.from(frame, "utf8")
}

function isSafeTempPath(value: string | undefined): value is string {
    if (value === undefined || value.length > MAX_PATH_LENGTH || !/^[A-Za-z]:\\/.test(value)) return false
    const tail = value.slice(3)
    if (/[\u0000-\u001f<>:"/|?*]/.test(tail)) return false
    const components = tail.split("\\")
    if (components.at(-1) === "") components.pop()
    return components.every((component: string): boolean => component !== "" && !/[. ]$/.test(component))
}

function processEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { SystemRoot: WINDOWS_ROOT, WINDIR: WINDOWS_ROOT }
    for (const key of ["TEMP", "TMP"]) {
        const value = process.env[key]
        if (isSafeTempPath(value)) environment[key] = value
    }
    return environment
}

function nativeCodeFrom(fields: Record<string, unknown>): number | undefined {
    if (!("nativeCode" in fields)) return undefined
    const value = fields.nativeCode
    if (typeof value !== "number" || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
        throw new WindowsCredentialProcessError("failed")
    }
    return value
}

function parseResponse(frame: string, request: WindowsCredentialRequest, expectedSid: string | undefined): WindowsCredentialResponse {
    if (frame.endsWith("\n")) {
        frame = frame.slice(0, -1)
        if (frame.endsWith("\r")) frame = frame.slice(0, -1)
    }
    if (!frame.startsWith("{") || !frame.endsWith("}")) throw new WindowsCredentialProcessError("failed")
    const value: unknown = JSON.parse(frame)
    const fields = readFields(value, ["version", "status", "payload", "identity", "ids", "code", "nativeCode"], "failed")
    if (fields.version !== 1) throw new WindowsCredentialProcessError("failed")
    if (fields.status === "missing" || fields.status === "unavailable") {
        readFields(fields, ["version", "status", "nativeCode"], "failed")
        const response: WindowsCredentialResponse = { version: 1, status: fields.status }
        const nativeCode = nativeCodeFrom(fields)
        if (nativeCode !== undefined) response.nativeCode = nativeCode
        return response
    }
    if (fields.status === "error") {
        readFields(fields, ["version", "status", "code", "nativeCode"], "failed")
        const code = ERROR_CODES.find((candidate: CredentialErrorCode): boolean => candidate === fields.code)
        if (code === undefined) throw new WindowsCredentialProcessError("failed")
        throw new WindowsCredentialProcessError(code, nativeCodeFrom(fields))
    }
    if (fields.status !== "ok") throw new WindowsCredentialProcessError("failed")
    if (request.operation === "identity") {
        readFields(fields, ["version", "status", "identity"], "failed")
        const identity = readFields(fields.identity, ["sid", "account"], "failed")
        if (!isSid(identity.sid) || (expectedSid !== undefined && identity.sid !== expectedSid)) {
            throw new WindowsCredentialProcessError("failed")
        }
        return { version: 1, status: "ok", identity: { sid: identity.sid, account: requireString(identity.account, "failed") } }
    }
    if (request.operation === "enumerate") {
        readFields(fields, ["version", "status", "ids"], "failed")
        if (!Array.isArray(fields.ids) || fields.ids.length > 4096
            || fields.ids.some((id: unknown): boolean => typeof id !== "string" || !/^[A-Z0-9_]+$/.test(id))) {
            throw new WindowsCredentialProcessError("failed")
        }
        return { version: 1, status: "ok", ids: fields.ids as string[] }
    }
    if (request.operation === "read" || request.operation === "file-read") {
        readFields(fields, ["version", "status", "payload"], "failed")
        const payload = requireString(fields.payload, "failed")
        const maxBytes = request.operation === "file-read" ? request.maxBytes ?? MAX_FILE_BYTES : WINDOWS_CREDENTIAL_MAX_BYTES
        if (Buffer.byteLength(payload, "utf8") > maxBytes) throw new WindowsCredentialProcessError("failed")
        return { version: 1, status: "ok", payload }
    }
    readFields(fields, ["version", "status"], "failed")
    return { version: 1, status: "ok" }
}

function createHelperTraceParser(observer: (trace: Readonly<WindowsCredentialHelperTrace>) => void): {
    receive: (chunk: Buffer) => void
    end: () => void
    last: () => Readonly<WindowsCredentialHelperTrace> | undefined
    clear: () => void
} {
    const line = Buffer.alloc(MAX_TRACE_LINE_BYTES)
    let length = 0
    let totalBytes = 0
    let records = 0
    let last: Readonly<WindowsCredentialHelperTrace> | undefined
    let notify: typeof observer | undefined = observer

    function finishLine(): void {
        const match = /^ACW_INTERNAL_STAGE_V1\|([A-Za-z-]+)\|((?:0|[1-9][0-9]{0,15}))\|((?:0|[1-9][0-9]{0,15}))$/.exec(line.toString("ascii", 0, length))
        line.fill(0)
        length = 0
        if (match === null || ++records > MAX_TRACE_RECORDS) throw new WindowsCredentialProcessError("failed")
        const helperStage = HELPER_STAGES.find((stage: WindowsCredentialHelperStage): boolean => stage === match[1])
        const helperElapsedMs = Number(match[2])
        const helperByteCount = Number(match[3])
        if (helperStage === undefined || !Number.isSafeInteger(helperElapsedMs) || !Number.isSafeInteger(helperByteCount)
            || helperByteCount > MAX_FRAME_BYTES + 1 || helperElapsedMs < (last?.helperElapsedMs ?? 0)
            || helperByteCount < (last?.helperByteCount ?? 0)) throw new WindowsCredentialProcessError("failed")
        last = Object.freeze({ helperStage, helperElapsedMs, helperByteCount })
        try { void Promise.resolve(notify?.(last)).catch(absorbLateChildError) } catch { }
    }

    return {
        receive(chunk: Buffer): void {
            totalBytes += chunk.byteLength
            if (totalBytes > MAX_TRACE_BYTES) throw new WindowsCredentialProcessError("failed")
            for (const byte of chunk) {
                if (byte > 126) throw new WindowsCredentialProcessError("failed")
                if (byte === 10) finishLine()
                else {
                    if (byte < 32 || length === line.byteLength) throw new WindowsCredentialProcessError("failed")
                    line[length++] = byte
                }
            }
        },
        end(): void {
            if (length !== 0) throw new WindowsCredentialProcessError("failed")
        },
        last: (): Readonly<WindowsCredentialHelperTrace> | undefined => last,
        clear(): void {
            line.fill(0)
            length = 0
            notify = undefined
        },
    }
}

function executeRequest(
    frame: Buffer,
    request: WindowsCredentialRequest,
    options: WindowsCredentialProcessOptions & { timeoutMs: number },
    dependencies: CredentialChildDependencies,
): Promise<WindowsCredentialResponse> {
    const helperPath = fileURLToPath(new URL("./windows-credentials.ps1", import.meta.url))
    const environment = processEnvironment()
    const observer = HELPER_TRACE_CONTEXT.getStore()
    const trace = observer === undefined ? undefined : createHelperTraceParser(observer)
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
    let response: WindowsCredentialResponse | undefined
    let totalBytes = 0
    let terminated = false
    let carriageReturn = false
    let parsed = false
    const fragments: string[] = []

    function countOutput(chunk: Buffer): void {
        totalBytes = Math.min(MAX_FRAME_BYTES + 1, totalBytes + chunk.byteLength)
        if (totalBytes > MAX_FRAME_BYTES) throw new WindowsCredentialProcessError("too_large")
    }

    function finishFrame(): void {
        const text = fragments.join("")
        fragments.length = 0
        parsed = true
        response = parseResponse(text, request, options.expectedSid)
    }

    function receiveText(text: string): void {
        if (text.length === 0) return
        if (parsed) throw new WindowsCredentialProcessError("failed")
        for (const character of text) {
            if (terminated || (carriageReturn && character !== "\n")) throw new WindowsCredentialProcessError("failed")
            carriageReturn = character === "\r"
            if (character === "\n") terminated = true
        }
        fragments.push(text)
        if (terminated) finishFrame()
    }

    return runBoundedCredentialChild((): ChildProcessWithoutNullStreams => {
        const { spawn } = dependencies
        let child: ChildProcessWithoutNullStreams
        const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helperPath]
        if (trace !== undefined) args.push("-AutoCodeInternalTrace")
        child = spawn(POWERSHELL_PATH, args, {
            cwd: `${WINDOWS_ROOT}\\System32`,
            env: environment,
            stdio: ["pipe", "pipe", "pipe"],
            detached: false,
            windowsHide: true,
            shell: false,
        })
        return child
    }, frame, options.timeoutMs, {
        stdout(chunk: Buffer): void {
            countOutput(chunk)
            receiveText(decoder.decode(chunk, { stream: true }))
        },
        stderr(chunk: Buffer): void {
            if (trace !== undefined) {
                trace.receive(chunk)
                return
            }
            countOutput(chunk)
            if (chunk.byteLength !== 0) throw new WindowsCredentialProcessError("failed")
        },
        stderrEnd: trace?.end,
        helperTrace: trace?.last,
        stdoutEnd(): void {
            receiveText(decoder.decode())
            if (carriageReturn) throw new WindowsCredentialProcessError("failed")
            if (!parsed) finishFrame()
        },
        complete(code: number | null, signal: NodeJS.Signals | null): WindowsCredentialResponse {
            if (code !== 0 || signal !== null || response === undefined) throw new WindowsCredentialProcessError("failed")
            return response
        },
        clear(): void {
            trace?.clear()
            fragments.length = 0
            response = undefined
            try { decoder.decode() } catch { }
        },
    }, dependencies)
}

export function createWindowsCredentialOperation(dependencies: CredentialChildDependencies = CHILD_DEPENDENCIES): typeof runWindowsCredentialOperation {
    return async (request: WindowsCredentialRequest, options: WindowsCredentialProcessOptions = {}): Promise<WindowsCredentialResponse> => {
        if (process.platform !== "win32") throw new WindowsCredentialProcessError("unsupported")
        let frame: Buffer | undefined
        try {
            const validatedOptions = validateOptions(options)
            const validatedRequest = validateRequest(request)
            frame = createFrame(validatedRequest, validatedOptions.expectedSid)
            // The helper's whole-stream trailing-byte check still requires EOF; transport deadlines bound missing EOF.
            return await executeRequest(frame, validatedRequest, validatedOptions, dependencies)
        } catch (error: unknown) {
            throw error instanceof WindowsCredentialProcessError ? error : new WindowsCredentialProcessError("failed")
        } finally {
            frame?.fill(0)
        }
    }
}

export async function runWindowsCredentialOperation(
    request: WindowsCredentialRequest,
    options: WindowsCredentialProcessOptions = {},
): Promise<WindowsCredentialResponse> {
    return createWindowsCredentialOperation()(request, options)
}
