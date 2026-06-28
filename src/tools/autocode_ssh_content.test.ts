import { EventEmitter } from "node:events"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import type { ConnectConfig, FileEntryWithStats, Stats } from "ssh2"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { createTools } from "./index"
import { createToolContext } from "./test_context"
import { createAutocodeSshContentFrontmatterWriteTool, createAutocodeSshContentGrepTool, createAutocodeSshContentInsertTool, createAutocodeSshContentReadTool, createAutocodeSshContentRemoveTool, createAutocodeSshContentWriteTool } from "./autocode_ssh_content"
import type { SftpLike, SshChannelLike, SshClientLike, SshConnectionPool, SshReadableLike, SshResolvedConfig } from "../utils/ssh"

type ToolWithExecute = {
    execute(args: never, context: ReturnType<typeof createToolContext>): unknown
}

type FakeSftpOptions = {
    failRename?: boolean
    omitRename?: boolean
}

const baseMarkdown = `# Root
Root intro.

## Install
Install body.

### Setup
Setup body.

## Usage
Usage body.
`

function parseResult(result: unknown): Record<string, any> {
    const text = typeof result === "string" ? result : (result as { output: string }).output
    return JSON.parse(text)
}

async function execute(tool: ToolWithExecute, args: Record<string, unknown>): Promise<Record<string, any>> {
    return parseResult(await tool.execute(args as never, createToolContext()))
}

class FakeReadable extends EventEmitter implements SshReadableLike {
}

class FakeChannel extends FakeReadable implements SshChannelLike {
    readonly stderr = new FakeReadable()
}

class FakeClient extends EventEmitter implements SshClientLike {
    execCalls = 0

    constructor(private readonly sftpInstance: SftpLike) {
        super()
    }

    connect(_config: ConnectConfig): void {
    }

    exec(_command: string, callback: (err: Error | undefined, channel: SshChannelLike) => void): void {
        this.execCalls++
        callback(new Error("shell exec must not be used"), new FakeChannel())
    }

    sftp(callback: (err: Error | undefined, sftp: SftpLike) => void): void {
        callback(undefined, this.sftpInstance)
    }

    end(): void {
    }
}

class FakeSftp implements SftpLike {
    readonly readFileCalls: string[] = []
    readonly writeFileCalls: Array<{ path: string; data: string }> = []
    readonly statCalls: string[] = []
    readonly unlinkCalls: string[] = []
    readonly renameCalls: Array<{ oldPath: string; newPath: string }> = []
    rename?: (oldPath: string, newPath: string, callback: (err: Error | undefined) => void) => void

    constructor(readonly files: Record<string, string>, private readonly options: FakeSftpOptions = {}) {
        if (!options.omitRename) {
            this.rename = (oldPath: string, newPath: string, callback: (err: Error | undefined) => void): void => {
                this.renameCalls.push({ oldPath, newPath })
                if (this.options.failRename) {
                    callback(new Error("rename failed"))
                    return
                }
                this.files[newPath] = this.files[oldPath] ?? ""
                delete this.files[oldPath]
                callback(undefined)
            }
        }
    }

    readFile(path: string, callback: (err: Error | undefined, data: Buffer) => void): void
    readFile(path: string, encoding: BufferEncoding, callback: (err: Error | undefined, data: Buffer) => void): void
    readFile(path: string, encodingOrCallback: BufferEncoding | ((err: Error | undefined, data: Buffer) => void), maybeCallback?: (err: Error | undefined, data: Buffer) => void): void {
        this.readFileCalls.push(path)
        const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback
        if (!(path in this.files)) {
            callback?.(createMissingRemoteError(), Buffer.from(""))
            return
        }
        callback?.(undefined, Buffer.from(this.files[path]))
    }

    writeFile(path: string, data: string | Buffer, callback: (err: Error | undefined) => void): void {
        const content = String(data)
        this.files[path] = content
        this.writeFileCalls.push({ path, data: content })
        callback(undefined)
    }

    stat(path: string, callback: (err: Error | undefined, stats: Stats) => void): void {
        this.statCalls.push(path)
        if (!(path in this.files)) {
            callback(createMissingRemoteError(), createStats())
            return
        }
        callback(undefined, createStats())
    }

    unlink(path: string, callback: (err: Error | undefined) => void): void {
        this.unlinkCalls.push(path)
        delete this.files[path]
        callback(undefined)
    }

    mkdir(_path: string, callback: (err: Error | undefined) => void): void {
        callback(undefined)
    }

    readdir(_path: string, callback: (err: Error | undefined, list: FileEntryWithStats[]) => void): void {
        callback(undefined, [])
    }
}

class FakePool {
    readonly configs: SshResolvedConfig[] = []

    constructor(private readonly client: SshClientLike) {
    }

    async get(config: SshResolvedConfig): Promise<SshClientLike> {
        this.configs.push(config)
        return this.client
    }

    release(_config: SshResolvedConfig): void {
    }
}

