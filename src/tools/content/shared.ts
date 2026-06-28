export const CONTENT_LIMIT = 10000

export type TruncatedText = {
    value: string
    truncated: boolean
}

export function truncateText(value: string): TruncatedText {
    if (value.length <= CONTENT_LIMIT) return { value, truncated: false }
    return { value: value.slice(0, CONTENT_LIMIT), truncated: true }
}

export function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

export function detectNewline(raw: string): string {
    return raw.includes("\r\n") ? "\r\n" : "\n"
}
