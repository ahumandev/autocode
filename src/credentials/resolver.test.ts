import { beforeAll, describe, expect, mock, test } from "bun:test"
import { Buffer } from "node:buffer"
import { createCredentialResolver } from "./resolver"
import {
    CredentialError,
    MAX_CREDENTIAL_ENVELOPE_BYTES,
    MAX_CREDENTIAL_FIELD_BYTES,
    PLAINTEXT_CREDENTIAL_WARNING,
    WINDOWS_CREDENTIAL_MAX_BYTES,
    type CredentialErrorCode,
    type CredentialKind,
    type CredentialProfileMap,
    type CredentialProvider,
    type CredentialProviderName,
    type CredentialProviderPolicy,
    type CredentialReadResult,
    type CredentialSource,
} from "./types"

const SECRET = "resolver-test-secret-canary"
const PROFILE_ID = " resolver_secret_2 "
const NORMALIZED_ID = "RESOLVER_SECRET_2"
const kinds: CredentialKind[] = ["ssh", "db", "rest"]
const providerNames: Exclude<CredentialProviderName, "linux-secret-service">[] = ["windows-credential-manager", "plaintext"]
const softStatuses: ("missing" | "incomplete" | "unavailable")[] = ["missing", "incomplete", "unavailable"]
const profiles: CredentialProfileMap = {
    ssh: { host: "plaintext.example.test" },
    db: { connection: "Server=plaintext.example.test" },
    rest: { authorization: `Bearer ${SECRET}` },
}

function providerReturning(result: CredentialReadResult): CredentialProvider {
    return {
        read: mock(async (_kind: CredentialKind, _normalizedId: string): Promise<CredentialReadResult> => result),
    }
}

function providerThrowing(error: unknown): CredentialProvider {
    return {
        read: mock(async (_kind: CredentialKind, _normalizedId: string): Promise<CredentialReadResult> => {
            throw error
        }),
    }
}

async function expectCredentialError(
    action: () => Promise<unknown>,
    code: CredentialErrorCode,
): Promise<CredentialError> {
    try {
        await action()
    } catch (error: unknown) {
        expect(error).toBeInstanceOf(CredentialError)
        if (!(error instanceof CredentialError)) {
            throw error
        }
        const expected = new CredentialError(code)
        expect(error.code).toBe(code)
        expect(error.name).toBe(expected.name)
        expect(error.message).toBe(expected.message)
        expect(String(error)).toBe(String(expected))
        expect(Object.hasOwn(error, "cause")).toBe(false)
        expect(error.cause).toBeUndefined()
        expect(error.stack).not.toContain(SECRET)
        expect(JSON.stringify(error)).not.toContain(SECRET)
        return error
    }
    throw new Error(`Expected CredentialError(${code}).`)
}

async function expectNativeFailure(
    native: CredentialProvider,
    code: CredentialErrorCode,
    kind: CredentialKind = "ssh",
): Promise<CredentialError> {
    const plaintext = providerReturning({ status: "found", profile: profiles[kind] })
    const onSource = mock((_source: CredentialSource): void => {})
    const warn = mock((_message: string): void => {})
    const resolver = createCredentialResolver({
        providers: { "windows-credential-manager": native, plaintext },
        onSource,
        warn,
    })

    const error = await expectCredentialError((): Promise<unknown> => resolver.resolve(kind, PROFILE_ID), code)
    expect(native.read).toHaveBeenCalledTimes(1)
    expect(native.read).toHaveBeenCalledWith(kind, NORMALIZED_ID)
    expect(plaintext.read).not.toHaveBeenCalled()
    expect(onSource).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    return error
}

