import { parse as yamlParse, stringify as yamlStringify, parseDocument, isMap, isSeq, isScalar, type Document, type Node, type YAMLMap, type YAMLSeq } from "yaml"
import type { ConfigFormatParser, ConfigDocumentEditor, EditOperation } from "./types"

export const yamlParser: ConfigFormatParser = {
    parse(raw: string): unknown {
        const value = yamlParse(raw)
        return value === undefined ? null : value
    },
    stringify(value: unknown): string {
        return yamlStringify(value)
    }
}

/**
 * Format-preserving YAML editor. Edits a parsed `Document` node tree in place
 * (via `setIn`/`deleteIn`/`YAMLSeq.items.splice`/`Pair.key` mutation) so that
 * untouched nodes retain their original style — including:
 *   - top-level, inline, and block comments
 *   - blank lines and the `---` document-start marker
 *   - implied-null form (`key:` is NOT rewritten to `key: null`)
 *   - key order on same-parent rename
 *
 * Construct via `createYamlDocumentEditor(raw)` and drive through the
 * `ConfigDocumentEditor` interface. `configEditFlow` automatically routes
 * `.yaml`/`.yml` edits through this editor.
 */
export class YamlDocumentEditor implements ConfigDocumentEditor {
    private doc: Document
    constructor(raw: string) {
        this.doc = parseDocument(raw)
    }
    toJS(): unknown {
        const value = this.doc.toJS()
        return value === undefined ? null : value
    }
    apply(op: EditOperation): void {
        switch (op.kind) {
            case "replace": this.applyReplace(op.path, op.value); return
            case "create": this.applyCreate(op.path, op.value, op.index); return
            case "rename": this.applyRename(op); return
        }
    }
    toString(): string {
        return this.doc.toString()
    }
    private applyReplace(path: (string | number)[], value: unknown): void {
        this.doc.setIn(path, this.doc.createNode(value))
    }
    private applyCreate(path: (string | number)[], value: unknown, index: number | null): void {
        const last = path[path.length - 1]
        if (typeof last === "string") {
            this.doc.setIn(path, this.doc.createNode(value))
            return
        }
        const parentPath = path.slice(0, -1)
        let parent = this.doc.getIn(parentPath, true)
        if (!isSeq(parent)) {
            this.doc.setIn(parentPath, this.doc.createNode([]))
            parent = this.doc.getIn(parentPath, true)
        }
        if (!isSeq(parent)) throw new Error("cannot insert: parent not array")
        const seq = parent as YAMLSeq
        const position = index === null
            ? seq.items.length
            : (index === -1 ? seq.items.length : Math.max(0, Math.min(index, seq.items.length)))
        seq.items.splice(position, 0, this.doc.createNode(value))
    }
    private applyRename(op: Extract<EditOperation, { kind: "rename" }>): void {
        const curParent = op.cur.slice(0, -1)
        const neuParent = op.neu.slice(0, -1)
        const sameParent = curParent.length === neuParent.length && curParent.every((s, i) => s === neuParent[i])
        if (sameParent) {
            const parent = this.doc.getIn(curParent, true)
            if (isMap(parent)) {
                const oldKey = op.cur[op.cur.length - 1]
                const newKey = op.neu[op.neu.length - 1]
                const pair = parent.items.find(p => {
                    const k = p.key
                    return isScalar(k) ? String((k as { value: unknown }).value) === String(oldKey) : String(k) === String(oldKey)
                })
                if (pair) {
                    pair.key = this.doc.createNode(newKey)
                    if (op.hasContent) pair.value = this.doc.createNode(op.content)
                    return
                }
            }
        }
        const existingNode = this.doc.getIn(op.cur, true) as Node | undefined
        const valueNode = op.hasContent ? this.doc.createNode(op.content) : existingNode
        this.doc.deleteIn(op.cur)
        const lastNeu = op.neu[op.neu.length - 1]
        if (typeof lastNeu === "string") {
            this.doc.setIn(op.neu, valueNode)
        } else {
            const parent = this.doc.getIn(neuParent, true)
            if (isSeq(parent)) {
                const position = op.index === null
                    ? parent.items.length
                    : (op.index === -1 ? parent.items.length : Math.max(0, Math.min(op.index, parent.items.length)))
                parent.items.splice(position, 0, valueNode as Node)
            } else {
                this.doc.setIn(op.neu, valueNode)
            }
        }
    }
}

export function createYamlDocumentEditor(raw: string): ConfigDocumentEditor {
    return new YamlDocumentEditor(raw)
}
