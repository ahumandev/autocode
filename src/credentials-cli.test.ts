import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import { Readable } from "node:stream"
import { runCredentialsCli, type CredentialsCliDependencies } from "./credentials-cli"
import { CredentialError, type CredentialErrorCode, type CredentialKind } from "./credentials/types"
import { serializeCredentialEnvelope } from "./credentials/validation"

type Identity = NonNullable<CredentialsCliDependencies["getWindowsCredentialIdentity"]>
type WindowsWriter = NonNullable<CredentialsCliDependencies["writeWindowsProfile"]>
type PlaintextWriter = NonNullable<CredentialsCliDependencies["writePlaintextProfile"]>
type Provider = "windows-credential-manager" | "plaintext"

interface Harness {
    deps: CredentialsCliDependencies
    output: { stdout: string; stderr: string; prompt: string }
    identityCalls: Parameters<Identity>[]
    windowsCalls: Parameters<WindowsWriter>[]
    plaintextCalls: Parameters<PlaintextWriter>[]
}

const SID = "S-1-5-21-101-202-303-1001"
const ACCOUNT = "UNIT\\opencode-service"
const LIMIT = 65536
const STREAM_TIMEOUT_MS = 2000
const CONTEXT = "Warning: Run under the actual OpenCode service logon context; matching SID alone does not prove the same logon session."
const PLAINTEXT = "Warning: Plaintext credentials are stored unencrypted at the fixed global credential path."
const USAGE = "Invalid credentials command or options. Use --help."
const SID_GUIDANCE = "Windows writes require a nonempty --expected-sid matching the current token."
const TTY_GUIDANCE = "Hidden input requires stdin and prompt output TTYs with working raw-mode support. Use --stdin instead."
const SAVED = "Credential profile saved.\n"
const ERROR_MESSAGES: Readonly<Record<CredentialErrorCode, string>> = {
    locked: "Credential store is locked.",
    denied: "Credential access or identity assertion denied.",
    invalid: "Invalid credential profile or ID.",
    unsafe_location: "Plaintext credentials require a private global configuration directory outside workspaces and Git repositories.",
    too_large: "Credential input exceeds the supported size limit.",
    failed: "Credential setup failed.",
    missing: "Credential profile is missing.",
    incomplete: "Credential profile is incomplete.",
    unavailable: "Credential provider is unavailable.",
    unsupported: "Credential setup or identity assertion is unsupported on this platform.",
}
const FIELDS: Readonly<Record<CredentialKind, readonly string[]>> = {
    ssh: ["host", "username", "port", "keyfile", "agent", "password", "keypass"],
    db: ["connection", "username", "password"],
    rest: ["authorization", "username", "password"],
}
const KINDS: readonly CredentialKind[] = ["ssh", "db", "rest"]
const PROVIDERS: readonly Provider[] = ["windows-credential-manager", "plaintext"]

function sentinel(): string {
    return `memory-only-${randomUUID()}`
}

function stdinJson(profile: unknown): Readable {
    return Readable.from([Buffer.from(JSON.stringify(profile), "utf8")])
}

function guardedInput(): { input: Readable; readonly readCount: number } {
    let readCount = 0
    const input = new Readable({
        read(): void {
            readCount++
            throw new Error(sentinel())
        },
    })
    return { input, get readCount(): number { return readCount } }
}

function makeHarness(overrides: CredentialsCliDependencies = {}): Harness {
    const output = { stdout: "", stderr: "", prompt: "" }
    const identityCalls: Parameters<Identity>[] = []
    const windowsCalls: Parameters<WindowsWriter>[] = []
    const plaintextCalls: Parameters<PlaintextWriter>[] = []
    const deps: CredentialsCliDependencies = {
        stdin: overrides.stdin ?? stdinJson({ connection: sentinel() }),
        stdout: overrides.stdout ?? { isTTY: false, write(text: string): void { output.stdout += text } },
        stderr: overrides.stderr ?? { isTTY: false, write(text: string): void { output.stderr += text } },
        promptOutput: overrides.promptOutput ?? { isTTY: false, write(text: string): void { output.prompt += text } },
        env: overrides.env ?? Object.create(null),
        platform: overrides.platform ?? "win32",
        getWindowsCredentialIdentity: async (...args: Parameters<Identity>): Promise<Awaited<ReturnType<Identity>>> => {
            identityCalls.push(args)
            return overrides.getWindowsCredentialIdentity === undefined
                ? { sid: SID, account: ACCOUNT }
                : await overrides.getWindowsCredentialIdentity(...args)
        },
        writeWindowsProfile: async (...args: Parameters<WindowsWriter>): Promise<void> => {
            windowsCalls.push(args)
            await overrides.writeWindowsProfile?.(...args)
        },
        writePlaintextProfile: async (...args: Parameters<PlaintextWriter>): Promise<void> => {
            plaintextCalls.push(args)
            await overrides.writePlaintextProfile?.(...args)
        },
    }
    return { deps, output, identityCalls, windowsCalls, plaintextCalls }
}

function commandArgs(
    command: "set" | "import-env" = "set",
    kind: CredentialKind = "db",
    provider: Provider = "windows-credential-manager",
    key: string = "selected",
): string[] {
    return [command, "--provider", provider, "--kind", kind, "--key", key]
}

function windowsArgs(
    kind: CredentialKind = "db",
    key: string = "selected",
    command: "set" | "import-env" = "set",
    provider: Provider = "windows-credential-manager",
): string[] {
    const args = [...commandArgs(command, kind, provider, key), "--expected-sid", SID]
    if (command === "set") args.push("--stdin")
    return args
}

function warnings(provider: Provider): string[] {
    return provider === "plaintext" ? [CONTEXT, PLAINTEXT] : [CONTEXT]
}

