export function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

export function detectNewline(raw: string): string {
    return raw.includes("\r\n") ? "\r\n" : "\n"
}
