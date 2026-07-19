import { parse as jsoncParse, modify, applyEdits, parseTree, findNodeAtLocation, type ParseError, type FormattingOptions } from "jsonc-parser"
import type { ConfigFormatParser, ConfigDocumentEditor, EditOperation } from "./types"

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
        if (!valueNode || !valueNode.parent) throw new Error("rename: node not found")
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