function expectNoWrites(harness: Harness): void {
    expect(harness.windowsCalls.length === 0).toBe(true)
    expect(harness.plaintextCalls.length === 0).toBe(true)
}

function expectNoLeaks(harness: Harness, values: readonly string[]): void {
    const output = harness.output.stdout + harness.output.stderr + harness.output.prompt
    for (const value of values) {
        if (value.length > 0) expect(output.includes(value)).toBe(false)
    }
}

function expectFailure(harness: Harness, result: number, message: string, guidance: readonly string[] = []): void {
    expect(result === 1).toBe(true)
    expect(harness.output.stdout === "").toBe(true)
    expect(harness.output.prompt === "").toBe(true)
    expect(harness.output.stderr === [...guidance, message].join("\n") + "\n").toBe(true)
}

function expectSaved(
    harness: Harness,
    result: number,
    kind: CredentialKind,
    id: string,
    profile: Readonly<Record<string, string>>,
    provider: Provider = "windows-credential-manager",
): void {
    const calls = provider === "plaintext" ? harness.plaintextCalls : harness.windowsCalls
    const otherCalls = provider === "plaintext" ? harness.windowsCalls : harness.plaintextCalls
    expect(result === 0).toBe(true)
    expect(calls.length === 1).toBe(true)
    expect(otherCalls.length === 0).toBe(true)
    expect(calls[0]?.[0] === kind).toBe(true)
    expect(calls[0]?.[1] === id).toBe(true)
    expect(JSON.stringify(calls[0]?.[2]) === JSON.stringify(profile)).toBe(true)
    expect(harness.output.stdout === SAVED).toBe(true)
    expect(harness.output.prompt === "").toBe(true)
    expectNoLeaks(harness, Object.values(profile))
}

function minimalProfile(kind: CredentialKind, value: string): Record<string, string> {
    if (kind === "ssh") return { host: value }
    if (kind === "db") return { connection: value }
    return { authorization: value }
}

function environmentFor(kind: CredentialKind, id: string, profile: Readonly<Record<string, string>>): Record<string, string> {
    const environment: Record<string, string> = Object.create(null)
    for (const [field, value] of Object.entries(profile)) {
        environment[`AUTOCODE_${kind.toUpperCase()}_${id}_${field.toUpperCase()}`] = value
    }
    return environment
}

function guardedEnvironment(
    kind: CredentialKind,
    id: string,
    values: Readonly<Record<string, string>>,
): { env: Readonly<Record<string, string | undefined>>; reads: string[]; readonly enumerations: number; readonly unexpectedReads: number } {
    const allowed = FIELDS[kind].map((field: string): string => `AUTOCODE_${kind.toUpperCase()}_${id}_${field.toUpperCase()}`)
    const reads: string[] = []
    let enumerations = 0
    let unexpectedReads = 0
    const env = new Proxy<Readonly<Record<string, string | undefined>>>(values, {
        get(target: Readonly<Record<string, string | undefined>>, key: string | symbol): string | undefined {
            if (typeof key !== "string" || !allowed.includes(key)) {
                unexpectedReads++
                throw new Error(sentinel())
            }
            reads.push(key)
            return target[key]
        },
        ownKeys(): never {
            enumerations++
            throw new Error(sentinel())
        },
    })
    return { env, reads, get enumerations(): number { return enumerations }, get unexpectedReads(): number { return unexpectedReads } }
}

describe("runCredentialsCli identity and help", (): void => {
    test("identity prints checked SID, account, and service logon guidance without reading input", async (): Promise<void> => {
        const input = guardedInput()
        const harness = makeHarness({ stdin: input.input })
        const result = await runCredentialsCli(["identity"], harness.deps)
        expect(result === 0).toBe(true)
        expect(harness.output.stdout === `SID: ${SID}\nAccount: ${ACCOUNT}\n${CONTEXT}\n`).toBe(true)
        expect(harness.output.stderr === "").toBe(true)
        expect(harness.output.prompt === "").toBe(true)
        expect(harness.identityCalls.length === 1).toBe(true)
        expect(harness.identityCalls[0]?.length === 0).toBe(true)
        expect(input.readCount === 0).toBe(true)
        expectNoWrites(harness)
    })

    const invalidIdentities: [string, (value: string) => unknown][] = [
        ["null", (): unknown => null],
        ["missing fields", (): unknown => ({})],
        ["non-string SID", (value: string): unknown => ({ sid: 1, account: value })],
        ["non-string account", (value: string): unknown => ({ sid: value, account: false })],
        ["empty SID", (value: string): unknown => ({ sid: "", account: value })],
        ["empty account", (value: string): unknown => ({ sid: value, account: "" })],
        ["SID line break", (value: string): unknown => ({ sid: value + "\n", account: ACCOUNT })],
        ["account control character", (value: string): unknown => ({ sid: SID, account: value + "\u0085" })],
        ["oversized SID bytes", (value: string): unknown => ({ sid: value + "é".repeat(LIMIT / 2), account: ACCOUNT })],
        ["oversized account bytes", (value: string): unknown => ({ sid: SID, account: value + "é".repeat(LIMIT / 2) })],
    ]
    test.each(invalidIdentities)("rejects identity with %s", async (_name, create): Promise<void> => {
        const value = sentinel()
        const harness = makeHarness({
            getWindowsCredentialIdentity: async (): Promise<Awaited<ReturnType<Identity>>> => create(value) as Awaited<ReturnType<Identity>>,
        })
        const result = await runCredentialsCli(["identity"], harness.deps)
        expectFailure(harness, result, ERROR_MESSAGES.failed)
        expectNoLeaks(harness, [value])
        expectNoWrites(harness)
    })

    test("Linux identity is unsupported without invoking Windows identity", async (): Promise<void> => {
        const input = guardedInput()
        const harness = makeHarness({ platform: "linux", stdin: input.input })
        expectFailure(harness, await runCredentialsCli(["identity"], harness.deps), ERROR_MESSAGES.unsupported)
        expect(harness.identityCalls.length === 0).toBe(true)
        expect(input.readCount === 0).toBe(true)
        expectNoWrites(harness)
    })

    test.each([
        ["top-level long", ["--help"]],
        ["top-level short", ["-h"]],
        ["identity", ["identity", "--help"]],
        ["set", ["set", "-h"]],
        ["import-env", ["import-env", "--help"]],
    ] as [string, string[]][])("%s help reads no credentials", async (_name, args): Promise<void> => {
        const input = guardedInput()
        const environment = guardedEnvironment("db", "SELECTED", {})
        const harness = makeHarness({ stdin: input.input, env: environment.env })
        expect(await runCredentialsCli(args, harness.deps) === 0).toBe(true)
        expect(harness.output.stdout.startsWith("Usage:\n")).toBe(true)
        expect(harness.output.stdout.includes(CONTEXT)).toBe(true)
        expect(harness.output.stdout.includes(PLAINTEXT)).toBe(true)
        expect(harness.output.stdout.includes("65,536 bytes")).toBe(true)
        expect(harness.output.stderr === "").toBe(true)
        expect(harness.output.prompt === "").toBe(true)
        expect(harness.identityCalls.length === 0).toBe(true)
        expect(input.readCount === 0).toBe(true)
        expect(environment.reads.length === 0).toBe(true)
        expect(environment.enumerations === 0).toBe(true)
        expectNoWrites(harness)
    })
})

