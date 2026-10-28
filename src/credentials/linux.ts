import { Buffer } from "node:buffer"
import type { EventEmitter } from "node:events"
import { createRequire } from "node:module"
import type { Socket } from "node:net"
import { types } from "node:util"
import { normalizeEnvKey } from "../utils/envkey"
import {
    CredentialError,
    MAX_CREDENTIAL_ENVELOPE_BYTES,
    type CredentialKind,
    type CredentialProvider,
    type CredentialReadResult,
} from "./types"
import { parseCredentialEnvelope } from "./validation"

export interface LinuxSecretServiceProviderOptions {
    timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5000
const MAX_TIMEOUT_MS = 30000
const CLEANUP_TIMEOUT_MS = 250
const BUS_NAME = "org.freedesktop.DBus"
const BUS_PATH = "/org/freedesktop/DBus"
const SERVICE_NAME = "org.freedesktop.secrets"
const SERVICE_PATH = "/org/freedesktop/secrets"
const SERVICE_INTERFACE = "org.freedesktop.Secret.Service"
const ITEM_INTERFACE = "org.freedesktop.Secret.Item"
const PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties"
// dbus-next 0.10.2's declarations disagree with these D-Bus wire constants.
const METHOD_CALL = 1
const METHOD_RETURN = 2
const ERROR_REPLY = 3
const SIGNAL = 4
const NO_AUTO_START = 2
const DBUS_HEADER_BYTES = 16
const MAX_DBUS_AUTH_BYTES = 16 * 1024
const MAX_DBUS_HEADER_FIELDS_BYTES = 64 * 1024
const MAX_DBUS_FRAME_BYTES = 2 * 1024 * 1024
const MAX_DBUS_CONNECTION_BYTES = 8 * 1024 * 1024
const MAX_DBUS_FRAMES = 256
const MAX_DBUS_SIGNATURE_BYTES = 255
const MAX_DBUS_DEPTH = 32
const MAX_DBUS_FRAME_WORK = 262144
const MAX_DBUS_CONNECTION_WORK = 1048576
// Keep per-item attribute reads within the existing per-connection D-Bus frame budget.
const MAX_LINUX_ENUMERATED_PROFILES = 128
const DBUS_BASIC_TYPES = "ybnqiuxtdsog"
const DBUS_FIELD_SIGNATURES = ["", "o", "s", "s", "s", "u", "s", "s", "g", "u"]

interface OutgoingMessage {
    type: number
    serial: number
    destination: string
    path: string
    interface: string
    member: string
    signature: string
    body: unknown[]
    flags: number
}

interface RawConnection extends EventEmitter {
    stream: Socket
    message(message: unknown): void
}

interface DbusRuntime {
    createConnection(options: {
        busAddress: string
        authMethods: string[]
        negotiateUnixFd: boolean
    }): RawConnection
    Message: new (options: OutgoingMessage) => unknown
    Variant: new (signature: string, value: unknown) => unknown
}

interface RemoteCall {
    destination: string
    path: string
    interface: string
    member: string
    signature: string
    body: unknown[]
    replySignature: string
    replyLength: number
    nameOwnerLookup?: boolean
}

interface PendingCall {
    call: RemoteCall
    resolve(body: unknown[]): void
    reject(error: CredentialError): void
    timer?: ReturnType<typeof setTimeout>
}

interface DbusSignatureNode {
    type: string
    children: DbusSignatureNode[]
}

interface DbusFrameHeader {
    littleEndian: boolean
    type: number
    fieldsLength: number
    paddedFieldsLength: number
    bodyLength: number
    tailLength: number
}

interface DbusWorkBudget {
    remaining: number
}

function readDbusFrameHeader(buffer: Buffer): DbusFrameHeader {
    const endian = buffer[0]
    if ((endian !== 108 && endian !== 66) || buffer[3] !== 1
        || buffer[1] < METHOD_CALL || buffer[1] > SIGNAL) {
        throw new CredentialError("failed")
    }
    const littleEndian = endian === 108
    const bodyLength = littleEndian ? buffer.readUInt32LE(4) : buffer.readUInt32BE(4)
    const serial = littleEndian ? buffer.readUInt32LE(8) : buffer.readUInt32BE(8)
    const fieldsLength = littleEndian ? buffer.readUInt32LE(12) : buffer.readUInt32BE(12)
    const paddedFieldsLength = Math.ceil(fieldsLength / 8) * 8
    const tailLength = paddedFieldsLength + bodyLength
    const totalLength = DBUS_HEADER_BYTES + tailLength
    // Positive fields length avoids the dependency's zero-tail read(0), which returns null rather than an empty frame.
    if (serial === 0 || fieldsLength === 0 || fieldsLength > MAX_DBUS_HEADER_FIELDS_BYTES
        || !Number.isSafeInteger(totalLength) || totalLength > MAX_DBUS_FRAME_BYTES) {
        throw new CredentialError("failed")
    }
    return { littleEndian, type: buffer[1], fieldsLength, paddedFieldsLength, bodyLength, tailLength }
}

function parseDbusSignature(
    buffer: Buffer,
    start: number,
    length: number,
    charge: (amount: number) => void,
): DbusSignatureNode[] {
    if (length > MAX_DBUS_SIGNATURE_BYTES) {
        throw new CredentialError("failed")
    }
    charge(length)
    let position = start
    const end = start + length
    function parseOne(depth: number, dictAllowed: boolean): DbusSignatureNode {
        if (depth > MAX_DBUS_DEPTH || position >= end || buffer[position] > 0x7f) {
            throw new CredentialError("failed")
        }
        charge(1)
        const type = String.fromCharCode(buffer[position++])
        const children: DbusSignatureNode[] = []
        if (DBUS_BASIC_TYPES.includes(type) || type === "v") {
            return { type, children }
        }
        if (type === "a") {
            children.push(parseOne(depth + 1, true))
        } else if (type === "(" || (type === "{" && dictAllowed)) {
            const close = type === "(" ? 41 : 125
            while (position < end && buffer[position] !== close) {
                children.push(parseOne(depth + 1, false))
            }
            if (position >= end || children.length === 0) {
                throw new CredentialError("failed")
            }
            position++
            if (type === "{" && (children.length !== 2 || !DBUS_BASIC_TYPES.includes(children[0].type))) {
                throw new CredentialError("failed")
            }
        } else {
            throw new CredentialError("failed")
        }
        return { type, children }
    }
    const signature: DbusSignatureNode[] = []
    while (position < end) {
        signature.push(parseOne(1, false))
    }
    return signature
}

function dbusAlignment(type: string): number {
    if ("xtd({".includes(type)) {
        return 8
    }
    if ("biusao".includes(type)) {
        return 4
    }
    return type === "n" || type === "q" ? 2 : 1
}

class DbusFramePreflight {
    private position = 0
    private remaining = MAX_DBUS_FRAME_WORK

