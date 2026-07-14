import { parse as jsoncParse, type ParseError } from "jsonc-parser"
import type { ConfigFormatParser } from "./types"

export const jsonParser: ConfigFormatParser = {
    parse(raw: string): unknown {
        const errors: ParseError[] = []
        const value = jsoncParse(raw, errors, { allowTrailingComma: true, disallowComments: false })
        if (errors.length > 0) {
            const first = errors[0]
            throw new Error(`Invalid JSON: ${first?.error ?? "parse error"} at offset ${first?.offset ?? 0}`)
        }
        return value
    },
    stringify(value: unknown): string {
        return JSON.stringify(value, null, 2)
    }
}