describe("runCredentialsCli argument validation", (): void => {
    const value = sentinel()
    const base = commandArgs()
    const invalid: [string, readonly string[], string][] = [
        ["no command", [], USAGE],
        ["unknown command", [value], USAGE],
        ["identity options", ["identity", "--expected-sid", value], USAGE],
        ["help with extra token", ["--help", value], USAGE],
        ["missing all options", ["set"], USAGE],
        ["missing provider", ["set", "--kind", "db", "--key", value], USAGE],
        ["missing kind", ["set", "--provider", "plaintext", "--key", value], USAGE],
        ["missing key", ["set", "--provider", "plaintext", "--kind", "db"], USAGE],
        ["provider missing value", ["set", "--provider"], USAGE],
        ["kind missing value", ["set", "--provider", "plaintext", "--kind"], USAGE],
        ["key missing value", ["set", "--provider", "plaintext", "--kind", "db", "--key"], USAGE],
        ["SID missing value", [...base, "--expected-sid"], USAGE],
        ["flag used as value", ["set", "--provider", "--kind", "db", "--key", value], USAGE],
        ["duplicate provider", [...base, "--provider", "plaintext"], USAGE],
        ["duplicate kind", [...base, "--kind", "ssh"], USAGE],
        ["duplicate key", [...base, "--key", value], USAGE],
        ["duplicate SID", [...base, "--expected-sid", SID, "--expected-sid", value], USAGE],
        ["duplicate stdin", [...base, "--stdin", "--stdin"], USAGE],
        ["unknown flag", [...base, `--${value}`], USAGE],
        ["password flag", [...base, "--password", value], USAGE],
        ["authorization flag", [...base, "--authorization", value], USAGE],
        ["inline token flag", [...base, `--token=${value}`], USAGE],
        ["positional secret", [...base, value], USAGE],
        ["automatic provider", ["set", "--provider", "auto", "--kind", "db", "--key", value], USAGE],
        ["Linux native provider", ["set", "--provider", "linux-secret-service", "--kind", "db", "--key", value], USAGE],
        ["unknown kind", ["set", "--provider", "plaintext", "--kind", value, "--key", "selected"], USAGE],
        ["empty ID", commandArgs("set", "db", "plaintext", ""), ERROR_MESSAGES.invalid],
        ["blank ID", commandArgs("set", "db", "plaintext", " \t"), ERROR_MESSAGES.invalid],
        ["DB hyphen ID", commandArgs("set", "db", "plaintext", value), ERROR_MESSAGES.invalid],
        ["REST hyphen ID", commandArgs("set", "rest", "plaintext", value), ERROR_MESSAGES.invalid],
        ["SSH path ID", commandArgs("set", "ssh", "plaintext", value + "/profile"), ERROR_MESSAGES.invalid],
        ["import-env stdin", [...commandArgs("import-env"), "--stdin"], USAGE],
        ["stdin with value", [...base, "--stdin", value], USAGE],
        ["stdin before command", ["--stdin", ...base], USAGE],
    ]
    test.each(invalid)("rejects %s without echoing arguments", async (_name, args, message): Promise<void> => {
        const input = guardedInput()
        const harness = makeHarness({ stdin: input.input })
        expectFailure(harness, await runCredentialsCli(args, harness.deps), message)
        expectNoLeaks(harness, [value, "--password", "--authorization", "--token"])
        expect(harness.identityCalls.length === 0).toBe(true)
        expect(input.readCount === 0).toBe(true)
        expectNoWrites(harness)
    })
})

