import { parse as jsoncParse, modify, applyEdits, parseTree, findNodeAtLocation, createScanner, SyntaxKind, type Node, type ParseError, type FormattingOptions } from "jsonc-parser/lib/esm/main.js"
import type { ConfigFormatParser, ConfigDocumentEditor, EditOperation } from "./types"

export function findUniqueJsoncNode(root: Node, path: readonly (string | number)[]): Node | undefined {
    let current: Node | undefined = root
    for (const segment of path) {
        if (current.type === "object" && typeof segment === "string") {
            const matches: Node[] = current.children?.filter((property: Node): boolean => property.children?.[0]?.value === segment) ?? []
            if (matches.length > 1) throw new Error("Ambiguous JSONC path")
            current = matches[0]?.children?.[1]
        } else if (current.type === "array" && typeof segment === "number" && Number.isInteger(segment) && segment >= 0) {
            current = current.children?.[segment]
        } else {
            return undefined
        }
        if (!current) return undefined
    }
    return current
}

export function removeJsoncNodePreservingComments(raw: string, path: readonly (string | number)[]): string {
    if (path.length === 0) throw new Error("JSONC removal path must not be empty")
    const errors: ParseError[] = []
    const root = parseTree(raw, errors, { allowTrailingComma: true, disallowComments: false })
    if (!root || errors.length > 0) throw new Error("Invalid JSONC document")

    const parent = findUniqueJsoncNode(root, path.slice(0, -1))
    if (!parent) return raw
    const node = findUniqueJsoncNode(parent, [path[path.length - 1]])
    if (!node) return raw
    const member = parent.type === "object" ? node.parent : node
    if (!member || (parent.type !== "object" && parent.type !== "array")) throw new Error("Invalid JSONC node")
    const siblings = parent.children ?? []
    const index = siblings.indexOf(member)
    if (index < 0) throw new Error("Invalid JSONC node")

    const scanner = createScanner(raw, true)
    const ranges: { offset: number, length: number }[] = []
    const end = member.offset + member.length
    let previousComma: number | undefined
    let followingComma: number | undefined
    let token = scanner.scan()
    while (token !== SyntaxKind.EOF) {
        const offset = scanner.getTokenOffset()
        if (offset < member.offset) {
            previousComma = token === SyntaxKind.CommaToken ? offset : undefined
        } else if (offset < end) {
            ranges.push({ offset, length: scanner.getTokenLength() })
        } else {
            if (token === SyntaxKind.CommaToken) followingComma = offset
            break
        }
        token = scanner.scan()
    }
    const comma = followingComma ?? (index > 0 ? previousComma : undefined)
    if (comma !== undefined) ranges.push({ offset: comma, length: 1 })
    else if (siblings.length > 1) throw new Error("Invalid JSONC separator")

    ranges.sort((a, b) => a.offset - b.offset)
    let result = ""
    let cursor = 0
    for (const range of ranges) {
        result += raw.slice(cursor, range.offset)
        cursor = range.offset + range.length
    }
    return result + raw.slice(cursor)
}

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

function detectFormattingOptions(raw: string): FormattingOptions {
    const lines = raw.split(/\r?\n/)
    for (const line of lines) {
        const match = /^(\t+| +)\S/.exec(line)
        if (match) {
            const indent = match[1]
            if (indent.startsWith("\t")) return { tabSize: 4, insertSpaces: false }
            return { tabSize: indent.length, insertSpaces: true }
        }
    }
    return { tabSize: 2, insertSpaces: true }
}

/**
 * Format-preserving JSON/JSONC editor. Uses `jsonc-parser`'s `modify()`/
 * `applyEdits()` for AST-level edits so that line and block comments,
 * indentation, and array element formatting are preserved across edits.
 *
 * Same-parent object rename uses text-level key swap (`renameKeyInPlace`)
 * to preserve key position. Cross-parent rename falls back to delete+insert
 * and may move the new key to the end of its parent container.
 *
 * Construct via `createJsoncDocumentEditor(raw)` and drive through the
 * `ConfigDocumentEditor` interface. `configEditFlow` automatically routes
 * `.json`/`.jsonc` edits through this editor.
 */
