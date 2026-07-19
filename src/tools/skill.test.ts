import { beforeEach, describe, expect, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
    activeContextIncludesMarkerHash,
    buildAutocodeSkillLoadHash,
    buildAutocodeSkillLoadIdentity,
    buildAutocodeSkillLoadMarker,
    clearAutocodeSkillLoadLiveCacheForTest,
    createSkillTool,
} from "./skill"
import { createToolContext } from "./test_context"

type JsonObject = Record<string, unknown>

type ActiveContextClient = {
    _client?: {
        getConfig?: () => { baseUrl?: string, fetch?: (request: Request) => Promise<Response>, headers?: HeadersInit }
    }
    v2?: {
        session?: {
            context?: (args: unknown) => Promise<unknown>
        }
    }
    session?: {
        activeContext?: (args: unknown) => Promise<unknown>
        context?: (args: unknown) => Promise<unknown>
        messages?: (args: unknown) => Promise<unknown>
    }
    experimental?: {
        context?: {
            get?: (args: unknown) => Promise<unknown>
        }
    }
}

function withTempSkillRoots<T>(fn: (roots: { root: string, configHome: string, worktree: string }) => Promise<T>): Promise<T> {
    const root = mkdtempSync(join(tmpdir(), "autocode-skill-load-"))
    const configHome = join(root, "config")
    const worktree = join(root, "worktree")
    const oldHome = process.env.HOME
    const oldXdgConfigHome = process.env.XDG_CONFIG_HOME

    process.env.HOME = root
    process.env.XDG_CONFIG_HOME = configHome
    mkdirSync(worktree, { recursive: true })

    return fn({ root, configHome, worktree }).finally(() => {
        if (oldHome === undefined) delete process.env.HOME
        else process.env.HOME = oldHome

        if (oldXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = oldXdgConfigHome

        rmSync(root, { recursive: true, force: true })
    })
}

function parseToolResult(result: string | { output: string }): JsonObject {
    const raw = typeof result === "string" ? result : result.output
    try {
        return JSON.parse(raw) as JsonObject
    }
    catch {
        return { output: raw }
    }
}

function expectExactKeys(result: JsonObject, keys: string[]): void {
    expect(Object.keys(result).sort()).toEqual([...keys].sort())
}

function expectLegacyLoadFieldsAbsent(result: JsonObject): void {
    for (const field of ["reason", "identity", "hash", "generated", "learned", "active_context", "content", "marker", "diagnostics"]) {
        expect(result).not.toHaveProperty(field)
    }
}

function expectLoadedResultShape(result: JsonObject, name: string): void {
    expectExactKeys(result, ["output"])
    expect(result.output).toEqual(expect.stringContaining("skill"))
    expect(result.output).toEqual(expect.stringContaining("hash="))
    expect(result.output).toEqual(expect.stringContaining(`<skill_content name="${name}">`))
    // The marker stays inside output so active-context dedupe can match native-like tool results.
    expectMarkerSafe(extractMarker(result.output))
    expectLegacyLoadFieldsAbsent(result)
}

function expectSkippedResultShape(result: JsonObject): void {
    expectExactKeys(result, ["output"])
    expect(result.output).toBe("")
    expectLegacyLoadFieldsAbsent(result)
}

function extractMarker(output: unknown): string {
    const match = String(output).match(/<!-- skill identity=[^\n]+ hash=[a-f0-9]+ -->/)
    expect(match).not.toBeNull()
    return match?.[0] ?? ""
}

function extractHash(output: unknown): string {
    const match = String(output).match(/hash=([a-f0-9]+)/)
    expect(match).not.toBeNull()
    return match?.[1] ?? ""
}

function expectMarkerSafe(marker: unknown, leakedPaths: string[] = []): void {
    const value = String(marker)
    expect(value).toMatch(/^<!-- skill identity=skill:[^\n]+ hash=[a-f0-9]+ -->$/)
    expect(value).toContain("skill")
    expect(value).toContain("hash=")
    expect(value).not.toContain("/")
    for (const leakedPath of leakedPaths) {
        expect(value).not.toContain(leakedPath)
    }
}

function skillMarkdown(name: string, content: string): string {
    return `---\nname: ${name}\ndescription: Test skill\n---\n\n${content}`
}

function writeGeneratedSkill(configHome: string, name = "code-typescript", content = "Generated skill content."): string {
    const dir = join(configHome, "skills", "autocode", name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "SKILL.md"), skillMarkdown(name, content))
    return dir
}

