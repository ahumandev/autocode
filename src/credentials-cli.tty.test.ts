import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { Readable } from "node:stream"
import { runCredentialsCli, type CredentialsCliDependencies } from "./credentials-cli"
import {
    MAX_CREDENTIAL_ENVELOPE_BYTES,
    MAX_CREDENTIAL_FIELD_BYTES,
    type CredentialKind,
    type CredentialProfileMap,
} from "./credentials/types"

const STREAM_EVENTS = ["data", "end", "close", "error"] as const
const SIGNAL_EVENTS = ["SIGINT", "SIGTERM", "SIGHUP"] as const
const RUN_TIMEOUT_MS = 1500
const RAW_MODE_FAILURE = "Synthetic raw-mode failure."
const SYNTHETIC_SID = "S-1-5-21-100-200-300-1001"
const PLAINTEXT_WARNING = "Warning: Plaintext credentials are stored unencrypted at the fixed global credential path.\n"
const CONTEXT_WARNING = "Warning: Run under the actual OpenCode service logon context; matching SID alone does not prove the same logon session.\n"
const FAILURE_MESSAGES = {
    tty: "Hidden input requires stdin and prompt output TTYs with working raw-mode support. Use --stdin instead.",
    aborted: "Credential setup aborted.",
    invalid: "Invalid credential profile or ID.",
    incomplete: "Credential profile is incomplete.",
    tooLarge: "Credential input exceeds the supported size limit.",
    failed: "Credential setup failed.",
} as const
const STATIC_STDERR = new Set([
    PLAINTEXT_WARNING,
    CONTEXT_WARNING,
    ...Object.values(FAILURE_MESSAGES).map((message: string): string => `${message}\n`),
])
const FIELD_NAMES: Readonly<Record<CredentialKind, readonly string[]>> = {
    ssh: ["host", "username", "port", "keyfile", "agent", "password", "keypass"],
    db: ["connection", "username", "password"],
    rest: ["authorization", "username", "password"],
}
const PROMPTS: Readonly<Record<CredentialKind, readonly string[]>> = {
    ssh: [
        "Host (hidden): ",
        "Username (hidden): ",
        "Port (hidden): ",
        "Keyfile (hidden): ",
        "Agent (hidden): ",
        "Password (hidden): ",
        "Key passphrase (hidden): ",
    ],
    db: ["Connection (hidden): ", "Username (hidden): ", "Password (hidden): "],
    rest: ["Authorization (hidden): ", "Username (hidden): ", "Password (hidden): "],
}

type InputStep = Buffer | "end" | "close" | Error
type RawBehavior = "working" | "throws" | "throws-after-enable" | "no-effect"
type StreamListeners = Record<(typeof STREAM_EVENTS)[number], ReturnType<Readable["rawListeners"]>>
type SignalListeners = Record<(typeof SIGNAL_EVENTS)[number], ReturnType<typeof process.rawListeners>>
type PlaintextWrite = Parameters<NonNullable<CredentialsCliDependencies["writePlaintextProfile"]>>
type WindowsWrite = Parameters<NonNullable<CredentialsCliDependencies["writeWindowsProfile"]>>
type GetIdentity = NonNullable<CredentialsCliDependencies["getWindowsCredentialIdentity"]>
type IdentityOptions = Parameters<GetIdentity>[0]
type FixtureOptions = {
    initialRaw?: boolean
    rawBehavior?: RawBehavior
    stdinTty?: boolean
    promptTty?: boolean
    missingRawSetter?: boolean
    promptFailureAt?: number
    platform?: "linux" | "win32"
}
type CliFixture = {
    input: ScriptedTty
    stdout: string[]
    stderr: string[]
    prompts: string[]
    writes: PlaintextWrite[]
    windowsWrites: WindowsWrite[]
    identityCalls: IdentityOptions[]
    platform: "linux" | "win32"
    dependencies: CredentialsCliDependencies
}