    constructor(
        private readonly buffer: Buffer,
        private readonly header: DbusFrameHeader,
        private readonly budget: DbusWorkBudget,
    ) {}

    validate(): void {
        this.charge(1)
        const seen = new Set<number>()
        let bodySignature: DbusSignatureNode[] = []
        while (this.position < this.header.fieldsLength) {
            this.align(8, this.header.fieldsLength)
            this.charge(3)
            const code = this.byte(this.header.fieldsLength)
            if (code === 0 || code >= DBUS_FIELD_SIGNATURES.length || seen.has(code)) {
                throw new CredentialError("failed")
            }
            seen.add(code)
            const [type] = this.signature(this.header.fieldsLength, true)
            if (type.type !== DBUS_FIELD_SIGNATURES[code]) {
                throw new CredentialError("failed")
            }
            if (code === 8) {
                this.charge(1)
                bodySignature = this.signature(this.header.fieldsLength)
            } else if (code === 5 || code === 9) {
                this.charge(1)
                const value = this.uint32(this.header.fieldsLength)
                if ((code === 5 && value === 0) || (code === 9 && value !== 0)) {
                    throw new CredentialError("failed")
                }
            } else {
                this.value(type, this.header.fieldsLength, 2)
            }
        }
        const required = this.header.type === METHOD_CALL ? [1, 3]
            : this.header.type === METHOD_RETURN ? [5]
                : this.header.type === ERROR_REPLY ? [4, 5] : [1, 2, 3]
        if (required.some((code: number): boolean => !seen.has(code))) {
            throw new CredentialError("failed")
        }
        this.align(8, this.buffer.length)
        if (this.position !== this.header.paddedFieldsLength
            || (this.header.bodyLength > 0 && bodySignature.length === 0)) {
            throw new CredentialError("failed")
        }
        for (const type of bodySignature) {
            this.value(type, this.buffer.length, 1)
        }
        if (this.position !== this.buffer.length) {
            throw new CredentialError("failed")
        }
    }

    private charge(amount: number): void {
        if (amount > this.remaining || amount > this.budget.remaining) {
            throw new CredentialError("failed")
        }
        this.remaining -= amount
        this.budget.remaining -= amount
    }

    private requireBytes(length: number, end: number): void {
        if (length > end - this.position) {
            throw new CredentialError("failed")
        }
    }

    private align(boundary: number, end: number): void {
        const aligned = Math.ceil(this.position / boundary) * boundary
        this.requireBytes(aligned - this.position, end)
        while (this.position < aligned) {
            if (this.buffer[this.position++] !== 0) {
                throw new CredentialError("failed")
            }
        }
    }

    private byte(end: number): number {
        this.requireBytes(1, end)
        return this.buffer[this.position++]
    }

    private uint32(end: number): number {
        this.align(4, end)
        this.requireBytes(4, end)
        const value = this.header.littleEndian
            ? this.buffer.readUInt32LE(this.position) : this.buffer.readUInt32BE(this.position)
        this.position += 4
        return value
    }

    private signature(end: number, single: boolean = false): DbusSignatureNode[] {
        const length = this.byte(end)
        this.requireBytes(length + 1, end)
        if (this.buffer[this.position + length] !== 0) {
            throw new CredentialError("failed")
        }
        const signature = parseDbusSignature(this.buffer, this.position, length,
            (amount: number): void => this.charge(amount))
        this.position += length + 1
        if (single && signature.length !== 1) {
            throw new CredentialError("failed")
        }
        return signature
    }

