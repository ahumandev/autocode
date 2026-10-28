import { describe, expect, mock, test } from "bun:test"
import { createCredentialResolver } from "../credentials/resolver"
import {
    CredentialError,
    type CredentialKind,
    type CredentialProfile,
    type CredentialProvider,
    type CredentialProviderName,
    type CredentialReadResult,
} from "../credentials/types"
import { createAutocodeCredentialsListTool } from "./autocode_credentials_list"
import { createToolContext } from "./test_context"

function createProfileResolver(profiles: Record<CredentialKind, Record<string, unknown>>) {
    const provider: CredentialProvider = {
        read: mock(async (kind: CredentialKind, id: string): Promise<CredentialReadResult> => {
            if (!Object.hasOwn(profiles[kind], id)) return { status: "missing" }
            return { status: "found", profile: profiles[kind][id] }
        }),
        enumerate: mock(async (kind: CredentialKind): Promise<string[]> => Object.keys(profiles[kind])),
    }
    const resolver = createCredentialResolver({
        providers: { plaintext: provider },
        provider: "plaintext",
        platform: "darwin",
        warn: (): void => {},
    })
    return { provider, resolver }
}

describe("autocode_credentials_list", (): void => {
    test("masks empty, short, and long secrets while excluding profile metadata", async (): Promise<void> => {
        const { resolver } = createProfileResolver({
            db: {
                DB_PROFILE: {
                    connection: " jdbc:db-secret ",
                    username: " A ",
                    password: "db-password",
                },
            },
            rest: {
                EMPTY_AUTH: { authorization: "" },
                LONG_AUTH: { authorization: "long-secret" },
                SHORT_AUTH: { authorization: "A" },
            },
            ssh: {
                SSH_PROFILE: {
                    host: "private-host-metadata",
                    username: "U",
                    port: "22",
                    agent: "private-agent-metadata",
                    password: "ssh-password",
                    keypass: "private-keypass-metadata",
                },
            },
        })

        const result = await createAutocodeCredentialsListTool(resolver).execute({}, createToolContext()) as string

        expect(result).toBe([
            "AUTOCODE_DB_DB_PROFILE_CONNECTION=*et",
            "AUTOCODE_DB_DB_PROFILE_USERNAME=*",
            "AUTOCODE_DB_DB_PROFILE_PASSWORD=*rd",
            "AUTOCODE_REST_EMPTY_AUTH_AUTHORIZATION=*",
            "AUTOCODE_REST_LONG_AUTH_AUTHORIZATION=*et",
            "AUTOCODE_REST_SHORT_AUTH_AUTHORIZATION=*",
            "AUTOCODE_SSH_SSH_PROFILE_USERNAME=*",
            "AUTOCODE_SSH_SSH_PROFILE_PASSWORD=*rd",
        ].join("\n"))
        for (const secret of [
            "db-secret", "db-password", "long-secret", "ssh-password", "private-host-metadata",
            "private-agent-metadata", "private-keypass-metadata", "22",
        ]) {
            expect(result).not.toContain(secret)
        }
    })

    test.each([
        ["win32", "windows-credential-manager"],
        ["linux", "linux-secret-service"],
    ] as const)("reports %s provider enumeration overflow as incomplete coverage", async (platform, providerName): Promise<void> => {
        const overflowingProvider: CredentialProvider = {
            read: mock(async (): Promise<CredentialReadResult> => ({ status: "missing" })),
            enumerate: mock(async (): Promise<string[]> => { throw new CredentialError("too_large") }),
        }
        const plaintextProvider: CredentialProvider = {
            read: mock(async (): Promise<CredentialReadResult> => ({ status: "missing" })),
            enumerate: mock(async (): Promise<string[]> => []),
        }
        const providers: Partial<Record<CredentialProviderName, CredentialProvider>> = {
            [providerName]: overflowingProvider,
            plaintext: plaintextProvider,
        }
        const resolver = createCredentialResolver({ providers, platform, provider: "auto" })

        const result = await createAutocodeCredentialsListTool(resolver).execute({}, createToolContext()) as string

        expect(result).toBe(`Provider coverage incomplete: ${providerName}`)
        expect(overflowingProvider.enumerate).toHaveBeenCalledTimes(3)
    })

    test("reports the 128-candidate safety cap and stops resolving further profiles", async (): Promise<void> => {
        const ids = Array.from({ length: 129 }, (_value, index): string => `PROFILE_${String(index).padStart(3, "0")}`)
        const { provider, resolver } = createProfileResolver({
            db: Object.fromEntries(ids.map((id): [string, CredentialProfile<"db">] => [id, { connection: "Server=example" }])),
            rest: {},
            ssh: {},
        })

        const result = await createAutocodeCredentialsListTool(resolver).execute({}, createToolContext()) as string
        const lines = result.split("\n")

        expect(provider.read).toHaveBeenCalledTimes(128)
        expect(provider.enumerate).toHaveBeenCalledTimes(1)
        expect(lines).toHaveLength(129)
        expect(lines[0]).toBe("AUTOCODE_DB_PROFILE_000_CONNECTION=*le")
        expect(lines.at(-1)).toBe("Credential listing incomplete: safety candidate limit reached.")
        expect(result).not.toContain("PROFILE_128")
    })
})