export class JsoncDocumentEditor implements ConfigDocumentEditor {
    private text: string
    private fmt: FormattingOptions
    constructor(raw: string) {
        this.text = raw
        this.fmt = detectFormattingOptions(raw)
    }
    toJS(): unknown {
        const errors: ParseError[] = []
        return jsoncParse(this.text, errors, { allowTrailingComma: true, disallowComments: false })
    }
    apply(op: EditOperation): void {
        switch (op.kind) {
            case "replace": {
                this.text = applyEdits(this.text, modify(this.text, op.path, op.value, { formattingOptions: this.fmt }))
                return
            }
            case "create": {
                const parentPath = op.path.slice(0, -1)
                const parent = this.readPath(parentPath)
                if (Array.isArray(parent)) {
                    const position = op.index === null
                        ? parent.length
                        : (op.index === -1 ? parent.length : Math.max(0, Math.min(op.index, parent.length)))
                    this.text = applyEdits(this.text, modify(this.text, parentPath.concat([position]), op.value, { formattingOptions: this.fmt, isArrayInsertion: true }))
                } else {
                    this.text = applyEdits(this.text, modify(this.text, op.path, op.value, { formattingOptions: this.fmt }))
                }
                return
            }
            case "rename": {
                const curParent = op.cur.slice(0, -1)
                const neuParent = op.neu.slice(0, -1)
                const sameParent = curParent.length === neuParent.length && curParent.every((s, i) => s === neuParent[i])
                const lastCur = op.cur[op.cur.length - 1]
                const lastNeu = op.neu[op.neu.length - 1]
                if (sameParent && typeof lastCur === "string" && typeof lastNeu === "string") {
                    try {
                        this.text = this.renameKeyInPlace(op.cur, lastNeu)
                        if (op.hasContent) {
                            this.text = applyEdits(this.text, modify(this.text, op.neu, op.content, { formattingOptions: this.fmt }))
                        }
                        return
                    } catch {
                        // fall through to delete + insert
                    }
                }
                const existing = op.hasContent ? op.content : this.readPath(op.cur)
                this.text = applyEdits(this.text, modify(this.text, op.cur, undefined, { formattingOptions: this.fmt }))
                this.text = applyEdits(this.text, modify(this.text, op.neu, existing, { formattingOptions: this.fmt }))
                return
            }
        }
    }
    toString(): string {
        return this.text
    }
    private readPath(path: (string | number)[]): unknown {
        const errors: ParseError[] = []
        const root = jsoncParse(this.text, errors, { allowTrailingComma: true, disallowComments: false })
        let cursor: unknown = root
        for (const seg of path) {
            if (cursor === null || typeof cursor !== "object") return undefined
            cursor = (cursor as Record<string | number, unknown>)[seg as never]
        }
        return cursor
    }
    /**
     * Same-parent object key rename via text-level replacement of the key
     * token's AST range. Preserves key position, comments, and value
     * formatting. Throws if the path does not resolve to a property node
     * (caller falls back to delete+insert).
     */
    private renameKeyInPlace(curPath: (string | number)[], newKey: string): string {
        const errors: ParseError[] = []
        const root = parseTree(this.text, errors, { allowTrailingComma: true, disallowComments: false })
        if (!root) throw new Error("rename: invalid JSON")
        const valueNode = findNodeAtLocation(root, curPath)
        if (!valueNode?.parent) throw new Error("rename: node not found")
        const propertyNode = valueNode.parent
        if (propertyNode.type !== "property") throw new Error("rename: not a property")
        const keyNode = propertyNode.children?.[0]
        if (!keyNode) throw new Error("rename: key node missing")
        const newKeyText = JSON.stringify(newKey)
        return this.text.slice(0, keyNode.offset) + newKeyText + this.text.slice(keyNode.offset + keyNode.length)
    }
}

export function createJsoncDocumentEditor(raw: string): ConfigDocumentEditor {
    return new JsoncDocumentEditor(raw)
}