describe("runCredentialsCli SID preflight and providers", (): void => {
    for (const provider of PROVIDERS) {
        for (const command of ["set", "import-env"] as const) {
            test.each([
                ["missing", undefined],
                ["empty", ""],
                ["blank", " \t\r\n"],
            ] as [string, string | undefined][])(`${provider} ${command} rejects %s SID before input`, async (_name, sid): Promise<void> => {
                const input = guardedInput()
                const environment = guardedEnvironment("db", "SELECTED", {})
                const harness = makeHarness({ stdin: input.input, env: environment.env })
                const args = commandArgs(command, "db", provider)
                if (sid !== undefined) args.push("--expected-sid", sid)
                if (command === "set") args.push("--stdin")
                expectFailure(harness, await runCredentialsCli(args, harness.deps), SID_GUIDANCE, [CONTEXT])
                expect(input.readCount === 0).toBe(true)
                expect(environment.reads.length === 0).toBe(true)
                expect(harness.identityCalls.length === 0).toBe(true)
                expectNoWrites(harness)
            })

            test(`${provider} ${command} forwards exact SID to preflight and writer`, async (): Promise<void> => {
                const profile = { connection: sentinel() }
                const harness = makeHarness({ stdin: stdinJson(profile), env: environmentFor("db", "SELECTED", profile) })
                expectSaved(harness, await runCredentialsCli(windowsArgs("db", "selected", command, provider), harness.deps), "db", "SELECTED", profile, provider)
                expect(harness.identityCalls.length === 1).toBe(true)
                expect(JSON.stringify(harness.identityCalls[0]?.[0]) === JSON.stringify({ expectedSid: SID })).toBe(true)
                const calls = provider === "plaintext" ? harness.plaintextCalls : harness.windowsCalls
                expect(JSON.stringify(calls[0]?.[3]) === JSON.stringify({ expectedSid: SID })).toBe(true)
                expect(harness.output.stderr === warnings(provider).join("\n") + "\n").toBe(true)
            })

            test.each([
                ["different", SID, SID + "-99"],
                ["identity leading whitespace", SID, " " + SID],
                ["identity different case", SID, SID.toLowerCase()],
                ["requested leading whitespace", " " + SID, SID],
                ["requested trailing whitespace", SID + " ", SID],
                ["requested different case", SID.toLowerCase(), SID],
            ] as [string, string, string][])(`${provider} ${command} denies %s SID before input`, async (_name, expectedSid, currentSid): Promise<void> => {
                const input = guardedInput()
                const environment = guardedEnvironment("db", "SELECTED", {})
                const harness = makeHarness({
                    stdin: input.input,
                    env: environment.env,
                    getWindowsCredentialIdentity: async (): Promise<Awaited<ReturnType<Identity>>> => ({ sid: currentSid, account: ACCOUNT }),
                })
                const args = [...commandArgs(command, "db", provider), "--expected-sid", expectedSid]
                if (command === "set") args.push("--stdin")
                expectFailure(harness, await runCredentialsCli(args, harness.deps), ERROR_MESSAGES.denied, [CONTEXT])
                expect(input.readCount === 0).toBe(true)
                expect(environment.reads.length === 0).toBe(true)
                expect(JSON.stringify(harness.identityCalls[0]?.[0]) === JSON.stringify({ expectedSid })).toBe(true)
                expectNoWrites(harness)
            })
        }
    }

    test.each(["denied", "unavailable"] as const)("identity %s prevents input and fallback", async (code): Promise<void> => {
        const input = guardedInput()
        const value = sentinel()
        const harness = makeHarness({
            stdin: input.input,
            getWindowsCredentialIdentity: async (): Promise<never> => {
                const error = new CredentialError(code)
                error.message = value
                throw error
            },
        })
        expectFailure(harness, await runCredentialsCli(windowsArgs(), harness.deps), ERROR_MESSAGES[code], [CONTEXT])
        expect(input.readCount === 0).toBe(true)
        expectNoLeaks(harness, [value])
        expectNoWrites(harness)
    })

    for (const command of ["set", "import-env"] as const) {
        test(`Linux native ${command} is unsupported before identity or input`, async (): Promise<void> => {
            const input = guardedInput()
            const environment = guardedEnvironment("db", "SELECTED", {})
            const harness = makeHarness({ platform: "linux", stdin: input.input, env: environment.env })
            expectFailure(harness, await runCredentialsCli(windowsArgs("db", "selected", command), harness.deps), ERROR_MESSAGES.unsupported, [CONTEXT])
            expect(harness.identityCalls.length === 0).toBe(true)
            expect(input.readCount === 0).toBe(true)
            expect(environment.reads.length === 0).toBe(true)
            expectNoWrites(harness)
        })

        test(`Linux plaintext ${command} rejects SID assertions`, async (): Promise<void> => {
            const input = guardedInput()
            const harness = makeHarness({ platform: "linux", stdin: input.input })
            expectFailure(harness, await runCredentialsCli(windowsArgs("db", "selected", command, "plaintext"), harness.deps), ERROR_MESSAGES.unsupported)
            expect(harness.identityCalls.length === 0).toBe(true)
            expect(input.readCount === 0).toBe(true)
            expectNoWrites(harness)
        })

        test(`Linux plaintext ${command} works without SID and warns about fixed unencrypted storage`, async (): Promise<void> => {
            const profile = { connection: sentinel() }
            const harness = makeHarness({ platform: "linux", stdin: stdinJson(profile), env: environmentFor("db", "SELECTED", profile) })
            const args = commandArgs(command, "db", "plaintext")
            if (command === "set") args.push("--stdin")
            expectSaved(harness, await runCredentialsCli(args, harness.deps), "db", "SELECTED", profile, "plaintext")
            expect(harness.identityCalls.length === 0).toBe(true)
            expect(JSON.stringify(harness.plaintextCalls[0]?.[3]) === JSON.stringify({})).toBe(true)
            expect(harness.output.stderr === PLAINTEXT + "\n").toBe(true)
        })
    }

    test.each([...PROVIDERS])("%s non-TTY set without --stdin never reads or writes", async (provider): Promise<void> => {
        const input = guardedInput()
        const harness = makeHarness({ stdin: input.input })
        const args = windowsArgs("db", "selected", "set", provider).filter((arg: string): boolean => arg !== "--stdin")
        expectFailure(harness, await runCredentialsCli(args, harness.deps), TTY_GUIDANCE, warnings(provider))
        expect(input.readCount === 0).toBe(true)
        expect(harness.identityCalls.length === 1).toBe(true)
        expectNoWrites(harness)
    })
})

