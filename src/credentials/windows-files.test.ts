import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { Buffer } from "node:buffer"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { win32 } from "node:path"
import { CredentialError, type CredentialErrorCode } from "./types"
import { getWindowsCredentialIdentity } from "./windows"
import { readSecureWindowsFile, WINDOWS_SECURE_FILE_MAX_BYTES, writeSecureWindowsFile } from "./windows-files"
import {
    readWindowsCredentialFailureDiagnostics,
    withWindowsCredentialHelperTrace,
    WindowsCredentialProcessError,
    type WindowsCredentialHelperStage,
    type WindowsCredentialHelperTrace,
} from "./windows-process"

const TEMP_DIRECTORY = "C:\\Users\\qxz13vb\\AppData\\Local\\Temp\\opencode"
const ROOT_PREFIX = "autocode-windows-credentials-"
const WINDOWS_ROOT = "C:\\Windows"
const POWERSHELL_PATH = `${WINDOWS_ROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
const TEST_TIMEOUT_MS = 240000
const FIXTURE_TIMEOUT_MS = 60000
const MAX_FIXTURE_OUTPUT_BYTES = 262144
const MAX_FIXTURE_ERROR_DEPTH = 4
const MAX_RETAINED_HELPER_TRACES = 8
const FIXTURE_HELPER_STAGES: readonly WindowsCredentialHelperStage[] = [
    "nativecompile-before", "nativecompile-after", "input-before", "input-newline", "input-await-EOF", "input-after",
    "parse-before", "parse-after", "tokenSID-before", "tokenSID-after", "identityName-before", "identityName-after",
    "dispatch-before", "dispatch-after", "response-before", "response-after", "cleanup-before", "cleanup-after",
    "parent-open-before", "parent-open-after", "parent-verify-before", "parent-verify-after",
    "file-open-before", "file-open-after", "file-read-before", "file-read-after",
]
const FIXTURE_ERROR_CODES: readonly CredentialErrorCode[] = [
    "locked", "denied", "invalid", "unsafe_location", "too_large", "failed", "missing", "incomplete", "unavailable", "unsupported",
]
const FILE_MAX_BYTES = 256
const FULL_CONTROL = 2032127
const EVERYONE_SID = "S-1-1-0"
const SYNTHETIC_CONTENTS = "synthetic-only: café 漢字 😀\r\n\t終わり"
const REPLACEMENT_CONTENTS = "synthetic-replacement: naïve 🔐\n"

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

interface PathObservation {
    acl: AclMetadata
    mtimeNs: bigint
    size: bigint
    directory: boolean
    entries?: string[]
}

interface FixtureResult {
    code: number | null
    signal: NodeJS.Signals | null
    failed: boolean
    output: string
}

interface FixtureProcess {
    child: ChildProcessWithoutNullStreams
    closed: Promise<FixtureResult>
    ready: Promise<boolean>
    stop(): Promise<void>
}

interface OwnedJunction {
    path: string
    target: string
    file: string
    observedPaths: string[]
    before: PathObservation[]
}

interface FileFixture {
    root: string
    processes: FixtureProcess[]
    junctions: OwnedJunction[]
    setPhase(phase: FileFixturePhase): void
}

type FileFixturePhase = "setup" | "action" | "seed-write" | "readback" | "junction-creation" | "denied-read" | "denied-existing-write" | "denied-new-write" | "post-integrity" | "cleanup"
type FixtureFailureOperation = "file-fixture" | "expected-error" | "file-read-denied" | "file-write-denied" | "cleanup" | "cleanup-junction" | "cleanup-integrity" | "cleanup-root"

interface FixtureFailureSnapshot {
    operation: FixtureFailureOperation
    testPhase: FileFixturePhase
    elapsedMs: number
    phaseElapsedMs: number
    class: "WindowsCredentialProcessError" | "CredentialError" | "Error" | "unknown"
    code: CredentialErrorCode | "unknown"
    nativeCode: number | "unknown"
    parent: ReturnType<typeof readWindowsCredentialFailureDiagnostics> | "unregistered"
    helperTrace: Readonly<WindowsCredentialHelperTrace>[]
    lastObservedStage: WindowsCredentialHelperStage | "unobserved"
}

const FIXTURE_FAILURE_CONTEXT = new AsyncLocalStorage<(error: unknown, operation: FixtureFailureOperation) => void>()
const createdRoots: string[] = []
const removedRoots: string[] = []
const createdJunctions: string[] = []
const removedJunctions: string[] = []
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
$fixtureOutput.WriteLine((ConvertTo-Json -InputObject $items -Depth 6 -Compress))
`

const ADD_EVERYONE_RULE = `
$everyone = [System.Security.Principal.SecurityIdentifier]::new('${EVERYONE_SID}')
foreach ($path in $inputData.paths) {
    $isDirectory = [System.IO.Directory]::Exists($path)
    if ($isDirectory) {
        $acl = [System.IO.Directory]::GetAccessControl($path, [System.Security.AccessControl.AccessControlSections]::Access)
    }
    else {
        $acl = [System.IO.File]::GetAccessControl($path, [System.Security.AccessControl.AccessControlSections]::Access)
    }
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $everyone, [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    if ($isDirectory) { [System.IO.Directory]::SetAccessControl($path, $acl) }
    else { [System.IO.File]::SetAccessControl($path, $acl) }
}
$fixtureOutput.WriteLine((ConvertTo-Json -InputObject @{ updated = @($inputData.paths).Count } -Compress))
`

