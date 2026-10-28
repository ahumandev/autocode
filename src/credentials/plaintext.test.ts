import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, unlink, writeFile } from "node:fs/promises"
import { win32 } from "node:path"
import { resolveOpenCodePaths } from "../utils/paths"
import {
    createPlaintextCredentialProvider,
    MAX_PLAINTEXT_STORE_BYTES,
    parsePlaintextCredentialStore,
    readPlaintextCredentialStore,
    resolvePlaintextCredentialStorePath,
    serializePlaintextCredentialStore,
    type PlaintextCredentialOptions,
    type PlaintextCredentialStore,
} from "./plaintext"
import { createCredentialResolver } from "./resolver"
import {
    CredentialError,
    MAX_CREDENTIAL_ENVELOPE_BYTES,
    WINDOWS_CREDENTIAL_MAX_BYTES,
    type CredentialErrorCode,
    type CredentialKind,
    type CredentialProfileMap,
} from "./types"
import { validateCredentialProfile } from "./validation"
import { getWindowsCredentialIdentity } from "./windows"
import { writeSecureWindowsFile } from "./windows-files"
import { readWindowsCredentialFailureDiagnostics, WindowsCredentialProcessError } from "./windows-process"

const TEMP_DIRECTORY = "C:\\Users\\qxz13vb\\AppData\\Local\\Temp\\opencode"
const ROOT_PREFIX = "autocode-plaintext-"
const DIAGNOSTIC_PATH = win32.join(TEMP_DIRECTORY, `autocode-plaintext-diagnostics-${randomUUID()}.jsonl`)
const DIAGNOSTIC_STARTED_AT = performance.now()
const MAX_DIAGNOSTIC_STDERR_BYTES = 4096
const DIAGNOSTIC_ERROR_CODES = [
    "locked", "denied", "invalid", "unsafe_location", "too_large", "failed", "missing", "incomplete", "unavailable", "unsupported",
    "EACCES", "EPERM", "ENOENT", "ENOTEMPTY", "EBUSY", "EEXIST", "EIO", "EINVAL", "ENOSPC", "EMFILE", "ENFILE", "ERR_ASSERTION",
] as const
const WINDOWS_ROOT = "C:\\Windows"
const POWERSHELL_PATH = `${WINDOWS_ROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
const TEST_TIMEOUT_MS = 60000
const IDENTITY_TIMEOUT_MS = 30000
const CHILD_TIMEOUT_MS = 10000
const MAX_FIXTURE_OUTPUT_BYTES = 262144
const MAX_FIXTURE_ERROR_DEPTH = 4
const FULL_CONTROL = 2032127
const EVERYONE_SID = "S-1-1-0"
const SECRET_CANARY = "plaintext-test-synthetic-secret-canary"
const PARSER_MARKER = "plaintext-test-parser-marker"
const KINDS = ["ssh", "db", "rest"] as const
const ERROR_MESSAGES: Readonly<Partial<Record<CredentialErrorCode, string>>> = {
    invalid: "Invalid credential profile, storage, or ID.",
    denied: "Credential access denied.",
    too_large: "Credential exceeds the supported size limit.",
    incomplete: "Credential profile is incomplete.",
    missing: "Credential profile is missing.",
    unsafe_location: "Plaintext credential storage must use a private global configuration directory outside workspaces and Git repositories. Set OPENCODE_CONFIG_DIR to a private user directory.",
}
const COMPLETE_PROFILES = {
    ssh: {
        host: "  gateway.example.test  ",
        username: "  operator  ",
        port: " 0022 ",
        keyfile: " C:\\synthetic keys\\clé ",
        agent: " false ",
        password: "",
        keypass: `\t${SECRET_CANARY}\r\n漢字 😀\0`,
    },
    db: {
        connection: "  jdbc:postgresql://localhost:05432/app?ssl=false  ",
        username: "",
        password: ` ${SECRET_CANARY}\r\n `,
    },
    rest: {
        authorization: ` Bearer ${SECRET_CANARY} `,
        username: "",
        password: "\t ",
    },
} satisfies CredentialProfileMap

interface AclMetadata {
    ownerSid: string
    protected: boolean
    sddl: string
    rules: {
        sid: string
        type: string
        rights: number
        inherited: boolean
        inheritance: number
        propagation: number
    }[]
}

interface TreeEntry {
    path: string
    directory: boolean
    reparse: boolean
    mtimeNs: bigint
    size: bigint
    digest?: string
    acl?: AclMetadata
}

interface PlaintextFixture {
    root: string
    junctions: string[]
    ownershipToken: string
    startedAt: number
}

type FixturePhase = "beforeAll-start" | "beforeAll-done" | "fixture-created"
    | "sentinel-start" | "sentinel-done" | "action-start" | "action-done"
    | "cleanup-start" | "cleanup-junctions-start" | "cleanup-junctions-done"
    | "cleanup-root-start" | "cleanup-root-done" | "cleanup-done" | "afterAll-start" | "afterAll-done"

interface FixtureFailure {
    role: "primary" | "cleanup"
    phase: FixturePhase
    elapsedMs: number
    errorClass: "WindowsCredentialProcessError" | "CredentialError" | "Error" | "unknown"
    code?: (typeof DIAGNOSTIC_ERROR_CODES)[number]
    nativeCode?: number
    errno?: number
    windows?: ReturnType<typeof readWindowsCredentialFailureDiagnostics>
}

let expectedSid = ""
let diagnosticArtifactState: "new" | "owned" | "disabled" = "new"

function storeWithProfile(kind: CredentialKind, fields: unknown, id: string = "PROFILE"): unknown {
    return { version: 1, profiles: { [kind]: { [id]: fields } } }
}

function createStoreLayers(): { store: PlaintextCredentialStore; layers: { value: object; key: string }[] } {
    const fields = { ...COMPLETE_PROFILES.ssh }
    const ids = { PROFILE: fields }
    const profiles = { ssh: ids }
    const store: PlaintextCredentialStore = { version: 1, profiles }
    return { store, layers: [
        { value: store, key: "profiles" },
        { value: profiles, key: "ssh" },
        { value: ids, key: "PROFILE" },
        { value: fields, key: "host" },
    ] }
}

function replaceStoreLayer(index: number, replace: (value: object) => unknown): unknown {
    const { store, layers } = createStoreLayers()
    const replacement = replace(layers[index].value)
    if (index === 0) return replacement
    Reflect.set(layers[index - 1].value, layers[index - 1].key, replacement)
    return store
}

function assertCredentialError(error: unknown, code: CredentialErrorCode, forbidden: readonly string[] = []): void {
    expect(error instanceof CredentialError).toBe(true)
    if (!(error instanceof CredentialError)) throw new Error("Expected sanitized CredentialError.")
    expect(error.constructor === CredentialError).toBe(true)
    expect(error.code).toBe(code)
    expect(error.name).toBe("CredentialError")
    expect(error.message === ERROR_MESSAGES[code]).toBe(true)
    expect(error.cause === undefined).toBe(true)
    expect(Object.hasOwn(error, "cause")).toBe(false)
    expect(Object.hasOwn(error, "nativeCode")).toBe(false)
    for (const marker of [SECRET_CANARY, PARSER_MARKER, "SyntaxError", "Unexpected token"]) {
        expect(`${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`.includes(marker)).toBe(false)
    }
    for (const marker of forbidden) expect(error.message.includes(marker)).toBe(false)
}

function expectCredentialError(action: () => unknown, code: CredentialErrorCode = "invalid"): void {
    try { action() } catch (error: unknown) {
        assertCredentialError(error, code)
        return
    }
    throw new Error("Expected CredentialError to be thrown.")
}

async function expectAsyncCredentialError(
    action: () => Promise<unknown>,
    code: CredentialErrorCode,
    forbidden: readonly string[] = [],
): Promise<void> {
    try { await action() } catch (error: unknown) {
        assertCredentialError(error, code, forbidden)
        return
    }
    throw new Error("Expected CredentialError to be thrown.")
}

function sizedString(bytes: number, character: string): string {
    const encodedBytes = Buffer.byteLength(JSON.stringify(character).slice(1, -1), "utf8")
    return character.repeat(Math.floor(bytes / encodedBytes)) + "a".repeat(bytes % encodedBytes)
}

function sizedProfile(kind: CredentialKind, bytes: number, character: string): Record<string, string> {
    const field = kind === "ssh" ? "host" : kind === "db" ? "connection" : "authorization"
    const fields = { [field]: "" }
    const overhead = Buffer.byteLength(JSON.stringify({ version: 1, kind, fields }), "utf8")
    fields[field] = sizedString(bytes - overhead, character)
    expect(Buffer.byteLength(JSON.stringify({ version: 1, kind, fields }), "utf8")).toBe(bytes)
    return fields
}

function sizedStore(bytes: number, character: string): PlaintextCredentialStore {
    const profiles: Record<string, { authorization: string }> = {}
    // Seventeen profiles reach the file cap without exceeding any individual envelope cap.
    for (let index = 0; index < 17; index++) profiles[`PROFILE_${index}`] = { authorization: "" }
    const store: PlaintextCredentialStore = { version: 1, profiles: { rest: profiles } }
    let remaining = bytes - Buffer.byteLength(JSON.stringify(store), "utf8")
    const envelopeOverhead = Buffer.byteLength(JSON.stringify({ version: 1, kind: "rest", fields: { authorization: "" } }), "utf8")
    for (const fields of Object.values(profiles)) {
        const available = Math.min(remaining, MAX_CREDENTIAL_ENVELOPE_BYTES - envelopeOverhead)
        fields.authorization = sizedString(available, character)
        remaining -= available
    }
    expect(remaining).toBe(0)
    expect(Buffer.byteLength(JSON.stringify(store), "utf8")).toBe(bytes)
    return store
}

describe("plaintext credential parser and serializer", (): void => {
    for (const kind of KINDS) {
        test(`${kind}: preserves every raw string without defaults or normalization`, (): void => {
            const source = storeWithProfile(kind, COMPLETE_PROFILES[kind])
            const contents = JSON.stringify(source)
            const parsed = parsePlaintextCredentialStore(contents)
            expect(JSON.stringify(parsed) === contents).toBe(true)
            expect(serializePlaintextCredentialStore(source) === contents).toBe(true)
            expect(serializePlaintextCredentialStore(parsed) === contents).toBe(true)
            expect(parsed.profiles[kind]?.PROFILE === COMPLETE_PROFILES[kind]).toBe(false)
        })

        test(`${kind}: permits empty, sparse, and incomplete profiles`, (): void => {
            const inputs = kind === "ssh"
                ? [{}, { host: "" }, { host: " \t\r\n" }, { password: SECRET_CANARY }, { host: "gateway.example.test" }]
                : kind === "db"
                    ? [{}, { connection: "" }, { connection: " \t\r\n" }, { username: "", password: "" }, { connection: "jdbc:test:opaque" }]
                    : [{}, { username: "" }, { password: SECRET_CANARY }, { authorization: "" }, { username: "", password: "" }]
            for (const fields of inputs) {
                const source = storeWithProfile(kind, fields)
                const contents = JSON.stringify(source)
                expect(serializePlaintextCredentialStore(source) === contents).toBe(true)
                expect(JSON.stringify(parsePlaintextCredentialStore(contents)) === contents).toBe(true)
            }
        })

        test(`${kind}: accepts canonical IDs including prototype-like uppercase names`, (): void => {
            for (const id of ["APP", "APP_1", "_", "123", "__PROTO__", "CONSTRUCTOR"]) {
                const contents = JSON.stringify(storeWithProfile(kind, {}, id))
                const parsed = parsePlaintextCredentialStore(contents)
                expect(Object.hasOwn(parsed.profiles[kind] ?? {}, id)).toBe(true)
                expect(serializePlaintextCredentialStore(parsed)).toBe(contents)
            }
        })

        test(`${kind}: rejects noncanonical stored IDs rather than rewriting them`, (): void => {
            for (const id of ["", "app", " App ", "APP-HOST", " APP", "APP ", "APP.X", "A/B", "A\\B", "é", "A\0", "__proto__", "constructor"]) {
                const source = storeWithProfile(kind, { password: SECRET_CANARY }, id)
                expectCredentialError((): string => serializePlaintextCredentialStore(source))
                expectCredentialError((): unknown => parsePlaintextCredentialStore(JSON.stringify(source)))
            }
        })

        test(`${kind}: rejects nonstring values on every supported field`, (): void => {
            for (const field of Object.keys(COMPLETE_PROFILES[kind])) {
                for (const value of [null, false, 0, {}, []]) {
                    const source = storeWithProfile(kind, { ...COMPLETE_PROFILES[kind], [field]: value })
                    expectCredentialError((): string => serializePlaintextCredentialStore(source))
                    expectCredentialError((): unknown => parsePlaintextCredentialStore(JSON.stringify(source)))
                }
                for (const value of [undefined, 1n, Symbol(SECRET_CANARY), (): string => SECRET_CANARY]) {
                    expectCredentialError((): string => serializePlaintextCredentialStore(storeWithProfile(kind, { [field]: value })))
                }
            }
        })

        test(`${kind}: applies the exact full-envelope byte limit, including escaping and UTF-8`, (): void => {
            for (const character of ["a", "é", "😀", "\n", "\"", "\\"]) {
                for (const bytes of [MAX_CREDENTIAL_ENVELOPE_BYTES - 1, MAX_CREDENTIAL_ENVELOPE_BYTES]) {
                    const source = storeWithProfile(kind, sizedProfile(kind, bytes, character))
                    const contents = JSON.stringify(source)
                    expect(serializePlaintextCredentialStore(source) === contents).toBe(true)
                    expect(JSON.stringify(parsePlaintextCredentialStore(contents)) === contents).toBe(true)
                }
                const source = storeWithProfile(kind, sizedProfile(kind, MAX_CREDENTIAL_ENVELOPE_BYTES + 1, character))
                expectCredentialError((): string => serializePlaintextCredentialStore(source), "too_large")
                expectCredentialError((): unknown => parsePlaintextCredentialStore(JSON.stringify(source)), "too_large")
            }
        })
    }

    test("round-trips all kinds together and accepts empty and sparse kind maps", (): void => {
        for (const profiles of [{}, { ssh: {} }, { db: {} }, { rest: {} }, { ssh: {}, db: {}, rest: {} }, {
            ssh: { GATEWAY: COMPLETE_PROFILES.ssh },
            db: { DATABASE: COMPLETE_PROFILES.db },
            rest: { SERVICE: COMPLETE_PROFILES.rest },
        }]) {
            const source = { version: 1, profiles }
            const contents = JSON.stringify(source)
            expect(serializePlaintextCredentialStore(source) === contents).toBe(true)
            expect(JSON.stringify(parsePlaintextCredentialStore(contents)) === contents).toBe(true)
        }
    })

    test("accepts null prototypes at every layer and returns independent safe objects", (): void => {
        const { store, layers } = createStoreLayers()
        for (const { value } of layers) Object.setPrototypeOf(value, null)
        const contents = serializePlaintextCredentialStore(store)
        const parsed = parsePlaintextCredentialStore(contents)
        expect(Object.getPrototypeOf(parsed)).toBeNull()
        expect(Object.getPrototypeOf(parsed.profiles)).toBeNull()
        expect(Object.getPrototypeOf(parsed.profiles.ssh)).toBeNull()
        expect(Object.getPrototypeOf(parsed.profiles.ssh?.PROFILE)).toBeNull()
        Reflect.set(store.profiles.ssh?.PROFILE ?? {}, "host", "changed-source")
        expect(parsed.profiles.ssh?.PROFILE.host === COMPLETE_PROFILES.ssh.host).toBe(true)
        Reflect.set(parsed.profiles.ssh?.PROFILE ?? {}, "password", "changed-copy")
        expect(store.profiles.ssh?.PROFILE.password).toBe("")
    })

    test("rejects malformed JSON with fixed errors and no parser diagnostics", (): void => {
        for (const contents of ["", " ", `{${SECRET_CANARY}:${PARSER_MARKER}}`, `{"version":1,"profiles":{}} ${SECRET_CANARY}`, "{\"version\":1,}", "\uFEFF{\"version\":1,\"profiles\":{}}"])
            expectCredentialError((): unknown => parsePlaintextCredentialStore(contents))
    })

    test("rejects nonstring parser inputs without coercion", (): void => {
        let calls = 0
        const coercible = { toString(): string { calls += 1; return SECRET_CANARY } }
        for (const contents of [undefined, null, false, 1, [], {}, Buffer.from("{}"), coercible])
            expectCredentialError((): unknown => parsePlaintextCredentialStore(contents as unknown as string))
        expect(calls).toBe(0)
    })

    test("rejects non-JSON serializer roots and class instances without coercion", (): void => {
        for (const source of [undefined, 1n, Symbol(SECRET_CANARY), (): string => SECRET_CANARY, new Date(0),
            Object.assign(new (class {})(), { version: 1, profiles: {} })])
            expectCredentialError((): string => serializePlaintextCredentialStore(source))
    })

    test("rejects malformed roots, versions, kind maps, and profile objects", (): void => {
        const sources: unknown[] = [null, [], true, 1, SECRET_CANARY, {}, { version: 1 }, { profiles: {} }]
        for (const version of [undefined, null, "1", 0, 2, false]) sources.push({ version, profiles: {} })
        for (const value of [null, [], SECRET_CANARY, 0, false]) {
            sources.push({ version: 1, profiles: value })
            for (const kind of KINDS) {
                sources.push({ version: 1, profiles: { [kind]: value } })
                sources.push(storeWithProfile(kind, value))
            }
        }
        for (const source of sources) {
            expectCredentialError((): string => serializePlaintextCredentialStore(source))
            expectCredentialError((): unknown => parsePlaintextCredentialStore(JSON.stringify(source)))
        }
    })

    test("rejects unknown and prototype-related keys at root, kind, and field levels", (): void => {
        for (const key of ["unexpected", "__proto__", "constructor", "prototype", "toJSON", "SSH", SECRET_CANARY]) {
            const sources: unknown[] = [
                { version: 1, profiles: {}, [key]: SECRET_CANARY },
                { version: 1, profiles: { [key]: {} } },
                ...KINDS.map((kind: CredentialKind): unknown => storeWithProfile(kind, { [key]: SECRET_CANARY })),
            ]
            for (const source of sources) {
                expectCredentialError((): string => serializePlaintextCredentialStore(source))
                expectCredentialError((): unknown => parsePlaintextCredentialStore(JSON.stringify(source)))
            }
        }
        for (const kind of KINDS) {
            const field = kind === "ssh" ? "connection" : "host"
            const source = storeWithProfile(kind, { [field]: SECRET_CANARY })
            expectCredentialError((): string => serializePlaintextCredentialStore(source))
            expectCredentialError((): unknown => parsePlaintextCredentialStore(JSON.stringify(source)))
        }
    })

    test("rejects accessors and nonenumerable data at every layer without invoking hooks", (): void => {
        let calls = 0
        for (let index = 0; index < 4; index++) {
            const keys = Reflect.ownKeys(createStoreLayers().layers[index].value)
            for (const key of keys) {
                for (const enumerable of [false, true]) {
                    const source = replaceStoreLayer(index, (value: object): object => {
                        Object.defineProperty(value, key, {
                            enumerable,
                            get(): never { calls += 1; throw new Error(`${SECRET_CANARY}:${PARSER_MARKER}`) },
                            set(_value: unknown): void { calls += 1 },
                        })
                        return value
                    })
                    expectCredentialError((): string => serializePlaintextCredentialStore(source))
                }
                const source = replaceStoreLayer(index, (value: object): object => {
                    const descriptor = Object.getOwnPropertyDescriptor(value, key)
                    Object.defineProperty(value, key, { ...descriptor, enumerable: false })
                    return value
                })
                expectCredentialError((): string => serializePlaintextCredentialStore(source))
            }
        }
        expect(calls).toBe(0)
    })

    test("rejects symbol keys and untrusted prototypes at every layer", (): void => {
        for (let index = 0; index < 4; index++) {
            for (const enumerable of [false, true]) {
                const source = replaceStoreLayer(index, (value: object): object => {
                    Object.defineProperty(value, Symbol(SECRET_CANARY), { value: SECRET_CANARY, enumerable })
                    return value
                })
                expectCredentialError((): string => serializePlaintextCredentialStore(source))
            }
            for (const prototype of [{ inherited: SECRET_CANARY }, [], new (class {})()]) {
                const source = replaceStoreLayer(index, (value: object): object => Object.setPrototypeOf(value, prototype))
                expectCredentialError((): string => serializePlaintextCredentialStore(source))
            }
        }
    })

    test("rejects proxies and revoked proxies without executing traps or leaking tainted errors", (): void => {
        let calls = 0
        const tainted = new CredentialError("invalid")
        tainted.message = `${SECRET_CANARY}:${PARSER_MARKER}`
        Object.defineProperty(tainted, "cause", { value: new Error(SECRET_CANARY) })
        for (let index = 0; index < 4; index++) {
            const source = replaceStoreLayer(index, (value: object): object => new Proxy(value, {
                getPrototypeOf(): never { calls += 1; throw tainted },
                ownKeys(): never { calls += 1; throw tainted },
                get(): never { calls += 1; throw tainted },
            }))
            expectCredentialError((): string => serializePlaintextCredentialStore(source))
            const revoked = replaceStoreLayer(index, (value: object): object => {
                const proxy = Proxy.revocable(value, {})
                proxy.revoke()
                return proxy.proxy
            })
            expectCredentialError((): string => serializePlaintextCredentialStore(revoked))
        }
        expect(calls).toBe(0)
    })

    test("never invokes toJSON hooks on store input", (): void => {
        let calls = 0
        for (let index = 0; index < 4; index++) {
            const source = replaceStoreLayer(index, (value: object): object => {
                Reflect.set(value, "toJSON", (): never => { calls += 1; throw new Error(SECRET_CANARY) })
                return value
            })
            expectCredentialError((): string => serializePlaintextCredentialStore(source))
        }
        expect(calls).toBe(0)
    })

    test("an unrelated invalid profile corrupts the whole store", (): void => {
        for (const invalidProfiles of [
            { ssh: { SELECTED: COMPLETE_PROFILES.ssh, OTHER: { password: 7 } } },
            { ssh: { SELECTED: COMPLETE_PROFILES.ssh }, rest: { OTHER: { unknown: SECRET_CANARY } } },
        ]) {
            const source = { version: 1, profiles: invalidProfiles }
            expectCredentialError((): string => serializePlaintextCredentialStore(source))
            expectCredentialError((): unknown => parsePlaintextCredentialStore(JSON.stringify(source)))
        }
    })

    test("enforces total envelope size across multiple individually small fields", (): void => {
        const source = storeWithProfile("rest", { username: "a".repeat(32768), password: "b".repeat(32768) })
        expectCredentialError((): string => serializePlaintextCredentialStore(source), "too_large")
        expectCredentialError((): unknown => parsePlaintextCredentialStore(JSON.stringify(source)), "too_large")
        expectCredentialError((): string => serializePlaintextCredentialStore(storeWithProfile("rest", { authorization: "a".repeat(65537) })), "too_large")
    })

    test("plaintext accepts complete profiles larger than the native Windows credential limit", (): void => {
        expect(WINDOWS_CREDENTIAL_MAX_BYTES).toBe(2560)
        expect(MAX_CREDENTIAL_ENVELOPE_BYTES).toBe(65536)
        const source = storeWithProfile("rest", sizedProfile("rest", WINDOWS_CREDENTIAL_MAX_BYTES + 1, "😀"))
        const contents = serializePlaintextCredentialStore(source)
        expect(JSON.stringify(parsePlaintextCredentialStore(contents)) === contents).toBe(true)
    })

    test("counts all file whitespace and rejects an oversized malformed input before parsing", (): void => {
        expect(MAX_PLAINTEXT_STORE_BYTES).toBe(1048576)
        const contents = '{"version":1,"profiles":{}}'
        const boundary = contents + " ".repeat(MAX_PLAINTEXT_STORE_BYTES - Buffer.byteLength(contents, "utf8"))
        expect(Buffer.byteLength(boundary, "utf8")).toBe(MAX_PLAINTEXT_STORE_BYTES)
        expect(JSON.stringify(parsePlaintextCredentialStore(boundary))).toBe(contents)
        expectCredentialError((): unknown => parsePlaintextCredentialStore(boundary + " "), "too_large")
        expectCredentialError((): unknown => parsePlaintextCredentialStore("x".repeat(MAX_PLAINTEXT_STORE_BYTES + 1)), "too_large")
    })

    test("enforces the exact serialized file cap with ASCII and multibyte profiles", (): void => {
        for (const character of ["a", "é", "😀"]) {
            for (const bytes of [MAX_PLAINTEXT_STORE_BYTES - 1, MAX_PLAINTEXT_STORE_BYTES]) {
                const source = sizedStore(bytes, character)
                const contents = JSON.stringify(source)
                if (character !== "a") expect(contents.length < bytes).toBe(true)
                expect(serializePlaintextCredentialStore(source) === contents).toBe(true)
                expect(JSON.stringify(parsePlaintextCredentialStore(contents)) === contents).toBe(true)
            }
            const source = sizedStore(MAX_PLAINTEXT_STORE_BYTES + 1, character)
            const contents = JSON.stringify(source)
            expectCredentialError((): string => serializePlaintextCredentialStore(source), "too_large")
            expectCredentialError((): unknown => parsePlaintextCredentialStore(contents), "too_large")
        }
    })
})

const INSPECT_ACLS = `
$fixtureStage = 'inspect-acls'
$items = @(
    foreach ($path in $inputData.paths) {
        $acl = Get-Acl -LiteralPath $path
        $rules = @(
            foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
                [ordered]@{
                    sid = $rule.IdentityReference.Value
                    type = $rule.AccessControlType.ToString()
                    rights = [int]$rule.FileSystemRights
                    inherited = $rule.IsInherited
                    inheritance = [int]$rule.InheritanceFlags
                    propagation = [int]$rule.PropagationFlags
                }
            }
        )
        [ordered]@{
            ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
            protected = $acl.AreAccessRulesProtected
            sddl = $acl.GetSecurityDescriptorSddlForm(
                [System.Security.AccessControl.AccessControlSections]::Access -bor
                [System.Security.AccessControl.AccessControlSections]::Owner -bor
                [System.Security.AccessControl.AccessControlSections]::Group)
            rules = $rules
        }
    }
)
$fixtureOutput.WriteLine((ConvertTo-Json -InputObject $items -Depth 6 -Compress))
`

const ADD_EVERYONE_RULE = `
# Limit fixture mutations to access rules without rewriting owner or group metadata.
$path = $inputData.path
$isDirectory = [System.IO.Directory]::Exists($path)
$fixtureStage = 'read-access-acl'
if ($isDirectory) {
    $acl = [System.IO.Directory]::GetAccessControl($path, [System.Security.AccessControl.AccessControlSections]::Access)
}
else {
    $acl = [System.IO.File]::GetAccessControl($path, [System.Security.AccessControl.AccessControlSections]::Access)
}
$fixtureStage = 'add-access-rule'
$everyone = [System.Security.Principal.SecurityIdentifier]::new('${EVERYONE_SID}')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $everyone, [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
$fixtureStage = 'write-access-acl'
if ($isDirectory) { [System.IO.Directory]::SetAccessControl($path, $acl) }
else { [System.IO.File]::SetAccessControl($path, $acl) }
$fixtureOutput.WriteLine('true')
`

const CREATE_JUNCTION = `
$fixtureStage = 'create-junction'
try {
    New-Item -ItemType Junction -Path $inputData.path -Target $inputData.target -ErrorAction Stop | Out-Null
    $fixtureOutput.WriteLine('{"created":true}')
}
catch {
    $exception = $_.Exception
    while ($null -ne $exception) {
        if (($exception.HResult -band 65535) -eq 1314) {
            $fixtureOutput.WriteLine('{"privilegeUnavailable":true}')
            return
        }
        $exception = $exception.InnerException
    }
    throw
}
`

function readFixtureDiagnostics(output: string): { stage: string; category: number; hresults: number[] } | undefined {
    let metadata: unknown
    try { metadata = JSON.parse(output.trim()) } catch { return undefined }
    if (typeof metadata !== "object" || metadata === null || !("fixtureError" in metadata)) return undefined
    const diagnostics = metadata.fixtureError
    if (typeof diagnostics !== "object" || diagnostics === null) return undefined
    const { stage, category, hresults } = diagnostics as Record<string, unknown>
    if (typeof stage !== "string"
        || !/^(?:bootstrap|parse-input|inspect-acls|read-access-acl|add-access-rule|write-access-acl|create-junction)$/.test(stage)
        || typeof category !== "number" || !Number.isInteger(category) || category < 0 || category > 255
        || !Array.isArray(hresults) || hresults.length < 1 || hresults.length > MAX_FIXTURE_ERROR_DEPTH) return undefined
    const codes: number[] = []
    for (const code of hresults) {
        if (typeof code !== "number" || !Number.isInteger(code) || code < -2147483648 || code > 2147483647) return undefined
        codes.push(code)
    }
    return { stage, category, hresults: codes }
}

async function runFixture(fixture: PlaintextFixture, script: string, input: object): Promise<unknown> {
    const wrappedScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$fixtureStage = 'bootstrap'
try {
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    $fixtureInput = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8)
    $fixtureOutput = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $utf8)
    $fixtureOutput.AutoFlush = $true
    $fixtureStage = 'parse-input'
    $inputData = ConvertFrom-Json -InputObject ($fixtureInput.ReadLine())
    ${script}
}
catch {
    $fixtureError = $_
    try {
        $exception = $fixtureError.Exception
        $hresults = @(
            for ($depth = 0; $null -ne $exception -and $depth -lt ${MAX_FIXTURE_ERROR_DEPTH}; $depth++) {
                [int]$exception.HResult
                $exception = $exception.InnerException
            }
        )
        $metadata = @{ fixtureError = @{
            stage = $fixtureStage
            category = [int]$fixtureError.CategoryInfo.Category
            hresults = $hresults
        } }
        $fixtureOutput.WriteLine((ConvertTo-Json -InputObject $metadata -Depth 4 -Compress))
    }
    catch { }
    exit 1
}
`
    let child: ChildProcessWithoutNullStreams
    try {
        child = spawn(POWERSHELL_PATH, [
            "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
            Buffer.from(wrappedScript, "utf16le").toString("base64"),
        ], {
            cwd: fixture.root,
            env: { SystemRoot: WINDOWS_ROOT, WINDIR: WINDOWS_ROOT, TEMP: TEMP_DIRECTORY, TMP: TEMP_DIRECTORY },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            shell: false,
        })
    } catch {
        throw new Error(`Plaintext credential fixture failed; native diagnostics withheld. ${JSON.stringify({ reason: "spawn" })}`)
    }
    let output = ""
    let outputBytes = 0
    let failure: string | undefined
    let closed = false
    function terminate(): void {
        if (closed) return
        try { child.kill("SIGKILL") } catch { failure ??= "termination" }
    }
    function fail(reason: string): void { failure ??= reason; terminate() }
    const timer = setTimeout((): void => fail("timeout"), CHILD_TIMEOUT_MS)
    const shutdown = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve: (result: { code: number | null; signal: NodeJS.Signals | null }) => void): void => {
        child.once("close", (code: number | null, signal: NodeJS.Signals | null): void => {
            closed = true
            clearTimeout(timer)
            child.stdin.destroy()
            resolve({ code, signal })
        })
    })
    child.on("error", (): void => fail("spawn"))
    child.once("spawn", (): void => { if (failure !== undefined) terminate() })
    child.stdin.on("error", (): void => fail("stdin"))
    child.stdout.on("error", (): void => fail("stdout"))
    child.stderr.on("error", (): void => fail("stderr-stream"))
    child.stderr.on("data", (chunk: Buffer): void => { if (chunk.length !== 0) fail("stderr-output") })
    child.stdout.on("data", (chunk: Buffer): void => {
        outputBytes += chunk.byteLength
        if (outputBytes > MAX_FIXTURE_OUTPUT_BYTES) fail("output-limit")
        else output += chunk.toString("utf8")
    })
    try {
        try { child.stdin.end(`${JSON.stringify(input)}\n`) } catch { fail("stdin") }
        const result = await shutdown
        if (failure !== undefined || result.code !== 0 || result.signal !== null) {
            const diagnostics = {
                reason: failure ?? "exit",
                exitCode: result.code,
                signaled: result.signal !== null,
                ...readFixtureDiagnostics(output),
            }
            throw new Error(`Plaintext credential fixture failed; native diagnostics withheld. ${JSON.stringify(diagnostics)}`)
        }
        try { return JSON.parse(output.trim()) } catch { throw new Error("Plaintext credential fixture returned invalid metadata.") }
    } finally {
        terminate()
        await shutdown
    }
}

