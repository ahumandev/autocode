import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CredentialReadResult } from "./credentials/types"
import {
    createWindowsCredentialProvider,
    deleteWindowsProfile,
    getWindowsCredentialIdentity,
    type WindowsCredentialIdentity,
} from "./credentials/windows"

const TEMP_ROOT = tmpdir()
const WINDOWS_ROOT = "C:\\Windows"
const NATIVE_TIMEOUT_MS = 15_000
const CHILD_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 16_384
const SUCCESS_MARKER = "HELPER_ENV_ISOLATED\n"
const PROBE_SOURCE = String.raw`
import { mock } from "bun:test"
import { fileURLToPath } from "node:url"

let passed = false
try {
    const childProcess = await import("node:child_process")
    const realExports = { ...childProcess }
    const realSpawn = childProcess.spawn
    const sourceUrl = process.env.CLI_HELPER_ENV_SOURCE_URL
    const id = process.env.CLI_HELPER_ENV_ID
    const sid = process.env.CLI_HELPER_ENV_SID
    if (!sourceUrl || !id || !sid || !/^[A-Z0-9_]+$/.test(id)) throw new Error("Invalid probe setup.")
    const authorization = process.env["AUTOCODE_REST_" + id + "_AUTHORIZATION"]
    if (!authorization) throw new Error("Missing probe input.")
    const expectedHelper = fileURLToPath(new URL("./credentials/windows-credentials.ps1", sourceUrl))
    const expectedExecutable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    const allowedKeys = new Set(["SystemRoot", "WINDIR", "TEMP", "TMP"])
    const captures = []

    function observedSpawn(command, args, options) {
        const capture = { helper: false, safe: false, spawned: false, closed: false }
        captures.push(capture)
        try {
            capture.helper = typeof command === "string"
                && command.toLowerCase() === expectedExecutable.toLowerCase()
                && Array.isArray(args) && args.includes("-File") && args.at(-1) === expectedHelper
            const environment = options?.env
            if (environment && typeof environment === "object" && !Array.isArray(environment)) {
                const keys = Object.keys(environment)
                capture.safe = keys.length > 0 && keys.every((key) => allowedKeys.has(key)
                    && !/^AUTOCODE_/i.test(key) && key.toUpperCase() !== "OPENCODE_CONFIG_DIR"
                    && !/^CLI_HELPER_ENV_/i.test(key)
                    && typeof environment[key] === "string" && !environment[key].includes(authorization))
            }
        } catch { }
        const child = realSpawn(command, args, options)
        child.once("spawn", () => { capture.spawned = true })
        child.once("close", (code, signal) => { capture.closed = code === 0 && signal === null })
        return child
    }

    mock.module("node:child_process", () => ({ ...realExports, spawn: observedSpawn }))
    const { runCredentialsCli } = await import(sourceUrl)
    const importSafe = captures.length === 0 && process.exitCode === undefined
    const code = importSafe ? await runCredentialsCli([
        "import-env", "--provider", "windows-credential-manager", "--kind", "rest",
        "--key", id, "--expected-sid", sid,
    ]) : 1
    passed = code === 0 && captures.length >= 2
        && captures.every((capture) => capture.helper && capture.safe && capture.spawned && capture.closed)
} catch { }
process.stdout.write(passed ? "HELPER_ENV_ISOLATED\n" : "HELPER_ENV_PROBE_FAILED\n")
process.exitCode = passed ? 0 : 1
`

type ProbeResult = { successfulExit: boolean; isolatedMarker: boolean; privateOutput: boolean }

async function safely<T>(stage: string, action: () => Promise<T>): Promise<T> {
    try {
        return await action()
    } catch {
        throw new Error(`Credential CLI helper environment probe failed (${stage}).`)
    }
}

