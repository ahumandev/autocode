import { SQL } from "bun"

export const DB_KEY_PATTERN = /^[A-Za-z0-9_]+$/
export const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const BINARY_TYPE = "Buffer"

export type DbAdapter = "postgres" | "mysql" | "mariadb" | "sqlite"

export type DbConfig = {
    adapter: DbAdapter
    connection: string
    connectionEnvVar: string
    dbKey: string
    normalizedDbKey: string
    password?: string
    passwordEnvVar: string
    username?: string
    usernameEnvVar: string
}

export type DbClient = {
    close: () => Promise<void>
    query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>
}

export type DbClientFactory = (config: DbConfig) => Promise<DbClient>

export type DbFilterOperator = "=" | "!=" | "<" | "<=" | ">" | ">=" | "like" | "in" | "is_null"

export type DbFilter = {
    key: string
    operator: DbFilterOperator
    value?: unknown
}

export type ReadOnlySelectInput = {
    adapter: DbAdapter
    fields?: string[]
    filters?: DbFilter[]
    limit: number
    schema: string
    sortAsc?: string
    sortDesc?: string
    table: string
}

export type ReadOnlySelectQuery = {
    params: unknown[]
    sql: string
}

export type DbTableField = {
    name: string
    nullable?: boolean
    type: string
}

export type DbTableRelationship = {
    foreign_join_field: string
    local_join_field: string
    table: string
}

export type DbTableMetadata = {
    fields: DbTableField[]
    indices: string[][]
    pk: string[]
    relationships: DbTableRelationship[]
    schema: string
    table: string
}

type BunSqlClient = {
    close?: () => Promise<unknown> | unknown
    end?: () => Promise<unknown> | unknown
    unsafe: (sql: string, params?: unknown[]) => Promise<unknown>
}

export function normalizeDbKey(dbKey: string): string {
    const trimmed = dbKey.trim()

    if (!DB_KEY_PATTERN.test(trimmed)) {
        throw new Error("Invalid db_key. Use only ASCII letters, digits, and underscores.")
    }

    return trimmed.toUpperCase()
}

export function getDbEnvVarNames(normalizedDbKey: string): {
    connectionEnvVar: string
    passwordEnvVar: string
    usernameEnvVar: string
} {
    return {
        connectionEnvVar: `AUTOCODE_DB_${normalizedDbKey}_CONNECTION`,
        passwordEnvVar: `AUTOCODE_DB_${normalizedDbKey}_PASSWORD`,
        usernameEnvVar: `AUTOCODE_DB_${normalizedDbKey}_USERNAME`,
    }
}

export function normalizeConnectionString(connection: string): string {
    // Strip JDBC-style prefix (e.g. "jdbc:postgresql://" → "postgresql://")
    return connection.replace(/^jdbc:/i, "")
}

export function detectDbAdapter(connection: string): DbAdapter {
    const normalized = connection.trim().toLowerCase()

    if (normalized.startsWith("postgres://") || normalized.startsWith("postgresql://")
        || normalized.startsWith("jdbc:postgres://") || normalized.startsWith("jdbc:postgresql://")) {
        return "postgres"
    }

    if (normalized.startsWith("mysql://")) {
        return "mysql"
    }

    if (normalized.startsWith("mariadb://")) {
        return "mariadb"
    }

    if (normalized.startsWith("sqlite://") || normalized.startsWith("sqlite:") || normalized.startsWith("file:")) {
        return "sqlite"
    }

    throw new Error("Unsupported database protocol. Use PostgreSQL, MySQL, MariaDB, or SQLite connection formats.")
}

export function loadDbConfig(dbKey: string, env: NodeJS.ProcessEnv = process.env): DbConfig {
    const normalizedDbKey = normalizeDbKey(dbKey)
    const { connectionEnvVar, passwordEnvVar, usernameEnvVar } = getDbEnvVarNames(normalizedDbKey)
    const rawConnection = env[connectionEnvVar]?.trim()

    if (!rawConnection) {
        throw new Error(`Missing required environment variable: ${connectionEnvVar}`)
    }

    const connection = normalizeConnectionString(rawConnection)
    const username = env[usernameEnvVar]?.trim() || undefined
    const password = env[passwordEnvVar]?.trim() || undefined

    return {
        adapter: detectDbAdapter(connection),
        connection,
        connectionEnvVar,
        dbKey: dbKey.trim(),
        normalizedDbKey,
        password,
        passwordEnvVar,
        username,
        usernameEnvVar,
    }
}