    private value(node: DbusSignatureNode, end: number, depth: number): void {
        if (depth > MAX_DBUS_DEPTH) {
            throw new CredentialError("failed")
        }
        this.charge(1)
        this.align(dbusAlignment(node.type), end)
        switch (node.type) {
            case "y":
                this.byte(end)
                return
            case "b":
                if (this.uint32(end) > 1) {
                    throw new CredentialError("failed")
                }
                return
            case "n":
            case "q":
                this.requireBytes(2, end)
                this.position += 2
                return
            case "i":
            case "u":
                this.uint32(end)
                return
            case "x":
            case "t":
            case "d":
                this.requireBytes(8, end)
                this.position += 8
                return
            case "s":
            case "o": {
                const length = this.uint32(end)
                this.requireBytes(length + 1, end)
                if (this.buffer.indexOf(0, this.position) !== this.position + length) {
                    throw new CredentialError("failed")
                }
                this.position += length + 1
                return
            }
            case "g":
                this.signature(end)
                return
            case "v":
                this.value(this.signature(end, true)[0], end, depth + 1)
                return
            case "a": {
                const length = this.uint32(end)
                const child = node.children[0]
                // dbus-next 0.10.2 aligns the first array element before adding the declared byte length.
                this.align(dbusAlignment(child.type), end)
                this.requireBytes(length, end)
                const arrayEnd = this.position + length
                if (child.type === "y") {
                    this.charge(length)
                    this.position = arrayEnd
                    return
                }
                while (this.position < arrayEnd) {
                    const start = this.position
                    this.value(child, arrayEnd, depth + 1)
                    if (this.position <= start) {
                        throw new CredentialError("failed")
                    }
                }
                return
            }
            case "(":
            case "{":
                for (const child of node.children) {
                    this.value(child, end, depth + 1)
                }
                return
            default:
                throw new CredentialError("failed")
        }
    }
}

class DbusInputGuard {
    private readonly originalRead: (size?: number, ...args: unknown[]) => unknown
    private readonly budget: DbusWorkBudget = { remaining: MAX_DBUS_CONNECTION_WORK }
    private stopped = false
    private framed = false
    private authBytes = 0
    private declaredBytes = 0
    private frames = 0
    private header?: DbusFrameHeader

    constructor(private readonly stream: Socket, private readonly onFailure: () => void) {
        // dbus-next 0.10.2 authenticates with read(1), emits connect, then installs read(16)/read(tail, null).
        this.originalRead = stream.read.bind(stream)
        const originalEmit: (event: string | symbol, ...args: unknown[]) => boolean = stream.emit
        // Only this owned Socket changes; wrappers remain after destruction to contain queued readable events.
        stream.read = (size?: number, ...args: unknown[]): Buffer | null => this.read(size, args)
        stream.emit = (event: string | symbol, ...args: unknown[]): boolean => {
            if (event !== "readable") {
                return originalEmit.call(stream, event, ...args)
            }
            if (this.stopped) {
                return false
            }
            try {
                return originalEmit.call(stream, event, ...args)
            } catch {
                this.fail()
                return false
            }
        }
    }

    activate(): void {
        if (this.stopped) {
            return
        }
        if (this.framed) {
            this.fail()
            return
        }
        this.framed = true
    }

    stop(): void {
        this.stopped = true
        this.header = undefined
    }

    private read(size: number | undefined, args: unknown[]): Buffer | null {
        if (this.stopped) {
            return null
        }
        try {
            const expected = this.framed ? this.header?.tailLength ?? DBUS_HEADER_BYTES : 1
            if (size !== 0 && size !== expected) {
                throw new CredentialError("failed")
            }
            const buffer = this.originalRead(size, ...args)
            if (this.stopped || buffer === null) {
                return null
            }
            if (size === 0 || !Buffer.isBuffer(buffer) || buffer.length !== expected) {
                throw new CredentialError("failed")
            }
            if (!this.framed) {
                this.authBytes += buffer.length
                if (this.authBytes > MAX_DBUS_AUTH_BYTES) {
                    throw new CredentialError("failed")
                }
            } else if (this.header === undefined) {
                const header = readDbusFrameHeader(buffer)
                this.declaredBytes += DBUS_HEADER_BYTES + header.tailLength
                this.frames++
                if (this.declaredBytes > MAX_DBUS_CONNECTION_BYTES || this.frames > MAX_DBUS_FRAMES) {
                    throw new CredentialError("failed")
                }
                this.header = header
            } else {
                new DbusFramePreflight(buffer, this.header, this.budget).validate()
                this.header = undefined
            }
            return buffer
        } catch {
            this.fail()
            return null
        }
    }

    private fail(): void {
        this.stop()
        try {
            this.onFailure()
        } catch {
            // Failure notification must not escape the socket-local input boundary.
        }
        try {
            this.stream.destroy()
        } catch {
            // Destruction errors must not replace the sanitized hard failure.
        }
    }
}

function ownValue(value: unknown, key: string): unknown {
    if (typeof value !== "object" || value === null) {
        return undefined
    }
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        return descriptor !== undefined && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined
    } catch {
        return undefined
    }
}

function sanitizedError(error: unknown): CredentialError {
    try {
        if (error instanceof CredentialError) {
            switch (ownValue(error, "code")) {
                case "locked": return new CredentialError("locked")
                case "denied": return new CredentialError("denied")
                case "invalid": return new CredentialError("invalid")
                case "too_large": return new CredentialError("too_large")
                case "unavailable": return new CredentialError("unavailable")
                case "unsupported": return new CredentialError("unsupported")
                case "failed": return new CredentialError("failed")
            }
        }
    } catch {
        return new CredentialError("failed")
    }
    return new CredentialError("failed")
}

function transportError(error: unknown, connecting: boolean): CredentialError {
    try {
        const code = ownValue(error, "code")
        if (code === "EACCES" || code === "EPERM") {
            return new CredentialError("denied")
        }
        if (connecting && (code === "ENOENT" || code === "ECONNREFUSED")) {
            return new CredentialError("unavailable")
        }
    } catch {
        return new CredentialError("failed")
    }
    return new CredentialError("failed")
}

