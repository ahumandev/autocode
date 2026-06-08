import { describe, beforeEach, expect, mock, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin"
import { createNoopAsk } from "./test_context"
import {
    buildReadOnlySelectQuery,
    loadDbConfig,
    normalizeDbKey,
    type DbClient,
    type DbConfig,
    type DbFilter,
} from "@/utils/db"
import { createAbortResponse, resetRetryCounts } from "@/utils/tools"
import { createAutocodeDbTableReadTool, createAutocodeDbTableTool, createAutocodeDbSchemasTool, createAutocodeDbTablesTool } from "./autocode_db"

type QueryResponse = Record<string, unknown>[]
type QueryHandler = {
    match: RegExp | string
    response: QueryResponse
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

function createFakeClient(handlers: QueryHandler[]) {
    const queries: Array<{ params: unknown[] | undefined, sql: string }> = []
    const client: DbClient & { close: ReturnType<typeof mock>, query: ReturnType<typeof mock> } = {
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
    test("autocode_db_tables returns a JSON string using injected env and client factory", async () => {
        const env = {
            AUTOCODE_DB_REPORTING_CONNECTION: "postgres://readonly@db.example/reporting",
            AUTOCODE_DB_REPORTING_USERNAME: "readonly",
            AUTOCODE_DB_REPORTING_PASSWORD: "secret",
        } satisfies NodeJS.ProcessEnv
        const { client } = createFakeClient([
            {
                match: "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
                response: [{ table_name: "orders" }, { table_name: "users" }],
            },
        ])
        const clientFactory = mock(async (config: DbConfig): Promise<DbClient> => {
            expect(config.dbKey).toBe("reporting")
            expect(config.normalizedDbKey).toBe("REPORTING")
            expect(config.connectionEnvVar).toBe("AUTOCODE_DB_REPORTING_CONNECTION")
            expect(config.usernameEnvVar).toBe("AUTOCODE_DB_REPORTING_USERNAME")
            expect(config.passwordEnvVar).toBe("AUTOCODE_DB_REPORTING_PASSWORD")
            return client
        })

        const tool = createAutocodeDbTablesTool({ clientFactory, env })
        const result = await tool.execute({ db_key: "reporting", schema: "public" }, createToolContext())

        expect(typeof result).toBe("string")
        expect(result).toBe(JSON.stringify(["orders", "users"]))
        expect(parseToolResult(result)).toEqual(["orders", "users"])
        expect(clientFactory).toHaveBeenCalledTimes(1)
        expect(client.query).toHaveBeenCalledWith(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
            ["public"]
        )
        expect(client.close).toHaveBeenCalledTimes(1)
    })

    test("autocode_db_table returns postgres metadata as a JSON string", async () => {
        const env = {
            AUTOCODE_DB_REPORTING_CONNECTION: "postgres://readonly@db.example/reporting",
        } satisfies NodeJS.ProcessEnv
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

        const tool = createAutocodeDbTableTool({ clientFactory: async () => client, env })
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
    })

    test("autocode_db_table returns mysql metadata as a JSON string", async () => {
        const env = {
            AUTOCODE_DB_ANALYTICS_CONNECTION: "mysql://readonly@db.example/analytics",
        } satisfies NodeJS.ProcessEnv
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

        const tool = createAutocodeDbTableTool({ clientFactory: async () => client, env })
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
    })

    test("autocode_db_table returns sqlite metadata as a JSON string", async () => {
        const env = {
            AUTOCODE_DB_LOCAL_CONNECTION: "sqlite:/tmp/local.sqlite",
        } satisfies NodeJS.ProcessEnv
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

        const tool = createAutocodeDbTableTool({ clientFactory: async () => client, env })
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
    })

    test("autocode_db_table_read defaults limit to 7, defaults fields to all, and normalizes bigint/date rows", async () => {
        const env = {
            AUTOCODE_DB_REPORTING_CONNECTION: "postgres://readonly@db.example/reporting",
        } satisfies NodeJS.ProcessEnv
        const { client, queries } = createFakeClient([
            {
                match: /SELECT \* FROM "public"\."orders" WHERE "status" = \$1 LIMIT \$2/,
                response: [{ id: 42n, created_at: new Date("2024-03-02T04:05:06.000Z"), status: "open" }],
            },
        ])

        const tool = createAutocodeDbTableReadTool({ clientFactory: async () => client, env })
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
    })

    test("returns retry responses for invalid db_key and invalid env config without leaking secrets", async () => {
        const missingEnvTool = createAutocodeDbTablesTool({ env: {} })
        const invalidKeyTool = createAutocodeDbTablesTool({
            env: {
                AUTOCODE_DB_REPORTING_DB_CONNECTION: "postgres://readonly:supersecret@db.example/reporting",
            },
        })
        const invalidProtocolTool = createAutocodeDbTablesTool({
            env: {
                AUTOCODE_DB_ANALYTICS_CONNECTION: "oracle://readonly:supersecret@db.example/analytics",
            },
        })

        const missingEnvResult = await missingEnvTool.execute({ db_key: "reporting_db", schema: "public" }, createToolContext())
        const invalidKeyResult = await invalidKeyTool.execute({ db_key: "reporting db", schema: "public" }, createToolContext())
        const invalidProtocolResult = await invalidProtocolTool.execute({ db_key: "analytics", schema: "public" }, createToolContext())

        expect(parseToolResult(missingEnvResult)).toEqual({
            failedAction: "list database tables",
            error: "Missing required environment variable: AUTOCODE_DB_REPORTING_DB_CONNECTION",
            instruction: "Provide a valid db_key/schema/table/fields/filters request or configure the required AUTOCODE_DB_<KEY> environment variables.",
        })
        expect(parseToolResult(invalidKeyResult)).toEqual({
            failedAction: "list database tables",
            error: "Invalid db_key. Use only ASCII letters, digits, and underscores.",
            instruction: "Provide a valid db_key/schema/table/fields/filters request or configure the required AUTOCODE_DB_<KEY> environment variables.",
        })
        expect(parseToolResult(invalidProtocolResult)).toEqual({
            failedAction: "list database tables",
            error: "Unsupported database protocol. Use PostgreSQL, MySQL, MariaDB, or SQLite connection formats.",
            instruction: "Provide a valid db_key/schema/table/fields/filters request or configure the required AUTOCODE_DB_<KEY> environment variables.",
        })
        expect(missingEnvResult).not.toContain("supersecret")
        expect(missingEnvResult).not.toContain("postgres://readonly:supersecret@db.example/reporting")
        expect(invalidKeyResult).not.toContain("supersecret")
        expect(invalidProtocolResult).not.toContain("supersecret")
        expect(invalidProtocolResult).not.toContain("oracle://readonly:supersecret@db.example/analytics")
    })

    test("sanitizes abort responses when client errors include connection credentials", async () => {
        const env = {
            AUTOCODE_DB_REPORTING_CONNECTION: "postgres://readonly:supersecret@db.example/reporting",
            AUTOCODE_DB_REPORTING_USERNAME: "readonly",
            AUTOCODE_DB_REPORTING_PASSWORD: "supersecret",
        } satisfies NodeJS.ProcessEnv
        const tool = createAutocodeDbTablesTool({
            clientFactory: async () => {
                throw new Error("failed to connect to postgres://readonly:supersecret@db.example/reporting as readonly with supersecret")
            },
            env,
        })

        const result = await tool.execute({ db_key: "reporting", schema: "public" }, createToolContext())

        expect(result).toBe(createAbortResponse(
            "list database tables",
            new Error("failed to connect to [REDACTED_CONNECTION] as [REDACTED] with [REDACTED]")
        ))
        expect(result).not.toContain("supersecret")
        expect(result).not.toContain("postgres://readonly:supersecret@db.example/reporting")
    })

    test("autocode_db_schemas returns schemas for postgres", async () => {
        const env = {
            AUTOCODE_DB_REPORTING_CONNECTION: "postgres://readonly@db.example/reporting",
        } satisfies NodeJS.ProcessEnv
        const { client } = createFakeClient([
            {
                match: "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name",
                response: [{ schema_name: "information_schema" }, { schema_name: "public" }],
            },
        ])

        const tool = createAutocodeDbSchemasTool({ clientFactory: async () => client, env })
        const result = await tool.execute({ db_key: "reporting" }, createToolContext())

        expect(typeof result).toBe("string")
        expect(parseToolResult(result)).toEqual(["information_schema", "public"])
        expect(client.close).toHaveBeenCalledTimes(1)
    })

    test("autocode_db_schemas returns schemas for mysql", async () => {
        const env = {
            AUTOCODE_DB_ANALYTICS_CONNECTION: "mysql://readonly@db.example/analytics",
        } satisfies NodeJS.ProcessEnv
        const { client } = createFakeClient([
            {
                match: "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name",
                response: [{ schema_name: "analytics" }, { schema_name: "information_schema" }],
            },
        ])

        const tool = createAutocodeDbSchemasTool({ clientFactory: async () => client, env })
        const result = await tool.execute({ db_key: "analytics" }, createToolContext())

        expect(parseToolResult(result)).toEqual(["analytics", "information_schema"])
    })

    test("autocode_db_schemas returns attached databases for sqlite", async () => {
        const env = {
            AUTOCODE_DB_LOCAL_CONNECTION: "sqlite:/tmp/local.sqlite",
        } satisfies NodeJS.ProcessEnv
        const { client } = createFakeClient([
            {
                match: "PRAGMA database_list",
                response: [
                    { seq: 0, name: "main", file: "/tmp/local.sqlite" },
                    { seq: 1, name: "temp", file: "" },
                ],
            },
        ])

        const tool = createAutocodeDbSchemasTool({ clientFactory: async () => client, env })
        const result = await tool.execute({ db_key: "LOCAL" }, createToolContext())

        expect(parseToolResult(result)).toEqual(["main", "temp"])
    })

    test("autocode_db_schemas returns retry response for missing env", async () => {
        const tool = createAutocodeDbSchemasTool({ env: {} })
        const result = await tool.execute({ db_key: "reporting" }, createToolContext())

        expect(parseToolResult(result)).toEqual({
            failedAction: "list database schemas",
            error: "Missing required environment variable: AUTOCODE_DB_REPORTING_CONNECTION",
            instruction: "Provide a valid db_key/schema/table/fields/filters request or configure the required AUTOCODE_DB_<KEY> environment variables.",
        })
    })
})

describe("db utils query safety", () => {
    test("reads env vars with uppercase normalized db_key and trims original db_key", () => {
        const config = loadDbConfig(" reporting_db ", {
            AUTOCODE_DB_REPORTING_DB_CONNECTION: "postgres://readonly@db.example/reporting",
            AUTOCODE_DB_REPORTING_DB_USERNAME: " readonly ",
            AUTOCODE_DB_REPORTING_DB_PASSWORD: " secret ",
        })

        expect(config).toMatchObject({
            adapter: "postgres",
            connection: "postgres://readonly@db.example/reporting",
            connectionEnvVar: "AUTOCODE_DB_REPORTING_DB_CONNECTION",
            dbKey: "reporting_db",
            normalizedDbKey: "REPORTING_DB",
            password: "secret",
            passwordEnvVar: "AUTOCODE_DB_REPORTING_DB_PASSWORD",
            username: "readonly",
            usernameEnvVar: "AUTOCODE_DB_REPORTING_DB_USERNAME",
        })
        expect(normalizeDbKey("reporting_db")).toBe("REPORTING_DB")
        expect(normalizeDbKey("RePoRtInG_123")).toBe("REPORTING_123")
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
