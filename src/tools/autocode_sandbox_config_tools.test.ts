import { describe, expect, mock, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { getSandboxPaths, type SandboxDependencies } from "@/utils/sandbox"
import { createToolContext } from "./test_context"
import type { ConfigMode } from "./config/types"
import {
    createAutocodeSandboxConfigEditTool,
    createAutocodeSandboxConfigReadTool,
    createAutocodeSandboxConfigRemoveTool,
    createSandboxConfigAdapter,
} from "./autocode_sandbox_config_tools"

function parseResult(result: string | { output: string }): any {
    return JSON.parse(typeof result === "string" ? result : result.output)
}

function createClient(title = "My Feature", directory = "/workspace"): OpencodeClient {
    return { session: { get: mock(async () => ({ data: { id: "session-1", title, directory } })) } } as unknown as OpencodeClient
}

function createProjectToolContext(projectRoot: string): ReturnType<typeof createToolContext> {
    return { ...createToolContext(), directory: projectRoot, worktree: projectRoot }
}

function createBubblewrapMetadata(paths: ReturnType<typeof getSandboxPaths>, backendData: Record<string, string | number | boolean | undefined> = { bwrap: "bwrap" }): string {
    return JSON.stringify({ sandbox_name: paths.sandboxName, job_name: paths.jobName, distro: "alpine", backend: "bubblewrap", root_path: paths.sandboxPath, backend_data: backendData })
}

function createRealDeps(): SandboxDependencies {
    return {
        fileSystem: { mkdir, readFile: readFile as SandboxDependencies["fileSystem"]["readFile"], readdir: readdir as SandboxDependencies["fileSystem"]["readdir"], rename: async () => { }, rm, stat, lstat, writeFile, cp: undefined },
        spawn: mock(async () => ({ exitCode: 0, stdout: "out", stderr: "err" })),
        commandExists: mock(async (command: string) => command === "bwrap"),
        fetch: mock(async () => ({ ok: true, status: 200, text: async () => "", arrayBuffer: async () => new Uint8Array().buffer } as Response)),
        process: { platform: "linux", arch: "arm64", env: {} },
    }
}

function createInMemoryDeps(): SandboxDependencies {
    return {
        fileSystem: {
            mkdir: mock(async () => undefined),
            readFile: mock(async () => ""),
            readdir: mock(async () => []),
            rename: mock(async () => undefined),
            rm: mock(async () => undefined),
            stat: mock(async () => ({ mtimeMs: 0 })),
            lstat: mock(async () => ({ mtimeMs: 0 })),
            writeFile: mock(async () => undefined),
        },
        spawn: mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
        commandExists: mock(async () => false),
        fetch: mock(async () => ({ ok: true, status: 200, text: async () => "", arrayBuffer: async () => new Uint8Array().buffer } as Response)),
        process: { platform: "linux", arch: "arm64", env: {} },
    }
}

async function withSandboxFixture<T>(fn: (fixture: { projectRoot: string, paths: ReturnType<typeof getSandboxPaths>, deps: SandboxDependencies, client: OpencodeClient, context: ReturnType<typeof createToolContext> }) => Promise<T>): Promise<T> {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "autocode-sandbox-config-tools-"))
    const paths = getSandboxPaths(projectRoot, "my_feature", "dev")
    const deps = createRealDeps()
    try {
        await mkdir(paths.sandboxPath, { recursive: true })
        await writeFile(paths.metadataFile, createBubblewrapMetadata(paths))
        return await fn({ projectRoot, paths, deps, client: createClient("My Feature", projectRoot), context: createProjectToolContext(projectRoot) })
    }
    finally {
        await rm(projectRoot, { recursive: true, force: true })
    }
}

async function withTempRoot<T>(fn: (fixture: { rootPath: string, deps: SandboxDependencies }) => Promise<T>): Promise<T> {
    const rootPath = await mkdtemp(path.join(tmpdir(), "autocode-sandbox-config-adapter-"))
    const deps = createRealDeps()
    try {
        return await fn({ rootPath, deps })
    }
    finally {
        await rm(rootPath, { recursive: true, force: true })
    }
}

