import { describe, beforeEach, expect, mock, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin"
import type { CredentialKind, CredentialResolver, DbCredentialProfile, ResolvedCredentialProfile } from "@/credentials/types"
import { createNoopAsk } from "./test_context"
import {
    buildReadOnlySelectQuery,
    loadDbConfig,
    normalizeDbKey,
    type DbAdapter,
    type DbClient,
    type DbConfig,
    type DbFilter,
} from "@/utils/db"
import { createAbortResponse, resetRetryCounts } from "@/utils/tools"
import { createAutocodeDbTableReadTool, createAutocodeDbTableTool, createAutocodeDbSchemasTool, createAutocodeDbTablesTool } from "./autocode_db"

const DB_ENV_READ_TRAP_MESSAGE = "Database environment reads are forbidden in this test."

type QueryResponse = Record<string, unknown>[]
type QueryHandler = {
    match: RegExp | string
    response: QueryResponse
}

function createFakeCredentialResolver(profileOrSequence: DbCredentialProfile | Error | Array<DbCredentialProfile | Error>): {
    calls: Array<{ kind: CredentialKind, id: string }>
    credentialResolver: CredentialResolver
} {
    const profiles = Array.isArray(profileOrSequence) ? profileOrSequence : [profileOrSequence]
    const calls: Array<{ kind: CredentialKind, id: string }> = []
    const credentialResolver: CredentialResolver = {
        async resolve<K extends CredentialKind>(kind: K, id: string): Promise<ResolvedCredentialProfile<K>> {
            calls.push({ kind, id })
            if (kind !== "db") {
                throw new Error("Unexpected credential kind.")
            }

            const profile = profiles[calls.length - 1]
            if (!profile) {
                throw new Error("Unexpected additional credential resolution.")
            }
            if (profile instanceof Error) {
                throw profile
            }

            const resolved: ResolvedCredentialProfile<"db"> = { kind: "db", provider: "plaintext", profile }
            // Narrowing kind does not narrow the generic mapped profile type.
            return resolved as ResolvedCredentialProfile<K>
        },
    }

    return { calls, credentialResolver }
}

function createSensitiveFailure(stage: string): {
    error: Error
    expectedError: Error
    messageSecrets: string[]
    profile: DbCredentialProfile
    secrets: string[]
} {
    const urlUsername = "URL_USER_QX91+marker"
    const urlPassword = "URL_PASS_QX92#marker"
    const queryCredentials = {
        UsEr: "QUERY_USER_QX93+marker",
        username: "QUERY_USERNAME_QX94#marker",
        PaSs: "QUERY_PASS_QX95/marker",
        password: "QUERY_PASSWORD_QX96?marker",
        pwd: "QUERY_PWD_QX97=marker",
    }
    const query = Object.entries(queryCredentials).map(([key, value]): string => `${key}=${encodeURIComponent(value)}`).join("&")
    const profile = {
        connection: `postgres://${encodeURIComponent(urlUsername)}:${encodeURIComponent(urlPassword)}@db.example/reporting?${query}`,
        username: "SEPARATE_USER_QX98+marker",
        password: "SEPARATE_PASS_QX99#marker",
    } satisfies DbCredentialProfile
    const credentials = [urlUsername, urlPassword, profile.username, profile.password, ...Object.values(queryCredentials)]
    const variants = credentials.flatMap((value): string[] => [value, encodeURIComponent(value)])
    const connections = [profile.connection, encodeURIComponent(profile.connection), decodeURIComponent(profile.connection)]
    const messageSecrets = [...connections, ...variants]
    const rawCause = `RAW_CAUSE_QX100_${stage}`
    const rawProperty = `RAW_PROPERTY_QX101_${stage}`
    const error = Object.assign(new Error(`${stage} failed ${messageSecrets.join(" ")}`, {
        cause: new Error(rawCause),
    }), {
        name: `DbFailure_${profile.username}`,
        detail: rawProperty,
        credentials: { connection: profile.connection, password: profile.password },
    })
    const expectedError = new Error(`${stage} failed ${connections.map((): string => "[REDACTED_CONNECTION]").join(" ")} ${variants.map((): string => "[REDACTED]").join(" ")}`)
    expectedError.name = "DbFailure_[REDACTED]"

    return { error, expectedError, messageSecrets, profile, secrets: [...messageSecrets, rawCause, rawProperty] }
}

async function withDbEnvReadTrap(run: () => Promise<void>): Promise<void> {
    const originalEnv = process.env
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, "env")
    const reads: string[] = []

    function rejectDbEnvRead(property: string | symbol): void {
        if (typeof property === "string" && /^AUTOCODE_DB_/i.test(property)) {
            reads.push(property)
            throw new Error(DB_ENV_READ_TRAP_MESSAGE)
        }
    }

    try {
        process.env = new Proxy(originalEnv, {
            get(target, property): unknown {
                rejectDbEnvRead(property)
                return Reflect.get(target, property, target)
            },
            has(target, property): boolean {
                rejectDbEnvRead(property)
                return Reflect.has(target, property)
            },
            getOwnPropertyDescriptor(target, property): PropertyDescriptor | undefined {
                rejectDbEnvRead(property)
                return Reflect.getOwnPropertyDescriptor(target, property)
            },
            set(target, property, value: unknown): boolean {
                return Reflect.set(target, property, value, target)
            },
        })
        const probeName = "AUTOCODE_DB_READ_TRAP_PROBE"
        const probes: Array<() => unknown> = [
            (): unknown => process.env[probeName],
            (): boolean => probeName in process.env,
            (): PropertyDescriptor | undefined => Object.getOwnPropertyDescriptor(process.env, probeName),
        ]
        for (const probe of probes) {
            expect(probe).toThrow(DB_ENV_READ_TRAP_MESSAGE)
            expect(reads).toEqual([probeName])
            reads.length = 0
        }

        await run()
        expect(reads).toEqual([])
    }
    finally {
        process.env = originalEnv
        if (originalDescriptor) {
            Object.defineProperty(process, "env", originalDescriptor)
        }
        else {
            Reflect.deleteProperty(process, "env")
        }
    }
    expect(process.env === originalEnv).toBe(true)
}

