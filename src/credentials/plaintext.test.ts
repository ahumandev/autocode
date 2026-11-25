import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import {
    MAX_PLAINTEXT_STORE_BYTES,
    parsePlaintextCredentialStore,
    serializePlaintextCredentialStore,
    type PlaintextCredentialStore,
} from "./plaintext"
import {
    CredentialError,
    MAX_CREDENTIAL_ENVELOPE_BYTES,
    WINDOWS_CREDENTIAL_MAX_BYTES,
    type CredentialErrorCode,
    type CredentialKind,
    type CredentialProfileMap,
} from "./types"

const SECRET_CANARY = "plaintext-test-synthetic-secret-canary"
const PARSER_MARKER = "plaintext-test-parser-marker"
const KINDS = ["ssh", "db", "rest"] as const
const ERROR_MESSAGES: Readonly<Partial<Record<CredentialErrorCode, string>>> = {
    invalid: "Invalid credential profile, storage, or ID.",
    denied: "Credential access denied.",
    too_large: "Credential exceeds the supported size limit.",
    incomplete: "Credential profile is incomplete.",
    missing: "Credential profile is missing.",
    unsafe_location: "Plaintext credential storage must use a private global configuration directory outside workspaces and Git repositories. Set OPENCODE_CONFIG_DIR to a private user directory.",
}
const COMPLETE_PROFILES = {
    ssh: {
        host: "  gateway.example.test  ",
        username: "  operator  ",
        port: " 0022 ",
        keyfile: " C:\\synthetic keys\\clé ",
        agent: " false ",
        password: "",
        keypass: `\t${SECRET_CANARY}\r\n漢字 😀\0`,
    },
    db: {
        connection: "  jdbc:postgresql://localhost:05432/app?ssl=false  ",
        username: "",
        password: ` ${SECRET_CANARY}\r\n `,
    },
    rest: {
        authorization: ` Bearer ${SECRET_CANARY} `,
        username: "",
        password: "\t ",
    },
} satisfies CredentialProfileMap

function storeWithProfile(kind: CredentialKind, fields: unknown, id: string = "PROFILE"): unknown {
    return { version: 1, profiles: { [kind]: { [id]: fields } } }
}

function createStoreLayers(): { store: PlaintextCredentialStore; layers: { value: object; key: string }[] } {
    const fields = { ...COMPLETE_PROFILES.ssh }
    const ids = { PROFILE: fields }
    const profiles = { ssh: ids }
    const store: PlaintextCredentialStore = { version: 1, profiles }
    return { store, layers: [
        { value: store, key: "profiles" },
        { value: profiles, key: "ssh" },
        { value: ids, key: "PROFILE" },
        { value: fields, key: "host" },
    ] }
}

function replaceStoreLayer(index: number, replace: (value: object) => unknown): unknown {
    const { store, layers } = createStoreLayers()
    const replacement = replace(layers[index].value)
    if (index === 0) return replacement
    Reflect.set(layers[index - 1].value, layers[index - 1].key, replacement)
    return store
}

function assertCredentialError(error: unknown, code: CredentialErrorCode, forbidden: readonly string[] = []): void {
    expect(error instanceof CredentialError).toBe(true)
    if (!(error instanceof CredentialError)) throw new Error("Expected sanitized CredentialError.")
    expect(error.constructor === CredentialError).toBe(true)
    expect(error.code).toBe(code)
    expect(error.name).toBe("CredentialError")
    expect(error.message === ERROR_MESSAGES[code]).toBe(true)
    expect(error.cause === undefined).toBe(true)
    expect(Object.hasOwn(error, "cause")).toBe(false)
    expect(Object.hasOwn(error, "nativeCode")).toBe(false)
    for (const marker of [SECRET_CANARY, PARSER_MARKER, "SyntaxError", "Unexpected token"]) {
        expect(`${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`.includes(marker)).toBe(false)
    }
    for (const marker of forbidden) expect(error.message.includes(marker)).toBe(false)
}

function expectCredentialError(action: () => unknown, code: CredentialErrorCode = "invalid"): void {
    try { action() } catch (error: unknown) {
        assertCredentialError(error, code)
        return
    }
    throw new Error("Expected CredentialError to be thrown.")
}

function sizedString(bytes: number, character: string): string {
    const encodedBytes = Buffer.byteLength(JSON.stringify(character).slice(1, -1), "utf8")
    return character.repeat(Math.floor(bytes / encodedBytes)) + "a".repeat(bytes % encodedBytes)
}