function cleanupError(error: unknown): CredentialError {
    const sanitized = sanitizedError(error)
    return sanitized.code === "denied" || sanitized.code === "locked"
        ? sanitized
        : new CredentialError("failed")
}

function resolveTimeout(options: LinuxSecretServiceProviderOptions | undefined): number {
    try {
        if (options !== undefined && (typeof options !== "object" || options === null)) {
            throw new CredentialError("invalid")
        }
        const value = options?.timeoutMs
        const timeout = value === undefined ? DEFAULT_TIMEOUT_MS : value
        if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
            throw new CredentialError("invalid")
        }
        return timeout
    } catch {
        throw new CredentialError("invalid")
    }
}

function validateIdentity(kind: CredentialKind, id: string): void {
    if ((kind !== "ssh" && kind !== "db" && kind !== "rest") || typeof id !== "string") {
        throw new CredentialError("invalid")
    }
    try {
        if (normalizeEnvKey(id) !== id) {
            throw new CredentialError("invalid")
        }
    } catch {
        throw new CredentialError("invalid")
    }
}

function parseBusAddress(address: string): string {
    const addresses = address.split(";")
    const parsed: { transport: string; values: Map<string, string> }[] = []
    for (const entry of addresses) {
        const separator = entry.indexOf(":")
        const transport = entry.slice(0, separator)
        if (separator <= 0 || /[^A-Za-z0-9_-]/.test(transport)) {
            throw new CredentialError("invalid")
        }
        const values = new Map<string, string>()
        const parameters = entry.slice(separator + 1)
        for (const pair of parameters === "" ? [] : parameters.split(",")) {
            const equals = pair.indexOf("=")
            const key = pair.slice(0, equals)
            const encoded = pair.slice(equals + 1)
            const escaped = /^(?:[A-Za-z0-9_/.\\*-]|%[A-Fa-f0-9]{2})*$/.exec(encoded)
            if (equals <= 0 || /[^A-Za-z0-9_-]/.test(key) || values.has(key) || escaped?.[0] !== encoded) {
                throw new CredentialError("invalid")
            }
            let value: string
            try {
                value = decodeURIComponent(encoded)
            } catch {
                throw new CredentialError("invalid")
            }
            if (value.includes("\0")) {
                throw new CredentialError("invalid")
            }
            values.set(key, value)
        }
        const guid = values.get("guid")
        if (guid !== undefined && (guid.length !== 32 || /[^A-Fa-f0-9]/.test(guid))) {
            throw new CredentialError("invalid")
        }
        parsed.push({ transport, values })
    }
    if (parsed.length !== 1 || parsed[0].transport !== "unix") {
        throw new CredentialError("unsupported")
    }
    const values = parsed[0].values
    if (values.has("path") && values.has("socket")) {
        throw new CredentialError("invalid")
    }
    for (const key of values.keys()) {
        if (key !== "path" && key !== "socket" && key !== "guid") {
            throw new CredentialError("unsupported")
        }
    }
    const path = values.get("path") ?? values.get("socket")
    if (path === undefined) {
        throw new CredentialError("unsupported")
    }
    if (path.length === 0) {
        throw new CredentialError("invalid")
    }
    if (!path.startsWith("/") || /[;,:=]/.test(path)) {
        throw new CredentialError("unsupported")
    }
    // The internal parser neither unescapes values nor safely carries decoded delimiters.
    return `unix:socket=${path}`
}

function isUniqueName(value: unknown): value is string {
    return typeof value === "string" && value.length <= 255 && value === value.trim()
        && /^:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(value)
}

function isObjectPath(value: unknown): value is string {
    if (typeof value !== "string" || !value.startsWith("/")) {
        return false
    }
    if (value === "/") {
        return true
    }
    for (const segment of value.slice(1).split("/")) {
        if (segment.length === 0 || /[^A-Za-z0-9_]/.test(segment)) {
            return false
        }
    }
    return true
}

function isSerial(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0xffffffff
}

function remoteError(name: unknown, ownerLookup: boolean): CredentialError {
    if (name === "org.freedesktop.DBus.Error.AccessDenied") {
        return new CredentialError("denied")
    }
    if (name === "org.freedesktop.Secret.Error.IsLocked") {
        return new CredentialError("locked")
    }
    if (ownerLookup && (name === "org.freedesktop.DBus.Error.NameHasNoOwner"
        || name === "org.freedesktop.DBus.Error.ServiceUnknown")) {
        return new CredentialError("unavailable")
    }
    return new CredentialError("failed")
}

function wipeBytes(value: unknown): void {
    try {
        if (types.isUint8Array(value)) {
            Uint8Array.prototype.fill.call(value, 0)
        } else if (Array.isArray(value)) {
            Array.prototype.fill.call(value, 0)
        }
    } catch {
        // Immutable or detached storage cannot be cleared reliably.
    }
}

function wipeReplySecretBytes(body: unknown): void {
    const tuple = ownValue(body, "0")
    if (Array.isArray(body) && Array.isArray(tuple)) {
        wipeBytes(ownValue(tuple, "2"))
    }
}

function ignoreTransportError(_error: unknown): void {}

class SecretServiceBus {
    private connection?: RawConnection
    private inputGuard?: DbusInputGuard
    private overallTimer?: ReturnType<typeof setTimeout>
    private connectResolve?: () => void
    private connectReject?: (error: CredentialError) => void
    private readonly pending = new Map<number, PendingCall>()
    private readonly onConnectBound: () => void
    private readonly onMessageBound: (message: unknown) => void
    private readonly onErrorBound: (error: unknown) => void
    private readonly onEndBound: () => void
    private readonly onCloseBound: () => void
    private nextSerial = 1
    private connected = false
    private stopping = false
    private timedOut = false
    private failure?: CredentialError