export function validateIdentifier(identifier: string, label: string): string {
    const trimmed = identifier.trim()

    if (!IDENTIFIER_PATTERN.test(trimmed)) {
        throw new Error(`Invalid ${label}. Use single identifiers with letters, digits, and underscores only.`)
    }

    return trimmed
}

export function quoteIdentifier(adapter: DbAdapter, identifier: string): string {
    const validIdentifier = validateIdentifier(identifier, "identifier")

    if (adapter === "mysql" || adapter === "mariadb") {
        return `\`${validIdentifier}\``
    }

    return `"${validIdentifier}"`
}

export function getDefaultSchema(adapter: DbAdapter): string | undefined {
    if (adapter === "postgres") {
        return "public"
    }

    if (adapter === "sqlite") {
        return "main"
    }

    return undefined
}

export async function getMysqlDefaultSchema(client: DbClient): Promise<string | undefined> {
    const rows = await client.query("SELECT DATABASE() AS schema_name")
    const schemaName = rows[0]?.schema_name

    if (typeof schemaName === "string" && schemaName.length > 0) {
        return schemaName
    }

    return undefined
}

export async function resolveDbSchema(client: DbClient, adapter: DbAdapter, schema?: string): Promise<string> {
    if (schema) {
        return validateIdentifier(schema, "schema")
    }

    const defaultSchema = getDefaultSchema(adapter)
    if (defaultSchema) {
        return defaultSchema
    }

    const mysqlSchema = await getMysqlDefaultSchema(client)
    if (mysqlSchema) {
        return validateIdentifier(mysqlSchema, "schema")
    }

    throw new Error("Invalid schema. Provide schema or configure a default database for this connection.")
}

export async function readDbTables(client: DbClient, adapter: DbAdapter, schema: string): Promise<string[]> {
    if (adapter === "postgres") {
        const rows = await client.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
            [schema]
        )
        return rows.map((row) => String(row.table_name))
    }

    if (adapter === "mysql" || adapter === "mariadb") {
        const rows = await client.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name",
            [schema]
        )
        return rows.map((row) => String(row.table_name))
    }

    const rows = await client.query(
        `SELECT name FROM ${quoteIdentifier(adapter, schema)}.sqlite_master WHERE type = ? AND name NOT LIKE ? ORDER BY name`,
        ["table", "sqlite_%"]
    )
    return rows.map((row) => String(row.name))
}

export async function readDbSchemas(client: DbClient, adapter: DbAdapter): Promise<string[]> {
    if (adapter === "postgres") {
        const rows = await client.query(
            "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name"
        )
        return rows.map((row) => String(row.schema_name))
    }

    if (adapter === "mysql" || adapter === "mariadb") {
        const rows = await client.query(
            "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name"
        )
        return rows.map((row) => String(row.schema_name))
    }

    // SQLite: PRAGMA database_list returns seq, name, file
    const rows = await client.query("PRAGMA database_list")
    return rows.map((row) => String(row.name))
}

export async function readDbTableMetadata(client: DbClient, adapter: DbAdapter, schemaInput: string, tableInput: string): Promise<DbTableMetadata> {
    const schema = validateIdentifier(schemaInput, "schema")
    const table = validateIdentifier(tableInput, "table")

    if (adapter === "postgres") {
        return await readPostgresTableMetadata(client, schema, table)
    }

    if (adapter === "mysql" || adapter === "mariadb") {
        return await readMysqlTableMetadata(client, schema, table)
    }

    return await readSqliteTableMetadata(client, schema, table)
}

export function createPlaceholder(adapter: DbAdapter, index: number): string {
    if (adapter === "postgres") {
        return `$${index}`
    }

    return "?"
}

