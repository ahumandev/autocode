import { describe, expect, mock, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createCredentialResolver } from "./credentials/resolver"
import {
    CredentialError,
    type CredentialKind,
    type CredentialProvider,
    type CredentialReadResult,
    type CredentialResolver,
} from "./credentials/types"
import { runCredentialsCli } from "./credentials-cli"
import { createAutocodeCredentialsListTool } from "./tools/autocode_credentials_list"
import { createToolContext } from "./tools/test_context"

describe("credentials CLI listing", (): void => {
    test("matches tool formatting and incomplete-provider warnings", async (): Promise<void> => {
        const keyfile = fileURLToPath(import.meta.url)
        const profiles: Partial<Record<CredentialKind, Record<string, unknown>>> = {
            db: { DB_PROFILE: { connection: "jdbc:db-secret-42", username: "db-user" } },
            rest: { REST_PROFILE: { authorization: "Bearer rest-secret-99" } },
            ssh: {
                SSH_PROFILE: {
                    host: "private-host-metadata",
                    port: "2222",
                    keyfile,
                    agent: "private-agent-metadata",
                    username: "ssh-user",
                    keypass: "ssh-keypass-21",
                },
            },
        }
        const provider: CredentialProvider = {
            read: mock(async (kind: CredentialKind, id: string): Promise<CredentialReadResult> => {
                const kindProfiles = profiles[kind]
                if (kindProfiles !== undefined && Object.hasOwn(kindProfiles, id)) {
                    return { status: "found", profile: kindProfiles[id] }
                }
                return { status: "missing" }
            }),
            enumerate: mock(async (kind: CredentialKind): Promise<string[]> => {
                if (kind === "db") throw new CredentialError("too_large")
                return Object.keys(profiles[kind] ?? {})
            }),
        }
        const resolver = createCredentialResolver({
            providers: { plaintext: provider },
            provider: "plaintext",
            platform: "darwin",
            warn: (): void => {},
        })
        const toolOutput = await createAutocodeCredentialsListTool(resolver).execute({}, createToolContext()) as string
        let stdout = ""
        let stderr = ""

        const exitCode = await runCredentialsCli(["list"], {
            platform: "darwin",
            credentialResolver: resolver,
            stdout: { write(text: string): void { stdout += text } },
            stderr: { write(text: string): void { stderr += text } },
        })

        expect(exitCode).toBe(0)
        expect(stderr).toBe("")
        expect(stdout).toBe(`${toolOutput}\n`)
        expect(stdout).toContain("Provider coverage incomplete: plaintext")
        for (const hidden of ["db-secret-42", "rest-secret-99", "ssh-user", "ssh-keypass-21", keyfile, "private-host-metadata", "2222", "private-agent-metadata"]) {
            expect(stdout).not.toContain(hidden)
        }
    })

    test("reports the shared 128-candidate truncation warning", async (): Promise<void> => {
        const ids = Array.from({ length: 129 }, (_value: undefined, index: number): string => `PROFILE_${String(index).padStart(3, "0")}`)
        const provider: CredentialProvider = {
            read: mock(async (): Promise<CredentialReadResult> => ({ status: "found", profile: { connection: "Server=example" } })),
            enumerate: mock(async (kind: CredentialKind): Promise<string[]> => kind === "db" ? ids : []),
        }
        const resolver = createCredentialResolver({
            providers: { plaintext: provider },
            provider: "plaintext",
            platform: "darwin",
            warn: (): void => {},
        })
        let stdout = ""

        const exitCode = await runCredentialsCli(["list"], {
            platform: "darwin",
            credentialResolver: resolver,
            stdout: { write(text: string): void { stdout += text } },
            stderr: { write(): void {} },
        })

        expect(exitCode).toBe(0)
        expect(stdout.split("\n")).toHaveLength(130)
        expect(stdout).toContain("Credential listing incomplete: safety candidate limit reached.\n")
        expect(stdout).not.toContain("PROFILE_128")
    })

    test("does not print raw errors from a failing listing resolver", async (): Promise<void> => {
        const resolver: CredentialResolver = {
            resolve: async () => { throw new Error("private provider diagnostic") },
            enumerate: async () => { throw new Error("private provider diagnostic") },
        }
        const toolOutput = await createAutocodeCredentialsListTool(resolver).execute({}, createToolContext()) as string
        let stdout = ""
        let stderr = ""

        const exitCode = await runCredentialsCli(["list"], {
            credentialResolver: resolver,
            stdout: { write(text: string): void { stdout += text } },
            stderr: { write(text: string): void { stderr += text } },
        })

        expect(exitCode).toBe(1)
        expect(stdout).toBe("")
        expect(stderr).toBe(`${toolOutput}\n`)
        expect(stderr).not.toContain("private provider diagnostic")
    })
})
