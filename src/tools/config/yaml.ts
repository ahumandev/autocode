import { parse as yamlParse, stringify as yamlStringify } from "yaml"
import type { ConfigFormatParser } from "./types"

export const yamlParser: ConfigFormatParser = {
    parse(raw: string): unknown {
        const value = yamlParse(raw)
        return value === undefined ? null : value
    },
    stringify(value: unknown): string {
        return yamlStringify(value)
    }
}