    constructor(private readonly runtime: DbusRuntime, private readonly deadline: number) {
        this.onConnectBound = this.onConnect.bind(this)
        this.onMessageBound = this.onMessage.bind(this)
        this.onErrorBound = this.onError.bind(this)
        this.onEndBound = this.onEnd.bind(this)
        this.onCloseBound = this.onClose.bind(this)
    }

    async connect(address: string): Promise<void> {
        this.assertPrimary()
        this.overallTimer = setTimeout((): void => {
            this.timedOut = true
            const error = new CredentialError("failed")
            this.rejectConnect(error)
            this.rejectPending(error)
        }, Math.max(1, this.deadline - performance.now()))
        return new Promise<void>((resolve, reject): void => {
            this.connectResolve = resolve
            this.connectReject = reject
            try {
                this.connection = this.runtime.createConnection({
                    busAddress: address,
                    authMethods: ["EXTERNAL"],
                    negotiateUnixFd: false,
                })
                this.inputGuard = new DbusInputGuard(this.connection.stream, (): void => {
                    this.fail(new CredentialError("failed"))
                })
                this.connection.on("error", this.onErrorBound)
                this.connection.stream.on("error", this.onErrorBound)
                this.connection.on("end", this.onEndBound)
                this.connection.stream.once("close", this.onCloseBound)
                this.connection.on("connect", this.onConnectBound)
                this.connection.on("message", this.onMessageBound)
            } catch (error: unknown) {
                this.fail(transportError(error, true))
            }
        })
    }

    isLive(): boolean {
        return this.connected && !this.stopping && this.connection !== undefined
            && !this.connection.stream.destroyed && !this.connection.stream.readableEnded
            && !this.connection.stream.writableEnded
    }

    assertTransport(): void {
        if (this.failure !== undefined) {
            throw sanitizedError(this.failure)
        }
        if (!this.isLive()) {
            throw new CredentialError("failed")
        }
    }

    assertPrimary(): void {
        if (this.failure !== undefined) {
            throw sanitizedError(this.failure)
        }
        if (this.timedOut || performance.now() >= this.deadline) {
            throw new CredentialError("failed")
        }
    }

    stopPrimaryTimer(): void {
        clearTimeout(this.overallTimer)
        this.overallTimer = undefined
    }

    async call(call: RemoteCall, cleanup = false): Promise<unknown[]> {
        if (!cleanup) {
            this.assertPrimary()
        }
        const connection = this.connection
        if (!this.isLive() || connection === undefined) {
            throw new CredentialError("failed")
        }
        const serial = this.nextSerial++
        return new Promise<unknown[]>((resolve, reject): void => {
            const pending: PendingCall = { call, resolve, reject }
            this.pending.set(serial, pending)
            if (cleanup) {
                pending.timer = setTimeout((): void => {
                    this.pending.delete(serial)
                    reject(new CredentialError("failed"))
                }, CLEANUP_TIMEOUT_MS)
            }
            try {
                connection.message(new this.runtime.Message({
                    type: METHOD_CALL,
                    serial,
                    destination: call.destination,
                    path: call.path,
                    interface: call.interface,
                    member: call.member,
                    signature: call.signature,
                    body: call.body,
                    flags: NO_AUTO_START,
                }))
            } catch (error: unknown) {
                this.fail(transportError(error, false))
            }
        })
    }

    dispose(): CredentialError | undefined {
        this.stopping = true
        this.inputGuard?.stop()
        this.stopPrimaryTimer()
        this.rejectConnect(new CredentialError("failed"))
        this.rejectPending(new CredentialError("failed"))
        try {
            this.connection?.stream.destroy()
        } catch {
            return new CredentialError("failed")
        }
        return undefined
    }

    private rejectConnect(error: CredentialError): void {
        const reject = this.connectReject
        this.connectResolve = undefined
        this.connectReject = undefined
        reject?.(error)
    }