export function buildReadOnlySelectQuery(input: ReadOnlySelectInput): ReadOnlySelectQuery {
    const schema = validateIdentifier(input.schema, "schema")
    const table = validateIdentifier(input.table, "table")

    if (input.sortAsc && input.sortDesc) {
        throw new Error("Provide only one of sort_asc or sort_desc.")
    }

    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
        throw new Error("Invalid limit. Use an integer between 1 and 100.")
    }

    const fields = input.fields?.length
        ? input.fields.map((field) => quoteIdentifier(input.adapter, validateIdentifier(field, "field"))).join(", ")
        : "*"

    const qualifiedTable = `${quoteIdentifier(input.adapter, schema)}.${quoteIdentifier(input.adapter, table)}`
    const params: unknown[] = []
    const whereClauses = (input.filters ?? []).map((filter) => buildFilterClause(input.adapter, filter, params))
    const orderBy = input.sortAsc
        ? ` ORDER BY ${quoteIdentifier(input.adapter, validateIdentifier(input.sortAsc, "sort_asc"))} ASC`
        : input.sortDesc
            ? ` ORDER BY ${quoteIdentifier(input.adapter, validateIdentifier(input.sortDesc, "sort_desc"))} DESC`
            : ""
    const where = whereClauses.length ? ` WHERE ${whereClauses.join(" AND ")}` : ""
    const limitPlaceholder = createPlaceholder(input.adapter, params.length + 1)

    params.push(input.limit)

    return {
        params,
        sql: `SELECT ${fields} FROM ${qualifiedTable}${where}${orderBy} LIMIT ${limitPlaceholder}`,
    }
}

function buildFilterClause(adapter: DbAdapter, filter: DbFilter, params: unknown[]): string {
    const key = quoteIdentifier(adapter, validateIdentifier(filter.key, "filter key"))

    switch (filter.operator) {
        case "=":
        case "!=":
        case "<":
        case "<=":
        case ">":
        case ">=":
        case "like": {
            params.push(filter.value)
            return `${key} ${operatorSql(filter.operator)} ${createPlaceholder(adapter, params.length)}`
        }
        case "in": {
            if (!Array.isArray(filter.value) || filter.value.length === 0) {
                throw new Error("Invalid in filter. Provide a non-empty array value.")
            }

            const placeholders = filter.value.map((value) => {
                params.push(value)
                return createPlaceholder(adapter, params.length)
            })

            return `${key} IN (${placeholders.join(", ")})`
        }
        case "is_null": {
            if (filter.value !== undefined) {
                throw new Error("is_null filters must omit value.")
            }

            return `${key} IS NULL`
        }
        default:
            throw new Error("Unsupported filter operator.")
    }
}

function operatorSql(operator: Exclude<DbFilterOperator, "in" | "is_null">): string {
    return operator === "like" ? "LIKE" : operator
}

function getSqliteFilename(connection: string): string {
    if (connection.startsWith("sqlite://")) {
        const filename = connection.slice("sqlite://".length)
        if (filename) {
            return filename
        }
    }

    if (connection.startsWith("sqlite:")) {
        const filename = connection.slice("sqlite:".length)
        if (filename) {
            return filename
        }
    }

    if (connection.startsWith("file:")) {
        try {
            const url = new URL(connection)
            const filename = decodeURIComponent(url.pathname)
            if (filename) {
                return filename
            }
        }
        catch {
            const filename = connection.slice("file:".length)
            if (filename) {
                return filename
            }
        }
    }

    throw new Error("Invalid SQLite connection. Provide a valid sqlite://, sqlite:, or file: filename.")
}

export async function defaultDbClientFactory(config: DbConfig): Promise<DbClient> {
    const sqlClient = createBunSqlClient(config)

    return {
        async close(): Promise<void> {
            if (typeof sqlClient.close === "function") {
                await sqlClient.close()
                return
            }

            if (typeof sqlClient.end === "function") {
                await sqlClient.end()
            }
        },
        async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
            const result = await sqlClient.unsafe(sql, params)
            return result as Record<string, unknown>[]
        },
    }
}