function privateValue(field: string): string {
    return `tty-private-fixture-${field}`
}

function ignoreStreamEvent(_value?: unknown): void {}

function streamListeners(input: Readable): StreamListeners {
    return {
        data: input.rawListeners("data"),
        end: input.rawListeners("end"),
        close: input.rawListeners("close"),
        error: input.rawListeners("error"),
    }
}

function signalListeners(): SignalListeners {
    return {
        SIGINT: process.rawListeners("SIGINT"),
        SIGTERM: process.rawListeners("SIGTERM"),
        SIGHUP: process.rawListeners("SIGHUP"),
    }
}

class ScriptedTty extends Readable {
    isTTY: boolean
    isRaw: boolean
    readonly initialRaw: boolean
    readonly rawModes: boolean[] = []
    pauseCalls = 0
    activeListeners?: { stream: StreamListeners; signals: SignalListeners; pauseCalls: number }
    private started = false
    private stopped = false
    private readonly rawBehavior: RawBehavior

    constructor(private readonly steps: readonly InputStep[], options: FixtureOptions) {
        super({ autoDestroy: false })
        this.isTTY = options.stdinTty ?? true
        this.initialRaw = options.initialRaw ?? false
        this.isRaw = this.initialRaw
        this.rawBehavior = options.rawBehavior ?? "working"
        for (const event of STREAM_EVENTS) this.on(event, ignoreStreamEvent)
        this.pause()
    }

    override _read(): void {}

    override pause(): this {
        this.pauseCalls++
        return super.pause()
    }

    override resume(): this {
        super.resume()
        // The existing data listener must not start input before the production reader attaches.
        if (!this.started && this.listenerCount("data") > 1) {
            this.started = true
            setImmediate((): void => {
                if (this.stopped) return
                this.activeListeners = {
                    stream: streamListeners(this),
                    signals: signalListeners(),
                    pauseCalls: this.pauseCalls,
                }
                this.deliver(0)
            })
        }
        return this
    }

    setRawMode(mode: boolean): this {
        this.rawModes.push(mode)
        if (mode && this.rawBehavior === "throws") throw new Error(RAW_MODE_FAILURE)
        if (this.rawBehavior !== "no-effect") this.isRaw = mode
        if (mode && this.rawBehavior === "throws-after-enable") throw new Error(RAW_MODE_FAILURE)
        return this
    }

    stop(): void {
        this.stopped = true
        this.destroy()
    }

    private deliver(index: number): void {
        if (this.stopped) return
        const step = this.steps[index]
        if (step === undefined) return
        if (step === "end") {
            this.push(null)
            return
        }
        if (step === "close") {
            this.destroy()
            return
        }
        if (step instanceof Error) {
            this.destroy(step)
            return
        }
        this.push(step)
        queueMicrotask((): void => this.deliver(index + 1))
    }
}

function createFixture(steps: readonly InputStep[], options: FixtureOptions = {}): CliFixture {
    const input = new ScriptedTty(steps, options)
    if (options.missingRawSetter) Object.defineProperty(input, "setRawMode", { value: undefined })
    const stdout: string[] = []
    const stderr: string[] = []
    const prompts: string[] = []
    const writes: PlaintextWrite[] = []
    const windowsWrites: WindowsWrite[] = []
    const identityCalls: IdentityOptions[] = []
    const platform = options.platform ?? "linux"
    const dependencies: CredentialsCliDependencies = {
        stdin: input,
        stdout: { isTTY: false, write(text: string): void { stdout.push(text) } },
        stderr: { isTTY: false, write(text: string): void { stderr.push(text) } },
        promptOutput: {
            isTTY: options.promptTty ?? true,
            write(text: string): void {
                prompts.push(text)
                if (prompts.length === options.promptFailureAt) throw new Error("Synthetic prompt failure.")
            },
        },
        platform,
        env: {},
        async getWindowsCredentialIdentity(options: IdentityOptions): Promise<Awaited<ReturnType<GetIdentity>>> {
            identityCalls.push(options)
            return { sid: SYNTHETIC_SID, account: "synthetic-account" }
        },
        async writePlaintextProfile(...args: PlaintextWrite): Promise<void> { writes.push(args) },
        async writeWindowsProfile(...args: WindowsWrite): Promise<void> { windowsWrites.push(args) },
    }
    return { input, stdout, stderr, prompts, writes, windowsWrites, identityCalls, platform, dependencies }
}