    private rejectPending(error: CredentialError): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer)
            pending.reject(error)
        }
        this.pending.clear()
    }

    private fail(error: CredentialError): void {
        this.inputGuard?.stop()
        this.connected = false
        this.failure ??= error
        this.rejectConnect(this.failure)
        this.rejectPending(this.failure)
    }

    private onConnect(): void {
        this.inputGuard?.activate()
        if (this.stopping || this.timedOut || this.failure !== undefined) {
            return
        }
        this.connected = true
        const resolve = this.connectResolve
        this.connectResolve = undefined
        this.connectReject = undefined
        resolve?.()
    }

    private onError(error: unknown): void {
        const connecting = !this.connected
        this.connected = false
        this.fail(transportError(error, connecting))
    }

    private onEnd(): void {
        this.connected = false
        if (!this.stopping) {
            this.fail(new CredentialError("failed"))
        }
    }

    private onClose(): void {
        this.connected = false
        if (!this.stopping) {
            this.fail(new CredentialError("failed"))
        }
        const connection = this.connection
        if (connection === undefined) {
            return
        }
        // Retain stateless sinks for delayed authentication/socket callbacks after close.
        connection.on("error", ignoreTransportError)
        connection.stream.on("error", ignoreTransportError)
        connection.off("error", this.onErrorBound)
        connection.stream.off("error", this.onErrorBound)
        connection.off("connect", this.onConnectBound)
        connection.off("message", this.onMessageBound)
        connection.off("end", this.onEndBound)
        connection.stream.off("close", this.onCloseBound)
    }

    private onMessage(message: unknown): void {
        try {
            this.dispatchMessage(message)
        } catch {
            wipeReplySecretBytes(ownValue(message, "body"))
            this.fail(new CredentialError("failed"))
        }
    }

    private dispatchMessage(message: unknown): void {
        const type = ownValue(message, "type")
        const body = ownValue(message, "body")
        if (!isSerial(ownValue(message, "serial"))) {
            throw new CredentialError("failed")
        }
        if (type === METHOD_CALL || type === SIGNAL) {
            wipeReplySecretBytes(body)
            return
        }
        const serial = ownValue(message, "replySerial")
        if ((type !== METHOD_RETURN && type !== ERROR_REPLY) || !isSerial(serial)) {
            throw new CredentialError("failed")
        }
        const pending = this.pending.get(serial)
        if (pending === undefined) {
            wipeReplySecretBytes(body)
            return
        }
        const sender = ownValue(message, "sender")
        const signature = ownValue(message, "signature")
        // Bus-generated errors are trusted; successful service replies require the pinned owner.
        if ((sender !== pending.call.destination && !(type === ERROR_REPLY && sender === BUS_NAME))
            || !Array.isArray(body)) {
            throw new CredentialError("failed")
        }
        if (type === METHOD_RETURN) {
            if (signature !== pending.call.replySignature || body.length !== pending.call.replyLength) {
                throw new CredentialError("failed")
            }
        } else if (!((signature === "" && body.length === 0)
            || (signature === "s" && body.length === 1 && typeof body[0] === "string"))) {
            throw new CredentialError("failed")
        }
        this.pending.delete(serial)
        clearTimeout(pending.timer)
        if (type === ERROR_REPLY) {
            wipeReplySecretBytes(body)
            pending.reject(remoteError(ownValue(message, "errorName"), pending.call.nameOwnerLookup === true))
        } else {
            pending.resolve(body)
        }
    }
}

function variantValue(value: unknown, signature: string): unknown {
    if (Array.isArray(value) || ownValue(value, "signature") !== signature) {
        throw new CredentialError("invalid")
    }
    return ownValue(value, "value")
}

function selectedItem(body: unknown[]): string | undefined {
    const [unlocked, locked] = body
    if (!Array.isArray(unlocked) || !Array.isArray(locked)) {
        throw new CredentialError("invalid")
    }
    for (const paths of [unlocked, locked]) {
        for (const path of paths) {
            if (!isObjectPath(path) || path === "/") {
                throw new CredentialError("invalid")
            }
        }
    }
    const count = unlocked.length + locked.length
    if (count > 1) {
        throw new CredentialError("invalid")
    }
    if (locked.length !== 0) {
        // Never unlock or prompt, including when the only matching item is locked.
        throw new CredentialError("locked")
    }
    return count === 0 ? undefined : unlocked[0] as string
}

function validateAttributes(value: unknown, attributes: Record<string, string>): void {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new CredentialError("invalid")
    }
    const prototype: unknown = Object.getPrototypeOf(value)
    if ((prototype !== Object.prototype && prototype !== null)
        || Reflect.ownKeys(value).length !== Object.keys(attributes).length) {
        throw new CredentialError("invalid")
    }
    for (const [key, expected] of Object.entries(attributes)) {
        if (ownValue(value, key) !== expected) {
            throw new CredentialError("invalid")
        }
    }
}

function listedItemPaths(body: unknown[]): string[] {
    const [unlocked, locked] = body
    if (!Array.isArray(unlocked) || !Array.isArray(locked) || unlocked.length > MAX_LINUX_ENUMERATED_PROFILES) {
        throw new CredentialError("too_large")
    }
    for (const itemPath of [...unlocked, ...locked]) {
        if (!isObjectPath(itemPath) || itemPath === "/") {
            throw new CredentialError("invalid")
        }
    }
    if (new Set([...unlocked, ...locked]).size !== unlocked.length + locked.length) {
        throw new CredentialError("invalid")
    }
    return unlocked as string[]
}

function listedProfileId(value: unknown, kind: CredentialKind): string {
    if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value)) {
        throw new CredentialError("invalid")
    }
    const attributes = value as Record<string, unknown>
    const prototype = Object.getPrototypeOf(attributes)
    if ((prototype !== Object.prototype && prototype !== null)
        || Reflect.ownKeys(attributes).length !== 3
        || ownValue(attributes, "application") !== "autocode"
        || ownValue(attributes, "kind") !== kind) {
        throw new CredentialError("invalid")
    }
    const id = ownValue(attributes, "profile")
    if (typeof id !== "string" || normalizeEnvKey(id) !== id) {
        throw new CredentialError("invalid")
    }
    return id
}

function secretBytes(value: unknown): Uint8Array | number[] {
    if (!types.isUint8Array(value) && !Array.isArray(value)) {
        throw new CredentialError("invalid")
    }
    const length: unknown = Array.isArray(value)
        ? value.length
        : Reflect.get(Uint8Array.prototype, "byteLength", value)
    if (typeof length !== "number") {
        throw new CredentialError("invalid")
    }
    if (length > MAX_CREDENTIAL_ENVELOPE_BYTES) {
        throw new CredentialError("too_large")
    }
    if (Array.isArray(value)) {
        for (const byte of value) {
            if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
                throw new CredentialError("invalid")
            }
        }
        return value as number[]
    }
    return value
}

