import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import {
    CredentialError,
    MAX_CREDENTIAL_ENVELOPE_BYTES,
    MAX_CREDENTIAL_FIELD_BYTES,
    WINDOWS_CREDENTIAL_MAX_BYTES,
    type CredentialErrorCode,
    type CredentialKind,
    type CredentialProfileMap,
} from "./types"
import { parseCredentialEnvelope, serializeCredentialEnvelope, validateCredentialProfile } from "./validation"

const SECRET_CANARY = "credential-test-secret-canary"
const KINDS = ["ssh", "db", "rest"] as const
const COMPLETE_PROFILES = {
    ssh: {
        host: "  gateway.example.test  ",
        username: "  operator  ",
        port: " 0022 ",
        keyfile: " C:\\keys\\test key ",
        agent: " false ",
        password: "",
        keypass: "\t ",
    },
    db: {
        connection: "  jdbc:postgresql://localhost:05432/app?ssl=false  ",
        username: "  db user  ",
        password: "",
    },
    rest: {
        authorization: ` Bearer ${SECRET_CANARY} `,
        username: "",
        password: "\t ",
    },
} satisfies CredentialProfileMap
const MINIMAL_PROFILES = {
    ssh: { host: "gateway.example.test" },
    db: { connection: "jdbc:postgresql://localhost/app" },
    rest: { authorization: "" },
} satisfies CredentialProfileMap
const INCOMPLETE_PROFILES: Readonly<Record<CredentialKind, readonly unknown[]>> = {
    ssh: [{}, { host: "" }, { host: " \t\r\n" }, { password: SECRET_CANARY }, { host: "", username: SECRET_CANARY }],
    db: [{}, { connection: "" }, { connection: " \t\r\n" }, { password: SECRET_CANARY }, { connection: "", username: SECRET_CANARY }],
    rest: [{}, { username: "" }, { password: "" }, { username: SECRET_CANARY }, { password: SECRET_CANARY }],
}

function expectCredentialError(action: () => unknown, code: CredentialErrorCode = "invalid"): void {
    try {
        action()
    } catch (error: unknown) {
        expect(error).toBeInstanceOf(CredentialError)
        if (!(error instanceof CredentialError)) {
            throw new Error("Expected CredentialError.")
        }
        expect(error.code).toBe(code)
        expect(error.message).toBe(new CredentialError(code).message)
        expect(error.message).not.toContain(SECRET_CANARY)
        expect(error.message).not.toContain("SyntaxError")
        expect(error.cause).toBeUndefined()
        expect(Object.hasOwn(error, "cause")).toBe(false)
        return
    }
    throw new Error("Expected CredentialError to be thrown.")
}

function createSizedEnvelope(byteLength: number, character: string = "a"): { fields: { authorization: string }; payload: string } {
    const fields = { authorization: "" }
    const envelope = { version: 1, kind: "rest", fields }
    const overhead = Buffer.byteLength(JSON.stringify(envelope), "utf8")
    const available = byteLength - overhead
    const characterBytes = Buffer.byteLength(character, "utf8")
    fields.authorization = character.repeat(Math.floor(available / characterBytes)) + "a".repeat(available % characterBytes)
    const payload = JSON.stringify(envelope)
    expect(Buffer.byteLength(payload, "utf8")).toBe(byteLength)
    return { fields, payload }
}

