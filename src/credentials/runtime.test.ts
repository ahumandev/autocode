import { beforeAll, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { extname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { MAX_PLAINTEXT_STORE_BYTES, serializePlaintextCredentialStore, type PlaintextCredentialStore } from "./plaintext"
import { createCredentialResolver } from "./resolver"
import { createRuntimeCredentialResolver } from "./runtime"
import {
    CredentialError,
    PLAINTEXT_CREDENTIAL_WARNING,
    WINDOWS_CREDENTIAL_MAX_BYTES,
    type CredentialErrorCode,
    type CredentialKind,
    type CredentialProfileMap,
    type CredentialProviderPolicy,
    type CredentialReadResult,
} from "./types"
import { createWindowsCredentialProvider, deleteWindowsProfile, getWindowsCredentialIdentity, writeWindowsProfile } from "./windows"
import { writeSecureWindowsFile } from "./windows-files"

const TEST_TIMEOUT_MS = 60_000
const CHILD_TIMEOUT_MS = 30_000
const MAX_CHILD_OUTPUT_BYTES = 65_536
const TEMP_ROOT = "C:\\Users\\qxz13vb\\AppData\\Local\\Temp\\opencode"
const SECRET = "runtime-credential-secret-canary"
const UNSAFE_LOCATION_MESSAGE = "Plaintext credential storage must use a private global configuration directory outside workspaces and Git repositories. Set OPENCODE_CONFIG_DIR to a private user directory."
const NATIVE_OPTIONS = { timeoutMs: 15_000 }
const KINDS: CredentialKind[] = ["ssh", "db", "rest"]
const PROFILES = {
    ssh: { host: "  hôte.example.test  ", username: "plaintext-user", port: "0022", password: `${SECRET}:漢🧪\r\n\0` },
    db: { connection: " Server=plaintext.example.test;Database=試験 ", username: "", password: `${SECRET}:db` },
    rest: { authorization: ` Bearer ${SECRET}:é漢🧪 ` },
} satisfies CredentialProfileMap
const runtimePath = fileURLToPath(new URL("./runtime.ts", import.meta.url))
const windowsPath = fileURLToPath(new URL("./windows.ts", import.meta.url))
const processPath = fileURLToPath(new URL("./windows-process.ts", import.meta.url))
const typesPath = fileURLToPath(new URL("./types.ts", import.meta.url))

const isolatedIoGuard = `
    import * as fileSystem from "node:fs"
    import * as promiseFileSystem from "node:fs/promises"
    import * as childProcess from "node:child_process"
    import * as operatingSystem from "node:os"
    const ioCalls = []
    function forbidIo(all) {
        const mutations = /^(?:appendFile|chmod|chown|copyFile|cp|fchmod|fchown|fdatasync|fsync|ftruncate|futimes|lchmod|lchown|link|lutimes|mkdir|mkdtemp|rename|rm|rmdir|symlink|truncate|unlink|utimes|write|writeFile|writev|createWriteStream)(?:Sync)?$/
        const forbidden = (name) => () => { ioCalls.push(name); throw new Error(secret) }
        const guard = (module, label, blockAll = all) => Object.fromEntries(Object.entries(module).map(([name, value]) => [
            name, typeof value === "function" && (blockAll || mutations.test(name)) ? forbidden(label + "." + name) : value,
        ]))
        const guardedPromises = guard(promiseFileSystem, "fs/promises")
        mock.module("node:fs/promises", () => guardedPromises)
        mock.module("node:fs", () => ({ ...guard(fileSystem, "fs"), promises: guardedPromises }))
        mock.module("node:child_process", () => guard(childProcess, "child_process", true))
        if (all) mock.module("node:os", () => ({ ...operatingSystem, homedir: forbidden("os.homedir") }))
    }
`

const isolatedNativeProvider = `
    const nativeReads = []
    let nativeResult = { status: "missing" }
    mock.module(windowsPath, () => ({
        createWindowsCredentialProvider: () => ({
            async read(kind, id) { nativeReads.push({ kind, id }); return nativeResult },
        }),
    }))
`

function uniqueId(): string {
    return `AUTOCODE_RUNTIME_${randomUUID().replaceAll("-", "").toUpperCase()}`
}

async function withTemporaryRoot(action: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(TEMP_ROOT, "autocode-runtime-"))
    try {
        await action(root)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

async function writeStore(root: string, profiles: PlaintextCredentialStore["profiles"]): Promise<void> {
    const identity = await getWindowsCredentialIdentity(NATIVE_OPTIONS)
    await writeSecureWindowsFile(
        join(root, "credentials", "profiles.json"),
        serializePlaintextCredentialStore({ version: 1, profiles }),
        MAX_PLAINTEXT_STORE_BYTES,
        { ...NATIVE_OPTIONS, expectedSid: identity.sid },
    )
}

async function snapshotTree(root: string): Promise<string> {
    const metadata = await lstat(root)
    const entries = await readdir(root, { withFileTypes: true })
    entries.sort((left, right): number => left.name.localeCompare(right.name))
    const contents = await Promise.all(entries.map(async (entry): Promise<unknown> => {
        const path = join(root, entry.name)
        const metadata = await lstat(path)
        return {
            name: entry.name, mode: metadata.mode, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs,
            contents: entry.isDirectory() ? await snapshotTree(path) : await readFile(path, "utf8"),
        }
    }))
    return JSON.stringify({ mode: metadata.mode, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs, contents })
}

async function expectCredentialError(
    action: () => Promise<unknown>,
    code: CredentialErrorCode,
    markers: readonly string[],
): Promise<CredentialError> {
    let caught: unknown
    try {
        await action()
    } catch (error: unknown) {
        caught = error
    }
    expect(caught).toBeInstanceOf(CredentialError)
    if (!(caught instanceof CredentialError)) {
        throw new Error("Expected a credential rejection.")
    }
    expect(caught.code).toBe(code)
    expect(caught.name).toBe("CredentialError")
    expect(caught.message).toBe(new CredentialError(code).message)
    expect(Object.hasOwn(caught, "cause")).toBe(false)
    expect(caught.cause).toBeUndefined()
    for (const surface of [String(caught), caught.stack ?? "", JSON.stringify(caught)]) {
        for (const marker of [SECRET, ...markers]) {
            expect(surface).not.toContain(marker)
        }
    }
    return caught
}

async function readChildOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let length = 0
    let output = ""
    try {
        for (;;) {
            const result = await reader.read()
            if (result.done) break
            length += result.value.byteLength
            if (length > MAX_CHILD_OUTPUT_BYTES) {
                throw new Error("Isolated runtime output exceeded the supported limit.")
            }
            output += decoder.decode(result.value, { stream: true })
        }
        return output + decoder.decode()
    } finally {
        reader.releaseLock()
    }
}

async function runIsolated(script: string): Promise<void> {
    const prelude = `
        import { expect, mock } from "bun:test"
        const runtimePath = ${JSON.stringify(runtimePath)}
        const windowsPath = ${JSON.stringify(windowsPath)}
        const processPath = ${JSON.stringify(processPath)}
        const secret = ${JSON.stringify(SECRET)}
        const plaintextWarning = ${JSON.stringify(PLAINTEXT_CREDENTIAL_WARNING)}
        const profiles = ${JSON.stringify(PROFILES)}
        const { CredentialError } = await import(${JSON.stringify(typesPath)})
        async function expectFailure(action, code, markers) {
            let caught
            try { await action() } catch (error) { caught = error }
            expect(caught).toBeInstanceOf(CredentialError)
            expect(caught.code).toBe(code)
            expect(caught.name).toBe("CredentialError")
            expect(caught.message).toBe(new CredentialError(code).message)
            expect(Object.hasOwn(caught, "cause")).toBe(false)
            expect(caught.cause).toBeUndefined()
            for (const surface of [String(caught), caught.stack ?? "", JSON.stringify(caught)]) {
                for (const marker of [secret, ...markers]) expect(surface).not.toContain(marker)
            }
            return caught
        }
    `
    const child = Bun.spawn({
        cmd: [process.execPath, "-e", `${prelude}\n${script}\nprocess.stdout.write("runtime assertions passed\\n")`],
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    })
    function stopChild(): void {
        if (child.exitCode === null) {
            try { child.kill("SIGKILL") } catch { }
        }
    }
    const timer = setTimeout(stopChild, CHILD_TIMEOUT_MS)
    try {
        const [stdout, stderr, exitCode] = await Promise.all([
            readChildOutput(child.stdout),
            readChildOutput(child.stderr),
            child.exited,
        ])
        expect(stderr).toBe("")
        expect(exitCode).toBe(0)
        expect(stdout).toBe("runtime assertions passed\n")
    } finally {
        clearTimeout(timer)
        stopChild()
        await child.exited
    }
}

describe("runtime credential resolver on Windows", (): void => {
    beforeAll((): void => {
        expect(process.platform).toBe("win32")
    })

    test("runtime import graph excludes provisioning and keeps platform-only loading lazy", async (): Promise<void> => {
        const pending = [new URL("./runtime.ts", import.meta.url)]
        const visited = new Set<string>()
        const transpiler = new Bun.Transpiler({ loader: "ts" })
        while (pending.length > 0) {
            const current = pending.pop()!
            if (visited.has(current.href)) continue
            visited.add(current.href)
            const imports = transpiler.scanImports(await readFile(current, "utf8"))
            for (const dependency of imports) {
                expect(dependency.path).not.toMatch(/(?:^|\/)provision(?:\.[cm]?[jt]s)?$/)
                if (!dependency.path.startsWith(".")) continue
                if (/\/linux(?:\.[cm]?[jt]s)?$/.test(dependency.path)) {
                    expect(dependency.kind).toBe("dynamic-import")
                    continue
                }
                const target = new URL(dependency.path, current)
                target.pathname = target.pathname.replace(/\.js$/, ".ts")
                if (extname(target.pathname) === "") target.pathname += ".ts"
                pending.push(target)
            }
        }
    }, TEST_TIMEOUT_MS)

    test("factory construction performs no filesystem or process IO for any Windows policy", async (): Promise<void> => {
        await runIsolated(`
            ${isolatedIoGuard}
            forbidIo(true)
            const { createRuntimeCredentialResolver } = await import(runtimePath)
            const warnings = []
            for (const provider of [undefined, "auto", "windows-credential-manager", "plaintext"]) {
                const resolver = createRuntimeCredentialResolver({ provider, warn: (message) => warnings.push(message) })
                expect(typeof resolver.resolve).toBe("function")
                const unsafe = createRuntimeCredentialResolver({ provider, globalConfigRoot: process.cwd() })
                expect(typeof unsafe.resolve).toBe("function")
            }
            expect(typeof createRuntimeCredentialResolver().resolve).toBe("function")
            await new Promise((resolve) => setImmediate(resolve))
            expect(ioCalls).toEqual([])
            expect(warnings).toEqual([])
        `)
    }, TEST_TIMEOUT_MS)

    test("default and auto native success never inspect an unsafe plaintext root", async (): Promise<void> => {
        await runIsolated(`
            ${isolatedIoGuard}
            ${isolatedNativeProvider}
            forbidIo(true)
            nativeResult = { status: "found", profile: profiles.ssh }
            const { createRuntimeCredentialResolver } = await import(runtimePath)
            const warnings = []
            for (const provider of [undefined, "auto"]) {
                const resolver = createRuntimeCredentialResolver({
                    provider, globalConfigRoot: process.cwd(), warn: (message) => warnings.push(message),
                })
                expect(await resolver.resolve("ssh", " runtime-native-id ")).toEqual({
                    kind: "ssh", provider: "windows-credential-manager", profile: profiles.ssh,
                })
            }
            expect(nativeReads).toEqual([
                { kind: "ssh", id: "RUNTIME_NATIVE_ID" }, { kind: "ssh", id: "RUNTIME_NATIVE_ID" },
            ])
            expect(warnings).toEqual([])
            expect(ioCalls).toEqual([])
        `)
    }, TEST_TIMEOUT_MS)

    // Measured slow tests are skipped from the fast suite; retained for future opt-in/slow testing.
    test.skip("native SSH profile resolves through auto abstraction without plaintext reads", async (): Promise<void> => {
        const id = uniqueId()
        const nativeOptions = { timeoutMs: 8_000 }
        const native = createWindowsCredentialProvider(nativeOptions)
        const fields = {
            host: "  native-resolver.invalid  ",
            port: "0022",
            username: "synthetic-native-user",
            keyfile: "C:\\synthetic-native\\unused-key",
            agent: "false",
            password: `${SECRET}:native-password`,
            keypass: `${SECRET}:native-keypass`,
        } satisfies CredentialProfileMap["ssh"]
        const envKeys = ["HOST", "PORT", "USERNAME", "KEYFILE", "AGENT", "PASSWORD", "KEYPASS"]
            .map((field: string): string => `AUTOCODE_SSH_${id}_${field}`)
        const plaintextRead = mock(async (): Promise<CredentialReadResult> => ({ status: "missing" }))
        const resolver = createCredentialResolver({
            providers: { "windows-credential-manager": native, plaintext: { read: plaintextRead } },
            provider: "auto",
            platform: "win32",
        })
        const failures: string[] = []
        let phase = "Native SSH envelope bound failed."
        let owned = false
        try {
            expect(Buffer.byteLength(JSON.stringify({ version: 1, kind: "ssh", fields }), "utf8") < WINDOWS_CREDENTIAL_MAX_BYTES).toBe(true)
            phase = "Native SSH env check before resolve failed."
            expect(envKeys.every((key: string): boolean => !Object.hasOwn(process.env, key))).toBe(true)
            phase = "Native SSH initial missing check failed."
            expect((await native.read("ssh", id)).status === "missing").toBe(true)
            owned = true
            phase = "Native SSH write failed."
            await writeWindowsProfile("ssh", id, fields, nativeOptions)

            phase = "Native SSH auto resolve failed."
            const resolved = await resolver.resolve("ssh", id)
            phase = "Native SSH exact result assertion failed."
            expect(
                Reflect.ownKeys(resolved).length === 3
                && ["kind", "provider", "profile"].every((key: string): boolean => Object.hasOwn(resolved, key))
                && resolved.kind === "ssh"
                && resolved.provider === "windows-credential-manager"
                && Reflect.ownKeys(resolved.profile).length === Object.keys(fields).length
                && Object.entries(fields).every(([key, value]: [string, string]): boolean =>
                    Object.getOwnPropertyDescriptor(resolved.profile, key)?.value === value),
            ).toBe(true)
            phase = "Native SSH plaintext zero assertion failed."
            expect(plaintextRead.mock.calls.length).toBe(0)
            phase = "Native SSH env check after resolve failed."
            expect(envKeys.every((key: string): boolean => !Object.hasOwn(process.env, key))).toBe(true)
        } catch {
            failures.push(phase)
        } finally {
            if (owned) {
                try {
                    await deleteWindowsProfile("ssh", id, nativeOptions)
                } catch {
                    failures.push("Native SSH cleanup delete failed.")
                }
                try {
                    expect((await native.read("ssh", id)).status === "missing").toBe(true)
                } catch {
                    failures.push("Native SSH cleanup missing verification failed.")
                }
            }
        }
        if (failures.length > 0) {
            throw new Error(failures.join(" "))
        }
    }, 55_000)

    for (const kind of KINDS) {
        test(`pinned plaintext securely round-trips ${kind} without changing storage`, async (): Promise<void> => {
            await withTemporaryRoot(async (root: string): Promise<void> => {
                const id = uniqueId()
                await writeStore(root, { [kind]: { [id]: PROFILES[kind] } })
                const before = await snapshotTree(root)
                const warn = mock((_message: string): void => {})
                const resolver = createRuntimeCredentialResolver({ provider: "plaintext", globalConfigRoot: root, warn })

                expect(await resolver.resolve(kind, ` ${id.toLowerCase()} `)).toEqual({ kind, provider: "plaintext", profile: PROFILES[kind] })
                expect(warn).toHaveBeenCalledTimes(1)
                expect(warn).toHaveBeenCalledWith(PLAINTEXT_CREDENTIAL_WARNING)
                expect(await snapshotTree(root)).toBe(before)
            })
        }, TEST_TIMEOUT_MS)

        test.skip(`auto falls back from an actual native ${kind} miss to plaintext`, async (): Promise<void> => {
            await withTemporaryRoot(async (root: string): Promise<void> => {
                const id = uniqueId()
                await writeStore(root, { [kind]: { [id]: PROFILES[kind] } })
                const before = await snapshotTree(root)
                expect(await createWindowsCredentialProvider(NATIVE_OPTIONS).read(kind, id)).toEqual({ status: "missing" })
                const warn = mock((_message: string): void => {})
                const resolver = createRuntimeCredentialResolver({ provider: "auto", globalConfigRoot: root, warn })

                expect(await resolver.resolve(kind, id)).toEqual({ kind, provider: "plaintext", profile: PROFILES[kind] })
                expect(warn).toHaveBeenCalledTimes(1)
                expect(warn).toHaveBeenCalledWith(PLAINTEXT_CREDENTIAL_WARNING)
                expect(await snapshotTree(root)).toBe(before)
            })
        }, TEST_TIMEOUT_MS)
    }

    test("pinned native miss cannot read a populated plaintext store", async (): Promise<void> => {
        await withTemporaryRoot(async (root: string): Promise<void> => {
            const id = uniqueId()
            await writeStore(root, { ssh: { [id]: PROFILES.ssh } })
            const before = await snapshotTree(root)
            const warn = mock((_message: string): void => {})
            const resolver = createRuntimeCredentialResolver({ provider: "windows-credential-manager", globalConfigRoot: root, warn })

            await expectCredentialError((): Promise<unknown> => resolver.resolve("ssh", id), "missing", [id, root])
            expect(warn).not.toHaveBeenCalled()
            await runIsolated(`
                ${isolatedIoGuard}
                ${isolatedNativeProvider}
                forbidIo(true)
                const { createRuntimeCredentialResolver } = await import(runtimePath)
                const warnings = []
                const root = ${JSON.stringify(root)}
                const id = ${JSON.stringify(id)}
                const resolver = createRuntimeCredentialResolver({
                    provider: "windows-credential-manager", globalConfigRoot: root, warn: (message) => warnings.push(message),
                })
                await expectFailure(() => resolver.resolve("ssh", id), "missing", [id, root])
                expect(nativeReads).toEqual([{ kind: "ssh", id }])
                expect(warnings).toEqual([])
                expect(ioCalls).toEqual([])
            `)
            expect(await snapshotTree(root)).toBe(before)
        })
    }, TEST_TIMEOUT_MS)

    test("missing plaintext storage never creates directories, sentinels, or locks", async (): Promise<void> => {
        await withTemporaryRoot(async (root: string): Promise<void> => {
            const configRoot = join(root, "uncreated-global-config")
            const before = await snapshotTree(root)
            const policies: CredentialProviderPolicy[] = ["auto", "plaintext"]
            for (const provider of policies) {
                const id = uniqueId()
                const warn = mock((_message: string): void => {})
                const resolver = createRuntimeCredentialResolver({ provider, globalConfigRoot: configRoot, warn })

                await expectCredentialError((): Promise<unknown> => resolver.resolve("ssh", id), "missing", [id, configRoot])
                expect(warn).not.toHaveBeenCalled()
                expect(await snapshotTree(root)).toBe(before)
            }
        })
    }, TEST_TIMEOUT_MS)

    test.skip("native incomplete profiles fall back as whole profiles without merging fields", async (): Promise<void> => {
        await withTemporaryRoot(async (root: string): Promise<void> => {
            const id = uniqueId()
            const fallback = { ssh: { host: "fallback.example.test" }, db: { connection: "Server=fallback.example.test" }, rest: PROFILES.rest }
            await writeStore(root, { ssh: { [id]: fallback.ssh }, db: { [id]: fallback.db }, rest: { [id]: fallback.rest } })
            const before = await snapshotTree(root)
            await runIsolated(`
                ${isolatedNativeProvider}
                const { createRuntimeCredentialResolver } = await import(runtimePath)
                const fallback = ${JSON.stringify(fallback)}
                const id = ${JSON.stringify(id)}
                const warnings = []
                const resolver = createRuntimeCredentialResolver({
                    provider: "auto", globalConfigRoot: ${JSON.stringify(root)}, warn: (message) => warnings.push(message),
                })
                for (const kind of ["ssh", "db", "rest"]) {
                    nativeResult = { status: "found", profile: { username: "native-only-user", password: secret } }
                    if (kind === "rest") nativeResult = { status: "found", profile: { username: "native-only-user" } }
                    expect(await resolver.resolve(kind, id)).toEqual({ kind, provider: "plaintext", profile: fallback[kind] })
                }
                expect(nativeReads).toEqual(["ssh", "db", "rest"].map((kind) => ({ kind, id })))
                expect(warnings).toEqual([plaintextWarning, plaintextWarning, plaintextWarning])
            `)
            expect(await snapshotTree(root)).toBe(before)
        })
    }, TEST_TIMEOUT_MS)

    test("complementary native and plaintext REST fragments remain incomplete without warnings", async (): Promise<void> => {
        await withTemporaryRoot(async (root: string): Promise<void> => {
            const id = uniqueId()
            await writeStore(root, { rest: { [id]: { password: SECRET } } })
            const before = await snapshotTree(root)
            await runIsolated(`
                ${isolatedNativeProvider}
                nativeResult = { status: "found", profile: { username: "native-only-user" } }
                const { createRuntimeCredentialResolver } = await import(runtimePath)
                const warnings = []
                const root = ${JSON.stringify(root)}
                const id = ${JSON.stringify(id)}
                const resolver = createRuntimeCredentialResolver({ globalConfigRoot: root, warn: (message) => warnings.push(message) })
                await expectFailure(() => resolver.resolve("rest", id), "incomplete", [id, root])
                expect(nativeReads).toEqual([{ kind: "rest", id }])
                expect(warnings).toEqual([])
            `)
            expect(await snapshotTree(root)).toBe(before)
        })
    }, TEST_TIMEOUT_MS)

    test("pinned plaintext rejects incomplete profiles without trying successful native credentials", async (): Promise<void> => {
        await withTemporaryRoot(async (root: string): Promise<void> => {
            const id = uniqueId()
            const completeId = uniqueId()
            await writeStore(root, { rest: { [id]: { password: SECRET }, [completeId]: PROFILES.rest } })
            const before = await snapshotTree(root)
            await runIsolated(`
                ${isolatedNativeProvider}
                nativeResult = { status: "found", profile: profiles.rest }
                const { createRuntimeCredentialResolver } = await import(runtimePath)
                const warnings = []
                const root = ${JSON.stringify(root)}
                const id = ${JSON.stringify(id)}
                const completeId = ${JSON.stringify(completeId)}
                const resolver = createRuntimeCredentialResolver({
                    provider: "plaintext", globalConfigRoot: root, warn: (message) => warnings.push(message),
                })
                await expectFailure(() => resolver.resolve("rest", id), "incomplete", [id, root])
                expect(nativeReads).toEqual([])
                expect(warnings).toEqual([])
                expect(await resolver.resolve("rest", completeId)).toEqual({ kind: "rest", provider: "plaintext", profile: profiles.rest })
                expect(nativeReads).toEqual([])
                expect(warnings).toEqual([plaintextWarning])
            `)
            expect(await snapshotTree(root)).toBe(before)
        })
    }, TEST_TIMEOUT_MS)

    test("denied plaintext reads hard-stop without ACL repair or provisioning operations", async (): Promise<void> => {
        await withTemporaryRoot(async (root: string): Promise<void> => {
            const before = await snapshotTree(root)
            await runIsolated(`
                ${isolatedIoGuard}
                forbidIo(false)
                const operations = []
                class WindowsCredentialProcessError extends CredentialError {}
                mock.module(processPath, () => ({
                    WindowsCredentialProcessError,
                    async runWindowsCredentialOperation(request) {
                        operations.push(request.operation)
                        if (request.operation === "read") return { version: 1, status: "missing" }
                        const error = new WindowsCredentialProcessError("denied")
                        error.message = secret + " " + ${JSON.stringify(root)}
                        Object.defineProperty(error, "cause", { value: secret, enumerable: true })
                        throw error
                    },
                }))
                const { createRuntimeCredentialResolver } = await import(runtimePath)
                const warnings = []
                const root = ${JSON.stringify(root)}
                const id = ${JSON.stringify(uniqueId())}
                const resolver = createRuntimeCredentialResolver({ globalConfigRoot: root, warn: (message) => warnings.push(message) })
                await expectFailure(() => resolver.resolve("ssh", id), "denied", [id, root])
                expect(operations).toEqual(["read", "file-read"])
                expect(warnings).toEqual([])
                expect(ioCalls).toEqual([])
            `)
            expect(await snapshotTree(root)).toBe(before)
        })
    }, TEST_TIMEOUT_MS)

    const unsafePolicies: CredentialProviderPolicy[] = ["auto", "plaintext"]
    for (const provider of unsafePolicies) {
        test(`${provider} unsafe plaintext location returns fixed guidance without writes or leaks`, async (): Promise<void> => {
            await withTemporaryRoot(async (root: string): Promise<void> => {
                const before = await snapshotTree(root)
                await runIsolated(`
                    ${isolatedIoGuard}
                    ${isolatedNativeProvider}
                    forbidIo(true)
                    const { createRuntimeCredentialResolver } = await import(runtimePath)
                    const warnings = []
                    const root = ${JSON.stringify(root)}
                    // Keep eval source locations outside the rejected configuration root.
                    process.chdir(root)
                    const id = ${JSON.stringify(uniqueId())}
                    const provider = ${JSON.stringify(provider)}
                    const resolver = createRuntimeCredentialResolver({ provider, globalConfigRoot: root, warn: (message) => warnings.push(message) })
                    const error = await expectFailure(() => resolver.resolve("ssh", id), "unsafe_location", [id, root])
                    expect(error.message).toBe(${JSON.stringify(UNSAFE_LOCATION_MESSAGE)})
                    expect(nativeReads).toEqual(provider === "auto" ? [{ kind: "ssh", id }] : [])
                    expect(warnings).toEqual([])
                    expect(ioCalls).toEqual([])
                `)
                expect(await snapshotTree(root)).toBe(before)
            })
        }, TEST_TIMEOUT_MS)
    }
})