async function runProbe(environment: NodeJS.ProcessEnv, authorization: string): Promise<ProbeResult> {
    let child: ChildProcessWithoutNullStreams
    try {
        child = spawn(process.execPath, ["--eval", PROBE_SOURCE], {
            cwd: environment.OPENCODE_CONFIG_DIR,
            env: environment,
            stdio: ["pipe", "pipe", "pipe"],
            shell: false,
            windowsHide: true,
        })
    } catch {
        throw new Error("Credential CLI helper environment probe failed (spawn).")
    }

    let closed = false
    let failure: string | undefined
    let outputBytes = 0
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []

    function killChild(): void {
        if (closed) return
        try { child.kill("SIGKILL") } catch { }
    }

    function fail(stage: string): void {
        if (closed || failure !== undefined) return
        failure = stage
        child.stdin.destroy()
        killChild()
    }

    function capture(chunks: Buffer[], chunk: Buffer): void {
        outputBytes = Math.min(MAX_OUTPUT_BYTES + 1, outputBytes + chunk.byteLength)
        if (outputBytes > MAX_OUTPUT_BYTES) fail("output-limit")
        if (failure === undefined) chunks.push(chunk)
        else chunk.fill(0)
    }

    const result = new Promise<ProbeResult>((resolve: (value: ProbeResult) => void, reject: (error: Error) => void): void => {
        const timer = setTimeout((): void => fail("timeout"), CHILD_TIMEOUT_MS)
        child.on("error", (): void => fail("spawn"))
        child.stdin.on("error", (): void => fail("stdin"))
        child.stdout.on("error", (): void => fail("stdout"))
        child.stderr.on("error", (): void => fail("stderr"))
        child.once("spawn", (): void => {
            if (failure !== undefined) killChild()
        })
        child.stdout.on("data", (chunk: Buffer): void => capture(stdout, chunk))
        child.stderr.on("data", (chunk: Buffer): void => capture(stderr, chunk))
        child.once("close", (code: number | null, signal: NodeJS.Signals | null): void => {
            closed = true
            clearTimeout(timer)
            if (failure === undefined) {
                const output = Buffer.concat(stdout).toString("utf8")
                const errors = Buffer.concat(stderr).toString("utf8")
                const escaped = JSON.stringify(authorization).slice(1, -1)
                resolve({
                    successfulExit: code === 0 && signal === null,
                    isolatedMarker: output.endsWith(SUCCESS_MARKER),
                    privateOutput: ![authorization, escaped].some((value: string): boolean =>
                        output.includes(value) || errors.includes(value)),
                })
            } else {
                reject(new Error(`Credential CLI helper environment probe failed (${failure}).`))
            }
            for (const chunk of [...stdout, ...stderr]) chunk.fill(0)
        })
    })

    try {
        try { child.stdin.end() } catch { fail("stdin") }
        return await result
    } finally {
        // Native cleanup must wait for child close, including timeout and output-limit failures.
        killChild()
        await result.catch((): void => { })
    }
}

describe.skipIf(process.platform !== "win32")("Windows CLI native helper environment", (): void => {
    // Measured slow tests are skipped from the fast suite; retained for future opt-in/slow testing.
    test.skip("real import-env helper spawns exclude credential and probe environment", async (): Promise<void> => {
        const root = await safely("temporary-root", (): Promise<string> =>
            mkdtemp(join(TEMP_ROOT, "autocode-cli-helper-env-")))
        const id = `AUTOCODE_CLI_HELPER_ENV_${randomUUID().replaceAll("-", "").toUpperCase()}`
        const authorization = `synthetic-helper-env-${randomUUID()}`
        try {
            const identity = await safely("identity", (): Promise<WindowsCredentialIdentity> =>
                getWindowsCredentialIdentity({ timeoutMs: NATIVE_TIMEOUT_MS }))
            const options = { timeoutMs: NATIVE_TIMEOUT_MS, expectedSid: identity.sid }
            try {
                const result = await runProbe({
                    SystemRoot: WINDOWS_ROOT,
                    WINDIR: WINDOWS_ROOT,
                    TEMP: root,
                    TMP: root,
                    OPENCODE_CONFIG_DIR: root,
                    CLI_HELPER_ENV_SOURCE_URL: new URL("./credentials-cli.ts", import.meta.url).href,
                    CLI_HELPER_ENV_ID: id,
                    CLI_HELPER_ENV_SID: identity.sid,
                    [`AUTOCODE_REST_${id}_AUTHORIZATION`]: authorization,
                }, authorization)
                expect(result.privateOutput, "Child output must not expose synthetic authorization.").toBe(true)
                expect(result.isolatedMarker, "Probe must intercept at least two safe real native helper launches.").toBe(true)
                expect(result.successfulExit, "CLI helper environment probe must exit successfully.").toBe(true)
                const stored = await safely("native-read", (): Promise<CredentialReadResult> =>
                    createWindowsCredentialProvider(options).read("rest", id))
                const matches = stored.status === "found" && typeof stored.profile === "object" && stored.profile !== null
                    && Object.getOwnPropertyDescriptor(stored.profile, "authorization")?.value === authorization
                expect(matches, "Native REST authorization must match synthetic input.").toBe(true)
            } finally {
                await safely("native-cleanup", (): Promise<boolean> => deleteWindowsProfile("rest", id, options))
            }
        } finally {
            await safely("temporary-cleanup", (): Promise<void> =>
                rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
        }
    }, TEST_TIMEOUT_MS)
})
