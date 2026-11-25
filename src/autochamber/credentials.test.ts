import { describe, expect, test } from "bun:test"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { createCredentialResolver } from "../credentials/resolver"
import type { CredentialKind, CredentialProvider, CredentialProviderPolicy } from "../credentials/types"
import { serializeCredentialEnvelope } from "../credentials/validation"
import { createWindowsCredentialOperation, type CredentialChildDependencies } from "../credentials/windows-process"
import { createAutocodeDbSchemasTool } from "../tools/autocode_db"
import { createAutocodeRestTool } from "../tools/autocode_rest"
import { createAutocodeSshCommandTool } from "../tools/autocode_ssh"
import { createToolContext } from "../tools/test_context"
import type { DbConfig } from "../utils/db"
import type { SshChannelLike, SshConnectionPool, SshResolvedConfig } from "../utils/ssh"
import {
    createCredentialProfileService,
    type CredentialProfileSummary,
    type CredentialServiceErrorCode,
    type CredentialServiceProvider,
    type CredentialServiceResult,
    type CredentialWritePrecondition,
} from "./credentials"

const SECRET = "fixture-secret-canary"
const USER = "fixture-user-canary"
const SID = "S-1-5-21-123"

type Fields = Record<string, string>
type Stores = Record<CredentialServiceProvider, Map<string, Fields>>

function success<T>(result: CredentialServiceResult<T>): T {
    if (!result.ok) throw new Error(`Unexpected service error: ${result.error.code}`)
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(JSON.stringify(result)).not.toContain(USER)
    return result.data
}

function expectFailure<T>(result: CredentialServiceResult<T>, code: CredentialServiceErrorCode): void {
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("Expected service failure")
    expect(result.error.code).toBe(code)
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(JSON.stringify(result)).not.toContain(USER)
}

function fixture(
    platform: NodeJS.Platform = "linux",
    initialPolicy: CredentialProviderPolicy = "plaintext",
    writeWindows?: (kind: CredentialKind, id: string, fields: Fields, sid: string) => Promise<void>,
) {
    const stores: Stores = { plaintext: new Map(), windows: new Map(), linux: new Map() }
    const writes: Array<{ provider: CredentialServiceProvider; kind: CredentialKind; id: string; fields: Fields; expected?: CredentialWritePrecondition; sid?: string }> = []
    const reads: Array<{ provider: CredentialServiceProvider; kind: CredentialKind; id: string }> = []
    const identities: Array<string | undefined> = []
    let policy = initialPolicy
    let sid = SID
    const provider = (name: CredentialServiceProvider): CredentialProvider => ({
        async enumerate(kind: CredentialKind): Promise<string[]> {
            return [...stores[name].keys()].filter((key: string): boolean => key.startsWith(`${kind}/`))
                .map((key: string): string => key.slice(kind.length + 1))
        },
        async read(kind: CredentialKind, id: string) {
            reads.push({ provider: name, kind, id })
            const fields = stores[name].get(`${kind}/${id}`)
            return fields === undefined ? { status: "missing" as const } : { status: "found" as const, profile: { ...fields } }
        },
    })
    const plaintext = provider("plaintext")
    const linux = provider("linux")
    const windows = provider("windows")
    const service = createCredentialProfileService({
        platform,
        expectedSid: platform === "win32" ? SID : undefined,
        loadPolicy: async (): Promise<CredentialProviderPolicy> => policy,
        getWindowsIdentity: async (expected?: string): Promise<{ sid: string; account: string }> => {
            identities.push(expected)
            return { sid, account: "fixture-account" }
        },
        createProvider: async (name: CredentialServiceProvider): Promise<CredentialProvider> =>
            name === "plaintext" ? plaintext : name === "windows" ? windows : linux,
        windowsInventoryComplete: true,
        writePlaintextAtomic: async (kind, id, fields, expected, expectedSid): Promise<void> => {
            writes.push({ provider: "plaintext", kind, id, fields: { ...fields }, expected, sid: expectedSid })
            stores.plaintext.set(`${kind}/${id}`, { ...fields })
        },
        writeWindows: async (kind, id, fields, expectedSid): Promise<void> => {
            await writeWindows?.(kind, id, { ...fields }, expectedSid)
            writes.push({ provider: "windows", kind, id, fields: { ...fields }, sid: expectedSid })
            stores.windows.set(`${kind}/${id}`, { ...fields })
        },
    })
    const makeResolver = (provider: CredentialProviderPolicy) => createCredentialResolver({
        platform,
        provider,
        providers: { plaintext, "windows-credential-manager": windows, "linux-secret-service": linux },
        warn: (): void => {},
    })
    const resolver = makeResolver(initialPolicy)
    return {
        service, stores, writes, reads, identities, resolver, makeResolver,
        setPolicy(value: CredentialProviderPolicy): void { policy = value },
        setSid(value: string): void { sid = value },
    }
}

