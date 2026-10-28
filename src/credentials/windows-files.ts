import { Buffer } from "node:buffer"
import { CredentialError } from "./types"
import {
    runWindowsCredentialOperation,
    WindowsCredentialProcessError,
    type WindowsCredentialProcessOptions,
    type WindowsCredentialResponse,
} from "./windows-process"

export const WINDOWS_SECURE_FILE_MAX_BYTES = 1048576

export type SecureWindowsFileReadResult =
    | { status: "found"; contents: string }
    | { status: "missing" }

function validateFileArguments(path: string, maxBytes: number): void {
    if (typeof path !== "string" || !path.isWellFormed()
        || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > WINDOWS_SECURE_FILE_MAX_BYTES) {
        throw new CredentialError("invalid")
    }
}

function requireSuccessfulResponse(
    response: WindowsCredentialResponse,
): Extract<WindowsCredentialResponse, { status: "ok" }> {
    if (response.status === "missing" || response.status === "unavailable") {
        throw new WindowsCredentialProcessError(response.status, response.nativeCode)
    }
    if (response.status !== "ok") {
        throw new CredentialError("failed")
    }
    return response
}

// Paths are trusted application credential locations, never project-config paths; no expansion occurs.
// The helper pins non-reparse ancestors during each operation; owner-only DACL checks cover the final parent and file.
// Privileged and same-token actors remain outside DACL isolation.
export async function readSecureWindowsFile(
    path: string,
    maxBytes: number,
    options?: WindowsCredentialProcessOptions,
): Promise<SecureWindowsFileReadResult> {
    validateFileArguments(path, maxBytes)
    const response = await runWindowsCredentialOperation({ operation: "file-read", path, maxBytes }, options)
    if (response.status === "missing") {
        return { status: "missing" }
    }
    const success = requireSuccessfulResponse(response)
    if (typeof success.payload !== "string" || !success.payload.isWellFormed()
        || Buffer.byteLength(success.payload, "utf8") > maxBytes) {
        throw new CredentialError("failed")
    }
    return { status: "found", contents: success.payload }
}

// Provisioning replaces the whole file atomically; no read-modify-write locking is promised.
export async function writeSecureWindowsFile(
    path: string,
    contents: string,
    maxBytes: number,
    options?: WindowsCredentialProcessOptions,
): Promise<void> {
    validateFileArguments(path, maxBytes)
    if (typeof contents !== "string" || !contents.isWellFormed()) {
        throw new CredentialError("invalid")
    }
    if (Buffer.byteLength(contents, "utf8") > maxBytes) {
        throw new CredentialError("too_large")
    }
    const response = await runWindowsCredentialOperation({ operation: "file-write", path, maxBytes, payload: contents }, options)
    requireSuccessfulResponse(response)
}