function parseSecret(kind: CredentialKind, body: unknown[], session: string): unknown {
    const tuple: unknown = body[0]
    const rawBytes: unknown = Array.isArray(tuple) ? tuple[2] : undefined
    let bytes: Uint8Array | undefined
    try {
        if (!Array.isArray(tuple) || tuple.length !== 4 || tuple[0] !== session) {
            throw new CredentialError("invalid")
        }
        const parameters: unknown = tuple[1]
        if ((!types.isUint8Array(parameters) && !Array.isArray(parameters)) || parameters.length !== 0) {
            throw new CredentialError("invalid")
        }
        const checked = secretBytes(rawBytes)
        const contentType: unknown = tuple[3]
        if (typeof contentType !== "string"
            || !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(contentType.trim())) {
            throw new CredentialError("invalid")
        }
        bytes = Array.isArray(checked) ? Uint8Array.from(checked) : checked
        // Native records are UTF-8 JSON {version:1,kind,fields}, <=65536 bytes, application/json (optional charset=utf-8).
        return parseCredentialEnvelope(kind, bytes, MAX_CREDENTIAL_ENVELOPE_BYTES)
    } finally {
        wipeBytes(bytes)
        wipeBytes(rawBytes)
    }
}

async function readLinuxCredential(
    kind: CredentialKind,
    normalizedId: string,
    address: string,
    timeoutMs: number,
): Promise<CredentialReadResult> {
    const deadline = performance.now() + timeoutMs
    // Pin dbus-next 0.10.2's internal seam: public sessionBus has unsafe Hello/disconnect lifecycle.
    const require = createRequire(import.meta.url)
    const module: unknown = require("dbus-next")
    const createConnection: unknown = require("dbus-next/lib/connection")
    const Message = ownValue(module, "Message")
    const Variant = ownValue(module, "Variant")
    if (typeof createConnection !== "function" || typeof Message !== "function" || typeof Variant !== "function") {
        throw new CredentialError("failed")
    }
    const runtime = { createConnection, Message, Variant } as DbusRuntime
    const bus = new SecretServiceBus(runtime, deadline)
    let owner: string | undefined
    let session: string | undefined
    let result: CredentialReadResult | undefined
    let failure: CredentialError | undefined
    try {
        await bus.connect(address)
        const hello = await bus.call({
            destination: BUS_NAME,
            path: BUS_PATH,
            interface: BUS_NAME,
            member: "Hello",
            signature: "",
            body: [],
            replySignature: "s",
            replyLength: 1,
        })
        if (!isUniqueName(hello[0])) {
            throw new CredentialError("failed")
        }
        const ownerReply = await bus.call({
            destination: BUS_NAME,
            path: BUS_PATH,
            interface: BUS_NAME,
            member: "GetNameOwner",
            signature: "s",
            body: [SERVICE_NAME],
            replySignature: "s",
            replyLength: 1,
            nameOwnerLookup: true,
        })
        if (!isUniqueName(ownerReply[0])) {
            throw new CredentialError("failed")
        }
        owner = ownerReply[0]
        // Native items must have exactly application=autocode, kind=<kind>, profile=<normalizedId>.
        const attributes = { application: "autocode", kind, profile: normalizedId }
        const search = await bus.call({
            destination: owner,
            path: SERVICE_PATH,
            interface: SERVICE_INTERFACE,
            member: "SearchItems",
            signature: "a{ss}",
            body: [attributes],
            replySignature: "aoao",
            replyLength: 2,
        })
        const item = selectedItem(search)
        if (item === undefined) {
            result = { status: "missing" }
        } else {
            const locked = await bus.call({
                destination: owner,
                path: item,
                interface: PROPERTIES_INTERFACE,
                member: "Get",
                signature: "ss",
                body: [ITEM_INTERFACE, "Locked"],
                replySignature: "v",
                replyLength: 1,
            })
            const lockedValue = variantValue(locked[0], "b")
            if (typeof lockedValue !== "boolean") {
                throw new CredentialError("invalid")
            }
            if (lockedValue) {
                throw new CredentialError("locked")
            }
            const itemAttributes = await bus.call({
                destination: owner,
                path: item,
                interface: PROPERTIES_INTERFACE,
                member: "Get",
                signature: "ss",
                body: [ITEM_INTERFACE, "Attributes"],
                replySignature: "v",
                replyLength: 1,
            })
            validateAttributes(variantValue(itemAttributes[0], "a{ss}"), attributes)
            // Plain session bytes stay on the current-login local bus, never in argv/env/logs.
            const opened = await bus.call({
                destination: owner,
                path: SERVICE_PATH,
                interface: SERVICE_INTERFACE,
                member: "OpenSession",
                signature: "sv",
                body: ["plain", new runtime.Variant("s", "")],
                replySignature: "vo",
                replyLength: 2,
            })
            if (!isObjectPath(opened[1]) || opened[1] === "/") {
                throw new CredentialError("invalid")
            }
            session = opened[1]
            if (variantValue(opened[0], "s") !== "") {
                throw new CredentialError("invalid")
            }
            const secret = await bus.call({
                destination: owner,
                path: item,
                interface: ITEM_INTERFACE,
                member: "GetSecret",
                signature: "o",
                body: [session],
                replySignature: "(oayays)",
                replyLength: 1,
            })
            result = { status: "found", profile: parseSecret(kind, secret, session) }
        }
        bus.assertPrimary()
    } catch (error: unknown) {
        failure = sanitizedError(error)
    } finally {
        bus.stopPrimaryTimer()
        if (session !== undefined && owner !== undefined) {
            if (bus.isLive()) {
                try {
                    await bus.call({
                        destination: owner,
                        path: session,
                        interface: "org.freedesktop.Secret.Session",
                        member: "Close",
                        signature: "",
                        body: [],
                        replySignature: "",
                        replyLength: 0,
                    }, true)
                    bus.assertTransport()
                } catch (error: unknown) {
                    failure ??= cleanupError(error)
                }
            } else {
                failure ??= new CredentialError("failed")
            }
        }
        const disposalFailure = bus.dispose()
        failure ??= disposalFailure
    }
    if (failure !== undefined) {
        throw failure
    }
    if (result === undefined) {
        throw new CredentialError("failed")
    }
    return result
}

