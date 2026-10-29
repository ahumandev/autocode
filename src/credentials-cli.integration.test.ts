import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { lstat, mkdir, open, rm, symlink, unlink, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createPlaintextCredentialProvider } from "./credentials/plaintext"
import {
    CredentialError,
    MAX_CREDENTIAL_ENVELOPE_BYTES,
    WINDOWS_CREDENTIAL_MAX_BYTES,
    type CredentialErrorCode,
    type CredentialKind,
    type CredentialProfileInput,
    type CredentialReadResult,
} from "./credentials/types"
import {
    createWindowsCredentialProvider,
    deleteWindowsProfile,
    getWindowsCredentialIdentity,
    type WindowsCredentialIdentity,
} from "./credentials/windows"
import {
    readWindowsCredentialFailureDiagnostics,
    runBoundedCredentialChild,
    WindowsCredentialProcessError,
    type CredentialChildDependencies,
    type WindowsCredentialFailureDiagnostics,
    type WindowsCredentialHelperTrace,
    withWindowsCredentialHelperTrace,
} from "./credentials/windows-process"

const REPO = fileURLToPath(new URL("../", import.meta.url))
const SOURCE = join(REPO, "src", "credentials-cli.ts")
const TEMP_ROOT = tmpdir()
const WINDOWS_ROOT = "C:\\Windows"
const CHILD_TIMEOUT_MS = 20_000
const TEST_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 65_536
const ID_PREFIX = "AUTOCODE_CLI_INTEGRATION_"
const PROVIDERS = ["plaintext", "windows-credential-manager"] as const
const KINDS = ["ssh", "db", "rest"] as const
const METHODS = ["set", "import-env"] as const
const CONTEXT_WARNING = "Warning: Run under the actual OpenCode service logon context; matching SID alone does not prove the same logon session."
const PLAINTEXT_WARNING = "Warning: Plaintext credentials are stored unencrypted at the fixed global credential path."
const SAVED_MESSAGE = "Credential profile saved.\n"
const ERRORS = {
    usage: "Invalid credentials command or options. Use --help.",
    denied: "Credential access or identity assertion denied.",
    invalid: "Invalid credential profile or ID.",
    incomplete: "Credential profile is incomplete.",
    too_large: "Credential input exceeds the supported size limit.",
    tty: "Hidden input requires stdin and prompt output TTYs with working raw-mode support. Use --stdin instead.",
} as const
const IMPORT_MARKER = "credentials-cli-import-safe\n"
const IMPORT_SOURCE = `
import { join } from "node:path";
import { pathToFileURL } from "node:url";
await import(pathToFileURL(join(process.cwd(), "src", "credentials-cli.ts")).href);
if (process.exitCode !== undefined) throw new Error("CLI import changed exitCode");
queueMicrotask(() => process.stdout.write("credentials-cli-import-safe\\n"));
`

type WriteProvider = (typeof PROVIDERS)[number]
type ProvisionMethod = (typeof METHODS)[number]
type ChildResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
type Fixture = { root: string; provider: WriteProvider; kind: CredentialKind; id: string; sid: string }
type InputFailure = "malformed JSON" | "malformed UTF-8" | "incomplete profile" | "general input limit"
type OwnedOperationPhase = ProvisionMethod | "fixture" | "native-read" | "profile-cleanup" | "root-cleanup"
type OwnedRecord = {
    phase: string
    operationPhase?: OwnedOperationPhase
    elapsedMs?: number
    outcome?: "success" | "failure"
    failureRole?: "primary" | "cleanup"
    ownerPID?: number
    childPID?: number
    helperPIDUnavailable?: boolean
    provider?: WriteProvider
    kind?: CredentialKind
    id?: string
    nativeUUID?: string
    exactNativeTarget?: string
    plaintextStorePath?: string
    contextRecorded?: boolean
    contextMatches?: boolean
    cleanupVerified?: boolean
    ownershipMapClosed?: boolean
    nativeTargetsRemaining?: number
    rootRemoved?: boolean
    helperTrace?: readonly Readonly<WindowsCredentialHelperTrace>[]
    error?: {
        class: SafeErrorClass
        code: CredentialErrorCode | "unknown"
        nativeCode: number | "unknown"
        transport: Readonly<WindowsCredentialFailureDiagnostics> | "unknown"
    }
}
type OwnedRoot = {
    ownershipToken: string
    root: string
    journal: FileHandle
    journalQueue: Promise<void>
    pendingRecords: Promise<void>
    nativeTargets: Set<string>
    contextFingerprint?: string
    closedToChildRecords: boolean
}

const INTEGRATION_STAGES = [
    "identity", "temporary-root", "temporary-action", "temporary-cleanup", "native-read", "plaintext-read",
    "native-cleanup", "profile-action", "profile-cleanup", "plaintext-file-check", "junction-create", "junction-cleanup",
] as const
const INTEGRATION_PHASES = ["precheck", "test-body", "cleanup"] as const
const SAFE_CREDENTIAL_ERROR_CODES: readonly CredentialErrorCode[] = [
    "locked", "denied", "invalid", "unsafe_location", "too_large", "failed", "missing", "incomplete", "unavailable", "unsupported",
]
const MIN_NATIVE_CODE = -2147483648
const MAX_NATIVE_CODE = 4294967295
type IntegrationStage = (typeof INTEGRATION_STAGES)[number] | "unknown"
type IntegrationPhase = (typeof INTEGRATION_PHASES)[number] | "unknown"
type SafeErrorClass = "WindowsCredentialProcessError" | "CredentialError" | "Error" | "unknown"
interface SafeIntegrationSummary {
    stage: IntegrationStage
    phase: IntegrationPhase
    class: SafeErrorClass
    code: CredentialErrorCode | "unknown"
    nativeCode: number | "unknown"
    cleanupUnconfirmed: boolean | "unknown"
    transport: Readonly<WindowsCredentialFailureDiagnostics> | "unknown"
    elapsedMs: number | "unknown"
}

const integrationFailures = new WeakMap<object, { stage: IntegrationStage; summaries: readonly string[] }>()
const sentinels = new Set<string>()
let identityPromise: Promise<WindowsCredentialIdentity> | undefined

function sentinel(field: string): string {
    const value = `cli-${field}-${randomUUID()}-é漢🧪`
    sentinels.add(value)
    return value
}

function ownDataValue(value: unknown, key: string): unknown {
    if (typeof value !== "object" || value === null) return undefined
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
    } catch {
        return undefined
    }
}

function safeErrorClass(error: unknown): SafeErrorClass {
    try {
        if (error instanceof WindowsCredentialProcessError) return "WindowsCredentialProcessError"
        if (error instanceof CredentialError) return "CredentialError"
        if (error instanceof Error) return "Error"
    } catch { }
    return "unknown"
}

function integrationFailure(stage: IntegrationStage, summaries: readonly string[]): Error {
    const serialized = JSON.stringify({ failures: summaries.map((summary: string): unknown => JSON.parse(summary)) })
    const error = new Error(`Credential CLI integration failed (${stage}). ${serialized}`)
    integrationFailures.set(error, { stage, summaries: Object.freeze([...summaries]) })
    return error
}

