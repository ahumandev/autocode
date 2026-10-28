import { Buffer } from "node:buffer"
import { TextDecoder, types } from "node:util"
import {
    CredentialError,
    MAX_CREDENTIAL_ENVELOPE_BYTES,
    MAX_CREDENTIAL_FIELD_BYTES,
    type CredentialEnvelope,
    type CredentialKind,
    type CredentialProfile,
    type CredentialProfileValidation,
} from "./types"

const CREDENTIAL_FIELD_NAMES: Readonly<Record<CredentialKind, readonly string[]>> = {
    ssh: ["host", "username", "port", "keyfile", "agent", "password", "keypass"],
    db: ["connection", "username", "password"],
    rest: ["authorization", "username", "password"],
}

function assertCredentialKind(kind: unknown): asserts kind is CredentialKind {
    if (kind !== "ssh" && kind !== "db" && kind !== "rest") {
        throw new CredentialError("invalid")
    }
}

function assertPlainObject(value: unknown): asserts value is object {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new CredentialError("invalid")
    }

    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
        throw new CredentialError("invalid")
    }
}

function readOwnDataValue(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
        throw new CredentialError("invalid")
    }

    return descriptor.value
}

function resolveMaxBytes(maxBytes: number | undefined): number {
    const limit = maxBytes === undefined ? MAX_CREDENTIAL_ENVELOPE_BYTES : maxBytes
    if (typeof limit !== "number" || !Number.isInteger(limit)
        || limit <= 0 || limit > MAX_CREDENTIAL_ENVELOPE_BYTES) {
        throw new CredentialError("invalid")
    }

    return limit
}

function assertByteSize(value: string | Uint8Array, maxBytes: number): void {
    // Intrinsic byte length avoids invoking an input's overridden accessor.
    const byteLength: unknown = typeof value === "string"
        ? Buffer.byteLength(value, "utf8")
        : Reflect.get(Uint8Array.prototype, "byteLength", value)
    if (typeof byteLength !== "number") {
        throw new CredentialError("invalid")
    }
    if (byteLength > maxBytes) {
        throw new CredentialError("too_large")
    }
}

function copyCredentialFields(kind: CredentialKind, profile: unknown): Record<string, string> {
    assertPlainObject(profile)
    const keys = Reflect.ownKeys(profile)
    const allowedKeys = CREDENTIAL_FIELD_NAMES[kind]
    if (keys.length > allowedKeys.length) {
        throw new CredentialError("invalid")
    }

    const fields: Record<string, string> = Object.create(null)
    for (const key of keys) {
        if (typeof key !== "string" || !allowedKeys.includes(key)) {
            throw new CredentialError("invalid")
        }

        const value = readOwnDataValue(profile, key)
        if (typeof value !== "string") {
            throw new CredentialError("invalid")
        }
        fields[key] = value
    }

    for (const value of Object.values(fields)) {
        assertByteSize(value, MAX_CREDENTIAL_FIELD_BYTES)
    }
    return fields
}

function encodeCredentialEnvelope(kind: CredentialKind, fields: Record<string, string>, maxBytes: number): string {
    // Null prototypes keep inherited toJSON hooks out of credential serialization.
    const envelope: CredentialEnvelope<CredentialKind> = Object.create(null)
    envelope.version = 1
    envelope.kind = kind
    envelope.fields = fields
    const payload: unknown = JSON.stringify(envelope)
    if (typeof payload !== "string") {
        throw new CredentialError("invalid")
    }

    assertByteSize(payload, maxBytes)
    return payload
}

function sanitizeCredentialError(error: unknown): CredentialError {
    try {
        if (error instanceof CredentialError) {
            const code = readOwnDataValue(error, "code")
            switch (code) {
                case "locked":
                case "denied":
                case "invalid":
                case "too_large":
                case "failed":
                case "missing":
                case "incomplete":
                case "unavailable":
                case "unsupported":
                    return new CredentialError(code)
            }
        }
    } catch {
        // Reflection on an untrusted error can also fail.
    }
    return new CredentialError("invalid")
}

export function validateCredentialProfile<K extends CredentialKind>(kind: K, profile: unknown): CredentialProfileValidation<K> {
    try {
        assertCredentialKind(kind)
        const fields = copyCredentialFields(kind, profile)
        encodeCredentialEnvelope(kind, fields, MAX_CREDENTIAL_ENVELOPE_BYTES)

        let complete: boolean
        if (kind === "ssh") {
            complete = typeof fields.host === "string" && fields.host.trim().length > 0
        } else if (kind === "db") {
            complete = typeof fields.connection === "string" && fields.connection.trim().length > 0
        } else {
            complete = Object.hasOwn(fields, "authorization")
                || (Object.hasOwn(fields, "username") && Object.hasOwn(fields, "password"))
        }

        return complete
            ? { status: "found", profile: fields as unknown as CredentialProfile<K> }
            : { status: "incomplete" }
    } catch (error: unknown) {
        throw sanitizeCredentialError(error)
    }
}

export function parseCredentialEnvelope<K extends CredentialKind>(kind: K, payload: string | Uint8Array, maxBytes?: number): unknown {
    try {
        assertCredentialKind(kind)
        const limit = resolveMaxBytes(maxBytes)
        if (typeof payload !== "string" && !types.isUint8Array(payload)) {
            throw new CredentialError("invalid")
        }

        if (typeof payload !== "string") {
            assertByteSize(payload, limit)
        }
        const text = typeof payload === "string"
            ? payload
            : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload)
        assertByteSize(text, limit)
        const envelope: unknown = JSON.parse(text)
        assertPlainObject(envelope)
        if (Reflect.ownKeys(envelope).length !== 3
            || readOwnDataValue(envelope, "version") !== 1
            || readOwnDataValue(envelope, "kind") !== kind) {
            throw new CredentialError("invalid")
        }

        return readOwnDataValue(envelope, "fields")
    } catch (error: unknown) {
        throw sanitizeCredentialError(error)
    }
}

export function serializeCredentialEnvelope<K extends CredentialKind>(kind: K, fields: unknown, maxBytes?: number): string {
    try {
        assertCredentialKind(kind)
        const limit = resolveMaxBytes(maxBytes)
        return encodeCredentialEnvelope(kind, copyCredentialFields(kind, fields), limit)
    } catch (error: unknown) {
        throw sanitizeCredentialError(error)
    }
}