describe("createSandboxConfigAdapter", () => {
    test("validateConfigPath rejects empty and non-string", async () => {
        const adapter = createSandboxConfigAdapter("/tmp/anywhere", createInMemoryDeps())

        const empty = await adapter.validateConfigPath("")
        const undef = await adapter.validateConfigPath(undefined)
        const nul = await adapter.validateConfigPath(null)

        expect(empty.ok).toBe(false)
        expect(undef.ok).toBe(false)
        expect(nul.ok).toBe(false)
        if (!empty.ok) {
            const parsed = JSON.parse(empty.response)
            expect(parsed.failedAction).toBe("Read configuration file")
            expect(String(parsed.error)).toContain("path required")
        }
    })

    test("validateConfigPath refuses markdown", async () => {
        const adapter = createSandboxConfigAdapter("/tmp/anywhere", createInMemoryDeps())
        const result = await adapter.validateConfigPath("notes.md")

        expect(result.ok).toBe(false)
        if (!result.ok) {
            const parsed = JSON.parse(result.response)
            expect(String(parsed.error)).toContain("markdown")
            expect(String(parsed.instruction)).toContain("autocode_md")
        }
    })

    test("validateConfigPath refuses unsupported extension", async () => {
        const adapter = createSandboxConfigAdapter("/tmp/anywhere", createInMemoryDeps())
        const result = await adapter.validateConfigPath("notes.txt")

        expect(result.ok).toBe(false)
        if (!result.ok) {
            const parsed = JSON.parse(result.response)
            expect(String(parsed.error)).toContain("unsupported file extension")
        }
    })

    test("validateConfigPath refuses parent escape", async () => {
        const adapter = createSandboxConfigAdapter("/tmp/anywhere", createInMemoryDeps())
        const result = await adapter.validateConfigPath("../escape.json")

        expect(result.ok).toBe(false)
        if (!result.ok) {
            const parsed = JSON.parse(result.response)
            expect(String(parsed.error)).toContain("escape")
        }
    })

    test("validateConfigPath accepts supported extensions with correct mode", async () => withSandboxFixture(async ({ paths }) => {
        const adapter = createSandboxConfigAdapter(paths.sandboxPath, createRealDeps())
        const cases: Array<[string, ConfigMode]> = [
            ["app.json", "json"],
            ["data.yaml", "yaml"],
            ["settings.yml", "yaml"],
            ["config.toml", "toml"],
            ["app.ini", "ini"],
            ["app.conf", "ini"],
            ["app.properties", "ini"],
        ]
        for (const [name, mode] of cases) {
            const result = await adapter.validateConfigPath(name)
            expect(result.ok).toBe(true)
            if (result.ok) {
                expect(result.value.mode).toBe(mode)
                expect(result.value.absolutePath).toBe(path.join(paths.sandboxPath, name))
            }
        }
    }))

    test("validateConfigPath accepts .env and conf.ini and data.yaml modes", async () => withSandboxFixture(async ({ paths }) => {
        const adapter = createSandboxConfigAdapter(paths.sandboxPath, createRealDeps())

        const env = await adapter.validateConfigPath(".env")
        expect(env.ok).toBe(true)
        if (env.ok) expect(env.value.mode).toBe("env")

        const ini = await adapter.validateConfigPath("conf.ini")
        expect(ini.ok).toBe(true)
        if (ini.ok) expect(ini.value.mode).toBe("ini")

        const yaml = await adapter.validateConfigPath("data.yaml")
        expect(yaml.ok).toBe(true)
        if (yaml.ok) expect(yaml.value.mode).toBe("yaml")
    }))

    test("read returns written file content and write creates nested parent dirs", async () => withTempRoot(async ({ rootPath, deps }) => {
        const adapter = createSandboxConfigAdapter(rootPath, deps)
        const target = { absolutePath: path.join(rootPath, "nested", "dir", "a.json"), mode: "json" as const }
        const content = '{"hello":"world"}'

        await adapter.write(target, content)
        const onDisk = await readFile(target.absolutePath, "utf8")
        expect(onDisk).toBe(content)

        const readBack = await adapter.read(target)
        expect(readBack).toBe(content)
    }))
})