async function boundedRun(operation: Promise<number>, input: ScriptedTty): Promise<number> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject): void => {
        timer = setTimeout((): void => {
            const error = new Error("Synthetic TTY input timed out.")
            input.destroy(error)
            reject(error)
        }, RUN_TIMEOUT_MS)
    })
    try {
        return await Promise.race([operation, deadline])
    } finally {
        clearTimeout(timer)
    }
}

function expectCleanup(
    input: ScriptedTty,
    beforeStream: StreamListeners,
    beforeSignals: SignalListeners,
    rawModes: readonly boolean[],
): void {
    expect(input.isRaw).toBe(input.initialRaw)
    expect(input.rawModes.length).toBe(rawModes.length)
    expect(input.rawModes.every((mode: boolean, index: number): boolean => mode === rawModes[index])).toBe(true)
    if (input.activeListeners) expect(input.pauseCalls).toBeGreaterThan(input.activeListeners.pauseCalls)
    // Destroyed Readables may discard flowing state; recorded pause calls still verify cleanup.
    if (!input.destroyed) expect(input.isPaused()).toBe(true)
    for (const event of STREAM_EVENTS) {
        const after = input.rawListeners(event)
        expect(after.length).toBe(beforeStream[event].length)
        expect(after.every((listener, index: number): boolean => listener === beforeStream[event][index])).toBe(true)
        expect(after.includes(ignoreStreamEvent)).toBe(true)
        if (input.activeListeners) {
            const active = input.activeListeners.stream[event]
            expect(active.length).toBe(beforeStream[event].length + 1)
            expect(beforeStream[event].every((listener): boolean => active.includes(listener))).toBe(true)
        }
    }
    for (const event of SIGNAL_EVENTS) {
        const after = process.rawListeners(event)
        expect(after.length).toBe(beforeSignals[event].length)
        expect(after.every((listener, index: number): boolean => listener === beforeSignals[event][index])).toBe(true)
        if (input.activeListeners) {
            const active = input.activeListeners.signals[event]
            expect(active.length).toBe(beforeSignals[event].length + 1)
            expect(beforeSignals[event].every((listener): boolean => active.includes(listener))).toBe(true)
        }
    }
}

function promptTranscript(kind: CredentialKind): string {
    return PROMPTS[kind].map((label: string): string => `${label}\n`).join("")
}

async function runFixture(
    fixture: CliFixture,
    kind: CredentialKind,
    rawModes: readonly boolean[] = [true, fixture.input.initialRaw],
): Promise<{ code: number; bufferedBytes: number }> {
    const beforeStream = streamListeners(fixture.input)
    const beforeSignals = signalListeners()
    const args = ["set", "--provider", "plaintext", "--kind", kind, "--key", "SYNTH"]
    if (fixture.platform === "win32") args.push("--expected-sid", SYNTHETIC_SID)
    try {
        const code = await boundedRun(runCredentialsCli(args, fixture.dependencies), fixture.input)
        expectCleanup(fixture.input, beforeStream, beforeSignals, rawModes)
        // Boolean comparisons prevent assertion failures from rendering private input fixtures.
        expect(promptTranscript(kind).startsWith(fixture.prompts.join(""))).toBe(true)
        expect(fixture.stdout.join("") === (code === 0 ? "Credential profile saved.\n" : "")).toBe(true)
        expect(fixture.stderr.every((text: string): boolean => STATIC_STDERR.has(text))).toBe(true)
        expect(fixture.windowsWrites.length).toBe(0)
        if (code !== 0) expect(fixture.writes.length).toBe(0)
        return { code, bufferedBytes: fixture.input.readableLength }
    } finally {
        fixture.input.stop()
    }
}