describe("runCredentialsCli sanitized diagnostics", (): void => {
    for (const provider of PROVIDERS) {
        test.each(Object.keys(ERROR_MESSAGES) as CredentialErrorCode[])(`${provider} writer %s uses only fixed diagnostics`, async (code): Promise<void> => {
            const value = sentinel()
            const error = new CredentialError(code)
            error.message = value
            error.stack = value
            Object.assign(error, { cause: { detail: value }, nativeCode: value })
            const fail = async (): Promise<never> => { throw error }
            const harness = makeHarness({ stdin: stdinJson({ connection: value }), writeWindowsProfile: fail, writePlaintextProfile: fail })
            expectFailure(harness, await runCredentialsCli(windowsArgs("db", "selected", "set", provider), harness.deps), ERROR_MESSAGES[code], warnings(provider))
            expect((provider === "plaintext" ? harness.plaintextCalls : harness.windowsCalls).length === 1).toBe(true)
            expect((provider === "plaintext" ? harness.windowsCalls : harness.plaintextCalls).length === 0).toBe(true)
            expectNoLeaks(harness, [value])
        })
    }

    const unexpected: [string, (value: string) => unknown][] = [
        ["Error", (value: string): unknown => new Error(value)],
        ["SyntaxError", (value: string): unknown => new SyntaxError(value)],
        ["arbitrary object", (value: string): unknown => ({ code: "denied", message: value, profile: value })],
        ["primitive", (value: string): unknown => value],
        ["null", (): unknown => null],
        ["throwing error getter", (value: string): unknown => Object.defineProperty(new CredentialError("denied"), "code", { get(): never { throw new Error(value) } })],
        ["hostile Proxy", (value: string): unknown => new Proxy({}, { get(): never { throw new Error(value) }, getPrototypeOf(): never { throw new Error(value) } })],
    ]
    test.each(unexpected)("unexpected %s never exposes payload", async (_name, create): Promise<void> => {
        const value = sentinel()
        const harness = makeHarness({
            stdin: stdinJson({ connection: value }),
            writeWindowsProfile: async (): Promise<never> => { throw create(value) },
        })
        expectFailure(harness, await runCredentialsCli(windowsArgs(), harness.deps), ERROR_MESSAGES.failed, [CONTEXT])
        expect(harness.windowsCalls.length === 1).toBe(true)
        expect(harness.plaintextCalls.length === 0).toBe(true)
        expectNoLeaks(harness, [value])
    })

    test("throwing error sink does not reject the runner", async (): Promise<void> => {
        const value = sentinel()
        let writes = 0
        const harness = makeHarness({
            stderr: { write(): void { writes++; if (writes > 1) throw new Error(value) } },
            writeWindowsProfile: async (): Promise<never> => { throw new Error(value) },
        })
        expect(await runCredentialsCli(windowsArgs(), harness.deps) === 1).toBe(true)
        expect(writes === 2).toBe(true)
        expect(harness.windowsCalls.length === 1).toBe(true)
        expect(harness.plaintextCalls.length === 0).toBe(true)
        expectNoLeaks(harness, [value])
    })
})