// Snapshot handles close before mutation; native file IDs distinguish replacement from in-place writes.
const SNAPSHOT_FILE_IDENTITY = `
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using FILETIME = System.Runtime.InteropServices.ComTypes.FILETIME;
using Microsoft.Win32.SafeHandles;

public static class WindowsCredentialFileIdentityFixture
{
    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        public uint Attributes;
        public FILETIME CreationTime;
        public FILETIME LastAccessTime;
        public FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode,
        ExactSpelling = true, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint sharing,
        IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);

    public static SafeFileHandle Open(string path)
    {
        SafeFileHandle handle = CreateFile(path, 0, 1 | 2 | 4, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error);
        }
        return handle;
    }

    public static string Identity(SafeFileHandle handle)
    {
        FileInformation information;
        if (!GetFileInformationByHandle(handle, out information))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        ulong index = ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow;
        if (index == 0)
            throw new InvalidOperationException("File identity unavailable.");
        return information.VolumeSerialNumber.ToString("X8") + ":" + index.ToString("X16");
    }
}
'@
Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop | Out-Null
$handle = [WindowsCredentialFileIdentityFixture]::Open($inputData.path)
try {
    $identity = [WindowsCredentialFileIdentityFixture]::Identity($handle)
}
finally { $handle.Dispose() }
$fixtureOutput.WriteLine((ConvertTo-Json -InputObject @{ identity = $identity } -Compress))
`

