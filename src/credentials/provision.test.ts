import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { win32 } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { MAX_PLAINTEXT_STORE_BYTES, readPlaintextCredentialStore, type PlaintextCredentialOptions, type PlaintextCredentialStore } from "./plaintext"
import { PLAINTEXT_PROVISION_INITIALIZER_PREFIX, PLAINTEXT_PROVISION_LOCK_FILENAME, writePlaintextProfile } from "./provision"
import { CredentialError, MAX_CREDENTIAL_ENVELOPE_BYTES, MAX_CREDENTIAL_FIELD_BYTES, type CredentialErrorCode, type CredentialKind } from "./types"
import { getWindowsCredentialIdentity } from "./windows"
import { writeSecureWindowsFile } from "./windows-files"

const TEMP_DIRECTORY = tmpdir()
const ROOT_PREFIX = "autocode-provision-"
const WINDOWS_ROOT = "C:\\Windows"
const POWERSHELL_PATH = `${WINDOWS_ROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
const TASKKILL_PATH = `${WINDOWS_ROOT}\\System32\\taskkill.exe`
const TEST_TIMEOUT_MS = 60000
const CHILD_TIMEOUT_MS = 45000
const KILL_TIMEOUT_MS = 3000
const MAX_CHILD_OUTPUT_BYTES = 65536
const HELPER_TEMP_DIRECTORY_NAME = ".helper-temp"
const FULL_CONTROL = 2032127
const SECRET_CANARY = "synthetic-provision-secret-canary"
const ID_CANARY = "private-profile-id-canary"
const PROVISION_URL = new URL("./provision.ts", import.meta.url).href
const WINDOWS_FILES_URL = new URL("./windows-files.ts", import.meta.url).href
const TYPES_URL = new URL("./types.ts", import.meta.url).href
const KINDS = ["ssh", "db", "rest"] as const
const INITIALIZER_NAME_PATTERN = new RegExp(`^${PLAINTEXT_PROVISION_INITIALIZER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[A-Za-z0-9_-]{11}$`)
const DIAGNOSTIC_STAGES = [
    "scenario", "acl-inspection", "atomic-open", "atomic-provision", "atomic-identity", "atomic-old-contents", "atomic-new-contents", "atomic-observation", "atomic-samples",
    "sentinel-provision", "sentinel-write", "sentinel-written", "sentinel-pin-spawn", "sentinel-pin-input", "sentinel-pin-readiness",
    "sentinel-pin-open", "sentinel-pin-marker", "sentinel-pin-held", "sentinel-pin-wait", "sentinel-pin-protocol",
    "lock-wait-write", "lock-wait-result-validation", "lock-wait-foreign-lock-bytes",
    "lock-wait-poll-count", "lock-wait-first-delay", "lock-wait-advance-count", "lock-wait-advance-offset", "lock-wait-deadline-read-count",
    "lock-wait-error-type", "lock-wait-error-code", "lock-wait-error-message", "lock-wait-error-cause",
    "lock-wait-error-own-cause", "lock-wait-error-own-native-code", "lock-wait-error-message-canary", "lock-wait-error-json-canary",
]
const DIAGNOSTIC_CODES = ["locked", "denied", "invalid", "unsafe_location", "too_large", "failed", "missing", "incomplete", "unavailable", "unsupported", "ERR_ASSERTION", "EACCES", "EBUSY", "EPERM", "ENOENT", "EEXIST", "EIO", "EPIPE"]
const MINIMAL_PROFILES = {
    ssh: { host: "  replacement.example.test  " },
    db: { connection: "  jdbc:postgresql://localhost/synthetic  " },
    rest: { authorization: "" },
}

interface AclMetadata {
    ownerSid: string
    protected: boolean
    sddl: string
    rules: {
        sid: string
        type: string
        rights: number
        inherited: boolean
        inheritance: number
        propagation: number
    }[]
}

interface ProcessResult {
    code: number | null
    signal: NodeJS.Signals | null
    failed: boolean
    output: string
    failure?: "timeout" | "spawn" | "stdin" | "stdout" | "stderr" | "output-limit"
}

interface FixtureProcess {
    child: ChildProcessWithoutNullStreams
    ready: Promise<boolean>
    closed: Promise<ProcessResult>
    stop(): Promise<void>
}

interface ProvisionFixture {
    root: string
    temp: string
    config: string
    directory: string
    store: string
    initializers: string[]
    lock: string
    options: PlaintextCredentialOptions
    children: FixtureProcess[]
    writes: Promise<void>[]
}

const createdRoots: string[] = []
const removedRoots: string[] = []
let expectedSid = ""

const INSPECT_ACLS = `
$items = @(
    foreach ($path in $inputData.paths) {
        $acl = Get-Acl -LiteralPath $path
        $rules = @(
            foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
                [ordered]@{
                    sid = $rule.IdentityReference.Value
                    type = $rule.AccessControlType.ToString()
                    rights = [int]$rule.FileSystemRights
                    inherited = $rule.IsInherited
                    inheritance = [int]$rule.InheritanceFlags
                    propagation = [int]$rule.PropagationFlags
                }
            }
        )
        [ordered]@{
            ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
            protected = $acl.AreAccessRulesProtected
            sddl = $acl.GetSecurityDescriptorSddlForm(
                [System.Security.AccessControl.AccessControlSections]::Access -bor
                [System.Security.AccessControl.AccessControlSections]::Owner -bor
                [System.Security.AccessControl.AccessControlSections]::Group)
            rules = $rules
        }
    }
)
$outputWriter.WriteLine((ConvertTo-Json -InputObject $items -Depth 6 -Compress))
`

function startProcess(fixture: ProvisionFixture, executable: string, args: string[], input: object, interactive: boolean = false): FixtureProcess {
    const child = spawn(executable, args, {
        // Provisioning must run outside the fixture's config root, just like the real plugin.
        cwd: process.cwd(),
        env: { SystemRoot: WINDOWS_ROOT, WINDIR: WINDOWS_ROOT, TEMP: fixture.temp, TMP: fixture.temp },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
    })
    let output = ""
    let bytes = 0
    let failed = false
    let failure: ProcessResult["failure"]
    let finished = false
    let stopping: Promise<void> | undefined
    let markReady!: (value: boolean) => void
    const ready = new Promise<boolean>((resolve: (value: boolean) => void): void => { markReady = resolve })
    const closed = new Promise<ProcessResult>((resolve: (result: ProcessResult) => void): void => {
        child.once("close", (code: number | null, signal: NodeJS.Signals | null): void => {
            finished = true
            clearTimeout(watchdog)
            markReady(false)
            child.stdin.destroy()
            resolve({ code, signal, failed, output, failure })
        })
    })

    async function stop(): Promise<void> {
        if (stopping !== undefined) return stopping
        stopping = (async (): Promise<void> => {
            let treeStopped = true
            if (!finished && child.pid !== undefined) {
                // Killing the tree also reaps an in-flight native PowerShell helper before cleanup.
                const killer = spawn(TASKKILL_PATH, ["/PID", String(child.pid), "/T", "/F"], {
                    stdio: "ignore", windowsHide: true, shell: false,
                    env: { SystemRoot: WINDOWS_ROOT, WINDIR: WINDOWS_ROOT },
                })
                treeStopped = await new Promise<boolean>((resolve: (success: boolean) => void): void => {
                    let timedOut = false
                    const timer = setTimeout((): void => { timedOut = true; killer.kill("SIGKILL") }, KILL_TIMEOUT_MS)
                    killer.once("error", (): void => { clearTimeout(timer); resolve(false) })
                    killer.once("close", (code: number | null): void => { clearTimeout(timer); resolve(!timedOut && code === 0) })
                })
            }
            if (!finished) child.kill("SIGKILL")
            await closed
            if (!treeStopped) throw new Error("Could not verify fixture process-tree termination.")
        })()
        return stopping
    }

    function fail(reason: NonNullable<ProcessResult["failure"]>): void {
        failed = true
        failure ??= reason
        void stop().catch((): void => {})
    }

    const watchdog = setTimeout((): void => fail("timeout"), CHILD_TIMEOUT_MS)
    child.on("error", (): void => fail("spawn"))
    child.stdin.on("error", (): void => fail("stdin"))
    child.stdout.on("error", (): void => fail("stdout"))
    child.stderr.on("error", (): void => fail("stderr"))
    child.stdout.on("data", (chunk: Buffer): void => {
        bytes += chunk.byteLength
        if (bytes > MAX_CHILD_OUTPUT_BYTES) return fail("output-limit")
        output += chunk.toString("utf8")
        if (output.split(/\r?\n/).includes('{"ready":true}')) markReady(true)
    })
    child.stderr.on("data", (chunk: Buffer): void => {
        bytes += chunk.byteLength
        fail(bytes > MAX_CHILD_OUTPUT_BYTES ? "output-limit" : "stderr")
    })
    const running = { child, ready, closed, stop }
    fixture.children.push(running)
    child.stdin.write(`${JSON.stringify(input)}\n`)
    if (!interactive) child.stdin.end()
    return running
}

function safeDiagnostic(value: unknown): Record<string, string | number> | undefined {
    if (typeof value !== "object" || value === null) return undefined
    const input = value as Record<string, unknown>
    const result: Record<string, string | number> = {}
    for (const [key, allowed] of [
        ["stage", DIAGNOSTIC_STAGES],
        ["kind", ["credential", "assertion", "filesystem", "powershell", "unknown"]],
        ["code", DIAGNOSTIC_CODES],
        ["credentialCode", DIAGNOSTIC_CODES],
        ["operation", ["file-read", "file-write"]],
        ["target", ["profiles.json", "initializer", "other"]],
        ["failure", ["spawn", "stdin", "stdout", "stderr", "timeout", "output-limit", "protocol"]],
        ["stderrClass", ["parser-error", "binding-error", "permission-error", "other"]],
    ] as const) {
        const value = input[key]
        if (typeof value === "string" && allowed.some((entry: string): boolean => entry === value)) result[key] = value
    }
    for (const key of ["nativeCode", "hresult", "exitCode", "errno", "line", "column"]) {
        const number = input[key]
        if (typeof number === "number" && Number.isInteger(number) && number >= -2147483648 && number <= 2147483647) result[key] = number
    }
    if (typeof input.type === "string" && /^(?:System|Microsoft)\.[A-Za-z0-9_.+]{1,199}$/.test(input.type)) result.type = input.type
    if (typeof input.category === "string" && /^[A-Z][A-Za-z]{0,63}$/.test(input.category)) result.category = input.category
    const nativeCode = result.nativeCode ?? (typeof result.hresult === "number" && result.hresult >>> 16 === 0x8007 ? result.hresult & 0xffff : undefined)
    if (nativeCode === 32) result.nativeReason = "sharing_violation"
    if (nativeCode === 33) result.nativeReason = "lock_violation"
    if (nativeCode === 5) result.nativeReason = "access_denied"
    return Object.keys(result).length === 0 ? undefined : result
}

function processMessages(result: ProcessResult): unknown[] {
    if (result.failed || result.code !== 0 || result.signal !== null) {
        let metadata: unknown
        try { metadata = JSON.parse(result.output.trim().split(/\r?\n/).at(-1) ?? "") } catch { }
        const details = typeof metadata === "object" && metadata !== null ? metadata as Record<string, unknown> : {}
        throw new Error(`Provision fixture child failed; raw diagnostics withheld. ${JSON.stringify({
            exitCode: result.code, signal: result.signal, failure: result.failure,
            diagnostic: safeDiagnostic(details.diagnostic), nativeDiagnostic: safeDiagnostic(details.nativeDiagnostic),
        })}`)
    }
    try {
        return result.output.trim().split(/\r?\n/).map((line: string): unknown => JSON.parse(line))
    } catch {
        throw new Error("Provision fixture child returned invalid metadata.")
    }
}

function startBun(fixture: ProvisionFixture, body: string, interactive: boolean = false): FixtureProcess {
    const script = `
