import { describe, expect, spyOn, test } from "bun:test"
import { Buffer } from "node:buffer"
import { CredentialError } from "./types"
import { readSecureWindowsFile, WINDOWS_SECURE_FILE_MAX_BYTES, writeSecureWindowsFile } from "./windows-files"
import * as windowsProcess from "./windows-process"

const PATH = "C:\\synthetic\\credentials.json"
const EXPECTED_SID = "S-1-5-21-1"

describe("Windows credential files", (): void => {
    test("passes file requests and expected SID to the mocked helper", async (): Promise<void> => {
        const run = spyOn(windowsProcess, "runWindowsCredentialOperation")
            .mockResolvedValueOnce({ version: 1, status: "ok" })
            .mockResolvedValueOnce({ version: 1, status: "ok", payload: "café" })
            .mockResolvedValueOnce({ version: 1, status: "missing" })
        try {
            await writeSecureWindowsFile(PATH, "café", 8, { expectedSid: EXPECTED_SID })
            expect(await readSecureWindowsFile(PATH, 8, { expectedSid: EXPECTED_SID })).toEqual({ status: "found", contents: "café" })
            expect(await readSecureWindowsFile(PATH, 8, { expectedSid: EXPECTED_SID })).toEqual({ status: "missing" })
            expect(run.mock.calls).toEqual([
                [{ operation: "file-write", path: PATH, maxBytes: 8, payload: "café" }, { expectedSid: EXPECTED_SID }],
                [{ operation: "file-read", path: PATH, maxBytes: 8 }, { expectedSid: EXPECTED_SID }],
                [{ operation: "file-read", path: PATH, maxBytes: 8 }, { expectedSid: EXPECTED_SID }],
            ])
        } finally {
            run.mockRestore()
        }
    })

    test("rejects invalid arguments and oversized UTF-8 before calling the helper", async (): Promise<void> => {
        const run = spyOn(windowsProcess, "runWindowsCredentialOperation").mockResolvedValue({ version: 1, status: "ok" })
        try {
            expect(WINDOWS_SECURE_FILE_MAX_BYTES).toBe(1048576)
            for (const cap of [0, -1, 0.5, NaN, Infinity, -Infinity, WINDOWS_SECURE_FILE_MAX_BYTES + 1]) {
                await expect(readSecureWindowsFile(PATH, cap)).rejects.toMatchObject({ code: "invalid" })
                await expect(writeSecureWindowsFile(PATH, "synthetic", cap)).rejects.toMatchObject({ code: "invalid" })
            }
            await expect(readSecureWindowsFile("\ud800", 8)).rejects.toMatchObject({ code: "invalid" })
            await expect(writeSecureWindowsFile(PATH, "\ud800", 8)).rejects.toMatchObject({ code: "invalid" })
            const boundary = "é".repeat(14) + "😀"
            expect(Buffer.byteLength(boundary, "utf8")).toBe(32)
            await expect(writeSecureWindowsFile(PATH, boundary + "x", 32)).rejects.toMatchObject({ code: "too_large" })
            expect(run).not.toHaveBeenCalled()
            await writeSecureWindowsFile(PATH, boundary, 32)
            expect(run).toHaveBeenCalledTimes(1)
        } finally {
            run.mockRestore()
        }
    })

    test("rejects malformed helper payloads and propagates unavailable status", async (): Promise<void> => {
        const run = spyOn(windowsProcess, "runWindowsCredentialOperation")
            .mockResolvedValueOnce({ version: 1, status: "ok", payload: "\ud800" })
            .mockResolvedValueOnce({ version: 1, status: "ok", payload: "éé" })
            .mockResolvedValueOnce({ version: 1, status: "unavailable", nativeCode: 5 })
        try {
            await expect(readSecureWindowsFile(PATH, 8)).rejects.toMatchObject({ code: "failed" })
            await expect(readSecureWindowsFile(PATH, 3)).rejects.toMatchObject({ code: "failed" })
            await expect(writeSecureWindowsFile(PATH, "x", 8)).rejects.toMatchObject({ code: "unavailable", nativeCode: 5 })
        } finally {
            run.mockRestore()
        }
    })
})

describe("Windows file failure diagnostics (safe metadata)", (): void => {
    test("withholds malformed helper payload from production errors", async (): Promise<void> => {
        const privateText = "synthetic-private-path-and-payload"
        const run = spyOn(windowsProcess, "runWindowsCredentialOperation")
            .mockResolvedValue({ version: 1, status: "ok", payload: privateText })
        try {
            let failure: unknown
            try { await readSecureWindowsFile(PATH, 1) } catch (error: unknown) { failure = error }
            expect(failure instanceof CredentialError).toBe(true)
            if (!(failure instanceof CredentialError)) throw new Error("Expected sanitized credential failure.")
            expect(failure.code).toBe("failed")
            expect(failure.message).toBe(new CredentialError("failed").message)
            expect(failure.message.includes(privateText)).toBe(false)
            expect(failure.stack?.includes(privateText)).toBe(false)
            expect(JSON.stringify(failure).includes(privateText)).toBe(false)
            expect(Object.hasOwn(failure, "cause")).toBe(false)
        } finally {
            run.mockRestore()
        }
    })
})
