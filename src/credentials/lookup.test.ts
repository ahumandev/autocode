import { describe, expect, mock, test } from "bun:test"
import { createCredentialResolver } from "./resolver"
import { listCredentialProfiles, normalizeCredentialId, resolveCredentialProfile } from "./lookup"
import {
    CredentialError,
    type CredentialKind,
    type CredentialProfile,
    type CredentialProvider,
    type CredentialReadResult,
    type CredentialResolver,
    type ResolvedCredentialProfile,
} from "./types"

describe("shared credential lookup", (): void => {
    test.each([
        ["ssh", " qa--web-east_2 ", "QA__WEB_EAST_2"],
        ["db", " reporting_db_2 ", "REPORTING_DB_2"],
        ["rest", " service_2 ", "SERVICE_2"],
    ] as const)("normalizes %s credential ID", (kind, id, expected): void => {
        expect(normalizeCredentialId(kind, id)).toBe(expected)
    })

    test("allows hyphens only for SSH IDs", (): void => {
        expect(normalizeCredentialId("ssh", "qa-web")).toBe("QA_WEB")
        expect((): string => normalizeCredentialId("db", "qa-web")).toThrow()
        expect((): string => normalizeCredentialId("rest", "qa-web")).toThrow()
    })

    test("keeps caller-supplied validation messages", (): void => {
        expect((): string => normalizeCredentialId("db", "bad key", {
            errorMessage: "Invalid database profile key.",
            label: "database profile key",
        })).toThrow("Invalid database profile key.")
    })

    test("delegates normalized profile lookup to the shared resolver", async (): Promise<void> => {
        const calls: Array<{ kind: CredentialKind; id: string }> = []
        const resolver: CredentialResolver = {
            async resolve<K extends CredentialKind>(kind: K, id: string): Promise<ResolvedCredentialProfile<K>> {
                calls.push({ kind, id })
                return {
                    kind,
                    provider: "plaintext",
                    profile: { connection: "postgres://db.example/reporting" } as unknown as CredentialProfile<K>,
                }
            },
        }

        const result = await resolveCredentialProfile("db", "REPORTING", resolver)

        expect(calls).toEqual([{ kind: "db", id: "REPORTING" }])
        expect(result).toEqual({
            kind: "db",
            provider: "plaintext",
            profile: { connection: "postgres://db.example/reporting" },
        })
    })
})

describe("credential profile listing", (): void => {
    test("lists valid profiles and skips invalid, incomplete, and unresolved profiles", async (): Promise<void> => {
        const reads = mock(async (kind: CredentialKind, id: string): Promise<CredentialReadResult> => {
            if (kind !== "db") return { status: "missing" }
            if (id === "GOOD") return { status: "found", profile: { connection: "postgres://db.example/good" } }
            if (id === "INVALID") return { status: "found", profile: { connection: "postgres://db.example/invalid", extra: "not allowed" } }
            if (id === "INCOMPLETE") return { status: "found", profile: {} }
            return { status: "missing" }
        })
        const enumerate = mock(async (kind: CredentialKind): Promise<string[]> => kind === "db"
            ? ["GOOD", "INVALID", "INCOMPLETE", "MISSING"]
            : [])
        const provider: CredentialProvider = { read: reads, enumerate }
        const resolver = createCredentialResolver({
            providers: { plaintext: provider },
            provider: "plaintext",
            platform: "darwin",
            warn: (): void => {},
        })

        const listing = await listCredentialProfiles(resolver)

        expect(listing.profiles).toEqual([{
            kind: "db",
            id: "GOOD",
            profile: { connection: "postgres://db.example/good" },
        }])
        expect(listing.unavailableProviders).toEqual([])
        expect(listing.truncated).toBe(false)
        expect(reads.mock.calls.map(([kind, id]) => [kind, id])).toEqual([
            ["db", "GOOD"],
            ["db", "INCOMPLETE"],
            ["db", "INVALID"],
            ["db", "MISSING"],
        ])
        expect(enumerate).toHaveBeenCalledTimes(3)
    })

    test("filters invalid and non-normalized discovered IDs before resolving", async (): Promise<void> => {
        const resolveCalls: Array<{ kind: CredentialKind; id: string }> = []
        const resolver: CredentialResolver = {
            async resolve<K extends CredentialKind>(kind: K, id: string): Promise<ResolvedCredentialProfile<K>> {
                resolveCalls.push({ kind, id })
                return {
                    kind,
                    provider: "plaintext",
                    profile: { authorization: "Bearer listed" } as unknown as CredentialProfile<K>,
                }
            },
            async enumerate(kind: CredentialKind) {
                return {
                    ids: kind === "rest" ? ["VALID", "lowercase", "bad/id"] : [],
                    unavailableProviders: [],
                }
            },
        }

        const listing = await listCredentialProfiles(resolver)

        expect(listing.profiles.map(({ kind, id }) => [kind, id])).toEqual([["rest", "VALID"]])
        expect(resolveCalls).toEqual([{ kind: "rest", id: "VALID" }])
    })

    test("requires resolver profile enumeration support", async (): Promise<void> => {
        const resolver: CredentialResolver = {
            async resolve<K extends CredentialKind>(kind: K, _id: string): Promise<ResolvedCredentialProfile<K>> {
                throw new CredentialError("missing")
            },
        }

        await expect(listCredentialProfiles(resolver)).rejects.toThrow("Credential resolver does not support profile enumeration.")
    })
})