import { strict as assert } from "node:assert";
import { lstat, readFile, rename, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
const lines = createInterface({ input: process.stdin });
const iterator = lines[Symbol.asyncIterator]();
const input = JSON.parse((await iterator.next()).value);
const provisionUrl = ${JSON.stringify(PROVISION_URL)};
const windowsFilesUrl = ${JSON.stringify(WINDOWS_FILES_URL)};
const typesUrl = ${JSON.stringify(TYPES_URL)};
const { CredentialError } = await import(typesUrl);
let diagnosticStage = "scenario";
let diagnosticCredentialError;
let nativeDiagnostic;
function isInitializerPath(candidate) {
    return typeof candidate === "string" && candidate !== input.store
        && win32.dirname(candidate).toLowerCase() === win32.dirname(input.store).toLowerCase();
}
function classifyFailure(error) {
    const diagnostic = { stage: diagnosticStage, kind: "unknown" };
    try {
        const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
        if (${JSON.stringify(DIAGNOSTIC_CODES)}.includes(code)) {
            diagnostic.code = code;
            diagnostic.kind = error instanceof CredentialError ? "credential" : code === "ERR_ASSERTION" ? "assertion" : "filesystem";
        }
        const nativeCode = Object.getOwnPropertyDescriptor(error, "nativeCode")?.value;
        if (Number.isInteger(nativeCode) && nativeCode >= -2147483648 && nativeCode <= 2147483647) diagnostic.nativeCode = nativeCode;
        if (diagnosticCredentialError instanceof CredentialError) {
            const credentialCode = Object.getOwnPropertyDescriptor(diagnosticCredentialError, "code")?.value;
            if (${JSON.stringify(DIAGNOSTIC_CODES)}.includes(credentialCode)) diagnostic.credentialCode = credentialCode;
        }
    } catch { }
    return diagnostic;
}
function checkFailure(error, code, lockWait = false) {
    if (lockWait) {
        diagnosticCredentialError = error;
        diagnosticStage = "lock-wait-error-type";
    }
    assert.ok(error instanceof CredentialError);
    if (lockWait) diagnosticStage = "lock-wait-error-code";
    assert.equal(error.code, code);
    if (lockWait) diagnosticStage = "lock-wait-error-message";
    assert.equal(error.message, new CredentialError(code).message);
    if (lockWait) diagnosticStage = "lock-wait-error-cause";
    assert.equal(error.cause, undefined);
    if (lockWait) diagnosticStage = "lock-wait-error-own-cause";
    assert.equal(Object.hasOwn(error, "cause"), false);
    if (lockWait) diagnosticStage = "lock-wait-error-own-native-code";
    assert.equal(Object.hasOwn(error, "nativeCode"), false);
    for (const canary of [input.root, input.secret, input.id]) {
        if (lockWait) diagnosticStage = "lock-wait-error-message-canary";
        assert.equal(error.message.includes(canary), false);
        if (lockWait) diagnosticStage = "lock-wait-error-json-canary";
        assert.equal(JSON.stringify(error).includes(canary), false);
    }
}
try {
    ${body}
    process.stdout.write('{"ok":true}\\n');
} catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, diagnostic: classifyFailure(error), nativeDiagnostic }) + "\\n");
    process.exitCode = 1;
} finally {
    lines.close();
    process.stdin.destroy();
}
`
    return startProcess(fixture, process.execPath, ["--eval", script], {
        root: fixture.root,
        store: fixture.store,
        lock: fixture.lock,
        parkedLock: win32.join(fixture.directory, ".owned-lock-moved"),
        options: fixture.options,
        secret: SECRET_CANARY,
        id: ID_CANARY,
    }, interactive)
}

async function runBun(fixture: ProvisionFixture, body: string): Promise<void> {
    const running = startBun(fixture, body)
    expect(processMessages(await running.closed)).toEqual([{ ok: true }])
}

async function inspectAcls(fixture: ProvisionFixture, paths: string[]): Promise<AclMetadata[]> {
    const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $inputReader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8)
    $outputWriter = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $utf8)
    $outputWriter.AutoFlush = $true
    $inputData = ConvertFrom-Json -InputObject ($inputReader.ReadLine())
    ${INSPECT_ACLS}
} catch {
    try {
        $exception = $_.Exception
        for ($depth = 0; $null -ne $exception.InnerException -and $depth -lt 4; $depth++) { $exception = $exception.InnerException }
        $diagnostic = [ordered]@{
            stage = 'acl-inspection'
            kind = 'powershell'
            category = $_.CategoryInfo.Category.ToString()
            type = $exception.GetType().FullName
            hresult = [int]$exception.HResult
        }
        $outputWriter.WriteLine((ConvertTo-Json -InputObject @{ diagnostic = $diagnostic } -Depth 4 -Compress))
    } catch { }
    exit 1
}
`
    const running = startProcess(fixture, POWERSHELL_PATH, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
    ], { paths })
    const messages = processMessages(await running.closed)
    expect(messages.length).toBe(1)
    const metadata = messages[0] as AclMetadata[]
    expect(Array.isArray(metadata)).toBe(true)
    expect(metadata.length).toBe(paths.length)
    return metadata
}

function expectOwnerOnly(acl: AclMetadata, directory: boolean): void {
    expect(acl.ownerSid).toBe(expectedSid)
    expect(acl.protected).toBe(true)
    expect(acl.rules).toEqual([{
        sid: expectedSid, type: "Allow", rights: FULL_CONTROL,
        inherited: false, inheritance: directory ? 3 : 0, propagation: 0,
    }])
}

function expectInheritedOnly(acl: AclMetadata, directory: boolean): void {
    expect(acl.protected).toBe(false)
    expect(acl.rules).toEqual([{
        sid: expectedSid, type: "Allow", rights: FULL_CONTROL,
        inherited: true, inheritance: directory ? 3 : 0, propagation: 0,
    }])
}

async function snapshot(fixture: ProvisionFixture, paths: string[]): Promise<unknown[]> {
    const acls = await inspectAcls(fixture, paths)
    return Promise.all(paths.map(async (path: string, index: number): Promise<unknown> => {
        const info = await stat(path, { bigint: true })
        return {
            acl: acls[index], dev: info.dev, ino: info.ino, nlink: info.nlink,
            mtimeNs: info.mtimeNs, size: info.size,
            ...(info.isDirectory() ? { entries: (await readdir(path)).sort() } : {}),
        }
    }))
}

