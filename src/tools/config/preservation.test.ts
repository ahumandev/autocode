import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configEditFlow } from "./core"
import { createLocalConfigAdapter } from "./adapter"

describe("config preservation", () => {
    let dir: string

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "cfg-pres-"))
    })

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true })
    })

    describe("YAML comments and formatting", () => {
        it("preserves top-level comments on replace", async () => {
            const file = join(dir, "c.yaml")
            await writeFile(file, "# top comment\na: 1\nb: 2\n", "utf8")
            await configEditFlow(createLocalConfigAdapter(), {
                file_path: file,
                current_key: "a",
                content: 99,
            })
            const out = await readFile(file, "utf8")
            expect(out).toContain("# top comment")
            expect(out).toContain("a: 99")
            expect(out).toContain("b: 2")
        })

        it("preserves inline comments on unrelated replace", async () => {
            const file = join(dir, "c.yaml")
            await writeFile(file, "a: 1  # comment on a\nb: 2\n", "utf8")
            await configEditFlow(createLocalConfigAdapter(), {
                file_path: file,
                current_key: "b",
                content: 99,
            })
            const out = await readFile(file, "utf8")
            expect(out).toContain("# comment on a")
            expect(out).toContain("a: 1")
            expect(out).toContain("b: 99")
        })

        it("preserves implied null on unrelated edit (NOT converted to 'null')", async () => {
            const file = join(dir, "c.yaml")
            await writeFile(file, "a:\nb: 2\n", "utf8")
            await configEditFlow(createLocalConfigAdapter(), {
                file_path: file,
                current_key: "b",
                content: 99,
            })
            const out = await readFile(file, "utf8")
            // Implied null `a:` (no value after colon) must be preserved
            expect(out.split(/\r?\n/)).toContain("a:")
            expect(out).not.toMatch(/a:[ \t]*null/)
            expect(out).toContain("b: 99")
        })

        it("preserves blank lines and section comments", async () => {
            const file = join(dir, "c.yaml")
            await writeFile(file, "a: 1\n\n# section separator\n\nb: 2\n", "utf8")
            await configEditFlow(createLocalConfigAdapter(), {
                file_path: file,
                current_key: "a",
                content: 99,
            })
            const out = await readFile(file, "utf8")
            expect(out).toContain("# section separator")
            expect(out).toContain("a: 99")
        })

        it("preserves nested comments on create", async () => {
            const file = join(dir, "c.yaml")
            await writeFile(file, "server:\n  # comment\n  host: localhost\n  port: 8080\n", "utf8")
            await configEditFlow(createLocalConfigAdapter(), {
                file_path: file,
                new_key: "server.debug",
                content: true,
            })
            const out = await readFile(file, "utf8")
            expect(out).toContain("# comment")
            expect(out).toContain("host: localhost")
            expect(out).toContain("debug: true")
        })

        it("preserves key order on same-parent rename", async () => {
            const file = join(dir, "c.yaml")
            await writeFile(file, "server:\n  host: a\n  port: 1\n", "utf8")
            await configEditFlow(createLocalConfigAdapter(), {
                file_path: file,
                current_key: "server.host",
                new_key: "server.hostname",
            })
            const out = await readFile(file, "utf8")
            const lines = out.split(/\r?\n/)
            const hostnameIdx = lines.findIndex(l => /hostname:/.test(l))
            const portIdx = lines.findIndex(l => /port:/.test(l))
            expect(hostnameIdx).toBeGreaterThan(-1)
            expect(portIdx).toBeGreaterThan(-1)
            expect(hostnameIdx).toBeLessThan(portIdx)
        })

        it("preserves document start marker '---'", async () => {
            const file = join(dir, "c.yaml")
            await writeFile(file, "---\na: 1\nb: 2\n", "utf8")
            await configEditFlow(createLocalConfigAdapter(), {
                file_path: file,
                current_key: "a",
                content: 99,
            })
            const out = await readFile(file, "utf8")
            expect(out.startsWith("---")).toBe(true)
            expect(out).toContain("a: 99")
        })
    })

    describe("JSONC comments and formatting", () => {
        it("preserves line comments on replace (.json)", async () => {
            const file = join(dir, "c.json")
            await writeFile(file, '{\n  // header comment\n  "a": 1,\n  "b": 2\n}\n', "utf8")
            await configEditFlow(createLocalConfigAdapter(), {
                file_path: file,
                current_key: "a",
                content: 99,
            })
            const out = await readFile(file, "utf8")
            expect(out).toContain("// header comment")
            expect(out).toContain('"a": 99')
        })

        it("preserves block comments on replace (.json)", async () => {
            const file = join(dir, "c.json")
            await writeFile(file, '{\n  /* block\n     comment */\n  "a": 1\n}\n', "utf8")
            await configEditFlow(createLocalConfigAdapter(), {
                file_path: file,
                current_key: "a",
                content: 99,
            })
            const out = await readFile(file, "utf8")
            expect(out).toContain("/* block")
            expect(out).toContain("comment */")
            expect(out).toContain('"a": 99')
        })

        it("preserves trailing comments on create", async () => {
            const file = join(dir, "c.json")
            await writeFile(file, '{\n  "a": 1, // trailing\n  "b": 2\n}\n', "utf8")
            await configEditFlow(createLocalConfigAdapter(), {
                file_path: file,
                new_key: "c",
                content: 3,
            })
            const out = await readFile(file, "utf8")
            expect(out).toContain("// trailing")
            expect(out).toContain('"c": 3')
        })

        it("preserves key position on rename", async () => {
            const file = join(dir, "c.json")
            await writeFile(file, '{\n  "a": 1,\n  "b": 2\n}\n', "utf8")
            await configEditFlow(createLocalConfigAdapter(), {
                file_path: file,
                current_key: "a",
                new_key: "aa",
            })
            const out = await readFile(file, "utf8")
            expect(out.indexOf('"aa"')).toBeLessThan(out.indexOf('"b"'))
        })

        it("preserves comments in .jsonc file", async () => {
            const file = join(dir, "c.jsonc")
            await writeFile(file, '{\n  // header\n  "a": 1\n}\n', "utf8")
            const res = await configEditFlow(createLocalConfigAdapter(), {
                file_path: file,
                current_key: "a",
                content: 99,
            })
            const parsed = JSON.parse(res)
            expect(parsed.action).toBe("replace")
            const out = await readFile(file, "utf8")
            expect(out).toContain("// header")
            expect(out).toContain('"a": 99')
        })

        it("preserves array element formatting on insert at index", async () => {
            const file = join(dir, "c.json")
            await writeFile(file, '{\n  "arr": [\n    "one",\n    "two"\n  ]\n}\n', "utf8")
            await configEditFlow(createLocalConfigAdapter(), {
                file_path: file,
                new_key: ["arr", 2],
                content: "nine",
                new_index: 0,
            })
            const out = await readFile(file, "utf8")
            // Existing elements "one" and "two" must remain stringified unchanged
            expect(out).toContain('"one"')
            expect(out).toContain('"two"')
            expect(out).toContain('"nine"')
            // "nine" must appear before "one" in the output
            expect(out.indexOf('"nine"')).toBeLessThan(out.indexOf('"one"'))
        })
    })
})
