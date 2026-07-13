export type ConfigMode = "json" | "yaml" | "ini" | "toml" | "env"

export type RetryResult<T> = { ok: true; value: T } | { ok: false; response: string }

export type ConfigTarget = {
    absolutePath: string
    mode: ConfigMode
}

export type ConfigFormatParser = {
    parse(raw: string): unknown
    stringify(value: unknown): string
}

export type ConfigAdapter = {
    validateConfigPath(input: unknown, failedAction?: string): Promise<RetryResult<ConfigTarget>>
    read(target: ConfigTarget): Promise<string>
    write(target: ConfigTarget, raw: string): Promise<void>
    parseStringContent?: boolean
}

export type ConfigNode = {
    path: (string | number)[]
    value: string | null
}

export type ReadOptions = {
    keyDepth: number
    subkeyPattern?: RegExp
    valuePattern?: RegExp
    maxKeys: number
    maxValueChars: number
}

export type ReadResult = {
    nodes: ConfigNode[]
    truncated: boolean
    nodesShown: number
    nodesTotal: number
}

export type WriteOptions = {
    currentKey: (string | number)[] | null
    newKey: (string | number)[] | null
    content: unknown
    newIndex: number | null
    parseStringContent?: boolean
}

export type WriteOutcome = { value: unknown; action: "replace" | "rename" | "create" }

export type RemoveOutcome = { value: unknown; removed: (string | number)[]; parentNow: string | null | Record<string, string | null> }