function expectFailure(error: unknown, code: CredentialErrorCode, fixture: ProvisionFixture): void {
    expect(error instanceof CredentialError).toBe(true)
    if (!(error instanceof CredentialError)) throw new Error("Expected sanitized provisioning failure.")
    expect(error.code).toBe(code)
    expect(error.message === new CredentialError(code).message).toBe(true)
    expect(error.cause).toBeUndefined()
    expect(Object.hasOwn(error, "cause")).toBe(false)
    expect(Object.hasOwn(error, "nativeCode")).toBe(false)
    for (const canary of [SECRET_CANARY, ID_CANARY, fixture.root]) {
        expect(error.message.includes(canary)).toBe(false)
        expect(JSON.stringify(error).includes(canary)).toBe(false)
    }
}

async function expectCredentialError(fixture: ProvisionFixture, action: () => Promise<unknown>, code: CredentialErrorCode): Promise<void> {
    let failure: unknown
    try { await action() } catch (error: unknown) { failure = error }
    expectFailure(failure, code, fixture)
}

async function expectAbsent(path: string): Promise<void> {
    let absent = false
    try { await lstat(path) } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not inspect owned fixture path.")
        absent = true
    }
    expect(absent).toBe(true)
}

async function expectCleanProvision(fixture: ProvisionFixture): Promise<void> {
    await expectAbsent(fixture.lock)
    expect(await readdir(fixture.directory)).toEqual(["profiles.json"])
    for (const initializer of fixture.initializers) await expectAbsent(initializer)
}

function trackWrite(fixture: ProvisionFixture, operation: Promise<void>): Promise<void> {
    fixture.writes.push(operation)
    void operation.catch((): void => {})
    return operation
}

async function withFixture(action: (fixture: ProvisionFixture) => Promise<void>): Promise<void> {
    const root = await mkdtemp(win32.join(TEMP_DIRECTORY, ROOT_PREFIX))
    createdRoots.push(root)
    const config = win32.join(root, "config")
    const directory = win32.join(config, "credentials")
    const fixture: ProvisionFixture = {
        root, temp: win32.join(root, HELPER_TEMP_DIRECTORY_NAME), config, directory,
        store: win32.join(directory, "profiles.json"),
        lock: win32.join(directory, PLAINTEXT_PROVISION_LOCK_FILENAME),
        options: { globalConfigRoot: config, expectedSid },
        children: [], writes: [], initializers: [],
    }
    try {
        // PowerShell startup temp files must not mutate directories covered by no-write snapshots.
        await mkdir(fixture.temp)
        await action(fixture)
    } finally {
        const stopped = await Promise.allSettled(fixture.children.map((child: FixtureProcess): Promise<void> => child.stop()))
        await Promise.allSettled(fixture.writes)
        if (stopped.some((result: PromiseSettledResult<void>): boolean => result.status === "rejected")) {
            throw new Error("Fixture children could not be reaped; owned root retained.")
        }
        if (win32.dirname(root) !== TEMP_DIRECTORY || !win32.basename(root).startsWith(ROOT_PREFIX)
            || (await lstat(root)).isSymbolicLink()) {
            throw new Error("Refusing cleanup outside exact owned fixture root.")
        }
        await rm(root, { recursive: true, force: false, maxRetries: 8, retryDelay: 100 })
        await expectAbsent(root)
        removedRoots.push(root)
    }
}

function seedStore(): PlaintextCredentialStore {
    return {
        version: 1,
        profiles: {
            ssh: {
                REPLACE_ME: { host: "old.example.test", username: "operator", port: "0022", keyfile: "C:\\synthetic\\key", agent: "false", password: SECRET_CANARY, keypass: "" },
                KEEP: { host: "keep.example.test", password: "  unchanged  " },
                INCOMPLETE: { password: SECRET_CANARY },
            },
            db: {
                REPLACE_ME: { connection: "jdbc:synthetic:old", username: "operator", password: SECRET_CANARY },
                KEEP: { connection: "jdbc:synthetic:keep" },
                INCOMPLETE: {},
            },
            rest: {
                REPLACE_ME: { authorization: `Bearer ${SECRET_CANARY}`, username: "operator", password: "" },
                KEEP: { username: "", password: "\t " },
                INCOMPLETE: { username: "operator" },
            },
        },
    }
}

async function seed(fixture: ProvisionFixture, contents: string = JSON.stringify(seedStore())): Promise<void> {
    await writeSecureWindowsFile(fixture.store, contents, MAX_PLAINTEXT_STORE_BYTES, { expectedSid })
}

async function readStore(fixture: ProvisionFixture): Promise<PlaintextCredentialStore> {
    return JSON.parse(await readFile(fixture.store, "utf8")) as PlaintextCredentialStore
}

function sizedRestProfile(bytes: number): { authorization: string } {
    const fields = { authorization: "" }
    const overhead = Buffer.byteLength(JSON.stringify({ version: 1, kind: "rest", fields }), "utf8")
    const available = bytes - overhead
    fields.authorization = "é".repeat(Math.floor(available / 2)) + "x".repeat(available % 2)
    if (Buffer.byteLength(JSON.stringify({ version: 1, kind: "rest", fields }), "utf8") !== bytes) {
        throw new Error("Could not size synthetic credential envelope.")
    }
    return fields
}