describe("runCredentialsCli stdin JSON profiles", (): void => {
    const valid: [string, CredentialKind, (value: string) => Record<string, string>][] = [
        ["minimal SSH", "ssh", (value: string): Record<string, string> => ({ host: value })],
        ["complete SSH", "ssh", (value: string): Record<string, string> => ({ host: value, username: value + "u", port: "22", keyfile: value + "k", agent: "true", password: value + "p", keypass: value + "q" })],
        ["SSH optional empties", "ssh", (value: string): Record<string, string> => ({ host: value, username: "", port: "", keyfile: "", agent: "", password: "", keypass: "" })],
        ["minimal DB", "db", (value: string): Record<string, string> => ({ connection: value })],
        ["complete DB", "db", (value: string): Record<string, string> => ({ connection: value, username: value + "u", password: value + "p" })],
        ["DB optional empties", "db", (value: string): Record<string, string> => ({ connection: value, username: "", password: "" })],
        ["REST authorization", "rest", (value: string): Record<string, string> => ({ authorization: value })],
        ["REST empty authorization", "rest", (): Record<string, string> => ({ authorization: "" })],
        ["REST basic", "rest", (value: string): Record<string, string> => ({ username: value + "u", password: value + "p" })],
        ["REST empty basic", "rest", (): Record<string, string> => ({ username: "", password: "" })],
        ["complete REST", "rest", (value: string): Record<string, string> => ({ authorization: value, username: value + "u", password: value + "p" })],
        ["REST authorization with optional empty username", "rest", (): Record<string, string> => ({ authorization: "", username: "" })],
    ]
    test.each(valid)("accepts %s without exposing fields", async (_name, kind, create): Promise<void> => {
        const profile = create(sentinel())
        const key = kind === "ssh" ? " deploy-node " : " selected_2 "
        const id = kind === "ssh" ? "DEPLOY_NODE" : "SELECTED_2"
        const args = windowsArgs(kind, key)
        const harness = makeHarness({ stdin: stdinJson(profile) })
        expect(Object.values(profile).filter((value: string): boolean => value.length > 0).every((value: string): boolean => args.every((arg: string): boolean => !arg.includes(value)))).toBe(true)
        expectSaved(harness, await runCredentialsCli(args, harness.deps), kind, id, profile)
        expect(harness.output.stderr === CONTEXT + "\n").toBe(true)
    })

    const invalidJson: [string, (value: string) => string][] = [
        ["malformed JSON", (value: string): string => `{"connection":${JSON.stringify(value)},}`],
        ["multiple JSON documents", (value: string): string => JSON.stringify({ connection: value }) + "{}"],
        ["empty input", (): string => ""],
        ["null", (): string => "null"],
        ["array", (value: string): string => JSON.stringify([{ connection: value }])],
        ["string", (value: string): string => JSON.stringify(value)],
        ["number", (): string => "42"],
        ["boolean", (): string => "true"],
        ["unknown field", (value: string): string => JSON.stringify({ connection: value, token: value })],
        ["prototype field", (value: string): string => `{"connection":${JSON.stringify(value)},"__proto__":{"password":${JSON.stringify(value)}}}`],
        ["storage envelope", (value: string): string => JSON.stringify({ version: 1, kind: "db", fields: { connection: value } })],
    ]
    test.each(invalidJson)("rejects %s with fixed diagnostics", async (_name, create): Promise<void> => {
        const value = sentinel()
        const harness = makeHarness({ stdin: Readable.from([Buffer.from(create(value), "utf8")]) })
        expectFailure(harness, await runCredentialsCli(windowsArgs(), harness.deps), ERROR_MESSAGES.invalid, [CONTEXT])
        expectNoLeaks(harness, [value])
        expectNoWrites(harness)
    })

    for (const kind of KINDS) {
        for (const field of FIELDS[kind]) {
            test.each([["numeric", 1], ["null", null]] as [string, unknown][])(`${kind} rejects %s ${field}`, async (_name, invalid): Promise<void> => {
                const value = sentinel()
                const profile = { ...minimalProfile(kind, value), [field]: invalid }
                const harness = makeHarness({ stdin: stdinJson(profile) })
                expectFailure(harness, await runCredentialsCli(windowsArgs(kind), harness.deps), ERROR_MESSAGES.invalid, [CONTEXT])
                expectNoLeaks(harness, [value])
                expectNoWrites(harness)
            })
        }
    }

    test.each([
        ["SSH missing host", "ssh", {}],
        ["SSH blank host", "ssh", { host: " \t\n" }],
        ["DB missing connection", "db", {}],
        ["DB blank connection", "db", { connection: " \t\n" }],
        ["REST empty object", "rest", {}],
        ["REST username alone", "rest", { username: "" }],
        ["REST password alone", "rest", { password: "" }],
    ] as [string, CredentialKind, Record<string, string>][])("rejects incomplete %s", async (_name, kind, profile): Promise<void> => {
        const harness = makeHarness({ stdin: stdinJson(profile) })
        expectFailure(harness, await runCredentialsCli(windowsArgs(kind), harness.deps), ERROR_MESSAGES.incomplete, [CONTEXT])
        expectNoWrites(harness)
    })

    test("malformed UTF-8 bytes are not replaced or printed", async (): Promise<void> => {
        const value = sentinel()
        const bytes = Buffer.concat([Buffer.from(`{"connection":"${value}`), Buffer.from([0xc3, 0x28]), Buffer.from('"}')])
        const harness = makeHarness({ stdin: Readable.from([bytes]) })
        expectFailure(harness, await runCredentialsCli(windowsArgs(), harness.deps), ERROR_MESSAGES.invalid, [CONTEXT])
        expectNoLeaks(harness, [value])
        expectNoWrites(harness)
    })

    test("UTF-8 may cross byte chunk boundaries", async (): Promise<void> => {
        const profile = { connection: sentinel() + "é🔒" }
        const bytes = Buffer.from(JSON.stringify(profile), "utf8")
        const split = bytes.indexOf(Buffer.from("é")) + 1
        const harness = makeHarness({ stdin: Readable.from([bytes.subarray(0, split), bytes.subarray(split)]) })
        expectSaved(harness, await runCredentialsCli(windowsArgs(), harness.deps), "db", "SELECTED", profile)
    }, STREAM_TIMEOUT_MS)

    test("native 2560-byte storage limit is left to the writer", async (): Promise<void> => {
        const profile = { connection: sentinel() + "x".repeat(3000) }
        const harness = makeHarness({ stdin: stdinJson(profile) })
        expectSaved(harness, await runCredentialsCli(windowsArgs(), harness.deps), "db", "SELECTED", profile)
    })

    test("accepts exactly 65536 raw input bytes padded with JSON whitespace", async (): Promise<void> => {
        const profile = { connection: sentinel() }
        const serialized = JSON.stringify(profile)
        const payload = serialized + " ".repeat(LIMIT - Buffer.byteLength(serialized, "utf8"))
        expect(Buffer.byteLength(payload, "utf8") === LIMIT).toBe(true)
        expect(Buffer.byteLength(serializeCredentialEnvelope("db", profile), "utf8") < LIMIT).toBe(true)
        const harness = makeHarness({ stdin: Readable.from([Buffer.from(payload, "utf8")]) })
        expectSaved(harness, await runCredentialsCli(windowsArgs(), harness.deps), "db", "SELECTED", profile)
    })

    test.each(["single chunk", "multiple chunks"])("rejects 65537 whitespace-padded raw bytes across %s", async (mode): Promise<void> => {
        const value = sentinel()
        const profile = { connection: value }
        const serialized = JSON.stringify(profile)
        const bytes = Buffer.from(serialized + " ".repeat(LIMIT + 1 - Buffer.byteLength(serialized, "utf8")), "utf8")
        expect(bytes.byteLength === LIMIT + 1).toBe(true)
        expect(Buffer.byteLength(serializeCredentialEnvelope("db", profile), "utf8") < LIMIT).toBe(true)
        const chunks = mode === "single chunk" ? [bytes] : [bytes.subarray(0, LIMIT / 2), bytes.subarray(LIMIT / 2)]
        const harness = makeHarness({ stdin: Readable.from(chunks) })
        expectFailure(harness, await runCredentialsCli(windowsArgs(), harness.deps), ERROR_MESSAGES.too_large, [CONTEXT])
        expectNoLeaks(harness, [value])
        expectNoWrites(harness)
    }, STREAM_TIMEOUT_MS)

    test.each([LIMIT, LIMIT + 1])("enforces %i-byte encoded storage envelopes below the raw input limit", async (envelopeBytes): Promise<void> => {
        const value = sentinel()
        const initialBytes = Buffer.byteLength(serializeCredentialEnvelope("db", { connection: value }), "utf8")
        const profile = { connection: value + "x".repeat(envelopeBytes - initialBytes) }
        const payload = JSON.stringify(profile)
        const envelope = JSON.stringify({ version: 1, kind: "db", fields: profile })
        expect(Buffer.byteLength(payload, "utf8") < LIMIT).toBe(true)
        expect(Buffer.byteLength(envelope, "utf8") === envelopeBytes).toBe(true)
        const harness = makeHarness({ stdin: Readable.from([Buffer.from(payload, "utf8")]) })
        const result = await runCredentialsCli(windowsArgs(), harness.deps)
        if (envelopeBytes === LIMIT) {
            expect(Buffer.byteLength(serializeCredentialEnvelope("db", profile), "utf8") === LIMIT).toBe(true)
            expectSaved(harness, result, "db", "SELECTED", profile)
        } else {
            expectFailure(harness, result, ERROR_MESSAGES.too_large, [CONTEXT])
            expectNoWrites(harness)
        }
        expectNoLeaks(harness, [value])
    })

    test("stdin limit counts UTF-8 bytes rather than characters", async (): Promise<void> => {
        const value = sentinel()
        const payload = JSON.stringify({ connection: value + "é".repeat(LIMIT / 2) })
        expect(payload.length < LIMIT).toBe(true)
        expect(Buffer.byteLength(payload, "utf8") > LIMIT).toBe(true)
        const harness = makeHarness({ stdin: Readable.from([Buffer.from(payload, "utf8")]) })
        expectFailure(harness, await runCredentialsCli(windowsArgs(), harness.deps), ERROR_MESSAGES.too_large, [CONTEXT])
        expectNoLeaks(harness, [value])
        expectNoWrites(harness)
    })
})

