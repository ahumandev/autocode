import { describe, expect, test } from "bun:test"
import type { Dirent } from "node:fs"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { createAutocodeConceptCreateTool } from "./autocode_concept_create"
import { createAutocodeConceptListTool } from "./autocode_concept_list"
import { createAutocodeConceptReadTool } from "./autocode_concept_read"
import { createToolContext } from "./test_context"

function createMissingFileError(): NodeJS.ErrnoException {
    const error = new Error("missing") as NodeJS.ErrnoException
    error.code = "ENOENT"
    return error
}

function createFile(name: string): Dirent {
    return {
        name,
        isDirectory: (): boolean => false,
        isFile: (): boolean => true,
    } as Dirent
}

describe("concept tools", () => {
    test("creates concepts under .agents/concepts", async () => {
        const writes: Array<{ filePath: string, content: string }> = []
        const tool = createAutocodeConceptCreateTool({
            session: {
                async get() {
                    return { data: { title: "Current Session" } }
                },
            },
        } as unknown as OpencodeClient, {
            async mkdir(): Promise<string | undefined> {
                return undefined
            },
            async stat(): Promise<{ mtimeMs: number }> {
                throw createMissingFileError()
            },
            async writeFile(filePath: string, content: string): Promise<void> {
                writes.push({ filePath, content })
            },
        }, () => new Date("2026-06-02T10:11:12Z"))

        const result = await tool.execute({ label: "Checkout Flow", concept: "Body" }, createToolContext())

        expect(result).toBe(JSON.stringify({ label: "checkout_flow", file_path: ".agents/concepts/checkout_flow.md" }))
        expect(writes[0]?.filePath).toBe("/workspace/.agents/concepts/checkout_flow.md")
    })

    test("lists concepts from .agents/concepts only", async () => {
        const reads: string[] = []
        const tool = createAutocodeConceptListTool({
            async readdir(directory: string, _options: { withFileTypes: true }): Promise<Dirent[]> {
                expect(directory).toBe("/workspace/.agents/concepts")
                return [createFile("beta.md"), createFile("alpha.md")]
            },
            async readFile(filePath: string, _encoding: "utf8"): Promise<string> {
                reads.push(filePath)
                return `# Heading\n${filePath.endsWith("alpha.md") ? "Alpha" : "Beta"}`
            },
        })

        expect(await tool.execute({}, createToolContext())).toBe(JSON.stringify({
            backlog: [
                { label: "alpha", description: "Alpha" },
                { label: "beta", description: "Beta" },
            ],
        }))
        expect(reads).toEqual([
            "/workspace/.agents/concepts/alpha.md",
            "/workspace/.agents/concepts/beta.md",
        ])
    })

    test("reads a concept without changing workspace files", async () => {
        const tool = createAutocodeConceptReadTool({
            async readFile(filePath: string, _encoding: "utf8"): Promise<string> {
                expect(filePath).toBe("/workspace/.agents/concepts/example.md")
                return "---\ntitle: Example\n---\n\n# Example\n\nBody"
            },
        })

        expect(await tool.execute({ label: "example" }, createToolContext())).toBe("# Example\n\nBody")
    })
})
