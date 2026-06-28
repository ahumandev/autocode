import type { Node } from "jsonc-parser"

export type ContentPosition = number | undefined

export type ContentMode = "markdown" | "json" | "yaml" | "env" | "ini" | "toml"

export type ContentTarget = {
    inputPath: string
    absolutePath: string
    mode: ContentMode
}

export type Frontmatter = {
    block: string
    content: string
    body: string
    hasFrontmatter: boolean
}

export type Heading = {
    title: string
    level: number
    start: number
    headerEnd: number
    end: number
    header: string
    parent?: Heading
    children: Heading[]
    path: string
}

export type MarkdownModel = {
    frontmatter: Frontmatter
    body: string
    headings: Heading[]
    root: Heading
    newline: string
}

export type JsonPathElement = string | number

export type JsonPath = JsonPathElement[]

export type JsonModel = {
    raw: string
    root: Node
    value: unknown
    newline: string
}

export type JsonNodeInfo = {
    node: Node
    path: JsonPath
    parent?: Node
    property?: Node
}

export type YamlModel = {
    raw: string
    document: import("yaml").Document.Parsed
    newline: string
}

export type YamlNodeInfo = {
    node: import("yaml").ParsedNode
    path: JsonPath
    parent?: import("yaml").ParsedNode
    pair?: import("yaml").Pair
}

export type EnvAssignment = {
    key: string
    line: number
    lineStart: number
    lineEnd: number
    lineEndWithNewline: number
    valueStart: number
    valueEnd: number
}

export type EnvModel = {
    raw: string
    newline: string
    assignments: EnvAssignment[]
}

export type IniPath = {
    section?: string
    key?: string
}

export type IniSection = {
    name: string
    line: number
    lineStart: number
    lineEnd: number
    lineEndWithNewline: number
    bodyStart: number
    end: number
    endWithNewline: number
}

export type IniAssignment = {
    section?: string
    key: string
    line: number
    lineStart: number
    lineEnd: number
    lineEndWithNewline: number
    keyStart: number
    keyEnd: number
    valueStart: number
    valueEnd: number
}

export type IniModel = {
    raw: string
    newline: string
    iniLike: boolean
    sections: IniSection[]
    assignments: IniAssignment[]
}

export type TomlPath = JsonPath

export type TomlTable = {
    path: TomlPath
    line: number
    lineStart: number
    lineEnd: number
    lineEndWithNewline: number
    bodyStart: number
    end: number
    endWithNewline: number
    array: boolean
}

export type TomlAssignment = {
    path: TomlPath
    line: number
    lineStart: number
    lineEnd: number
    lineEndWithNewline: number
    keyStart: number
    keyEnd: number
    valueStart: number
    valueEnd: number
}

export type TomlModel = {
    raw: string
    newline: string
    tables: TomlTable[]
    assignments: TomlAssignment[]
}

export type TomlNodeInfo = {
    path: TomlPath
    table?: TomlTable
    assignment?: TomlAssignment
}

export type RetryResult<T> = { ok: true, value: T } | { ok: false, response: string }

export type OptionalRetryResult<T> = { ok: true, value?: T } | { ok: false, response: string }