function storePath(fixture: PlaintextFixture): string {
    return win32.join(fixture.root, "credentials", "profiles.json")
}

function fixtureOptions(fixture: PlaintextFixture): PlaintextCredentialOptions {
    return { globalConfigRoot: fixture.root, expectedSid }
}

async function observeTree(fixture: PlaintextFixture): Promise<TreeEntry[]> {
    const entries: TreeEntry[] = []
    const paths: string[] = []
    async function visit(path: string): Promise<void> {
        const metadata = await lstat(path, { bigint: true })
        const reparse = metadata.isSymbolicLink()
        entries.push({
            path: win32.relative(fixture.root, path),
            directory: metadata.isDirectory(),
            reparse,
            mtimeNs: metadata.mtimeNs,
            size: metadata.size,
            ...(metadata.isFile() ? { digest: createHash("sha256").update(await readFile(path)).digest("hex") } : {}),
        })
        if (!reparse) paths.push(path)
        if (metadata.isDirectory() && !reparse)
            for (const name of (await readdir(path)).sort()) await visit(win32.join(path, name))
    }
    await visit(fixture.root)
    const acls = await runFixture(fixture, INSPECT_ACLS, { paths }) as AclMetadata[]
    expect(Array.isArray(acls)).toBe(true)
    expect(acls.length).toBe(paths.length)
    let index = 0
    for (const entry of entries) if (!entry.reparse) entry.acl = acls[index++]
    return entries
}

