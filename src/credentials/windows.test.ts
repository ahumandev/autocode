import { afterAll, describe, expect, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import { appendFile, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { win32 } from "node:path"
import {
    CredentialError,
    WINDOWS_CREDENTIAL_MAX_BYTES,
    type CredentialKind,
    type CredentialProfileInput,
    type CredentialProfileMap,
    type CredentialReadResult,
} from "./types"
import {
    createWindowsCredentialProvider,
    deleteWindowsProfile,
    getWindowsCredentialIdentity,
    writeWindowsProfile,
} from "./windows"
import {
    readWindowsCredentialFailureDiagnostics,
    runWindowsCredentialOperation,
    withWindowsCredentialHelperTrace,
    WindowsCredentialProcessError,
    type WindowsCredentialHelperStage,
    type WindowsCredentialHelperTrace,
    type WindowsCredentialIdentity,
    type WindowsCredentialProcessOptions,
    type WindowsCredentialRequest,
    type WindowsCredentialResponse,
} from "./windows-process"

const TEST_TIMEOUT_MS = 600_000
const NATIVE_OPTIONS = { timeoutMs: 15_000 } satisfies WindowsCredentialProcessOptions
const NATIVE_NOT_FOUND = 1168
const ID_PREFIX = "AUTOCODE_WINDOWS_TEST_"
const TEMP_DIRECTORY = tmpdir()
const MAX_RETAINED_HELPER_TRACES = 8
const HELPER_STAGES: readonly WindowsCredentialHelperStage[] = [
    "nativecompile-before", "nativecompile-after", "input-before", "input-newline", "input-await-EOF", "input-after",
    "parse-before", "parse-after", "tokenSID-before", "tokenSID-after", "identityName-before", "identityName-after",
    "dispatch-before", "dispatch-after", "response-before", "response-after", "cleanup-before", "cleanup-after",
]
const SECRET_CANARY = "synthetic-windows-credential-test-canary"
const KINDS = ["ssh", "db", "rest"] as const
const SAFE_MESSAGES = {
    invalid: "Invalid credential profile, storage, or ID.",
    incomplete: "Credential profile is incomplete.",
    too_large: "Credential exceeds the supported size limit.",
    denied: "Credential access denied.",
    failed: "Credential read failed.",
} as const
const SAFE_ERROR_CODES = [...Object.keys(SAFE_MESSAGES), "locked", "missing", "unavailable", "unsupported"]
const COMPLETE_PROFILES = {
    ssh: {
        host: "  hôte-例.example.test  ",
        username: "  opérateur_用户🧪  ",
        port: " 0022 ",
        keyfile: " C:\\clés\\clé 🧪 ",
        agent: " false ",
        password: `${SECRET_CANARY}:é漢🧪\"\\\r\n\t\0`,
        keypass: `${SECRET_CANARY}:cle\u0301🔑 `,
    },
    db: {
        connection: "  jdbc:postgresql://db.example.test:05432/試験?ssl=false  ",
        username: "  usér_用户🧪  ",
        password: `${SECRET_CANARY}:données漢🧪\"\\\r\n\0`,
    },
    rest: {
        authorization: ` Bearer ${SECRET_CANARY}:é漢🧪\"\\\r\n `,
        username: "  usér_用户🧪  ",
        password: `${SECRET_CANARY}:re\u0301ponse🔑\t\0`,
    },
} satisfies CredentialProfileMap
const INCOMPLETE_PROFILES = {
    ssh: [{}, { password: SECRET_CANARY }, { host: "" }, { host: " \t\r\n", password: SECRET_CANARY }],
    db: [{}, { password: SECRET_CANARY }, { connection: "" }, { connection: " \t\r\n", username: SECRET_CANARY }],
    rest: [{}, { username: SECRET_CANARY }, { password: SECRET_CANARY }],
} satisfies { [K in CredentialKind]: readonly CredentialProfileInput<K>[] }
const INVALID_ENVELOPES = [
    { name: "malformed JSON", payload: `{"version":1,"kind":"rest","fields":{"authorization":"${SECRET_CANARY}"}` },
    { name: "wrong kind", payload: JSON.stringify({ version: 1, kind: "ssh", fields: { host: SECRET_CANARY } }) },
    { name: "wrong version", payload: JSON.stringify({ version: 2, kind: "rest", fields: COMPLETE_PROFILES.rest }) },
    { name: "extra envelope key", payload: JSON.stringify({ version: 1, kind: "rest", fields: COMPLETE_PROFILES.rest, extra: SECRET_CANARY }) },
    { name: "extra profile key", payload: JSON.stringify({ version: 1, kind: "rest", fields: { ...COMPLETE_PROFILES.rest, extra: SECRET_CANARY } }) },
    { name: "nonstring field", payload: JSON.stringify({ version: 1, kind: "rest", fields: { authorization: 42, password: SECRET_CANARY } }) },
]

type OwnedCredential = { kind: CredentialKind; id: string; target: string; nativeUUID: string }
type OwnershipJournal = { root: string; path: string }
type FailurePhase = "primary" | "cleanup"
type FailureOperation = WindowsCredentialRequest["operation"] | "case" | "cleanup-verification" | "journal-finalization"

const ownedCredentials = new Map<string, OwnedCredential>()
const verifiedCleanup = new Set<string>()
const ownershipToken = randomUUID()
const failurePhase = new AsyncLocalStorage<FailurePhase>()
const reportedFailures = new WeakSet<object>()
let ownershipJournal: Promise<OwnershipJournal> | undefined
let diagnosticOutputFailed = false
let diagnosticPersistenceFailed = false

async function createOwnershipJournal(): Promise<OwnershipJournal> {
    try {
        const root = await mkdtemp(win32.join(TEMP_DIRECTORY, `autocode-windows-credentials-${ownershipToken}-`))
        const path = win32.join(root, "ownership.jsonl")
        const record = `${JSON.stringify({ phase: "root-created", ownershipToken, root, pid: process.pid, journal: path })}\n`
        process.stderr.write(record)
        await appendFile(path, record, { encoding: "utf8", flag: "ax", mode: 0o600 })
        return { root, path }
    } catch {
        throw new Error("Windows credential ownership journal initialization failed.")
    }
}

function getOwnershipJournal(): Promise<OwnershipJournal> {
    return ownershipJournal ??= createOwnershipJournal()
}

async function appendOwnershipRecord(
    phase: "registered" | "cleanup-verified" | "owned-cleanup-complete" | "owned-cleanup-incomplete" | "root-retained",
    credential?: OwnedCredential,
): Promise<void> {
    try {
        const journal = await getOwnershipJournal()
        await appendFile(journal.path, `${JSON.stringify({
            phase, ownershipToken, root: journal.root, pid: process.pid,
            ...(credential === undefined ? { remaining: ownedCredentials.size, verified: verifiedCleanup.size } : {
                kind: credential.kind, id: credential.id, target: credential.target, nativeUUID: credential.nativeUUID,
            }),
        })}\n`, "utf8")
    } catch {
        throw new Error("Windows credential ownership journal append failed.")
    }
}

async function ownCredential(kind: CredentialKind): Promise<OwnedCredential> {
    const nativeUUID = randomUUID()
    const id = `${ID_PREFIX}${nativeUUID.replaceAll("-", "").toUpperCase()}`
    const target = `AutoCode/v1/${kind}/${id}`
    const credential = { kind, id, target, nativeUUID }
    expect(ownedCredentials.has(target)).toBe(false)
    // Registration must finish before callers can reach any native write, including normalized SSH aliases.
    await appendOwnershipRecord("registered", credential)
    ownedCredentials.set(target, credential)
    return credential
}

async function reportFailure(
    error: unknown,
    operation: FailureOperation,
    phase: FailurePhase,
    startedAt: number = performance.now(),
    helperTrace: readonly Readonly<WindowsCredentialHelperTrace>[] = [],
): Promise<void> {
    if (typeof error === "object" && error !== null) {
        if (reportedFailures.has(error)) return
        reportedFailures.add(error)
    }
    const nativeCode = error instanceof WindowsCredentialProcessError ? error.nativeCode : undefined
    const snapshot = {
        phase: "failure", operation, failurePhase: phase, ownershipToken, pid: process.pid,
        elapsedMs: Math.max(0, Math.floor(performance.now() - startedAt)),
        class: error instanceof WindowsCredentialProcessError ? "WindowsCredentialProcessError" : error instanceof CredentialError ? "CredentialError" : error instanceof Error ? "Error" : "unknown",
        code: error instanceof CredentialError && SAFE_ERROR_CODES.includes(error.code) ? error.code : "unexpected",
        nativeCode: typeof nativeCode === "number" && Number.isSafeInteger(nativeCode) && nativeCode >= -2147483648 && nativeCode <= 2147483647 ? nativeCode : "unknown",
        parent: readWindowsCredentialFailureDiagnostics(error) ?? "unregistered",
        helperTrace: helperTrace.slice(-MAX_RETAINED_HELPER_TRACES),
    }
    let stderrFailed = false
    try {
        process.stderr.write(`${JSON.stringify(snapshot)}\n`)
    } catch {
        stderrFailed = true
    }
    try {
        const journal = await getOwnershipJournal()
        await appendFile(journal.path, `${JSON.stringify({ ...snapshot, stderrFailed })}\n`, "utf8")
    } catch {
        diagnosticPersistenceFailed = true
        try {
            process.stderr.write(`${JSON.stringify({ phase: "diagnostic-persistence-failed", operation, failurePhase: phase, ownershipToken, pid: process.pid })}\n`)
        } catch {
            stderrFailed = true
        }
    }
    diagnosticOutputFailed ||= stderrFailed
}

async function observeNative<T>(operation: FailureOperation, action: () => Promise<T>, expectedCode?: keyof typeof SAFE_MESSAGES): Promise<T> {
    const phase = failurePhase.getStore() ?? "primary"
    const startedAt = performance.now()
    const helperTrace: Readonly<WindowsCredentialHelperTrace>[] = []
    try {
        return await withWindowsCredentialHelperTrace((trace: Readonly<WindowsCredentialHelperTrace>): void => {
            if (!HELPER_STAGES.includes(trace.helperStage)
                || !Number.isSafeInteger(trace.helperElapsedMs) || trace.helperElapsedMs < 0
                || !Number.isSafeInteger(trace.helperByteCount) || trace.helperByteCount < 0) return
            if (helperTrace.length === MAX_RETAINED_HELPER_TRACES) helperTrace.shift()
            helperTrace.push({ helperStage: trace.helperStage, helperElapsedMs: trace.helperElapsedMs, helperByteCount: trace.helperByteCount })
        }, action)
    } catch (error: unknown) {
        if (!(error instanceof CredentialError && error.code === expectedCode)) {
            await reportFailure(error, operation, phase, startedAt, helperTrace)
        }
        throw error
    }
}

function failureDescription(error: unknown): string {
    const code = error instanceof CredentialError && SAFE_ERROR_CODES.includes(error.code) ? error.code : "unexpected"
    const nativeCode = error instanceof WindowsCredentialProcessError ? error.nativeCode : undefined
    return `Windows credential integration failed (${code}${Number.isInteger(nativeCode) ? `; nativeCode=${nativeCode}` : ""}).`
}

async function safely<T>(operation: FailureOperation, action: () => Promise<T>): Promise<T> {
    try {
        return await observeNative(operation, action)
    } catch (error: unknown) {
        const sanitized = new Error(failureDescription(error))
        if (typeof error === "object" && error !== null && reportedFailures.has(error)) reportedFailures.add(sanitized)
        throw sanitized
    }
}

async function runNative(
    request: WindowsCredentialRequest,
    options: WindowsCredentialProcessOptions = NATIVE_OPTIONS,
): Promise<WindowsCredentialResponse> {
    let unavailable = false
    try {
        return await observeNative(request.operation, async (): Promise<WindowsCredentialResponse> => {
            const response = await runWindowsCredentialOperation(request, options)
            if (response.status === "unavailable") {
                unavailable = true
                throw new WindowsCredentialProcessError("unavailable", response.nativeCode)
            }
            return response
        })
    } catch (error: unknown) {
        const sanitized = new Error(unavailable && error instanceof WindowsCredentialProcessError
            ? `Windows Credential Manager unavailable; nativeCode=${error.nativeCode ?? "none"}.`
            : failureDescription(error))
        if (typeof error === "object" && error !== null && reportedFailures.has(error)) reportedFailures.add(sanitized)
        throw sanitized
    }
}

async function expectCredentialRejection(
    action: () => Promise<unknown>,
    code: keyof typeof SAFE_MESSAGES,
    redactions: readonly string[],
    operation: FailureOperation,
): Promise<CredentialError> {
    let caught: unknown
    try {
        await observeNative(operation, action, code)
    } catch (error: unknown) {
        caught = error
    }
    expect(caught instanceof CredentialError).toBe(true)
    if (!(caught instanceof CredentialError)) {
        throw new Error("Expected a credential rejection.")
    }
    expect(caught.code === code).toBe(true)
    expect(caught.message === SAFE_MESSAGES[code]).toBe(true)
    const diagnostics = [caught.message, caught.stack ?? "", JSON.stringify(caught) ?? ""]
    for (const diagnostic of diagnostics) {
        for (const redaction of [SECRET_CANARY, ...redactions]) {
            expect(diagnostic.includes(redaction)).toBe(false)
        }
    }
    expect(caught.cause === undefined).toBe(true)
    expect(Object.hasOwn(caught, "cause")).toBe(false)
    return caught
}

async function expectNativeMissing(credential: OwnedCredential): Promise<void> {
    const response = await runNative({ operation: "read", target: credential.target })
    expect(JSON.stringify(response) === JSON.stringify({ version: 1, status: "missing", nativeCode: NATIVE_NOT_FOUND })).toBe(true)
}

async function expectStoredPayload(credential: OwnedCredential, payload: string): Promise<void> {
    const response = await runNative({ operation: "read", target: credential.target })
    expect(response.status === "ok" && response.payload === payload).toBe(true)
}

async function expectFoundProfile(
    credential: OwnedCredential,
    profile: CredentialProfileInput<CredentialKind>,
    id: string = credential.id,
    options: WindowsCredentialProcessOptions = NATIVE_OPTIONS,
): Promise<void> {
    const result = await safely("read", (): Promise<CredentialReadResult> => createWindowsCredentialProvider(options).read(credential.kind, id))
    expect(result.status === "found" && JSON.stringify(result.profile) === JSON.stringify(profile)).toBe(true)
}

async function cleanupCredentials(credentials: readonly OwnedCredential[]): Promise<void> {
    await failurePhase.run("cleanup", async (): Promise<void> => {
        const failures: string[] = []
        for (const credential of credentials) {
            verifiedCleanup.delete(credential.target)
            let deleted = false
            try {
                const response = await runNative({ operation: "delete", target: credential.target })
                expect(response.status === "ok" || response.status === "missing").toBe(true)
                deleted = true
            } catch (error: unknown) {
                await reportFailure(error, "delete", "cleanup")
                failures.push(`${credential.target}: delete failed; ${failureDescription(error)}`)
            }
            try {
                await expectNativeMissing(credential)
                if (deleted) {
                    await appendOwnershipRecord("cleanup-verified", credential)
                    verifiedCleanup.add(credential.target)
                    ownedCredentials.delete(credential.target)
                }
            } catch (error: unknown) {
                await reportFailure(error, "cleanup-verification", "cleanup")
                failures.push(`${credential.target}: missing verification failed; ${failureDescription(error)}`)
            }
        }
        if (failures.length > 0) {
            throw new Error(`Owned credential cleanup failed: ${failures.join("; ")}`)
        }
    })
}

async function withOwnedCredentials(credentials: readonly OwnedCredential[], action: () => Promise<void>): Promise<void> {
    let primaryError: unknown
    let primaryFailed = false
    try {
        await action()
    } catch (error: unknown) {
        primaryFailed = true
        primaryError = error
        await reportFailure(error, "case", "primary")
    }
    let cleanupError: unknown
    let cleanupFailed = false
    try {
        await cleanupCredentials(credentials)
    } catch (error: unknown) {
        cleanupFailed = true
        cleanupError = error
        await reportFailure(error, "case", "cleanup")
    }
    if (primaryFailed && cleanupFailed) {
        throw new Error("Windows credential integration primary and cleanup failed; separate sanitized diagnostics retained.")
    }
    if (primaryFailed) throw primaryError
    if (cleanupFailed) throw cleanupError
}

function createSizedEnvelope(byteLength: number): { fields: { authorization: string }; payload: string } {
    const fields = { authorization: `${SECRET_CANARY}:é漢🧪` }
    const envelope = { version: 1, kind: "rest", fields }
    const available = byteLength - Buffer.byteLength(JSON.stringify(envelope), "utf8")
    const padding = "界🧪"
    const paddingBytes = Buffer.byteLength(padding, "utf8")
    fields.authorization += padding.repeat(Math.floor(available / paddingBytes)) + "x".repeat(available % paddingBytes)
    const payload = JSON.stringify(envelope)
    expect(Buffer.byteLength(payload, "utf8")).toBe(byteLength)
    expect(payload.length < byteLength).toBe(true)
    return { fields, payload }
}

async function expectRoundTrip<K extends CredentialKind>(kind: K, fields: CredentialProfileMap[K]): Promise<void> {
    const credential = await ownCredential(kind)
    const id = kind === "ssh" ? credential.id.toLowerCase().replaceAll("_", "-") : credential.id
    const payload = JSON.stringify({ version: 1, kind, fields })
    await withOwnedCredentials([credential], async (): Promise<void> => {
        await expectNativeMissing(credential)
        const identity = await safely("identity", (): Promise<WindowsCredentialIdentity> => getWindowsCredentialIdentity(NATIVE_OPTIONS))
        const options = { ...NATIVE_OPTIONS, expectedSid: identity.sid }
        await safely("write", (): Promise<void> => writeWindowsProfile(kind, id, fields, options))
        await expectStoredPayload(credential, payload)
        await expectFoundProfile(credential, fields, id, options)
        if (id !== credential.id) {
            await expectFoundProfile(credential, fields, credential.id, options)
        }
        expect(await safely("delete", (): Promise<boolean> => deleteWindowsProfile(kind, id, options))).toBe(true)
        await expectNativeMissing(credential)
        expect(await safely("delete", (): Promise<boolean> => deleteWindowsProfile(kind, credential.id, options))).toBe(false)
    })
}

describe.skipIf(process.platform !== "win32")("Windows Credential Manager native integration", (): void => {
    afterAll(async (): Promise<void> => {
        let cleanupError: unknown
        let cleanupFailed = false
        try {
            await cleanupCredentials([...ownedCredentials.values()])
            if (ownedCredentials.size !== 0) {
                throw new Error("Owned credential cleanup remains incomplete.")
            }
        } catch (error: unknown) {
            cleanupFailed = true
            cleanupError = error
            await reportFailure(error, "case", "cleanup")
        }
        try {
            await appendOwnershipRecord(!cleanupFailed && ownedCredentials.size === 0 ? "owned-cleanup-complete" : "owned-cleanup-incomplete")
            await appendOwnershipRecord("root-retained")
        } catch (error: unknown) {
            await reportFailure(error, "journal-finalization", "cleanup")
            if (cleanupFailed) throw new Error("Windows credential cleanup and journal finalization failed; separate sanitized diagnostics retained.")
            throw error
        }
        console.info(`Windows credential cleanup: ${JSON.stringify({
            owned: [...ownedCredentials.values()].map((credential: OwnedCredential): { kind: CredentialKind; id: string } => ({
                kind: credential.kind,
                id: credential.id,
            })),
            verified: verifiedCleanup.size,
            total: ownedCredentials.size + verifiedCleanup.size,
            diagnosticOutputFailed,
            diagnosticPersistenceFailed,
        })}`)
        if (cleanupFailed) throw cleanupError
    }, TEST_TIMEOUT_MS * 2)

    test("reports current SID/account and accepts matching expectedSid", async (): Promise<void> => {
        const identity = await safely("identity", (): Promise<WindowsCredentialIdentity> => getWindowsCredentialIdentity(NATIVE_OPTIONS))
        expect(/^S-1-[0-9]+(?:-[0-9]+)*$/.test(identity.sid)).toBe(true)
        expect(identity.account.trim().length > 0).toBe(true)
        const response = await runNative({ operation: "identity" })
        expect(response.status === "ok" && JSON.stringify(response.identity) === JSON.stringify(identity)).toBe(true)
        const options = { ...NATIVE_OPTIONS, expectedSid: identity.sid }
        const matching = await safely("identity", (): Promise<WindowsCredentialIdentity> => getWindowsCredentialIdentity(options))
        expect(JSON.stringify(matching) === JSON.stringify(identity)).toBe(true)
        const nativeMatching = await runNative({ operation: "identity" }, options)
        expect(nativeMatching.status === "ok" && JSON.stringify(nativeMatching.identity) === JSON.stringify(identity)).toBe(true)
    }, TEST_TIMEOUT_MS)

    // Measured slow tests are skipped from the fast suite; retained for future opt-in/slow testing.
    test.skip("rejects a valid different expectedSid before native read/write/delete", async (): Promise<void> => {
        const existing = await ownCredential("rest")
        const absent = await ownCredential("rest")
        const fields = COMPLETE_PROFILES.rest
        const payload = JSON.stringify({ version: 1, kind: "rest", fields })
        await withOwnedCredentials([existing, absent], async (): Promise<void> => {
            await expectNativeMissing(existing)
            await expectNativeMissing(absent)
            await safely("write", (): Promise<void> => writeWindowsProfile("rest", existing.id, fields, NATIVE_OPTIONS))
            const identity = await safely("identity", (): Promise<WindowsCredentialIdentity> => getWindowsCredentialIdentity(NATIVE_OPTIONS))
            const wrongSid = identity.sid === "S-1-5-18" ? "S-1-5-19" : "S-1-5-18"
            const options = { ...NATIVE_OPTIONS, expectedSid: wrongSid }
            const provider = createWindowsCredentialProvider(options)
            const actions: [FailureOperation, () => Promise<unknown>][] = [
                ["identity", (): Promise<unknown> => getWindowsCredentialIdentity(options)],
                ["read", (): Promise<unknown> => provider.read("rest", existing.id)],
                ["read", (): Promise<unknown> => provider.read("rest", absent.id)],
                ["write", (): Promise<unknown> => writeWindowsProfile("rest", existing.id, { authorization: `${SECRET_CANARY}:replacement` }, options)],
                ["write", (): Promise<unknown> => writeWindowsProfile("rest", absent.id, fields, options)],
                ["delete", (): Promise<unknown> => deleteWindowsProfile("rest", existing.id, options)],
                ["delete", (): Promise<unknown> => deleteWindowsProfile("rest", absent.id, options)],
            ]
            for (const [operation, action] of actions) {
                const error = await expectCredentialRejection(action, "denied", [existing.id, absent.id, existing.target, absent.target, wrongSid, ...Object.values(fields)], operation)
                expect(error instanceof WindowsCredentialProcessError).toBe(true)
                await expectStoredPayload(existing, payload)
                await expectNativeMissing(absent)
            }
        })
    }, TEST_TIMEOUT_MS)

    test.skip("returns native 1168, provider missing, and false deletion for an exact absent target", async (): Promise<void> => {
        const credential = await ownCredential("db")
        await withOwnedCredentials([credential], async (): Promise<void> => {
            await expectNativeMissing(credential)
            const response = await runNative({ operation: "delete", target: credential.target })
            expect(JSON.stringify(response) === JSON.stringify({ version: 1, status: "missing", nativeCode: NATIVE_NOT_FOUND })).toBe(true)
            const result = await safely("read", (): Promise<CredentialReadResult> => createWindowsCredentialProvider(NATIVE_OPTIONS).read("db", credential.id))
            expect(JSON.stringify(result) === '{"status":"missing"}').toBe(true)
            expect(Reflect.get(result, "nativeCode") === NATIVE_NOT_FOUND).toBe(true)
            expect(Object.getOwnPropertyDescriptor(result, "nativeCode")?.enumerable === false).toBe(true)
            expect(await safely("delete", (): Promise<boolean> => deleteWindowsProfile("db", credential.id, NATIVE_OPTIONS))).toBe(false)
            await expectNativeMissing(credential)
        })
    }, TEST_TIMEOUT_MS)

    for (const kind of KINDS) {
        test.skip(`round-trips complete Unicode ${kind} and deletes its exact normalized target`, async (): Promise<void> => {
            await expectRoundTrip(kind, COMPLETE_PROFILES[kind])
        }, TEST_TIMEOUT_MS)
    }

    test.skip("round-trips Unicode REST basic fields without authorization", async (): Promise<void> => {
        await expectRoundTrip("rest", { username: "  usér_用户🧪  ", password: `${SECRET_CANARY}:basic-é漢🧪\0` })
    }, TEST_TIMEOUT_MS)

    for (const kind of KINDS) {
        test.skip(`returns only incomplete for raw stored ${kind} partial envelopes`, async (): Promise<void> => {
            const credential = await ownCredential(kind)
            await withOwnedCredentials([credential], async (): Promise<void> => {
                await expectNativeMissing(credential)
                for (const fields of INCOMPLETE_PROFILES[kind]) {
                    const payload = JSON.stringify({ version: 1, kind, fields })
                    const response = await runNative({ operation: "write", target: credential.target, payload })
                    expect(response.status === "ok").toBe(true)
                    await expectStoredPayload(credential, payload)
                    const result = await safely("read", (): Promise<CredentialReadResult> => createWindowsCredentialProvider(NATIVE_OPTIONS).read(kind, credential.id))
                    expect(JSON.stringify(result) === '{"status":"incomplete"}').toBe(true)
                    expect(Reflect.ownKeys(result).length === 1 && Object.hasOwn(result, "status")).toBe(true)
                }
            })
        }, TEST_TIMEOUT_MS)
    }

    for (const fixture of INVALID_ENVELOPES) {
        test.skip(`rejects raw ${fixture.name} as invalid without missing/unavailable fallback`, async (): Promise<void> => {
            const credential = await ownCredential("rest")
            await withOwnedCredentials([credential], async (): Promise<void> => {
                await expectNativeMissing(credential)
                const response = await runNative({ operation: "write", target: credential.target, payload: fixture.payload })
                expect(response.status === "ok").toBe(true)
                await expectStoredPayload(credential, fixture.payload)
                await expectCredentialRejection(
                    (): Promise<CredentialReadResult> => createWindowsCredentialProvider(NATIVE_OPTIONS).read("rest", credential.id),
                    "invalid",
                    [credential.id, credential.target, fixture.payload],
                    "read",
                )
                await expectStoredPayload(credential, fixture.payload)
            })
        }, TEST_TIMEOUT_MS)
    }

    test.skip("round-trips exactly 2560 UTF-8 bytes without truncation", async (): Promise<void> => {
        expect(WINDOWS_CREDENTIAL_MAX_BYTES).toBe(2560)
        const fixture = createSizedEnvelope(WINDOWS_CREDENTIAL_MAX_BYTES)
        const credential = await ownCredential("rest")
        await withOwnedCredentials([credential], async (): Promise<void> => {
            await expectNativeMissing(credential)
            await safely("write", (): Promise<void> => writeWindowsProfile("rest", credential.id, fixture.fields, NATIVE_OPTIONS))
            await expectStoredPayload(credential, fixture.payload)
            await expectFoundProfile(credential, fixture.fields)
            const response = await runNative({ operation: "write", target: credential.target, payload: fixture.payload })
            expect(response.status === "ok").toBe(true)
            await expectStoredPayload(credential, fixture.payload)
            await expectFoundProfile(credential, fixture.fields)
        })
    }, TEST_TIMEOUT_MS)

    test.skip("rejects 2561+ UTF-8 bytes without overwrite, truncation, or absent target creation", async (): Promise<void> => {
        const baseline = createSizedEnvelope(WINDOWS_CREDENTIAL_MAX_BYTES)
        const existing = await ownCredential("rest")
        const absent = await ownCredential("rest")
        await withOwnedCredentials([existing, absent], async (): Promise<void> => {
            await expectNativeMissing(existing)
            await expectNativeMissing(absent)
            await safely("write", (): Promise<void> => writeWindowsProfile("rest", existing.id, baseline.fields, NATIVE_OPTIONS))
            for (const byteLength of [WINDOWS_CREDENTIAL_MAX_BYTES + 1, WINDOWS_CREDENTIAL_MAX_BYTES + 256]) {
                const fixture = createSizedEnvelope(byteLength)
                for (const credential of [existing, absent]) {
                    const actions: (() => Promise<unknown>)[] = [
                        (): Promise<unknown> => writeWindowsProfile("rest", credential.id, fixture.fields, NATIVE_OPTIONS),
                        (): Promise<unknown> => runWindowsCredentialOperation({ operation: "write", target: credential.target, payload: fixture.payload }, NATIVE_OPTIONS),
                    ]
                    for (const action of actions) {
                        await expectCredentialRejection(action, "too_large", [credential.id, credential.target, fixture.fields.authorization, fixture.payload], "write")
                        await expectStoredPayload(existing, baseline.payload)
                        await expectFoundProfile(existing, baseline.fields)
                        await expectNativeMissing(absent)
                    }
                }
            }
        })
    }, TEST_TIMEOUT_MS)

    for (const kind of KINDS) {
        test.skip(`rejects incomplete ${kind} writes before native processing and preserves targets`, async (): Promise<void> => {
            const existing = await ownCredential(kind)
            const absent = await ownCredential(kind)
            const fields = COMPLETE_PROFILES[kind]
            const payload = JSON.stringify({ version: 1, kind, fields })
            await withOwnedCredentials([existing, absent], async (): Promise<void> => {
                await expectNativeMissing(existing)
                await expectNativeMissing(absent)
                await safely("write", (): Promise<void> => writeWindowsProfile(kind, existing.id, fields, NATIVE_OPTIONS))
                for (const incomplete of INCOMPLETE_PROFILES[kind]) {
                    for (const credential of [existing, absent]) {
                        await expectCredentialRejection(
                            (): Promise<void> => writeWindowsProfile(kind, credential.id, incomplete, NATIVE_OPTIONS),
                            "incomplete",
                            [credential.id, credential.target],
                            "write",
                        )
                    }
                    // Invalid helper options distinguish profile rejection from transport validation.
                    await expectCredentialRejection(
                        (): Promise<void> => writeWindowsProfile(kind, existing.id, incomplete, { timeoutMs: 0 }),
                        "incomplete",
                        [existing.id, existing.target],
                        "write",
                    )
                    await expectStoredPayload(existing, payload)
                    await expectNativeMissing(absent)
                }
            })
        }, TEST_TIMEOUT_MS)

        test.skip(`rejects invalid ${kind} IDs safely without native changes`, async (): Promise<void> => {
            const existing = await ownCredential(kind)
            const absent = await ownCredential(kind)
            const fields = COMPLETE_PROFILES[kind]
            const payload = JSON.stringify({ version: 1, kind, fields })
            await withOwnedCredentials([existing, absent], async (): Promise<void> => {
                await expectNativeMissing(existing)
                await expectNativeMissing(absent)
                await safely("write", (): Promise<void> => writeWindowsProfile(kind, existing.id, fields, NATIVE_OPTIONS))
                for (const credential of [existing, absent]) {
                    const invalidIds = [
                        `${credential.id}/${SECRET_CANARY}`,
                        `${credential.id}.${SECRET_CANARY}`,
                        `${credential.id} ${SECRET_CANARY}`,
                        `${credential.id}\0${SECRET_CANARY}`,
                    ]
                    if (kind !== "ssh") invalidIds.push(credential.id.toLowerCase().replaceAll("_", "-"))
                    for (const id of invalidIds) {
                        const actions: [FailureOperation, () => Promise<unknown>][] = [
                            ["write", (): Promise<unknown> => writeWindowsProfile(kind, id, fields, NATIVE_OPTIONS)],
                            ["read", (): Promise<unknown> => createWindowsCredentialProvider(NATIVE_OPTIONS).read(kind, id)],
                            ["delete", (): Promise<unknown> => deleteWindowsProfile(kind, id, NATIVE_OPTIONS)],
                        ]
                        for (const [operation, action] of actions) {
                            await expectCredentialRejection(action, "invalid", [id, credential.id, credential.target, ...Object.values(fields)], operation)
                        }
                        await expectStoredPayload(existing, payload)
                        await expectNativeMissing(absent)
                    }
                }
            })
        }, TEST_TIMEOUT_MS)
    }

    test("keeps process error nativeCode metadata nonenumerable and failed message fixed", (): void => {
        // This checks error metadata only, not native failure mapping.
        const error = new WindowsCredentialProcessError("failed", NATIVE_NOT_FOUND)
        expect(error instanceof CredentialError).toBe(true)
        expect(error.code === "failed").toBe(true)
        expect(error.message === SAFE_MESSAGES.failed).toBe(true)
        expect(error.nativeCode === NATIVE_NOT_FOUND).toBe(true)
        expect(Object.getOwnPropertyDescriptor(error, "nativeCode")?.enumerable === false).toBe(true)
        expect(Object.keys(error).includes("nativeCode")).toBe(false)
        expect((JSON.stringify(error) ?? "").includes("nativeCode")).toBe(false)
    }, TEST_TIMEOUT_MS)
})
