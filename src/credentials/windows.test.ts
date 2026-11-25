import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { CredentialError } from "./types"
import { WindowsCredentialProcessError } from "./windows-process"

const WINDOWS_PATH = fileURLToPath(new URL("./windows.ts", import.meta.url))
const PROCESS_PATH = fileURLToPath(new URL("./windows-process.ts", import.meta.url))
const TYPES_PATH = fileURLToPath(new URL("./types.ts", import.meta.url))
const SECRET = "synthetic-windows-credential-test-canary"

describe("Windows credential provider with fake transport", (): void => {
    test("covers SID policy, Unicode profiles, validation, and redaction without native access", async (): Promise<void> => {
        const source = `
            import { expect, mock } from "bun:test"
            import { Buffer } from "node:buffer"
            const childProcess = await import("node:child_process")
            mock.module("node:child_process", () => ({
                ...childProcess,
                spawn() { throw new Error("Native process launch forbidden") },
            }))
            const { CredentialError, WINDOWS_CREDENTIAL_MAX_BYTES } = await import(${JSON.stringify(TYPES_PATH)})
            const { WindowsCredentialProcessError } = await import(${JSON.stringify(PROCESS_PATH)})
            const secret = ${JSON.stringify(SECRET)}
            const sid = "S-1-5-21-123"
            const identity = { sid, account: "synthetic-account" }
            const stored = new Map()
            const requests = []
            let nextResponse
            mock.module(${JSON.stringify(PROCESS_PATH)}, () => ({
                WindowsCredentialProcessError,
                async runWindowsCredentialOperation(request, options = {}) {
                    requests.push({ request, options })
                    if (nextResponse !== undefined) {
                        const response = nextResponse
                        nextResponse = undefined
                        return response
                    }
                    if (options.expectedSid !== undefined && options.expectedSid !== sid) {
                        throw new WindowsCredentialProcessError("denied")
                    }
                    if (request.operation === "identity") return { version: 1, status: "ok", identity }
                    if (request.operation === "write") {
                        stored.set(request.target, request.payload)
                        return { version: 1, status: "ok" }
                    }
                    if (request.operation === "read") {
                        return stored.has(request.target)
                            ? { version: 1, status: "ok", payload: stored.get(request.target) }
                            : { version: 1, status: "missing", nativeCode: 1168 }
                    }
                    if (request.operation === "delete") {
                        return stored.delete(request.target)
                            ? { version: 1, status: "ok" }
                            : { version: 1, status: "missing", nativeCode: 1168 }
                    }
                    throw new Error("Unexpected operation")
                },
            }))
            const { createWindowsCredentialProvider, deleteWindowsProfile, getWindowsCredentialIdentity, writeWindowsProfile } =
                await import(${JSON.stringify(WINDOWS_PATH)})
            const profiles = {
                ssh: { host: "  hôte-例.example.test  ", username: "  opérateur_用户🧪  ", password: secret + ":é漢🧪\\\\\\r\\n\\t\\0" },
                db: { connection: "  jdbc:postgresql://db.example.test/試験  ", username: "  usér_用户🧪  ", password: secret + ":données漢🧪" },
                rest: { authorization: " Bearer " + secret + ":é漢🧪 ", username: "  usér_用户🧪  ", password: secret + ":réponse🔑\\0" },
            }
            const incomplete = {
                ssh: [{}, { password: secret }, { host: "" }, { host: " \\t\\r\\n", password: secret }],
                db: [{}, { password: secret }, { connection: "" }, { connection: " \\t\\r\\n", username: secret }],
                rest: [{}, { username: secret }, { password: secret }],
            }
            async function rejected(action, code, redactions) {
                let caught
                try { await action() } catch (error) { caught = error }
                expect(caught).toBeInstanceOf(CredentialError)
                expect(caught.code).toBe(code)
                expect(caught.message).toBe(new CredentialError(code).message)
                expect(Object.hasOwn(caught, "cause")).toBe(false)
                for (const surface of [caught.message, caught.stack ?? "", JSON.stringify(caught)]) {
                    for (const value of [secret, ...redactions]) expect(surface.includes(value)).toBe(false)
                }
            }
            expect(await getWindowsCredentialIdentity({ expectedSid: sid })).toEqual(identity)
            for (const kind of ["ssh", "db", "rest"]) {
                const id = kind === "ssh" ? "test-id" : "TEST_ID"
                const target = "AutoCode/v1/" + kind + "/TEST_ID"
                const options = { expectedSid: sid }
                const provider = createWindowsCredentialProvider(options)
                const missing = await provider.read(kind, id)
                expect(missing).toEqual({ status: "missing" })
                expect(Reflect.get(missing, "nativeCode")).toBe(1168)
                expect(Object.getOwnPropertyDescriptor(missing, "nativeCode").enumerable).toBe(false)
                await writeWindowsProfile(kind, id, profiles[kind], options)
                expect(stored.get(target)).toBe(JSON.stringify({ version: 1, kind, fields: profiles[kind] }))
                expect(await provider.read(kind, id)).toEqual({ status: "found", profile: profiles[kind] })
                const before = stored.get(target)
                const wrong = { expectedSid: "S-1-5-18" }
                for (const action of [
                    () => getWindowsCredentialIdentity(wrong),
                    () => createWindowsCredentialProvider(wrong).read(kind, id),
                    () => writeWindowsProfile(kind, id, profiles[kind], wrong),
                    () => deleteWindowsProfile(kind, id, wrong),
                ]) {
                    await rejected(action, "denied", [id, target, wrong.expectedSid])
                    expect(stored.get(target)).toBe(before)
                }
                for (const invalid of [id + "/" + secret, id + "." + secret, id + " " + secret, id + "\\0" + secret]) {
                    const count = requests.length
                    for (const action of [
                        () => provider.read(kind, invalid),
                        () => writeWindowsProfile(kind, invalid, profiles[kind], options),
                        () => deleteWindowsProfile(kind, invalid, options),
                    ]) await rejected(action, "invalid", [invalid, target])
                    expect(requests.length).toBe(count)
                }
                for (const partial of incomplete[kind]) {
                    const count = requests.length
                    await rejected(() => writeWindowsProfile(kind, id, partial, options), "incomplete", [id, target])
                    expect(requests.length).toBe(count)
                    stored.set(target, JSON.stringify({ version: 1, kind, fields: partial }))
                    expect(await provider.read(kind, id)).toEqual({ status: "incomplete" })
                }
                expect(await deleteWindowsProfile(kind, id, options)).toBe(true)
                expect(await deleteWindowsProfile(kind, id, options)).toBe(false)
            }
            const target = "AutoCode/v1/rest/TEST_ID"
            const provider = createWindowsCredentialProvider()
            for (const malformed of [
                undefined, null, {}, { sid }, { account: secret },
                { sid: 42, account: secret }, { sid: secret, account: 42 },
            ]) {
                nextResponse = { version: 1, status: "ok", identity: malformed }
                await rejected(() => getWindowsCredentialIdentity(), "failed", [sid])
            }
            for (const payload of [undefined, null, 42, { authorization: secret }]) {
                nextResponse = { version: 1, status: "ok", payload }
                await rejected(() => provider.read("rest", "TEST_ID"), "failed", [target])
            }
            const oversized = JSON.stringify({ version: 1, kind: "rest", fields: { authorization: secret + "é".repeat(1280) } })
            nextResponse = { version: 1, status: "ok", payload: oversized }
            await rejected(() => provider.read("rest", "TEST_ID"), "too_large", [target, oversized])
            for (const status of [undefined, null, 42, "unexpected"]) {
                for (const action of [
                    () => getWindowsCredentialIdentity(),
                    () => provider.read("rest", "TEST_ID"),
                    () => provider.enumerate("rest"),
                    () => writeWindowsProfile("rest", "TEST_ID", profiles.rest),
                    () => deleteWindowsProfile("rest", "TEST_ID"),
                ]) {
                    nextResponse = { version: 1, status, payload: secret }
                    await rejected(action, "failed", [target])
                }
            }
            for (const ids of [undefined, null, secret, { id: secret }]) {
                nextResponse = { version: 1, status: "ok", ids }
                await rejected(() => provider.enumerate("rest"), "failed", [])
            }
            const longId = "PRIVATE_ID_" + "A".repeat(32768 - "AutoCode/v1/rest/".length - "PRIVATE_ID_".length)
            const longTarget = "AutoCode/v1/rest/" + longId
            expect(longTarget.length).toBe(32768)
            const requestCount = requests.length
            for (const action of [
                () => provider.read("rest", longId),
                () => writeWindowsProfile("rest", longId, profiles.rest),
                () => deleteWindowsProfile("rest", longId),
            ]) await rejected(action, "invalid", [longId, longTarget])
            expect(requests.length).toBe(requestCount)
            for (const payload of [
                '{"version":1,"kind":"rest","fields":',
                JSON.stringify({ version: 2, kind: "rest", fields: profiles.rest }),
                JSON.stringify({ version: 1, kind: "ssh", fields: profiles.ssh }),
                JSON.stringify({ version: 1, kind: "rest", fields: profiles.rest, extra: secret }),
                JSON.stringify({ version: 1, kind: "rest", fields: { authorization: 42, password: secret } }),
                JSON.stringify({ version: 1, kind: "rest", fields: { ...profiles.rest, extra: secret } }),
            ]) {
                stored.set(target, payload)
                await rejected(() => provider.read("rest", "TEST_ID"), "invalid", [payload, target])
            }
            const basic = { username: "  usér_用户🧪  ", password: secret + ":basic-é漢🧪\\0" }
            await writeWindowsProfile("rest", "TEST_ID", basic)
            expect(await provider.read("rest", "TEST_ID")).toEqual({ status: "found", profile: basic })
            expect(WINDOWS_CREDENTIAL_MAX_BYTES).toBe(2560)
            const fields = { authorization: secret + "é漢🧪" }
            const envelope = () => JSON.stringify({ version: 1, kind: "rest", fields })
            fields.authorization += "x".repeat(WINDOWS_CREDENTIAL_MAX_BYTES - Buffer.byteLength(envelope(), "utf8"))
            await writeWindowsProfile("rest", "TEST_ID", fields)
            expect(Buffer.byteLength(stored.get(target), "utf8")).toBe(WINDOWS_CREDENTIAL_MAX_BYTES)
            expect(await provider.read("rest", "TEST_ID")).toEqual({ status: "found", profile: fields })
            const before = stored.get(target)
            for (const padding of [1, 255]) {
                fields.authorization += "x".repeat(padding)
                const count = requests.length
                await rejected(() => writeWindowsProfile("rest", "TEST_ID", fields), "too_large", [target, fields.authorization])
                expect(requests.length).toBe(count)
                expect(stored.get(target)).toBe(before)
            }
        `
        const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" })
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ])
        expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    }, 60_000)

    test("keeps process error nativeCode metadata nonenumerable and failed message fixed", (): void => {
        const error = new WindowsCredentialProcessError("failed", 1168)
        expect(error).toBeInstanceOf(CredentialError)
        expect(error.code).toBe("failed")
        expect(error.message).toBe("Credential read failed.")
        expect(error.nativeCode).toBe(1168)
        expect(Object.getOwnPropertyDescriptor(error, "nativeCode")?.enumerable).toBe(false)
        expect(Object.keys(error)).not.toContain("nativeCode")
        expect(JSON.stringify(error)).not.toContain("nativeCode")
    })
})