function writeProjectSkill(worktree: string, name = "a", content = "Project skill content."): string {
    const dir = join(worktree, ".opencode", "skills", name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "SKILL.md"), skillMarkdown(name, content))
    return dir
}

function writeLearnedSkill(worktree: string, subject = "learned-corrections", agent = "pair", content = "Learned skill content."): string {
    const name = `${subject}-${agent}`
    const dir = join(worktree, ".agents", "skills", name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "SKILL.md"), `---\ndescription: Use ${name} skill to recall ${subject} of previous sessions.\n---\n\n${content}`)
    return dir
}

async function executeSkillLoad(worktree: string, client: OpencodeClient | undefined = undefined, args: Record<string, unknown> = { name: "code-typescript" }, agent = "pair", sessionID: string | null = "session-1"): Promise<JsonObject> {
    const tool = createSkillTool(client)
    const result = await tool.execute(args as never, createToolContext({
        agent,
        directory: worktree,
        worktree,
        sessionID: sessionID === null ? undefined : sessionID,
    }))

    return parseToolResult(result)
}

async function executeSkillAlias(worktree: string, client: OpencodeClient | undefined = undefined, args: Record<string, unknown> = { name: "code-typescript" }, agent = "pair"): Promise<JsonObject> {
    const tool = createSkillTool(client)
    const result = await tool.execute(args as never, createToolContext({
        agent,
        directory: worktree,
        worktree,
        sessionID: "session-1",
    }))

    return parseToolResult(result)
}

function createClient(overrides: ActiveContextClient = {}): OpencodeClient {
    return overrides as unknown as OpencodeClient
}

describe("skill helpers", () => {
    beforeEach(() => {
        clearAutocodeSkillLoadLiveCacheForTest()
    })

    test("identity, hash, and marker are stable without full paths", () => {
        const identity = buildAutocodeSkillLoadIdentity("code-typescript")
        const payload = {
            content: "Generated /tmp/full/path text.",
        }
        const sameHash = buildAutocodeSkillLoadHash(identity, payload)
        const changedHash = buildAutocodeSkillLoadHash(identity, { ...payload, content: "Changed." })
        const marker = buildAutocodeSkillLoadMarker(identity, sameHash)

        expect(buildAutocodeSkillLoadIdentity("code-typescript")).toBe(identity)
        expect(buildAutocodeSkillLoadHash(identity, payload)).toBe(sameHash)
        expect(buildAutocodeSkillLoadMarker(identity, sameHash)).toBe(marker)
        expect(changedHash).not.toBe(sameHash)
        expect(identity).not.toContain("/tmp/full/path")
        expect(marker).not.toContain("/tmp/full/path")
    })

    test("activeContextIncludesMarkerHash scans exact marker and hash safely", () => {
        const marker = "<!-- skill identity=skill hash=abc123 -->"
        const hash = "abc123"
        const cyclic: Record<string, unknown> = { child: { entries: ["prefix", marker] } }
        cyclic.self = cyclic

        expect(activeContextIncludesMarkerHash(`content ${marker}`, marker, hash)).toBe(true)
        expect(activeContextIncludesMarkerHash(["other", marker], marker, hash)).toBe(true)
        expect(activeContextIncludesMarkerHash(cyclic, marker, hash)).toBe(true)
        expect(activeContextIncludesMarkerHash({ nested: ["marker only", { hash }] }, marker, hash)).toBe(false)
    })
})