function startFixture(fixture: FileFixture, script: string, input: object): FixtureProcess {
    const wrappedScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $fixtureInput = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8)
    $fixtureOutput = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $utf8)
    $fixtureOutput.AutoFlush = $true
    $inputData = ConvertFrom-Json -InputObject ($fixtureInput.ReadLine())
    ${script}
}
catch {
    try {
        $exception = $_.Exception
        $category = $_.CategoryInfo.Category.ToString()
        $diagnostics = @(
            for ($depth = 0; $null -ne $exception -and $depth -lt ${MAX_FIXTURE_ERROR_DEPTH}; $depth++) {
                [ordered]@{
                    category = $category
                    type = $exception.GetType().FullName
                    hresult = [int]$exception.HResult
                }
                $exception = $exception.InnerException
            }
        )
        $fixtureOutput.WriteLine((ConvertTo-Json -InputObject @{ fixtureError = $diagnostics } -Depth 4 -Compress))
    }
    catch { }
    [Console]::Error.WriteLine('Windows credential fixture failed.')
    exit 1
}
`
    let child: ChildProcessWithoutNullStreams
    try {
        child = spawn(POWERSHELL_PATH, [
            "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
            Buffer.from(wrappedScript, "utf16le").toString("base64"),
        ], {
            cwd: fixture.root,
            env: { SystemRoot: WINDOWS_ROOT, WINDIR: WINDOWS_ROOT, TEMP: TEMP_DIRECTORY, TMP: TEMP_DIRECTORY },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            shell: false,
        })
    } catch {
        throw new Error("Windows credential fixture could not start.")
    }

    let output = ""
    let stderr = ""
    let outputBytes = 0
    let failed = false
    let finished = false
    let markReady!: (ready: boolean) => void
    const ready = new Promise<boolean>((resolve: (ready: boolean) => void): void => { markReady = resolve })

    function terminate(): void {
        if (finished) return
        try { child.kill("SIGKILL") } catch { failed = true }
    }

    function fail(): void {
        failed = true
        terminate()
    }

    function receive(chunk: Buffer, isStderr: boolean): void {
        outputBytes += chunk.byteLength
        if (outputBytes > MAX_FIXTURE_OUTPUT_BYTES) {
            fail()
            return
        }
        if (isStderr) stderr += chunk.toString("utf8")
        else {
            output += chunk.toString("utf8")
            if (output.split(/\r?\n/).includes('{"ready":true}')) markReady(true)
        }
    }

    const timer = setTimeout(fail, FIXTURE_TIMEOUT_MS)
    const closed = new Promise<FixtureResult>((resolve: (result: FixtureResult) => void): void => {
        child.once("close", (code: number | null, signal: NodeJS.Signals | null): void => {
            finished = true
            clearTimeout(timer)
            markReady(false)
            child.stdin.destroy()
            const result = { code, signal, failed: failed || stderr.length !== 0, output }
            stderr = ""
            output = ""
            resolve(result)
        })
    })
    child.on("error", fail)
    child.stdin.on("error", fail)
    child.stdout.on("error", fail)
    child.stderr.on("error", fail)
    child.stdout.on("data", (chunk: Buffer): void => receive(chunk, false))
    child.stderr.on("data", (chunk: Buffer): void => receive(chunk, true))
    const running: FixtureProcess = {
        child, closed, ready,
        async stop(): Promise<void> {
            terminate()
            await closed
        },
    }
    fixture.processes.push(running)
    try { child.stdin.write(`${JSON.stringify(input)}\n`) } catch { fail() }
    return running
}

function fixtureMessages(result: FixtureResult): unknown[] {
    if (result.failed || result.code !== 0 || result.signal !== null) {
        const message = "Windows credential fixture failed; raw native diagnostics withheld."
        let metadata: unknown
        try { metadata = JSON.parse(result.output.trim().split(/\r?\n/).at(-1) ?? "") } catch { throw new Error(message) }
        if (typeof metadata !== "object" || metadata === null || !("fixtureError" in metadata)
            || !Array.isArray(metadata.fixtureError) || metadata.fixtureError.length < 1
            || metadata.fixtureError.length > MAX_FIXTURE_ERROR_DEPTH) {
            throw new Error(message)
        }
        const diagnostics: { category: string; type: string; hresult: number }[] = []
        for (const entry of metadata.fixtureError) {
            if (typeof entry !== "object" || entry === null) throw new Error(message)
            const { category, type, hresult } = entry as Record<string, unknown>
            if (typeof category !== "string" || !/^[A-Z][A-Za-z]{0,63}$/.test(category)
                || typeof type !== "string" || !/^(?:System|Microsoft)\.[A-Za-z0-9_.+]{1,199}$/.test(type)
                || typeof hresult !== "number" || !Number.isInteger(hresult)
                || hresult < -2147483648 || hresult > 2147483647) {
                throw new Error(message)
            }
            diagnostics.push({ category, type, hresult })
        }
        throw new Error(`${message} ${JSON.stringify({ fixtureError: diagnostics })}`)
    }
    try {
        return result.output.trim().split(/\r?\n/).map((line: string): unknown => JSON.parse(line))
    } catch {
        throw new Error("Windows credential fixture returned invalid metadata.")
    }
}

async function runFixture(fixture: FileFixture, script: string, input: object): Promise<unknown> {
    const running = startFixture(fixture, script, input)
    running.child.stdin.end()
    const messages = fixtureMessages(await running.closed)
    expect(messages.length).toBe(1)
    return messages[0]
}

async function readFileIdentity(fixture: FileFixture, path: string): Promise<string> {
    const metadata = await runFixture(fixture, SNAPSHOT_FILE_IDENTITY, { path })
    if (typeof metadata !== "object" || metadata === null || !("identity" in metadata)
        || typeof metadata.identity !== "string" || !/^[0-9A-F]{8}:[0-9A-F]{16}$/.test(metadata.identity)) {
        throw new Error("Windows credential fixture returned invalid file identity metadata.")
    }
    return metadata.identity
}

async function observePaths(fixture: FileFixture, paths: string[]): Promise<PathObservation[]> {
    const acls = await runFixture(fixture, INSPECT_ACLS, { paths }) as AclMetadata[]
    expect(Array.isArray(acls)).toBe(true)
    expect(acls.length).toBe(paths.length)
    const observations: PathObservation[] = []
    for (const [index, path] of paths.entries()) {
        const info = await stat(path, { bigint: true })
        observations.push({
            acl: acls[index],
            mtimeNs: info.mtimeNs,
            size: info.size,
            directory: info.isDirectory(),
            ...(info.isDirectory() ? { entries: (await readdir(path)).sort() } : {}),
        })
    }
    return observations
}

function expectOwnerOnly(acl: AclMetadata, directory: boolean): void {
    expect(acl.ownerSid).toBe(expectedSid)
    expect(acl.protected).toBe(true)
    expect(acl.rules).toEqual([{
        sid: expectedSid,
        type: "Allow",
        rights: FULL_CONTROL,
        inherited: false,
        inheritance: directory ? 3 : 0,
        propagation: 0,
    }])
}

function unexpectedCredentialFailure(error: unknown, expectedPhase: "file-fixture" | "expected-error" | "file-read-denied" | "file-write-denied"): Error {
    const trusted = error instanceof CredentialError ? error : undefined
    const codes: readonly CredentialErrorCode[] = ["locked", "denied", "invalid", "too_large", "failed", "missing", "incomplete", "unavailable", "unsupported"]
    const code = codes.find((candidate: CredentialErrorCode): boolean => candidate === trusted?.code) ?? "unknown"
    const nativeCode = error instanceof WindowsCredentialProcessError ? error.nativeCode : undefined
    return new Error(`Unexpected Windows credential outcome; raw error withheld. ${JSON.stringify({
        expectedPhase,
        class: error instanceof WindowsCredentialProcessError ? "WindowsCredentialProcessError" : trusted === undefined ? "unknown" : "CredentialError",
        code,
        nativeCode: typeof nativeCode === "number" && Number.isInteger(nativeCode) && nativeCode >= -2147483648 && nativeCode <= 2147483647 ? nativeCode : "unknown",
        parent: readWindowsCredentialFailureDiagnostics(error) ?? "unregistered",
    })}`)
}

async function expectCredentialError(
    action: () => Promise<unknown>,
    code: CredentialErrorCode,
    expectedPhase: "expected-error" | "file-read-denied" | "file-write-denied" = "expected-error",
): Promise<void> {
    let failure: unknown
    try { await action() } catch (error: unknown) { failure = error }
    if (!(failure instanceof CredentialError) || failure.code !== code) {
        FIXTURE_FAILURE_CONTEXT.getStore()?.(failure, expectedPhase)
        throw unexpectedCredentialFailure(failure, expectedPhase)
    }
    try {
        expect(failure instanceof CredentialError).toBe(true)
        if (!(failure instanceof CredentialError)) throw new Error("Expected a sanitized CredentialError.")
        expect(failure.code).toBe(code)
        expect(failure.message === new CredentialError(code).message).toBe(true)
        expect(failure.cause === undefined).toBe(true)
        expect(Object.hasOwn(failure, "cause")).toBe(false)
    } catch (error: unknown) {
        FIXTURE_FAILURE_CONTEXT.getStore()?.(failure, expectedPhase)
        throw error
    }
}

async function expectContents(path: string, expected: string, maxBytes: number = FILE_MAX_BYTES): Promise<void> {
    const result = await readSecureWindowsFile(path, maxBytes, { expectedSid })
    expect(result.status).toBe("found")
    expect(result.status === "found" && result.contents === expected).toBe(true)
    expect(await readFile(path, "utf8") === expected).toBe(true)
}

async function expectAbsent(path: string): Promise<void> {
    let missing = false
    try { await lstat(path) } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not verify owned path absence.")
        missing = true
    }
    expect(missing).toBe(true)
}

function expectOwnedPath(fixture: FileFixture, path: string): void {
    const relative = win32.relative(fixture.root, path)
    if (relative === "" || relative === ".." || relative.startsWith("..\\") || win32.isAbsolute(relative)) {
        throw new Error("Fixture path is outside its exact owned root.")
    }
}

async function cleanupFixture(fixture: FileFixture, onFailure: (error: unknown, operation: FixtureFailureOperation) => Promise<void>): Promise<Error | undefined> {
    const failures: string[] = []
    let junctionsRemoved = true
    for (const running of fixture.processes) await running.stop()
    // Remove exact junction names before recursive cleanup so targets cannot be traversed.
    for (const junction of fixture.junctions) {
        try {
            expectOwnedPath(fixture, junction.path)
            expectOwnedPath(fixture, junction.target)
            let exists = true
            try { await lstat(junction.path) } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
                exists = false
            }
            if (exists) {
                expect((await lstat(junction.path)).isSymbolicLink()).toBe(true)
                await rmdir(junction.path)
            }
            await expectAbsent(junction.path)
            if (createdJunctions.includes(junction.path)) removedJunctions.push(junction.path)
        } catch (error: unknown) {
            await onFailure(error, "cleanup-junction")
            junctionsRemoved = false
            failures.push(`Junction cleanup verification failed: ${junction.path}`)
            continue
        }
        try {
            expect(await observePaths(fixture, junction.observedPaths)).toEqual(junction.before)
            expect(await readFile(junction.file, "utf8") === SYNTHETIC_CONTENTS).toBe(true)
        } catch (error: unknown) {
            await onFailure(error, "cleanup-integrity")
            failures.push(`Junction target preservation verification failed: ${junction.target}`)
        }
    }
    for (const running of fixture.processes) await running.stop()
    if (junctionsRemoved) {
        try {
            if (win32.dirname(fixture.root) !== TEMP_DIRECTORY || !win32.basename(fixture.root).startsWith(ROOT_PREFIX)) {
                throw new Error("Unowned cleanup root.")
            }
            await rm(fixture.root, { recursive: true, force: false, maxRetries: 8, retryDelay: 100 })
            await expectAbsent(fixture.root)
            removedRoots.push(fixture.root)
        } catch (error: unknown) {
            await onFailure(error, "cleanup-root")
            failures.push(`Owned root cleanup verification failed: ${fixture.root}`)
        }
    }
    return failures.length !== 0 ? new Error(failures.join("\n")) : undefined
}

async function persistFixtureFailure(snapshot: FixtureFailureSnapshot): Promise<void> {
    const artifact = win32.join(TEMP_DIRECTORY, `${ROOT_PREFIX}diagnostic-${randomUUID()}.jsonl`)
    const record = `${JSON.stringify({ ...snapshot, artifact })}\n`
    try { process.stderr.write(record) } catch { }
    try {
        await appendFile(artifact, record, { encoding: "utf8", flag: "ax", mode: 0o600 })
    } catch {
        try { process.stderr.write('{"operation":"file-fixture-diagnostics","artifactStatus":"failed"}\n') } catch { }
    }
}

async function withFileFixture(action: (fixture: FileFixture) => Promise<void>): Promise<void> {
    const startedAt = performance.now()
    let phase: FileFixturePhase = "setup"
    let phaseStartedAt = startedAt
    const helperTrace: Readonly<WindowsCredentialHelperTrace>[] = []
    let primarySnapshot: FixtureFailureSnapshot | undefined
    const cleanupFailures: Error[] = []

    function setPhase(nextPhase: FileFixturePhase): void {
        phase = nextPhase
        phaseStartedAt = performance.now()
    }

    function snapshotFailure(error: unknown, operation: FixtureFailureOperation): FixtureFailureSnapshot {
        const parent = readWindowsCredentialFailureDiagnostics(error) ?? "unregistered"
        const now = performance.now()
        const trusted = error instanceof CredentialError ? error : undefined
        const nativeCode = error instanceof WindowsCredentialProcessError ? error.nativeCode : undefined
        return {
            operation,
            testPhase: phase,
            elapsedMs: Math.max(0, Math.floor(now - startedAt)),
            phaseElapsedMs: Math.max(0, Math.floor(now - phaseStartedAt)),
            class: error instanceof WindowsCredentialProcessError ? "WindowsCredentialProcessError" : trusted !== undefined ? "CredentialError" : error instanceof Error ? "Error" : "unknown",
            code: FIXTURE_ERROR_CODES.find((code: CredentialErrorCode): boolean => code === trusted?.code) ?? "unknown",
            nativeCode: typeof nativeCode === "number" && Number.isSafeInteger(nativeCode) && nativeCode >= -2147483648 && nativeCode <= 2147483647 ? nativeCode : "unknown",
            parent,
            helperTrace: [...helperTrace],
            lastObservedStage: helperTrace.at(-1)?.helperStage ?? "unobserved",
        }
    }

    function capturePrimary(error: unknown, operation: FixtureFailureOperation): FixtureFailureSnapshot {
        return primarySnapshot ??= snapshotFailure(error, operation)
    }

    async function captureCleanup(error: unknown, operation: FixtureFailureOperation): Promise<void> {
        const snapshot = snapshotFailure(error, operation)
        cleanupFailures.push(new Error(`Windows credential fixture cleanup failure; raw error withheld. ${JSON.stringify(snapshot)}`))
        await persistFixtureFailure(snapshot)
    }

    await FIXTURE_FAILURE_CONTEXT.run(capturePrimary, (): Promise<void> => withWindowsCredentialHelperTrace((trace: Readonly<WindowsCredentialHelperTrace>): void => {
        if (!FIXTURE_HELPER_STAGES.includes(trace.helperStage)
            || !Number.isSafeInteger(trace.helperElapsedMs) || trace.helperElapsedMs < 0
            || !Number.isSafeInteger(trace.helperByteCount) || trace.helperByteCount < 0) return
        if (helperTrace.length === MAX_RETAINED_HELPER_TRACES) helperTrace.shift()
        helperTrace.push({ helperStage: trace.helperStage, helperElapsedMs: trace.helperElapsedMs, helperByteCount: trace.helperByteCount })
    }, async (): Promise<void> => {
        let fixture: FileFixture | undefined
        let primaryError: unknown
        let primaryFailed = false
        try {
            const root = await mkdtemp(win32.join(TEMP_DIRECTORY, ROOT_PREFIX))
            createdRoots.push(root)
            fixture = { root, processes: [], junctions: [], setPhase }
            setPhase("action")
            await action(fixture)
        } catch (error: unknown) {
            const snapshot = capturePrimary(error, "file-fixture")
            await persistFixtureFailure(snapshot)
            primaryError = error instanceof CredentialError ? unexpectedCredentialFailure(error, "file-fixture") : error
            primaryFailed = true
        }

        let cleanupError: unknown
        let cleanupFailed = false
        if (fixture !== undefined) {
            setPhase("cleanup")
            try {
                cleanupError = await cleanupFixture(fixture, captureCleanup)
                cleanupFailed = cleanupError !== undefined
            } catch (error: unknown) {
                await captureCleanup(error, "cleanup")
                cleanupError = error instanceof CredentialError ? unexpectedCredentialFailure(error, "file-fixture") : error
                cleanupFailed = true
            }
        }
        if (primaryFailed && cleanupFailed) {
            throw new AggregateError([
                new Error(`Windows credential fixture primary failure; raw error withheld. ${JSON.stringify(primarySnapshot)}`),
                ...cleanupFailures,
            ], "Windows credential fixture action and cleanup failed; raw errors withheld.")
        }
        if (primaryFailed) throw primaryError
        if (cleanupFailed) throw cleanupError
    }))
}

describe.skipIf(process.platform !== "win32")("Windows file failure diagnostics (safe metadata)", (): void => {
    test("withholds original messages, causes, stacks, and untrusted codes", (): void => {
        const privateText = "synthetic-private-path-and-payload"
        const trusted = new WindowsCredentialProcessError("failed", 5)
        trusted.message = privateText
        trusted.stack = privateText
        Object.defineProperty(trusted, "cause", { value: new Error(privateText) })
        const untrusted = Object.assign(new Error(privateText), { code: privateText, cause: privateText, stack: privateText })
        for (const error of [trusted, untrusted]) {
            const safe = unexpectedCredentialFailure(error, "file-read-denied")
            expect(safe.message.includes(privateText)).toBe(false)
            expect(safe.stack?.includes(privateText)).toBe(false)
            expect(safe.message).toContain('"expectedPhase":"file-read-denied"')
            expect(safe.message).toContain('"parent":"unregistered"')
            expect(Object.hasOwn(safe, "cause")).toBe(false)
        }
        expect(unexpectedCredentialFailure(trusted, "file-read-denied").message).toContain('"code":"failed","nativeCode":5')
        expect(unexpectedCredentialFailure(untrusted, "file-read-denied").message).toContain('"code":"unknown","nativeCode":"unknown"')
    })
})

// 69.7s for 11 tests; PowerShell-backed real-filesystem fixtures make this Windows suite too slow.
describe.skip("Windows protected credential files (real filesystem)", (): void => {
    const originalTemp = process.env.TEMP
    const originalTmp = process.env.TMP

    beforeAll(async (): Promise<void> => {
        process.env.TEMP = TEMP_DIRECTORY
        process.env.TMP = TEMP_DIRECTORY
        const identity = await getWindowsCredentialIdentity()
        expectedSid = identity.sid
        expect(/^S-1-/.test(expectedSid)).toBe(true)
    }, TEST_TIMEOUT_MS)

    describe("Windows helper stage proof (owned synthetic file)", (): void => {
        test("traces file-read stages without identityName access", async (): Promise<void> => {
            await withFileFixture(async (fixture: FileFixture): Promise<void> => {
                const path = win32.join(fixture.root, "stage-proof", "synthetic.json")
                await writeSecureWindowsFile(path, SYNTHETIC_CONTENTS, FILE_MAX_BYTES, { expectedSid })
                const receipts: Readonly<WindowsCredentialHelperTrace>[] = []
                const result = await withWindowsCredentialHelperTrace((trace: Readonly<WindowsCredentialHelperTrace>): void => {
                    receipts.push(trace)
                }, (): ReturnType<typeof readSecureWindowsFile> => readSecureWindowsFile(path, FILE_MAX_BYTES, { expectedSid }))
                expect(result.status === "found" && result.contents === SYNTHETIC_CONTENTS).toBe(true)
                const required: WindowsCredentialHelperStage[] = [
                    "nativecompile-before", "nativecompile-after", "input-before", "input-newline", "input-await-EOF", "input-after",
                    "parse-before", "parse-after", "tokenSID-before", "tokenSID-after", "dispatch-before", "dispatch-after",
                    "response-before", "response-after", "cleanup-before", "cleanup-after",
                ]
                const allowed: WindowsCredentialHelperStage[] = [
                    ...required, "parent-open-before", "parent-open-after", "parent-verify-before", "parent-verify-after",
                    "file-open-before", "file-open-after", "file-read-before", "file-read-after",
                ]
                const stages = receipts.map((trace: Readonly<WindowsCredentialHelperTrace>): WindowsCredentialHelperStage => trace.helperStage)
                expect(stages.filter((stage: WindowsCredentialHelperStage): boolean => required.includes(stage))).toEqual(required)
                expect(stages.some((stage: WindowsCredentialHelperStage): boolean => stage === "identityName-before" || stage === "identityName-after")).toBe(false)
                expect(receipts.length).toBeLessThanOrEqual(96)
                let elapsedMs = 0
                let byteCount = 0
                for (const trace of receipts) {
                    expect(Object.isFrozen(trace)).toBe(true)
                    expect(Object.keys(trace)).toEqual(["helperStage", "helperElapsedMs", "helperByteCount"])
                    expect(allowed.includes(trace.helperStage)).toBe(true)
                    expect(Number.isSafeInteger(trace.helperElapsedMs) && trace.helperElapsedMs >= elapsedMs).toBe(true)
                    expect(Number.isSafeInteger(trace.helperByteCount) && trace.helperByteCount >= byteCount).toBe(true)
                    elapsedMs = trace.helperElapsedMs
                    byteCount = trace.helperByteCount
                }
                expect(byteCount).toBeGreaterThan(0)
                const text = JSON.stringify(receipts)
                expect([path, expectedSid, SYNTHETIC_CONTENTS, "ACW_INTERNAL_STAGE_V1|"].every((value: string): boolean => !text.includes(value))).toBe(true)
            })
        }, TEST_TIMEOUT_MS)
    })

    afterAll((): void => {
        if (originalTemp === undefined) delete process.env.TEMP
        else process.env.TEMP = originalTemp
        if (originalTmp === undefined) delete process.env.TMP
        else process.env.TMP = originalTmp
        process.stdout.write(`${JSON.stringify({
            prefix: ROOT_PREFIX,
            roots: createdRoots,
            verifiedRemovedRootCount: removedRoots.length,
            junctions: createdJunctions,
            verifiedRemovedJunctionCount: removedJunctions.length,
            uncovered: ["Wrong-owner fixture: requires privileges not exercised by this suite."],
        })}\n`)
        expect(removedRoots.length).toBe(createdRoots.length)
        expect(removedJunctions.length).toBe(createdJunctions.length)
    }, TEST_TIMEOUT_MS)

    test("missing reads leave existing secure and absent credential parents untouched", async (): Promise<void> => {
        await withFileFixture(async (fixture: FileFixture): Promise<void> => {
            const parent = win32.join(fixture.root, "existing-secure")
            const path = win32.join(parent, "missing.json")
            await writeSecureWindowsFile(path, SYNTHETIC_CONTENTS, FILE_MAX_BYTES, { expectedSid })
            await unlink(path)
            const paths = [fixture.root, parent]
            const before = await observePaths(fixture, paths)
            expectOwnerOnly(before[1].acl, true)
            const absentParent = win32.join(fixture.root, "absent-parent")
            const absentAncestor = win32.join(fixture.root, "absent-ancestor")
            for (const missing of [path, win32.join(absentParent, "missing.json"), win32.join(absentAncestor, "nested", "missing.json")]) {
                const result = await readSecureWindowsFile(missing, FILE_MAX_BYTES, { expectedSid })
                expect(result.status).toBe("missing")
                expect(Object.keys(result)).toEqual(["status"])
            }
            await expectAbsent(path)
            await expectAbsent(absentParent)
            await expectAbsent(absentAncestor)
            expect(await observePaths(fixture, paths)).toEqual(before)
        })
    }, TEST_TIMEOUT_MS)

    test("provisions Unicode owner-only ACLs, replaces atomically, and reads without mutation", async (): Promise<void> => {
        await withFileFixture(async (fixture: FileFixture): Promise<void> => {
            const structural = win32.join(fixture.root, "ordinary-ancestor")
            await mkdir(structural)
            const structuralBefore = await observePaths(fixture, [fixture.root, structural])
            expect(structuralBefore[0].acl.protected).toBe(false)
            expect(structuralBefore[1].acl.protected).toBe(false)
            const nested = win32.join(structural, "保護")
            const parent = win32.join(nested, "credentials")
            const path = win32.join(parent, "秘密.json")
            await expectAbsent(nested)
            await writeSecureWindowsFile(path, SYNTHETIC_CONTENTS, FILE_MAX_BYTES, { expectedSid })
            await expectContents(path, SYNTHETIC_CONTENTS)
            const provisioned = await observePaths(fixture, [nested, parent, path])
            expectOwnerOnly(provisioned[0].acl, true)
            expectOwnerOnly(provisioned[1].acl, true)
            expectOwnerOnly(provisioned[2].acl, false)
            const structuralAfter = await observePaths(fixture, [fixture.root, structural])
            expect(structuralAfter.map((item: PathObservation): AclMetadata => item.acl))
                .toEqual(structuralBefore.map((item: PathObservation): AclMetadata => item.acl))

            const originalIdentity = await readFileIdentity(fixture, path)
            await writeSecureWindowsFile(path, REPLACEMENT_CONTENTS, FILE_MAX_BYTES, { expectedSid })
            const replacementIdentity = await readFileIdentity(fixture, path)
            expect(originalIdentity !== replacementIdentity).toBe(true)
            await expectContents(path, REPLACEMENT_CONTENTS)

            const paths = [fixture.root, structural, nested, parent, path]
            const beforeReads = await observePaths(fixture, paths)
            expectOwnerOnly(beforeReads[3].acl, true)
            expectOwnerOnly(beforeReads[4].acl, false)
            expect(beforeReads[3].entries).toEqual([win32.basename(path)])
            expect(beforeReads[4].acl.sddl).toBe(provisioned[2].acl.sddl)
            for (let index = 0; index < 3; index++) await expectContents(path, REPLACEMENT_CONTENTS)
            expect(await observePaths(fixture, paths)).toEqual(beforeReads)
        })
    }, TEST_TIMEOUT_MS)

    test("enforces UTF-8 byte boundaries and the hard cap without altering prior files", async (): Promise<void> => {
        await withFileFixture(async (fixture: FileFixture): Promise<void> => {
            expect(WINDOWS_SECURE_FILE_MAX_BYTES).toBe(1048576)
            const parent = win32.join(fixture.root, "byte-limits")
            const path = win32.join(parent, "credentials.json")
            const maxBytes = 32
            const boundary = "é".repeat(14) + "😀"
            const oversized = boundary + "x"
            expect(Buffer.byteLength(boundary, "utf8")).toBe(maxBytes)
            expect(Buffer.byteLength(oversized, "utf8")).toBe(maxBytes + 1)
            expect(oversized.length < maxBytes).toBe(true)
            await writeSecureWindowsFile(path, "synthetic-seed", WINDOWS_SECURE_FILE_MAX_BYTES, { expectedSid })
            await writeSecureWindowsFile(path, boundary, maxBytes, { expectedSid })
            await expectContents(path, boundary, maxBytes)
            await expectContents(path, boundary, WINDOWS_SECURE_FILE_MAX_BYTES)
            const paths = [fixture.root, parent, path]
            const before = await observePaths(fixture, paths)
            await expectCredentialError((): Promise<void> => writeSecureWindowsFile(path, oversized, maxBytes, { expectedSid }), "too_large")
            await expectCredentialError((): Promise<unknown> => readSecureWindowsFile(path, maxBytes - 1, { expectedSid }), "too_large")
            const absentParent = win32.join(fixture.root, "oversize-must-not-create")
            await expectCredentialError((): Promise<void> => writeSecureWindowsFile(win32.join(absentParent, "file.json"), oversized, maxBytes, { expectedSid }), "too_large")
            for (const invalidCap of [0, -1, 0.5, NaN, Infinity, -Infinity, WINDOWS_SECURE_FILE_MAX_BYTES + 1]) {
                await expectCredentialError((): Promise<unknown> => readSecureWindowsFile(path, invalidCap, { expectedSid }), "invalid")
                await expectCredentialError((): Promise<void> => writeSecureWindowsFile(path, "synthetic", invalidCap, { expectedSid }), "invalid")
            }
            await expectAbsent(absentParent)
            expect(await observePaths(fixture, paths)).toEqual(before)
            await expectContents(path, boundary, maxBytes)
        })
    }, TEST_TIMEOUT_MS)

    test("rejects an existing insecure parent and file without repairing ACLs or creating files", async (): Promise<void> => {
        await withFileFixture(async (fixture: FileFixture): Promise<void> => {
            const parent = win32.join(fixture.root, "insecure-parent")
            const path = win32.join(parent, "credentials.json")
            await mkdir(parent)
            await writeFile(path, SYNTHETIC_CONTENTS, "utf8")
            expect(await runFixture(fixture, ADD_EVERYONE_RULE, { paths: [parent, path] })).toEqual({ updated: 2 })
            const paths = [fixture.root, parent, path]
            const before = await observePaths(fixture, paths)
            for (const item of before.slice(1)) {
                expect(item.acl.rules.some((rule: AclMetadata["rules"][number]): boolean => rule.sid === EVERYONE_SID)).toBe(true)
            }
            await expectCredentialError((): Promise<unknown> => readSecureWindowsFile(path, FILE_MAX_BYTES, { expectedSid }), "denied")
            await expectCredentialError((): Promise<void> => writeSecureWindowsFile(path, REPLACEMENT_CONTENTS, FILE_MAX_BYTES, { expectedSid }), "denied")
            const absent = win32.join(parent, "must-not-create.json")
            await expectCredentialError((): Promise<void> => writeSecureWindowsFile(absent, REPLACEMENT_CONTENTS, FILE_MAX_BYTES, { expectedSid }), "denied")
            await expectAbsent(absent)
            expect(await observePaths(fixture, paths)).toEqual(before)
            expect(await readFile(path, "utf8") === SYNTHETIC_CONTENTS).toBe(true)
        })
    }, TEST_TIMEOUT_MS)

    test("rejects a specifically insecure file beneath a still-secure parent without repair", async (): Promise<void> => {
        await withFileFixture(async (fixture: FileFixture): Promise<void> => {
            const parent = win32.join(fixture.root, "secure-parent")
            const path = win32.join(parent, "insecure-file.json")
            await writeSecureWindowsFile(path, SYNTHETIC_CONTENTS, FILE_MAX_BYTES, { expectedSid })
            const secure = await observePaths(fixture, [parent, path])
            expectOwnerOnly(secure[0].acl, true)
            expectOwnerOnly(secure[1].acl, false)
            expect(await runFixture(fixture, ADD_EVERYONE_RULE, { paths: [path] })).toEqual({ updated: 1 })
            const paths = [fixture.root, parent, path]
            const before = await observePaths(fixture, paths)
            expect(before[1]).toEqual(secure[0])
            expect(before[2].acl.protected).toBe(true)
            expect(before[2].acl.rules.some((rule: AclMetadata["rules"][number]): boolean => rule.sid === EVERYONE_SID)).toBe(true)
            await expectCredentialError((): Promise<unknown> => readSecureWindowsFile(path, FILE_MAX_BYTES, { expectedSid }), "denied", "file-read-denied")
            await expectCredentialError((): Promise<void> => writeSecureWindowsFile(path, REPLACEMENT_CONTENTS, FILE_MAX_BYTES, { expectedSid }), "denied", "file-write-denied")
            expect(await observePaths(fixture, paths)).toEqual(before)
            expect(await readFile(path, "utf8") === SYNTHETIC_CONTENTS).toBe(true)
        })
    }, TEST_TIMEOUT_MS)

    for (const structural of [false, true]) {
        test(`rejects a real junction in ${structural ? "a higher structural ancestor" : "the final credential parent"}`, async (): Promise<void> => {
            await withFileFixture(async (fixture: FileFixture): Promise<void> => {
                const target = win32.join(fixture.root, "junction-target")
                const parent = structural ? win32.join(target, "secure-parent") : target
                if (structural) await mkdir(target)
                const file = win32.join(parent, "credentials.json")
                fixture.setPhase("seed-write")
                await writeSecureWindowsFile(file, SYNTHETIC_CONTENTS, FILE_MAX_BYTES, { expectedSid })
                fixture.setPhase("readback")
                await expectContents(file, SYNTHETIC_CONTENTS)
                const observedPaths = structural ? [target, parent, file] : [target, file]
                const before = await observePaths(fixture, observedPaths)
                const junction = win32.join(fixture.root, "junction")
                const record = { path: junction, target, file, observedPaths, before }
                fixture.junctions.push(record)
                fixture.setPhase("junction-creation")
                await symlink(target, junction, "junction")
                createdJunctions.push(junction)
                expect((await lstat(junction)).isSymbolicLink()).toBe(true)
                expect((await stat(junction)).isDirectory()).toBe(true)
                const throughJunction = win32.join(junction, ...(structural ? ["secure-parent"] : []), "credentials.json")
                fixture.setPhase("denied-read")
                await expectCredentialError((): Promise<unknown> => readSecureWindowsFile(throughJunction, FILE_MAX_BYTES, { expectedSid }), "denied", "file-read-denied")
                fixture.setPhase("denied-existing-write")
                await expectCredentialError((): Promise<void> => writeSecureWindowsFile(throughJunction, REPLACEMENT_CONTENTS, FILE_MAX_BYTES, { expectedSid }), "denied", "file-write-denied")
                const absent = structural
                    ? win32.join(junction, "must-not-create", "credentials.json")
                    : win32.join(junction, "must-not-create.json")
                fixture.setPhase("denied-new-write")
                await expectCredentialError((): Promise<void> => writeSecureWindowsFile(absent, REPLACEMENT_CONTENTS, FILE_MAX_BYTES, { expectedSid }), "denied", "file-write-denied")
                fixture.setPhase("post-integrity")
                await expectAbsent(structural ? win32.join(target, "must-not-create") : win32.join(target, "must-not-create.json"))
                expect(await observePaths(fixture, observedPaths)).toEqual(before)
                await expectContents(file, SYNTHETIC_CONTENTS)
            })
        }, TEST_TIMEOUT_MS)
    }

    test("rejects a directory used as a credential file without changing it", async (): Promise<void> => {
        await withFileFixture(async (fixture: FileFixture): Promise<void> => {
            const parent = win32.join(fixture.root, "nonregular")
            const seed = win32.join(parent, "seed.json")
            await writeSecureWindowsFile(seed, SYNTHETIC_CONTENTS, FILE_MAX_BYTES, { expectedSid })
            const directory = win32.join(parent, "directory.json")
            await mkdir(directory)
            const marker = win32.join(directory, "marker.txt")
            await writeFile(marker, SYNTHETIC_CONTENTS, "utf8")
            const paths = [fixture.root, parent, directory, marker]
            const before = await observePaths(fixture, paths)
            expectOwnerOnly(before[1].acl, true)
            expect(before[2].directory).toBe(true)
            await expectCredentialError((): Promise<unknown> => readSecureWindowsFile(directory, FILE_MAX_BYTES, { expectedSid }), "denied")
            await expectCredentialError((): Promise<void> => writeSecureWindowsFile(directory, REPLACEMENT_CONTENTS, FILE_MAX_BYTES, { expectedSid }), "denied")
            expect(await observePaths(fixture, paths)).toEqual(before)
            expect(await readFile(marker, "utf8") === SYNTHETIC_CONTENTS).toBe(true)
        })
    }, TEST_TIMEOUT_MS)

    test("rejects relative, loopback UNC, and ADS paths before accessing their targets", async (): Promise<void> => {
        await withFileFixture(async (fixture: FileFixture): Promise<void> => {
            const parent = win32.join(fixture.root, "invalid-paths")
            const path = win32.join(parent, "credentials.json")
            await writeSecureWindowsFile(path, SYNTHETIC_CONTENTS, FILE_MAX_BYTES, { expectedSid })
            const paths = [fixture.root, parent, path]
            const before = await observePaths(fixture, paths)
            const relative = win32.relative(win32.join(WINDOWS_ROOT, "System32"), path)
            const loopbackUnc = `\\\\127.0.0.1\\C$\\${path.slice(3)}`
            const ads = `${path}:fixture-stream`
            for (const invalidPath of [relative, loopbackUnc, ads]) {
                await expectCredentialError((): Promise<unknown> => readSecureWindowsFile(invalidPath, FILE_MAX_BYTES, { expectedSid }), "invalid")
                await expectCredentialError((): Promise<void> => writeSecureWindowsFile(invalidPath, REPLACEMENT_CONTENTS, FILE_MAX_BYTES, { expectedSid }), "invalid")
            }
            let streamMissing = false
            try { await readFile(ads) } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not verify fixture alternate stream absence.")
                streamMissing = true
            }
            expect(streamMissing).toBe(true)
            expect(await observePaths(fixture, paths)).toEqual(before)
            await expectContents(path, SYNTHETIC_CONTENTS)
        })
    }, TEST_TIMEOUT_MS)

    test("denies a different canonical expectedSid before reading, mutating, or creating paths", async (): Promise<void> => {
        await withFileFixture(async (fixture: FileFixture): Promise<void> => {
            const parent = win32.join(fixture.root, "expected-account")
            const path = win32.join(parent, "credentials.json")
            await writeSecureWindowsFile(path, SYNTHETIC_CONTENTS, FILE_MAX_BYTES, { expectedSid })
            const systemSid = "S-1-5-18"
            const wrongSid = expectedSid === systemSid ? "S-1-5-19" : systemSid
            const absentParent = win32.join(fixture.root, "wrong-account-must-not-create")
            const absent = win32.join(absentParent, "credentials.json")
            const paths = [fixture.root, parent, path]
            const before = await observePaths(fixture, paths)
            for (const target of [path, absent]) {
                await expectCredentialError((): Promise<unknown> => readSecureWindowsFile(target, FILE_MAX_BYTES, { expectedSid: wrongSid }), "denied")
                await expectCredentialError((): Promise<void> => writeSecureWindowsFile(target, REPLACEMENT_CONTENTS, FILE_MAX_BYTES, { expectedSid: wrongSid }), "denied")
            }
            await expectAbsent(absentParent)
            expect(await observePaths(fixture, paths)).toEqual(before)
            await expectContents(path, SYNTHETIC_CONTENTS)
        })
    }, TEST_TIMEOUT_MS)
})