async function enumerateLinuxCredentialIds(
    kind: CredentialKind,
    address: string,
    timeoutMs: number,
): Promise<string[]> {
    const deadline = performance.now() + timeoutMs
    const require = createRequire(import.meta.url)
    const module: unknown = require("dbus-next")
    const createConnection: unknown = require("dbus-next/lib/connection")
    const Message = ownValue(module, "Message")
    const Variant = ownValue(module, "Variant")
    if (typeof createConnection !== "function" || typeof Message !== "function" || typeof Variant !== "function") {
        throw new CredentialError("failed")
    }
    const runtime = { createConnection, Message, Variant } as DbusRuntime
    const bus = new SecretServiceBus(runtime, deadline)
    let owner: string | undefined
    let result: string[] | undefined
    let failure: CredentialError | undefined
    try {
        await bus.connect(address)
        const hello = await bus.call({
            destination: BUS_NAME,
            path: BUS_PATH,
            interface: BUS_NAME,
            member: "Hello",
            signature: "",
            body: [],
            replySignature: "s",
            replyLength: 1,
        })
        if (!isUniqueName(hello[0])) {
            throw new CredentialError("failed")
        }
        const ownerReply = await bus.call({
            destination: BUS_NAME,
            path: BUS_PATH,
            interface: BUS_NAME,
            member: "GetNameOwner",
            signature: "s",
            body: [SERVICE_NAME],
            replySignature: "s",
            replyLength: 1,
            nameOwnerLookup: true,
        })
        if (!isUniqueName(ownerReply[0])) {
            throw new CredentialError("failed")
        }
        owner = ownerReply[0]
        const queryAttributes = { application: "autocode", kind }
        const search = await bus.call({
            destination: owner,
            path: SERVICE_PATH,
            interface: SERVICE_INTERFACE,
            member: "SearchItems",
            signature: "a{ss}",
            body: [queryAttributes],
            replySignature: "aoao",
            replyLength: 2,
        })
        const itemPaths = listedItemPaths(search)
        const ids = new Set<string>()
        for (const itemPath of itemPaths) {
            const itemAttributes = await bus.call({
                destination: owner,
                path: itemPath,
                interface: PROPERTIES_INTERFACE,
                member: "Get",
                signature: "ss",
                body: [ITEM_INTERFACE, "Attributes"],
                replySignature: "v",
                replyLength: 1,
            })
            ids.add(listedProfileId(variantValue(itemAttributes[0], "a{ss}"), kind))
        }
        bus.assertPrimary()
        result = [...ids].sort()
    } catch (error: unknown) {
        failure = sanitizedError(error)
    } finally {
        bus.stopPrimaryTimer()
        const disposalFailure = bus.dispose()
        failure ??= disposalFailure
    }
    if (failure !== undefined) {
        throw failure
    }
    if (result === undefined) {
        throw new CredentialError("failed")
    }
    return result
}

// Linux UNVALIDATED; only the current-login filesystem session bus is supported, never discovery or autolaunch.
// Static-only socket preflight caps auth at 16 KiB, fields at 64 KiB, frames at 2 MiB, and connection input at 8 MiB/256 frames.
// Signature/value depth is capped at 32 and work at 262144/frame and 1048576/connection; Linux runtime/mock validation is deferred.
// System services may have a different identity/session bus; this provider does not select one for them.
export function createLinuxSecretServiceProvider(options?: LinuxSecretServiceProviderOptions): CredentialProvider {
    const timeoutMs = resolveTimeout(options)
    return {
        async read(kind: CredentialKind, normalizedId: string): Promise<CredentialReadResult> {
            validateIdentity(kind, normalizedId)
            if (process.platform !== "linux") {
                return { status: "unavailable" }
            }
            try {
                const address = process.env.DBUS_SESSION_BUS_ADDRESS
                if (address === undefined || address === "") {
                    return { status: "unavailable" }
                }
                return await readLinuxCredential(kind, normalizedId, parseBusAddress(address), timeoutMs)
            } catch (error: unknown) {
                const sanitized = sanitizedError(error)
                if (sanitized.code === "unavailable") {
                    return { status: "unavailable" }
                }
                throw sanitized
            }
        },
        async enumerate(kind: CredentialKind): Promise<string[]> {
            if (kind !== "ssh" && kind !== "db" && kind !== "rest") {
                throw new CredentialError("invalid")
            }
            if (process.platform !== "linux") {
                throw new CredentialError("unsupported")
            }
            try {
                const address = process.env.DBUS_SESSION_BUS_ADDRESS
                if (address === undefined || address === "") {
                    throw new CredentialError("unavailable")
                }
                return await enumerateLinuxCredentialIds(kind, parseBusAddress(address), timeoutMs)
            } catch (error: unknown) {
                throw sanitizedError(error)
            }
        },
    }
}