describe("validateCredentialProfile", (): void => {
    for (const kind of KINDS) {
        describe(kind, (): void => {
            test("returns a fresh complete copy preserving raw spaces and blank strings", (): void => {
                const fields = { ...COMPLETE_PROFILES[kind] }
                const result = validateCredentialProfile(kind, fields)
                expect(result.status).toBe("found")
                if (result.status !== "found") {
                    throw new Error("Expected complete credential profile.")
                }
                expect({ ...result.profile }).toEqual(fields)
                expect(result.profile).not.toBe(fields)
                expect(Reflect.ownKeys(result.profile)).toEqual(Reflect.ownKeys(fields))
                Reflect.set(fields, "password", "source-only")
                expect({ ...result.profile }).toEqual(COMPLETE_PROFILES[kind])
                Reflect.set(result.profile, "password", "copy-only")
                expect(fields.password).toBe("source-only")
            })

            test("accepts minimal profiles without adding defaults", (): void => {
                const fields = MINIMAL_PROFILES[kind]
                const result = validateCredentialProfile(kind, fields)
                expect(result).toEqual({ status: "found", profile: fields })
                if (result.status !== "found") {
                    throw new Error("Expected complete credential profile.")
                }
                expect(result.profile).not.toBe(fields)
                expect(Reflect.ownKeys(result.profile)).toEqual(Reflect.ownKeys(fields))
            })

            test("preserves empty and whitespace-only optional strings", (): void => {
                const required = Object.keys(MINIMAL_PROFILES[kind])
                for (const field of Object.keys(COMPLETE_PROFILES[kind])) {
                    if (required.includes(field)) continue
                    for (const value of ["", " \t\r\n"]) {
                        const fields = { ...MINIMAL_PROFILES[kind], [field]: value }
                        expect(validateCredentialProfile(kind, fields)).toEqual({ status: "found", profile: fields })
                    }
                }
            })

            test("accepts null-prototype objects and own nonenumerable data fields", (): void => {
                const fields: object = Object.assign(Object.create(null), MINIMAL_PROFILES[kind])
                Object.defineProperty(fields, "password", { value: "", enumerable: false })
                const expected = { ...MINIMAL_PROFILES[kind], password: "" }
                expect(validateCredentialProfile(kind, fields)).toEqual({ status: "found", profile: expected })
                expect(serializeCredentialEnvelope(kind, fields)).toBe(JSON.stringify({ version: 1, kind, fields: expected }))
            })

            test("returns only incomplete status without exposing partial profiles", (): void => {
                for (const fields of INCOMPLETE_PROFILES[kind]) {
                    const result = validateCredentialProfile(kind, fields)
                    expect(result).toEqual({ status: "incomplete" })
                    expect(Reflect.ownKeys(result)).toEqual(["status"])
                    expect(JSON.stringify(result)).not.toContain(SECRET_CANARY)
                }
            })

            test("rejects null, arrays, primitives, class instances, and inherited prototypes", (): void => {
                const fields = COMPLETE_PROFILES[kind]
                const invalidProfiles: readonly unknown[] = [
                    null, undefined, [], [SECRET_CANARY], "", SECRET_CANARY, 0, true, 1n, Symbol(SECRET_CANARY),
                    (): string => SECRET_CANARY,
                    Object.assign(new (class {})(), fields),
                    Object.create(fields),
                    Object.assign(Object.create({ inherited: SECRET_CANARY }), fields),
                ]
                for (const profile of invalidProfiles) {
                    expectCredentialError((): unknown => validateCredentialProfile(kind, profile))
                    expectCredentialError((): unknown => serializeCredentialEnvelope(kind, profile))
                }
            })

            test("rejects unknown keys including prototype-related and other-kind fields", (): void => {
                const otherKindField = kind === "ssh" ? "connection" : "host"
                for (const key of ["unexpected", "__proto__", "constructor", "toJSON", otherKindField]) {
                    const fields = { ...MINIMAL_PROFILES[kind] }
                    Object.defineProperty(fields, key, { value: SECRET_CANARY, enumerable: true })
                    expectCredentialError((): unknown => validateCredentialProfile(kind, fields))
                    expectCredentialError((): unknown => serializeCredentialEnvelope(kind, fields))
                }
            })

            test("rejects every nonstring value on required and optional fields", (): void => {
                const values: readonly unknown[] = [
                    undefined, null, 0, false, {}, [], { password: SECRET_CANARY }, 1n, Symbol(SECRET_CANARY),
                    (): string => SECRET_CANARY,
                ]
                for (const field of Object.keys(COMPLETE_PROFILES[kind])) {
                    for (const value of values) {
                        const fields = { ...MINIMAL_PROFILES[kind], [field]: value }
                        expectCredentialError((): unknown => validateCredentialProfile(kind, fields))
                        expectCredentialError((): unknown => serializeCredentialEnvelope(kind, fields))
                    }
                }
            })

            test("rejects enumerable and nonenumerable symbol keys", (): void => {
                for (const enumerable of [false, true]) {
                    const fields = { ...MINIMAL_PROFILES[kind] }
                    Object.defineProperty(fields, Symbol(SECRET_CANARY), { value: SECRET_CANARY, enumerable })
                    expectCredentialError((): unknown => validateCredentialProfile(kind, fields))
                    expectCredentialError((): unknown => serializeCredentialEnvelope(kind, fields))
                }
            })

            test("rejects accessors on every recognized field without invoking getters or setters", (): void => {
                let calls = 0
                for (const field of Object.keys(COMPLETE_PROFILES[kind])) {
                    for (const enumerable of [false, true]) {
                        const fields = { ...MINIMAL_PROFILES[kind] }
                        Object.defineProperty(fields, field, {
                            enumerable,
                            get(): string {
                                calls += 1
                                throw new Error(SECRET_CANARY)
                            },
                        })
                        expectCredentialError((): unknown => validateCredentialProfile(kind, fields))
                        expectCredentialError((): unknown => serializeCredentialEnvelope(kind, fields))
                    }
                    const fields = { ...MINIMAL_PROFILES[kind] }
                    Object.defineProperty(fields, field, {
                        set(_value: unknown): void {
                            calls += 1
                        },
                    })
                    expectCredentialError((): unknown => validateCredentialProfile(kind, fields))
                    expectCredentialError((): unknown => serializeCredentialEnvelope(kind, fields))
                }
                expect(calls).toBe(0)
            })
        })
    }

    test("accepts REST authorization or both basic fields by presence, including empty strings", (): void => {
        const profiles = [
            { authorization: "" },
            { authorization: " \t " },
            { authorization: "", username: "" },
            { authorization: "", password: "" },
            { username: "", password: "" },
            { username: " \t ", password: " " },
            { authorization: `Bearer ${SECRET_CANARY}`, username: "", password: "" },
        ]
        for (const profile of profiles) {
            expect(validateCredentialProfile("rest", profile)).toEqual({ status: "found", profile })
        }
    })

    test("keeps SSH ports as arbitrary strings rather than normalizing or validating numbers", (): void => {
        for (const port of ["", " \t ", "0", "-1", "65536", "not-a-port", " 0022 "]) {
            const fields = { host: " gateway.example.test ", port }
            expect(validateCredentialProfile("ssh", fields)).toEqual({ status: "found", profile: fields })
        }
    })

    test("keeps JDBC connections and embedded port strings unchanged", (): void => {
        for (const connection of [" jdbc:postgresql://localhost:05432/app ", "jdbc:test:opaque", " connection "]) {
            const fields = { connection }
            expect(validateCredentialProfile("db", fields)).toEqual({ status: "found", profile: fields })
        }
    })

    test("rejects unknown kinds across validation, parsing, and serialization", (): void => {
        const kinds: readonly unknown[] = ["", "SSH", "smtp", "__proto__", null, undefined, 0, true, {}, Symbol(SECRET_CANARY)]
        for (const value of kinds) {
            const kind = value as CredentialKind
            expectCredentialError((): unknown => validateCredentialProfile(kind, {}))
            expectCredentialError((): unknown => serializeCredentialEnvelope(kind, {}))
            expectCredentialError((): unknown => parseCredentialEnvelope(kind, JSON.stringify({ version: 1, kind: "ssh", fields: {} })))
        }
    })

    test("sanitizes reflection errors and tainted CredentialErrors without retaining causes", (): void => {
        const tainted = new CredentialError("invalid")
        tainted.message = SECRET_CANARY
        Object.defineProperty(tainted, "cause", { value: new Error(SECRET_CANARY) })
        let getterCalls = 0
        const accessorError = new CredentialError("invalid")
        Object.defineProperty(accessorError, "code", {
            get(): string {
                getterCalls += 1
                throw new Error(SECRET_CANARY)
            },
        })
        for (const error of [new Error(SECRET_CANARY), tainted, accessorError]) {
            const fields = new Proxy({}, {
                getPrototypeOf(): object | null {
                    throw error
                },
            })
            expectCredentialError((): unknown => validateCredentialProfile("ssh", fields))
            expectCredentialError((): unknown => serializeCredentialEnvelope("ssh", fields))
        }
        expect(getterCalls).toBe(0)
    })
})