function resolveTls(connection: string): boolean | { rejectUnauthorized: boolean } {
    try {
        const url = new URL(connection)
        const sslmode = url.searchParams.get("sslmode")

        if (sslmode === "disable") {
            return false
        }

        if (sslmode === "require") {
            return { rejectUnauthorized: false }
        }

        if (sslmode === "verify-ca" || sslmode === "verify-full") {
            return { rejectUnauthorized: true }
        }
    }
    catch {
        // unparseable URL — fall through to default
    }

    // Default: attempt TLS without strict cert verification (matches most managed DBs)
    return { rejectUnauthorized: false }
}

function createBunSqlClient(config: DbConfig): BunSqlClient {
    if (config.adapter === "sqlite") {
        return new SQL({
            adapter: "sqlite",
            filename: getSqliteFilename(config.connection),
        }) as unknown as BunSqlClient
    }

    return new SQL({
        adapter: config.adapter,
        max: 1,
        password: config.password,
        tls: resolveTls(config.connection),
        url: config.connection,
        username: config.username,
    }) as unknown as BunSqlClient
}

export function normalizeJsonValue(value: unknown): unknown {
    if (value === null || value === undefined) {
        return value
    }

    if (typeof value === "bigint") {
        return value.toString()
    }

    if (value instanceof Date) {
        return value.toISOString()
    }

    if (value instanceof Uint8Array) {
        return {
            encoding: "base64",
            type: "binary",
            value: Buffer.from(value).toString("base64"),
        }
    }

    if (Array.isArray(value)) {
        return value.map((entry) => normalizeJsonValue(entry))
    }

    if (typeof value === "object") {
        const constructorName = (value as { constructor?: { name?: string } }).constructor?.name

        if (constructorName === BINARY_TYPE) {
            return {
                encoding: "base64",
                type: "binary",
                value: Buffer.from(value as Uint8Array).toString("base64"),
            }
        }

        return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>((result, [key, entry]) => {
            result[key] = normalizeJsonValue(entry)
            return result
        }, {})
    }

    return value
}

export function normalizeJsonRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return rows.map((row) => normalizeJsonValue(row) as Record<string, unknown>)
}

export function sanitizeDbError(error: unknown, config?: Pick<DbConfig, "connection" | "password" | "username">): unknown {
    const secrets = [config?.connection, config?.password, config?.username].filter((value): value is string => Boolean(value))

    if (error instanceof Error) {
        const sanitized = new Error(sanitizeString(error.message, secrets))
        sanitized.name = error.name
        return sanitized
    }

    if (typeof error === "string") {
        return sanitizeString(error, secrets)
    }

    if (Array.isArray(error)) {
        return error.map((entry) => sanitizeDbError(entry, config))
    }

    if (error && typeof error === "object") {
        return Object.entries(error as Record<string, unknown>).reduce<Record<string, unknown>>((result, [key, value]) => {
            result[key] = sanitizeDbError(value, config)
            return result
        }, {})
    }

    return error
}

