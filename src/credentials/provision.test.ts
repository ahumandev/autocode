import { describe, expect, spyOn, test } from "bun:test"
import { Buffer } from "node:buffer"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type PlaintextCredentialOptions } from "./plaintext"
import { writePlaintextProfile } from "./provision"
import { CredentialError, MAX_CREDENTIAL_ENVELOPE_BYTES, MAX_CREDENTIAL_FIELD_BYTES, type CredentialErrorCode, type CredentialKind } from "./types"
import * as windowsFiles from "./windows-files"
import * as windowsProcess from "./windows-process"

const SECRET_CANARY = "synthetic-provision-secret-canary"
const ID_CANARY = "private-profile-id-canary"
const MINIMAL_PROFILES = {
    ssh: { host: "  replacement.example.test  " },
    db: { connection: "  jdbc:postgresql://localhost/synthetic  " },
    rest: { authorization: "" },
}

function sizedRestProfile(bytes: number): { authorization: string } {
    const fields = { authorization: "" }
    const overhead = Buffer.byteLength(JSON.stringify({ version: 1, kind: "rest", fields }), "utf8")
    const available = bytes - overhead
    fields.authorization = "é".repeat(Math.floor(available / 2)) + "x".repeat(available % 2)
    expect(Buffer.byteLength(JSON.stringify({ version: 1, kind: "rest", fields }), "utf8")).toBe(bytes)
    return fields
}

async function expectCredentialError(action: () => Promise<unknown>, code: CredentialErrorCode, root: string): Promise<void> {
    let failure: unknown
    try { await action() } catch (error: unknown) { failure = error }
    expect(failure instanceof CredentialError).toBe(true)
    if (!(failure instanceof CredentialError)) throw new Error("Expected sanitized provisioning failure.")
    expect(failure.code).toBe(code)
    expect(failure.message).toBe(new CredentialError(code).message)
    expect(failure.cause).toBeUndefined()
    expect(Object.hasOwn(failure, "cause")).toBe(false)
    expect(Object.hasOwn(failure, "nativeCode")).toBe(false)
    for (const canary of [SECRET_CANARY, ID_CANARY, root]) {
        expect(failure.message.includes(canary)).toBe(false)
        expect(JSON.stringify(failure).includes(canary)).toBe(false)
    }
}

describe("plaintext profile provisioning validation", (): void => {
    test("finishes ID, profile, envelope, and options validation before creating any paths", async (): Promise<void> => {
        const root = await mkdtemp(join(tmpdir(), "autocode-provision-"))
        const run = spyOn(windowsProcess, "runWindowsCredentialOperation").mockImplementation(async (): Promise<never> => {
            throw new Error("Unexpected Windows credential helper call.")
        })
        const read = spyOn(windowsFiles, "readSecureWindowsFile").mockImplementation(async (): Promise<never> => {
            throw new Error("Unexpected Windows credential file read.")
        })
        const write = spyOn(windowsFiles, "writeSecureWindowsFile").mockImplementation(async (): Promise<never> => {
            throw new Error("Unexpected Windows credential file write.")
        })
        try {
            const options: PlaintextCredentialOptions = { globalConfigRoot: join(root, "config"), expectedSid: "S-1-5-21-1" }
            const getterProfile = Object.defineProperty({}, "host", {
                enumerable: true, get(): never { throw new Error(`${SECRET_CANARY} ${root}`) },
            })
            let optionReads = 0
            const getterOptions = Object.defineProperty({}, "globalConfigRoot", {
                enumerable: true, get(): never { optionReads++; throw new Error(SECRET_CANARY) },
            })
            const invalidProfiles: unknown[] = [null, [], "host", { host: 22 }, { host: "valid", unexpected: SECRET_CANARY }, getterProfile]
            for (const profile of invalidProfiles) {
                await expectCredentialError((): Promise<void> => writePlaintextProfile("ssh", "VALID", profile, options), "invalid", root)
            }
            for (const [kind, profile] of [["ssh", { host: " \t" }], ["db", {}], ["rest", { username: "" }]] as const) {
                await expectCredentialError((): Promise<void> => writePlaintextProfile(kind, "VALID", profile, options), "incomplete", root)
            }
            for (const kind of ["db", "rest"] as const) {
                await expectCredentialError((): Promise<void> => writePlaintextProfile(kind, ID_CANARY, MINIMAL_PROFILES[kind], options), "invalid", root)
            }
            for (const id of ["", " \t", "../private", "has space", "private/id", "private\0id"]) {
                await expectCredentialError((): Promise<void> => writePlaintextProfile("ssh", id, MINIMAL_PROFILES.ssh, getterOptions), "invalid", root)
            }
            await expectCredentialError((): Promise<void> => writePlaintextProfile("other" as CredentialKind, "VALID", MINIMAL_PROFILES.ssh, options), "invalid", root)
            await expectCredentialError((): Promise<void> => writePlaintextProfile("rest", "VALID", sizedRestProfile(MAX_CREDENTIAL_ENVELOPE_BYTES + 1), getterOptions), "too_large", root)
            await expectCredentialError((): Promise<void> => writePlaintextProfile("ssh", "VALID", { host: "x".repeat(MAX_CREDENTIAL_FIELD_BYTES + 1) }, getterOptions), "too_large", root)
            await expectCredentialError((): Promise<void> => writePlaintextProfile("ssh", "VALID", MINIMAL_PROFILES.ssh, getterOptions), "invalid", root)
            await expectCredentialError((): Promise<void> => writePlaintextProfile("ssh", "VALID", MINIMAL_PROFILES.ssh, { ...options, expectedSid: 22 } as unknown as PlaintextCredentialOptions), "invalid", root)
            expect(optionReads).toBe(0)
            expect(run).not.toHaveBeenCalled()
            expect(read).not.toHaveBeenCalled()
            expect(write).not.toHaveBeenCalled()
            expect(await readdir(root)).toEqual([])
        } finally {
            write.mockRestore()
            read.mockRestore()
            run.mockRestore()
            await rm(root, { recursive: true, force: true })
        }
    })
})