function sizedProfile(kind: CredentialKind, bytes: number, character: string): Record<string, string> {
    const field = kind === "ssh" ? "host" : kind === "db" ? "connection" : "authorization"
    const fields = { [field]: "" }
    const overhead = Buffer.byteLength(JSON.stringify({ version: 1, kind, fields }), "utf8")
    fields[field] = sizedString(bytes - overhead, character)
    expect(Buffer.byteLength(JSON.stringify({ version: 1, kind, fields }), "utf8")).toBe(bytes)
    return fields
}

function sizedStore(bytes: number, character: string): PlaintextCredentialStore {
    const profiles: Record<string, { authorization: string }> = {}
    // Seventeen profiles reach the file cap without exceeding any individual envelope cap.
    for (let index = 0; index < 17; index++) profiles[`PROFILE_${index}`] = { authorization: "" }
    const store: PlaintextCredentialStore = { version: 1, profiles: { rest: profiles } }
    let remaining = bytes - Buffer.byteLength(JSON.stringify(store), "utf8")
    const envelopeOverhead = Buffer.byteLength(JSON.stringify({ version: 1, kind: "rest", fields: { authorization: "" } }), "utf8")
    for (const fields of Object.values(profiles)) {
        const available = Math.min(remaining, MAX_CREDENTIAL_ENVELOPE_BYTES - envelopeOverhead)
        fields.authorization = sizedString(available, character)
        remaining -= available
    }
    expect(remaining).toBe(0)
    expect(Buffer.byteLength(JSON.stringify(store), "utf8")).toBe(bytes)
    return store
}