function fieldInput(kind: CredentialKind, fields: Readonly<Record<string, string>>, delimiter: string = "\n"): Buffer {
    return Buffer.from(FIELD_NAMES[kind].map((name: string): string => fields[name] ?? "").join(delimiter) + delimiter)
}

function expectSaved(fixture: CliFixture, kind: CredentialKind, fields: Readonly<Record<string, string>>): void {
    expect(fixture.writes.length).toBe(1)
    const [writtenKind, key, profile, options] = fixture.writes[0]
    expect(writtenKind === kind && key === "SYNTH").toBe(true)
    expect(typeof profile === "object" && profile !== null).toBe(true)
    if (typeof profile !== "object" || profile === null) throw new Error("Expected captured profile object.")
    const captured = profile as Record<string, unknown>
    expect(Reflect.ownKeys(captured).length).toBe(Object.keys(fields).length)
    expect(Object.entries(fields).every(([name, value]): boolean => (
        Object.hasOwn(captured, name) && typeof captured[name] === "string" && captured[name] === value
    ))).toBe(true)
    expect(options?.expectedSid === (fixture.platform === "win32" ? SYNTHETIC_SID : undefined)).toBe(true)
    expect(fixture.prompts.join("") === promptTranscript(kind)).toBe(true)
    expect(fixture.stderr.join("") === (fixture.platform === "win32" ? CONTEXT_WARNING : "") + PLAINTEXT_WARNING).toBe(true)
    expect(fixture.input.activeListeners !== undefined).toBe(true)
}

function expectNoHiddenValues(fixture: CliFixture, values: readonly string[]): void {
    const combined = [...fixture.stdout, ...fixture.stderr, ...fixture.prompts].join("")
    for (const value of values) expect(!combined.includes(value)).toBe(true)
}

function expectFailure(fixture: CliFixture, code: number, message: string): void {
    expect(code).toBe(1)
    expect(fixture.writes.length).toBe(0)
    const warnings = (fixture.platform === "win32" ? CONTEXT_WARNING : "") + PLAINTEXT_WARNING
    expect(fixture.stderr.join("") === `${warnings}${message}\n`).toBe(true)
}

function sizedAuthorization(envelopeBytes: number): string {
    const overhead = Buffer.byteLength(JSON.stringify({ version: 1, kind: "rest", fields: { authorization: "" } }))
    const prefix = privateValue("sized")
    const remaining = envelopeBytes - overhead - Buffer.byteLength(prefix)
    const character = "é"
    const characterBytes = Buffer.byteLength(character)
    return prefix + character.repeat(Math.floor(remaining / characterBytes)) + "x".repeat(remaining % characterBytes)
}

const FULL_PROFILES = {
    ssh: {
        host: `  ${privateValue("host")}  `,
        username: privateValue("ssh-user"),
        port: "0022",
        keyfile: privateValue("keyfile"),
        agent: "false",
        password: `  ${privateValue("ssh-password")}  `,
        keypass: privateValue("keypass"),
    },
    db: {
        connection: privateValue("connection"),
        username: privateValue("db-user"),
        password: privateValue("db-password"),
    },
    rest: {
        authorization: privateValue("authorization"),
        username: privateValue("rest-user"),
        password: privateValue("rest-password"),
    },
} satisfies CredentialProfileMap
const MINIMAL_PROFILES = {
    ssh: { host: privateValue("minimal-host") },
    db: { connection: privateValue("minimal-connection") },
    rest: { authorization: privateValue("minimal-authorization") },
} satisfies CredentialProfileMap