describe("runCredentialsCli non-TTY stream failures", (): void => {
    test.each([
        ["object chunk", (): Readable => Readable.from([{ connection: sentinel() }])],
        ["numeric chunk", (): Readable => Readable.from([42])],
        ["non-byte typed array", (): Readable => Readable.from([new Uint16Array([42])])],
        ["ill-formed string chunk", (): Readable => Readable.from(['{"connection":"\ud800"}'])],
        ["predecoded stream", (): Readable => stdinJson({ connection: sentinel() }).setEncoding("utf8")],
    ] as [string, () => Readable][])("rejects %s without a write", async (_name, create): Promise<void> => {
        const harness = makeHarness({ stdin: create() })
        expectFailure(harness, await runCredentialsCli(windowsArgs(), harness.deps), ERROR_MESSAGES.invalid, [CONTEXT])
        expectNoWrites(harness)
    }, STREAM_TIMEOUT_MS)

    test("stream errors are bounded and sanitized", async (): Promise<void> => {
        const value = sentinel()
        const input = new Readable({ read(): void { this.destroy(new Error(value)) } })
        const harness = makeHarness({ stdin: input })
        expectFailure(harness, await runCredentialsCli(windowsArgs(), harness.deps), ERROR_MESSAGES.failed, [CONTEXT])
        expectNoLeaks(harness, [value])
        expectNoWrites(harness)
    }, STREAM_TIMEOUT_MS)

    test("premature stream close aborts instead of hanging or saving", async (): Promise<void> => {
        const input = new Readable({ read(): void { this.destroy() } })
        const harness = makeHarness({ stdin: input })
        expectFailure(harness, await runCredentialsCli(windowsArgs(), harness.deps), "Credential setup aborted.", [CONTEXT])
        expectNoWrites(harness)
    }, STREAM_TIMEOUT_MS)

    test("already destroyed input aborts without waiting for data", async (): Promise<void> => {
        const input = new Readable({ read(): void {} })
        input.destroy()
        const harness = makeHarness({ stdin: input })
        expectFailure(harness, await runCredentialsCli(windowsArgs(), harness.deps), "Credential setup aborted.", [CONTEXT])
        expectNoWrites(harness)
    }, STREAM_TIMEOUT_MS)
})