async function safely<T>(
    stage: IntegrationStage,
    action: () => Promise<T>,
    phase: IntegrationPhase = "test-body",
    now: () => number = (): number => performance.now(),
): Promise<T> {
    const startedAt = now()
    try {
        return await action()
    } catch (error: unknown) {
        if (typeof error === "object" && error !== null && integrationFailures.has(error)) throw error
        const errorClass = safeErrorClass(error)
        const trustedCredential = errorClass === "WindowsCredentialProcessError" || errorClass === "CredentialError"
        const code = trustedCredential ? ownDataValue(error, "code") : undefined
        const nativeCode = errorClass === "WindowsCredentialProcessError" ? ownDataValue(error, "nativeCode") : undefined
        const cleanup = errorClass === "WindowsCredentialProcessError" ? ownDataValue(error, "cleanupUnconfirmed") : undefined
        const elapsedMs = now() - startedAt
        const summary: SafeIntegrationSummary = {
            stage: INTEGRATION_STAGES.find((candidate): boolean => candidate === stage) ?? "unknown",
            phase: INTEGRATION_PHASES.find((candidate): boolean => candidate === phase) ?? "unknown",
            class: errorClass,
            code: SAFE_CREDENTIAL_ERROR_CODES.find((candidate: CredentialErrorCode): boolean => candidate === code) ?? "unknown",
            nativeCode: typeof nativeCode === "number" && Number.isInteger(nativeCode) && nativeCode >= MIN_NATIVE_CODE && nativeCode <= MAX_NATIVE_CODE ? nativeCode : "unknown",
            cleanupUnconfirmed: typeof cleanup === "boolean" ? cleanup : "unknown",
            transport: readWindowsCredentialFailureDiagnostics(error) ?? "unknown",
            elapsedMs: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : "unknown",
        }
        throw integrationFailure(summary.stage, [JSON.stringify(summary)])
    }
}

async function withSafeCleanup(
    action: () => Promise<void>,
    cleanup: () => Promise<void>,
    actionStage: IntegrationStage,
    cleanupStage: IntegrationStage,
    now: () => number = (): number => performance.now(),
): Promise<void> {
    let actionFailure: Error | undefined
    try {
        await safely(actionStage, action, "test-body", now)
    } catch (error: unknown) {
        actionFailure = error as Error
    }
    try {
        await safely(cleanupStage, cleanup, "cleanup", now)
    } catch (error: unknown) {
        if (actionFailure === undefined) throw error
        const primary = integrationFailures.get(actionFailure)!
        const secondary = integrationFailures.get(error as Error)!
        throw integrationFailure(primary.stage, [...primary.summaries, ...secondary.summaries])
    }
    if (actionFailure !== undefined) throw actionFailure
}

const SAFE_HELPER_STAGES: readonly WindowsCredentialHelperTrace["helperStage"][] = [
    "nativecompile-before", "nativecompile-after", "input-before", "input-newline", "input-await-EOF", "input-after",
    "parse-before", "parse-after", "tokenSID-before", "tokenSID-after", "identityName-before", "identityName-after",
    "dispatch-before", "dispatch-after", "response-before", "response-after", "cleanup-before", "cleanup-after",
    "parent-open-before", "parent-open-after", "parent-verify-before", "parent-verify-after", "file-open-before",
    "file-open-after", "file-read-before", "file-read-after",
]
const MAX_OWNED_HELPER_TRACES = 8

const ownedRoots = new Map<string, OwnedRoot>()

function safeObservedError(error: unknown): NonNullable<OwnedRecord["error"]> {
    const errorClass = safeErrorClass(error)
    const trustedCredential = errorClass === "WindowsCredentialProcessError" || errorClass === "CredentialError"
    const code = trustedCredential ? ownDataValue(error, "code") : undefined
    const nativeCode = errorClass === "WindowsCredentialProcessError" ? ownDataValue(error, "nativeCode") : undefined
    return {
        class: errorClass,
        code: SAFE_CREDENTIAL_ERROR_CODES.find((candidate: CredentialErrorCode): boolean => candidate === code) ?? "unknown",
        nativeCode: typeof nativeCode === "number" && Number.isInteger(nativeCode)
            && nativeCode >= MIN_NATIVE_CODE && nativeCode <= MAX_NATIVE_CODE ? nativeCode : "unknown",
        transport: readWindowsCredentialFailureDiagnostics(error) ?? "unknown",
    }
}

function safeElapsed(startedAt: number): number {
    const elapsedMs = performance.now() - startedAt
    return Number.isFinite(elapsedMs) && elapsedMs >= 0 ? Math.floor(elapsedMs) : 0
}

function writeMetadataLine(line: string): Promise<void> {
    return new Promise((resolve, reject): void => {
        process.stderr.write(line, (error?: Error | null): void => {
            if (error !== undefined && error !== null) reject(error)
            else resolve()
        })
    })
}

async function appendOwnedRecord(
    owner: OwnedRoot,
    record: OwnedRecord,
    privateFields: Readonly<{ contextFingerprint?: string }> = {},
): Promise<void> {
    const publicRecord = { ...record, ownershipToken: owner.ownershipToken, ownerPID: process.pid, root: owner.root }
    const journalLine = `${JSON.stringify({ ...publicRecord, ...privateFields })}\n`
    const publicLine = `${JSON.stringify(publicRecord)}\n`
    const write = owner.journalQueue.then(async (): Promise<void> => {
        await owner.journal.writeFile(journalLine, "utf8")
        await owner.journal.sync()
        await writeMetadataLine(publicLine)
    })
    owner.journalQueue = write.catch((): void => { })
    await write
}

async function appendDiagnosticRecord(owner: OwnedRoot, record: OwnedRecord): Promise<void> {
    try {
        await appendOwnedRecord(owner, record)
    } catch {
        try {
            await writeMetadataLine(`${JSON.stringify({
                phase: "diagnostic-persistence-failed", ownershipToken: owner.ownershipToken,
                ownerPID: process.pid, root: owner.root,
            })}\n`)
        } catch { }
    }
}

function saltedContextFingerprint(ownershipToken: string, sid: string): string {
    return createHash("sha256").update(ownershipToken).update("\0").update(sid).digest("hex")
}

function matchesOwnedContext(owner: OwnedRoot, sid: string): boolean {
    return owner.contextFingerprint !== undefined
        && saltedContextFingerprint(owner.ownershipToken, sid) === owner.contextFingerprint
}

function retainOwnedHelperTrace(
    traces: Readonly<WindowsCredentialHelperTrace>[],
    trace: Readonly<WindowsCredentialHelperTrace>,
): void {
    const helperStage = ownDataValue(trace, "helperStage")
    const helperElapsedMs = ownDataValue(trace, "helperElapsedMs")
    const helperByteCount = ownDataValue(trace, "helperByteCount")
    const safeHelperStage = typeof helperStage === "string"
        ? SAFE_HELPER_STAGES.find((stage): boolean => stage === helperStage) : undefined
    if (safeHelperStage === undefined
        || typeof helperElapsedMs !== "number" || !Number.isSafeInteger(helperElapsedMs) || helperElapsedMs < 0
        || typeof helperByteCount !== "number" || !Number.isSafeInteger(helperByteCount) || helperByteCount < 0) return
    if (traces.length === MAX_OWNED_HELPER_TRACES) traces.shift()
    traces.push({ helperStage: safeHelperStage, helperElapsedMs, helperByteCount })
}

async function runOwnedOperation<T>(
    owner: OwnedRoot,
    operationPhase: OwnedOperationPhase,
    action: () => Promise<T>,
    failureRole: "primary" | "cleanup" = "primary",
): Promise<T> {
    const startedAt = performance.now()
    const helperTrace: Readonly<WindowsCredentialHelperTrace>[] = []
    try {
        const result = await withWindowsCredentialHelperTrace(
            (trace: Readonly<WindowsCredentialHelperTrace>): void => retainOwnedHelperTrace(helperTrace, trace), action,
        )
        await appendDiagnosticRecord(owner, {
            phase: "operation", operationPhase, elapsedMs: safeElapsed(startedAt), outcome: "success",
            helperPIDUnavailable: true, helperTrace,
        })
        return result
    } catch (error: unknown) {
        await appendDiagnosticRecord(owner, {
            phase: "operation", operationPhase, elapsedMs: safeElapsed(startedAt), outcome: "failure", failureRole,
            helperPIDUnavailable: true, error: safeObservedError(error), helperTrace,
        })
        throw error
    }
}