describe("runCredentialsCli hidden input with synthetic raw TTY streams", (): void => {
    for (const kind of ["ssh", "db", "rest"] as const) {
        test(`${kind}: captures every string field with only static hidden prompts`, async (): Promise<void> => {
            const fields = FULL_PROFILES[kind]
            const fixture = createFixture([fieldInput(kind, fields)])
            const result = await runFixture(fixture, kind)
            expect(result.code).toBe(0)
            expectSaved(fixture, kind, fields)
            expectNoHiddenValues(fixture, Object.values(fields).filter((value: string): boolean => value.includes(privateValue(""))))
            expect(fixture.identityCalls.length).toBe(0)
        })

        test(`${kind}: omits empty hidden fields without adding defaults`, async (): Promise<void> => {
            const fields = MINIMAL_PROFILES[kind]
            const fixture = createFixture([fieldInput(kind, fields)])
            const result = await runFixture(fixture, kind)
            expect(result.code).toBe(0)
            expectSaved(fixture, kind, fields)
            expectNoHiddenValues(fixture, Object.values(fields))
        })
    }

    test("uses injected Windows identity and plaintext writer without native storage", async (): Promise<void> => {
        const fixture = createFixture([fieldInput("ssh", FULL_PROFILES.ssh)], { platform: "win32" })
        const result = await runFixture(fixture, "ssh")
        expect(result.code).toBe(0)
        expectSaved(fixture, "ssh", FULL_PROFILES.ssh)
        expect(fixture.identityCalls.length).toBe(1)
        expect(fixture.identityCalls[0]?.expectedSid === SYNTHETIC_SID).toBe(true)
    })

    test("REST accepts username and password when authorization is omitted", async (): Promise<void> => {
        const fields = { username: privateValue("basic-user"), password: privateValue("basic-password") }
        const fixture = createFixture([fieldInput("rest", fields)])
        const result = await runFixture(fixture, "rest")
        expect(result.code).toBe(0)
        expectSaved(fixture, "rest", fields)
    })

    test("preserves nonempty whitespace in optional hidden fields", async (): Promise<void> => {
        const fields = { ...MINIMAL_PROFILES.db, username: " ", password: "  " }
        const fixture = createFixture([fieldInput("db", fields)])
        const result = await runFixture(fixture, "db")
        expect(result.code).toBe(0)
        expectSaved(fixture, "db", fields)
    })

    const incompleteProfiles: readonly { name: string; kind: CredentialKind; fields: Record<string, string> }[] = [
        { name: "SSH missing host", kind: "ssh", fields: { password: privateValue("incomplete-ssh") } },
        { name: "SSH blank host", kind: "ssh", fields: { host: "   " } },
        { name: "DB missing connection", kind: "db", fields: { username: privateValue("incomplete-db") } },
        { name: "DB blank connection", kind: "db", fields: { connection: "   " } },
        { name: "REST all empty", kind: "rest", fields: {} },
        { name: "REST username only", kind: "rest", fields: { username: privateValue("incomplete-user") } },
        { name: "REST password only", kind: "rest", fields: { password: privateValue("incomplete-password") } },
    ]
    for (const { name, kind, fields } of incompleteProfiles) {
        test(`rejects incomplete profile: ${name}`, async (): Promise<void> => {
            const fixture = createFixture([fieldInput(kind, fields)])
            const result = await runFixture(fixture, kind)
            expectFailure(fixture, result.code, FAILURE_MESSAGES.incomplete)
            expect(fixture.prompts.join("") === promptTranscript(kind)).toBe(true)
        })
    }

    test("consumes CRLF paste split between fields without creating empty fields", async (): Promise<void> => {
        const values = Object.values(FULL_PROFILES.ssh)
        const chunks = values.flatMap((value: string, index: number): Buffer[] => (
            index === values.length - 1
                ? [Buffer.from(`${value}\r\n`)]
                : [Buffer.from(`${value}\r`), Buffer.from("\n")]
        ))
        const fixture = createFixture(chunks)
        const result = await runFixture(fixture, "ssh")
        expect(result.code).toBe(0)
        expectSaved(fixture, "ssh", FULL_PROFILES.ssh)
        expect(result.bufferedBytes).toBe(0)
    })

    // These cases make no claim to consume or reject future terminal chunks after the command completes.
    test("accepts a final CRLF split across chunks without requiring the later LF to drain", async (): Promise<void> => {
        const input = fieldInput("db", MINIMAL_PROFILES.db, "\r\n")
        const fixture = createFixture([input.subarray(0, -1), input.subarray(-1)])
        const result = await runFixture(fixture, "db")
        expect(result.code).toBe(0)
        expectSaved(fixture, "db", MINIMAL_PROFILES.db)
    })

    test("accepts mixed CR and LF terminators", async (): Promise<void> => {
        const fields = FULL_PROFILES.db
        const fixture = createFixture([Buffer.from(`${fields.connection}\r${fields.username}\n${fields.password}\r\n`)])
        const result = await runFixture(fixture, "db")
        expect(result.code).toBe(0)
        expectSaved(fixture, "db", fields)
    })

    test("backspace and delete remove Unicode codepoints across split UTF-8 bytes", async (): Promise<void> => {
        const prefix = privateValue("edited-connection")
        const bytes = Buffer.from(`\b\x7f${prefix}😀\b界\x7fé\b🦊\x7fq\u0301\x7f\n\n\n`)
        const chunks = Array.from(bytes, (byte: number): Buffer => Buffer.from([byte]))
        const fixture = createFixture(chunks)
        const result = await runFixture(fixture, "db")
        expect(result.code).toBe(0)
        expectSaved(fixture, "db", { connection: `${prefix}q` })
        expectNoHiddenValues(fixture, [prefix, `${prefix}q`])
    })

    test("rejects trailing data pasted in the final field chunk", async (): Promise<void> => {
        const fixture = createFixture([Buffer.concat([
            fieldInput("db", MINIMAL_PROFILES.db),
            Buffer.from(privateValue("trailing")),
        ])])
        const result = await runFixture(fixture, "db")
        expectFailure(fixture, result.code, FAILURE_MESSAGES.invalid)
    })

    test("completes without EOF and preserves the accepted profile despite later input", async (): Promise<void> => {
        const fixture = createFixture([
            fieldInput("db", MINIMAL_PROFILES.db),
            fieldInput("db", FULL_PROFILES.db),
        ])
        const result = await runFixture(fixture, "db")
        expect(result.code).toBe(0)
        expectSaved(fixture, "db", MINIMAL_PROFILES.db)
    })

    const malformedInputs: readonly { name: string; chunks: readonly InputStep[] }[] = [
        { name: "invalid leading byte", chunks: [Buffer.from([0xff])] },
        { name: "overlong encoding", chunks: [Buffer.from([0xc0, 0xaf])] },
        { name: "encoded surrogate", chunks: [Buffer.from([0xed, 0xa0, 0x80])] },
        { name: "invalid continuation", chunks: [Buffer.from([0xe2]), Buffer.from([0x28, 0xa1])] },
        { name: "incomplete multibyte EOF", chunks: [Buffer.from([0xe2]), Buffer.from([0x82]), "end"] },
        {
            name: "incomplete multibyte suffix after final terminator",
            chunks: [Buffer.concat([fieldInput("db", MINIMAL_PROFILES.db), Buffer.from([0xe2])])],
        },
    ]
    for (const { name, chunks } of malformedInputs) {
        test(`rejects UTF-8 input: ${name}`, async (): Promise<void> => {
            const fixture = createFixture([Buffer.from(privateValue("invalid-utf8")), ...chunks])
            const result = await runFixture(fixture, "db")
            expectFailure(fixture, result.code, FAILURE_MESSAGES.invalid)
            expectNoHiddenValues(fixture, [privateValue("invalid-utf8")])
        })
    }

    test("rejects predecoded streams before malformed UTF-8 can be replaced", async (): Promise<void> => {
        const fixture = createFixture([Buffer.from([0xff]), "end"])
        fixture.input.setEncoding("utf8")
        const result = await runFixture(fixture, "db")
        expectFailure(fixture, result.code, FAILURE_MESSAGES.invalid)
        expect(fixture.input.activeListeners === undefined).toBe(true)
    })

    const rejectedControls = [
        ...Array.from({ length: 32 }, (_value: unknown, code: number): number => code)
            .filter((code: number): boolean => ![3, 4, 8, 9, 10, 13, 26].includes(code)),
        ...Array.from({ length: 32 }, (_value: unknown, offset: number): number => 0x80 + offset),
    ]
    for (const code of rejectedControls) {
        test(`rejects hidden input control U+${code.toString(16).padStart(4, "0")}`, async (): Promise<void> => {
            const fixture = createFixture([Buffer.from(`${privateValue("control")}${String.fromCodePoint(code)}\n\n\n`)])
            const result = await runFixture(fixture, "db")
            expectFailure(fixture, result.code, FAILURE_MESSAGES.invalid)
            expectNoHiddenValues(fixture, [privateValue("control")])
        })
    }

    for (const [name, character] of [["Ctrl-C", "\x03"], ["Ctrl-D", "\x04"], ["Ctrl-Z", "\x1a"]] as const) {
        test(`${name} aborts without emitting input or writing a profile`, async (): Promise<void> => {
            const fixture = createFixture([Buffer.from(`${privateValue("aborted")}${character}\n\n\n`)])
            const result = await runFixture(fixture, "db")
            expectFailure(fixture, result.code, FAILURE_MESSAGES.aborted)
            expectNoHiddenValues(fixture, [privateValue("aborted")])
        })
    }

    const interruptedInputs: readonly { name: string; steps: readonly InputStep[]; message: string }[] = [
        { name: "empty EOF", steps: ["end"], message: FAILURE_MESSAGES.aborted },
        { name: "partial first field EOF", steps: [Buffer.from(privateValue("partial")), "end"], message: FAILURE_MESSAGES.aborted },
        { name: "missing final terminator EOF", steps: [Buffer.from(`${privateValue("partial")}\n\n`), "end"], message: FAILURE_MESSAGES.aborted },
        { name: "partial stream close", steps: [Buffer.from(privateValue("closed")), "close"], message: FAILURE_MESSAGES.aborted },
        { name: "partial stream error", steps: [Buffer.from(privateValue("errored")), new Error("Synthetic stream failure.")], message: FAILURE_MESSAGES.failed },
    ]
    for (const { name, steps, message } of interruptedInputs) {
        test(`rejects incomplete input: ${name}`, async (): Promise<void> => {
            const fixture = createFixture(steps)
            const result = await runFixture(fixture, "db")
            expectFailure(fixture, result.code, message)
        })
    }

    test("accepts an exactly maximum-sized serialized UTF-8 envelope", async (): Promise<void> => {
        const fields = { authorization: sizedAuthorization(MAX_CREDENTIAL_ENVELOPE_BYTES) }
        const fixture = createFixture([fieldInput("rest", fields)])
        const result = await runFixture(fixture, "rest")
        expect(result.code).toBe(0)
        expectSaved(fixture, "rest", fields)
    })

    test("rejects a serialized UTF-8 envelope one byte over the limit", async (): Promise<void> => {
        const fields = { authorization: sizedAuthorization(MAX_CREDENTIAL_ENVELOPE_BYTES + 1) }
        const fixture = createFixture([fieldInput("rest", fields)])
        const result = await runFixture(fixture, "rest")
        expectFailure(fixture, result.code, FAILURE_MESSAGES.tooLarge)
        expectNoHiddenValues(fixture, [privateValue("sized")])
    })

    for (const excess of [0, 1]) {
        test(`raw UTF-8 input budget includes editing bytes: limit plus ${excess}`, async (): Promise<void> => {
            const body = fieldInput("db", MINIMAL_PROFILES.db)
            const available = MAX_CREDENTIAL_ENVELOPE_BYTES - body.byteLength + excess
            const edit = "😀\x7f"
            const editBytes = Buffer.byteLength(edit)
            const padding = Buffer.concat([
                Buffer.from(edit.repeat(Math.floor(available / editBytes))),
                Buffer.alloc(available % editBytes, 0x7f),
            ])
            const fixture = createFixture([padding, body])
            const result = await runFixture(fixture, "db")
            if (excess === 0) {
                expect(result.code).toBe(0)
                expectSaved(fixture, "db", MINIMAL_PROFILES.db)
            } else {
                expectFailure(fixture, result.code, FAILURE_MESSAGES.tooLarge)
            }
        })
    }

    test("rejects a maximum-sized field when required line endings exceed the raw budget", async (): Promise<void> => {
        const fixture = createFixture([Buffer.alloc(MAX_CREDENTIAL_FIELD_BYTES, 0x78), Buffer.from("\n\n\n")])
        const result = await runFixture(fixture, "db")
        expectFailure(fixture, result.code, FAILURE_MESSAGES.tooLarge)
    })

    const unavailableTtys: readonly { name: string; options: FixtureOptions }[] = [
        { name: "stdin is not a TTY", options: { stdinTty: false } },
        { name: "prompt output is not a TTY", options: { promptTty: false } },
        { name: "raw setter is missing", options: { missingRawSetter: true } },
    ]
    for (const { name, options } of unavailableTtys) {
        test(`fails safely when ${name}`, async (): Promise<void> => {
            const fixture = createFixture([fieldInput("db", MINIMAL_PROFILES.db)], options)
            const result = await runFixture(fixture, "db", [])
            expectFailure(fixture, result.code, FAILURE_MESSAGES.tty)
            expect(fixture.prompts.length).toBe(0)
            expect(fixture.input.activeListeners === undefined).toBe(true)
        })
    }

    for (const rawBehavior of ["throws", "throws-after-enable", "no-effect"] as const) {
        test(`fails safely when raw setter ${rawBehavior}`, async (): Promise<void> => {
            const fixture = createFixture([fieldInput("db", MINIMAL_PROFILES.db)], { rawBehavior })
            const result = await runFixture(fixture, "db")
            expectFailure(fixture, result.code, rawBehavior === "no-effect" ? FAILURE_MESSAGES.tty : FAILURE_MESSAGES.failed)
            expect(fixture.prompts.length).toBe(0)
            expect(fixture.input.activeListeners === undefined).toBe(true)
        })
    }

    for (const initialRaw of [false, true]) {
        test(`restores initial raw state ${initialRaw} after success`, async (): Promise<void> => {
            const fixture = createFixture([fieldInput("db", MINIMAL_PROFILES.db)], { initialRaw })
            const result = await runFixture(fixture, "db")
            expect(result.code).toBe(0)
            expectSaved(fixture, "db", MINIMAL_PROFILES.db)
        })

        test(`restores initial raw state ${initialRaw} after failure`, async (): Promise<void> => {
            const fixture = createFixture([Buffer.from(`${privateValue("raw-abort")}\x03`)], { initialRaw })
            const result = await runFixture(fixture, "db")
            expectFailure(fixture, result.code, FAILURE_MESSAGES.aborted)
        })

        for (const promptFailureAt of [1, 2, 3]) {
            test(`cleans up prompt write failure ${promptFailureAt} with initial raw state ${initialRaw}`, async (): Promise<void> => {
                const fixture = createFixture([fieldInput("db", FULL_PROFILES.db)], { initialRaw, promptFailureAt })
                const result = await runFixture(fixture, "db")
                expectFailure(fixture, result.code, FAILURE_MESSAGES.failed)
                expect(fixture.prompts.length).toBe(promptFailureAt)
                expect((fixture.input.activeListeners !== undefined) === (promptFailureAt !== 1)).toBe(true)
            })
        }
    }
})