function sanitizeString(value: string, secrets: string[]): string {
    let sanitized = value.replace(/\b(?:postgres(?:ql)?|mysql|mariadb|sqlite|file):[^\s'"`]+/gi, "[REDACTED_CONNECTION]")

    for (const secret of secrets) {
        if (secret) {
            sanitized = sanitized.split(secret).join("[REDACTED]")
        }
    }

    return sanitized
}

export function quoteSqliteStringLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`
}

async function readPostgresTableMetadata(client: DbClient, schema: string, table: string): Promise<DbTableMetadata> {
    const [fieldRows, pkRows, indexRows, relationshipRows] = await Promise.all([
        client.query(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
            [schema, table]
        ),
        client.query(
            "SELECT kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2 ORDER BY kcu.ordinal_position",
            [schema, table]
        ),
        client.query(
            "SELECT i.relname AS index_name, array_agg(a.attname ORDER BY k.ord) AS columns FROM pg_class t JOIN pg_namespace ns ON ns.oid = t.relnamespace JOIN pg_index ix ON ix.indrelid = t.oid JOIN pg_class i ON i.oid = ix.indexrelid JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum WHERE ns.nspname = $1 AND t.relname = $2 AND NOT ix.indisprimary GROUP BY i.relname ORDER BY i.relname",
            [schema, table]
        ),
        client.query(
            "SELECT ccu.table_name AS table_name, kcu.column_name AS local_join_field, ccu.column_name AS foreign_join_field FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.table_schema WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2 ORDER BY ccu.table_name, kcu.ordinal_position",
            [schema, table]
        ),
    ])

    return {
        fields: fieldRows.map((row) => ({
            name: String(row.column_name),
            nullable: row.is_nullable === "YES",
            type: String(row.data_type),
        })),
        indices: indexRows.map((row) => normalizeStringList(row.columns)).filter((columns) => columns.length > 0),
        pk: pkRows.map((row) => String(row.column_name)),
        relationships: relationshipRows.map((row) => ({
            foreign_join_field: String(row.foreign_join_field),
            local_join_field: String(row.local_join_field),
            table: String(row.table_name),
        })),
        schema,
        table,
    }
}

async function readMysqlTableMetadata(client: DbClient, schema: string, table: string): Promise<DbTableMetadata> {
    const [fieldRows, pkRows, indexRows, relationshipRows] = await Promise.all([
        client.query(
            "SELECT column_name, column_type, is_nullable FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
            [schema, table]
        ),
        client.query(
            "SELECT column_name FROM information_schema.key_column_usage WHERE table_schema = ? AND table_name = ? AND constraint_name = 'PRIMARY' ORDER BY ordinal_position",
            [schema, table]
        ),
        client.query(
            "SELECT index_name, column_name FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? AND index_name <> 'PRIMARY' ORDER BY index_name, seq_in_index",
            [schema, table]
        ),
        client.query(
            "SELECT referenced_table_name AS table_name, column_name AS local_join_field, referenced_column_name AS foreign_join_field FROM information_schema.key_column_usage WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL ORDER BY referenced_table_name, ordinal_position",
            [schema, table]
        ),
    ])

    return {
        fields: fieldRows.map((row) => ({
            name: String(row.column_name),
            nullable: row.is_nullable === "YES",
            type: String(row.column_type),
        })),
        indices: groupMysqlIndices(indexRows),
        pk: pkRows.map((row) => String(row.column_name)),
        relationships: relationshipRows.map((row) => ({
            foreign_join_field: String(row.foreign_join_field),
            local_join_field: String(row.local_join_field),
            table: String(row.table_name),
        })),
        schema,
        table,
    }
}

async function readSqliteTableMetadata(client: DbClient, schema: string, table: string): Promise<DbTableMetadata> {
    const qualifiedSchema = quoteIdentifier("sqlite", schema)
    const tableLiteral = quoteSqliteStringLiteral(table)
    const fieldRows = await client.query(`PRAGMA ${qualifiedSchema}.table_info(${tableLiteral})`)
    const indexRows = await client.query(`PRAGMA ${qualifiedSchema}.index_list(${tableLiteral})`)
    const relationshipRows = await client.query(`PRAGMA ${qualifiedSchema}.foreign_key_list(${tableLiteral})`)
    const indices: string[][] = []

    for (const row of indexRows) {
        if (row.origin === "pk") {
            continue
        }

        const indexName = String(row.name)
        const indexInfoRows = await client.query(`PRAGMA ${qualifiedSchema}.index_info(${quoteSqliteStringLiteral(indexName)})`)
        indices.push(indexInfoRows.map((indexInfoRow) => String(indexInfoRow.name)).filter((name) => name.length > 0))
    }

    return {
        fields: fieldRows.map((row) => ({
            name: String(row.name),
            nullable: Number(row.notnull) === 0,
            type: String(row.type),
        })),
        indices,
        pk: fieldRows.filter((row) => Number(row.pk) > 0).sort((left, right) => Number(left.pk) - Number(right.pk)).map((row) => String(row.name)),
        relationships: relationshipRows.map((row) => ({
            foreign_join_field: String(row.to),
            local_join_field: String(row.from),
            table: String(row.table),
        })),
        schema,
        table,
    }
}

function groupMysqlIndices(rows: Record<string, unknown>[]): string[][] {
    const grouped = new Map<string, string[]>()

    for (const row of rows) {
        const indexName = String(row.index_name)
        const columns = grouped.get(indexName) ?? []
        columns.push(String(row.column_name))
        grouped.set(indexName, columns)
    }

    return [...grouped.values()]
}

function normalizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return []
    }

    return value.map((entry) => String(entry))
}