function expectOwnerOnly(entries: TreeEntry[], path: string, directory: boolean): void {
    const acl = entries.find((entry: TreeEntry): boolean => entry.path === path)?.acl
    expect(acl !== undefined).toBe(true)
    if (acl === undefined) throw new Error("Missing owned ACL observation.")
    expect(acl.ownerSid === expectedSid).toBe(true)
    expect(acl.protected).toBe(true)
    expect(acl.rules).toEqual([{
        sid: expectedSid,
        type: "Allow",
        rights: FULL_CONTROL,
        inherited: false,
        inheritance: directory ? 3 : 0,
        propagation: 0,
    }])
}

async function provisionStore(fixture: PlaintextFixture, contents: string): Promise<void> {
    await writeSecureWindowsFile(storePath(fixture), contents, MAX_PLAINTEXT_STORE_BYTES, { expectedSid, timeoutMs: CHILD_TIMEOUT_MS })
    const entries = await observeTree(fixture)
    expectOwnerOnly(entries, "credentials", true)
    expectOwnerOnly(entries, "credentials\\profiles.json", false)
}

async function expectAbsent(path: string): Promise<void> {
    try { await lstat(path) } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw new Error("Could not inspect owned fixture path.")
    }
    throw new Error("Expected owned fixture path to remain absent.")
}