function createToolContext(): ToolContext {
    return {
        sessionID: "session-1",
        messageID: "message-1",
        agent: "pair",
        directory: "/workspace",
        worktree: "/workspace",
        abort: new AbortController().signal,
        metadata() {
        },
        ask: createNoopAsk(),
    }
}

function parseToolResult(result: string | { output: string }): unknown {
    return JSON.parse(typeof result === "string" ? result : result.output)
}

function createFakeClient(handlers: QueryHandler[]): {
    client: DbClient
    queries: Array<{ params: unknown[] | undefined, sql: string }>
} {
    const queries: Array<{ params: unknown[] | undefined, sql: string }> = []
    const client: DbClient = {
        close: mock(async (): Promise<void> => { }),
        query: mock(async (sql: string, params?: unknown[]): Promise<QueryResponse> => {
            queries.push({ params, sql })

            for (const handler of handlers) {
                if (typeof handler.match === "string" && handler.match === sql) {
                    return handler.response
                }

                if (handler.match instanceof RegExp && handler.match.test(sql)) {
                    return handler.response
                }
            }

            throw new Error(`Unexpected SQL: ${sql}`)
        }),
    }

    return { client, queries }
}

describe("autocode_db tools", () => {
    beforeEach(() => { resetRetryCounts() })
    test("autocode_db_tables returns a JSON string using one whole-profile resolution and client factory", async () => {
        const { calls, credentialResolver } = createFakeCredentialResolver({
            connection: "postgres://readonly@db.example/reporting",
            username: "readonly",
            password: "secret",
        })
        const { client } = createFakeClient([
            {
                match: "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
                response: [{ table_name: "orders" }, { table_name: "users" }],
            },
        ])
        const clientFactory = mock(async (config: DbConfig): Promise<DbClient> => {
            expect(config.dbKey).toBe("reporting")
            expect(config.normalizedDbKey).toBe("REPORTING")
            return client
        })

        const tool = createAutocodeDbTablesTool({ clientFactory, credentialResolver })
        const result = await tool.execute({ db_key: "reporting", schema: "public" }, createToolContext())

        expect(typeof result).toBe("string")
        expect(result).toBe(JSON.stringify(["orders", "users"]))
        expect(parseToolResult(result)).toEqual(["orders", "users"])
        expect(calls).toEqual([{ kind: "db", id: "REPORTING" }])
        expect(clientFactory).toHaveBeenCalledTimes(1)
        expect(client.query).toHaveBeenCalledWith(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
            ["public"]
        )
        expect(client.close).toHaveBeenCalledTimes(1)
    })

    test.serial.each(["success", "resolver failure"] as const)(
        "does not read or fall back to AUTOCODE_DB_* during %s",
        async (outcome): Promise<void> => {
            await withDbEnvReadTrap(async (): Promise<void> => {
                const profile = {
                    connection: "postgres://PROFILE_URL_USER_QX701:PROFILE_URL_PASS_QX702@db.example/reporting",
                    username: "PROFILE_USER_QX703",
                    password: "PROFILE_PASS_QX704",
                } satisfies DbCredentialProfile
                const failureMarker = "RESOLVER_NO_FALLBACK_QX705"
                const { calls, credentialResolver } = createFakeCredentialResolver([
                    outcome === "success" ? profile : new Error(failureMarker),
                    { connection: "mysql://unused@db.example/fallback" },
                ])
                const configs: DbConfig[] = []
                const actions: Array<"create" | "query" | "close"> = []
                const client: DbClient = {
                    query: mock(async (): Promise<QueryResponse> => {
                        actions.push("query")
                        return [{ table_name: "orders" }]
                    }),
                    close: mock(async (): Promise<void> => { actions.push("close") }),
                }
                const clientFactory = mock(async (config: DbConfig): Promise<DbClient> => {
                    configs.push(config)
                    actions.push("create")
                    return client
                })
                const tool = createAutocodeDbTablesTool({ clientFactory, credentialResolver })

                const result = await tool.execute({ db_key: " reporting_db ", schema: "public" }, createToolContext())

                expect(calls).toEqual([{ kind: "db", id: "REPORTING_DB" }])
                if (outcome === "success") {
                    expect(configs).toEqual([{ ...profile, adapter: "postgres", dbKey: "reporting_db", normalizedDbKey: "REPORTING_DB" }])
                    expect(clientFactory).toHaveBeenCalledTimes(1)
                    expect(clientFactory.mock.calls[0]?.[0]).toBe(configs[0])
                    expect(actions).toEqual(["create", "query", "close"])
                    expect(client.query).toHaveBeenCalledTimes(1)
                    expect(client.query).toHaveBeenCalledWith(
                        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
                        ["public"]
                    )
                    expect(client.close).toHaveBeenCalledTimes(1)
                    expect(parseToolResult(result)).toEqual(["orders"])
                }
                else {
                    expect(parseToolResult(result)).toEqual(parseToolResult(createAbortResponse("list database tables", new Error("Credential read failed."))))
                    expect(configs).toEqual([])
                    expect(actions).toEqual([])
                    expect(clientFactory).not.toHaveBeenCalled()
                    expect(client.query).not.toHaveBeenCalled()
                    expect(client.close).not.toHaveBeenCalled()
                }
                expect(JSON.stringify(parseToolResult(result))).not.toContain(failureMarker)
            })
        }
    )

    test("autocode_db_table returns postgres metadata as a JSON string", async () => {
        const { calls, credentialResolver } = createFakeCredentialResolver({
            connection: "postgres://readonly@db.example/reporting",
        })
        const { client } = createFakeClient([
            {
                match: "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
                response: [
                    { column_name: "id", data_type: "bigint", is_nullable: "NO" },
                    { column_name: "account_id", data_type: "uuid", is_nullable: "NO" },
                ],
            },
            {
                match: "SELECT kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2 ORDER BY kcu.ordinal_position",
                response: [{ column_name: "id" }],
            },
            {
                match: "SELECT i.relname AS index_name, array_agg(a.attname ORDER BY k.ord) AS columns FROM pg_class t JOIN pg_namespace ns ON ns.oid = t.relnamespace JOIN pg_index ix ON ix.indrelid = t.oid JOIN pg_class i ON i.oid = ix.indexrelid JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum WHERE ns.nspname = $1 AND t.relname = $2 AND NOT ix.indisprimary GROUP BY i.relname ORDER BY i.relname",
                response: [{ index_name: "orders_account_id_idx", columns: ["account_id"] }],
            },
            {
                match: "SELECT ccu.table_name AS table_name, kcu.column_name AS local_join_field, ccu.column_name AS foreign_join_field FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.table_schema WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2 ORDER BY ccu.table_name, kcu.ordinal_position",
                response: [{ table_name: "accounts", local_join_field: "account_id", foreign_join_field: "id" }],
            },
        ])

        const tool = createAutocodeDbTableTool({ clientFactory: async () => client, credentialResolver })
        const result = await tool.execute({ db_key: "REPORTING", schema: "public", table: "orders" }, createToolContext())

        expect(parseToolResult(result)).toEqual({
            fields: [
                { name: "id", nullable: false, type: "bigint" },
                { name: "account_id", nullable: false, type: "uuid" },
            ],
            indices: [["account_id"]],
            pk: ["id"],
            relationships: [{ table: "accounts", local_join_field: "account_id", foreign_join_field: "id" }],
            schema: "public",
            table: "orders",
        })
        expect(calls).toEqual([{ kind: "db", id: "REPORTING" }])
        expect(client.close).toHaveBeenCalledTimes(1)
    })

    test("autocode_db_table returns mysql metadata as a JSON string", async () => {
        const { calls, credentialResolver } = createFakeCredentialResolver({
            connection: "mysql://readonly@db.example/analytics",
        })
        const { client } = createFakeClient([
            {
                match: "SELECT column_name, column_type, is_nullable FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
                response: [
                    { column_name: "id", column_type: "bigint unsigned", is_nullable: "NO" },
                    { column_name: "project_id", column_type: "varchar(36)", is_nullable: "NO" },
                ],
            },
            {
                match: "SELECT column_name FROM information_schema.key_column_usage WHERE table_schema = ? AND table_name = ? AND constraint_name = 'PRIMARY' ORDER BY ordinal_position",
                response: [{ column_name: "id" }],
            },
            {
                match: "SELECT index_name, column_name FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? AND index_name <> 'PRIMARY' ORDER BY index_name, seq_in_index",
                response: [
                    { index_name: "project_created_idx", column_name: "project_id" },
                    { index_name: "project_created_idx", column_name: "created_at" },
                ],
            },
            {
                match: "SELECT referenced_table_name AS table_name, column_name AS local_join_field, referenced_column_name AS foreign_join_field FROM information_schema.key_column_usage WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL ORDER BY referenced_table_name, ordinal_position",
                response: [{ table_name: "projects", local_join_field: "project_id", foreign_join_field: "id" }],
            },
        ])

        const tool = createAutocodeDbTableTool({ clientFactory: async () => client, credentialResolver })
        const result = await tool.execute({ db_key: "analytics", schema: "analytics", table: "events" }, createToolContext())

        expect(parseToolResult(result)).toEqual({
            fields: [
                { name: "id", nullable: false, type: "bigint unsigned" },
                { name: "project_id", nullable: false, type: "varchar(36)" },
            ],
            indices: [["project_id", "created_at"]],
            pk: ["id"],
            relationships: [{ table: "projects", local_join_field: "project_id", foreign_join_field: "id" }],
            schema: "analytics",
            table: "events",
        })
        expect(calls).toEqual([{ kind: "db", id: "ANALYTICS" }])
        expect(client.close).toHaveBeenCalledTimes(1)
    })

    test("autocode_db_table returns sqlite metadata as a JSON string", async () => {
        const { calls, credentialResolver } = createFakeCredentialResolver({
            connection: "sqlite:/tmp/local.sqlite",
        })
        const { client } = createFakeClient([
            {
                match: `PRAGMA "main".table_info('users')`,
                response: [
                    { name: "id", notnull: 1, pk: 1, type: "INTEGER" },
                    { name: "org_id", notnull: 0, pk: 0, type: "TEXT" },
                ],
            },
            {
                match: `PRAGMA "main".index_list('users')`,
                response: [
                    { name: "users_org_idx", origin: "c" },
                    { name: "sqlite_autoindex_users_1", origin: "pk" },
                ],
            },
            {
                match: `PRAGMA "main".foreign_key_list('users')`,
                response: [{ table: "orgs", from: "org_id", to: "id" }],
            },
            {
                match: `PRAGMA "main".index_info('users_org_idx')`,
                response: [{ name: "org_id" }],
            },
        ])

        const tool = createAutocodeDbTableTool({ clientFactory: async () => client, credentialResolver })
        const result = await tool.execute({ db_key: "LOCAL", schema: "main", table: "users" }, createToolContext())

        expect(parseToolResult(result)).toEqual({
            fields: [
                { name: "id", nullable: false, type: "INTEGER" },
                { name: "org_id", nullable: true, type: "TEXT" },
            ],
            indices: [["org_id"]],
            pk: ["id"],
            relationships: [{ table: "orgs", local_join_field: "org_id", foreign_join_field: "id" }],
            schema: "main",
            table: "users",
        })
        expect(calls).toEqual([{ kind: "db", id: "LOCAL" }])
        expect(client.close).toHaveBeenCalledTimes(1)
    })

    test("autocode_db_table_read defaults limit to 7, defaults fields to all, and normalizes bigint/date rows", async () => {
        const { calls, credentialResolver } = createFakeCredentialResolver({
            connection: "postgres://readonly@db.example/reporting",
        })
        const { client, queries } = createFakeClient([
            {
                match: /SELECT \* FROM "public"\."orders" WHERE "status" = \$1 LIMIT \$2/,
                response: [{ id: 42n, created_at: new Date("2024-03-02T04:05:06.000Z"), status: "open" }],
            },
        ])

        const tool = createAutocodeDbTableReadTool({ clientFactory: async () => client, credentialResolver })
        const result = await tool.execute({
            db_key: "reporting",
            filters: [{ key: "status", operator: "=", value: "open" }],
            schema: "public",
            table: "orders",
        }, createToolContext())

        expect(queries).toEqual([{
            params: ["open", 7],
            sql: "SELECT * FROM \"public\".\"orders\" WHERE \"status\" = $1 LIMIT $2",
        }])
        expect(result).toBe(JSON.stringify([
            { id: "42", created_at: "2024-03-02T04:05:06.000Z", status: "open" },
        ]))
        expect(calls).toEqual([{ kind: "db", id: "REPORTING" }])
        expect(client.close).toHaveBeenCalledTimes(1)
    })

    test("aborts invalid db_key and invalid credential config without creating clients or leaking secrets", async (): Promise<void> => {
        const missing = createFakeCredentialResolver(new Error("MISSING_PROFILE_SECRET_QX201"))
        const invalidKey = createFakeCredentialResolver({
            connection: "postgres://KEY_USER_QX202:KEY_PASS_QX203@db.example/reporting",
        })
        const invalidProtocol = createFakeCredentialResolver({
            connection: "oracle://PROTOCOL_USER_QX204:PROTOCOL_PASS_QX205@db.example/analytics",
        })
        const { client } = createFakeClient([])
        const clientFactory = mock(async (): Promise<DbClient> => client)
        const missingProfileTool = createAutocodeDbTablesTool({ clientFactory, credentialResolver: missing.credentialResolver })
        const invalidKeyTool = createAutocodeDbTablesTool({ clientFactory, credentialResolver: invalidKey.credentialResolver })
        const invalidProtocolTool = createAutocodeDbTablesTool({ clientFactory, credentialResolver: invalidProtocol.credentialResolver })

        const results = [
            await missingProfileTool.execute({ db_key: "reporting_db", schema: "public" }, createToolContext()),
            await invalidKeyTool.execute({ db_key: "reporting db", schema: "public" }, createToolContext()),
            await invalidProtocolTool.execute({ db_key: "analytics", schema: "public" }, createToolContext()),
        ]

        for (const result of results) {
            expect(parseToolResult(result)).toEqual(parseToolResult(createAbortResponse("list database tables", new Error("Credential read failed."))))
            const serialized = JSON.stringify(parseToolResult(result))
            for (const secret of ["MISSING_PROFILE_SECRET_QX201", "KEY_USER_QX202", "KEY_PASS_QX203", "PROTOCOL_USER_QX204", "PROTOCOL_PASS_QX205"]) {
                expect(serialized).not.toContain(secret)
            }
        }
        expect(missing.calls).toEqual([{ kind: "db", id: "REPORTING_DB" }])
        expect(invalidKey.calls).toEqual([])
        expect(invalidProtocol.calls).toEqual([{ kind: "db", id: "ANALYTICS" }])
        expect(clientFactory).not.toHaveBeenCalled()
        expect(client.query).not.toHaveBeenCalled()
        expect(client.close).not.toHaveBeenCalled()
    })

    test.each([
        ["success", "Error"],
        ["create", "Error"],
        ["query", "Error"],
        ["close", "Error"],
        ["query and close", "Error"],
        ["create", "object"],
        ["query", "object"],
        ["close", "object"],
        ["create", "string"],
        ["query", "string"],
        ["close", "string"],
    ] as const)(
        "resolves once and retains first config during %s (%s payload)",
        async (stage, errorShape): Promise<void> => {
            const { error, expectedError, messageSecrets, profile, secrets } = createSensitiveFailure(stage === "query and close" ? "query" : stage)
            const rawObjectProperty = "RAW_OBJECT_PROPERTY_QX308"
            const causeSegment = `cause=${profile.password}/${profile.connection}`
            const failure = errorShape === "Error" ? error : errorShape === "string" ? `${error.message} ${causeSegment}` : {
                name: error.name,
                message: error.message,
                cause: error.cause,
                detail: rawObjectProperty,
                credentials: { ...profile },
            }
            const expectedFailure = errorShape === "Error" ? expectedError : errorShape === "string"
                ? `${expectedError.message} cause=[REDACTED]/[REDACTED_CONNECTION]`
                : new Error(expectedError.message)
            const failureMessage = typeof failure === "string" ? failure : failure.message
            for (const secret of messageSecrets) {
                expect(failureMessage).toContain(secret)
            }
            if (typeof failure === "string") {
                expect(failure).toContain(causeSegment)
            }
            const secondProfile: DbCredentialProfile = {
                connection: "mysql://SECOND_URL_USER_QX301:SECOND_URL_PASS_QX302@other.example/replaced",
                username: "SECOND_USER_QX303",
                password: "SECOND_PASS_QX304",
            }
            const { calls, credentialResolver } = createFakeCredentialResolver([profile, secondProfile])
            const configs: DbConfig[] = []
            const actions: Array<{ action: "query" | "close", config: DbConfig }> = []
            const cleanupMarker = "CLEANUP_FAILURE_ONLY_QX305"
            const cleanupError = Object.assign(new Error(`${cleanupMarker} ${profile.connection} ${profile.password}`, {
                cause: new Error("CLEANUP_CAUSE_ONLY_QX306"),
            }), { detail: "CLEANUP_PROPERTY_ONLY_QX307" })
            const client: DbClient = {
                query: mock(async (): Promise<QueryResponse> => {
                    const config = configs[0]!
                    actions.push({ action: "query", config })
                    expect(config.connection).toBe(profile.connection)
                    expect(config.username).toBe(profile.username)
                    expect(config.password).toBe(profile.password)
                    if (stage === "query" || stage === "query and close") {
                        throw failure
                    }
                    return [{ table_name: "orders" }]
                }),
                close: mock(async (): Promise<void> => {
                    const config = configs[0]!
                    actions.push({ action: "close", config })
                    expect(config.connection).toBe(profile.connection)
                    expect(config.username).toBe(profile.username)
                    expect(config.password).toBe(profile.password)
                    if (stage === "close") {
                        throw failure
                    }
                    if (stage === "query and close") {
                        throw cleanupError
                    }
                }),
            }
            const clientFactory = mock(async (config: DbConfig): Promise<DbClient> => {
                configs.push(config)
                expect(config).toMatchObject({ ...profile, adapter: "postgres", dbKey: "reporting_db", normalizedDbKey: "REPORTING_DB" })
                if (stage === "create") {
                    throw failure
                }
                return client
            })
            const tool = createAutocodeDbTablesTool({ clientFactory, credentialResolver })

            const result = await tool.execute({ db_key: " reporting_db ", schema: "public" }, createToolContext())

            expect(calls).toEqual([{ kind: "db", id: "REPORTING_DB" }])
            expect(clientFactory).toHaveBeenCalledTimes(1)
            expect(configs).toHaveLength(1)
            expect(configs[0]).toMatchObject({ ...profile, adapter: "postgres", dbKey: "reporting_db", normalizedDbKey: "REPORTING_DB" })
            expect(clientFactory.mock.calls[0]?.[0]).toBe(configs[0])
            expect(actions.map(({ action }): string => action)).toEqual(stage === "create" ? [] : ["query", "close"])
            for (const action of actions) {
                expect(action.config).toBe(configs[0])
            }
            expect(client.close).toHaveBeenCalledTimes(stage === "create" ? 0 : 1)
            expect(client.query).toHaveBeenCalledTimes(stage === "create" ? 0 : 1)
            if (stage !== "create") {
                expect(client.query).toHaveBeenCalledWith(
                    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
                    ["public"]
                )
            }
            if (stage === "success") {
                expect(parseToolResult(result)).toEqual(["orders"])
            }
            else {
                expect(parseToolResult(result)).toEqual(parseToolResult(createAbortResponse("list database tables", expectedFailure)))
            }
            const serialized = JSON.stringify(parseToolResult(result))
            if (typeof failure === "string") {
                expect(serialized).not.toContain(causeSegment)
                expect(parseToolResult(result)).toHaveProperty("error", expectedFailure)
            }
            if (stage === "query and close") {
                expect(result).toBe(createAbortResponse("list database tables", expectedError))
                expect(parseToolResult(result)).toHaveProperty("error", `DbFailure_[REDACTED]: ${expectedError.message}`)
                expect(client.close).toHaveBeenCalledTimes(1)
                expect(serialized).not.toContain(cleanupError.message)
                expect(serialized).not.toContain(`${cleanupMarker} [REDACTED_CONNECTION] [REDACTED]`)
            }
            for (const secret of [...secrets, secondProfile.connection, secondProfile.username!, secondProfile.password!, cleanupMarker, "CLEANUP_CAUSE_ONLY_QX306", "CLEANUP_PROPERTY_ONLY_QX307", rawObjectProperty]) {
                expect(serialized).not.toContain(secret)
            }
            expect(serialized).not.toContain('"cause"')
            expect(serialized).not.toContain('"detail"')
            expect(serialized).not.toContain('"credentials"')
        }
    )

    test("autocode_db_schemas returns schemas for postgres", async () => {
        const { calls, credentialResolver } = createFakeCredentialResolver({
            connection: "postgres://readonly@db.example/reporting",
        })
        const { client } = createFakeClient([
            {
                match: "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name",
                response: [{ schema_name: "information_schema" }, { schema_name: "public" }],
            },
        ])

        const tool = createAutocodeDbSchemasTool({ clientFactory: async () => client, credentialResolver })
        const result = await tool.execute({ db_key: "reporting" }, createToolContext())

        expect(typeof result).toBe("string")
        expect(parseToolResult(result)).toEqual(["information_schema", "public"])
        expect(calls).toEqual([{ kind: "db", id: "REPORTING" }])
        expect(client.close).toHaveBeenCalledTimes(1)
    })

    test("autocode_db_schemas returns schemas for mysql", async () => {
        const { calls, credentialResolver } = createFakeCredentialResolver({
            connection: "mysql://readonly@db.example/analytics",
        })
        const { client } = createFakeClient([
            {
                match: "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name",
                response: [{ schema_name: "analytics" }, { schema_name: "information_schema" }],
            },
        ])

        const tool = createAutocodeDbSchemasTool({ clientFactory: async () => client, credentialResolver })
        const result = await tool.execute({ db_key: "analytics" }, createToolContext())

        expect(parseToolResult(result)).toEqual(["analytics", "information_schema"])
        expect(calls).toEqual([{ kind: "db", id: "ANALYTICS" }])
        expect(client.close).toHaveBeenCalledTimes(1)
    })

    test("autocode_db_schemas returns attached databases for sqlite", async () => {
        const { calls, credentialResolver } = createFakeCredentialResolver({
            connection: "sqlite:/tmp/local.sqlite",
        })
        const { client } = createFakeClient([
            {
                match: "PRAGMA database_list",
                response: [
                    { seq: 0, name: "main", file: "/tmp/local.sqlite" },
                    { seq: 1, name: "temp", file: "" },
                ],
            },
        ])

        const tool = createAutocodeDbSchemasTool({ clientFactory: async () => client, credentialResolver })
        const result = await tool.execute({ db_key: "LOCAL" }, createToolContext())

        expect(parseToolResult(result)).toEqual(["main", "temp"])
        expect(calls).toEqual([{ kind: "db", id: "LOCAL" }])
        expect(client.close).toHaveBeenCalledTimes(1)
    })

    test.each([
        ["resolver rejection", new Error("RESOLVER_REJECTION_SECRET_QX401")],
        ["missing connection", { username: "INCOMPLETE_USER_QX402", password: "INCOMPLETE_PASS_QX403" } as unknown as DbCredentialProfile],
        ["blank connection", { connection: " \t\n ", username: "INCOMPLETE_USER_QX402", password: "INCOMPLETE_PASS_QX403" }],
    ] satisfies Array<[string, DbCredentialProfile | Error]>)(
        "autocode_db_schemas aborts %s without fallback or client creation",
        async (_label: string, profile: DbCredentialProfile | Error): Promise<void> => {
            const { calls, credentialResolver } = createFakeCredentialResolver([
                profile,
                { connection: "postgres://FALLBACK_USER_QX404:FALLBACK_PASS_QX405@db.example/reporting" },
            ])
            const { client } = createFakeClient([])
            const clientFactory = mock(async (): Promise<DbClient> => client)
            const tool = createAutocodeDbSchemasTool({ clientFactory, credentialResolver })

            const result = await tool.execute({ db_key: " reporting " }, createToolContext())

            expect(parseToolResult(result)).toEqual(parseToolResult(createAbortResponse("list database schemas", new Error("Credential read failed."))))
            expect(calls).toEqual([{ kind: "db", id: "REPORTING" }])
            expect(clientFactory).not.toHaveBeenCalled()
            expect(client.query).not.toHaveBeenCalled()
            expect(client.close).not.toHaveBeenCalled()
            const serialized = JSON.stringify(parseToolResult(result))
            for (const secret of ["RESOLVER_REJECTION_SECRET_QX401", "INCOMPLETE_USER_QX402", "INCOMPLETE_PASS_QX403", "FALLBACK_USER_QX404", "FALLBACK_PASS_QX405"]) {
                expect(serialized).not.toContain(secret)
            }
        }
    )
})