describe("runCredentialsCli selected environment import", (): void => {
    test.each([...KINDS])("%s reads only exact normalized selected environment names without enumeration", async (kind): Promise<void> => {
        const value = sentinel()
        const profile: Record<string, string> = Object.create(null)
        for (const field of FIELDS[kind]) profile[field] = value + field
        const key = kind === "ssh" ? " deploy-node " : " selected_2 "
        const id = kind === "ssh" ? "DEPLOY_NODE" : "SELECTED_2"
        const values = {
            ...environmentFor(kind, id, profile),
            AUTOCODE_SSH_OTHER_HOST: sentinel(),
            AUTOCODE_DB_OTHER_CONNECTION: sentinel(),
            AUTOCODE_REST_OTHER_AUTHORIZATION: sentinel(),
            AUTOCODE_DB_SELECTED_CONNECTION: sentinel(),
            AUTOCODE_SSH_DEPLOY_NODE_TOKEN: sentinel(),
        }
        const environment = guardedEnvironment(kind, id, values)
        const input = guardedInput()
        const harness = makeHarness({ stdin: input.input, env: environment.env })
        const args = windowsArgs(kind, key, "import-env")
        expect(Object.values(profile).every((fieldValue: string): boolean => args.every((arg: string): boolean => !arg.includes(fieldValue)))).toBe(true)
        expectSaved(harness, await runCredentialsCli(args, harness.deps), kind, id, profile)
        const expectedReads = FIELDS[kind].map((field: string): string => `AUTOCODE_${kind.toUpperCase()}_${id}_${field.toUpperCase()}`)
        expect(JSON.stringify(environment.reads) === JSON.stringify(expectedReads)).toBe(true)
        expect(environment.enumerations === 0).toBe(true)
        expect(environment.unexpectedReads === 0).toBe(true)
        expect(input.readCount === 0).toBe(true)
        expectNoLeaks(harness, Object.values(values))
    })

    test.each([...KINDS])("%s missing selected variables never falls back to another profile or kind", async (kind): Promise<void> => {
        const values = {
            AUTOCODE_SSH_OTHER_HOST: sentinel(),
            AUTOCODE_DB_OTHER_CONNECTION: sentinel(),
            AUTOCODE_REST_OTHER_AUTHORIZATION: sentinel(),
            AUTOCODE_SSH_SELECTED_HOST: sentinel(),
            AUTOCODE_DB_SELECTED_CONNECTION: sentinel(),
            AUTOCODE_REST_SELECTED_AUTHORIZATION: sentinel(),
        }
        const environment = guardedEnvironment(kind, "MISSING", values)
        const input = guardedInput()
        const harness = makeHarness({ stdin: input.input, env: environment.env })
        expectFailure(harness, await runCredentialsCli(windowsArgs(kind, "missing", "import-env"), harness.deps), ERROR_MESSAGES.incomplete, [CONTEXT])
        expect(environment.enumerations === 0).toBe(true)
        expect(environment.unexpectedReads === 0).toBe(true)
        // The ownership check skips value reads for absent selected variables.
        expect(environment.reads.length === 0).toBe(true)
        expect(input.readCount === 0).toBe(true)
        expectNoLeaks(harness, Object.values(values))
        expectNoWrites(harness)
    })

    test.each([...KINDS])("%s inherited required environment values do not provision a profile", async (kind): Promise<void> => {
        const value = sentinel()
        const env: Record<string, string> = Object.create(environmentFor(kind, "SELECTED", minimalProfile(kind, value)))
        expect(Object.keys(env).length === 0).toBe(true)
        const harness = makeHarness({ env })
        expectFailure(harness, await runCredentialsCli(windowsArgs(kind, "selected", "import-env"), harness.deps), ERROR_MESSAGES.incomplete, [CONTEXT])
        expectNoLeaks(harness, [value])
        expectNoWrites(harness)
    })

    test.each([...KINDS])("%s inherited optional environment values are not copied", async (kind): Promise<void> => {
        const profile = minimalProfile(kind, sentinel())
        const inherited = { username: sentinel(), password: sentinel() }
        const inheritedFields = environmentFor(kind, "SELECTED", inherited)
        const ownFields = environmentFor(kind, "SELECTED", profile)
        const env: Record<string, string> = Object.assign(Object.create(inheritedFields), ownFields)
        expect(Object.getPrototypeOf(env) === inheritedFields).toBe(true)
        expect(JSON.stringify(Object.keys(env)) === JSON.stringify(Object.keys(ownFields))).toBe(true)
        for (const key of Object.keys(inheritedFields)) expect(Object.hasOwn(env, key)).toBe(false)
        const harness = makeHarness({ env })
        expectSaved(harness, await runCredentialsCli(windowsArgs(kind, "selected", "import-env"), harness.deps), kind, "SELECTED", profile)
        expectNoLeaks(harness, Object.values(inherited))
    })

    test.each(["username", "password"] as const)("REST inherited %s does not complete own basic credentials", async (field): Promise<void> => {
        const value = sentinel()
        const inherited = environmentFor("rest", "SELECTED", { [field]: value })
        const own: Record<string, string> = field === "username" ? { password: "" } : { username: "" }
        const ownFields = environmentFor("rest", "SELECTED", own)
        const env: Record<string, string> = Object.assign(Object.create(inherited), ownFields)
        expect(Object.getPrototypeOf(env) === inherited).toBe(true)
        expect(JSON.stringify(Object.keys(env)) === JSON.stringify(Object.keys(ownFields))).toBe(true)
        for (const key of Object.keys(inherited)) expect(Object.hasOwn(env, key)).toBe(false)
        const harness = makeHarness({ env })
        expectFailure(harness, await runCredentialsCli(windowsArgs("rest", "selected", "import-env"), harness.deps), ERROR_MESSAGES.incomplete, [CONTEXT])
        expectNoLeaks(harness, [value])
        expectNoWrites(harness)
    })

    test.each([
        ["SSH", "ssh", (): Record<string, string> => ({ host: sentinel(), username: "", port: "", keyfile: "", agent: "", password: "", keypass: "" })],
        ["DB", "db", (): Record<string, string> => ({ connection: sentinel(), username: "", password: "" })],
        ["REST authorization", "rest", (): Record<string, string> => ({ authorization: "" })],
        ["REST basic", "rest", (): Record<string, string> => ({ username: "", password: "" })],
    ] as [string, CredentialKind, () => Record<string, string>][])("%s environment import preserves explicit empty strings", async (_name, kind, create): Promise<void> => {
        const profile = create()
        const harness = makeHarness({ env: environmentFor(kind, "SELECTED", profile) })
        expectSaved(harness, await runCredentialsCli(windowsArgs(kind, "selected", "import-env"), harness.deps), kind, "SELECTED", profile)
    })

    test.each(["field", "aggregate", "UTF-8 bytes"])("environment %s size overflow rejects before writer", async (mode): Promise<void> => {
        const value = sentinel()
        const profile: Record<string, string> = mode === "aggregate"
            ? { connection: value + "x".repeat(LIMIT / 2), password: "x".repeat(LIMIT / 2) }
            : { connection: value + (mode === "field" ? "x".repeat(LIMIT + 1) : "é".repeat(LIMIT / 2)) }
        const harness = makeHarness({ env: environmentFor("db", "SELECTED", profile) })
        expectFailure(harness, await runCredentialsCli(windowsArgs("db", "selected", "import-env"), harness.deps), ERROR_MESSAGES.too_large, [CONTEXT])
        expectNoLeaks(harness, [value])
        expectNoWrites(harness)
    })
})