function readFixtureFailure(error: unknown, role: FixtureFailure["role"], phase: FixturePhase, fixture: PlaintextFixture): FixtureFailure {
    const failure: FixtureFailure = {
        role, phase, elapsedMs: Math.floor(performance.now() - fixture.startedAt), errorClass: "unknown",
        windows: readWindowsCredentialFailureDiagnostics(error),
    }
    try {
        failure.errorClass = error instanceof WindowsCredentialProcessError ? "WindowsCredentialProcessError"
            : error instanceof CredentialError ? "CredentialError" : error instanceof Error ? "Error" : "unknown"
        if (typeof error === "object" && error !== null) {
            const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value
            failure.code = DIAGNOSTIC_ERROR_CODES.find((known: string): boolean => known === code)
            for (const key of ["nativeCode", "errno"] as const) {
                const value: unknown = Object.getOwnPropertyDescriptor(error, key)?.value
                if (typeof value === "number" && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) failure[key] = value
            }
        }
    } catch { }
    return failure
}

async function recordFixturePhase(phase: FixturePhase, fixture?: PlaintextFixture, failure?: FixtureFailure): Promise<void> {
    const event = {
        artifactPath: DIAGNOSTIC_PATH, phase, elapsedMs: Math.floor(performance.now() - (fixture?.startedAt ?? DIAGNOSTIC_STARTED_AT)),
        ...(fixture ? {
            ownershipToken: fixture.ownershipToken, root: fixture.root, storePath: storePath(fixture),
            junctions: fixture.junctions.filter((junction: string): boolean => win32.dirname(junction) === fixture.root),
        } : {}),
        failure,
    }
    const line = `${JSON.stringify(event)}\n`
    let writeStatus: "written" | "failed" | "disabled" = "disabled"
    if (diagnosticArtifactState !== "disabled") {
        try {
            await appendFile(DIAGNOSTIC_PATH, line, { encoding: "utf8", flag: diagnosticArtifactState === "new" ? "wx" : "a" })
            diagnosticArtifactState = "owned"
            writeStatus = "written"
        } catch {
            // Disable retries after failed exclusive creation or append; never fall back to another path.
            diagnosticArtifactState = "disabled"
            writeStatus = "failed"
        }
    }
    const stderrLine = `${JSON.stringify({ ...event, writeStatus })}\n`
    const boundedLine = Buffer.byteLength(stderrLine, "utf8") <= MAX_DIAGNOSTIC_STDERR_BYTES ? stderrLine
        : `${JSON.stringify({ artifactPath: DIAGNOSTIC_PATH, phase, writeStatus, stderrStatus: "event-too-large" })}\n`
    if (process.stderr.destroyed || !process.stderr.writable) return
    await new Promise<void>((resolve: () => void): void => {
        const absorbError = (): void => { resolve() }
        process.stderr.once("error", absorbError)
        try {
            process.stderr.write(boundedLine, (error?: Error | null): void => {
                if (!error) process.stderr.removeListener("error", absorbError)
                resolve()
            })
        } catch {
            process.stderr.removeListener("error", absorbError)
            resolve()
        }
    })
}