describe("plaintext credential parser and serializer", (): void => {
    for (const kind of KINDS) {
        test(`${kind}: preserves every raw string without defaults or normalization`, (): void => {
            const source = storeWithProfile(kind, COMPLETE_PROFILES[kind])
            const contents = JSON.stringify(source)
            const parsed = parsePlaintextCredentialStore(contents)
            expect(JSON.stringify(parsed) === contents).toBe(true)
            expect(serializePlaintextCredentialStore(source) === contents).toBe(true)
            expect(serializePlaintextCredentialStore(parsed) === contents).toBe(true)
            expect(parsed.profiles[kind]?.PROFILE === COMPLETE_PROFILES[kind]).toBe(false)
        })

        test(`${kind}: permits empty, sparse, and incomplete profiles`, (): void => {
            const inputs = kind === "ssh"
                ? [{}, { host: "" }, { host: " \t\r\n" }, { password: SECRET_CANARY }, { host: "gateway.example.test" }]
                : kind === "db"
                    ? [{}, { connection: "" }, { connection: " \t\r\n" }, { username: "", password: "" }, { connection: "jdbc:test:opaque" }]
                    : [{}, { username: "" }, { password: SECRET_CANARY }, { authorization: "" }, { username: "", password: "" }]
            for (const fields of inputs) {
                const source = storeWithProfile(kind, fields)
                const contents = JSON.stringify(source)
                expect(serializePlaintextCredentialStore(source) === contents).toBe(true)
                expect(JSON.stringify(parsePlaintextCredentialStore(contents)) === contents).toBe(true)
            }
        })

        test(`${kind}: accepts canonical IDs including prototype-like uppercase names`, (): void => {
            for (const id of ["APP", "APP_1", "_", "123", "__PROTO__", "CONSTRUCTOR"]) {
                const contents = JSON.stringify(storeWithProfile(kind, {}, id))
                const parsed = parsePlaintextCredentialStore(contents)
                expect(Object.hasOwn(parsed.profiles[kind] ?? {}, id)).toBe(true)
                expect(serializePlaintextCredentialStore(parsed)).toBe(contents)
            }
        })

        test(`${kind}: rejects noncanonical stored IDs rather than rewriting them`, (): void => {
            for (const id of ["", "app", " App ", "APP-HOST", " APP", "APP ", "APP.X", "A/B", "A\\B", "é", "A\0", "__proto__", "constructor"]) {
                const source = storeWithProfile(kind, { password: SECRET_CANARY }, id)
                expectCredentialError((): string => serializePlaintextCredentialStore(source))
                expectCredentialError((): unknown => parsePlaintextCredentialStore(JSON.stringify(source)))
            }
        })

        test(`${kind}: rejects nonstring values on every supported field`, (): void => {
            for (const field of Object.keys(COMPLETE_PROFILES[kind])) {
                for (const value of [null, false, 0, {}, []]) {
                    const source = storeWithProfile(kind, { ...COMPLETE_PROFILES[kind], [field]: value })
                    expectCredentialError((): string => serializePlaintextCredentialStore(source))
                    expectCredentialError((): unknown => parsePlaintextCredentialStore(JSON.stringify(source)))
                }
                for (const value of [undefined, 1n, Symbol(SECRET_CANARY), (): string => SECRET_CANARY]) {
                    expectCredentialError((): string => serializePlaintextCredentialStore(storeWithProfile(kind, { [field]: value })))
                }
            }
        })

        test(`${kind}: applies the exact full-envelope byte limit, including escaping and UTF-8`, (): void => {
            for (const character of ["a", "é", "😀", "\n", "\"", "\\"]) {
                for (const bytes of [MAX_CREDENTIAL_ENVELOPE_BYTES - 1, MAX_CREDENTIAL_ENVELOPE_BYTES]) {
                    const source = storeWithProfile(kind, sizedProfile(kind, bytes, character))
                    const contents = JSON.stringify(source)
                    expect(serializePlaintextCredentialStore(source) === contents).toBe(true)
                    expect(JSON.stringify(parsePlaintextCredentialStore(contents)) === contents).toBe(true)
                }
                const source = storeWithProfile(kind, sizedProfile(kind, MAX_CREDENTIAL_ENVELOPE_BYTES + 1, character))
                expectCredentialError((): string => serializePlaintextCredentialStore(source), "too_large")
                expectCredentialError((): unknown => parsePlaintextCredentialStore(JSON.stringify(source)), "too_large")
            }
        })
    }

    test("round-trips all kinds together and accepts empty and sparse kind maps", (): void => {
        for (const profiles of [{}, { ssh: {} }, { db: {} }, { rest: {} }, { ssh: {}, db: {}, rest: {} }, {
            ssh: { GATEWAY: COMPLETE_PROFILES.ssh },
            db: { DATABASE: COMPLETE_PROFILES.db },
            rest: { SERVICE: COMPLETE_PROFILES.rest },
        }]) {
            const source = { version: 1, profiles }
            const contents = JSON.stringify(source)
            expect(serializePlaintextCredentialStore(source) === contents).toBe(true)
            expect(JSON.stringify(parsePlaintextCredentialStore(contents)) === contents).toBe(true)
        }
    })

    test("accepts null prototypes at every layer and returns independent safe objects", (): void => {
        const { store, layers } = createStoreLayers()
        for (const { value } of layers) Object.setPrototypeOf(value, null)
        const contents = serializePlaintextCredentialStore(store)
        const parsed = parsePlaintextCredentialStore(contents)
        expect(Object.getPrototypeOf(parsed)).toBeNull()
        expect(Object.getPrototypeOf(parsed.profiles)).toBeNull()
        expect(Object.getPrototypeOf(parsed.profiles.ssh)).toBeNull()
        expect(Object.getPrototypeOf(parsed.profiles.ssh?.PROFILE)).toBeNull()
        Reflect.set(store.profiles.ssh?.PROFILE ?? {}, "host", "changed-source")
        expect(parsed.profiles.ssh?.PROFILE.host === COMPLETE_PROFILES.ssh.host).toBe(true)
        Reflect.set(parsed.profiles.ssh?.PROFILE ?? {}, "password", "changed-copy")
        expect(store.profiles.ssh?.PROFILE.password).toBe("")
    })

    test("rejects malformed JSON with fixed errors and no parser diagnostics", (): void => {
        for (const contents of ["", " ", `{${SECRET_CANARY}:${PARSER_MARKER}}`, `{"version":1,"profiles":{}} ${SECRET_CANARY}`, "{\"version\":1,}", "\uFEFF{\"version\":1,\"profiles\":{}}"])
            expectCredentialError((): unknown => parsePlaintextCredentialStore(contents))
    })

    test("rejects nonstring parser inputs without coercion", (): void => {
        let calls = 0
        const coercible = { toString(): string { calls += 1; return SECRET_CANARY } }
        for (const contents of [undefined, null, false, 1, [], {}, Buffer.from("{}"), coercible])
            expectCredentialError((): unknown => parsePlaintextCredentialStore(contents as unknown as string))
        expect(calls).toBe(0)
    })

    test("rejects non-JSON serializer roots and class instances without coercion", (): void => {
        for (const source of [undefined, 1n, Symbol(SECRET_CANARY), (): string => SECRET_CANARY, new Date(0),
            Object.assign(new (class {})(), { version: 1, profiles: {} })])
            expectCredentialError((): string => serializePlaintextCredentialStore(source))
    })

    test("rejects malformed roots, versions, kind maps, and profile objects", (): void => {
        const sources: unknown[] = [null, [], true, 1, SECRET_CANARY, {}, { version: 1 }, { profiles: {} }]
        for (const version of [undefined, null, "1", 0, 2, false]) sources.push({ version, profiles: {} })
        for (const value of [null, [], SECRET_CANARY, 0, false]) {
            sources.push({ version: 1, profiles: value })
            for (const kind of KINDS) {
                sources.push({ version: 1, profiles: { [kind]: value } })
                sources.push(storeWithProfile(kind, value))
            }
        }
        for (const source of sources) {
            expectCredentialError((): string => serializePlaintextCredentialStore(source))
            expectCredentialError((): unknown => parsePlaintextCredentialStore(JSON.stringify(source)))
        }
    })

    test("rejects unknown and prototype-related keys at root, kind, and field levels", (): void => {
        for (const key of ["unexpected", "__proto__", "constructor", "prototype", "toJSON", "SSH", SECRET_CANARY]) {
            const sources: unknown[] = [
                { version: 1, profiles: {}, [key]: SECRET_CANARY },
                { version: 1, profiles: { [key]: {} } },
                ...KINDS.map((kind: CredentialKind): unknown => storeWithProfile(kind, { [key]: SECRET_CANARY })),
            ]
            for (const source of sources) {
                expectCredentialError((): string => serializePlaintextCredentialStore(source))
                expectCredentialError((): unknown => parsePlaintextCredentialStore(JSON.stringify(source)))
            }
        }
        for (const kind of KINDS) {
            const field = kind === "ssh" ? "connection" : "host"
            const source = storeWithProfile(kind, { [field]: SECRET_CANARY })
            expectCredentialError((): string => serializePlaintextCredentialStore(source))
            expectCredentialError((): unknown => parsePlaintextCredentialStore(JSON.stringify(source)))
        }
    })

    test("rejects accessors and nonenumerable data at every layer without invoking hooks", (): void => {
        let calls = 0
        for (let index = 0; index < 4; index++) {
            const keys = Reflect.ownKeys(createStoreLayers().layers[index].value)
            for (const key of keys) {
                for (const enumerable of [false, true]) {
                    const source = replaceStoreLayer(index, (value: object): object => {
                        Object.defineProperty(value, key, {
                            enumerable,
                            get(): never { calls += 1; throw new Error(`${SECRET_CANARY}:${PARSER_MARKER}`) },
                            set(_value: unknown): void { calls += 1 },
                        })
                        return value
                    })
                    expectCredentialError((): string => serializePlaintextCredentialStore(source))
                }
                const source = replaceStoreLayer(index, (value: object): object => {
                    const descriptor = Object.getOwnPropertyDescriptor(value, key)
                    Object.defineProperty(value, key, { ...descriptor, enumerable: false })
                    return value
                })
                expectCredentialError((): string => serializePlaintextCredentialStore(source))
            }
        }
        expect(calls).toBe(0)
    })

    test("rejects symbol keys and untrusted prototypes at every layer", (): void => {
        for (let index = 0; index < 4; index++) {
            for (const enumerable of [false, true]) {
                const source = replaceStoreLayer(index, (value: object): object => {
                    Object.defineProperty(value, Symbol(SECRET_CANARY), { value: SECRET_CANARY, enumerable })
                    return value
                })
                expectCredentialError((): string => serializePlaintextCredentialStore(source))
            }
            for (const prototype of [{ inherited: SECRET_CANARY }, [], new (class {})()]) {
                const source = replaceStoreLayer(index, (value: object): object => Object.setPrototypeOf(value, prototype))
                expectCredentialError((): string => serializePlaintextCredentialStore(source))
            }
        }
    })

    test("rejects proxies and revoked proxies without executing traps or leaking tainted errors", (): void => {
        let calls = 0
        const tainted = new CredentialError("invalid")
        tainted.message = `${SECRET_CANARY}:${PARSER_MARKER}`
        Object.defineProperty(tainted, "cause", { value: new Error(SECRET_CANARY) })
        for (let index = 0; index < 4; index++) {
            const source = replaceStoreLayer(index, (value: object): object => new Proxy(value, {
                getPrototypeOf(): never { calls += 1; throw tainted },
                ownKeys(): never { calls += 1; throw tainted },
                get(): never { calls += 1; throw tainted },
            }))
            expectCredentialError((): string => serializePlaintextCredentialStore(source))
            const revoked = replaceStoreLayer(index, (value: object): object => {
                const proxy = Proxy.revocable(value, {})
                proxy.revoke()
                return proxy.proxy
            })
            expectCredentialError((): string => serializePlaintextCredentialStore(revoked))
        }
        expect(calls).toBe(0)
    })

    test("never invokes toJSON hooks on store input", (): void => {
        let calls = 0
        for (let index = 0; index < 4; index++) {
            const source = replaceStoreLayer(index, (value: object): object => {
                Reflect.set(value, "toJSON", (): never => { calls += 1; throw new Error(SECRET_CANARY) })
                return value
            })
            expectCredentialError((): string => serializePlaintextCredentialStore(source))
        }
        expect(calls).toBe(0)
    })

    test("an unrelated invalid profile corrupts the whole store", (): void => {
        for (const invalidProfiles of [
            { ssh: { SELECTED: COMPLETE_PROFILES.ssh, OTHER: { password: 7 } } },
            { ssh: { SELECTED: COMPLETE_PROFILES.ssh }, rest: { OTHER: { unknown: SECRET_CANARY } } },
        ]) {
            const source = { version: 1, profiles: invalidProfiles }
            expectCredentialError((): string => serializePlaintextCredentialStore(source))
            expectCredentialError((): unknown => parsePlaintextCredentialStore(JSON.stringify(source)))
        }
    })

    test("enforces total envelope size across multiple individually small fields", (): void => {
        const source = storeWithProfile("rest", { username: "a".repeat(32768), password: "b".repeat(32768) })
        expectCredentialError((): string => serializePlaintextCredentialStore(source), "too_large")
        expectCredentialError((): unknown => parsePlaintextCredentialStore(JSON.stringify(source)), "too_large")
        expectCredentialError((): string => serializePlaintextCredentialStore(storeWithProfile("rest", { authorization: "a".repeat(65537) })), "too_large")
    })

    test("plaintext accepts complete profiles larger than the native Windows credential limit", (): void => {
        expect(WINDOWS_CREDENTIAL_MAX_BYTES).toBe(2560)
        expect(MAX_CREDENTIAL_ENVELOPE_BYTES).toBe(65536)
        const source = storeWithProfile("rest", sizedProfile("rest", WINDOWS_CREDENTIAL_MAX_BYTES + 1, "😀"))
        const contents = serializePlaintextCredentialStore(source)
        expect(JSON.stringify(parsePlaintextCredentialStore(contents)) === contents).toBe(true)
    })

    test("counts all file whitespace and rejects an oversized malformed input before parsing", (): void => {
        expect(MAX_PLAINTEXT_STORE_BYTES).toBe(1048576)
        const contents = '{"version":1,"profiles":{}}'
        const boundary = contents + " ".repeat(MAX_PLAINTEXT_STORE_BYTES - Buffer.byteLength(contents, "utf8"))
        expect(Buffer.byteLength(boundary, "utf8")).toBe(MAX_PLAINTEXT_STORE_BYTES)
        expect(JSON.stringify(parsePlaintextCredentialStore(boundary))).toBe(contents)
        expectCredentialError((): unknown => parsePlaintextCredentialStore(boundary + " "), "too_large")
        expectCredentialError((): unknown => parsePlaintextCredentialStore("x".repeat(MAX_PLAINTEXT_STORE_BYTES + 1)), "too_large")
    })

    test("enforces the exact serialized file cap with ASCII and multibyte profiles", (): void => {
        for (const character of ["a", "é", "😀"]) {
            for (const bytes of [MAX_PLAINTEXT_STORE_BYTES - 1, MAX_PLAINTEXT_STORE_BYTES]) {
                const source = sizedStore(bytes, character)
                const contents = JSON.stringify(source)
                if (character !== "a") expect(contents.length < bytes).toBe(true)
                expect(serializePlaintextCredentialStore(source) === contents).toBe(true)
                expect(JSON.stringify(parsePlaintextCredentialStore(contents)) === contents).toBe(true)
            }
            const source = sizedStore(MAX_PLAINTEXT_STORE_BYTES + 1, character)
            const contents = JSON.stringify(source)
            expectCredentialError((): string => serializePlaintextCredentialStore(source), "too_large")
            expectCredentialError((): unknown => parsePlaintextCredentialStore(contents), "too_large")
        }
    })
})
