import { tool } from "@opencode-ai/plugin"
import { createRuntimeCredentialResolver } from "@/credentials/runtime"
import type { CredentialResolver } from "@/credentials/types"
import {
    buildReadOnlySelectQuery,
    defaultDbClientFactory,
    loadDbConfig,
    normalizeJsonRows,
    normalizeJsonValue,
    readDbSchemas,
    readDbTableMetadata,
    readDbTables,
    resolveDbSchema,
    sanitizeDbError,
    type DbAdapter,
    type DbClient,
    type DbClientFactory,
    type DbConfig,
    type DbFilter,
} from "@/utils/db"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

export type DbDeps = {
    clientFactory?: DbClientFactory
    credentialResolver?: CredentialResolver
}

const DB_KEY_DESCRIPTION = "Use correct db_key to unlock your database."
const SCHEMA_DESCRIPTION = "DB schema name as a single identifier. Use autocode_db_schemas first when uncertain."
const TABLE_DESCRIPTION = "DB table name as a single identifier. Use autocode_db_tables first when uncertain."
const RETRY_INSTRUCTION = "Provide a valid db_key/schema/table/fields/filters request or configure the required database credential profile."
const FILTER_OPERATORS = ["=", "!=", "<", "<=", ">", ">=", "like", "in", "is_null"] as const

function getDeps(deps?: DbDeps): Required<DbDeps> {
    return {
        clientFactory: deps?.clientFactory ?? defaultDbClientFactory,
        credentialResolver: deps?.credentialResolver ?? createRuntimeCredentialResolver(),
    }
}

async function withClient<T>(action: string, deps: Required<DbDeps>, dbKey: string, run: (client: DbClient, adapter: DbAdapter) => Promise<T>): Promise<string> {
    let client: DbClient | undefined
    let config: DbConfig | undefined
    let response: string
    let succeeded = false

    try {
        config = await loadDbConfig(dbKey, deps.credentialResolver)
        client = await deps.clientFactory(config)
        const result = await run(client, config.adapter)
        response = JSON.stringify(normalizeJsonValue(result))
        succeeded = true
    }
    catch (error) {
        const sanitizedError = config ? sanitizeDbError(error, config) : new Error("Credential read failed.")
        if (isRetryableDbError(sanitizedError)) {
            response = createRetryResponse(action, retryMessage(sanitizedError), RETRY_INSTRUCTION)
        }
        else {
            response = createAbortResponse(action, sanitizedError)
        }
    }
    finally {
        if (client) {
            try {
                await client.close()
            }
            catch (error) {
                const sanitizedError = sanitizeDbError(error, config)
                if (succeeded) {
                    response = createAbortResponse(action, sanitizedError)
                }
            }
        }
    }

    return response
}

function isRetryableDbError(error: unknown): boolean {
    return error instanceof Error && (
        error.message.startsWith("Invalid ")
        || error.message.startsWith("Provide only one")
        || error.message.startsWith("Unsupported ")
        || error.message.startsWith("is_null ")
    )
}

function retryMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Invalid database request."
}

export function createAutocodeDbTablesTool(deps?: DbDeps): ReturnType<typeof tool> {
    const resolvedDeps = getDeps(deps)

    return tool({
        description: "List all db table names for a given db_key.",
        args: {
            db_key: tool.schema.string().describe(DB_KEY_DESCRIPTION),
            schema: tool.schema.string().optional().describe("Optional schema/database name. Defaults are adapter-specific."),
        },
        async execute(args) {
            return withClient("list database tables", resolvedDeps, args.db_key, async (client, adapter) => {
                const schema = await resolveDbSchema(client, adapter, args.schema)
                return await readDbTables(client, adapter, schema)
            })
        },
    })
}

export function createAutocodeDbTableTool(deps?: DbDeps): ReturnType<typeof tool> {
    const resolvedDeps = getDeps(deps)

    return tool({
        description: "Read db table metadata (fields, types, pk, indices, relationships) for specific table.",
        args: {
            db_key: tool.schema.string().describe(DB_KEY_DESCRIPTION),
            schema: tool.schema.string().describe(SCHEMA_DESCRIPTION),
            table: tool.schema.string().describe(TABLE_DESCRIPTION),
        },
        async execute(args) {
            return withClient("describe database table", resolvedDeps, args.db_key, async (client, adapter) => {
                return await readDbTableMetadata(client, adapter, args.schema, args.table)
            })
        },
    })
}

export function createAutocodeDbTableReadTool(deps?: DbDeps): ReturnType<typeof tool> {
    const resolvedDeps = getDeps(deps)

    return tool({
        description: "Read records from a specific db table.",
        args: {
            db_key: tool.schema.string().describe(DB_KEY_DESCRIPTION),
            fields: tool.schema.array(tool.schema.string()).optional().describe("Optional field list. Omit to return all columns."),
            filters: tool.schema.array(tool.schema.object({
                key: tool.schema.string(),
                operator: tool.schema.enum(FILTER_OPERATORS),
                value: tool.schema.unknown().optional(),
            })).optional().describe("Optional filter list using operators =, !=, <, <=, >, >=, like, in, is_null. Use autocode_db_table to find available fields."),
            limit: tool.schema.number().int().min(1).max(40).optional().describe("Optional row limit from 1 to 40. Defaults to 7."),
            schema: tool.schema.string().describe(SCHEMA_DESCRIPTION),
            sort_asc: tool.schema.string().optional().describe("Optional ascending sort field."),
            sort_desc: tool.schema.string().optional().describe("Optional descending sort field. Do not combine with sort_asc."),
            table: tool.schema.string().describe(TABLE_DESCRIPTION),
        },
        async execute(args) {
            return withClient("read database table rows", resolvedDeps, args.db_key, async (client, adapter) => {
                const query = buildReadOnlySelectQuery({
                    adapter,
                    fields: args.fields,
                    filters: args.filters as DbFilter[] | undefined,
                    limit: args.limit ?? 7,
                    schema: args.schema,
                    sortAsc: args.sort_asc,
                    sortDesc: args.sort_desc,
                    table: args.table,
                })
                const rows = await client.query(query.sql, query.params)
                return normalizeJsonRows(rows)
            })
        },
    })
}

export function createAutocodeDbSchemasTool(deps?: DbDeps): ReturnType<typeof tool> {
    const resolvedDeps = getDeps(deps)

    return tool({
        description: "List all available db schemas for a given db_key.",
        args: {
            db_key: tool.schema.string().describe(DB_KEY_DESCRIPTION),
        },
        async execute(args) {
            return withClient("list database schemas", resolvedDeps, args.db_key, async (client, adapter) => {
                return await readDbSchemas(client, adapter)
            })
        },
    })
}