async function withFixture(action: (fixture: PlaintextFixture) => Promise<void>): Promise<void> {
    const root = await mkdtemp(win32.join(TEMP_DIRECTORY, ROOT_PREFIX))
    const fixture: PlaintextFixture = { root, junctions: [], ownershipToken: randomUUID(), startedAt: performance.now() }
    await recordFixturePhase("fixture-created", fixture)
    let phase: FixturePhase = "sentinel-start"
    let primaryError: unknown
    let cleanupError: unknown
    let primaryFailure: FixtureFailure | undefined
    let cleanupFailure: FixtureFailure | undefined
    try {
        await recordFixturePhase(phase, fixture)
        await writeFile(win32.join(root, "sentinel.txt"), SECRET_CANARY, "utf8")
        await recordFixturePhase("sentinel-done", fixture)
        phase = "action-start"
        await recordFixturePhase(phase, fixture)
        await action(fixture)
        await recordFixturePhase("action-done", fixture)
    } catch (error: unknown) {
        primaryError = error
        primaryFailure = readFixtureFailure(error, "primary", phase, fixture)
        await recordFixturePhase(phase, fixture, primaryFailure)
    }
    try {
        phase = "cleanup-start"
        await recordFixturePhase(phase, fixture)
        phase = "cleanup-junctions-start"
        await recordFixturePhase(phase, fixture)
        // Unlink exact owned junction names before recursive cleanup to preserve their targets.
        for (const junction of fixture.junctions) {
            if (win32.dirname(junction) !== root) throw new Error("Unowned junction cleanup path.")
            try {
                const metadata = await lstat(junction)
                if (!metadata.isSymbolicLink() && !metadata.isDirectory()) throw new Error("Unexpected owned junction fixture type.")
                await rmdir(junction)
            } catch (error: unknown) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    cleanupFailure = readFixtureFailure(error, "cleanup", phase, fixture)
                    throw new Error("Owned junction cleanup failed.")
                }
            }
            await expectAbsent(junction)
        }
        await recordFixturePhase("cleanup-junctions-done", fixture)
        phase = "cleanup-root-start"
        await recordFixturePhase(phase, fixture)
        if (win32.dirname(root) !== TEMP_DIRECTORY || !win32.basename(root).startsWith(ROOT_PREFIX)) throw new Error("Unowned fixture cleanup root.")
        await rm(root, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 })
        await expectAbsent(root)
        await recordFixturePhase("cleanup-root-done", fixture)
        await recordFixturePhase("cleanup-done", fixture)
    } catch (error: unknown) {
        cleanupError = error
        cleanupFailure ??= readFixtureFailure(error, "cleanup", phase, fixture)
        await recordFixturePhase(phase, fixture, cleanupFailure)
    }
    if (primaryFailure && cleanupFailure)
        throw Object.assign(new Error("Plaintext credential fixture action and cleanup both failed."), { primary: primaryFailure, cleanup: cleanupFailure })
    if (primaryFailure) throw primaryError
    if (cleanupFailure) throw cleanupError
}

