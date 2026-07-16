export type NormalizeEnvKeyOptions = {
    allowHyphen?: boolean
    errorMessage?: string
    label?: string
}

const STRICT_KEY_PATTERN = /^[A-Za-z0-9_]+$/
const HYPHEN_KEY_PATTERN = /^[A-Za-z0-9_-]+$/

export function normalizeEnvKey(rawKey: string, options: NormalizeEnvKeyOptions = {}): string {
    const label = options.label ?? "key"
    const errorMessage = options.errorMessage ?? `Invalid ${label}.`
    const trimmed = rawKey.trim()

    if (!trimmed) {
        throw new Error(errorMessage)
    }

    const pattern = options.allowHyphen ? HYPHEN_KEY_PATTERN : STRICT_KEY_PATTERN
    if (!pattern.test(trimmed)) {
        throw new Error(errorMessage)
    }

    const replaced = options.allowHyphen ? trimmed.replaceAll("-", "_") : trimmed
    return replaced.toUpperCase()
}

export function buildEnvVarName(prefix: string, normalizedKey: string, field: string): string {
    return `${prefix}_${normalizedKey}_${field}`
}
