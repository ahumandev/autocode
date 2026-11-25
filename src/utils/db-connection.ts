export type DbAdapter = "postgres" | "mysql" | "mariadb" | "sqlite"

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
