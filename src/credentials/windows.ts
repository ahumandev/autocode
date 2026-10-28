import { normalizeEnvKey } from "../utils/envkey"
import {
    CredentialError,
    WINDOWS_CREDENTIAL_MAX_BYTES,
    type CredentialKind,
    type CredentialProfileInput,
    type CredentialProvider,
    type CredentialReadResult,
} from "./types"
import { parseCredentialEnvelope, serializeCredentialEnvelope, validateCredentialProfile } from "./validation"
import {
    runWindowsCredentialOperation,
    WindowsCredentialProcessError,
    type WindowsCredentialIdentity,
    type WindowsCredentialProcessOptions,
    type WindowsCredentialResponse,
} from "./windows-process"

export type { WindowsCredentialIdentity, WindowsCredentialProcessOptions } from "./windows-process"

function buildWindowsCredentialTarget(kind: CredentialKind, id: string): string {
    if ((kind !== "ssh" && kind !== "db" && kind !== "rest") || typeof id !== "string") {
        throw new CredentialError("invalid")
    }

    let normalizedId: string
    try {
        normalizedId = normalizeEnvKey(id, { allowHyphen: kind === "ssh" })
    } catch {
        throw new CredentialError("invalid")
    }

    const target = `AutoCode/v1/${kind}/${normalizedId}`
    if (target.length > 32767) {
        throw new CredentialError("invalid")
    }
    return target
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

export function createWindowsCredentialProvider(options?: WindowsCredentialProcessOptions): CredentialProvider {
    return {
        async read(kind: CredentialKind, normalizedId: string): Promise<CredentialReadResult> {
            const target = buildWindowsCredentialTarget(kind, normalizedId)
            const response = await runWindowsCredentialOperation({ operation: "read", target }, options)
            if (response.status === "missing" || response.status === "unavailable") {
                const result: CredentialReadResult = { status: response.status }
                if (response.nativeCode !== undefined) {
                    Object.defineProperty(result, "nativeCode", { value: response.nativeCode, enumerable: false })
                }
                return result
            }

            const success = requireSuccessfulResponse(response)
            if (typeof success.payload !== "string") {
                throw new CredentialError("failed")
            }
            const profile = parseCredentialEnvelope(kind, success.payload, WINDOWS_CREDENTIAL_MAX_BYTES)
            return validateCredentialProfile(kind, profile)
        },
        async enumerate(kind: CredentialKind): Promise<string[]> {
            const response = await runWindowsCredentialOperation({ operation: "enumerate", kind }, options)
            const success = requireSuccessfulResponse(response)
            if (!Array.isArray(success.ids)) {
                throw new CredentialError("failed")
            }
            return success.ids
        },
    }
}

// Services may use another logon context; provision under the service account/logon token.
// Call getWindowsCredentialIdentity there, then pass expectedSid to prevent wrong-account writes.
// Matching SIDs do not prove the same logon session or credential access; native 1312 remains unavailable.
export async function writeWindowsProfile<K extends CredentialKind>(
    kind: K,
    id: string,
    profile: CredentialProfileInput<K>,
    options?: WindowsCredentialProcessOptions,
): Promise<void> {
    const target = buildWindowsCredentialTarget(kind, id)
    const validation = validateCredentialProfile(kind, profile)
    if (validation.status === "incomplete") {
        throw new CredentialError("incomplete")
    }
    const payload = serializeCredentialEnvelope(kind, validation.profile, WINDOWS_CREDENTIAL_MAX_BYTES)
    const response = await runWindowsCredentialOperation({ operation: "write", target, payload }, options)
    requireSuccessfulResponse(response)
}

export async function deleteWindowsProfile(
    kind: CredentialKind,
    id: string,
    options?: WindowsCredentialProcessOptions,
): Promise<boolean> {
    const target = buildWindowsCredentialTarget(kind, id)
    const response = await runWindowsCredentialOperation({ operation: "delete", target }, options)
    if (response.status === "missing") {
        return false
    }
    requireSuccessfulResponse(response)
    return true
}

export async function getWindowsCredentialIdentity(
    options?: WindowsCredentialProcessOptions,
): Promise<WindowsCredentialIdentity> {
    const response = requireSuccessfulResponse(await runWindowsCredentialOperation({ operation: "identity" }, options))
    const identity = response.identity
    if (typeof identity !== "object" || identity === null
        || typeof identity.sid !== "string" || typeof identity.account !== "string") {
        throw new CredentialError("failed")
    }
    return identity
}