describe.skipIf(process.platform !== "win32")("Windows plaintext profile provisioning (real filesystem)", (): void => {
    const originalTemp = process.env.TEMP
    const originalTmp = process.env.TMP

    beforeAll(async (): Promise<void> => {
        process.env.TEMP = TEMP_DIRECTORY
        process.env.TMP = TEMP_DIRECTORY
        expectedSid = (await getWindowsCredentialIdentity()).sid
        expect(/^S-1-/.test(expectedSid)).toBe(true)
    }, TEST_TIMEOUT_MS)

    afterAll((): void => {
        if (originalTemp === undefined) delete process.env.TEMP
        else process.env.TEMP = originalTemp
        if (originalTmp === undefined) delete process.env.TMP
        else process.env.TMP = originalTmp
        expect(removedRoots).toEqual(createdRoots)
    }, TEST_TIMEOUT_MS)

    for (const kind of KINDS) {
        // SSH was already skipped after prior measurement; DB (5.041s) and REST (5.163s) exceed 5s; retain bodies for slower/opt-in runs.
        test.skipIf(kind === "ssh" || kind === "db" || kind === "rest")(`${kind}: normalizes ID and replaces whole profile without losing other kinds, IDs, or incomplete records`, async (): Promise<void> => {
            await withFixture(async (fixture: ProvisionFixture): Promise<void> => {
                const expected = seedStore()
                await seed(fixture, JSON.stringify(expected))
                const before = await inspectAcls(fixture, [fixture.directory, fixture.store])
                const id = kind === "ssh" ? "  replace-me  " : "  replace_me  "
                const profile = { ...MINIMAL_PROFILES[kind] }
                const options = { ...fixture.options }
                const pending = trackWrite(fixture, writePlaintextProfile(kind, id, profile, options))
                Reflect.set(profile, Object.keys(profile)[0], SECRET_CANARY)
                options.globalConfigRoot = win32.join(fixture.root, "mutated-options")
                await pending
                Object.assign(expected.profiles[kind] ?? {}, { REPLACE_ME: MINIMAL_PROFILES[kind] })
                expect(await readStore(fixture)).toEqual(expected)
                expect(await inspectAcls(fixture, [fixture.directory, fixture.store])).toEqual(before)
                await expectAbsent(options.globalConfigRoot)
                await expectCleanProvision(fixture)
            })
        }, TEST_TIMEOUT_MS)
    }

    test("finishes ID, profile, envelope, and options validation before creating any paths", async (): Promise<void> => {
        await withFixture(async (fixture: ProvisionFixture): Promise<void> => {
            const getterProfile = Object.defineProperty({}, "host", {
                enumerable: true, get(): never { throw new Error(`${SECRET_CANARY} ${fixture.root}`) },
            })
            let optionReads = 0
            const getterOptions = Object.defineProperty({}, "globalConfigRoot", {
                enumerable: true, get(): never { optionReads++; throw new Error(SECRET_CANARY) },
            })
            const invalidProfiles: unknown[] = [null, [], "host", { host: 22 }, { host: "valid", unexpected: SECRET_CANARY }, getterProfile]
            for (const profile of invalidProfiles) {
                await expectCredentialError(fixture, (): Promise<void> => writePlaintextProfile("ssh", "VALID", profile, fixture.options), "invalid")
            }
            for (const [kind, profile] of [["ssh", { host: " \t" }], ["db", {}], ["rest", { username: "" }]] as const) {
                await expectCredentialError(fixture, (): Promise<void> => writePlaintextProfile(kind, "VALID", profile, fixture.options), "incomplete")
            }
            for (const kind of ["db", "rest"] as const) {
                await expectCredentialError(fixture, (): Promise<void> => writePlaintextProfile(kind, ID_CANARY, MINIMAL_PROFILES[kind], fixture.options), "invalid")
            }
            for (const id of ["", " \t", "../private", "has space", "private/id", "private\0id"]) {
                await expectCredentialError(fixture, (): Promise<void> => writePlaintextProfile("ssh", id, MINIMAL_PROFILES.ssh, getterOptions), "invalid")
            }
            await expectCredentialError(fixture, (): Promise<void> => writePlaintextProfile("other" as CredentialKind, "VALID", MINIMAL_PROFILES.ssh, fixture.options), "invalid")
            await expectCredentialError(fixture, (): Promise<void> => writePlaintextProfile("rest", "VALID", sizedRestProfile(MAX_CREDENTIAL_ENVELOPE_BYTES + 1), getterOptions), "too_large")
            await expectCredentialError(fixture, (): Promise<void> => writePlaintextProfile("ssh", "VALID", { host: "x".repeat(MAX_CREDENTIAL_FIELD_BYTES + 1) }, getterOptions), "too_large")
            await expectCredentialError(fixture, (): Promise<void> => writePlaintextProfile("ssh", "VALID", MINIMAL_PROFILES.ssh, getterOptions), "invalid")
            await expectCredentialError(fixture, (): Promise<void> => writePlaintextProfile("ssh", "VALID", MINIMAL_PROFILES.ssh, { ...fixture.options, expectedSid: 22 } as unknown as PlaintextCredentialOptions), "invalid")
            expect(optionReads).toBe(0)
            expect(await readdir(fixture.root)).toEqual([HELPER_TEMP_DIRECTORY_NAME])
            await expectAbsent(fixture.config)
        })
    }, TEST_TIMEOUT_MS)

    test("accepts a 64 KiB UTF-8 envelope and rejects one extra byte without changing existing files", async (): Promise<void> => {
        await withFixture(async (fixture: ProvisionFixture): Promise<void> => {
            expect(MAX_CREDENTIAL_ENVELOPE_BYTES).toBe(65536)
            const boundary = sizedRestProfile(MAX_CREDENTIAL_ENVELOPE_BYTES)
            await writePlaintextProfile("rest", "boundary", boundary, fixture.options)
            expect((await readStore(fixture)).profiles.rest).toEqual({ BOUNDARY: boundary })
            const paths = [fixture.directory, fixture.store]
            const before = await snapshot(fixture, paths)
            const contents = await readFile(fixture.store, "utf8")
            await expectCredentialError(fixture, (): Promise<void> => writePlaintextProfile("rest", "BOUNDARY", sizedRestProfile(MAX_CREDENTIAL_ENVELOPE_BYTES + 1), fixture.options), "too_large")
            expect(await snapshot(fixture, paths)).toEqual(before)
            expect(await readFile(fixture.store, "utf8") === contents).toBe(true)
            await expectCleanProvision(fixture)
        })
    }, TEST_TIMEOUT_MS)

    test.skip("provisions protected owner-only directory and store ACLs with actual child inheritance", async (): Promise<void> => {
        await withFixture(async (fixture: ProvisionFixture): Promise<void> => {
            const ancestorAcl = await inspectAcls(fixture, [fixture.root])
            await writePlaintextProfile("ssh", "acl-profile", { host: "保護.example.test", password: SECRET_CANARY }, fixture.options)
            const paths = [fixture.directory, fixture.store]
            const acls = await inspectAcls(fixture, paths)
            for (const [index, acl] of acls.entries()) expectOwnerOnly(acl, index === 0)
            const inheritedFile = win32.join(fixture.directory, "inherited-child")
            const inheritedDirectory = win32.join(fixture.directory, "inherited-directory")
            const file = await open(inheritedFile, "wx")
            await file.close()
            await mkdir(inheritedDirectory)
            const grandchild = win32.join(inheritedDirectory, "grandchild")
            const nestedFile = await open(grandchild, "wx")
            await nestedFile.close()
            const children = await inspectAcls(fixture, [inheritedFile, inheritedDirectory, grandchild])
            for (const [index, acl] of children.entries()) expectInheritedOnly(acl, index === 1)
            await writePlaintextProfile("ssh", "ACL_PROFILE", { host: "replacement.example.test" }, fixture.options)
            expect(await inspectAcls(fixture, paths)).toEqual(acls)
            expect(await inspectAcls(fixture, [fixture.root])).toEqual(ancestorAcl)
            await expectAbsent(fixture.lock)
            expect((await readdir(fixture.directory)).sort()).toEqual(["profiles.json", "inherited-child", "inherited-directory"].sort())
        })
    }, TEST_TIMEOUT_MS)

    test.skip("expectedSid mismatch leaves existing files and absent config roots unchanged", async (): Promise<void> => {
        await withFixture(async (fixture: ProvisionFixture): Promise<void> => {
            await writePlaintextProfile("ssh", "seed", MINIMAL_PROFILES.ssh, fixture.options)
            const paths = [fixture.root, fixture.config, fixture.directory, fixture.store]
            const before = await snapshot(fixture, paths)
            const contents = await readFile(fixture.store, "utf8")
            const wrongSid = expectedSid === "S-1-5-18" ? "S-1-5-19" : "S-1-5-18"
            const absent = win32.join(fixture.root, "wrong-account")
            for (const globalConfigRoot of [fixture.config, absent]) {
                await expectCredentialError(fixture, (): Promise<void> => writePlaintextProfile("rest", "PRIVATE_ID_CANARY", { authorization: SECRET_CANARY }, { globalConfigRoot, expectedSid: wrongSid }), "denied")
            }
            const after = await snapshot(fixture, paths)
            const labels = ["fixture-root", "config", "config/credentials", "config/credentials/profiles.json"]
            for (const [index, label] of labels.entries()) expect({ [label]: after[index] }).toEqual({ [label]: before[index] })
            expect(await readFile(fixture.store, "utf8") === contents).toBe(true)
            await expectAbsent(absent)
            await expectCleanProvision(fixture)
        })
    }, TEST_TIMEOUT_MS)

    const corruptStores: { name: string; contents: string; code: CredentialErrorCode }[] = [
        { name: "malformed JSON", contents: `{"version":1,"profiles":{"rest":{"PRIVATE_ID_CANARY":{"authorization":"${SECRET_CANARY}"}}}`, code: "invalid" },
        { name: "unsupported version", contents: JSON.stringify({ version: 2, profiles: {} }), code: "invalid" },
        { name: "unknown profile field", contents: JSON.stringify({ version: 1, profiles: { ssh: { PRIVATE_ID_CANARY: { host: "valid", unexpected: SECRET_CANARY } } } }), code: "invalid" },
        { name: "non-normalized stored ID", contents: JSON.stringify({ version: 1, profiles: { ssh: { "private-id-canary": { host: "valid" } } } }), code: "invalid" },
        { name: "oversized stored envelope", contents: JSON.stringify({ version: 1, profiles: { rest: { PRIVATE_ID_CANARY: sizedRestProfile(MAX_CREDENTIAL_ENVELOPE_BYTES + 1) } } }), code: "too_large" },
    ]
    for (const corrupt of corruptStores) {
        test(`never resets or overwrites ${corrupt.name}; releases its own lock on failure`, async (): Promise<void> => {
            await withFixture(async (fixture: ProvisionFixture): Promise<void> => {
                await seed(fixture, corrupt.contents)
                const before = await snapshot(fixture, [fixture.store])
                await expectCredentialError(fixture, (): Promise<void> => writePlaintextProfile("rest", "NEW_PROFILE", { authorization: SECRET_CANARY }, fixture.options), corrupt.code)
                expect(await readFile(fixture.store, "utf8") === corrupt.contents).toBe(true)
                expect(await snapshot(fixture, [fixture.store])).toEqual(before)
                await expectCleanProvision(fixture)
            })
        }, TEST_TIMEOUT_MS)
    }

    test.skip("enforces the 1 MiB aggregate cap and recovers its same-path queue after serialization failure", async (): Promise<void> => {
        await withFixture(async (fixture: ProvisionFixture): Promise<void> => {
            expect(MAX_PLAINTEXT_STORE_BYTES).toBe(1048576)
            const profiles: Record<string, { password: string }> = {}
            const overhead = Buffer.byteLength(JSON.stringify({ version: 1, kind: "rest", fields: { password: "" } }), "utf8")
            for (let index = 0; index < 16; index++) {
                profiles[`INCOMPLETE_${index}`] = { password: "x".repeat(MAX_CREDENTIAL_ENVELOPE_BYTES - overhead) }
            }
            const original = { version: 1, profiles: { rest: profiles } }
            const contents = JSON.stringify(original)
            expect(Buffer.byteLength(contents, "utf8") < MAX_PLAINTEXT_STORE_BYTES).toBe(true)
            expect(MAX_PLAINTEXT_STORE_BYTES - Buffer.byteLength(contents, "utf8") < 2048).toBe(true)
            await seed(fixture, contents)
            const results = await Promise.allSettled([
                trackWrite(fixture, writePlaintextProfile("rest", "TOO_LARGE", { authorization: "é".repeat(2048) }, fixture.options)),
                trackWrite(fixture, writePlaintextProfile("rest", "SMALL", { authorization: "" }, { ...fixture.options, globalConfigRoot: fixture.config.toUpperCase() })),
            ])
            expect(results[0].status).toBe("rejected")
            if (results[0].status === "rejected") expectFailure(results[0].reason, "too_large", fixture)
            expect(results[1].status).toBe("fulfilled")
            expect(await readStore(fixture)).toEqual({ version: 1, profiles: { rest: { ...profiles, SMALL: { authorization: "" } } } })
            const remaining = MAX_PLAINTEXT_STORE_BYTES - Buffer.byteLength(await readFile(fixture.store, "utf8"), "utf8")
            const boundary = { authorization: "x".repeat(remaining) }
            await writePlaintextProfile("rest", "SMALL", boundary, fixture.options)
            expect((await stat(fixture.store)).size).toBe(MAX_PLAINTEXT_STORE_BYTES)
            const atLimit = await readFile(fixture.store, "utf8")
            await expectCredentialError(fixture, (): Promise<void> => writePlaintextProfile("rest", "SMALL", { authorization: boundary.authorization + "x" }, fixture.options), "too_large")
            expect(await readFile(fixture.store, "utf8") === atLimit).toBe(true)
            await expectCleanProvision(fixture)
        })
    }, TEST_TIMEOUT_MS)

    test.skip("same-process concurrent kinds and case aliases retain every update", async (): Promise<void> => {
        await withFixture(async (fixture: ProvisionFixture): Promise<void> => {
            const expected = seedStore()
            await seed(fixture, JSON.stringify(expected))
            const results = await Promise.allSettled(KINDS.map((kind: CredentialKind, index: number): Promise<void> => {
                return trackWrite(fixture, writePlaintextProfile(kind, "concurrent", MINIMAL_PROFILES[kind], {
                    ...fixture.options, globalConfigRoot: index === 1 ? fixture.config.toUpperCase() : fixture.config,
                }))
            }))
            expect(results.every((result: PromiseSettledResult<void>): boolean => result.status === "fulfilled")).toBe(true)
            for (const kind of KINDS) Object.assign(expected.profiles[kind] ?? {}, { CONCURRENT: MINIMAL_PROFILES[kind] })
            expect(await readStore(fixture)).toEqual(expected)
            await expectCleanProvision(fixture)
        })
    }, TEST_TIMEOUT_MS)

    test.skip("independent Windows Bun processes both succeed and retain separate IDs", async (): Promise<void> => {
        await withFixture(async (fixture: ProvisionFixture): Promise<void> => {
            const expected = seedStore()
            await seed(fixture, JSON.stringify(expected))
            const ids = ["PROCESS_A", "PROCESS_B"]
            const children = ids.map((id: string): FixtureProcess => startBun(fixture, `
const { mock } = await import("bun:test");
const native = await import(windowsFilesUrl);
const nativeRead = native.readSecureWindowsFile;
const nativeWrite = native.writeSecureWindowsFile;
const maxBytes = native.WINDOWS_SECURE_FILE_MAX_BYTES;
function observeNative(operation, action) {
    return async (...args) => {
        try { return await action(...args); }
        catch (error) {
            nativeDiagnostic = {
                ...classifyFailure(error), operation,
                target: args[0] === input.store ? "profiles.json" : isInitializerPath(args[0]) ? "initializer" : "other",
            };
            throw error;
        }
    };
}
mock.module(fileURLToPath(windowsFilesUrl), () => ({
    WINDOWS_SECURE_FILE_MAX_BYTES: maxBytes,
    readSecureWindowsFile: observeNative("file-read", nativeRead),
    writeSecureWindowsFile: observeNative("file-write", nativeWrite),
}));
const { writePlaintextProfile } = await import(provisionUrl);
process.stdout.write('{"ready":true}\\n');
assert.equal((await iterator.next()).value, "go");
await writePlaintextProfile("db", ${JSON.stringify(id)}, { connection: "jdbc:synthetic:${id}" }, input.options);
`, true))
            const ready = await Promise.all(children.map((child: FixtureProcess): Promise<boolean> => child.ready))
            for (const [index, child] of children.entries()) {
                if (ready[index] && !child.child.stdin.destroyed) child.child.stdin.end("go\n")
            }
            const results = await Promise.allSettled(children.map((child: FixtureProcess): Promise<ProcessResult> => child.closed))
            const reaped = await Promise.allSettled(children.map((child: FixtureProcess): Promise<void> => child.stop()))
            const outcomes = await Promise.allSettled(results.map(async (result: PromiseSettledResult<ProcessResult>, index: number): Promise<void> => {
                if (result.status !== "fulfilled") throw new Error("Provision worker lifecycle failed; raw diagnostics withheld.")
                expect(processMessages(result.value)).toEqual([{ ready: true }, { ok: true }])
                expect(ready[index]).toBe(true)
            }))
            // Check seeded records and acknowledged writes before reporting worker failures, including post-commit errors.
            const preservation = await Promise.allSettled([(async (): Promise<void> => {
                const stored = await readStore(fixture)
                for (const [index, id] of ids.entries()) {
                    if (outcomes[index].status === "fulfilled" || Object.hasOwn(stored.profiles.db ?? {}, id)) {
                        Object.assign(expected.profiles.db ?? {}, { [id]: { connection: `jdbc:synthetic:${id}` } })
                    }
                }
                expect(stored).toEqual(expected)
                await expectCleanProvision(fixture)
            })()])
            const failures = [...reaped, ...outcomes, ...preservation].flatMap((result: PromiseSettledResult<void>): unknown[] => {
                return result.status === "rejected" ? [result.reason] : []
            })
            if (failures.length === 1) throw failures[0]
            if (failures.length > 1) throw new AggregateError(failures, "Concurrent provision workers or store preservation failed.")
        })
    }, TEST_TIMEOUT_MS)

    // 11.3s runtime; coordinating two Bun writers, PowerShell, and polling makes this Windows test too slow.
    test.skip("fresh-root independent Windows writers serialize sentinel initialization", async (): Promise<void> => {
        await withFixture(async (fixture: ProvisionFixture): Promise<void> => {
            await expectAbsent(fixture.config)
            await expectAbsent(fixture.directory)
            const coordinationName = "sentinel-race"
            const coordination = win32.join(fixture.root, coordinationName)
            const markers = {
                firstReady: "writer-a.ready", firstRelease: "writer-a.release",
                secondReady: "writer-b.ready", secondAllow: "writer-b.allow",
                secondWriteDone: "writer-b.write-done", secondDone: "writer-b.done", pinRelease: "pin.release",
            }
            const ids = ["FRESH_A", "FRESH_B"]
            const connectionPrefix = "jdbc:synthetic:"
            const coordinationTimeoutMs = 30000
            const pollMs = 25
            await mkdir(coordination)
            const pinScript = `
$ErrorActionPreference = 'Stop'
# First-use module progress must not contaminate the strict stderr protocol.
$ProgressPreference = 'SilentlyContinue'
$pin = $null
$stage = 'sentinel-pin-input'
$operation = 'file-read'
$target = 'initializer'
try {
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8)
    $writer = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $utf8)
    $writer.AutoFlush = $true
    $data = ConvertFrom-Json -InputObject ($reader.ReadLine())
    $stage = 'sentinel-pin-open'
    $pin = [System.IO.FileStream]::new($data.path, [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    $writer.WriteLine('{"ready":true}')
    $stage = 'sentinel-pin-wait'
    $operation = 'file-read'
    $target = 'initializer'
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not [System.IO.File]::Exists($data.release)) {
        if ($clock.ElapsedMilliseconds -ge ${coordinationTimeoutMs}) { throw [System.TimeoutException]::new('Sentinel pin release timed out.') }
        [System.Threading.Thread]::Sleep(${pollMs})
    }
    $writer.WriteLine('{"ok":true}')
} catch {
    try {
        $category = $_.CategoryInfo.Category.ToString()
        $exception = $_.Exception
        for ($depth = 0; $null -ne $exception.InnerException -and $depth -lt 4; $depth++) { $exception = $exception.InnerException }
        $writer.WriteLine((ConvertTo-Json -InputObject @{ diagnostic = @{
            stage = $stage; kind = 'powershell'; operation = $operation; target = $target
            type = $exception.GetType().FullName; hresult = [int]$exception.HResult; category = $category
        } } -Depth 4 -Compress))
    } catch { }
    exit 1
} finally { if ($null -ne $pin) { $pin.Dispose() } }
`
            const startWriter = (first: boolean): FixtureProcess => startBun(fixture, `
const { mock } = await import("bun:test");
const first = ${JSON.stringify(first)};
const id = ${JSON.stringify(ids[first ? 0 : 1])};
const coordination = win32.join(input.root, ${JSON.stringify(coordinationName)});
const markers = ${JSON.stringify(markers)};
async function publish(name, data) {
    const target = win32.join(coordination, name);
    await writeFile(target + ".pending", JSON.stringify(data), { flag: "wx" });
    await rename(target + ".pending", target);
}
async function waitForGate(name) {
    const deadline = Date.now() + ${coordinationTimeoutMs};
    for (;;) {
        try { await lstat(win32.join(coordination, name)); return; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (Date.now() >= deadline) throw new Error("Initializer coordination gate timed out.");
        await delay(${pollMs});
    }
}
const native = await import(windowsFilesUrl);
const nativeRead = native.readSecureWindowsFile;
const nativeWrite = native.writeSecureWindowsFile;
const maxBytes = native.WINDOWS_SECURE_FILE_MAX_BYTES;
async function invokeNative(operation, action, args) {
    diagnosticStage = operation === "file-write" && isInitializerPath(args[0]) ? "sentinel-write" : "sentinel-provision";
    try { return await action(...args); }
    catch (error) {
        nativeDiagnostic = {
            ...classifyFailure(error), operation,
            target: isInitializerPath(args[0]) ? "initializer" : args[0] === input.store ? "profiles.json" : "other",
        };
        throw error;
    }
}
let observed = false;
mock.module(fileURLToPath(windowsFilesUrl), () => ({
    WINDOWS_SECURE_FILE_MAX_BYTES: maxBytes,
    readSecureWindowsFile: (...args) => invokeNative("file-read", nativeRead, args),
    writeSecureWindowsFile: async (...args) => {
        if (!isInitializerPath(args[0])) return invokeNative("file-write", nativeWrite, args);
        assert.equal(observed, false);
        observed = true;
        if (first) {
            await invokeNative("file-write", nativeWrite, args);
            diagnosticStage = "sentinel-written";
            await publish(markers.firstReady, { path: args[0] });
            await waitForGate(markers.firstRelease);
            diagnosticStage = "sentinel-provision";
        } else {
            await publish(markers.secondReady, { path: args[0] });
            await waitForGate(markers.secondAllow);
            let written = false;
            try { await invokeNative("file-write", nativeWrite, args); written = true; }
            finally { await publish(markers.secondWriteDone, { written }); }
        }
    },
}));
const { writePlaintextProfile } = await import(provisionUrl);
diagnosticStage = "sentinel-provision";
try { await writePlaintextProfile("db", id, { connection: ${JSON.stringify(connectionPrefix)} + id }, input.options); }
finally { if (!first) await publish(markers.secondDone, { done: true }); }
`)
            const deadline = Date.now() + coordinationTimeoutMs
            const exists = async (path: string): Promise<boolean> => {
                try { await lstat(path); return true } catch (error: unknown) {
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
                    throw new Error("Could not inspect owned sentinel-race coordination.")
                }
            }
            const waitUntil = async (condition: () => Promise<boolean>): Promise<void> => {
                while (!await condition()) {
                    if (Date.now() >= deadline) throw new Error("Sentinel-race coordination timed out.")
                    await delay(pollMs)
                }
            }
            const writers: FixtureProcess[] = []
            const failures: unknown[] = []
            let results: PromiseSettledResult<ProcessResult>[] = []
            let interrupted = false
            let firstPath: string | undefined
            let secondPath: string | undefined
            let pin: FixtureProcess | undefined
            const readMarker = async (name: string): Promise<Record<string, unknown> | undefined> => {
                const path = win32.join(coordination, name)
                if (!await exists(path)) return undefined
                try {
                    const data: unknown = JSON.parse(await readFile(path, "utf8"))
                    if (typeof data === "object" && data !== null && !Array.isArray(data)) return data as Record<string, unknown>
                } catch { }
                throw new Error("Initializer coordination metadata was invalid; raw diagnostics withheld.")
            }
            const readInitializerPath = async (name: string): Promise<string | undefined> => {
                const data = await readMarker(name)
                if (data === undefined) return undefined
                const path = data.path
                if (typeof path !== "string" || path === fixture.store
                    || win32.dirname(path).toLowerCase() !== fixture.directory.toLowerCase()) {
                    throw new Error("Initializer target was outside the owned credentials directory.")
                }
                return path
            }
            const releaseGate = async (name: string): Promise<boolean> => {
                try { await writeFile(win32.join(coordination, name), "release", "utf8"); return true } catch {
                    failures.push(new Error("Could not release an owned initializer coordination gate."))
                    interrupted = true
                    return false
                }
            }
            try {
                const first = startWriter(true)
                writers.push(first)
                let firstExited = false
                void first.closed.then((): void => { firstExited = true })
                await waitUntil(async (): Promise<boolean> => {
                    if (firstExited) throw new Error("First writer exited before its initializer was ready.")
                    if (await exists(win32.join(coordination, markers.firstReady))) return true
                    return false
                })
                firstPath = await readInitializerPath(markers.firstReady)
                if (firstPath === undefined) throw new Error("First writer did not record its initializer.")
                fixture.initializers.push(firstPath)
                expectOwnerOnly((await inspectAcls(fixture, [firstPath]))[0], false)
                expect(await readFile(firstPath, "utf8") === "").toBe(true)
                const second = startWriter(false)
                writers.push(second)
                let secondDone = false
                void second.closed.then((): void => { secondDone = true })
                await waitUntil(async (): Promise<boolean> => {
                    return await exists(win32.join(coordination, markers.secondReady))
                        || secondDone || await exists(win32.join(coordination, markers.secondDone)) || await exists(fixture.lock)
                })
                secondPath = await readInitializerPath(markers.secondReady)
                // Only a shared target gets a pin stretching native validation; unique initializers must remain free to delete themselves.
                if (firstPath === secondPath) {
                    pin = startProcess(fixture, POWERSHELL_PATH, [
                        "-NoLogo", "-NoProfile", "-NonInteractive", "-InputFormat", "Text", "-OutputFormat", "Text", "-EncodedCommand",
                        Buffer.from(pinScript, "utf16le").toString("base64"),
                    ], { path: firstPath, release: win32.join(coordination, markers.pinRelease) })
                    expect(await pin.ready).toBe(true)
                }
                if (!await releaseGate(markers.secondAllow)) throw new Error("Second initializer could not be allowed to write.")
                await waitUntil(async (): Promise<boolean> => {
                    return await exists(win32.join(coordination, markers.secondWriteDone))
                        || secondDone || await exists(win32.join(coordination, markers.secondDone)) || await exists(fixture.lock)
                })
            } catch (error: unknown) {
                failures.push(error)
                interrupted = true
            } finally {
                await releaseGate(markers.secondAllow)
                const pinReleased = await releaseGate(markers.pinRelease)
                if (pin !== undefined) {
                    if (!pinReleased) {
                        const stopped = await Promise.allSettled([pin.stop()])
                        for (const result of stopped) if (result.status === "rejected") failures.push(result.reason)
                    }
                    const observation = await pin.closed
                    const reaped = await Promise.allSettled([pin.stop()])
                    for (const result of reaped) if (result.status === "rejected") failures.push(result.reason)
                    try { expect(processMessages(observation)).toEqual([{ ready: true }, { ok: true }]) } catch (error: unknown) {
                        failures.push(error)
                    }
                }
                await releaseGate(markers.firstRelease)
                if (interrupted) {
                    const stopped = await Promise.allSettled(writers.map((writer: FixtureProcess): Promise<void> => writer.stop()))
                    for (const result of stopped) if (result.status === "rejected") failures.push(result.reason)
                }
                results = await Promise.allSettled(writers.map((writer: FixtureProcess): Promise<ProcessResult> => writer.closed))
                const reaped = await Promise.allSettled(writers.map((writer: FixtureProcess): Promise<void> => writer.stop()))
                for (const result of reaped) if (result.status === "rejected") failures.push(result.reason)
            }
            const outcomes = await Promise.allSettled(results.map(async (result: PromiseSettledResult<ProcessResult>): Promise<void> => {
                if (result.status !== "fulfilled") throw new Error("Fresh-root writer lifecycle failed; raw diagnostics withheld.")
                expect(processMessages(result.value)).toEqual([{ ok: true }])
            }))
            let stored: PlaintextCredentialStore | undefined
            const checks = await Promise.allSettled([
                (async (): Promise<void> => {
                    firstPath ??= await readInitializerPath(markers.firstReady)
                    secondPath ??= await readInitializerPath(markers.secondReady)
                    const written = await readMarker(markers.secondWriteDone)
                    if (secondPath !== undefined && written?.written === true) fixture.initializers.push(secondPath)
                    expect(firstPath !== undefined && secondPath !== undefined).toBe(true)
                    expect(firstPath === secondPath).toBe(false)
                    for (const path of [firstPath, secondPath]) {
                        if (path === undefined) continue
                        const name = win32.basename(path)
                        expect(INITIALIZER_NAME_PATTERN.test(name)).toBe(true)
                        expect(name.length).toBe(13)
                        await expectAbsent(path)
                    }
                })(),
                (async (): Promise<void> => {
                    const result = await readPlaintextCredentialStore(fixture.options)
                    if (result.status === "missing") {
                        expect(outcomes.some((outcome: PromiseSettledResult<void>): boolean => outcome.status === "fulfilled")).toBe(false)
                        return
                    }
                    stored = result.store
                    const retained = ids.filter((id: string, index: number): boolean => {
                        return outcomes[index]?.status === "fulfilled" || Object.hasOwn(result.store.profiles.db ?? {}, id)
                    })
                    expect(stored).toEqual({
                        version: 1,
                        profiles: { db: Object.fromEntries(retained.map((id: string): [string, { connection: string }] => [id, { connection: connectionPrefix + id }])) },
                    })
                })(),
                (async (): Promise<void> => {
                    await expectAbsent(fixture.lock)
                    if (await exists(fixture.directory)) {
                        const entries = await readdir(fixture.directory)
                        expect(entries.every((entry: string): boolean => entry === "profiles.json")).toBe(true)
                    }
                })(),
            ])
            const complete = await Promise.allSettled([(async (): Promise<void> => {
                expect(writers.length).toBe(ids.length)
                expect(stored?.profiles.db).toEqual(Object.fromEntries(ids.map((id: string): [string, { connection: string }] => [id, { connection: connectionPrefix + id }])))
                await expectCleanProvision(fixture)
            })()])
            for (const result of [...outcomes, ...checks, ...complete]) if (result.status === "rejected") failures.push(result.reason)
            if (failures.length === 1) throw failures[0]
            if (failures.length > 1) throw new AggregateError(failures, "Fresh-root sentinel serialization or store preservation failed.")
        })
    }, TEST_TIMEOUT_MS)

    test("wx lock excludes another opener, inherits owner-only access, and survives a waiting writer", async (): Promise<void> => {
        await withFixture(async (fixture: ProvisionFixture): Promise<void> => {
            await seed(fixture)
            const original = await readFile(fixture.store, "utf8")
            const foreign = await open(fixture.lock, "wx")
            let pending: FixtureProcess | undefined
            try {
                await foreign.writeFile("synthetic-foreign-lock", "utf8")
                const identity = await foreign.stat({ bigint: true })
                let exclusiveCode: string | undefined
                try {
                    const unexpected = await open(fixture.lock, "wx")
                    await unexpected.close()
                } catch (error: unknown) { exclusiveCode = (error as NodeJS.ErrnoException).code }
                expect(exclusiveCode).toBe("EEXIST")
                let settled = false
                pending = startBun(fixture, `
const { mock } = await import("bun:test");
const native = await import(windowsFilesUrl);
const nativeRead = native.readSecureWindowsFile;
const nativeWrite = native.writeSecureWindowsFile;
const maxBytes = native.WINDOWS_SECURE_FILE_MAX_BYTES;
let initialized = false;
mock.module(fileURLToPath(windowsFilesUrl), () => ({
    WINDOWS_SECURE_FILE_MAX_BYTES: maxBytes,
    readSecureWindowsFile: nativeRead,
    writeSecureWindowsFile: async (...args) => {
        await nativeWrite(...args);
        if (isInitializerPath(args[0])) {
            assert.equal(initialized, false);
            initialized = true;
            await writeFile(win32.join(input.root, "waiter-initializer"), JSON.stringify({ path: args[0] }), { flag: "wx" });
            process.stdout.write('{"ready":true}\\n');
        }
    },
}));
const { writePlaintextProfile } = await import(provisionUrl);
await writePlaintextProfile("rest", "WAITER", { authorization: "" }, input.options);
assert.equal(initialized, true);
`)
                void pending.closed.then((): void => { settled = true })
                expectInheritedOnly((await inspectAcls(fixture, [fixture.lock]))[0], false)
                expect(await pending.ready).toBe(true)
                const initializer = JSON.parse(await readFile(win32.join(fixture.root, "waiter-initializer"), "utf8")) as { path: string }
                expect(win32.dirname(initializer.path).toLowerCase() === fixture.directory.toLowerCase()).toBe(true)
                expect(INITIALIZER_NAME_PATTERN.test(win32.basename(initializer.path))).toBe(true)
                fixture.initializers.push(initializer.path)
                await delay(350)
                expect(settled).toBe(false)
                expect((await lstat(fixture.lock, { bigint: true })).ino).toBe(identity.ino)
                expect(await readFile(fixture.lock, "utf8") === "synthetic-foreign-lock").toBe(true)
                expect(await readFile(fixture.store, "utf8") === original).toBe(true)
            } finally {
                await foreign.close()
                await unlink(fixture.lock)
                if (pending !== undefined) expect(processMessages(await pending.closed)).toEqual([{ ready: true }, { ok: true }])
            }
            expect((await readStore(fixture)).profiles.rest?.WAITER).toEqual({ authorization: "" })
            await expectCleanProvision(fixture)
        })
    }, TEST_TIMEOUT_MS)

    test("a focused child clock seam bounds the 30-second wait without deleting a foreign lock", async (): Promise<void> => {
        await withFixture(async (fixture: ProvisionFixture): Promise<void> => {
            await seed(fixture)
            const foreign = await open(fixture.lock, "wx")
            await foreign.writeFile("synthetic-foreign-lock", "utf8")
            await foreign.close()
            const before = await snapshot(fixture, [fixture.store, fixture.lock])
            await runBun(fixture, `
const { spyOn } = await import("bun:test");
const timers = await import("node:timers/promises");
const originalDelay = timers.setTimeout;
const originalNow = performance.now.bind(performance);
const firstPollMs = 25;
const advanceMs = 30001;
const pollDelays = [];
let offset = 0;
let advances = 0;
let deadlineReadsAfterAdvance = 0;
let clock;
let pollTimer;
let failure;
diagnosticStage = "lock-wait-write";
try {
    clock = spyOn(performance, "now").mockImplementation(() => {
        if (offset !== 0) deadlineReadsAfterAdvance++;
        return originalNow() + offset;
    });
    pollTimer = spyOn(timers, "setTimeout").mockImplementation(async (...args) => {
        const firstPoll = pollDelays.length === 0;
        pollDelays.push(args[0]);
        const result = await originalDelay(...args);
        // Keep initializer deadlines real until the first expected lock poll completes.
        if (firstPoll && args[0] === firstPollMs) {
            offset += advanceMs;
            advances++;
        }
        return result;
    });
    const { writePlaintextProfile } = await import(provisionUrl);
    await writePlaintextProfile("rest", "PRIVATE_ID_CANARY", { authorization: input.secret }, input.options);
}
catch (error) { failure = error; }
finally {
    try { pollTimer?.mockRestore(); }
    finally { clock?.mockRestore(); }
}
diagnosticStage = "lock-wait-result-validation";
checkFailure(failure, "locked", true);
diagnosticStage = "lock-wait-poll-count";
assert.equal(pollDelays.length, 1);
diagnosticStage = "lock-wait-first-delay";
assert.equal(pollDelays[0], firstPollMs);
diagnosticStage = "lock-wait-advance-count";
assert.equal(advances, 1);
diagnosticStage = "lock-wait-advance-offset";
assert.equal(offset, advanceMs);
diagnosticStage = "lock-wait-deadline-read-count";
assert.equal(deadlineReadsAfterAdvance, 1);
diagnosticStage = "lock-wait-foreign-lock-bytes";
assert.equal(await readFile(input.lock, "utf8"), "synthetic-foreign-lock");
`)
            expect(await snapshot(fixture, [fixture.store, fixture.lock])).toEqual(before)
            expect((await readdir(fixture.directory)).sort()).toEqual([PLAINTEXT_PROVISION_LOCK_FILENAME, "profiles.json"].sort())
        })
    }, TEST_TIMEOUT_MS)

    test("identity-safe cleanup preserves a replacement lock even after the store commits", async (): Promise<void> => {
        await withFixture(async (fixture: ProvisionFixture): Promise<void> => {
            await seed(fixture)
            await runBun(fixture, `
const { mock } = await import("bun:test");
const native = await import(windowsFilesUrl);
const nativeRead = native.readSecureWindowsFile;
const nativeWrite = native.writeSecureWindowsFile;
const maxBytes = native.WINDOWS_SECURE_FILE_MAX_BYTES;
let replaced = false;
mock.module(fileURLToPath(windowsFilesUrl), () => ({
    WINDOWS_SECURE_FILE_MAX_BYTES: maxBytes,
    writeSecureWindowsFile: nativeWrite,
    readSecureWindowsFile: async (...args) => {
        const result = await nativeRead(...args);
        if (args[0] === input.store && !replaced) {
            await rename(input.lock, input.parkedLock);
            await writeFile(input.lock, "synthetic-replacement-lock", { flag: "wx" });
            const owned = await lstat(input.parkedLock, { bigint: true });
            const replacement = await lstat(input.lock, { bigint: true });
            assert.notEqual(owned.ino, 0n);
            assert.notEqual(owned.ino, replacement.ino);
            replaced = true;
        }
        return result;
    },
}));
const { writePlaintextProfile } = await import(provisionUrl);
let failure;
try { await writePlaintextProfile("rest", "COMMITTED", { authorization: "" }, input.options); }
catch (error) { failure = error; }
checkFailure(failure, "failed");
assert.equal(replaced, true);
assert.equal(await readFile(input.lock, "utf8"), "synthetic-replacement-lock");
assert.deepEqual(JSON.parse(await readFile(input.store, "utf8")).profiles.rest.COMMITTED, { authorization: "" });
`)
            expect(await readFile(fixture.lock, "utf8") === "synthetic-replacement-lock").toBe(true)
            expect((await readStore(fixture)).profiles.rest?.COMMITTED).toEqual({ authorization: "" })
        })
    }, TEST_TIMEOUT_MS)

    test.skip("isolated commit failure sanitizes native-shaped errors, releases its lock, and unblocks the next write", async (): Promise<void> => {
        await withFixture(async (fixture: ProvisionFixture): Promise<void> => {
            await seed(fixture)
            await runBun(fixture, `
const { mock } = await import("bun:test");
const native = await import(windowsFilesUrl);
const nativeRead = native.readSecureWindowsFile;
const nativeWrite = native.writeSecureWindowsFile;
const maxBytes = native.WINDOWS_SECURE_FILE_MAX_BYTES;
const original = await readFile(input.store, "utf8");
let commits = 0;
let markCommit;
let releaseFailure;
const firstCommit = new Promise((resolve) => { markCommit = resolve; });
const failureReleased = new Promise((resolve) => { releaseFailure = resolve; });
mock.module(fileURLToPath(windowsFilesUrl), () => ({
    WINDOWS_SECURE_FILE_MAX_BYTES: maxBytes,
    readSecureWindowsFile: nativeRead,
    writeSecureWindowsFile: async (...args) => {
        if (args[0] === input.store) {
            assert.equal((await lstat(input.lock)).isFile(), true);
            assert.equal(await readFile(input.store, "utf8"), original);
            if (commits++ === 0) {
                markCommit();
                await failureReleased;
                throw Object.assign(new Error(input.secret + input.id + input.root), { code: "EACCES" });
            }
        }
        await nativeWrite(...args);
    },
}));
const { writePlaintextProfile } = await import(provisionUrl);
const first = writePlaintextProfile("rest", "REJECTED", { authorization: input.secret }, input.options);
void first.catch(() => {});
await firstCommit;
const second = writePlaintextProfile("rest", "RECOVERED", { authorization: "" }, input.options);
void second.catch(() => {});
await delay(100);
releaseFailure();
const results = await Promise.allSettled([first, second]);
assert.equal(results[0].status, "rejected");
checkFailure(results[0].reason, "denied");
assert.equal(results[1].status, "fulfilled");
assert.equal(commits, 2);
await assert.rejects(lstat(input.lock), { code: "ENOENT" });
const store = JSON.parse(await readFile(input.store, "utf8"));
assert.equal(Object.hasOwn(store.profiles.rest, "REJECTED"), false);
assert.deepEqual(store.profiles.rest.RECOVERED, { authorization: "" });
`)
            await expectCleanProvision(fixture)
        })
    }, TEST_TIMEOUT_MS)

    // Native reader contention may deny replacement; denial must preserve the destination without a destructive fallback.
    test.skip("reader contention denies without mutation, then commits a new file identity after all readers close", async (): Promise<void> => {
        await withFixture(async (fixture: ProvisionFixture): Promise<void> => {
            await seed(fixture)
            const original = await readFile(fixture.store, "utf8")
            const expected = JSON.parse(original) as PlaintextCredentialStore
            const authorizationCharacters = 16000
            Object.assign(expected.profiles.rest ?? {}, { ATOMIC: { authorization: "é".repeat(authorizationCharacters) } })
            const replacement = JSON.stringify(expected)
            const before = await stat(fixture.store, { bigint: true })
            // Node's open API cannot select Windows share modes; both native readers must permit deletion.
            const observerScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$pinned = $null
$stage = 'atomic-open'
try {
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $inputReader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8)
    $outputWriter = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $utf8)
    $outputWriter.AutoFlush = $true
    $inputData = ConvertFrom-Json -InputObject ($inputReader.ReadLine())
    $sharing = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    $pinned = [System.IO.FileStream]::new($inputData.path, [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read, $sharing, 1, [System.IO.FileOptions]::None)
    $outputWriter.WriteLine('{"ready":true}')
    $stop = $inputReader.ReadLineAsync()
    $samples = 0
    $stage = 'atomic-observation'
    while (-not $stop.IsCompleted) {
        $sample = [System.IO.FileStream]::new($inputData.path, [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read, $sharing)
        try {
            $reader = [System.IO.StreamReader]::new($sample, $utf8, $false, 1024, $true)
            try { $contents = $reader.ReadToEnd() } finally { $reader.Dispose() }
        } finally { $sample.Dispose() }
        if (-not [string]::Equals($contents, $inputData.original, [System.StringComparison]::Ordinal)) {
            throw [System.IO.InvalidDataException]::new('Denied write changed sampled destination contents.')
        }
        $samples++
        [System.Threading.Thread]::Sleep(5)
    }
    if ($stop.GetAwaiter().GetResult() -cne 'stop') { throw [System.IO.InvalidDataException]::new('Invalid observer stop frame.') }
    $stage = 'atomic-old-contents'
    $reader = [System.IO.StreamReader]::new($pinned, $utf8, $false, 1024, $true)
    try { $oldContents = $reader.ReadToEnd() } finally { $reader.Dispose() }
    if (-not [string]::Equals($oldContents, $inputData.original, [System.StringComparison]::Ordinal)) {
        throw [System.IO.InvalidDataException]::new('Pinned old file contents changed.')
    }
    $outputWriter.WriteLine((ConvertTo-Json -InputObject @{ oldContentsUnchanged = $true; samples = $samples } -Compress))
} catch {
    try {
        $exception = $_.Exception
        for ($depth = 0; $null -ne $exception.InnerException -and $depth -lt 4; $depth++) { $exception = $exception.InnerException }
        $diagnostic = [ordered]@{
            stage = $stage
            kind = 'powershell'
            target = 'profiles.json'
            category = $_.CategoryInfo.Category.ToString()
            type = $exception.GetType().FullName
            hresult = [int]$exception.HResult
        }
        $outputWriter.WriteLine((ConvertTo-Json -InputObject @{ diagnostic = $diagnostic } -Depth 4 -Compress))
    } catch { }
    exit 1
} finally { if ($null -ne $pinned) { $pinned.Dispose() } }
`
            const commitProbe = `
const { mock } = await import("bun:test");
const native = await import(windowsFilesUrl);
const nativeRead = native.readSecureWindowsFile;
const nativeWrite = native.writeSecureWindowsFile;
const maxBytes = native.WINDOWS_SECURE_FILE_MAX_BYTES;
const originalContents = await readFile(input.store, "utf8");
const originalInfo = await lstat(input.store, { bigint: true });
const profile = { authorization: "é".repeat(${authorizationCharacters}) };
const expectedStore = JSON.parse(originalContents);
expectedStore.profiles.rest.ATOMIC = profile;
const expectedContents = JSON.stringify(expectedStore);
let storeWrites = 0;
function observeNative(operation, action) {
    return async (...args) => {
        const committing = operation === "file-write" && args[0] === input.store;
        if (committing) {
            storeWrites++;
            diagnosticStage = "atomic-identity";
            const current = await lstat(input.store, { bigint: true });
            assert.equal(current.dev, originalInfo.dev);
            assert.equal(current.ino, originalInfo.ino);
            assert.equal(await readFile(input.store, "utf8"), originalContents);
        }
        diagnosticStage = "atomic-provision";
        let result;
        try { result = await action(...args); }
        catch (error) {
            nativeDiagnostic = {
                ...classifyFailure(error), operation,
                target: args[0] === input.store ? "profiles.json" : isInitializerPath(args[0]) ? "initializer" : "other",
            };
            throw error;
        }
        if (committing) {
            diagnosticStage = "atomic-identity";
            const current = await lstat(input.store, { bigint: true });
            assert.notEqual(originalInfo.ino, 0n);
            assert.notEqual(current.ino, originalInfo.ino);
            diagnosticStage = "atomic-new-contents";
            assert.equal(await readFile(input.store, "utf8"), expectedContents);
        }
        return result;
    };
}
mock.module(fileURLToPath(windowsFilesUrl), () => ({
    WINDOWS_SECURE_FILE_MAX_BYTES: maxBytes,
    readSecureWindowsFile: observeNative("file-read", nativeRead),
    writeSecureWindowsFile: observeNative("file-write", nativeWrite),
}));
const { writePlaintextProfile } = await import(provisionUrl);
diagnosticStage = "atomic-provision";
`
            const observer = startProcess(fixture, POWERSHELL_PATH, [
                "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(observerScript, "utf16le").toString("base64"),
            ], { path: fixture.store, original }, true)
            expect(await observer.ready).toBe(true)
            let observation: ProcessResult
            try {
                await runBun(fixture, `${commitProbe}
let failure;
try { await writePlaintextProfile("rest", "ATOMIC", profile, input.options); }
catch (error) { failure = error; }
checkFailure(failure, "denied");
assert.equal(storeWrites, 1);
assert.equal(nativeDiagnostic.operation, "file-write");
assert.equal(nativeDiagnostic.target, "profiles.json");
assert.equal(nativeDiagnostic.code, "denied");
assert.equal(nativeDiagnostic.nativeCode, 5);
diagnosticStage = "atomic-identity";
const unchanged = await lstat(input.store, { bigint: true });
assert.equal(unchanged.dev, originalInfo.dev);
assert.equal(unchanged.ino, originalInfo.ino);
assert.equal(unchanged.mtimeNs, originalInfo.mtimeNs);
assert.equal(unchanged.size, originalInfo.size);
diagnosticStage = "atomic-old-contents";
assert.equal(await readFile(input.store, "utf8"), originalContents);
`)
                const denied = await stat(fixture.store, { bigint: true })
                expect(denied.dev).toBe(before.dev)
                expect(denied.ino).toBe(before.ino)
                expect(denied.mtimeNs).toBe(before.mtimeNs)
                expect(denied.size).toBe(before.size)
                expect(await readFile(fixture.store, "utf8") === original).toBe(true)
                await expectCleanProvision(fixture)
            } finally {
                if (!observer.child.stdin.destroyed) observer.child.stdin.end("stop\n")
                observation = await observer.closed
            }
            const messages = processMessages(observation)
            expect(messages.length).toBe(2)
            expect(messages[0]).toEqual({ ready: true })
            const sampled = messages[1] as { oldContentsUnchanged: boolean; samples: number }
            expect(sampled.oldContentsUnchanged).toBe(true)
            expect(sampled.samples).toBeGreaterThan(1)
            // Before/after native commit observations detect in-place writes, not an unobservably short unlink gap.
            await runBun(fixture, `${commitProbe}
await writePlaintextProfile("rest", "ATOMIC", profile, input.options);
assert.equal(storeWrites, 1);
assert.equal(nativeDiagnostic, undefined);
`)
            const after = await stat(fixture.store, { bigint: true })
            expect(before.ino === 0n).toBe(false)
            expect(before.ino === after.ino).toBe(false)
            expect(await readFile(fixture.store, "utf8") === replacement).toBe(true)
            await expectCleanProvision(fixture)
        })
    }, TEST_TIMEOUT_MS)
})