async function createOwnedRoot(): Promise<OwnedRoot> {
    const ownershipToken = randomUUID()
    const root = join(TEMP_ROOT, `autocode-cli-integration-${ownershipToken}`)
    const journalPath = join(TEMP_ROOT, `autocode-cli-integration-${ownershipToken}.jsonl`)
    let journal: FileHandle
    try {
        journal = await open(journalPath, "wx", 0o600)
    } catch {
        throw new Error("Credential CLI ownership journal initialization failed.")
    }
    const owner: OwnedRoot = {
        ownershipToken, root, journal, journalQueue: Promise.resolve(), pendingRecords: Promise.resolve(),
        nativeTargets: new Set<string>(), closedToChildRecords: false,
    }
    try {
        await appendOwnedRecord(owner, { phase: "root-registered" })
    } catch {
        await journal.close().catch((): void => { })
        throw new Error("Credential CLI root ownership registration failed.")
    }
    let rootCreated = false
    try {
        await mkdir(root)
        rootCreated = true
        await appendOwnedRecord(owner, { phase: "root-created" })
        return owner
    } catch {
        if (rootCreated) {
            try {
                await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
                await appendOwnedRecord(owner, { phase: "root-removed", rootRemoved: true })
            } catch { }
        }
        await journal.close().catch((): void => { })
        throw new Error("Credential CLI temporary root initialization failed.")
    }
}

async function flushOwnedRecords(owner: OwnedRoot): Promise<void> {
    for (;;) {
        const pendingRecords = owner.pendingRecords
        const journalQueue = owner.journalQueue
        await pendingRecords
        await journalQueue
        if (pendingRecords === owner.pendingRecords && journalQueue === owner.journalQueue) return
    }
}

function queueChildPID(owner: OwnedRoot, child: ChildProcessWithoutNullStreams): void {
    child.once("spawn", (): void => {
        const childPID = child.pid
        if (owner.closedToChildRecords || typeof childPID !== "number" || !Number.isSafeInteger(childPID) || childPID <= 0) return
        owner.pendingRecords = owner.pendingRecords.then(async (): Promise<void> => {
            await appendDiagnosticRecord(owner, { phase: "child-started", childPID })
        })
    })
}

function actualIdentity(): Promise<WindowsCredentialIdentity> {
    identityPromise ??= safely("identity", (): Promise<WindowsCredentialIdentity> =>
        getWindowsCredentialIdentity({ timeoutMs: CHILD_TIMEOUT_MS }), "precheck")
    return identityPromise
}

function childEnvironment(root: string, selected: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
    return {
        SystemRoot: WINDOWS_ROOT,
        WINDIR: WINDOWS_ROOT,
        TEMP: root,
        TMP: root,
        OPENCODE_CONFIG_DIR: root,
        ...selected,
    }
}

function spawnSource(
    root: string,
    args: readonly string[],
    input: Buffer = Buffer.alloc(0),
    selected: Readonly<Record<string, string>> = {},
    dependencies?: CredentialChildDependencies,
): Promise<ChildResult> {
    const owner = dependencies === undefined ? ownedRoots.get(root) : undefined
    const command = args[1]
    const operationPhase: OwnedOperationPhase = command === "set" || command === "import-env" ? command : "fixture"
    const payload = Buffer.from(input)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0

    function capture(chunks: Buffer[], chunk: Buffer): void {
        outputBytes = Math.min(MAX_OUTPUT_BYTES + 1, outputBytes + chunk.byteLength)
        if (outputBytes > MAX_OUTPUT_BYTES) throw new WindowsCredentialProcessError("too_large")
        chunks.push(Buffer.from(chunk))
    }

    function text(chunks: Buffer[]): string {
        const buffer = Buffer.concat(chunks)
        try { return buffer.toString("utf8") } finally { buffer.fill(0) }
    }

    const launch = (): Promise<ChildResult> => runBoundedCredentialChild((): ChildProcessWithoutNullStreams => {
        const spawnChild = dependencies?.spawn ?? spawn
        const child = spawnChild(process.execPath, [...args], {
            cwd: REPO,
            env: childEnvironment(root, selected),
            stdio: ["pipe", "pipe", "pipe"],
            shell: false,
            windowsHide: true,
        })
        if (owner !== undefined) queueChildPID(owner, child)
        return child
    }, payload, CHILD_TIMEOUT_MS, {
        stdout(chunk: Buffer): void { capture(stdout, chunk) },
        stderr(chunk: Buffer): void { capture(stderr, chunk) },
        complete(code: number | null, signal: NodeJS.Signals | null): ChildResult {
            return { code, signal, stdout: text(stdout), stderr: text(stderr) }
        },
        clear(): void {
            for (const chunk of [...stdout, ...stderr]) chunk.fill(0)
            stdout.length = 0
            stderr.length = 0
        },
        ignoreInputError(error: unknown): boolean {
            // Rejected commands may close stdin before a bounded payload finishes writing.
            const code = (error as NodeJS.ErrnoException | undefined)?.code
            return code === "EPIPE" || code === "ERR_STREAM_DESTROYED"
        },
    }, dependencies)
    if (owner === undefined) return launch()
    return (async (): Promise<ChildResult> => {
        await appendOwnedRecord(owner, { phase: "child-launch", operationPhase })
        return runOwnedOperation(owner, operationPhase, launch)
    })()
}

function expectPrivateOutput(result: ChildResult): void {
    for (const value of sentinels) {
        if (value.length === 0) continue
        const escaped = JSON.stringify(value).slice(1, -1)
        expect(result.stdout.includes(value) || result.stderr.includes(value)
            || result.stdout.includes(escaped) || result.stderr.includes(escaped)).toBe(false)
    }
}

async function runCli(
    root: string,
    args: readonly string[],
    input: Buffer = Buffer.alloc(0),
    selected: Readonly<Record<string, string>> = {},
): Promise<ChildResult> {
    const result = await spawnSource(root, [SOURCE, ...args], input, selected)
    expectPrivateOutput(result)
    return result
}

async function withTemporaryRoot(action: (root: string) => Promise<void>): Promise<void> {
    const owner = await safely("temporary-root", createOwnedRoot, "precheck")
    const root = owner.root
    ownedRoots.set(root, owner)
    await withSafeCleanup(
        (): Promise<void> => runOwnedOperation(owner, "fixture", (): Promise<void> => action(root)),
        async (): Promise<void> => {
            try {
                await flushOwnedRecords(owner)
                owner.closedToChildRecords = true
                await runOwnedOperation(owner, "root-cleanup", (): Promise<void> =>
                    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }), "cleanup")
                await appendOwnedRecord(owner, {
                    phase: "root-removed", rootRemoved: true, ownershipMapClosed: owner.nativeTargets.size === 0,
                    nativeTargetsRemaining: owner.nativeTargets.size,
                })
            } finally {
                ownedRoots.delete(root)
                await flushOwnedRecords(owner)
                await owner.journal.close()
            }
        },
        "temporary-action", "temporary-cleanup",
    )
}

async function readNative(fixture: Fixture, phase: IntegrationPhase = "test-body"): Promise<CredentialReadResult> {
    const action = (): Promise<CredentialReadResult> =>
        createWindowsCredentialProvider({ timeoutMs: CHILD_TIMEOUT_MS, expectedSid: fixture.sid })
            .read(fixture.kind, fixture.id)
    const owner = ownedRoots.get(fixture.root)
    return safely("native-read", (): Promise<CredentialReadResult> => owner === undefined ? action()
        : runOwnedOperation(owner, "native-read", action, phase === "cleanup" ? "cleanup" : "primary"), phase)
}

async function readPlaintext(fixture: Fixture): Promise<CredentialReadResult> {
    return safely("plaintext-read", (): Promise<CredentialReadResult> =>
        createPlaintextCredentialProvider({ globalConfigRoot: fixture.root, expectedSid: fixture.sid })
            .read(fixture.kind, fixture.id))
}