async function create(f: ReturnType<typeof fixture>, kind: CredentialKind, id: string, fields: Fields): Promise<CredentialProfileSummary> {
    return success(await f.service.createCredentialProfile({ kind, id, provider: "plaintext", fields, confirmPlaintext: true }))
}

function updateInput(summary: CredentialProfileSummary, fields: Record<string, unknown>) {
    return {
        kind: summary.kind, id: summary.id, provider: summary.provider, revision: summary.revision,
        confirm: true, confirmPlaintext: true, fields,
    }
}

describe("AutoChamber credential profiles", (): void => {
    test("creates profiles consumed by actual resolver and DB tool factory", async (): Promise<void> => {
        const f = fixture()
        const ssh = { host: "ssh.example.test", username: USER, port: "2200", agent: "fixture-agent", password: SECRET, keyfile: "/fixture/key", keypass: `${SECRET}-key` }
        const db = { connection: " jdbc:postgresql://db.example.test/example ", username: ` ${USER} `, password: ` ${SECRET} ` }
        const rest = { authorization: `Bearer ${SECRET}` }
        const results = [
            await create(f, "ssh", " dev-West ", ssh),
            await create(f, "db", " main_db ", db),
            await create(f, "rest", " api ", rest),
        ]
        expect(results.map((item): string => item.id)).toEqual(["DEV_WEST", "MAIN_DB", "API"])
        expect((await f.resolver.resolve("ssh", " dev-West ")).profile).toEqual(ssh)
        expect((await f.resolver.resolve("db", " main_db ")).profile).toEqual(db)
        expect((await f.resolver.resolve("rest", " api ")).profile).toEqual(rest)
        const list = success(await f.service.listCredentialProfiles())
        expect(list.profiles).toHaveLength(3)
        for (const surface of [results, list]) {
            const text = JSON.stringify(surface)
            for (const marker of [SECRET, USER, "ssh.example.test", "postgresql://", "/fixture/key"]) expect(text).not.toContain(marker)
            expect(text).not.toContain('"fields"')
        }
        expect(results[0].configured).toEqual({ host: true, username: true, port: true, keyfile: true, agent: true, password: true, keypass: true })
        expect(f.writes[0].expected).toEqual({ status: "missing" })

        const configs: DbConfig[] = []
        const tool = createAutocodeDbSchemasTool({
            credentialResolver: f.resolver,
            clientFactory: async (config): Promise<never> => { configs.push(config); throw new Error(SECRET) },
        })
        const output = await tool.execute({ db_key: " main_db " }, createToolContext())
        expect(configs).toEqual([{
            adapter: "postgres", connection: "postgresql://db.example.test/example",
            dbKey: "main_db", normalizedDbKey: "MAIN_DB", username: USER, password: SECRET,
        }])
        expect(JSON.stringify(output)).not.toContain(SECRET)
        expect(JSON.stringify(output)).not.toContain(USER)

        const queries: string[] = []
        let closed = false
        const workingTool = createAutocodeDbSchemasTool({
            credentialResolver: f.resolver,
            clientFactory: async (config) => {
                configs.push(config)
                return {
                    async query(sql: string): Promise<Record<string, unknown>[]> {
                        queries.push(sql)
                        return [{ schema_name: "fixture_schema" }]
                    },
                    async close(): Promise<void> { closed = true },
                }
            },
        })
        const successOutput = await workingTool.execute({ db_key: " main_db " }, createToolContext())
        expect(configs[1]).toEqual(configs[0])
        expect(queries).toEqual(["SELECT schema_name FROM information_schema.schemata ORDER BY schema_name"])
        expect(closed).toBe(true)
        expect(JSON.parse(successOutput as string)).toEqual(["fixture_schema"])
        expect(JSON.stringify(successOutput)).not.toContain(SECRET)
        expect(JSON.stringify(successOutput)).not.toContain(USER)
    })

    test("REST profiles supply authorization, Basic auth and explicit header override", async (): Promise<void> => {
        const f = fixture()
        await create(f, "rest", "token", { authorization: `Bearer ${SECRET}` })
        await create(f, "rest", "basic", { username: USER, password: SECRET })
        const requests: Headers[] = []
        const cachedBodies: Array<string | Buffer | Uint8Array> = []
        const originalFetch = globalThis.fetch
        const fileSystem = {
            async mkdir(): Promise<undefined> { return undefined },
            async readdir(): Promise<string[]> { return ["2026-08-20_10-30-00_my_job"] },
            async readFile(): Promise<string> { throw Object.assign(new Error("missing"), { code: "ENOENT" }) },
            async stat(): Promise<{ mtimeMs: number }> { throw Object.assign(new Error("missing"), { code: "ENOENT" }) },
            async writeFile(_file: string, data: string | Buffer | Uint8Array): Promise<void> { cachedBodies.push(data) },
            async rename(): Promise<void> {},
            async rm(): Promise<void> {},
        }
        const client = { session: { get: async (): Promise<unknown> => ({ data: { id: "session-1", title: "My Job" } }) } } as unknown as OpencodeClient
        try {
            globalThis.fetch = (async (_input, init): Promise<Response> => {
                requests.push(new Headers(init?.headers))
                return new Response("ok")
            }) as typeof fetch
            const tool = createAutocodeRestTool(client, fileSystem, f.resolver)
            const outputs = [
                await tool.execute({ url: "https://example.test/", method: "GET", rest_key: "token" } as never, createToolContext()),
                await tool.execute({ url: "https://example.test/", method: "GET", rest_key: "basic" } as never, createToolContext()),
                await tool.execute({ url: "https://example.test/", method: "GET", rest_key: "missing", headers: { authorization: "Bearer explicit" } } as never, createToolContext()),
            ]
            expect(requests.map((headers): string | null => headers.get("authorization"))).toEqual([
                `Bearer ${SECRET}`, `Basic ${Buffer.from(`${USER}:${SECRET}`).toString("base64")}`, "Bearer explicit",
            ])
            expect(cachedBodies).toEqual(["ok", "ok", "ok"])
            for (const output of outputs) {
                expect(JSON.parse(output as string)).toMatchObject({ status_code: 200, response_body: "ok" })
                expect(JSON.stringify(output)).not.toContain(SECRET)
                expect(JSON.stringify(output)).not.toContain(USER)
                expect(JSON.stringify(output)).not.toContain(Buffer.from(`${USER}:${SECRET}`).toString("base64"))
            }
            f.reads.length = 0
            const restricted = createAutocodeRestTool(client, fileSystem, f.makeResolver("linux-secret-service"))
            const denied = await restricted.execute({ url: "https://example.test/", method: "GET", rest_key: "token" } as never, createToolContext())
            expect(JSON.stringify(denied)).toContain("Unable to resolve REST authentication credentials.")
            expect(JSON.stringify(denied)).not.toContain(SECRET)
            expect(f.reads).toEqual([{ provider: "linux", kind: "rest", id: "TOKEN" }])
            expect(requests).toHaveLength(3)
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    test("SSH normalized profile reaches connection pool without exposing password in error", async (): Promise<void> => {
        const f = fixture()
        await create(f, "ssh", " dev-West ", { host: "ssh.example.test", port: "2200", username: USER, password: SECRET })
        const configs: SshResolvedConfig[] = []
        const pool = {
            async get(config: SshResolvedConfig): Promise<never> { configs.push(config); throw new Error(SECRET) },
            release(): void {},
        } as unknown as SshConnectionPool
        const tool = createAutocodeSshCommandTool({ credentialResolver: f.resolver, pool })
        const output = await tool.execute({ ssh_key: "dev-West", command: "uptime" }, createToolContext())
        expect(configs).toHaveLength(1)
        expect(configs[0]).toMatchObject({
            host: "ssh.example.test", port: 2200, username: USER,
            connectConfig: { host: "ssh.example.test", port: 2200, username: USER, password: SECRET },
        })
        expect(JSON.stringify(output)).not.toContain(SECRET)
        expect(JSON.stringify(output)).not.toContain(USER)

        const commands: string[] = []
        let released = false
        const client = {
            exec(command: string, callback: (error: Error | undefined, channel: SshChannelLike) => void): void {
                commands.push(command)
                const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
                callback(undefined, channel)
                queueMicrotask((): void => {
                    channel.emit("data", "fixture-output")
                    channel.emit("exit", 0, undefined)
                    channel.emit("close")
                })
            },
        }
        const workingPool = {
            async get(config: SshResolvedConfig) { configs.push(config); return client },
            release(): void { released = true },
        } as unknown as SshConnectionPool
        const workingTool = createAutocodeSshCommandTool({ credentialResolver: f.resolver, pool: workingPool })
        const successOutput = await workingTool.execute({ ssh_key: "dev-West", command: "uptime" }, createToolContext())
        expect(configs[1]).toEqual(configs[0])
        expect(commands).toEqual(["uptime"])
        expect(released).toBe(true)
        expect(JSON.parse(successOutput as string)).toMatchObject({ host: "ssh.example.test", port: 2200, output: "fixture-output" })
        expect(JSON.stringify(successOutput)).not.toContain(SECRET)
        expect(JSON.stringify(successOutput)).not.toContain(USER)
    })

    test("explicit native policy does not fall back to saved plaintext for DB or SSH", async (): Promise<void> => {
        const f = fixture()
        await create(f, "db", "main", { connection: "postgresql://db.example.test/example", username: USER, password: SECRET })
        await create(f, "ssh", "dev", { host: "ssh.example.test", username: USER, password: SECRET })
        f.reads.length = 0
        let dbCalls = 0
        let sshCalls = 0
        const resolver = f.makeResolver("linux-secret-service")
        const db = createAutocodeDbSchemasTool({
            credentialResolver: resolver,
            clientFactory: async (): Promise<never> => { dbCalls++; throw new Error("Unexpected DB client") },
        })
        const ssh = createAutocodeSshCommandTool({
            credentialResolver: resolver,
            pool: { async get(): Promise<never> { sshCalls++; throw new Error("Unexpected SSH client") } } as unknown as SshConnectionPool,
        })
        const dbOutput = await db.execute({ db_key: "main" }, createToolContext())
        const sshOutput = await ssh.execute({ ssh_key: "dev", command: "uptime" }, createToolContext())
        expect(f.reads).toEqual([
            { provider: "linux", kind: "db", id: "MAIN" },
            { provider: "linux", kind: "ssh", id: "DEV" },
        ])
        expect(dbCalls).toBe(0)
        expect(sshCalls).toBe(0)
        expect(JSON.stringify(dbOutput)).toContain("Credential read failed.")
        expect(JSON.stringify(sshOutput)).toContain("SSH credential resolution failed")
        for (const output of [dbOutput, sshOutput]) {
            expect(JSON.stringify(output)).not.toContain(SECRET)
            expect(JSON.stringify(output)).not.toContain(USER)
        }
    })

    test("validates payloads, consent, normalized collisions and unsafe REST modes", async (): Promise<void> => {
        const f = fixture()
        const base = { kind: "rest", id: "api", provider: "plaintext", fields: { authorization: SECRET }, confirmPlaintext: true }
        const getter = Object.defineProperty({}, "authorization", { enumerable: true, get(): never { throw new Error(SECRET) } })
        for (const input of [
            { ...base, fields: getter }, { ...base, fields: { authorization: SECRET, extra: SECRET } },
            { ...base, fields: { authorization: SECRET, username: USER, password: SECRET } },
            { ...base, id: "bad/id" }, { ...base, fields: { username: USER } },
            { ...base, fields: { authorization: "" } }, { ...base, extra: SECRET },
        ]) expectFailure(await f.service.createCredentialProfile(input), "invalid_request")
        const consent = await f.service.createCredentialProfile({ ...base, confirmPlaintext: false })
        expectFailure(consent, "plaintext_confirmation_required")
        if (!consent.ok) expect(consent.error.message).toContain("stored unencrypted")
        expect(f.writes).toHaveLength(0)
        await create(f, "ssh", "dev-west", { host: "ssh.example.test", password: SECRET })
        expectFailure(await f.service.createCredentialProfile({
            kind: "ssh", id: "DEV_WEST", provider: "plaintext", fields: { host: "other", password: SECRET }, confirmPlaintext: true,
        }), "duplicate_profile")
    })

    test("updates keep, set and clear atomically, preserving fields and requiring consent", async (): Promise<void> => {
        const f = fixture()
        await create(f, "ssh", "dev", { host: "ssh.example.test", username: USER, port: "22", password: SECRET })
        const original = success(await f.service.listCredentialProfiles()).profiles[0]
        expect(original.revision).toEqual(expect.any(String))
        const request = updateInput(original, { username: { op: "keep" }, port: { op: "clear" }, password: { op: "set", value: `${SECRET}-new` } })
        expectFailure(await f.service.updateCredentialProfile({ ...request, confirm: false }), "confirmation_required")
        expectFailure(await f.service.updateCredentialProfile({ ...request, confirmPlaintext: false }), "plaintext_confirmation_required")
        const updated = success(await f.service.updateCredentialProfile(request))
        expect(updated.configured.port).toBe(false)
        expect(f.stores.plaintext.get("ssh/DEV")).toEqual({ host: "ssh.example.test", username: USER, password: `${SECRET}-new` })
        expect(f.writes[1].expected).toEqual({ status: "found", profile: { host: "ssh.example.test", username: USER, port: "22", password: SECRET } })
        expect(JSON.stringify(updated)).not.toContain(SECRET)
        expectFailure(await f.service.updateCredentialProfile(request), "stale_revision")
        expectFailure(await f.service.updateCredentialProfile(updateInput(updated, { password: { op: "clear" } })), "invalid_request")
        expectFailure(await f.service.updateCredentialProfile(updateInput(updated, { password: { op: "keep", value: SECRET } })), "invalid_request")
        expect(f.writes).toHaveLength(2)
    })

    test("detects profile and provider mode drift before writing", async (): Promise<void> => {
        const f = fixture()
        const summary = await create(f, "rest", "api", { username: USER, password: SECRET })
        f.stores.plaintext.set("rest/API", { authorization: `Bearer ${SECRET}` })
        expectFailure(await f.service.updateCredentialProfile(updateInput(summary, { password: { op: "set", value: "new" } })), "stale_revision")
        f.stores.plaintext.set("rest/API", { username: USER, password: SECRET, authorization: SECRET })
        expectFailure(await f.service.updateCredentialProfile(updateInput(summary, { password: { op: "set", value: "new" } })), "profile_drift")
        f.setPolicy("auto")
        f.stores.plaintext.set("rest/API", { username: USER, password: SECRET })
        expectFailure(await f.service.updateCredentialProfile(updateInput(summary, { password: { op: "set", value: "new" } })), "stale_revision")
        expect(f.writes).toHaveLength(1)
    })

    test("auto selects Linux first, blocks shadowed writes, and reports unavailable fallback", async (): Promise<void> => {
        const f = fixture("linux", "auto")
        f.stores.linux.set("rest/API", { authorization: `Bearer ${SECRET}-native` })
        f.stores.plaintext.set("rest/API", { authorization: `Bearer ${SECRET}-plain` })
        const list = success(await f.service.listCredentialProfiles())
        expect(list.profiles[0]).toMatchObject({ provider: "linux", readOnly: true, unavailable: false })
        expect((await f.resolver.resolve("rest", "api")).provider).toBe("linux-secret-service")
        expectFailure(await f.service.createCredentialProfile({ kind: "rest", id: "api", provider: "linux", fields: { authorization: SECRET } }), "provider_not_allowed")
        expectFailure(await f.service.createCredentialProfile({ kind: "rest", id: "api", provider: "plaintext", fields: { authorization: SECRET }, confirmPlaintext: true }), "duplicate_profile")
        f.stores.linux.clear()
        expect((await f.resolver.resolve("rest", "api")).provider).toBe("plaintext")
        expect(success(await f.service.listCredentialProfiles()).profiles[0].provider).toBe("plaintext")
        const unsupported = fixture("darwin", "linux-secret-service")
        const unsupportedList = success(await unsupported.service.listCredentialProfiles())
        expect(unsupportedList.providers.find((item): boolean => item.provider === "linux")?.unavailable).toBe(true)
        expectFailure(await unsupported.service.createCredentialProfile({ kind: "rest", id: "api", provider: "plaintext", fields: { authorization: SECRET }, confirmPlaintext: true }), "provider_not_allowed")
        const otherPlatform = fixture("darwin", "auto")
        await create(otherPlatform, "rest", "api", { authorization: SECRET })
        expect((await otherPlatform.resolver.resolve("rest", "api")).provider).toBe("plaintext")
    })

    test("unavailable native inventory blocks plaintext mutation and writer failures stay sanitized", async (): Promise<void> => {
        const empty: CredentialProvider = {
            async enumerate(): Promise<string[]> { return [] },
            async read(): Promise<{ status: "missing" }> { return { status: "missing" } },
        }
        const service = createCredentialProfileService({
            platform: "linux",
            loadPolicy: async (): Promise<CredentialProviderPolicy> => "auto",
            createProvider: async (name): Promise<CredentialProvider> => {
                if (name === "linux") throw new Error(SECRET)
                return empty
            },
            writePlaintextAtomic: async (): Promise<void> => { throw new Error("unexpected write") },
        })
        const input = { kind: "rest", id: "api", provider: "plaintext", fields: { authorization: SECRET }, confirmPlaintext: true }
        const list = success(await service.listCredentialProfiles())
        expect(list.providers.find((item): boolean => item.provider === "linux")?.unavailable).toBe(true)
        expectFailure(await service.createCredentialProfile(input), "provider_unavailable")
        const failingWriter = createCredentialProfileService({
            platform: "linux",
            loadPolicy: async (): Promise<CredentialProviderPolicy> => "plaintext",
            createProvider: async (): Promise<CredentialProvider> => empty,
            writePlaintextAtomic: async (): Promise<void> => { throw new Error(`${USER} ${SECRET}`) },
        })
        expectFailure(await failingWriter.createCredentialProfile(input), "write_failed")
    })

    test("pins Windows identity and passes SID to injected writer; identity drift blocks writes", async (): Promise<void> => {
        const f = fixture("win32", "windows-credential-manager")
        const created = success(await f.service.createCredentialProfile({
            kind: "rest", id: "api", provider: "windows", fields: { authorization: `Bearer ${SECRET}` },
        }))
        expect(created.id).toBe("API")
        expect(f.writes).toMatchObject([{ provider: "windows", kind: "rest", id: "API", sid: SID }])
        expect(f.identities.length).toBeGreaterThanOrEqual(3)
        expect(f.identities.every((value): boolean => value === SID)).toBe(true)
        expect(JSON.stringify(created)).not.toContain(SECRET)
        f.setSid("S-1-5-21-456")
        expectFailure(await f.service.updateCredentialProfile(updateInput(created, { authorization: { op: "set", value: "new" } })), "provider_unavailable")
        expect(f.writes).toHaveLength(1)
    })

    test.skipIf(process.platform !== "win32")("Windows fake transport sends pinned SID and payload over stdin, not argv", async (): Promise<void> => {
        let frame = ""
        const launch: { args?: Parameters<CredentialChildDependencies["spawn"]> } = {}
        class FakeStream extends EventEmitter {
            end(input: Buffer): this {
                frame = input.toString("utf8")
                queueMicrotask((): void => {
                    child.stdin.emit("finish")
                    child.stdout.emit("data", Buffer.from('{"version":1,"status":"ok"}\n'))
                    child.stdout.emit("end")
                    child.stderr.emit("end")
                    child.emit("close", 0, null)
                })
                return this
            }
            destroy(): this { return this }
        }
        const child = Object.assign(new EventEmitter(), {
            stdin: new FakeStream(), stdout: new FakeStream(), stderr: new FakeStream(),
            exitCode: null, signalCode: null,
            kill(): boolean { return true },
            unref(): void {},
        })
        const operation = createWindowsCredentialOperation({
            spawn(...args: Parameters<CredentialChildDependencies["spawn"]>): ChildProcessWithoutNullStreams {
                launch.args = args
                return child as unknown as ChildProcessWithoutNullStreams
            },
            now: (): number => performance.now(),
            setTimer: (callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> => setTimeout(callback, milliseconds),
            clearTimer: (timer: ReturnType<typeof setTimeout>): void => clearTimeout(timer),
        })
        const f = fixture("win32", "windows-credential-manager", async (kind, id, fields, sid): Promise<void> => {
            await operation({
                operation: "write", target: `AutoCode/v1/${kind}/${id}`,
                payload: serializeCredentialEnvelope(kind, fields),
            }, { expectedSid: sid })
        })
        success(await f.service.createCredentialProfile({
            kind: "rest", id: "api", provider: "windows", fields: { username: USER, password: SECRET },
        }))
        expect((await f.resolver.resolve("rest", "api")).profile).toEqual({ username: USER, password: SECRET })
        const request = JSON.parse(frame) as { version: number; operation: string; target: string; payload: string; expectedSid: string }
        expect(request).toMatchObject({ version: 1, operation: "write", target: "AutoCode/v1/rest/API", expectedSid: SID })
        expect(JSON.parse(request.payload)).toEqual({ version: 1, kind: "rest", fields: { username: USER, password: SECRET } })
        expect(launch.args).toBeDefined()
        expect(launch.args?.[2].shell).toBe(false)
        for (const marker of [SECRET, USER, SID, request.payload]) expect(JSON.stringify(launch.args?.[1])).not.toContain(marker)
    })
})