describe("createAutocodeSandboxConfigEditTool", () => {
    test("REPLACE updates existing key in real sandbox file", async () => withSandboxFixture(async ({ paths, deps, client, context }) => {
        await writeFile(path.join(paths.sandboxPath, "app.json"), JSON.stringify({ server: { port: 3000 } }))
        const tool = createAutocodeSandboxConfigEditTool(client, deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", path: "app.json", current_key: "server.port", content: "8080" }, context))

        expect(result.action).toBe("replace")
        const onDisk = JSON.parse(await readFile(path.join(paths.sandboxPath, "app.json"), "utf8"))
        expect(onDisk.server.port).toBe(8080)
    }))

    test("CREATE adds new key in real sandbox file", async () => withSandboxFixture(async ({ paths, deps, client, context }) => {
        await writeFile(path.join(paths.sandboxPath, "app.json"), JSON.stringify({ server: { port: 3000 } }))
        const tool = createAutocodeSandboxConfigEditTool(client, deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", path: "app.json", new_key: "server.host", content: '"0.0.0.0"' }, context))

        expect(result.action).toBe("create")
        const onDisk = JSON.parse(await readFile(path.join(paths.sandboxPath, "app.json"), "utf8"))
        expect(onDisk.server.host).toBe("0.0.0.0")
        expect(onDisk.server.port).toBe(3000)
    }))

    test("RENAME moves key in real sandbox file", async () => withSandboxFixture(async ({ paths, deps, client, context }) => {
        await writeFile(path.join(paths.sandboxPath, "app.json"), JSON.stringify({ server: { port: 3000 } }))
        const tool = createAutocodeSandboxConfigEditTool(client, deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", path: "app.json", current_key: "server.port", new_key: "server.listen" }, context))

        expect(result.action).toBe("rename")
        const onDisk = JSON.parse(await readFile(path.join(paths.sandboxPath, "app.json"), "utf8"))
        expect(onDisk.server.listen).toBe(3000)
        expect(onDisk.server.port).toBeUndefined()
    }))

    test("array insert appends via non-existing index", async () => withSandboxFixture(async ({ paths, deps, client, context }) => {
        await writeFile(path.join(paths.sandboxPath, "app.json"), JSON.stringify({ ports: [80] }))
        const tool = createAutocodeSandboxConfigEditTool(client, deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", path: "app.json", new_key: "ports[1]", content: "443" }, context))

        expect(result.action).toBe("create")
        const onDisk = JSON.parse(await readFile(path.join(paths.sandboxPath, "app.json"), "utf8"))
        expect(onDisk.ports).toEqual([80, 443])
    }))

    test("refuses markdown path", async () => withSandboxFixture(async ({ paths, deps, client, context }) => {
        await writeFile(path.join(paths.sandboxPath, "readme.md"), "# hi")
        const tool = createAutocodeSandboxConfigEditTool(client, deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", path: "readme.md", current_key: "a", content: "1" }, context))

        expect(String(result.error)).toContain("markdown")
    }))

    test("refuses parent escape path", async () => withSandboxFixture(async ({ deps, client, context }) => {
        const tool = createAutocodeSandboxConfigEditTool(client, deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", path: "../escape.json", current_key: "a", content: "1" }, context))

        expect(String(result.error)).toContain("escape")
    }))

    test("missing sandbox_name returns retry with status missing", async () => withSandboxFixture(async ({ deps, client, context }) => {
        const tool = createAutocodeSandboxConfigEditTool(client, deps)

        const result = parseResult(await tool.execute({ sandbox_name: "nonexistent", path: "app.json", current_key: "a", content: "1" }, context))

        expect(result.status).toBe("missing")
    }))
})

describe("createAutocodeSandboxConfigReadTool", () => {
    test("outline returns key_paths and node counts for matching files", async () => withSandboxFixture(async ({ paths, deps, client, context }) => {
        await writeFile(path.join(paths.sandboxPath, "app.json"), JSON.stringify({ server: { port: 3000, host: "x" } }))
        const tool = createAutocodeSandboxConfigReadTool(client, deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", file_path_glob: "app.json" }, context))

        expect(Object.keys(result.file_paths)).toEqual(["app.json"])
        const fileEntry = result.file_paths["app.json"] as { key_paths: Record<string, string>, nodes_shown: number, nodes_total: number }
        expect(fileEntry.key_paths["server.port"]).toBe("3000")
        expect(fileEntry.key_paths["server.host"]).toBe("x")
        expect(fileEntry.nodes_shown).toBe(2)
        expect(fileEntry.nodes_total).toBe(2)
    }))

    test("key_path drills into a specific subtree", async () => withSandboxFixture(async ({ paths, deps, client, context }) => {
        await writeFile(path.join(paths.sandboxPath, "app.json"), JSON.stringify({ server: { port: 3000, host: "x" }, other: 1 }))
        const tool = createAutocodeSandboxConfigReadTool(client, deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", file_path_glob: "app.json", key_path: "server" }, context))
        const fileEntry = result.file_paths["app.json"] as { key_paths: Record<string, string> }

        expect(fileEntry.key_paths["port"]).toBe("3000")
        expect(fileEntry.key_paths["host"]).toBe("x")
        expect(fileEntry.key_paths["other"]).toBeUndefined()
    }))

    test("recursive glob returns multiple file_paths keys", async () => withSandboxFixture(async ({ paths, deps, client, context }) => {
        await mkdir(path.join(paths.sandboxPath, "cfg", "sub"), { recursive: true })
        await writeFile(path.join(paths.sandboxPath, "cfg", "a.json"), JSON.stringify({ a: 1 }))
        await writeFile(path.join(paths.sandboxPath, "cfg", "b.yaml"), "b: 2\n")
        await writeFile(path.join(paths.sandboxPath, "cfg", "sub", "c.json"), JSON.stringify({ c: 3 }))
        const tool = createAutocodeSandboxConfigReadTool(client, deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", file_path_glob: "cfg/**/*.{json,yaml}" }, context))

        expect(Object.keys(result.file_paths).sort()).toEqual(["cfg/a.json", "cfg/b.yaml", "cfg/sub/c.json"])
    }))

    test("value_regex filters leaf nodes by regex", async () => withSandboxFixture(async ({ paths, deps, client, context }) => {
        await writeFile(path.join(paths.sandboxPath, "vp.json"), JSON.stringify({ a: "hello", b: "world", c: 42 }))
        const tool = createAutocodeSandboxConfigReadTool(client, deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", file_path_glob: "vp.json", value_regex: "ello" }, context))
        const fileEntry = result.file_paths["vp.json"] as { key_paths: Record<string, string> }

        expect(fileEntry.key_paths["a"]).toBe("hello")
        expect(fileEntry.key_paths["c"]).toBeUndefined()
    }))

    test("non-matching glob returns retry 'no files matched glob'", async () => withSandboxFixture(async ({ deps, client, context }) => {
        const tool = createAutocodeSandboxConfigReadTool(client, deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", file_path_glob: "nope/*.json" }, context))

        expect(String(result.error)).toContain("no files matched glob")
        expect(result.file_paths).toBeUndefined()
    }))

    test("markdown-only glob returns retry 'no readable config files'", async () => withSandboxFixture(async ({ paths, deps, client, context }) => {
        await writeFile(path.join(paths.sandboxPath, "readme.md"), "# heading")
        const tool = createAutocodeSandboxConfigReadTool(client, deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", file_path_glob: "*.md" }, context))

        expect(String(result.error)).toContain("no readable config files")
        expect(result.file_paths).toBeUndefined()
    }))
})

describe("createAutocodeSandboxConfigRemoveTool", () => {
    test("remove leaf key keeps sibling keys", async () => withSandboxFixture(async ({ paths, deps, client, context }) => {
        await writeFile(path.join(paths.sandboxPath, "app.json"), JSON.stringify({ server: { port: 3000, host: "x" }, debug: true }))
        const tool = createAutocodeSandboxConfigRemoveTool(client, deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", path: "app.json", key_path: "server.port" }, context))

        expect(result.removed).toEqual(["server", "port"])
        const onDisk = JSON.parse(await readFile(path.join(paths.sandboxPath, "app.json"), "utf8"))
        expect(onDisk.server.port).toBeUndefined()
        expect(onDisk.server.host).toBe("x")
        expect(onDisk.debug).toBe(true)
    }))

    test("remove subtree deletes the entire branch", async () => withSandboxFixture(async ({ paths, deps, client, context }) => {
        await writeFile(path.join(paths.sandboxPath, "app.json"), JSON.stringify({ server: { port: 3000, host: "x" }, other: 1 }))
        const tool = createAutocodeSandboxConfigRemoveTool(client, deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", path: "app.json", key_path: "server" }, context))

        expect(result.removed).toEqual(["server"])
        const onDisk = JSON.parse(await readFile(path.join(paths.sandboxPath, "app.json"), "utf8"))
        expect(onDisk.server).toBeUndefined()
        expect(onDisk.other).toBe(1)
    }))

    test("refuses to remove root key", async () => withSandboxFixture(async ({ paths, deps, client, context }) => {
        await writeFile(path.join(paths.sandboxPath, "app.json"), JSON.stringify({ a: 1 }))
        const tool = createAutocodeSandboxConfigRemoveTool(client, deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", path: "app.json", key_path: "" }, context))

        expect(String(result.error)).toContain("cannot remove root")
        const onDisk = JSON.parse(await readFile(path.join(paths.sandboxPath, "app.json"), "utf8"))
        expect(onDisk.a).toBe(1)
    }))

    test("returns retry when key_path is not found", async () => withSandboxFixture(async ({ paths, deps, client, context }) => {
        await writeFile(path.join(paths.sandboxPath, "app.json"), JSON.stringify({ a: 1 }))
        const tool = createAutocodeSandboxConfigRemoveTool(client, deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", path: "app.json", key_path: "nope.missing" }, context))

        expect(String(result.error)).toContain("key_path not found")
    }))

    test("refuses markdown path", async () => withSandboxFixture(async ({ paths, deps, client, context }) => {
        await writeFile(path.join(paths.sandboxPath, "readme.md"), "# hi")
        const tool = createAutocodeSandboxConfigRemoveTool(client, deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", path: "readme.md", key_path: "x" }, context))

        expect(String(result.error)).toContain("markdown")
    }))
})