async function withProfile(
    provider: WriteProvider,
    kind: CredentialKind,
    action: (fixture: Fixture) => Promise<void>,
): Promise<void> {
    await withTemporaryRoot(async (root: string): Promise<void> => {
        const owner = ownedRoots.get(root)
        if (owner === undefined) throw new Error("Credential CLI fixture root ownership is unavailable.")
        const nativeUUID = randomUUID()
        const id = `${ID_PREFIX}${nativeUUID.replaceAll("-", "").toUpperCase()}`
        const exactNativeTarget = `AutoCode/v1/${kind}/${id}`
        await appendOwnedRecord(owner, {
            phase: "fixture-registered", provider, kind, id, nativeUUID, exactNativeTarget,
            ...(provider === "plaintext" ? { plaintextStorePath: join(root, "credentials", "profiles.json") } : {}),
        })
        owner.nativeTargets.add(exactNativeTarget)
        const identity = await runOwnedOperation(owner, "fixture", actualIdentity)
        const contextFingerprint = saltedContextFingerprint(owner.ownershipToken, identity.sid)
        owner.contextFingerprint = contextFingerprint
        const contextMatches = matchesOwnedContext(owner, identity.sid)
        await appendOwnedRecord(owner, {
            phase: "expected-context-recorded", contextRecorded: true, contextMatches,
        }, { contextFingerprint })
        const fixture = { root, provider, kind, id, sid: identity.sid }
        await withSafeCleanup(
            (): Promise<void> => runOwnedOperation(owner, "fixture", (): Promise<void> => action(fixture)),
            async (): Promise<void> => {
                await flushOwnedRecords(owner)
                await runOwnedOperation(owner, "profile-cleanup", async (): Promise<void> => {
                    await safely("native-cleanup", (): Promise<boolean> =>
                        deleteWindowsProfile(kind, fixture.id, { timeoutMs: CHILD_TIMEOUT_MS, expectedSid: identity.sid }), "cleanup")
                    expect((await readNative(fixture, "cleanup")).status === "missing").toBe(true)
                    await appendOwnedRecord(owner, {
                        phase: "cleanup-verified", provider, kind, id, nativeUUID, exactNativeTarget,
                        cleanupVerified: true,
                    })
                    owner.nativeTargets.delete(exactNativeTarget)
                    await appendOwnedRecord(owner, {
                        phase: "owned-map-closed", ownershipMapClosed: owner.nativeTargets.size === 0,
                        nativeTargetsRemaining: owner.nativeTargets.size,
                    })
                }, "cleanup")
            },
            "profile-action", "profile-cleanup",
        )
    })
}

function commandArgs(
    fixture: Fixture,
    method: ProvisionMethod,
    options: { expectedSid?: string; stdin?: boolean } = {},
): string[] {
    const key = fixture.kind === "ssh" ? fixture.id.toLowerCase().replaceAll("_", "-") : fixture.id
    const args = [method, "--provider", fixture.provider, "--kind", fixture.kind, "--key", key,
        "--expected-sid", options.expectedSid ?? fixture.sid]
    if (method === "set" && options.stdin !== false) args.push("--stdin")
    return args
}

function warnings(provider: WriteProvider): string {
    return `${CONTEXT_WARNING}\n${provider === "plaintext" ? `${PLAINTEXT_WARNING}\n` : ""}`
}

function expectSuccess(result: ChildResult, provider: WriteProvider): void {
    expect(result.code === 0 && result.signal === null).toBe(true)
    expect(result.stdout === SAVED_MESSAGE).toBe(true)
    expect(result.stderr === warnings(provider)).toBe(true)
}

function expectFailure(result: ChildResult, message: string, warningText: string): void {
    expect(result.code === 1 && result.signal === null).toBe(true)
    expect(result.stdout === "").toBe(true)
    expect(result.stderr === `${warningText}${message}\n`).toBe(true)
}

async function plaintextFileExists(root: string): Promise<boolean> {
    return safely("plaintext-file-check", async (): Promise<boolean> => {
        try {
            await lstat(join(root, "credentials", "profiles.json"))
            return true
        } catch (error: unknown) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
            throw new Error("Plaintext file check failed.")
        }
    })
}

async function expectNothingWritten(fixture: Fixture, phase: IntegrationPhase = "test-body"): Promise<void> {
    expect((await readNative(fixture, phase)).status === "missing").toBe(true)
    expect((await readPlaintext(fixture)).status === "missing").toBe(true)
    expect(await plaintextFileExists(fixture.root)).toBe(false)
}

function roundtripProfile(kind: CredentialKind, method: ProvisionMethod): CredentialProfileInput<CredentialKind> {
    const emptyOptionals = method === "import-env"
    if (kind === "ssh") {
        return {
            host: sentinel("host"),
            username: emptyOptionals ? "" : sentinel("ssh-username"),
            port: emptyOptionals ? "" : sentinel("port"),
            keyfile: sentinel("keyfile"),
            agent: emptyOptionals ? sentinel("agent") : "",
            password: sentinel("ssh-password"),
            keypass: emptyOptionals ? "" : sentinel("keypass"),
        }
    }
    if (kind === "db") {
        return {
            connection: sentinel("connection"),
            username: emptyOptionals ? "" : sentinel("db-username"),
            password: emptyOptionals ? sentinel("db-password") : "",
        }
    }
    return emptyOptionals
        ? { username: sentinel("rest-username"), password: "" }
        : { authorization: sentinel("authorization"), username: "", password: sentinel("rest-password") }
}

function selectedEnvironment(fixture: Fixture, profile: CredentialProfileInput<CredentialKind>): Record<string, string> {
    const environment: Record<string, string> = {}
    for (const [field, value] of Object.entries(profile)) {
        environment[`AUTOCODE_${fixture.kind.toUpperCase()}_${fixture.id}_${field.toUpperCase()}`] = value
    }
    return environment
}

function profilesEqual(actual: unknown, expected: CredentialProfileInput<CredentialKind>): boolean {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false
    const entries = Object.entries(expected)
    return Object.keys(actual).length === entries.length
        && entries.every(([key, value]: [string, string]): boolean =>
            Object.hasOwn(actual, key) && Object.getOwnPropertyDescriptor(actual, key)?.value === value)
}

function failureInput(scenario: InputFailure): Buffer {
    const value = sentinel("rejected-input")
    switch (scenario) {
        case "malformed JSON":
            return Buffer.from(`{"authorization":${JSON.stringify(value)}`, "utf8")
        case "malformed UTF-8":
            return Buffer.concat([Buffer.from(`{"authorization":"${value}`, "utf8"), Buffer.from([0xc3, 0x28]), Buffer.from('"}')])
        case "incomplete profile":
            return Buffer.from(JSON.stringify({ password: value }), "utf8")
        case "general input limit":
            return Buffer.from(JSON.stringify({ authorization: value + "x".repeat(MAX_CREDENTIAL_ENVELOPE_BYTES) }), "utf8")
    }
}

const CLI_LIFECYCLE_DRAIN_MS = 100
const CLI_LIFECYCLE_GRACE_MS = 500

class CliLifecycleClock {
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

class CliLifecycleStream extends EventEmitter {
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

class CliLifecycleChild extends EventEmitter {
    readonly stdin = new CliLifecycleStream()
    readonly stdout = new CliLifecycleStream()
    readonly stderr = new CliLifecycleStream()
    exitCode: number | null = null
    signalCode: NodeJS.Signals | null = null
    killResult: boolean | "throw" = true
    readonly kills: NodeJS.Signals[] = []
    unrefs = 0

    kill(signal: NodeJS.Signals): boolean {
        this.kills.push(signal)
        if (this.killResult === "throw") throw new Error("synthetic-private-cli-error")
        return this.killResult
    }