function createDeps(sftp: FakeSftp): { deps: { env: NodeJS.ProcessEnv; pool: SshConnectionPool }; client: FakeClient; pool: FakePool } {
    const client = new FakeClient(sftp)
    const pool = new FakePool(client)
    return { deps: { env: { AUTOCODE_SSH_TEST_HOST: "example.test" }, pool: pool as unknown as SshConnectionPool }, client, pool }
}

function createStats(): Stats {
    return {
        mode: 0o100640,
        size: 123,
        mtime: 0,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
    } as Stats
}

function createMissingRemoteError(): NodeJS.ErrnoException {
    const error = new Error("ENOENT: no such file") as NodeJS.ErrnoException
    error.code = "ENOENT"
    return error
}

function createMockClient(): OpencodeClient {
    return {
        session: {
            async get() {
                return { data: { id: "session-1", projectID: "project-1", directory: "/workspace", title: "Session", version: "1", time: { created: Date.now(), updated: Date.now() } } }
            },
            async children() {
                return { data: [] }
            },
            async messages() {
                return { data: [] }
            },
            async promptAsync() {
                return {}
            },
            async update() {
                return {}
            },
        },
        tui: {
            async showToast() {
                return { data: true }
            },
        },
    } as unknown as OpencodeClient
}

describe("autocode ssh content tools", () => {
    test("reads markdown, json, and yaml sections over SFTP", async () => {
        const sftp = new FakeSftp({
            "/docs/guide.md": baseMarkdown,
            "/docs/data.json": JSON.stringify({ h1: [{}, { h3: { value: "old", keep: true } }] }),
            "/docs/data.yaml": "root:\n  items:\n    - child: value\n",
        })
        const { deps } = createDeps(sftp)

        const markdown = await execute(createAutocodeSshContentReadTool(deps), { ssh_key: "TEST", path: "/docs/guide.md", section: "Root.Install" })
        expect(markdown.section.path).toBe("Root.Install")
        expect(markdown.content).toContain("Install body.")
        expect(markdown.content).not.toContain("Setup body.")

        const json = await execute(createAutocodeSshContentReadTool(deps), { ssh_key: "TEST", path: "/docs/data.json", section: "h1[1].h3" })
        expect(JSON.parse(json.content)).toEqual({ value: "old", keep: true })

        const yaml = await execute(createAutocodeSshContentReadTool(deps), { ssh_key: "TEST", path: "/docs/data.yaml", section: "root.items" })
        expect(yaml.section.path).toBe("root.items")
        expect(yaml.content).toContain("- child: value")
    })

    test("writes markdown section through SFTP temp rename without shell exec", async () => {
        const sftp = new FakeSftp({ "/docs/guide.md": baseMarkdown })
        const { deps, client } = createDeps(sftp)

        const result = await execute(createAutocodeSshContentWriteTool(deps), { ssh_key: "TEST", path: "/docs/guide.md", section: "Root.Install", content: "New install.\n\n#### Added\nAdded body.\n" })

        expect(result.changed).toBe(true)
        expect(sftp.files["/docs/guide.md"]).toContain("New install.")
        expect(sftp.files["/docs/guide.md"]).toContain("### Added")
        expect(sftp.files["/docs/guide.md"]).toContain("### Setup")
        expect(sftp.files["/docs/guide.md"]).not.toContain("Install body.")
        expect(sftp.files["/docs/guide.md"]).not.toContain("#### Added")
        expect(sftp.writeFileCalls.some(call => path.posix.dirname(call.path) === "/docs" && path.posix.basename(call.path).startsWith(".guide.md.") && path.posix.basename(call.path).endsWith(".tmp"))).toBe(true)
        expect(sftp.renameCalls).toHaveLength(1)
        expect(sftp.renameCalls[0]?.oldPath).toContain(".tmp")
        expect(sftp.renameCalls[0]?.newPath).toBe("/docs/guide.md")
        expect(client.execCalls).toBe(0)
    })

    test("insert remove and frontmatter write transform markdown over fake SFTP", async () => {
        const insertSftp = new FakeSftp({ "/docs/guide.md": baseMarkdown })
        await execute(createAutocodeSshContentInsertTool(createDeps(insertSftp).deps), { ssh_key: "TEST", path: "/docs/guide.md", target: "Root", position: 1, content: "#### Before Usage\nBefore body.\n" })
        expect(insertSftp.files["/docs/guide.md"]).toContain("## Before Usage")
        expect(insertSftp.files["/docs/guide.md"]).not.toContain("#### Before Usage")

        const removeSftp = new FakeSftp({ "/docs/guide.md": baseMarkdown })
        await execute(createAutocodeSshContentRemoveTool(createDeps(removeSftp).deps), { ssh_key: "TEST", path: "/docs/guide.md", section: "Root.Install" })
        expect(removeSftp.files["/docs/guide.md"]).not.toContain("## Install")
        expect(removeSftp.files["/docs/guide.md"]).not.toContain("Setup body.")
        expect(removeSftp.files["/docs/guide.md"]).toContain("## Usage")

        const frontmatterSftp = new FakeSftp({ "/docs/guide.md": "---\nold: true\n---\n# Root\nBody.\n---\nNot separator.\n" })
        await execute(createAutocodeSshContentFrontmatterWriteTool(createDeps(frontmatterSftp).deps), { ssh_key: "TEST", path: "/docs/guide.md", frontmatter: "---\ntitle: New\n---" })
        expect(frontmatterSftp.files["/docs/guide.md"]).toBe("---\ntitle: New\n---\n# Root\nBody.\n---\nNot separator.\n")
    })

    test("falls back to backup write when SFTP rename fails", async () => {
        const sftp = new FakeSftp({ "/docs/fallback.md": baseMarkdown }, { failRename: true })
        const { deps } = createDeps(sftp)

        const result = await execute(createAutocodeSshContentWriteTool(deps), { ssh_key: "TEST", path: "/docs/fallback.md", section: "Root.Install", content: "Fallback install.\n" })

        expect(result.changed).toBe(true)
        expect(sftp.renameCalls).toHaveLength(1)
        expect(sftp.renameCalls[0]?.oldPath).toContain(".tmp")
        expect(sftp.renameCalls[0]?.newPath).toBe("/docs/fallback.md")
        expect(sftp.writeFileCalls.some(call => call.path.includes(".fallback.md.") && call.path.endsWith(".bak"))).toBe(true)
        expect(sftp.unlinkCalls.some(path => path.includes(".tmp"))).toBe(true)
        expect(sftp.unlinkCalls.some(path => path.includes(".bak"))).toBe(true)
        expect(sftp.files["/docs/fallback.md"]).toContain("Fallback install.")
    })

    test("invalid paths fail before any SFTP file action", async () => {
        for (const path of ["", "relative.md", "/docs/*.md", "/docs/bad\u0000.md", "/docs/../secret.md"]) {
            const sftp = new FakeSftp({ "/docs/guide.md": baseMarkdown })
            const { deps } = createDeps(sftp)

            const result = await execute(createAutocodeSshContentReadTool(deps), { ssh_key: "TEST", path, section: "Root" })

            expect(result.failedAction).toBe("validate remote content path")
            expect(sftp.readFileCalls).toEqual([])
            expect(sftp.writeFileCalls).toEqual([])
            expect(sftp.statCalls).toEqual([])
        }
    })

    test("rejects remote XML content path before SFTP file action", async () => {
        const sftp = new FakeSftp({ "/docs/config.xml": "<root />\n" })
        const { deps } = createDeps(sftp)

        const result = await execute(createAutocodeSshContentReadTool(deps), { ssh_key: "TEST", path: "/docs/config.xml", section: "root" })

        expect(result.failedAction).toBe("validate remote content path")
        expect(result.error).toContain(".md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf")
        expect(result.instruction).toContain("Markdown, JSON, JSONC, YAML, TOML, .env, INI, properties, or .conf")
        expect(sftp.readFileCalls).toEqual([])
        expect(sftp.writeFileCalls).toEqual([])
        expect(sftp.statCalls).toEqual([])
    })

    test("greps remote content files and specifies the file path in output", async () => {
        const sftp = new FakeSftp({
            "/docs/guide.md": "# Root\nIntro.\n\n## Install\nUse target value.\n",
            "/docs/data.json": "{\n  \"service\": { \"name\": \"target-api\" }\n}\n",
        })
        const { deps } = createDeps(sftp)

        const markdown = await execute(createAutocodeSshContentGrepTool(deps), { ssh_key: "TEST", path: "/docs/guide.md", pattern: "target", limit: 10 })
        expect(markdown[0].path).toBe("/docs/guide.md")
        expect(markdown[0].matches[0].path).toBe("Root.Install")
        expect(markdown[0].truncated).toBe(false)

        const json = await execute(createAutocodeSshContentGrepTool(deps), { ssh_key: "TEST", path: "/docs/data.json", pattern: "target", limit: 10 })
        expect(json[0].path).toBe("/docs/data.json")
        expect(String(json[0].matches[0].path)).toContain("service")
    })

    test("createTools registers SSH content tools alongside local and SSH tools", () => {
        const names = Object.keys(createTools(createMockClient()))

        expect(names).toEqual(expect.arrayContaining([
            "autocode_ssh_content_toc",
            "autocode_ssh_content_read",
            "autocode_ssh_content_write",
            "autocode_ssh_content_insert",
            "autocode_ssh_content_move",
            "autocode_ssh_content_remove",
            "autocode_ssh_content_frontmatter_read",
            "autocode_ssh_content_frontmatter_write",
            "autocode_ssh_content_grep",
            "autocode_content_read",
            "autocode_content_write",
            "autocode_ssh_read_file",
            "autocode_ssh_write_file",
            "autocode_ssh_command",
        ]))
    })
})