describe("credential envelopes", (): void => {
    for (const kind of KINDS) {
        describe(kind, (): void => {
            test("serializes exactly version, kind, and unchanged fields", (): void => {
                const fields = COMPLETE_PROFILES[kind]
                expect(serializeCredentialEnvelope(kind, fields)).toBe(JSON.stringify({ version: 1, kind, fields }))
            })

            test("parses strings, Uint8Arrays, Buffers, and offset byte views", (): void => {
                const fields = COMPLETE_PROFILES[kind]
                const payload = JSON.stringify({ version: 1, kind, fields })
                const bytes = Buffer.from(payload, "utf8")
                const padded = Buffer.concat([Buffer.from("prefix"), bytes, Buffer.from("suffix")])
                const view = new Uint8Array(padded.buffer, padded.byteOffset + Buffer.byteLength("prefix"), bytes.byteLength)
                for (const input of [payload, new Uint8Array(bytes), bytes, view]) {
                    expect(parseCredentialEnvelope(kind, input)).toEqual(fields)
                }
            })

            test("serializes incomplete valid objects and leaves completeness validation separate", (): void => {
                for (const fields of INCOMPLETE_PROFILES[kind]) {
                    const payload = serializeCredentialEnvelope(kind, fields)
                    expect(payload).toBe(JSON.stringify({ version: 1, kind, fields }))
                    const parsed = parseCredentialEnvelope(kind, payload)
                    expect(parsed).toEqual(fields)
                    expect(validateCredentialProfile(kind, parsed)).toEqual({ status: "incomplete" })
                }
            })

            test("returns untrusted fields without prematurely validating their shape", (): void => {
                const invalidFields: readonly unknown[] = [
                    null, [], SECRET_CANARY, 0, true,
                    { ...MINIMAL_PROFILES[kind], password: null },
                    { ...MINIMAL_PROFILES[kind], unexpected: SECRET_CANARY },
                ]
                for (const fields of invalidFields) {
                    const payload = JSON.stringify({ version: 1, kind, fields })
                    const parsed = parseCredentialEnvelope(kind, payload)
                    expect(parsed).toEqual(fields)
                    expectCredentialError((): unknown => validateCredentialProfile(kind, parsed))
                }
            })
        })
    }

    test("rejects malformed JSON without exposing parser text or secret content", (): void => {
        const valid = JSON.stringify({ version: 1, kind: "rest", fields: { authorization: SECRET_CANARY } })
        for (const payload of ["", " \t\r\n", "undefined", "{", valid.slice(0, -1), `${valid} trailing`, `{${SECRET_CANARY}}`]) {
            expectCredentialError((): unknown => parseCredentialEnvelope("rest", payload))
            expectCredentialError((): unknown => parseCredentialEnvelope("rest", Buffer.from(payload, "utf8")))
        }
    })

    test("rejects null, arrays, primitive JSON roots, and empty objects", (): void => {
        for (const root of [null, [], [{ version: 1, kind: "ssh", fields: {} }], SECRET_CANARY, 0, true, {}]) {
            expectCredentialError((): unknown => parseCredentialEnvelope("ssh", JSON.stringify(root)))
        }
    })

    test("requires numeric version exactly one", (): void => {
        for (const version of [undefined, null, "1", 0, 2, -1, 1.5, true, {}, []]) {
            const payload = JSON.stringify({ version, kind: "ssh", fields: {} })
            expectCredentialError((): unknown => parseCredentialEnvelope("ssh", payload))
        }
    })

    test("requires the root kind to match the requested kind exactly", (): void => {
        for (const kind of KINDS) {
            const wrongKinds: readonly unknown[] = [...KINDS.filter((value: CredentialKind): boolean => value !== kind), undefined, null, "SSH", "smtp", 0, {}, []]
            for (const storedKind of wrongKinds) {
                const payload = JSON.stringify({ version: 1, kind: storedKind, fields: {} })
                expectCredentialError((): unknown => parseCredentialEnvelope(kind, payload))
            }
        }
    })

    test("rejects every extra root key including prototype-related names", (): void => {
        for (const key of ["unexpected", "password", "__proto__", "constructor", "toJSON"]) {
            const envelope = { version: 1, kind: "ssh", fields: {} }
            Object.defineProperty(envelope, key, { value: SECRET_CANARY, enumerable: true })
            expectCredentialError((): unknown => parseCredentialEnvelope("ssh", JSON.stringify(envelope)))
        }
    })

    test("requires all three root keys, even when a replacement key keeps the count at three", (): void => {
        for (const root of [
            { kind: "ssh", fields: {} },
            { version: 1, fields: {} },
            { version: 1, kind: "ssh" },
            { version: 1, kind: "ssh", profile: {} },
            { version: 1, fields: {}, unexpected: SECRET_CANARY },
            { kind: "ssh", fields: {}, unexpected: SECRET_CANARY },
        ]) {
            expectCredentialError((): unknown => parseCredentialEnvelope("ssh", JSON.stringify(root)))
        }
    })

    test("rejects payload types other than strings and Uint8Arrays", (): void => {
        const payloads: readonly unknown[] = [null, undefined, {}, [], 0, true, new ArrayBuffer(8), new Uint16Array(8), new DataView(new ArrayBuffer(8))]
        for (const payload of payloads) {
            expectCredentialError((): unknown => parseCredentialEnvelope("ssh", payload as string | Uint8Array))
        }
    })

    test("rejects malformed UTF-8 inside otherwise valid JSON string fields", (): void => {
        const prefix = Buffer.from(`{"version":1,"kind":"rest","fields":{"authorization":"${SECRET_CANARY}`, "utf8")
        const suffix = Buffer.from('"}}', "utf8")
        for (const bytes of [[0xff], [0xc3, 0x28], [0xe2, 0x82], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
            const payload = Buffer.concat([prefix, Buffer.from(bytes), suffix])
            expectCredentialError((): unknown => parseCredentialEnvelope("rest", new Uint8Array(payload)))
        }
    })

    test("defers prototype-related field keys to profile validation without polluting prototypes", (): void => {
        const payload = `{"version":1,"kind":"ssh","fields":{"host":"gateway.example.test","__proto__":{"password":"${SECRET_CANARY}"}}}`
        const fields = parseCredentialEnvelope("ssh", payload)
        expect(typeof fields).toBe("object")
        if (typeof fields !== "object" || fields === null) {
            throw new Error("Expected parsed fields object.")
        }
        expect(Object.hasOwn(fields, "__proto__")).toBe(true)
        expect(Object.getPrototypeOf(fields)).toBe(Object.prototype)
        expect(Object.hasOwn(Object.prototype, "password")).toBe(false)
        expectCredentialError((): unknown => validateCredentialProfile("ssh", fields))
    })
})

describe("credential UTF-8 byte limits", (): void => {
    test("pins generic, per-field, and Windows limits", (): void => {
        expect(MAX_CREDENTIAL_ENVELOPE_BYTES).toBe(65536)
        expect(MAX_CREDENTIAL_FIELD_BYTES).toBe(65536)
        expect(WINDOWS_CREDENTIAL_MAX_BYTES).toBe(2560)
    })

    test("rejects caps that are not positive finite integers at most the generic limit", (): void => {
        const invalidCaps: readonly unknown[] = [0, -1, 0.5, NaN, Infinity, -Infinity, MAX_CREDENTIAL_ENVELOPE_BYTES + 1, "2560", null, true, {}, 1n]
        const fields = MINIMAL_PROFILES.rest
        const payload = JSON.stringify({ version: 1, kind: "rest", fields })
        for (const value of invalidCaps) {
            const maxBytes = value as number
            expectCredentialError((): unknown => parseCredentialEnvelope("rest", payload, maxBytes))
            expectCredentialError((): unknown => serializeCredentialEnvelope("rest", fields, maxBytes))
        }
    })

    test("accepts positive integer caps but rejects envelopes exceeding them", (): void => {
        const fields = MINIMAL_PROFILES.rest
        const payload = JSON.stringify({ version: 1, kind: "rest", fields })
        const size = Buffer.byteLength(payload, "utf8")
        expectCredentialError((): unknown => parseCredentialEnvelope("rest", payload, 1), "too_large")
        expectCredentialError((): unknown => serializeCredentialEnvelope("rest", fields, 1), "too_large")
        expect(parseCredentialEnvelope("rest", payload, size)).toEqual(fields)
        expect(serializeCredentialEnvelope("rest", fields, size)).toBe(payload)
        expectCredentialError((): unknown => parseCredentialEnvelope("rest", payload, size - 1), "too_large")
        expectCredentialError((): unknown => serializeCredentialEnvelope("rest", fields, size - 1), "too_large")
    })

    test("does not apply the Windows cap to generic validation, parsing, or serialization", (): void => {
        const { fields, payload } = createSizedEnvelope(WINDOWS_CREDENTIAL_MAX_BYTES + 1)
        expect(validateCredentialProfile("rest", fields)).toEqual({ status: "found", profile: fields })
        expect(serializeCredentialEnvelope("rest", fields)).toBe(payload)
        expect(serializeCredentialEnvelope("rest", fields, undefined)).toBe(payload)
        expect(parseCredentialEnvelope("rest", payload)).toEqual(fields)
        expect(parseCredentialEnvelope("rest", new Uint8Array(Buffer.from(payload, "utf8")), undefined)).toEqual(fields)
    })

    for (const character of ["a", "é", "😀"]) {
        test(`accepts exactly 2560 envelope bytes with explicit Windows cap (${character})`, (): void => {
            const { fields, payload } = createSizedEnvelope(WINDOWS_CREDENTIAL_MAX_BYTES, character)
            expect(serializeCredentialEnvelope("rest", fields, WINDOWS_CREDENTIAL_MAX_BYTES)).toBe(payload)
            expect(parseCredentialEnvelope("rest", payload, WINDOWS_CREDENTIAL_MAX_BYTES)).toEqual(fields)
            expect(parseCredentialEnvelope("rest", new Uint8Array(Buffer.from(payload, "utf8")), WINDOWS_CREDENTIAL_MAX_BYTES)).toEqual(fields)
        })

        test(`rejects 2561 envelope bytes with explicit Windows cap (${character})`, (): void => {
            const { fields, payload } = createSizedEnvelope(WINDOWS_CREDENTIAL_MAX_BYTES + 1, character)
            if (character !== "a") expect(payload.length).toBeLessThan(WINDOWS_CREDENTIAL_MAX_BYTES)
            expectCredentialError((): unknown => serializeCredentialEnvelope("rest", fields, WINDOWS_CREDENTIAL_MAX_BYTES), "too_large")
            expectCredentialError((): unknown => parseCredentialEnvelope("rest", payload, WINDOWS_CREDENTIAL_MAX_BYTES), "too_large")
            expectCredentialError((): unknown => parseCredentialEnvelope("rest", new Uint8Array(Buffer.from(payload, "utf8")), WINDOWS_CREDENTIAL_MAX_BYTES), "too_large")
        })

        test(`accepts exactly 65536 full-envelope bytes (${character})`, (): void => {
            const { fields, payload } = createSizedEnvelope(MAX_CREDENTIAL_ENVELOPE_BYTES, character)
            expect(validateCredentialProfile("rest", fields)).toEqual({ status: "found", profile: fields })
            expect(serializeCredentialEnvelope("rest", fields)).toBe(payload)
            expect(serializeCredentialEnvelope("rest", fields, MAX_CREDENTIAL_ENVELOPE_BYTES)).toBe(payload)
            expect(parseCredentialEnvelope("rest", payload)).toEqual(fields)
            expect(parseCredentialEnvelope("rest", new Uint8Array(Buffer.from(payload, "utf8")), MAX_CREDENTIAL_ENVELOPE_BYTES)).toEqual(fields)
        })

        test(`rejects 65537 full-envelope bytes even when the field remains below its limit (${character})`, (): void => {
            const { fields, payload } = createSizedEnvelope(MAX_CREDENTIAL_ENVELOPE_BYTES + 1, character)
            expect(Buffer.byteLength(fields.authorization, "utf8")).toBeLessThan(MAX_CREDENTIAL_FIELD_BYTES)
            expectCredentialError((): unknown => validateCredentialProfile("rest", fields), "too_large")
            expectCredentialError((): unknown => serializeCredentialEnvelope("rest", fields), "too_large")
            expectCredentialError((): unknown => parseCredentialEnvelope("rest", payload), "too_large")
            expectCredentialError((): unknown => parseCredentialEnvelope("rest", new Uint8Array(Buffer.from(payload, "utf8"))), "too_large")
        })
    }

    test("rejects oversized required and optional fields for every kind with sanitized errors", (): void => {
        const ascii = SECRET_CANARY + "a".repeat(MAX_CREDENTIAL_FIELD_BYTES + 1 - Buffer.byteLength(SECRET_CANARY, "utf8"))
        const multibyte = SECRET_CANARY + "😀".repeat(Math.floor(MAX_CREDENTIAL_FIELD_BYTES / Buffer.byteLength("😀", "utf8")))
        for (const value of [ascii, multibyte]) {
            expect(Buffer.byteLength(value, "utf8")).toBeGreaterThan(MAX_CREDENTIAL_FIELD_BYTES)
            for (const kind of KINDS) {
                for (const field of Object.keys(COMPLETE_PROFILES[kind])) {
                    const fields = { ...MINIMAL_PROFILES[kind], [field]: value }
                    expectCredentialError((): unknown => validateCredentialProfile(kind, fields), "too_large")
                    expectCredentialError((): unknown => serializeCredentialEnvelope(kind, fields), "too_large")
                }
            }
        }
    })

    test("counts JSON escaping overhead rather than only raw field bytes", (): void => {
        const fields = { authorization: ` ${SECRET_CANARY}${"\n".repeat(Math.floor(MAX_CREDENTIAL_ENVELOPE_BYTES / 2))}` }
        const payload = JSON.stringify({ version: 1, kind: "rest", fields })
        expect(Buffer.byteLength(fields.authorization, "utf8")).toBeLessThan(MAX_CREDENTIAL_FIELD_BYTES)
        expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(MAX_CREDENTIAL_ENVELOPE_BYTES)
        expectCredentialError((): unknown => validateCredentialProfile("rest", fields), "too_large")
        expectCredentialError((): unknown => serializeCredentialEnvelope("rest", fields), "too_large")
        expectCredentialError((): unknown => parseCredentialEnvelope("rest", payload), "too_large")
    })

    test("counts leading and trailing JSON whitespace toward the full payload cap", (): void => {
        const { fields, payload } = createSizedEnvelope(WINDOWS_CREDENTIAL_MAX_BYTES - 2)
        const exact = ` ${payload}\n`
        expect(Buffer.byteLength(exact, "utf8")).toBe(WINDOWS_CREDENTIAL_MAX_BYTES)
        expect(parseCredentialEnvelope("rest", exact, WINDOWS_CREDENTIAL_MAX_BYTES)).toEqual(fields)
        expectCredentialError((): unknown => parseCredentialEnvelope("rest", ` ${exact}`, WINDOWS_CREDENTIAL_MAX_BYTES), "too_large")
    })
})