    unref(): void {
        this.unrefs++
    }
}

interface CliLifecycleSettlement {
    count: number
    value?: ChildResult
    error?: unknown
}

function boundedCli(killResult: boolean | "throw" = true, spawnThrows = false): {
    clock: CliLifecycleClock
    child: CliLifecycleChild
    settlement: CliLifecycleSettlement
    input: Buffer
    launch: { args?: Parameters<CredentialChildDependencies["spawn"]> }
    unrelated: () => void
} {
    const clock = new CliLifecycleClock()
    const child = new CliLifecycleChild()
    child.killResult = killResult
    const launch: { args?: Parameters<CredentialChildDependencies["spawn"]> } = {}
    const unrelated = (): void => { }
    child.on("exit", unrelated)
    child.stdin.on("error", unrelated)
    const dependencies: CredentialChildDependencies = {
        spawn(...args: Parameters<CredentialChildDependencies["spawn"]>): ChildProcessWithoutNullStreams {
            launch.args = args
            if (spawnThrows) throw new Error("synthetic-private-cli-error")
            return child as unknown as ChildProcessWithoutNullStreams
        },
        now: (): number => clock.time,
        setTimer: (callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> => clock.setTimer(callback, milliseconds),
        clearTimer: (timer: ReturnType<typeof setTimeout>): void => clock.clearTimer(timer),
    }
    const input = Buffer.from("synthetic-cli-input")
    const settlement: CliLifecycleSettlement = { count: 0 }
    void spawnSource(TEMP_ROOT, [SOURCE, "--help"], input, { AUTOCODE_TEST_SELECTED: "synthetic-selected" }, dependencies).then(
        (value: ChildResult): void => { settlement.count++; settlement.value = value },
        (error: unknown): void => { settlement.count++; settlement.error = error },
    )
    return { clock, child, settlement, input, launch, unrelated }
}

async function flushCliLifecycle(): Promise<void> {
    for (let index = 0; index < 4; index++) await Promise.resolve()
}

function expectCliLifecycleFailure(settlement: CliLifecycleSettlement, cleanupUnconfirmed = false, code: "failed" | "too_large" = "failed"): void {
    expect(settlement.count).toBe(1)
    expect(settlement.value).toBeUndefined()
    expect(settlement.error).toBeInstanceOf(WindowsCredentialProcessError)
    const error = settlement.error as WindowsCredentialProcessError
    expect(error.code).toBe(code)
    expect(error.message).toBe(`${code === "failed" ? "Credential read failed." : "Credential exceeds the supported size limit."}${cleanupUnconfirmed ? " Direct child cleanup unconfirmed." : ""}`)
    expect(error.cleanupUnconfirmed).toBe(cleanupUnconfirmed ? true : undefined)
    expect(Object.hasOwn(error, "cause")).toBe(false)
    const text = `${error.stack}\n${JSON.stringify(error)}`
    for (const forbidden of ["synthetic-private-cli-error", "synthetic-cli-input", "synthetic-selected"]) expect(text).not.toContain(forbidden)
}

function expectCliLifecycleReleased(fixture: ReturnType<typeof boundedCli>): void {
    const { child, clock, input, unrelated } = fixture
    expect(clock.timers.size).toBe(0)
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
        expect(stream.destroyed).toBe(true)
        expect(stream.listenerCount("end")).toBe(0)
        expect(stream.listenerCount("finish")).toBe(0)
    }
    expect(child.stdin.frame?.every((byte: number): boolean => byte === 0)).toBe(true)
    expect(input.toString()).toBe("synthetic-cli-input")
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

function expectSafeIntegrationFailure(error: unknown, stage: IntegrationStage, secret: string): SafeIntegrationSummary[] {
    expect(error).toBeInstanceOf(Error)
    const safe = error as Error
    expect(integrationFailures.has(safe)).toBe(true)
    const prefix = `Credential CLI integration failed (${stage}). `
    expect(safe.message.startsWith(prefix)).toBe(true)
    expect(`${safe.message}\n${safe.stack}\n${JSON.stringify(safe)}`).not.toContain(secret)
    expect(Object.hasOwn(safe, "cause")).toBe(false)
    expect(Object.keys(safe)).toEqual([])
    const parsed = JSON.parse(safe.message.slice(prefix.length)) as { failures: SafeIntegrationSummary[] }
    expect(Object.keys(parsed)).toEqual(["failures"])
    for (const summary of parsed.failures) {
        expect(Object.keys(summary)).toEqual(["stage", "phase", "class", "code", "nativeCode", "cleanupUnconfirmed", "transport", "elapsedMs"])
    }
    return parsed.failures
}

describe("native-read safe diagnostics", (): void => {
    const secret = "synthetic-native-read-secret-sentinel"

    test("retains trusted class, code, native code and phase without hostile message, cause or stack", async (): Promise<void> => {
        const clock = new CliLifecycleClock()
        const hostile = new WindowsCredentialProcessError("denied", 5)
        Object.defineProperties(hostile, {
            message: { value: secret },
            name: { value: secret },
            stack: { value: secret },
            cause: { value: { message: secret } },
            constructor: { value: { name: secret } },
            cleanupUnconfirmed: { value: true },
            arbitrary: { value: secret },
            toJSON: { value: (): never => { throw new Error(secret) } },
        })
        const error = await safely("native-read", async (): Promise<never> => {
            clock.advance(7)
            throw hostile
        }, "test-body", (): number => clock.time).catch((error: unknown): unknown => error)
        expect(expectSafeIntegrationFailure(error, "native-read", secret)).toEqual([{
            stage: "native-read", phase: "test-body", class: "WindowsCredentialProcessError", code: "denied",
            nativeCode: 5, cleanupUnconfirmed: true, transport: "unknown", elapsedMs: 7,
        }])
    })

    test("never invokes error getters or trusts attached transport fields", async (): Promise<void> => {
        let reads = 0
        const hostile = new WindowsCredentialProcessError("failed")
        for (const key of ["message", "name", "stack", "cause", "constructor", "code", "nativeCode", "cleanupUnconfirmed", "transport", "toJSON"]) {
            Object.defineProperty(hostile, key, {
                configurable: true,
                get(): never { reads++; throw new Error(secret) },
            })
        }
        const error = await safely("native-read", async (): Promise<never> => { throw hostile }, "precheck", (): number => 0)
            .catch((error: unknown): unknown => error)
        expect(reads).toBe(0)
        expect(readWindowsCredentialFailureDiagnostics(hostile)).toBeUndefined()
        expect(expectSafeIntegrationFailure(error, "native-read", secret)).toEqual([{
            stage: "native-read", phase: "precheck", class: "WindowsCredentialProcessError", code: "unknown",
            nativeCode: "unknown", cleanupUnconfirmed: "unknown", transport: "unknown", elapsedMs: 0,
        }])
        expect(reads).toBe(0)
    })

    test("maps arbitrary code and nativeCode strings to fixed unknown", async (): Promise<void> => {
        const hostile = new WindowsCredentialProcessError("failed")
        Object.defineProperties(hostile, {
            code: { value: secret },
            nativeCode: { value: secret },
            cleanupUnconfirmed: { value: secret },
            transport: { value: { reason: secret } },
        })
        const error = await safely("native-read", async (): Promise<never> => { throw hostile }, "cleanup", (): number => 0)
            .catch((error: unknown): unknown => error)
        expect(expectSafeIntegrationFailure(error, "native-read", secret)).toEqual([{
            stage: "native-read", phase: "cleanup", class: "WindowsCredentialProcessError", code: "unknown",
            nativeCode: "unknown", cleanupUnconfirmed: "unknown", transport: "unknown", elapsedMs: 0,
        }])
    })

    test("maps unrecognized phase, stage and elapsed values to fixed unknown", async (): Promise<void> => {
        const error = await safely(secret as IntegrationStage, async (): Promise<never> => {
            throw new CredentialError("denied")
        }, secret as IntegrationPhase, (): number => NaN).catch((error: unknown): unknown => error)
        expect(expectSafeIntegrationFailure(error, "unknown", secret)).toEqual([{
            stage: "unknown", phase: "unknown", class: "CredentialError", code: "denied",
            nativeCode: "unknown", cleanupUnconfirmed: "unknown", transport: "unknown", elapsedMs: "unknown",
        }])
    })

    test("ignores forged class names and credential fields on untrusted objects", async (): Promise<void> => {
        const forged = Object.assign(new Error(secret), { name: "WindowsCredentialProcessError", code: "denied", nativeCode: 5, cleanupUnconfirmed: true })
        for (const [hostile, expectedClass] of [
            [forged, "Error"],
            [{ name: "WindowsCredentialProcessError", code: "denied", nativeCode: 5, cleanupUnconfirmed: true, cause: secret }, "unknown"],
            [secret, "unknown"],
        ] as const) {
            const error = await safely("native-read", async (): Promise<never> => { throw hostile }, "precheck", (): number => 0)
                .catch((error: unknown): unknown => error)
            expect(expectSafeIntegrationFailure(error, "native-read", secret)).toEqual([{
                stage: "native-read", phase: "precheck", class: expectedClass, code: "unknown",
                nativeCode: "unknown", cleanupUnconfirmed: "unknown", transport: "unknown", elapsedMs: 0,
            }])
        }
    })

    test("maps only explicit CredentialErrorCode constants from trusted errors", async (): Promise<void> => {
        for (const code of SAFE_CREDENTIAL_ERROR_CODES) {
            const hostile = new CredentialError(code)
            Object.defineProperty(hostile, "nativeCode", { value: 5 })
            const error = await safely("native-read", async (): Promise<never> => { throw hostile }, "test-body", (): number => 0)
                .catch((error: unknown): unknown => error)
            expect(expectSafeIntegrationFailure(error, "native-read", secret)).toEqual([{
                stage: "native-read", phase: "test-body", class: "CredentialError", code,
                nativeCode: "unknown", cleanupUnconfirmed: "unknown", transport: "unknown", elapsedMs: 0,
            }])
        }
    })

    test("accepts only own finite int32 or uint32 native codes", async (): Promise<void> => {
        for (const [nativeCode, expected] of [
            [MIN_NATIVE_CODE, MIN_NATIVE_CODE], [0, 0], [MAX_NATIVE_CODE, MAX_NATIVE_CODE],
            [MIN_NATIVE_CODE - 1, "unknown"], [MAX_NATIVE_CODE + 1, "unknown"],
            [1.5, "unknown"], [NaN, "unknown"], [Infinity, "unknown"], [secret, "unknown"],
        ] as const) {
            const hostile = new WindowsCredentialProcessError("failed")
            Object.defineProperty(hostile, "nativeCode", { value: nativeCode })
            const error = await safely("native-read", async (): Promise<never> => { throw hostile }, "test-body", (): number => 0)
                .catch((error: unknown): unknown => error)
            const summaries = expectSafeIntegrationFailure(error, "native-read", secret)
            expect(summaries[0]!.nativeCode).toBe(expected)
        }
        const inherited = Object.create(new WindowsCredentialProcessError("denied", 5)) as WindowsCredentialProcessError
        const error = await safely("native-read", async (): Promise<never> => { throw inherited }, "cleanup", (): number => 0)
            .catch((error: unknown): unknown => error)
        expect(expectSafeIntegrationFailure(error, "native-read", secret)[0]).toMatchObject({
            class: "WindowsCredentialProcessError", code: "unknown", nativeCode: "unknown", phase: "cleanup",
        })
    })

    test("preserves both action and cleanup read failures through outer temporary cleanup", async (): Promise<void> => {
        const clock = new CliLifecycleClock()
        const primary = new WindowsCredentialProcessError("denied", 5)
        const secondary = new CredentialError("locked")
        Object.defineProperty(primary, "message", { value: secret })
        Object.defineProperty(secondary, "cause", { value: secret })
        let cleanupCalls = 0
        const error = await withSafeCleanup(
            (): Promise<void> => withSafeCleanup(
                (): Promise<void> => safely("native-read", async (): Promise<never> => {
                    clock.advance(7)
                    throw primary
                }, "test-body", (): number => clock.time),
                (): Promise<void> => safely("native-read", async (): Promise<never> => {
                    cleanupCalls++
                    clock.advance(3)
                    throw secondary
                }, "cleanup", (): number => clock.time),
                "profile-action", "profile-cleanup", (): number => clock.time,
            ),
            async (): Promise<void> => { cleanupCalls++ },
            "temporary-action", "temporary-cleanup", (): number => clock.time,
        ).catch((error: unknown): unknown => error)
        expect(cleanupCalls).toBe(2)
        expect(expectSafeIntegrationFailure(error, "native-read", secret)).toEqual([
            {
                stage: "native-read", phase: "test-body", class: "WindowsCredentialProcessError", code: "denied",
                nativeCode: 5, cleanupUnconfirmed: "unknown", transport: "unknown", elapsedMs: 7,
            },
            {
                stage: "native-read", phase: "cleanup", class: "CredentialError", code: "locked",
                nativeCode: "unknown", cleanupUnconfirmed: "unknown", transport: "unknown", elapsedMs: 3,
            },
        ])
    })

    test("retains only registered transport snapshots with deterministic lifecycle elapsed time", async (): Promise<void> => {
        const fixture = boundedCli()
        const error = await safely("native-read", async (): Promise<never> => {
            fixture.clock.advance(CHILD_TIMEOUT_MS + CLI_LIFECYCLE_GRACE_MS)
            await flushCliLifecycle()
            throw fixture.settlement.error
        }, "cleanup", (): number => fixture.clock.time).catch((error: unknown): unknown => error)
        const transport = readWindowsCredentialFailureDiagnostics(fixture.settlement.error)
        expect(expectSafeIntegrationFailure(error, "native-read", secret)).toEqual([{
            stage: "native-read", phase: "cleanup", class: "WindowsCredentialProcessError", code: "failed",
            nativeCode: "unknown", cleanupUnconfirmed: true, transport: transport!, elapsedMs: CHILD_TIMEOUT_MS + CLI_LIFECYCLE_GRACE_MS,
        }])
        expect(transport).toMatchObject({ reason: "operation-deadline", closeObserved: false, exitObserved: false, stdinFinished: false })
        expectCliLifecycleReleased(fixture)
    })

    test("keeps action and native-delete failures when temporary cleanup also fails", async (): Promise<void> => {
        const error = await withSafeCleanup(
            (): Promise<void> => withSafeCleanup(
                async (): Promise<void> => { throw new Error(secret) },
                (): Promise<void> => safely("native-cleanup", async (): Promise<never> => {
                    throw new WindowsCredentialProcessError("denied", 5)
                }, "cleanup", (): number => 0),
                "profile-action", "profile-cleanup", (): number => 0,
            ),
            async (): Promise<void> => { throw new Error(secret) },
            "temporary-action", "temporary-cleanup", (): number => 0,
        ).catch((error: unknown): unknown => error)
        expect(expectSafeIntegrationFailure(error, "profile-action", secret)).toEqual([
            {
                stage: "profile-action", phase: "test-body", class: "Error", code: "unknown",
                nativeCode: "unknown", cleanupUnconfirmed: "unknown", transport: "unknown", elapsedMs: 0,
            },
            {
                stage: "native-cleanup", phase: "cleanup", class: "WindowsCredentialProcessError", code: "denied",
                nativeCode: 5, cleanupUnconfirmed: "unknown", transport: "unknown", elapsedMs: 0,
            },
            {
                stage: "temporary-cleanup", phase: "cleanup", class: "Error", code: "unknown",
                nativeCode: "unknown", cleanupUnconfirmed: "unknown", transport: "unknown", elapsedMs: 0,
            },
        ])
    })

    test("keeps successful wrapper and cleanup actions unchanged", async (): Promise<void> => {
        const order: string[] = []
        const result = await safely("native-read", async (): Promise<number> => 17, "precheck", (): number => 0)
        expect(result).toBe(17)
        await withSafeCleanup(
            async (): Promise<void> => { order.push("action") },
            async (): Promise<void> => { order.push("cleanup") },
            "profile-action", "profile-cleanup", (): number => 0,
        )
        expect(order).toEqual(["action", "cleanup"])
    })
})

describe.skipIf(process.platform !== "win32")("bounded credential CLI child lifecycle", (): void => {
    test("settles at 20s plus 500ms without close or EOF after killing the direct child", async (): Promise<void> => {
        const fixture = boundedCli()
        const { child, clock, settlement } = fixture
        child.stdout.emit("data", Buffer.from(SAVED_MESSAGE))
        clock.advance(CHILD_TIMEOUT_MS)
        await flushCliLifecycle()
        expect(child.kills).toEqual(["SIGKILL"])
        expect(child.stdin.destroyed).toBe(true)
        expect(child.stdin.frame?.every((byte: number): boolean => byte === 0)).toBe(true)
        expect(settlement.count).toBe(0)
        clock.advance(CLI_LIFECYCLE_DRAIN_MS - 1)
        expect(child.stdout.destroyed).toBe(false)
        clock.advance(1)
        expect(child.stdout.destroyed && child.stderr.destroyed).toBe(true)
        clock.advance(CLI_LIFECYCLE_GRACE_MS - CLI_LIFECYCLE_DRAIN_MS - 1)
        await flushCliLifecycle()
        expect(settlement.count).toBe(0)
        // The previous spawnSource promise stays pending here forever without a close event.
        clock.advance(1)
        await flushCliLifecycle()
        expect(clock.time).toBe(CHILD_TIMEOUT_MS + CLI_LIFECYCLE_GRACE_MS)
        expectCliLifecycleFailure(settlement, true)
        expect(child.unrefs).toBe(1)
        expectCliLifecycleReleased(fixture)
    })

    for (const validOutput of [false, true]) {
        test(`bounds exit without output-end or close, valid output=${validOutput}`, async (): Promise<void> => {
            const fixture = boundedCli()
            if (validOutput) fixture.child.stdout.emit("data", Buffer.from(SAVED_MESSAGE))
            fixture.clock.advance(10)
            fixture.child.exitCode = 0
            fixture.child.emit("exit", 0, null)
            fixture.clock.advance(CLI_LIFECYCLE_GRACE_MS - 1)
            await flushCliLifecycle()
            expect(fixture.settlement.count).toBe(0)
            fixture.clock.advance(1)
            await flushCliLifecycle()
            expect(fixture.clock.time).toBe(10 + CLI_LIFECYCLE_GRACE_MS)
            expectCliLifecycleFailure(fixture.settlement)
            expect(fixture.child.kills).toEqual([])
            expect(fixture.child.unrefs).toBe(0)
            expectCliLifecycleReleased(fixture)
        })
    }

    test("preserves complete stdout, stderr, nonzero command results and restricted launch settings", async (): Promise<void> => {
        const fixture = boundedCli()
        const { child, settlement, launch } = fixture
        const stdout = Buffer.from("synthetic-cli-output\n")
        const stderr = Buffer.from(`${ERRORS.usage}\n`)
        child.stdout.emit("data", stdout)
        child.stderr.emit("data", stderr)
        child.stdin.emit("finish")
        child.stdout.emit("end")
        child.stderr.emit("end")
        child.exitCode = 1
        child.emit("exit", 1, null)
        child.emit("close", 1, null)
        await flushCliLifecycle()
        expect(settlement.count).toBe(1)
        expect(settlement.error).toBeUndefined()
        expect(settlement.value).toEqual({ code: 1, signal: null, stdout: "synthetic-cli-output\n", stderr: `${ERRORS.usage}\n` })
        expect(stdout.every((byte: number): boolean => byte === 0)).toBe(true)
        expect(stderr.every((byte: number): boolean => byte === 0)).toBe(true)
        expect(child.kills).toEqual([])
        expect(launch.args?.[0]).toBe(process.execPath)
        expect(launch.args?.[1]).toEqual([SOURCE, "--help"])
        expect(launch.args?.[2]).toEqual({
            cwd: REPO,
            env: { SystemRoot: WINDOWS_ROOT, WINDIR: WINDOWS_ROOT, TEMP: TEMP_ROOT, TMP: TEMP_ROOT, OPENCODE_CONFIG_DIR: TEMP_ROOT, AUTOCODE_TEST_SELECTED: "synthetic-selected" },
            stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
        })
        expectCliLifecycleReleased(fixture)
    })

    test("accepts full successful close and keeps expected rejected-command stdin errors harmless", async (): Promise<void> => {
        const fixture = boundedCli()
        for (const code of ["EPIPE", "ERR_STREAM_DESTROYED"]) fixture.child.stdin.emit("error", Object.assign(new Error("synthetic-private-cli-error"), { code }))
        fixture.child.exitCode = 0
        fixture.child.emit("exit", 0, null)
        fixture.clock.advance(CLI_LIFECYCLE_DRAIN_MS - 1)
        fixture.child.stdout.emit("data", Buffer.from(SAVED_MESSAGE))
        fixture.child.stdout.emit("end")
        fixture.child.stderr.emit("end")
        fixture.child.emit("close", 0, null)
        await flushCliLifecycle()
        expect(fixture.settlement.count).toBe(1)
        expect(fixture.settlement.error).toBeUndefined()
        expect(fixture.settlement.value).toEqual({ code: 0, signal: null, stdout: SAVED_MESSAGE, stderr: "" })
        expectCliLifecycleReleased(fixture)
    })

    test("rejects unended output and close at monotonic operation or drain deadlines without waiting for timers", async (): Promise<void> => {
        for (const state of ["unended", "operation deadline", "drain deadline"]) {
            const fixture = boundedCli()
            fixture.child.stdout.emit("data", Buffer.from(SAVED_MESSAGE))
            if (state !== "unended") {
                fixture.child.stdout.emit("end")
                fixture.child.stderr.emit("end")
                if (state === "drain deadline") fixture.child.emit("exit", 0, null)
                fixture.clock.time = state === "operation deadline" ? CHILD_TIMEOUT_MS : CLI_LIFECYCLE_DRAIN_MS
            }
            fixture.child.emit("close", 0, null)
            await flushCliLifecycle()
            expectCliLifecycleFailure(fixture.settlement)
            expectCliLifecycleReleased(fixture)
        }
    })

    test("sanitizes spawn throw and clears its timer immediately", async (): Promise<void> => {
        const fixture = boundedCli(true, true)
        await flushCliLifecycle()
        expectCliLifecycleFailure(fixture.settlement)
        expect(fixture.clock.timers.size).toBe(0)
        expect(fixture.child.kills).toEqual([])
        expect(fixture.child.unrefs).toBe(0)
    })

    for (const killResult of [true, false, "throw"] as const) {
        test(`bounds spawn error without close and marks cleanup unconfirmed, kill=${killResult}`, async (): Promise<void> => {
            const fixture = boundedCli(killResult)
            fixture.child.emit("error", new Error("synthetic-private-cli-error"))
            fixture.clock.advance(CLI_LIFECYCLE_GRACE_MS)
            await flushCliLifecycle()
            expectCliLifecycleFailure(fixture.settlement, true)
            expect(fixture.child.kills).toEqual(["SIGKILL"])
            expect(fixture.child.unrefs).toBe(1)
            expectCliLifecycleReleased(fixture)
        })
    }

    test("never replaces timeout with late output or close and safely absorbs later errors", async (): Promise<void> => {
        const fixture = boundedCli()
        fixture.clock.advance(CHILD_TIMEOUT_MS)
        const stdout = Buffer.from(SAVED_MESSAGE)
        fixture.child.stdout.emit("data", stdout)
        fixture.child.stdout.emit("end")
        fixture.child.stderr.emit("end")
        fixture.child.emit("close", 0, null)
        await flushCliLifecycle()
        expectCliLifecycleFailure(fixture.settlement)
        const late = Buffer.from("synthetic-private-cli-error")
        expect((): void => {
            fixture.child.emit("exit", 0, null)
            fixture.child.emit("close", 0, null)
            fixture.child.stderr.emit("data", late)
            for (const emitter of [fixture.child, fixture.child.stdin, fixture.child.stdout, fixture.child.stderr]) {
                emitter.emit("error", new Error("synthetic-private-cli-error"))
            }
        }).not.toThrow()
        fixture.clock.advance(CHILD_TIMEOUT_MS)
        await flushCliLifecycle()
        expectCliLifecycleFailure(fixture.settlement)
        expect(stdout.every((byte: number): boolean => byte === 0)).toBe(true)
        expect(late.every((byte: number): boolean => byte === 0)).toBe(true)
        expectCliLifecycleReleased(fixture)
    })

    test("preserves output limit failure and zeros discarded output during bounded cleanup", async (): Promise<void> => {
        const fixture = boundedCli()
        const oversized = Buffer.alloc(MAX_OUTPUT_BYTES + 1, 0x61)
        fixture.child.stdout.emit("data", oversized)
        fixture.child.stderr.emit("error", new Error("synthetic-private-cli-error"))
        fixture.clock.advance(CLI_LIFECYCLE_GRACE_MS)
        await flushCliLifecycle()
        expectCliLifecycleFailure(fixture.settlement, true, "too_large")
        expect(oversized.every((byte: number): boolean => byte === 0)).toBe(true)
        expectCliLifecycleReleased(fixture)
    })
})

// Slow Windows CLI and fixture subprocess integration emits JSON diagnostic events.
describe.skip("Windows source credentials CLI integration", (): void => {
    test("identity reports actual SID/account and service-logon warning without profile output", async (): Promise<void> => {
        await withTemporaryRoot(async (root: string): Promise<void> => {
            const identity = await actualIdentity()
            expect(/^S-1-[0-9]+(?:-[0-9]+)*$/.test(identity.sid)).toBe(true)
            expect(identity.account.trim().length > 0).toBe(true)
            const id = `${ID_PREFIX}${randomUUID().replaceAll("-", "").toUpperCase()}`
            const selected = { [`AUTOCODE_REST_${id}_AUTHORIZATION`]: sentinel("identity-environment") }
            const result = await runCli(root, ["identity"], Buffer.alloc(0), selected)
            expect(result.code === 0 && result.signal === null).toBe(true)
            expect(result.stdout === `SID: ${identity.sid}\nAccount: ${identity.account}\n${CONTEXT_WARNING}\n`).toBe(true)
            expect(result.stderr === "").toBe(true)
            expect(await plaintextFileExists(root)).toBe(false)
        })
    }, TEST_TIMEOUT_MS)

    test("importing source neither runs CLI nor exits or changes exitCode", async (): Promise<void> => {
        await withTemporaryRoot(async (root: string): Promise<void> => {
            const result = await spawnSource(root, ["--eval", IMPORT_SOURCE])
            expectPrivateOutput(result)
            expect(result.code === 0 && result.signal === null).toBe(true)
            expect(result.stdout === IMPORT_MARKER && result.stderr === "").toBe(true)
            expect(await plaintextFileExists(root)).toBe(false)
        })
    }, TEST_TIMEOUT_MS)

    test("direct source --help runs through a directory junction alias", async (): Promise<void> => {
        await withTemporaryRoot(async (root: string): Promise<void> => {
            const alias = join(root, "source-junction")
            await safely("junction-create", (): Promise<void> => symlink(join(REPO, "src"), alias, "junction"))
            try {
                const result = await spawnSource(root, [join(alias, "credentials-cli.ts"), "--help"])
                expectPrivateOutput(result)
                expect(result.code === 0 && result.signal === null).toBe(true)
                expect(result.stdout.startsWith("Usage:\n  autocode-credentials identity\n")
                    && result.stdout.includes("autocode-credentials set --provider")
                    && result.stdout.includes("autocode-credentials import-env --provider")).toBe(true)
                expect(result.stderr === "").toBe(true)
            } finally {
                await safely("junction-cleanup", (): Promise<void> => unlink(alias), "cleanup")
            }
        })
    }, TEST_TIMEOUT_MS)

    for (const provider of PROVIDERS) {
        for (const kind of KINDS) {
            for (const method of METHODS) {
                test(`${provider} ${kind} ${method} roundtrips exact fields without output exposure`, async (): Promise<void> => {
                    await withProfile(provider, kind, async (fixture: Fixture): Promise<void> => {
                        await expectNothingWritten(fixture, "precheck")
                        const profile = roundtripProfile(kind, method)
                        const input = method === "set" ? Buffer.from(JSON.stringify(profile), "utf8") : Buffer.alloc(0)
                        const selected = method === "import-env" ? selectedEnvironment(fixture, profile) : {}
                        const result = await runCli(fixture.root, commandArgs(fixture, method), input, selected)
                        expectSuccess(result, provider)
                        const stored = provider === "plaintext" ? await readPlaintext(fixture) : await readNative(fixture)
                        expect(stored.status === "found" && profilesEqual(stored.profile, profile)).toBe(true)
                        expect(await plaintextFileExists(fixture.root)).toBe(provider === "plaintext")
                        if (provider === "plaintext") expect((await readNative(fixture)).status === "missing").toBe(true)
                    })
                }, TEST_TIMEOUT_MS)
            }
        }

        test(`${provider} rejects actual SID mismatch before any write`, async (): Promise<void> => {
            await withProfile(provider, "rest", async (fixture: Fixture): Promise<void> => {
                const wrongSid = fixture.sid === "S-1-5-18" ? "S-1-5-19" : "S-1-5-18"
                expect(wrongSid !== fixture.sid).toBe(true)
                const input = Buffer.from(JSON.stringify({ authorization: sentinel("wrong-sid") }), "utf8")
                const result = await runCli(fixture.root, commandArgs(fixture, "set", { expectedSid: wrongSid }), input)
                expectFailure(result, ERRORS.denied, `${CONTEXT_WARNING}\n`)
                await expectNothingWritten(fixture)
            })
        }, TEST_TIMEOUT_MS)

        test(`${provider} rejects unknown options with fixed diagnostics`, async (): Promise<void> => {
            await withProfile(provider, "rest", async (fixture: Fixture): Promise<void> => {
                const input = Buffer.from(JSON.stringify({ authorization: sentinel("unknown-option") }), "utf8")
                const result = await runCli(fixture.root, [...commandArgs(fixture, "set"), "--unexpected-option"], input)
                expectFailure(result, ERRORS.usage, "")
                await expectNothingWritten(fixture)
            })
        }, TEST_TIMEOUT_MS)

        const failures: readonly InputFailure[] = ["malformed JSON", "malformed UTF-8", "incomplete profile", "general input limit"]
        for (const scenario of failures) {
            test(`${provider} rejects ${scenario} without exposing input`, async (): Promise<void> => {
                await withProfile(provider, "rest", async (fixture: Fixture): Promise<void> => {
                    const input = failureInput(scenario)
                    const result = await runCli(fixture.root, commandArgs(fixture, "set"), input)
                    const message = scenario === "general input limit" ? ERRORS.too_large
                        : scenario === "incomplete profile" ? ERRORS.incomplete : ERRORS.invalid
                    expectFailure(result, message, warnings(provider))
                    await expectNothingWritten(fixture)
                })
            }, TEST_TIMEOUT_MS)
        }

        test(`${provider} refuses piped input without explicit --stdin`, async (): Promise<void> => {
            await withProfile(provider, "rest", async (fixture: Fixture): Promise<void> => {
                const input = Buffer.from(JSON.stringify({ authorization: sentinel("non-tty") }), "utf8")
                const result = await runCli(fixture.root, commandArgs(fixture, "set", { stdin: false }), input)
                expectFailure(result, ERRORS.tty, warnings(provider))
                await expectNothingWritten(fixture, "test-body")
            })
        }, TEST_TIMEOUT_MS)
    }

    test("native size overflow rejects without plaintext fallback", async (): Promise<void> => {
        await withProfile("windows-credential-manager", "rest", async (fixture: Fixture): Promise<void> => {
            const authorization = sentinel("native-oversize") + "x".repeat(WINDOWS_CREDENTIAL_MAX_BYTES)
            const input = Buffer.from(JSON.stringify({ authorization }), "utf8")
            expect(input.byteLength > WINDOWS_CREDENTIAL_MAX_BYTES && input.byteLength < MAX_CREDENTIAL_ENVELOPE_BYTES).toBe(true)
            const result = await runCli(fixture.root, commandArgs(fixture, "set"), input)
            expectFailure(result, ERRORS.too_large, warnings(fixture.provider))
            await expectNothingWritten(fixture, "test-body")
        })
    }, TEST_TIMEOUT_MS)
})