// Disabled: real Windows filesystem/ACL fixture work is slow and emits diagnostic JSONL records.
describe.skip("plaintext credentials on Windows (real ACLs, read-only runtime)", (): void => {
    const originalTemp = process.env.TEMP
    const originalTmp = process.env.TMP
    beforeAll(async (): Promise<void> => {
        await recordFixturePhase("beforeAll-start")
        process.env.TEMP = TEMP_DIRECTORY
        process.env.TMP = TEMP_DIRECTORY
        expectedSid = (await getWindowsCredentialIdentity({ timeoutMs: IDENTITY_TIMEOUT_MS })).sid
        expect(/^S-1-/.test(expectedSid)).toBe(true)
        await recordFixturePhase("beforeAll-done")
    }, TEST_TIMEOUT_MS)
    afterAll(async (): Promise<void> => {
        await recordFixturePhase("afterAll-start")
        if (originalTemp === undefined) delete process.env.TEMP
        else process.env.TEMP = originalTemp
        if (originalTmp === undefined) delete process.env.TMP
        else process.env.TMP = originalTmp
        await recordFixturePhase("afterAll-done")
    })

    test("provider construction is lazy and exposes only read", async (): Promise<void> => {
        await withFixture(async (fixture: PlaintextFixture): Promise<void> => {
            const before = await observeTree(fixture)
            let calls = 0
            const options = Object.defineProperty({}, "globalConfigRoot", {
                enumerable: true,
                get(): never { calls += 1; throw new Error(SECRET_CANARY) },
            })
            const provider = createPlaintextCredentialProvider(options)
            expect(Object.keys(provider)).toEqual(["read"])
            expect(calls).toBe(0)
            await expectAsyncCredentialError((): Promise<unknown> => provider.read("ssh", "PROFILE"), "invalid")
            expect(calls).toBe(0)
            expect(await observeTree(fixture)).toEqual(before)
        })
    }, TEST_TIMEOUT_MS)

    test("invalid provider kinds and noncanonical IDs fail before reading the store", async (): Promise<void> => {
        await withFixture(async (fixture: PlaintextFixture): Promise<void> => {
            const before = await observeTree(fixture)
            const provider = createPlaintextCredentialProvider(fixtureOptions(fixture))
            for (const kind of ["", "SSH", "smtp", "__proto__", undefined, null, 1])
                await expectAsyncCredentialError((): Promise<unknown> => provider.read(kind as CredentialKind, "PROFILE"), "invalid")
            for (const kind of KINDS)
                for (const id of ["", "profile", " PROFILE ", "PROFILE-X", "PROFILE.X", undefined, null, 1])
                    await expectAsyncCredentialError((): Promise<unknown> => provider.read(kind, id as string), "invalid")
            await expectAbsent(win32.join(fixture.root, "credentials"))
            expect(await observeTree(fixture)).toEqual(before)
        })
    }, TEST_TIMEOUT_MS)

    for (const missing of ["global-root", "parent", "file", "key", "kind"] as const) {
        test(`missing ${missing} creates no parents, store, sentinel, or lock files`, async (): Promise<void> => {
            await withFixture(async (fixture: PlaintextFixture): Promise<void> => {
                let root = fixture.root
                if (missing === "global-root") root = win32.join(root, "absent", "nested")
                if (missing === "file") {
                    await provisionStore(fixture, '{"version":1,"profiles":{}}')
                    await unlink(storePath(fixture))
                }
                if (missing === "key" || missing === "kind")
                    await provisionStore(fixture, JSON.stringify({ version: 1, profiles: { ssh: { PRESENT: COMPLETE_PROFILES.ssh } } }))
                const options = { globalConfigRoot: root, expectedSid }
                const before = await observeTree(fixture)
                if (missing === "file") expectOwnerOnly(before, "credentials", true)
                const store = await readPlaintextCredentialStore(options)
                expect(store.status).toBe(missing === "key" || missing === "kind" ? "found" : "missing")
                expect(await createPlaintextCredentialProvider(options).read(missing === "kind" ? "db" : "ssh", "ABSENT")).toEqual({ status: "missing" })
                if (missing === "global-root") await expectAbsent(win32.join(fixture.root, "absent"))
                if (missing === "parent") await expectAbsent(win32.join(fixture.root, "credentials"))
                if (missing === "file") await expectAbsent(storePath(fixture))
                expect(await observeTree(fixture)).toEqual(before)
            })
        }, TEST_TIMEOUT_MS)
    }

    for (const kind of KINDS) {
        test(`${kind}: secure reads preserve raw fields and resolve without runtime writes`, async (): Promise<void> => {
            await withFixture(async (fixture: PlaintextFixture): Promise<void> => {
                const contents = JSON.stringify(storeWithProfile(kind, COMPLETE_PROFILES[kind]))
                await provisionStore(fixture, contents)
                const before = await observeTree(fixture)
                const options = fixtureOptions(fixture)
                const result = await readPlaintextCredentialStore(options)
                expect(result.status).toBe("found")
                expect(result.status === "found" && JSON.stringify(result.store) === contents).toBe(true)
                const provider = createPlaintextCredentialProvider(options)
                const read = await provider.read(kind, "PROFILE")
                expect(read.status === "found" && JSON.stringify(read.profile) === JSON.stringify(COMPLETE_PROFILES[kind])).toBe(true)
                const resolver = createCredentialResolver({ providers: { plaintext: provider }, provider: "plaintext", platform: "win32", warn(): void {} })
                const resolved = await resolver.resolve(kind, " profile ")
                expect(resolved.provider).toBe("plaintext")
                expect(JSON.stringify(resolved.profile) === JSON.stringify(COMPLETE_PROFILES[kind])).toBe(true)
                expect(await observeTree(fixture)).toEqual(before)
            })
        }, TEST_TIMEOUT_MS)

        test(`${kind}: stored incomplete fields remain found until core completeness validation`, async (): Promise<void> => {
            await withFixture(async (fixture: PlaintextFixture): Promise<void> => {
                const fields = kind === "rest" ? { username: SECRET_CANARY } : { password: SECRET_CANARY }
                const blank = kind === "ssh" ? { host: " \t\r\n" } : kind === "db" ? { connection: " \t\r\n" } : { password: "" }
                await provisionStore(fixture, JSON.stringify({ version: 1, profiles: { [kind]: { PROFILE: fields, EMPTY: {}, BLANK: blank } } }))
                const before = await observeTree(fixture)
                const provider = createPlaintextCredentialProvider(fixtureOptions(fixture))
                const result = await provider.read(kind, "PROFILE")
                expect(result.status === "found" && JSON.stringify(result.profile) === JSON.stringify(fields)).toBe(true)
                if (result.status !== "found") throw new Error("Expected stored partial profile.")
                expect(validateCredentialProfile(kind, result.profile)).toEqual({ status: "incomplete" })
                for (const [id, partial] of [["EMPTY", {}], ["BLANK", blank]] as const) {
                    const read = await provider.read(kind, id)
                    expect(read.status === "found" && JSON.stringify(read.profile) === JSON.stringify(partial)).toBe(true)
                    if (read.status !== "found") throw new Error("Expected stored incomplete profile.")
                    expect(validateCredentialProfile(kind, read.profile)).toEqual({ status: "incomplete" })
                }
                const resolver = createCredentialResolver({ providers: { plaintext: provider }, provider: "plaintext", platform: "win32", warn(): void {} })
                await expectAsyncCredentialError((): Promise<unknown> => resolver.resolve(kind, "PROFILE"), "incomplete")
                expect(await observeTree(fixture)).toEqual(before)
            })
        }, TEST_TIMEOUT_MS)
    }

    test("SSH caller hyphens normalize separately from canonical stored IDs", async (): Promise<void> => {
        await withFixture(async (fixture: PlaintextFixture): Promise<void> => {
            await provisionStore(fixture, JSON.stringify(storeWithProfile("ssh", { host: "gateway.example.test" }, "EDGE_HOST")))
            const before = await observeTree(fixture)
            const provider = createPlaintextCredentialProvider(fixtureOptions(fixture))
            await expectAsyncCredentialError((): Promise<unknown> => provider.read("ssh", "EDGE-HOST"), "invalid")
            const resolver = createCredentialResolver({ providers: { plaintext: provider }, provider: "plaintext", platform: "win32", warn(): void {} })
            expect((await resolver.resolve("ssh", " edge-host ")).profile).toEqual({ host: "gateway.example.test" })
            for (const kind of ["db", "rest"] as const)
                await expectAsyncCredentialError((): Promise<unknown> => resolver.resolve(kind, "edge-host"), "invalid")
            expect(await observeTree(fixture)).toEqual(before)
        })
    }, TEST_TIMEOUT_MS)

    test("minimal SSH, DB, and empty REST authorization or basic fields remain complete", async (): Promise<void> => {
        await withFixture(async (fixture: PlaintextFixture): Promise<void> => {
            await provisionStore(fixture, JSON.stringify({ version: 1, profiles: {
                ssh: { MINIMAL: { host: "gateway.example.test" } },
                db: { MINIMAL: { connection: " jdbc:test:opaque " } },
                rest: { AUTH: { authorization: "" }, BASIC: { username: "", password: "" } },
            } }))
            const before = await observeTree(fixture)
            const provider = createPlaintextCredentialProvider(fixtureOptions(fixture))
            for (const [kind, id] of [["ssh", "MINIMAL"], ["db", "MINIMAL"], ["rest", "AUTH"], ["rest", "BASIC"]] as const) {
                const result = await provider.read(kind, id)
                expect(result.status).toBe("found")
                if (result.status !== "found") throw new Error("Expected minimal stored profile.")
                expect(validateCredentialProfile(kind, result.profile).status).toBe("found")
            }
            expect(await observeTree(fixture)).toEqual(before)
        })
    }, TEST_TIMEOUT_MS)

    test("provider reads current contents instead of caching construction-time state", async (): Promise<void> => {
        await withFixture(async (fixture: PlaintextFixture): Promise<void> => {
            const provider = createPlaintextCredentialProvider(fixtureOptions(fixture))
            for (const authorization of [SECRET_CANARY, "synthetic-replacement"]) {
                await provisionStore(fixture, JSON.stringify(storeWithProfile("rest", { authorization })))
                const before = await observeTree(fixture)
                const result = await provider.read("rest", "PROFILE")
                expect(result.status === "found" && JSON.stringify(result.profile) === JSON.stringify({ authorization })).toBe(true)
                expect(await observeTree(fixture)).toEqual(before)
            }
        })
    }, TEST_TIMEOUT_MS)

    for (const corruption of ["json", "unrelated-profile", "unrelated-kind", "utf8"] as const) {
        test(`${corruption} corruption is a hard failure even when the requested key is absent`, async (): Promise<void> => {
            await withFixture(async (fixture: PlaintextFixture): Promise<void> => {
                const contents = corruption === "json" ? `{${SECRET_CANARY}:${PARSER_MARKER}}`
                    : JSON.stringify({ version: 1, profiles: {
                        ssh: { SELECTED: COMPLETE_PROFILES.ssh, ...(corruption === "unrelated-profile" ? { OTHER: { host: 7 } } : {}) },
                        ...(corruption === "unrelated-kind" ? { rest: { OTHER: { unknown: SECRET_CANARY } } } : {}),
                    } })
                await provisionStore(fixture, contents)
                if (corruption === "utf8") await writeFile(storePath(fixture), Buffer.from([0xc3, 0x28]))
                const before = await observeTree(fixture)
                expectOwnerOnly(before, "credentials", true)
                expectOwnerOnly(before, "credentials\\profiles.json", false)
                const options = fixtureOptions(fixture)
                await expectAsyncCredentialError((): Promise<unknown> => readPlaintextCredentialStore(options), "invalid")
                await expectAsyncCredentialError((): Promise<unknown> => createPlaintextCredentialProvider(options).read("ssh", "ABSENT"), "invalid")
                expect(await observeTree(fixture)).toEqual(before)
            })
        }, TEST_TIMEOUT_MS)
    }

    test("actual files accept the UTF-8 cap and reject one extra byte without mutation", async (): Promise<void> => {
        await withFixture(async (fixture: PlaintextFixture): Promise<void> => {
            const contents = JSON.stringify(sizedStore(MAX_PLAINTEXT_STORE_BYTES, "😀"))
            expect(contents.length < MAX_PLAINTEXT_STORE_BYTES).toBe(true)
            await provisionStore(fixture, contents)
            const options = fixtureOptions(fixture)
            const before = await observeTree(fixture)
            const found = await readPlaintextCredentialStore(options)
            expect(found.status === "found" && JSON.stringify(found.store) === contents).toBe(true)
            const provider = createPlaintextCredentialProvider(options)
            const profile = await provider.read("rest", "PROFILE_0")
            expect(profile.status).toBe("found")
            expect(await observeTree(fixture)).toEqual(before)
            // In-place fixture writes preserve the already inspected owner-only file ACL.
            await writeFile(storePath(fixture), contents + " ", "utf8")
            const oversized = await observeTree(fixture)
            expectOwnerOnly(oversized, "credentials", true)
            expectOwnerOnly(oversized, "credentials\\profiles.json", false)
            expect(oversized.find((entry: TreeEntry): boolean => entry.path === "credentials\\profiles.json")?.size).toBe(BigInt(MAX_PLAINTEXT_STORE_BYTES + 1))
            await expectAsyncCredentialError((): Promise<unknown> => readPlaintextCredentialStore(options), "too_large")
            await expectAsyncCredentialError((): Promise<unknown> => provider.read("rest", "ABSENT"), "too_large")
            expect(await observeTree(fixture)).toEqual(oversized)
        })
    }, TEST_TIMEOUT_MS)

    for (const insecure of ["directory", "file"] as const) {
        test(`actual insecure ${insecure} ACL is denied, never repaired or treated as absence`, async (): Promise<void> => {
            await withFixture(async (fixture: PlaintextFixture): Promise<void> => {
                await provisionStore(fixture, JSON.stringify(storeWithProfile("ssh", COMPLETE_PROFILES.ssh)))
                const path = insecure === "directory" ? win32.dirname(storePath(fixture)) : storePath(fixture)
                expect(await runFixture(fixture, ADD_EVERYONE_RULE, { path })).toBe(true)
                const before = await observeTree(fixture)
                const changed = before.find((entry: TreeEntry): boolean => entry.path === win32.relative(fixture.root, path))?.acl
                expect(changed?.ownerSid === expectedSid).toBe(true)
                expect(changed?.protected).toBe(true)
                expect(changed?.rules.some((rule: AclMetadata["rules"][number]): boolean => rule.sid === EVERYONE_SID && rule.type === "Allow")).toBe(true)
                expectOwnerOnly(before, insecure === "directory" ? "credentials\\profiles.json" : "credentials", insecure !== "directory")
                const options = fixtureOptions(fixture)
                await expectAsyncCredentialError((): Promise<unknown> => readPlaintextCredentialStore(options), "denied")
                await expectAsyncCredentialError((): Promise<unknown> => createPlaintextCredentialProvider(options).read("ssh", "ABSENT"), "denied")
                expect(await observeTree(fixture)).toEqual(before)
            })
        }, TEST_TIMEOUT_MS)
    }

    test("wrong expected SID denies access without reading, repairing, or creating paths", async (): Promise<void> => {
        await withFixture(async (fixture: PlaintextFixture): Promise<void> => {
            await provisionStore(fixture, JSON.stringify(storeWithProfile("rest", COMPLETE_PROFILES.rest)))
            const before = await observeTree(fixture)
            const wrongSid = expectedSid === "S-1-5-18" ? "S-1-5-19" : "S-1-5-18"
            for (const root of [fixture.root, win32.join(fixture.root, "absent")]) {
                const options = { globalConfigRoot: root, expectedSid: wrongSid }
                await expectAsyncCredentialError((): Promise<unknown> => readPlaintextCredentialStore(options), "denied")
            }
            await expectAbsent(win32.join(fixture.root, "absent"))
            expect(await observeTree(fixture)).toEqual(before)
        })
    }, TEST_TIMEOUT_MS)

    test("resolves only the fixed global credentials/profiles.json suffix without creating paths", async (): Promise<void> => {
        await withFixture(async (fixture: PlaintextFixture): Promise<void> => {
            const before = await observeTree(fixture)
            const root = `${fixture.root}\\unused\\..\\private`
            const result = await resolvePlaintextCredentialStorePath({ globalConfigRoot: root, expectedSid })
            expect(result === win32.join(fixture.root, "private", "credentials", "profiles.json")).toBe(true)
            await expectAbsent(win32.join(fixture.root, "private"))
            expect(await observeTree(fixture)).toEqual(before)
        })
    }, TEST_TIMEOUT_MS)

    test("checks the default Windows global-root convention with synthetic home and environment only", async (): Promise<void> => {
        await withFixture(async (fixture: PlaintextFixture): Promise<void> => {
            const before = await observeTree(fixture)
            const paths = resolveOpenCodePaths({ platform: "win32", home: fixture.root, env: {} })
            expect(paths.globalConfigRoot === win32.join(fixture.root, ".config", "opencode")).toBe(true)
            expect(await resolvePlaintextCredentialStorePath({ globalConfigRoot: paths.globalConfigRoot }) === win32.join(fixture.root, ".config", "opencode", "credentials", "profiles.json")).toBe(true)
            await expectAbsent(win32.join(fixture.root, ".config"))
            expect(await observeTree(fixture)).toEqual(before)
        })
    }, TEST_TIMEOUT_MS)

    test("rejects cwd equality, descendants, case aliases, and dot-dot normalization with actionable safe errors", async (): Promise<void> => {
        const cwd = process.cwd()
        for (const root of [cwd, `${cwd}\\${SECRET_CANARY}`, cwd.toUpperCase(), cwd.toLowerCase(), `${cwd}\\${SECRET_CANARY}\\..`]) {
            await expectAsyncCredentialError((): Promise<unknown> => resolvePlaintextCredentialStorePath({ globalConfigRoot: root }), "unsafe_location", [cwd, root])
            await expectAsyncCredentialError((): Promise<unknown> => readPlaintextCredentialStore({ globalConfigRoot: root }), "unsafe_location", [cwd, root])
        }
    }, TEST_TIMEOUT_MS)

    for (const marker of ["directory", "file"] as const) {
        test(`rejects an outside-workspace temporary Git ancestor with a .git ${marker}`, async (): Promise<void> => {
            await withFixture(async (fixture: PlaintextFixture): Promise<void> => {
                const repository = win32.join(fixture.root, "repository")
                await mkdir(repository)
                const git = win32.join(repository, ".git")
                if (marker === "directory") await mkdir(git)
                else await writeFile(git, `gitdir: ../${SECRET_CANARY}\n`, "utf8")
                const root = win32.join(repository, "nested", "private")
                const relative = win32.relative(process.cwd(), root)
                expect(relative === ".." || relative.startsWith("..\\") || win32.isAbsolute(relative)).toBe(true)
                const before = await observeTree(fixture)
                const options = { globalConfigRoot: root, expectedSid }
                await expectAsyncCredentialError((): Promise<unknown> => resolvePlaintextCredentialStorePath(options), "unsafe_location", [repository, root])
                await expectAsyncCredentialError((): Promise<unknown> => createPlaintextCredentialProvider(options).read("ssh", "ABSENT"), "unsafe_location", [root])
                expect(await observeTree(fixture)).toEqual(before)
            })
        }, TEST_TIMEOUT_MS)
    }

    test("canonicalizes a real junction whose target has a hidden Git ancestor", async (): Promise<void> => {
        await withFixture(async (fixture: PlaintextFixture): Promise<void> => {
            const repository = win32.join(fixture.root, "repository")
            const target = win32.join(repository, "nested")
            await mkdir(target, { recursive: true })
            await writeFile(win32.join(repository, ".git"), "gitdir: ../synthetic-metadata\n", "utf8")
            const junction = win32.join(fixture.root, "alias")
            fixture.junctions.push(junction)
            const created = await runFixture(fixture, CREATE_JUNCTION, { path: junction, target })
            if (typeof created === "object" && created !== null && "privilegeUnavailable" in created && created.privilegeUnavailable === true) {
                process.stdout.write("SKIP canonical junction location: Windows privilege unavailable (1314).\n")
                return
            }
            expect(created).toEqual({ created: true })
            expect((await lstat(junction)).isSymbolicLink()).toBe(true)
            await expectAbsent(win32.join(junction, ".git"))
            const before = await observeTree(fixture)
            const root = win32.join(junction, "private")
            await expectAsyncCredentialError((): Promise<unknown> => resolvePlaintextCredentialStorePath({ globalConfigRoot: root }), "unsafe_location", [root, target])
            await expectAsyncCredentialError((): Promise<unknown> => readPlaintextCredentialStore({ globalConfigRoot: root, expectedSid }), "unsafe_location", [root, target])
            await expectAbsent(win32.join(target, "private"))
            expect(await observeTree(fixture)).toEqual(before)
        })
    }, TEST_TIMEOUT_MS)

    test("rejects invalid roots and options before touching the owned tree", async (): Promise<void> => {
        await withFixture(async (fixture: PlaintextFixture): Promise<void> => {
            const before = await observeTree(fixture)
            for (const root of ["", "relative", "C:relative", `\\\\localhost\\C$\\${SECRET_CANARY}`, `${fixture.root}:stream`, `${fixture.root}\\NUL`, `${fixture.root}\\bad.`, `${fixture.root}\\bad `, `${fixture.root}\\\0`, `${fixture.root}\\\ud800`, `${fixture.root}\\${"a".repeat(260)}`])
                await expectAsyncCredentialError((): Promise<unknown> => resolvePlaintextCredentialStorePath({ globalConfigRoot: root }), "invalid")
            for (const options of [null, [], { globalConfigRoot: 1 }, { expectedSid: 1 }, { globalConfigRoot: fixture.root, unexpected: SECRET_CANARY }])
                await expectAsyncCredentialError((): Promise<unknown> => readPlaintextCredentialStore(options as PlaintextCredentialOptions), "invalid")
            expect(await observeTree(fixture)).toEqual(before)
        })
    }, TEST_TIMEOUT_MS)
})