describe("db utils query safety", () => {
    test("resolves one whole DB profile with normalized key and trims config fields", async (): Promise<void> => {
        const { calls, credentialResolver } = createFakeCredentialResolver({
            connection: " \tJDBC:postgresql://readonly@db.example/reporting \n",
            username: " readonly ",
            password: " secret ",
        })
        const config = await loadDbConfig(" reporting_db ", credentialResolver)

        expect(config).toMatchObject({
            adapter: "postgres",
            connection: "postgresql://readonly@db.example/reporting",
            dbKey: "reporting_db",
            normalizedDbKey: "REPORTING_DB",
            password: "secret",
            username: "readonly",
        })
        expect(calls).toEqual([{ kind: "db", id: "REPORTING_DB" }])
        expect(normalizeDbKey("reporting_db")).toBe("REPORTING_DB")
        expect(normalizeDbKey("RePoRtInG_123")).toBe("REPORTING_123")
    })

    test.each([
        ["missing", { username: "INCOMPLETE_USER_QX501", password: "INCOMPLETE_PASS_QX502" } as unknown as DbCredentialProfile],
        ["empty", { connection: "" }],
        ["whitespace", { connection: " \t\r\n " }],
    ] satisfies Array<[string, DbCredentialProfile]>)(
        "rejects %s connection without resolving a fallback profile",
        async (_label: string, profile: DbCredentialProfile): Promise<void> => {
            const { calls, credentialResolver } = createFakeCredentialResolver([
                profile,
                { connection: "postgres://unused@db.example/fallback" },
            ])

            await expect(loadDbConfig("reporting", credentialResolver)).rejects.toThrow("Invalid database credential profile. Connection is required.")
            expect(calls).toEqual([{ kind: "db", id: "REPORTING" }])
        }
    )

    test.each([
        ["absent", { connection: "postgres://db.example/reporting" }],
        ["empty", { connection: "postgres://db.example/reporting", username: "", password: "" }],
        ["whitespace", { connection: "postgres://db.example/reporting", username: " \t\n ", password: " \r\n " }],
    ] satisfies Array<[string, DbCredentialProfile]>)(
        "leaves %s optional DB credentials undefined",
        async (_label: string, profile: DbCredentialProfile): Promise<void> => {
            const { calls, credentialResolver } = createFakeCredentialResolver(profile)

            const config = await loadDbConfig("reporting", credentialResolver)

            expect(config.username).toBeUndefined()
            expect(config.password).toBeUndefined()
            expect(calls).toEqual([{ kind: "db", id: "REPORTING" }])
        }
    )

    test.each([
        ["postgres://db.example/reporting", "postgres"],
        ["postgresql://db.example/reporting", "postgres"],
        ["mysql://db.example/reporting", "mysql"],
        ["mariadb://db.example/reporting", "mariadb"],
        ["sqlite:C:/data/local.sqlite", "sqlite"],
        ["sqlite://C:/data/local.sqlite", "sqlite"],
        ["file:///C:/data/local.sqlite", "sqlite"],
        ["jdbc:postgres://db.example/reporting", "postgres"],
        ["JDBC:postgresql://db.example/reporting", "postgres"],
        ["jdbc:mysql://db.example/reporting", "mysql"],
        ["jdbc:mariadb://db.example/reporting", "mariadb"],
    ] satisfies Array<[string, DbAdapter]>)("preserves adapter for trimmed connection %s", async (connection: string, adapter: DbAdapter): Promise<void> => {
        const { calls, credentialResolver } = createFakeCredentialResolver({ connection: ` \t${connection}\n ` })

        const config = await loadDbConfig("reporting", credentialResolver)

        expect(config.adapter).toBe(adapter)
        expect(config.connection).toBe(connection.replace(/^jdbc:/i, ""))
        expect(calls).toEqual([{ kind: "db", id: "REPORTING" }])
    })

    test.each([
        "",
        " \t\r\n ",
        "reporting-db",
        "reporting.db",
        "reporting db",
        "reporting/db",
        "reporting;DROP_TABLE",
        "reporting' OR '1'='1",
        "reporting\0db",
        "rｅporting",
    ])("rejects invalid db_key %j before credential resolution", async (dbKey: string): Promise<void> => {
        const { calls, credentialResolver } = createFakeCredentialResolver({ connection: "postgres://db.example/reporting" })

        await expect(loadDbConfig(dbKey, credentialResolver)).rejects.toThrow("Invalid db_key. Use only ASCII letters, digits, and underscores.")
        expect(calls).toEqual([])
    })

    test.each(["lowercase", "reporting_db_123", "123", "_"])(
        "accepts db_key %s and resolves its uppercase normalized ID",
        async (dbKey: string): Promise<void> => {
            const { calls, credentialResolver } = createFakeCredentialResolver({ connection: "postgres://db.example/reporting" })

            const config = await loadDbConfig(` ${dbKey} `, credentialResolver)

            expect(config.dbKey).toBe(dbKey)
            expect(config.normalizedDbKey).toBe(dbKey.toUpperCase())
            expect(calls).toEqual([{ kind: "db", id: dbKey.toUpperCase() }])
        }
    )

    test("replaces credential resolver rejection with a generic error without fallback", async (): Promise<void> => {
        const failure = Object.assign(new Error("RESOLVER_MESSAGE_QX601", {
            cause: new Error("RESOLVER_CAUSE_QX602"),
        }), { name: "RESOLVER_NAME_QX603", detail: "RESOLVER_PROPERTY_QX604" })
        const { calls, credentialResolver } = createFakeCredentialResolver([
            failure,
            { connection: "postgres://unused@db.example/fallback" },
        ])

        await expect(loadDbConfig("reporting", credentialResolver)).rejects.toEqual(new Error("Credential read failed."))
        expect(calls).toEqual([{ kind: "db", id: "REPORTING" }])
    })

    test("rejects unsupported connection protocols without echoing credentials", async (): Promise<void> => {
        const { calls, credentialResolver } = createFakeCredentialResolver({
            connection: "oracle://UNSUPPORTED_USER_QX605:UNSUPPORTED_PASS_QX606@db.example/reporting",
        })

        await expect(loadDbConfig("reporting", credentialResolver)).rejects.toThrow("Unsupported database protocol. Use PostgreSQL, MySQL, MariaDB, or SQLite connection formats.")
        expect(calls).toEqual([{ kind: "db", id: "REPORTING" }])
    })

    test("rejects invalid identifiers, unsupported operators, bad limits, conflicting sorts, and bad in filters", () => {
        const invalidIdentifiers = ["users.id", "users id", "users;drop", "users*", "count(id)", '"users"']

        for (const invalidIdentifier of invalidIdentifiers) {
            expect(() => buildReadOnlySelectQuery({
                adapter: "postgres",
                fields: ["id"],
                limit: 5,
                schema: "public",
                table: invalidIdentifier,
            })).toThrow("Invalid table")

            expect(() => buildReadOnlySelectQuery({
                adapter: "postgres",
                fields: [invalidIdentifier],
                limit: 5,
                schema: "public",
                table: "users",
            })).toThrow("Invalid field")

            expect(() => buildReadOnlySelectQuery({
                adapter: "postgres",
                filters: [{ key: invalidIdentifier, operator: "=", value: 1 }],
                limit: 5,
                schema: "public",
                table: "users",
            })).toThrow("Invalid filter key")
        }

        expect(() => buildReadOnlySelectQuery({
            adapter: "postgres",
            filters: [{ key: "id", operator: "contains" as DbFilter["operator"], value: 1 }],
            limit: 5,
            schema: "public",
            table: "users",
        })).toThrow("Unsupported filter operator.")
        expect(() => buildReadOnlySelectQuery({ adapter: "postgres", limit: 0, schema: "public", table: "users" })).toThrow("Invalid limit")
        expect(() => buildReadOnlySelectQuery({ adapter: "postgres", limit: 101, schema: "public", table: "users" })).toThrow("Invalid limit")
        expect(() => buildReadOnlySelectQuery({ adapter: "postgres", limit: 3.5, schema: "public", table: "users" })).toThrow("Invalid limit")
        expect(() => buildReadOnlySelectQuery({
            adapter: "postgres",
            limit: 5,
            schema: "public",
            sortAsc: "id",
            sortDesc: "created_at",
            table: "users",
        })).toThrow("Provide only one of sort_asc or sort_desc.")
        expect(() => buildReadOnlySelectQuery({
            adapter: "postgres",
            filters: [{ key: "id", operator: "in", value: [] }],
            limit: 5,
            schema: "public",
            table: "users",
        })).toThrow("Invalid in filter. Provide a non-empty array value.")
        expect(() => buildReadOnlySelectQuery({
            adapter: "postgres",
            filters: [{ key: "id", operator: "in", value: "1,2" }],
            limit: 5,
            schema: "public",
            table: "users",
        })).toThrow("Invalid in filter. Provide a non-empty array value.")
        expect(() => buildReadOnlySelectQuery({
            adapter: "postgres",
            filters: [{ key: "deleted_at", operator: "is_null", value: false }],
            limit: 5,
            schema: "public",
            table: "users",
        })).toThrow("is_null filters must omit value.")
    })

    test("supports parameterized postgres filters with quoted identifiers and descending sort", () => {
        const query = buildReadOnlySelectQuery({
            adapter: "postgres",
            fields: ["id", "created_at"],
            filters: [
                { key: "status", operator: "=", value: "open" },
                { key: "role", operator: "!=", value: "guest" },
                { key: "score", operator: "<", value: 9 },
                { key: "min_score", operator: "<=", value: 10 },
                { key: "max_score", operator: ">", value: 1 },
                { key: "updated_at", operator: ">=", value: "2024-01-01" },
                { key: "email", operator: "like", value: "%@example.com" },
                { key: "id", operator: "in", value: [1, 2] },
                { key: "deleted_at", operator: "is_null" },
            ],
            limit: 25,
            schema: "public",
            sortDesc: "created_at",
            table: "users",
        })

        expect(query).toEqual({
            params: ["open", "guest", 9, 10, 1, "2024-01-01", "%@example.com", 1, 2, 25],
            sql: "SELECT \"id\", \"created_at\" FROM \"public\".\"users\" WHERE \"status\" = $1 AND \"role\" != $2 AND \"score\" < $3 AND \"min_score\" <= $4 AND \"max_score\" > $5 AND \"updated_at\" >= $6 AND \"email\" LIKE $7 AND \"id\" IN ($8, $9) AND \"deleted_at\" IS NULL ORDER BY \"created_at\" DESC LIMIT $10",
        })
    })

    test("supports parameterized mysql filters with quoted identifiers and ascending sort", () => {
        const query = buildReadOnlySelectQuery({
            adapter: "mysql",
            filters: [{ key: "kind", operator: "=", value: "click" }],
            limit: 7,
            schema: "analytics",
            sortAsc: "id",
            table: "events",
        })

        expect(query).toEqual({
            params: ["click", 7],
            sql: "SELECT * FROM `analytics`.`events` WHERE `kind` = ? ORDER BY `id` ASC LIMIT ?",
        })
    })
})