describe("credential resolver on Windows", (): void => {
    beforeAll((): void => {
        expect(process.platform).toBe("win32")
    })

    describe("whole-profile selection", (): void => {
        const policies: (CredentialProviderPolicy | undefined)[] = [undefined, "auto"]
        for (const policy of policies) {
            test(`${policy ?? "default"} selects native before plaintext`, async (): Promise<void> => {
                const profile = { host: "native.example.test", username: "native-user", password: SECRET }
                const native = providerReturning({ status: "found", profile })
                const plaintext = providerReturning({ status: "found", profile: profiles.ssh })
                const onSource = mock((_source: CredentialSource): void => {})
                const warn = mock((_message: string): void => {})
                const resolver = createCredentialResolver({
                    providers: { "windows-credential-manager": native, plaintext },
                    provider: policy,
                    onSource,
                    warn,
                })

                expect(await resolver.resolve("ssh", PROFILE_ID)).toEqual({
                    kind: "ssh", provider: "windows-credential-manager", profile,
                })
                expect(native.read).toHaveBeenCalledTimes(1)
                expect(native.read).toHaveBeenCalledWith("ssh", NORMALIZED_ID)
                expect(plaintext.read).not.toHaveBeenCalled()
                expect(onSource).toHaveBeenCalledTimes(1)
                expect(onSource).toHaveBeenCalledWith({ kind: "ssh", provider: "windows-credential-manager" })
                expect(warn).not.toHaveBeenCalled()
            })
        }

        for (const kind of kinds) {
            for (const status of softStatuses) {
                test(`${kind} falls back after returned ${status}`, async (): Promise<void> => {
                    const native = providerReturning({ status })
                    const plaintext = providerReturning({ status: "found", profile: profiles[kind] })
                    const onSource = mock((_source: CredentialSource): void => {})
                    const warn = mock((_message: string): void => {})
                    const resolver = createCredentialResolver({
                        providers: { "windows-credential-manager": native, plaintext }, onSource, warn,
                    })

                    expect(await resolver.resolve(kind, PROFILE_ID)).toEqual({
                        kind, provider: "plaintext", profile: profiles[kind],
                    })
                    expect(native.read).toHaveBeenCalledTimes(1)
                    expect(native.read).toHaveBeenCalledWith(kind, NORMALIZED_ID)
                    expect(plaintext.read).toHaveBeenCalledTimes(1)
                    expect(plaintext.read).toHaveBeenCalledWith(kind, NORMALIZED_ID)
                    expect(onSource).toHaveBeenCalledTimes(1)
                    expect(onSource).toHaveBeenCalledWith({ kind, provider: "plaintext" })
                    expect(warn).toHaveBeenCalledTimes(1)
                    expect(warn).toHaveBeenCalledWith(PLAINTEXT_CREDENTIAL_WARNING)
                })
            }
        }

        const incompleteProfiles: { kind: CredentialKind; name: string; profile: unknown }[] = [
            { kind: "ssh", name: "empty fields", profile: {} },
            { kind: "ssh", name: "blank host", profile: { host: " \t\n", username: "native-user" } },
            { kind: "ssh", name: "optional fields only", profile: { username: "native-user", password: SECRET, keypass: SECRET } },
            { kind: "db", name: "empty fields", profile: {} },
            { kind: "db", name: "blank connection", profile: { connection: " \t\n", username: "native-user" } },
            { kind: "db", name: "optional fields only", profile: { username: "native-user", password: SECRET } },
            { kind: "rest", name: "empty fields", profile: {} },
            { kind: "rest", name: "username only", profile: { username: "native-user" } },
            { kind: "rest", name: "password only", profile: { password: SECRET } },
        ]
        for (const { kind, name, profile } of incompleteProfiles) {
            test(`${kind} found with ${name} falls back without merging`, async (): Promise<void> => {
                const original = JSON.stringify(profile)
                const native = providerReturning({ status: "found", profile })
                const plaintext = providerReturning({ status: "found", profile: profiles[kind] })
                const warn = mock((_message: string): void => {})
                const resolver = createCredentialResolver({
                    providers: { "windows-credential-manager": native, plaintext }, warn,
                })

                const result = await resolver.resolve(kind, PROFILE_ID)
                expect(result).toEqual({ kind, provider: "plaintext", profile: profiles[kind] })
                expect(result.profile).not.toBe(profiles[kind])
                expect(JSON.stringify(profile)).toBe(original)
                expect(native.read).toHaveBeenCalledTimes(1)
                expect(native.read).toHaveBeenCalledWith(kind, NORMALIZED_ID)
                expect(plaintext.read).toHaveBeenCalledTimes(1)
                expect(plaintext.read).toHaveBeenCalledWith(kind, NORMALIZED_ID)
                expect(warn).toHaveBeenCalledTimes(1)
                expect(warn).toHaveBeenCalledWith(PLAINTEXT_CREDENTIAL_WARNING)
            })
        }

        test("complementary REST basic-auth fragments never combine", async (): Promise<void> => {
            const native = providerReturning({ status: "found", profile: { username: "native-user" } })
            const plaintext = providerReturning({ status: "found", profile: { password: SECRET } })
            const onSource = mock((_source: CredentialSource): void => {})
            const warn = mock((_message: string): void => {})
            const resolver = createCredentialResolver({
                providers: { "windows-credential-manager": native, plaintext }, onSource, warn,
            })

            await expectCredentialError((): Promise<unknown> => resolver.resolve("rest", PROFILE_ID), "incomplete")
            expect(native.read).toHaveBeenCalledTimes(1)
            expect(plaintext.read).toHaveBeenCalledTimes(1)
            expect(onSource).not.toHaveBeenCalled()
            expect(warn).not.toHaveBeenCalled()
        })

        test("absent native provider falls back to supplied plaintext only", async (): Promise<void> => {
            const plaintext = providerReturning({ status: "found", profile: profiles.db })
            const warn = mock((_message: string): void => {})
            const resolver = createCredentialResolver({ providers: { plaintext }, warn })

            expect(await resolver.resolve("db", PROFILE_ID)).toEqual({
                kind: "db", provider: "plaintext", profile: profiles.db,
            })
            expect(plaintext.read).toHaveBeenCalledTimes(1)
            expect(plaintext.read).toHaveBeenCalledWith("db", NORMALIZED_ID)
            expect(warn).toHaveBeenCalledWith(PLAINTEXT_CREDENTIAL_WARNING)
        })
    })

    describe("ID and policy validation before reads", (): void => {
        const normalizedCases: { kind: CredentialKind; id: string; expected: string }[] = [
            { kind: "ssh", id: " \tqa--web-east_2\r\n", expected: "QA__WEB_EAST_2" },
            { kind: "db", id: " \tqa_web_2\r\n", expected: "QA_WEB_2" },
            { kind: "rest", id: " \tqa_web_2\r\n", expected: "QA_WEB_2" },
        ]
        for (const { kind, id, expected } of normalizedCases) {
            test(`${kind} sends the same normalized ID to both providers`, async (): Promise<void> => {
                const native = providerReturning({ status: "missing" })
                const plaintext = providerReturning({ status: "found", profile: profiles[kind] })
                const warn = mock((_message: string): void => {})
                const resolver = createCredentialResolver({
                    providers: { "windows-credential-manager": native, plaintext }, warn,
                })

                await resolver.resolve(kind, id)
                expect(native.read).toHaveBeenCalledTimes(1)
                expect(native.read).toHaveBeenCalledWith(kind, expected)
                expect(plaintext.read).toHaveBeenCalledTimes(1)
                expect(plaintext.read).toHaveBeenCalledWith(kind, expected)
            })
        }

        const invalidIds: { name: string; id: unknown }[] = [
            { name: "empty", id: "" },
            { name: "whitespace", id: " \t\r\n" },
            { name: "internal space", id: "qa web" },
            { name: "slash", id: "qa/web" },
            { name: "dot", id: "qa.web" },
            { name: "NUL", id: "qa\u0000web" },
            { name: "non-ASCII", id: "caf\u00e9" },
            { name: "undefined", id: undefined },
            { name: "null", id: null },
            { name: "number", id: 17 },
            { name: "object", id: {} },
            { name: "array", id: [] },
        ]
        for (const kind of kinds) {
            for (const { name, id } of invalidIds) {
                test(`${kind} rejects ${name} ID without reads or notifications`, async (): Promise<void> => {
                    const native = providerReturning({ status: "found", profile: profiles[kind] })
                    const plaintext = providerReturning({ status: "found", profile: profiles[kind] })
                    const onSource = mock((_source: CredentialSource): void => {})
                    const warn = mock((_message: string): void => {})
                    const resolver = createCredentialResolver({
                        providers: { "windows-credential-manager": native, plaintext }, onSource, warn,
                    })

                    await expectCredentialError((): Promise<unknown> => resolver.resolve(kind, id as string), "invalid")
                    expect(native.read).not.toHaveBeenCalled()
                    expect(plaintext.read).not.toHaveBeenCalled()
                    expect(onSource).not.toHaveBeenCalled()
                    expect(warn).not.toHaveBeenCalled()
                })
            }
        }

        const strictKinds: CredentialKind[] = ["db", "rest"]
        for (const kind of strictKinds) {
            test(`${kind} rejects hyphenated IDs before reads`, async (): Promise<void> => {
                const native = providerReturning({ status: "missing" })
                const plaintext = providerReturning({ status: "found", profile: profiles[kind] })
                const resolver = createCredentialResolver({ providers: { "windows-credential-manager": native, plaintext } })

                await expectCredentialError((): Promise<unknown> => resolver.resolve(kind, "qa-web"), "invalid")
                expect(native.read).not.toHaveBeenCalled()
                expect(plaintext.read).not.toHaveBeenCalled()
            })
        }

        const invalidKinds: unknown[] = ["ftp", "SSH", "", undefined, null, 17]
        for (const kind of invalidKinds) {
            test(`rejects invalid kind ${String(kind)} before reads`, async (): Promise<void> => {
                const native = providerReturning({ status: "missing" })
                const plaintext = providerReturning({ status: "found", profile: profiles.ssh })
                const resolver = createCredentialResolver({ providers: { "windows-credential-manager": native, plaintext } })

                await expectCredentialError(
                    (): Promise<unknown> => resolver.resolve(kind as CredentialKind, PROFILE_ID), "invalid",
                )
                expect(native.read).not.toHaveBeenCalled()
                expect(plaintext.read).not.toHaveBeenCalled()
            })
        }

        const invalidPolicies: unknown[] = ["", "native", null]
        for (const policy of invalidPolicies) {
            test(`rejects invalid provider policy ${String(policy)} before reads`, async (): Promise<void> => {
                const native = providerReturning({ status: "missing" })
                const plaintext = providerReturning({ status: "found", profile: profiles.ssh })
                const resolver = createCredentialResolver({
                    providers: { "windows-credential-manager": native, plaintext },
                    provider: policy as CredentialProviderPolicy,
                })

                await expectCredentialError((): Promise<unknown> => resolver.resolve("ssh", PROFILE_ID), "invalid")
                expect(native.read).not.toHaveBeenCalled()
                expect(plaintext.read).not.toHaveBeenCalled()
            })
        }
    })

    describe("pinned provider policies", (): void => {
        for (const provider of providerNames) {
            for (const kind of kinds) {
                test(`${provider} success for ${kind} reads only the selected backend`, async (): Promise<void> => {
                    const native = providerReturning({ status: "found", profile: profiles[kind] })
                    const plaintext = providerReturning({ status: "found", profile: profiles[kind] })
                    const onSource = mock((_source: CredentialSource): void => {})
                    const warn = mock((_message: string): void => {})
                    const providers = { "windows-credential-manager": native, plaintext }
                    const other = provider === "plaintext" ? native : plaintext
                    const resolver = createCredentialResolver({ providers, provider, onSource, warn })

                    expect(await resolver.resolve(kind, PROFILE_ID)).toEqual({ kind, provider, profile: profiles[kind] })
                    expect(providers[provider].read).toHaveBeenCalledTimes(1)
                    expect(providers[provider].read).toHaveBeenCalledWith(kind, NORMALIZED_ID)
                    expect(other.read).not.toHaveBeenCalled()
                    expect(onSource).toHaveBeenCalledTimes(1)
                    expect(onSource).toHaveBeenCalledWith({ kind, provider })
                    expect(warn).toHaveBeenCalledTimes(provider === "plaintext" ? 1 : 0)
                    if (provider === "plaintext") {
                        expect(warn).toHaveBeenCalledWith(PLAINTEXT_CREDENTIAL_WARNING)
                    }
                })

                test(`${provider} found-incomplete ${kind} cannot fall back`, async (): Promise<void> => {
                    const selected = providerReturning({ status: "found", profile: {} })
                    const other = providerReturning({ status: "found", profile: profiles[kind] })
                    const onSource = mock((_source: CredentialSource): void => {})
                    const warn = mock((_message: string): void => {})
                    const resolver = createCredentialResolver({
                        providers: {
                            "windows-credential-manager": provider === "plaintext" ? other : selected,
                            plaintext: provider === "plaintext" ? selected : other,
                        },
                        provider, onSource, warn,
                    })

                    await expectCredentialError((): Promise<unknown> => resolver.resolve(kind, PROFILE_ID), "incomplete")
                    expect(selected.read).toHaveBeenCalledTimes(1)
                    expect(selected.read).toHaveBeenCalledWith(kind, NORMALIZED_ID)
                    expect(other.read).not.toHaveBeenCalled()
                    expect(onSource).not.toHaveBeenCalled()
                    expect(warn).not.toHaveBeenCalled()
                })
            }

            for (const status of softStatuses) {
                test(`${provider} returned ${status} throws the corresponding fixed error`, async (): Promise<void> => {
                    const selected = providerReturning({ status })
                    const other = providerReturning({ status: "found", profile: profiles.ssh })
                    const onSource = mock((_source: CredentialSource): void => {})
                    const warn = mock((_message: string): void => {})
                    const resolver = createCredentialResolver({
                        providers: {
                            "windows-credential-manager": provider === "plaintext" ? other : selected,
                            plaintext: provider === "plaintext" ? selected : other,
                        },
                        provider, onSource, warn,
                    })

                    await expectCredentialError((): Promise<unknown> => resolver.resolve("ssh", PROFILE_ID), status)
                    expect(selected.read).toHaveBeenCalledTimes(1)
                    expect(selected.read).toHaveBeenCalledWith("ssh", NORMALIZED_ID)
                    expect(other.read).not.toHaveBeenCalled()
                    expect(onSource).not.toHaveBeenCalled()
                    expect(warn).not.toHaveBeenCalled()
                })
            }

            test(`absent pinned ${provider} is unavailable without reading another backend`, async (): Promise<void> => {
                const other = providerReturning({ status: "found", profile: profiles.ssh })
                const warn = mock((_message: string): void => {})
                const onSource = mock((_source: CredentialSource): void => {})
                const resolver = createCredentialResolver({
                    providers: provider === "plaintext" ? { "windows-credential-manager": other } : { plaintext: other },
                    provider, onSource, warn,
                })

                await expectCredentialError((): Promise<unknown> => resolver.resolve("ssh", PROFILE_ID), "unavailable")
                expect(other.read).not.toHaveBeenCalled()
                expect(onSource).not.toHaveBeenCalled()
                expect(warn).not.toHaveBeenCalled()
            })
        }

        test("forced Linux policy is actionable unsupported on the actual Windows host", async (): Promise<void> => {
            expect(process.platform).toBe("win32")
            const native = providerReturning({ status: "found", profile: profiles.ssh })
            const plaintext = providerReturning({ status: "found", profile: profiles.ssh })
            const onSource = mock((_source: CredentialSource): void => {})
            const warn = mock((_message: string): void => {})
            const resolver = createCredentialResolver({
                providers: { "windows-credential-manager": native, plaintext },
                provider: "linux-secret-service",
                platform: process.platform,
                onSource,
                warn,
            })

            const error = await expectCredentialError((): Promise<unknown> => resolver.resolve("ssh", PROFILE_ID), "unsupported")
            expect(error.message).toBe("Credential provider is unsupported on this platform; select a compatible credentials.provider in global autocode.jsonc.")
            expect(native.read).not.toHaveBeenCalled()
            expect(plaintext.read).not.toHaveBeenCalled()
            expect(onSource).not.toHaveBeenCalled()
            expect(warn).not.toHaveBeenCalled()
        })
    })

    describe("hard provider errors never downgrade", (): void => {
        const codes: CredentialErrorCode[] = [
            "locked", "denied", "invalid", "too_large", "failed", "missing", "incomplete", "unavailable", "unsupported",
        ]
        for (const code of codes) {
            test(`thrown ${code} is reconstructed without secret message or cause`, async (): Promise<void> => {
                const injected = new CredentialError(code)
                injected.message = SECRET
                Object.defineProperty(injected, "cause", { value: { password: SECRET }, enumerable: true })

                const error = await expectNativeFailure(providerThrowing(injected), code)
                expect(error).not.toBe(injected)
            })
        }

        describe("unsafe_location hard stops", (): void => {
            const location = "C:\\resolver-private-path-canary\\credentials\\profiles.json"
            const causeMarker = "resolver-unsafe-location-cause-canary"
            const cases: {
                name: string
                policy: CredentialProviderPolicy
                provider: Exclude<CredentialProviderName, "linux-secret-service">
            }[] = [
                { name: "auto native failure stops before plaintext", policy: "auto", provider: "windows-credential-manager" },
                { name: "auto plaintext failure stops after native miss", policy: "auto", provider: "plaintext" },
                { name: "pinned native failure cannot downgrade", policy: "windows-credential-manager", provider: "windows-credential-manager" },
                { name: "pinned plaintext failure cannot fall back", policy: "plaintext", provider: "plaintext" },
            ]
            for (const { name, policy, provider } of cases) {
                test(name, async (): Promise<void> => {
                    const injected = new CredentialError("unsafe_location")
                    injected.message = `${SECRET} ${PROFILE_ID} ${NORMALIZED_ID} ${location}`
                    injected.stack = `CredentialError: ${injected.message}`
                    Object.defineProperty(injected, "cause", { value: new Error(causeMarker), enumerable: true })
                    const selected = providerThrowing(injected)
                    const precedingMiss = policy === "auto" && provider === "plaintext"
                    const other = providerReturning(precedingMiss ? { status: "missing" } : { status: "found", profile: profiles.ssh })
                    const onSource = mock((_source: CredentialSource): void => {})
                    const warn = mock((_message: string): void => {})
                    const resolver = createCredentialResolver({
                        providers: {
                            "windows-credential-manager": provider === "plaintext" ? other : selected,
                            plaintext: provider === "plaintext" ? selected : other,
                        },
                        provider: policy, onSource, warn,
                    })

                    const error = await expectCredentialError((): Promise<unknown> => resolver.resolve("ssh", PROFILE_ID), "unsafe_location")
                    expect(error).not.toBe(injected)
                    expect(error.message).toBe("Plaintext credential storage must use a private global configuration directory outside workspaces and Git repositories. Set OPENCODE_CONFIG_DIR to a private user directory.")
                    for (const surface of [String(error), error.stack ?? "", JSON.stringify(error)]) {
                        for (const marker of [SECRET, PROFILE_ID, NORMALIZED_ID, location, causeMarker]) {
                            expect(surface).not.toContain(marker)
                        }
                    }
                    expect(selected.read).toHaveBeenCalledTimes(1)
                    expect(selected.read).toHaveBeenCalledWith("ssh", NORMALIZED_ID)
                    expect(other.read).toHaveBeenCalledTimes(precedingMiss ? 1 : 0)
                    if (precedingMiss) {
                        expect(other.read).toHaveBeenCalledWith("ssh", NORMALIZED_ID)
                    }
                    expect(onSource).not.toHaveBeenCalled()
                    expect(warn).not.toHaveBeenCalled()
                }, 60_000)
            }
        })

        const ordinaryErrors: { name: string; error: unknown }[] = [
            { name: "ordinary Error", error: new Error(SECRET) },
            { name: "TypeError", error: new TypeError(SECRET) },
            { name: "string", error: SECRET },
            { name: "undefined", error: undefined },
            { name: "null", error: null },
            { name: "code-shaped object", error: { code: "unavailable", message: SECRET, cause: SECRET } },
        ]
        for (const { name, error } of ordinaryErrors) {
            test(`unknown thrown ${name} becomes fixed failed, not fallback`, async (): Promise<void> => {
                await expectNativeFailure(providerThrowing(error), "failed")
            })
        }

        const invalidCodes: unknown[] = ["unknown", undefined, null, {}]
        for (const code of invalidCodes) {
            test(`tampered CredentialError code ${String(code)} becomes fixed failed`, async (): Promise<void> => {
                const injected = new CredentialError("missing")
                injected.message = SECRET
                Object.defineProperty(injected, "code", { value: code })

                await expectNativeFailure(providerThrowing(injected), "failed")
            })
        }

        test("CredentialError code accessor is not invoked", async (): Promise<void> => {
            const getCode = mock((): string => { throw new Error(SECRET) })
            const injected = new CredentialError("missing")
            Object.defineProperty(injected, "code", { get: getCode })

            await expectNativeFailure(providerThrowing(injected), "failed")
            expect(getCode).not.toHaveBeenCalled()
        })

        test("plaintext failure after a native miss has no retry or success notification", async (): Promise<void> => {
            const native = providerReturning({ status: "missing" })
            const plaintext = providerThrowing(new Error(SECRET))
            const onSource = mock((_source: CredentialSource): void => {})
            const warn = mock((_message: string): void => {})
            const resolver = createCredentialResolver({
                providers: { "windows-credential-manager": native, plaintext }, onSource, warn,
            })

            await expectCredentialError((): Promise<unknown> => resolver.resolve("ssh", PROFILE_ID), "failed")
            expect(native.read).toHaveBeenCalledTimes(1)
            expect(plaintext.read).toHaveBeenCalledTimes(1)
            expect(plaintext.read).toHaveBeenCalledWith("ssh", NORMALIZED_ID)
            expect(onSource).not.toHaveBeenCalled()
            expect(warn).not.toHaveBeenCalled()
        })
    })

    describe("untrusted provider result shapes", (): void => {
        const malformedResults: { name: string; result: unknown }[] = [
            { name: "undefined", result: undefined },
            { name: "null", result: null },
            { name: "boolean", result: false },
            { name: "number", result: 17 },
            { name: "string", result: "missing" },
            { name: "array", result: [] },
            { name: "absent status", result: {} },
            { name: "null status", result: { status: null } },
            { name: "numeric status", result: { status: 17 } },
            { name: "object status", result: { status: {} } },
            { name: "found without own profile", result: { status: "found" } },
            { name: "inherited status", result: Object.create({ status: "missing" }) },
            { name: "inherited profile", result: Object.assign(Object.create({ profile: profiles.ssh }), { status: "found" }) },
        ]
        for (const { name, result } of malformedResults) {
            test(`${name} is failed without fallback`, async (): Promise<void> => {
                await expectNativeFailure(providerReturning(result as CredentialReadResult), "failed")
            })
        }

        const hardStatuses: string[] = ["locked", "denied", "invalid", "too_large", "failed", "unsupported", "unknown"]
        for (const status of hardStatuses) {
            test(`returned hard/unknown status ${status} is malformed, not a soft miss`, async (): Promise<void> => {
                await expectNativeFailure(providerReturning({ status } as CredentialReadResult), "failed")
            })
        }

        const accessorStatuses: string[] = ["missing", "incomplete", "unavailable", "found"]
        for (const status of accessorStatuses) {
            test(`status accessor claiming ${status} is rejected without invocation`, async (): Promise<void> => {
                const getStatus = mock((): string => status)
                const result = Object.defineProperty({}, "status", { get: getStatus })

                await expectNativeFailure(providerReturning(result as CredentialReadResult), "failed")
                expect(getStatus).not.toHaveBeenCalled()
            })
        }

        test("found profile accessor is rejected without invocation", async (): Promise<void> => {
            const getProfile = mock((): unknown => { throw new Error(SECRET) })
            const result = Object.defineProperty({ status: "found" }, "profile", { get: getProfile })

            await expectNativeFailure(providerReturning(result as CredentialReadResult), "failed")
            expect(getProfile).not.toHaveBeenCalled()
        })

        test("throwing result reflection becomes fixed failed", async (): Promise<void> => {
            const result = new Proxy({}, {
                getOwnPropertyDescriptor(): PropertyDescriptor | undefined { throw new Error(SECRET) },
            })

            await expectNativeFailure(providerReturning(result as CredentialReadResult), "failed")
        })
    })

    describe("central whole-profile validation", (): void => {
        const completeProfiles: { kind: CredentialKind; name: string; profile: CredentialProfileMap[CredentialKind] }[] = [
            {
                kind: "ssh", name: "all SSH fields",
                profile: {
                    host: " native.example.test ", username: "user", port: "22", keyfile: "C:\\keys\\test-key",
                    agent: "pageant", password: SECRET, keypass: SECRET,
                },
            },
            { kind: "db", name: "all DB fields", profile: { connection: " Server=example.test ", username: "", password: SECRET } },
            { kind: "rest", name: "authorization", profile: { authorization: `Bearer ${SECRET}` } },
            { kind: "rest", name: "empty authorization", profile: { authorization: "" } },
            { kind: "rest", name: "basic auth", profile: { username: "test-user", password: SECRET } },
            { kind: "rest", name: "empty basic-auth values", profile: { username: "", password: "" } },
            { kind: "rest", name: "authorization and basic auth", profile: { authorization: "", username: "test-user", password: SECRET } },
        ]
        for (const { kind, name, profile } of completeProfiles) {
            test(`accepts ${name} without trimming or rewriting fields`, async (): Promise<void> => {
                const native = providerReturning({ status: "found", profile })
                const plaintext = providerReturning({ status: "found", profile: profiles[kind] })
                const warn = mock((_message: string): void => {})
                const resolver = createCredentialResolver({
                    providers: { "windows-credential-manager": native, plaintext }, warn,
                })

                const result = await resolver.resolve(kind, PROFILE_ID)
                expect(result).toEqual({ kind, provider: "windows-credential-manager", profile })
                expect(result.profile).not.toBe(profile)
                expect(native.read).toHaveBeenCalledWith(kind, NORMALIZED_ID)
                expect(plaintext.read).not.toHaveBeenCalled()
                expect(warn).not.toHaveBeenCalled()
            })
        }

        const malformedProfiles: { name: string; profile: unknown }[] = [
            { name: "undefined", profile: undefined },
            { name: "null", profile: null },
            { name: "array", profile: [] },
            { name: "string", profile: SECRET },
            { name: "number", profile: 17 },
            { name: "boolean", profile: false },
        ]
        for (const kind of kinds) {
            for (const { name, profile } of malformedProfiles) {
                test(`${kind} found ${name} profile is hard invalid`, async (): Promise<void> => {
                    await expectNativeFailure(providerReturning({ status: "found", profile }), "invalid", kind)
                })
            }
        }

        const invalidFields: { kind: CredentialKind; name: string; profile: unknown }[] = [
            { kind: "ssh", name: "numeric host", profile: { host: 17 } },
            { kind: "ssh", name: "numeric port", profile: { host: "example.test", port: 22 } },
            { kind: "ssh", name: "undefined password", profile: { host: "example.test", password: undefined } },
            { kind: "ssh", name: "unknown field", profile: { host: "example.test", token: SECRET } },
            { kind: "db", name: "null connection", profile: { connection: null } },
            { kind: "db", name: "object password", profile: { connection: "Server=example.test", password: { value: SECRET } } },
            { kind: "db", name: "unknown field", profile: { connection: "Server=example.test", host: SECRET } },
            { kind: "rest", name: "undefined authorization", profile: { authorization: undefined } },
            { kind: "rest", name: "numeric password", profile: { username: "user", password: 17 } },
            { kind: "rest", name: "unknown field", profile: { authorization: "", token: SECRET } },
        ]
        for (const { kind, name, profile } of invalidFields) {
            test(`${kind} ${name} is hard invalid, never incomplete fallback`, async (): Promise<void> => {
                await expectNativeFailure(providerReturning({ status: "found", profile }), "invalid", kind)
            })
        }

        test("profile field accessor is rejected without invoking it", async (): Promise<void> => {
            const getHost = mock((): string => { throw new Error(SECRET) })
            const profile = Object.defineProperty({}, "host", { get: getHost, enumerable: true })

            await expectNativeFailure(providerReturning({ status: "found", profile }), "invalid")
            expect(getHost).not.toHaveBeenCalled()
        })

        test("inherited profile fields are invalid rather than used or downgraded", async (): Promise<void> => {
            const profile: unknown = Object.create({ host: "example.test", password: SECRET })
            await expectNativeFailure(providerReturning({ status: "found", profile }), "invalid")
        })

        test("symbol fields cannot smuggle secrets into an otherwise valid profile", async (): Promise<void> => {
            const profile = { host: "example.test", [Symbol("hidden")]: SECRET }
            await expectNativeFailure(providerReturning({ status: "found", profile }), "invalid")
        })

        test("throwing profile reflection is sanitized as invalid", async (): Promise<void> => {
            const profile = new Proxy({}, {
                ownKeys(): (string | symbol)[] { throw new Error(SECRET) },
            })
            await expectNativeFailure(providerReturning({ status: "found", profile }), "invalid")
        })

        for (const kind of kinds) {
            test(`${kind} frozen provider input is unchanged and each resolve returns a fresh profile`, async (): Promise<void> => {
                const profile = Object.freeze({ ...profiles[kind] })
                const native = providerReturning({ status: "found", profile })
                const warn = mock((_message: string): void => {})
                const resolver = createCredentialResolver({ providers: { "windows-credential-manager": native }, warn })

                const first = await resolver.resolve(kind, PROFILE_ID)
                expect(first.profile).toEqual(profile)
                expect(first.profile).not.toBe(profile)
                expect(Object.getPrototypeOf(first.profile)).toBeNull()
                const field = kind === "ssh" ? "host" : kind === "db" ? "connection" : "authorization"
                Reflect.set(first.profile, field, SECRET)
                const second = await resolver.resolve(kind, PROFILE_ID)
                expect(second).not.toBe(first)
                expect(second.profile).not.toBe(first.profile)
                expect(second.profile).not.toBe(profile)
                expect(second.profile).toEqual(profiles[kind])
                expect(profile).toEqual(profiles[kind])
                expect(Object.isFrozen(profile)).toBe(true)
                expect(native.read).toHaveBeenCalledTimes(2)
                expect(native.read).toHaveBeenNthCalledWith(1, kind, NORMALIZED_ID)
                expect(native.read).toHaveBeenNthCalledWith(2, kind, NORMALIZED_ID)
                expect(warn).not.toHaveBeenCalled()
            })
        }
    })

    describe("size limits belong to the correct layer", (): void => {
        for (const kind of kinds) {
            test(`${kind} oversized field is hard too_large without downgrade`, async (): Promise<void> => {
                const profile = { ...profiles[kind], password: "x".repeat(MAX_CREDENTIAL_FIELD_BYTES + 1) }
                await expectNativeFailure(providerReturning({ status: "found", profile }), "too_large", kind)
            })
        }

        test("UTF-8 byte size, not string length, limits central fields", async (): Promise<void> => {
            const password = "\u00e9".repeat(Math.floor(MAX_CREDENTIAL_FIELD_BYTES / 2) + 1)
            expect(password.length).toBeLessThan(MAX_CREDENTIAL_FIELD_BYTES)
            expect(Buffer.byteLength(password, "utf8")).toBeGreaterThan(MAX_CREDENTIAL_FIELD_BYTES)
            await expectNativeFailure(providerReturning({ status: "found", profile: { host: "example.test", password } }), "too_large")
        })

        test("central full envelope can exceed its cap even when each field fits", async (): Promise<void> => {
            const profile = {
                connection: "c".repeat(MAX_CREDENTIAL_ENVELOPE_BYTES / 2),
                password: "p".repeat(MAX_CREDENTIAL_ENVELOPE_BYTES / 2),
            }
            expect(Buffer.byteLength(profile.connection)).toBeLessThanOrEqual(MAX_CREDENTIAL_FIELD_BYTES)
            expect(Buffer.byteLength(profile.password)).toBeLessThanOrEqual(MAX_CREDENTIAL_FIELD_BYTES)
            expect(Buffer.byteLength(JSON.stringify({ version: 1, kind: "db", fields: profile }))).toBeGreaterThan(MAX_CREDENTIAL_ENVELOPE_BYTES)

            await expectNativeFailure(providerReturning({ status: "found", profile }), "too_large", "db")
        })

        test("native full-envelope overflow is a provider error, never plaintext fallback", async (): Promise<void> => {
            const profile = {
                connection: "c".repeat(WINDOWS_CREDENTIAL_MAX_BYTES / 2),
                password: "p".repeat(WINDOWS_CREDENTIAL_MAX_BYTES / 2),
            }
            expect(Buffer.byteLength(profile.connection)).toBeLessThanOrEqual(WINDOWS_CREDENTIAL_MAX_BYTES)
            expect(Buffer.byteLength(profile.password)).toBeLessThanOrEqual(WINDOWS_CREDENTIAL_MAX_BYTES)
            expect(Buffer.byteLength(JSON.stringify({ version: 1, kind: "db", fields: profile }))).toBeGreaterThan(WINDOWS_CREDENTIAL_MAX_BYTES)

            await expectNativeFailure(providerThrowing(new CredentialError("too_large")), "too_large", "db")
        })

        for (const provider of providerNames) {
            test(`${provider} centrally valid fields may exceed the native cap`, async (): Promise<void> => {
                const profile = { connection: "Server=example.test", password: "x".repeat(WINDOWS_CREDENTIAL_MAX_BYTES + 1) }
                const selected = providerReturning({ status: "found", profile })
                const warn = mock((_message: string): void => {})
                const resolver = createCredentialResolver({ providers: { [provider]: selected }, provider, warn })

                expect(Buffer.byteLength(profile.password)).toBeGreaterThan(WINDOWS_CREDENTIAL_MAX_BYTES)
                expect(Buffer.byteLength(JSON.stringify({ version: 1, kind: "db", fields: profile }))).toBeLessThan(MAX_CREDENTIAL_ENVELOPE_BYTES)
                expect(await resolver.resolve("db", PROFILE_ID)).toEqual({ kind: "db", provider, profile })
                expect(selected.read).toHaveBeenCalledTimes(1)
                expect(selected.read).toHaveBeenCalledWith("db", NORMALIZED_ID)
                expect(warn).toHaveBeenCalledTimes(provider === "plaintext" ? 1 : 0)
            })
        }
    })

    describe("exhaustion precedence", (): void => {
        for (const nativeStatus of softStatuses) {
            for (const plaintextStatus of softStatuses) {
                test(`${nativeStatus} then ${plaintextStatus} uses incomplete > missing > unavailable`, async (): Promise<void> => {
                    const native = providerReturning({ status: nativeStatus })
                    const plaintext = providerReturning({ status: plaintextStatus })
                    const onSource = mock((_source: CredentialSource): void => {})
                    const warn = mock((_message: string): void => {})
                    const resolver = createCredentialResolver({
                        providers: { "windows-credential-manager": native, plaintext }, onSource, warn,
                    })
                    const code = nativeStatus === "incomplete" || plaintextStatus === "incomplete"
                        ? "incomplete"
                        : nativeStatus === "missing" || plaintextStatus === "missing" ? "missing" : "unavailable"

                    await expectCredentialError((): Promise<unknown> => resolver.resolve("ssh", PROFILE_ID), code)
                    expect(native.read).toHaveBeenCalledTimes(1)
                    expect(native.read).toHaveBeenCalledWith("ssh", NORMALIZED_ID)
                    expect(plaintext.read).toHaveBeenCalledTimes(1)
                    expect(plaintext.read).toHaveBeenCalledWith("ssh", NORMALIZED_ID)
                    expect(onSource).not.toHaveBeenCalled()
                    expect(warn).not.toHaveBeenCalled()
                })
            }
        }

        for (const provider of providerNames) {
            for (const status of softStatuses) {
                test(`${provider} found-incomplete outranks other provider ${status}`, async (): Promise<void> => {
                    const incomplete = providerReturning({ status: "found", profile: { username: SECRET } })
                    const other = providerReturning({ status })
                    const onSource = mock((_source: CredentialSource): void => {})
                    const warn = mock((_message: string): void => {})
                    const resolver = createCredentialResolver({
                        providers: {
                            "windows-credential-manager": provider === "plaintext" ? other : incomplete,
                            plaintext: provider === "plaintext" ? incomplete : other,
                        },
                        onSource, warn,
                    })

                    await expectCredentialError((): Promise<unknown> => resolver.resolve("ssh", PROFILE_ID), "incomplete")
                    expect(incomplete.read).toHaveBeenCalledTimes(1)
                    expect(other.read).toHaveBeenCalledTimes(1)
                    expect(onSource).not.toHaveBeenCalled()
                    expect(warn).not.toHaveBeenCalled()
                })
            }
        }

        test("no supplied providers is fixed unavailable without notifications", async (): Promise<void> => {
            const onSource = mock((_source: CredentialSource): void => {})
            const warn = mock((_message: string): void => {})
            const resolver = createCredentialResolver({ providers: {}, onSource, warn })

            await expectCredentialError((): Promise<unknown> => resolver.resolve("ssh", PROFILE_ID), "unavailable")
            expect(onSource).not.toHaveBeenCalled()
            expect(warn).not.toHaveBeenCalled()
        })
    })

    describe("success callbacks and warning isolation", (): void => {
        for (const provider of providerNames) {
            for (const kind of kinds) {
                test(`${provider} ${kind} source contains only frozen kind/provider metadata`, async (): Promise<void> => {
                    const sourceCalls: CredentialSource[] = []
                    const onSource = mock((source: CredentialSource): void => { sourceCalls.push(source) })
                    const warn = mock((_message: string): void => {})
                    const selected = providerReturning({ status: "found", profile: profiles[kind] })
                    const resolver = createCredentialResolver({ providers: { [provider]: selected }, provider, onSource, warn })

                    const result = await resolver.resolve(kind, PROFILE_ID)
                    expect(result.profile).toEqual(profiles[kind])
                    expect(onSource).toHaveBeenCalledTimes(1)
                    expect(sourceCalls).toEqual([{ kind, provider }])
                    expect(Reflect.ownKeys(sourceCalls[0])).toEqual(["kind", "provider"])
                    expect(Object.isFrozen(sourceCalls[0])).toBe(true)
                    expect(JSON.stringify(sourceCalls)).not.toContain(NORMALIZED_ID)
                    expect(JSON.stringify(sourceCalls)).not.toContain(SECRET)
                    expect(warn).toHaveBeenCalledTimes(provider === "plaintext" ? 1 : 0)
                    if (provider === "plaintext") {
                        expect(warn).toHaveBeenCalledWith(PLAINTEXT_CREDENTIAL_WARNING)
                    }
                })
            }
        }

        const callbackFailures = [
            { name: "source throws", sourceThrows: true, warnThrows: false },
            { name: "warning throws", sourceThrows: false, warnThrows: true },
            { name: "both throw", sourceThrows: true, warnThrows: true },
        ]
        for (const { name, sourceThrows, warnThrows } of callbackFailures) {
            test(`plaintext ${name}: both callbacks attempted once without retry or leaks`, async (): Promise<void> => {
                const native = providerReturning({ status: "missing" })
                const plaintext = providerReturning({ status: "found", profile: profiles.rest })
                const sourceCalls: CredentialSource[] = []
                const warnings: string[] = []
                const onSource = mock((source: CredentialSource): void => {
                    sourceCalls.push(source)
                    if (sourceThrows) throw new Error(SECRET)
                })
                const warn = mock((message: string): void => {
                    warnings.push(message)
                    if (warnThrows) throw new Error(SECRET)
                })
                const resolver = createCredentialResolver({
                    providers: { "windows-credential-manager": native, plaintext }, onSource, warn,
                })

                expect(await resolver.resolve("rest", PROFILE_ID)).toEqual({
                    kind: "rest", provider: "plaintext", profile: profiles.rest,
                })
                expect(native.read).toHaveBeenCalledTimes(1)
                expect(plaintext.read).toHaveBeenCalledTimes(1)
                expect(native.read).toHaveBeenCalledWith("rest", NORMALIZED_ID)
                expect(plaintext.read).toHaveBeenCalledWith("rest", NORMALIZED_ID)
                expect(onSource).toHaveBeenCalledTimes(1)
                expect(warn).toHaveBeenCalledTimes(1)
                expect(sourceCalls).toEqual([{ kind: "rest", provider: "plaintext" }])
                expect(warnings).toEqual([PLAINTEXT_CREDENTIAL_WARNING])
                expect(JSON.stringify({ sourceCalls, warnings })).not.toContain(SECRET)
                expect(JSON.stringify({ sourceCalls, warnings })).not.toContain(NORMALIZED_ID)
            })
        }

        test("native source callback throwing cannot trigger plaintext fallback or warning", async (): Promise<void> => {
            const native = providerReturning({ status: "found", profile: profiles.ssh })
            const plaintext = providerReturning({ status: "found", profile: profiles.ssh })
            const onSource = mock((_source: CredentialSource): void => { throw new Error(SECRET) })
            const warn = mock((_message: string): void => { throw new Error(SECRET) })
            const resolver = createCredentialResolver({
                providers: { "windows-credential-manager": native, plaintext }, onSource, warn,
            })

            expect(await resolver.resolve("ssh", PROFILE_ID)).toEqual({
                kind: "ssh", provider: "windows-credential-manager", profile: profiles.ssh,
            })
            expect(native.read).toHaveBeenCalledTimes(1)
            expect(plaintext.read).not.toHaveBeenCalled()
            expect(onSource).toHaveBeenCalledTimes(1)
            expect(onSource).toHaveBeenCalledWith({ kind: "ssh", provider: "windows-credential-manager" })
            expect(warn).not.toHaveBeenCalled()
        })
    })
})