describe("skill tool", () => {
    beforeEach(() => {
        clearAutocodeSkillLoadLiveCacheForTest()
    })

    test("loads generated skill content with native-like output", async () => {
        await withTempSkillRoots(async ({ configHome, worktree }) => {
            const directory = writeGeneratedSkill(configHome, "code-typescript", "Generated TypeScript guidance.")

            const result = await executeSkillLoad(worktree)

            expectLoadedResultShape(result, "code-typescript")
            expect(result.output).toContain("Generated TypeScript guidance.")
        })
    })

    test("skill alias loads generated output with marker proof", async () => {
        await withTempSkillRoots(async ({ root, configHome, worktree }) => {
            const directory = writeGeneratedSkill(configHome, "code-typescript", "Generated TypeScript guidance.")

            const result = await executeSkillAlias(worktree)

            expectLoadedResultShape(result, "code-typescript")
            expect(result.output).toContain("Generated TypeScript guidance.")
            expectMarkerSafe(extractMarker(result.output), [root, configHome, worktree])
        })
    })

    test("skill alias loads project skill fallback from safe directory", async () => {
        await withTempSkillRoots(async ({ root, configHome, worktree }) => {
            const directory = writeProjectSkill(worktree, "a", "Local project skill A guidance.")

            const result = await executeSkillAlias(worktree, undefined, { name: "a" })

            expectLoadedResultShape(result, "a")
            expect(result.output).toContain("Local project skill A guidance.")
            expectMarkerSafe(extractMarker(result.output), [root, configHome, worktree])
        })
    })

    test("loads learned skill from hyphenated subject agent path", async () => {
        await withTempSkillRoots(async ({ root, configHome, worktree }) => {
            const directory = writeLearnedSkill(worktree, "learned-corrections", "pair", "Learned correction guidance.")

            const result = await executeSkillAlias(worktree, undefined, { name: "learned-corrections-pair" })

            expectLoadedResultShape(result, "learned-corrections-pair")
            expect(result.output).toContain("Learned correction guidance.")
            expectMarkerSafe(extractMarker(result.output), [root, configHome, worktree])
        })
    })

    test("loads learned correction skill from shortened suffix path", async () => {
        await withTempSkillRoots(async ({ root, configHome, worktree }) => {
            const directory = writeLearnedSkill(worktree, "learned-corrections", "os", "Learned os correction guidance.")

            const result = await executeSkillAlias(worktree, undefined, { name: "learned-corrections-os" }, "execute_os")

            expectLoadedResultShape(result, "learned-corrections-os")
            expect(result.output).toContain("Learned os correction guidance.")
            expectMarkerSafe(extractMarker(result.output), [root, configHome, worktree])
        })
    })

    test("generated skill path wins before project skill fallback", async () => {
        await withTempSkillRoots(async ({ configHome, worktree }) => {
            const directory = writeGeneratedSkill(configHome, "a", "Generated skill A guidance.")
            writeProjectSkill(worktree, "a", "Project skill A guidance must not load.")

            const result = await executeSkillLoad(worktree, undefined, { name: "a" })

            expectLoadedResultShape(result, "a")
            expect(result.output).toContain("Generated skill A guidance.")
            expect(result.output).not.toContain("Project skill A guidance must not load.")
        })
    })

    test("unsafe generated skill name rejects path traversal", async () => {
        await withTempSkillRoots(async ({ configHome, worktree }) => {
            writeGeneratedSkill(configHome)

            const result = await executeSkillLoad(worktree, undefined, { name: "../code-typescript" })

            expect(result.failedAction).toBe("load skill")
            expect(result.error).toBe("Unable to load skill ../code-typescript")
            expect(result.content).toBeUndefined()
        })
    })

    test("agent name from context is not required for native-like load", async () => {
        await withTempSkillRoots(async ({ configHome, worktree }) => {
            const directory = writeGeneratedSkill(configHome, "code-typescript", "Generated TypeScript guidance.")

            const result = await executeSkillLoad(worktree, undefined, { name: "code-typescript" }, "../pair")

            expectLoadedResultShape(result, "code-typescript")
            expect(result.output).toContain("Generated TypeScript guidance.")
        })
    })

    test("skips when active context contains exact marker and hash", async () => {
        await withTempSkillRoots(async ({ root, configHome, worktree }) => {
            const directory = writeGeneratedSkill(configHome)
            const loaded = await executeSkillLoad(worktree)
            const marker = extractMarker(loaded.output)
            const activeContextCalls: unknown[] = []
            const client = createClient({
                session: {
                    async activeContext(args) {
                        activeContextCalls.push(args)
                        return { messages: [{ content: [`already loaded ${marker}`] }] }
                    },
                },
            })

            clearAutocodeSkillLoadLiveCacheForTest()
            const result = await executeSkillLoad(worktree, client)

            expectSkippedResultShape(result)
            expect(activeContextCalls).toEqual([{ path: { id: "session-1" }, query: { directory: worktree } }])
            expectMarkerSafe(marker, [root, configHome, worktree])
        })
    })

    test("v2 context uses sessionID request and skips with real data response marker", async () => {
        await withTempSkillRoots(async ({ root, configHome, worktree }) => {
            const directory = writeGeneratedSkill(configHome)
            const loaded = await executeSkillLoad(worktree)
            const marker = extractMarker(loaded.output)
            const contextCalls: unknown[] = []
            const client = createClient({
                v2: {
                    session: {
                        async context(args) {
                            contextCalls.push(args)
                            return { data: [{ role: "assistant", parts: [{ text: `already loaded ${marker}` }] }] }
                        },
                    },
                },
                session: {
                    async activeContext() {
                        throw new Error("legacy active context must not be used after v2 match")
                    },
                },
            })

            clearAutocodeSkillLoadLiveCacheForTest()
            const result = await executeSkillLoad(worktree, client)

            expectSkippedResultShape(result)
            expect(contextCalls).toEqual([{ sessionID: "session-1" }])
            expectMarkerSafe(marker, [root, configHome, worktree])
        })
    })

    test("loads when v2 context real data response has no active marker", async () => {
        await withTempSkillRoots(async ({ configHome, worktree }) => {
            const directory = writeGeneratedSkill(configHome, "code-typescript", "Generated TypeScript guidance after v2 miss.")
            const contextCalls: unknown[] = []
            const client = createClient({
                v2: {
                    session: {
                        async context(args) {
                            contextCalls.push(args)
                            return { data: [{ role: "assistant", parts: [{ text: "context without skill marker" }] }] }
                        },
                    },
                },
            })

            const result = await executeSkillLoad(worktree, client)

            expectLoadedResultShape(result, "code-typescript")
            expect(result.output).toContain("Generated TypeScript guidance after v2 miss.")
            expect(contextCalls).toEqual([{ sessionID: "session-1" }])
        })
    })

    test("probe error falls back to next active context probe", async () => {
        await withTempSkillRoots(async ({ configHome, worktree }) => {
            const directory = writeGeneratedSkill(configHome)
            const loaded = await executeSkillLoad(worktree)
            const marker = extractMarker(loaded.output)
            const calls: string[] = []
            const client = createClient({
                v2: {
                    session: {
                        async context() {
                            calls.push("v2")
                            throw new Error("v2 context failed")
                        },
                    },
                },
                session: {
                    async activeContext() {
                        calls.push("legacy")
                        return { data: [{ content: marker }] }
                    },
                },
            })

            clearAutocodeSkillLoadLiveCacheForTest()
            const result = await executeSkillLoad(worktree, client)

            expectSkippedResultShape(result)
            expect(calls).toEqual(["v2", "legacy"])
        })
    })

    test("loads when active context has no marker after compaction", async () => {
        await withTempSkillRoots(async ({ configHome, worktree }) => {
            const directory = writeGeneratedSkill(configHome, "code-typescript", "Generated TypeScript guidance after compaction.")
            const client = createClient({
                session: {
                    async activeContext() {
                        return { content: "recent compacted context without skill marker" }
                    },
                },
            })

            const result = await executeSkillLoad(worktree, client)

            expectLoadedResultShape(result, "code-typescript")
            expect(result.output).toContain("Generated TypeScript guidance after compaction.")
        })
    })

    test("second same-session same-hash call skips via live cache when active context misses", async () => {
        await withTempSkillRoots(async ({ configHome, worktree }) => {
            const directory = writeGeneratedSkill(configHome)
            const activeContextCalls: unknown[] = []
            const client = createClient({
                session: {
                    async activeContext(args) {
                        activeContextCalls.push(args)
                        return { content: "active context without marker" }
                    },
                },
            })

            const loaded = await executeSkillLoad(worktree, client)
            const cached = await executeSkillLoad(worktree, client)

            expectLoadedResultShape(loaded, "code-typescript")
            expectSkippedResultShape(cached)
            expect(activeContextCalls).toEqual([{ path: { id: "session-1" }, query: { directory: worktree } }])
        })
    })

    test("different session does not skip via live cache", async () => {
        await withTempSkillRoots(async ({ configHome, worktree }) => {
            const directory = writeGeneratedSkill(configHome)
            const client = createClient({
                session: {
                    async activeContext() {
                        return { content: "active context without marker" }
                    },
                },
            })

            const firstSession = await executeSkillLoad(worktree, client, { name: "code-typescript" }, "pair", "session-1")
            const secondSession = await executeSkillLoad(worktree, client, { name: "code-typescript" }, "pair", "session-2")

            expectLoadedResultShape(firstSession, "code-typescript")
            expectLoadedResultShape(secondSession, "code-typescript")
        })
    })

    test("changed content hash reloads and stores new live cache key", async () => {
        await withTempSkillRoots(async ({ configHome, worktree }) => {
            const directory = writeGeneratedSkill(configHome, "code-typescript", "Old generated guidance.")
            const client = createClient({
                session: {
                    async activeContext() {
                        return { content: "active context without marker" }
                    },
                },
            })
            const oldResult = await executeSkillLoad(worktree, client)
            writeGeneratedSkill(configHome, "code-typescript", "New generated guidance.")

            const result = await executeSkillLoad(worktree, client)

            expectLoadedResultShape(result, "code-typescript")
            expect(extractHash(result.output)).not.toBe(extractHash(oldResult.output))
            expect(result.output).toContain("New generated guidance.")
        })
    })

    test("missing sessionID does not use live cache", async () => {
        await withTempSkillRoots(async ({ configHome, worktree }) => {
            writeGeneratedSkill(configHome)

            const first = await executeSkillLoad(worktree, undefined, { name: "code-typescript" }, "pair", null)
            const second = await executeSkillLoad(worktree, undefined, { name: "code-typescript" }, "pair", null)

            expectLoadedResultShape(first, "code-typescript")
            expectLoadedResultShape(second, "code-typescript")
        })
    })

    test("loads when active context method is missing or throws", async () => {
        await withTempSkillRoots(async ({ configHome, worktree }) => {
            const directory = writeGeneratedSkill(configHome)
            const missingClient = createClient({ session: { async messages() { throw new Error("messages must not be used") } } })
            const throwingClient = createClient({ session: { async activeContext() { throw new Error("active context failed") } } })

            const missingResult = await executeSkillLoad(worktree, missingClient)
            clearAutocodeSkillLoadLiveCacheForTest()
            const throwingResult = await executeSkillLoad(worktree, throwingClient)

            expectLoadedResultShape(missingResult, "code-typescript")
            expectLoadedResultShape(throwingResult, "code-typescript")
        })
    })

    test("direct HTTP context fallback uses SDK client base URL and skips duplicate marker", async () => {
        await withTempSkillRoots(async ({ configHome, worktree }) => {
            const directory = writeGeneratedSkill(configHome)
            const loaded = await executeSkillLoad(worktree)
            const marker = extractMarker(loaded.output)
            const requests: string[] = []
            const client = createClient({
                _client: {
                    getConfig() {
                        return {
                            baseUrl: "http://opencode.test",
                            async fetch(request: Request) {
                                requests.push(request.url)
                                expect(request.headers.get("authorization")).toBe("Bearer test")
                                return Response.json({ data: [{ content: `already loaded ${marker}` }] })
                            },
                            headers: { authorization: "Bearer test" },
                        }
                    },
                },
            })

            clearAutocodeSkillLoadLiveCacheForTest()
            const result = await executeSkillLoad(worktree, client)

            expectSkippedResultShape(result)
            expect(requests).toEqual([`http://opencode.test/api/session/session-1/context?directory=${encodeURIComponent(worktree)}`])
        })
    })

    test("loads with native-like shape when no context API or base URL exists", async () => {
        await withTempSkillRoots(async ({ configHome, worktree }) => {
            const directory = writeGeneratedSkill(configHome)
            const client = createClient({ session: { async messages() { return { data: [] } } } })

            const result = await executeSkillLoad(worktree, client)

            expectLoadedResultShape(result, "code-typescript")
        })
    })

    test("durable-history-only marker does not skip or read client.session.messages", async () => {
        await withTempSkillRoots(async ({ configHome, worktree }) => {
            const directory = writeGeneratedSkill(configHome)
            const loaded = await executeSkillLoad(worktree)
            const activeContextCalls: unknown[] = []
            const client = createClient({
                session: {
                    async activeContext(args) {
                        activeContextCalls.push(args)
                        return { content: "active context after compaction has no marker" }
                    },
                    async messages() {
                        throw new Error(`messages with durable marker must not be used: ${extractMarker(loaded.output)}`)
                    },
                },
            })

            clearAutocodeSkillLoadLiveCacheForTest()
            const result = await executeSkillLoad(worktree, client)

            expectLoadedResultShape(result, "code-typescript")
            expect(activeContextCalls).toEqual([{ path: { id: "session-1" }, query: { directory: worktree } }])
        })
    })

    test("reloads changed generated content when active context has old marker hash", async () => {
        await withTempSkillRoots(async ({ configHome, worktree }) => {
            const directory = writeGeneratedSkill(configHome, "code-typescript", "Old generated guidance.")
            const oldResult = await executeSkillLoad(worktree)
            const activeContextCalls: unknown[] = []
            writeGeneratedSkill(configHome, "code-typescript", "New generated guidance.")
            const client = createClient({
                session: {
                    async activeContext(args) {
                        activeContextCalls.push(args)
                        return { content: extractMarker(oldResult.output) }
                    },
                },
            })

            const result = await executeSkillLoad(worktree, client)

            expect(extractHash(result.output)).not.toBe(extractHash(oldResult.output))
            expectLoadedResultShape(result, "code-typescript")
            expect(result.output).toContain("New generated guidance.")
            expect(result.output).not.toContain("Old generated guidance.")
            expect(activeContextCalls).toEqual([{ path: { id: "session-1" }, query: { directory: worktree } }])
        })
    })

    test("root markdown skill loads with native name fallback", async () => {
        await withTempSkillRoots(async ({ configHome, worktree }) => {
            const rootSkill = join(configHome, "skills", "autocode", "standalone.md")
            mkdirSync(join(configHome, "skills", "autocode"), { recursive: true })
            writeFileSync(rootSkill, "---\ndescription: Standalone skill\n---\n\nStandalone guidance.")

            const result = await executeSkillLoad(worktree, undefined, { name: "standalone" })

            expectLoadedResultShape(result, "standalone")
            expect(result.output).toContain("Standalone guidance.")
        })
    })

    test("missing generated skill returns abort error", async () => {
        await withTempSkillRoots(async ({ worktree }) => {
            const result = await executeSkillLoad(worktree)

            expect(result.failedAction).toBe("load skill")
            expect(result.error).toBe("Unable to load skill code-typescript")
            expect(String(result.instruction)).toContain("Immediately ABORT")
        })
    })

    test("missing skill error names all searched locations", async () => {
        await withTempSkillRoots(async ({ worktree }) => {
            const result = await executeSkillAlias(worktree, undefined, { name: "a" })

            expect(result.failedAction).toBe("load skill")
            expect(result.error).toBe("Unable to load skill a")
            expect(String(result.error)).not.toContain("Generated skill not found")
        })
    })

    test("reference arg reads a reference file instead of main content", async () => {
        await withTempSkillRoots(async ({ configHome, worktree }) => {
            const directory = writeGeneratedSkill(configHome, "code-typescript", "Generated TypeScript guidance.")
            mkdirSync(join(directory, "templates"), { recursive: true })
            writeFileSync(join(directory, "templates", "foo.txt"), "reference content")

            const result = await executeSkillLoad(worktree, undefined, { name: "code-typescript", reference: "templates/foo.txt" })

            expect(result.output).toBe("reference content")
        })
    })

    test("reference arg errors when file not found", async () => {
        await withTempSkillRoots(async ({ configHome, worktree }) => {
            writeGeneratedSkill(configHome, "code-typescript", "Generated TypeScript guidance.")

            const result = await executeSkillLoad(worktree, undefined, { name: "code-typescript", reference: "templates/missing.txt" })

            expect(result.failedAction).toBe("load skill")
            expect(result.error).toContain("File not found")
        })
    })
})
