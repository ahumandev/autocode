import { EventEmitter } from "node:events"
import { describe, expect, test } from "bun:test"
import type { ConnectConfig, FileEntryWithStats, Stats } from "ssh2"
import type { SftpLike, SshChannelLike, SshClientLike, SshConnectionPool, SshResolvedConfig } from "../utils/ssh"
import { createToolContext } from "./test_context"
import { configReadFlow } from "./config/core"
import type { ConfigMode } from "./config/types"
import { createRemoteConfigAdapter, createRemoteConfigExecute } from "./config/ssh/adapter"
import { createAutocodeSshConfigReadTool } from "./autocode_ssh_config_read"

const envWithPassword = {
    AUTOCODE_SSH_DEV_HOST: "ssh.example:2200",
    AUTOCODE_SSH_DEV_USERNAME: "devuser",
    AUTOCODE_SSH_DEV_PASSWORD: "secret",
} satisfies NodeJS.ProcessEnv

class MemorySftp implements SftpLike {
    readonly files = new Map<string, string>()
    readonly readFileCalls: string[] = []
    readonly writeFileCalls: Array<{ path: string; data: string }> = []
    readonly renameCalls: Array<{ oldPath: string; newPath: string }> = []
    readonly unlinkCalls: string[] = []
    readonly missing = new Set<string>()

    constructor(initial: Record<string, string> = {}) {
        for (const [key, value] of Object.entries(initial)) this.files.set(key, value)
    }

    private mockPath(path: string): string {
        if (path === "." || path === "") return "/"
        if (path.startsWith("/")) return path
        return `/${path}`
    }

    readFile(path: string, callback: (err: Error | undefined, data: Buffer) => void): void
    readFile(path: string, encoding: BufferEncoding, callback: (err: Error | undefined, data: Buffer) => void): void
    readFile(path: string, encodingOrCallback: BufferEncoding | ((err: Error | undefined, data: Buffer) => void), maybeCallback?: (err: Error | undefined, data: Buffer) => void): void {
        this.readFileCalls.push(path)
        const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback!
        if (this.missing.has(path)) {
            callback(new Error("No such file"), Buffer.alloc(0))
            return
        }
        callback(undefined, Buffer.from(this.files.get(path) ?? ""))
    }

    writeFile(path: string, data: string | Buffer, callback: (err: Error | undefined) => void): void {
        const text = typeof data === "string" ? data : data.toString("utf8")
        this.writeFileCalls.push({ path, data: text })
        this.files.set(path, text)
        callback(undefined)
    }

    rename(oldPath: string, newPath: string, callback: (err: Error | undefined) => void): void {
        this.renameCalls.push({ oldPath, newPath })
        const data = this.files.get(oldPath)
        if (data === undefined) {
            callback(new Error("No such file"))
            return
        }
        this.files.delete(oldPath)
        this.files.set(newPath, data)
        callback(undefined)
    }

    unlink(path: string, callback: (err: Error | undefined) => void): void {
        this.unlinkCalls.push(path)
        this.files.delete(path)
        callback(undefined)
    }

    stat(path: string, callback: (err: Error | undefined, stats: Stats) => void): void {
        const originalPath = path
        path = this.mockPath(path)
        if (this.missing.has(originalPath)) {
            callback(new Error("No such file"), {} as Stats)
            return
        }
        if (this.files.has(path)) {
            const data = this.files.get(path)!
            const size = Buffer.byteLength(data, "utf8")
            const stats = {
                isDirectory: () => false,
                isFile: () => true,
                isSymbolicLink: () => false,
                size,
                mtime: 0,
            } as Stats
            callback(undefined, stats)
            return
        }
        const hasChildren = path === "/"
            ? Array.from(this.files.keys()).some((p) => p.startsWith("/") && p !== "/")
            : Array.from(this.files.keys()).some((p) => p === path || p.startsWith(path + "/"))
        if (hasChildren) {
            const stats = {
                isDirectory: () => true,
                isFile: () => false,
                isSymbolicLink: () => false,
                size: 0,
                mtime: 0,
            } as Stats
            callback(undefined, stats)
            return
        }
        callback(new Error("No such file"), {} as Stats)
    }

    mkdir(_path: string, callback: (err: Error | undefined) => void): void {
        callback(undefined)
    }

    readdir(path: string, callback: (err: Error | undefined, list: FileEntryWithStats[]) => void): void {
        const originalPath = path
        path = this.mockPath(path)
        if (this.missing.has(originalPath)) {
            callback(new Error("No such file"), [])
            return
        }
        const prefix = path === "/" ? "/" : path + "/"
        const children = new Set<string>()
        for (const filePath of this.files.keys()) {
            if (!filePath.startsWith(prefix)) continue
            const rest = filePath.slice(prefix.length)
            if (rest.length === 0) continue
            const slash = rest.indexOf("/")
            children.add(slash === -1 ? rest : rest.slice(0, slash))
        }
        const entries: FileEntryWithStats[] = Array.from(children).sort().map((name) => {
            const fullPath = prefix + name
            const rest = fullPath.slice(prefix.length)
            const isFile = !rest.includes("/") && this.files.has(fullPath)
            if (isFile) {
                const size = Buffer.byteLength(this.files.get(fullPath)!, "utf8")
                return {
                    filename: name,
                    attrs: {
                        isDirectory: () => false,
                        isFile: () => true,
                        isSymbolicLink: () => false,
                        size,
                        mtime: 0,
                    } as Stats,
                    longname: `-rw-r--r-- 1 root root ${size} Jan 1 00:00 ${name}`,
                }
            }
            return {
                filename: name,
                attrs: {
                    isDirectory: () => true,
                    isFile: () => false,
                    isSymbolicLink: () => false,
                    size: 0,
                    mtime: 0,
                } as Stats,
                longname: `drwxr-xr-x 2 root root 0 Jan 1 00:00 ${name}`,
            }
        })
        callback(undefined, entries)
    }
}

class FakeClient extends EventEmitter implements SshClientLike {
    constructor(private readonly sftpInstance: SftpLike) {
        super()
    }

    connect(_config: ConnectConfig): void {
    }

    exec(_command: string, _callback: (err: Error | undefined, channel: SshChannelLike) => void): void {
    }

    sftp(callback: (err: Error | undefined, sftp: SftpLike) => void): void {
        callback(undefined, this.sftpInstance)
    }

    end(): void {
    }
}

function createFakePool(client: SshClientLike): { configs: SshResolvedConfig[]; pool: SshConnectionPool } {
    const configs: SshResolvedConfig[] = []
    const pool = {
        async get(config: SshResolvedConfig): Promise<SshClientLike> {
            configs.push(config)
            return client
        },
        release(_config: SshResolvedConfig): void {
        },
    }
    return { configs, pool: pool as unknown as SshConnectionPool }
}

function buildDeps(sftp: MemorySftp) {
    return { env: envWithPassword, pool: createFakePool(new FakeClient(sftp)).pool }
}

function parseOut(result: unknown): any {
    const raw = typeof result === "string" ? result : (result as { output: string }).output
    return JSON.parse(raw)
}

describe("ssh config read adapter", () => {
    test("validateConfigPath accepts supported extensions", async () => {
        const adapter = createRemoteConfigAdapter(new MemorySftp())
        const cases: Array<[string, ConfigMode]> = [
            ["/etc/app.json", "json"],
            ["/etc/app.jsonc", "json"],
            ["/etc/app.yaml", "yaml"],
            ["/etc/app.yml", "yaml"],
            ["/etc/app.toml", "toml"],
            ["/etc/app.ini", "ini"],
            ["/etc/app.properties", "ini"],
            ["/etc/app.conf", "ini"],
            ["/etc/.env", "env"],
        ]
        for (const [remotePath, mode] of cases) {
            const result = await adapter.validateConfigPath(remotePath)
            expect(result.ok).toBe(true)
            if (result.ok) {
                expect(result.value.mode).toBe(mode)
                expect(result.value.absolutePath).toBe(remotePath)
            }
        }
    })

    test("validateConfigPath refuses markdown", async () => {
        const adapter = createRemoteConfigAdapter(new MemorySftp())
        const result = await adapter.validateConfigPath("/etc/README.md")
        expect(result.ok).toBe(false)
        if (!result.ok) {
            const parsed = JSON.parse(result.response)
            expect(parsed.error).toContain("markdown")
            expect(parsed.instruction).toContain("autocode_md")
        }
    })

    test("validateConfigPath refuses unsupported extension", async () => {
        const adapter = createRemoteConfigAdapter(new MemorySftp())
        const result = await adapter.validateConfigPath("/etc/app.txt")
        expect(result.ok).toBe(false)
        if (!result.ok) {
            const parsed = JSON.parse(result.response)
            expect(parsed.error).toContain("unsupported file extension")
        }
    })

    test("validateConfigPath refuses empty and non-string", async () => {
        const adapter = createRemoteConfigAdapter(new MemorySftp())
        expect((await adapter.validateConfigPath("")).ok).toBe(false)
        expect((await adapter.validateConfigPath(undefined)).ok).toBe(false)
    })

    test("read delegates to sftp.readFile and returns content", async () => {
        const sftp = new MemorySftp({ "/etc/app.json": '{"a":1}' })
        const adapter = createRemoteConfigAdapter(sftp)
        const content = await adapter.read({ absolutePath: "/etc/app.json", mode: "json" })
        expect(content).toBe('{"a":1}')
        expect(sftp.readFileCalls).toContain("/etc/app.json")
    })

    test("configReadFlow outlines config read over SFTP", async () => {
        const sftp = new MemorySftp({ "/etc/app.json": JSON.stringify({ server: { port: 8080 }, debug: true }) })
        const result = await configReadFlow(createRemoteConfigAdapter(sftp), { file_path: "/etc/app.json" })
        const out = parseOut(result)
        expect(out.truncated).toBe(false)
        expect(out.nodes_total).toBe(2)
        expect(out.nodes[0].value).toBe("8080")
    })
})

describe("ssh config read tool", () => {
    test("reads config over SFTP and returns nodes", async () => {
        const sftp = new MemorySftp({ "/etc/app.json": JSON.stringify({ host: "localhost", port: 3000 }) })
        const tool = createAutocodeSshConfigReadTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", file_path_glob: "/etc/*.json" }, createToolContext())
        const out = parseOut(result)
        expect(out.file_paths["/etc/app.json"].nodes_total).toBe(2)
        expect(out.file_paths["/etc/app.json"].nodes_shown).toBe(2)
        expect(sftp.readFileCalls).toContain("/etc/app.json")
    })

    test("drills into key_path over SFTP", async () => {
        const sftp = new MemorySftp({ "/etc/app.json": JSON.stringify({ server: { host: "h", port: 9 } }) })
        const tool = createAutocodeSshConfigReadTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", file_path_glob: "/etc/*.json", key_path: "server" }, createToolContext())
        const out = parseOut(result)
        expect(out.file_paths["/etc/app.json"].nodes_total).toBe(2)
    })

    test("skips markdown files without reading SFTP", async () => {
        const sftp = new MemorySftp({ "/etc/README.md": "# hi" })
        const tool = createAutocodeSshConfigReadTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", file_path_glob: "/etc/*.md" }, createToolContext())
        const out = parseOut(result)
        expect(out.error).toContain("no readable config files")
        expect(sftp.readFileCalls).toHaveLength(0)
    })

    test("returns error for unknown ssh_key", async () => {
        const sftp = new MemorySftp({ "/etc/app.json": "{}" })
        const tool = createAutocodeSshConfigReadTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "missing", file_path_glob: "/etc/*.json" }, createToolContext())
        const out = parseOut(result)
        expect(out.failedAction).toBe("resolve SSH config")
        expect(out.error).toContain("AUTOCODE_SSH_MISSING_HOST")
    })

    test("returns multiple matches keyed by absolute path", async () => {
        const sftp = new MemorySftp({
            "/etc/a.json": JSON.stringify({ a: 1 }),
            "/etc/b.json": JSON.stringify({ b: 2 }),
        })
        const tool = createAutocodeSshConfigReadTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", file_path_glob: "/etc/*.json" }, createToolContext())
        const out = parseOut(result)
        expect(Object.keys(out.file_paths).sort()).toEqual(["/etc/a.json", "/etc/b.json"])
        expect(out.file_paths["/etc/a.json"].nodes_total).toBe(1)
        expect(out.file_paths["/etc/b.json"].nodes_total).toBe(1)
    })

    test("handles literal file pattern with relative key", async () => {
        const sftp = new MemorySftp({ "/package.json": JSON.stringify({ name: "app", version: "1.0.0" }) })
        const tool = createAutocodeSshConfigReadTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", file_path_glob: "package.json" }, createToolContext())
        const out = parseOut(result)
        expect(Object.keys(out.file_paths)).toEqual(["package.json"])
        expect(out.file_paths["package.json"].nodes_total).toBe(2)
    })

    test("returns retry response when glob matches no files", async () => {
        const sftp = new MemorySftp({ "/etc/app.json": "{}" })
        const tool = createAutocodeSshConfigReadTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", file_path_glob: "/nonexistent/*.json" }, createToolContext())
        const out = parseOut(result)
        expect(out.error).toContain("no files matched glob")
        expect(out.instruction).toContain("glob pattern")
    })

    test("skips non-config files (markdown) while keeping config files", async () => {
        const sftp = new MemorySftp({
            "/etc/app.json": JSON.stringify({ a: 1 }),
            "/etc/notes.md": "# heading",
        })
        const tool = createAutocodeSshConfigReadTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", file_path_glob: "/etc/*" }, createToolContext())
        const out = parseOut(result)
        expect(Object.keys(out.file_paths)).toEqual(["/etc/app.json"])
        expect(sftp.readFileCalls).toContain("/etc/app.json")
        expect(sftp.readFileCalls).not.toContain("/etc/notes.md")
    })

    test("isolates read failures so other files still appear", async () => {
        const sftp = new MemorySftp({
            "/etc/good.json": JSON.stringify({ a: 1 }),
            "/etc/bad.json": "{}",
        })
        sftp.missing.add("/etc/bad.json")
        const tool = createAutocodeSshConfigReadTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", file_path_glob: "/etc/*.json" }, createToolContext())
        const out = parseOut(result)
        expect(Object.keys(out.file_paths)).toEqual(["/etc/good.json"])
        expect(sftp.readFileCalls).toContain("/etc/bad.json")
    })

    test("filters out files where key_path is not found", async () => {
        const sftp = new MemorySftp({
            "/etc/a.json": JSON.stringify({ server: { port: 8080 } }),
            "/etc/b.json": JSON.stringify({ client: { port: 9090 } }),
        })
        const tool = createAutocodeSshConfigReadTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", file_path_glob: "/etc/*.json", key_path: "server" }, createToolContext())
        const out = parseOut(result)
        expect(Object.keys(out.file_paths)).toEqual(["/etc/a.json"])
        expect(out.file_paths["/etc/a.json"].nodes_total).toBe(1)
    })

    test("truncates output to max_keys", async () => {
        const sftp = new MemorySftp({
            "/etc/app.json": JSON.stringify({ a: 1, b: 2, c: 3, d: 4 }),
        })
        const tool = createAutocodeSshConfigReadTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", file_path_glob: "/etc/*.json", max_keys: 2 }, createToolContext())
        const out = parseOut(result)
        expect(out.file_paths["/etc/app.json"].nodes_shown).toBe(2)
        expect(out.file_paths["/etc/app.json"].nodes_total).toBe(4)
    })

    test("applies subkey_regex to filter nodes", async () => {
        const sftp = new MemorySftp({
            "/etc/app.json": JSON.stringify({ host: "localhost", port: 3000, debug: true }),
        })
        const tool = createAutocodeSshConfigReadTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", file_path_glob: "/etc/*.json", subkey_regex: "^host$" }, createToolContext())
        const out = parseOut(result)
        const keys = Object.keys(out.file_paths["/etc/app.json"].key_paths)
        expect(keys).toEqual(["host"])
    })

    test("absolute recursive glob matches nested files", async () => {
        const sftp = new MemorySftp({
            "/etc/app.json": JSON.stringify({ a: 1 }),
            "/etc/sub/nested.json": JSON.stringify({ b: 2 }),
            "/etc/sub/deeper/leaf.json": JSON.stringify({ c: 3 }),
        })
        const tool = createAutocodeSshConfigReadTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", file_path_glob: "/etc/**/*.json" }, createToolContext())
        const out = parseOut(result)
        expect(Object.keys(out.file_paths).sort()).toEqual([
            "/etc/app.json",
            "/etc/sub/deeper/leaf.json",
            "/etc/sub/nested.json",
        ])
    })

    test("relative recursive glob matches nested files with relative keys", async () => {
        const sftp = new MemorySftp({
            "/app.json": JSON.stringify({ a: 1 }),
            "/sub/nested.json": JSON.stringify({ b: 2 }),
        })
        const tool = createAutocodeSshConfigReadTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", file_path_glob: "**/*.json" }, createToolContext())
        const out = parseOut(result)
        expect(Object.keys(out.file_paths).sort()).toEqual(["app.json", "sub/nested.json"])
    })

    test("recursive glob with subdirectory prefix", async () => {
        const sftp = new MemorySftp({
            "/sub/a.json": JSON.stringify({ a: 1 }),
            "/sub/deep/b.json": JSON.stringify({ b: 2 }),
            "/other/c.json": JSON.stringify({ c: 3 }),
        })
        const tool = createAutocodeSshConfigReadTool(buildDeps(sftp))
        const result = await tool.execute({ ssh_key: "dev", file_path_glob: "sub/**/*.json" }, createToolContext())
        const out = parseOut(result)
        expect(Object.keys(out.file_paths).sort()).toEqual(["sub/a.json", "sub/deep/b.json"])
    })

    test("wires ssh_key through withSftp and remaps path to file_path", async () => {
        const sftp = new MemorySftp()
        const { configs, pool } = createFakePool(new FakeClient(sftp))
        const seen: Array<Record<string, unknown>> = []
        const execute = createRemoteConfigExecute({ env: envWithPassword, pool }, "read SSH config file", async (_adapter, args) => {
            seen.push(args)
            return "FLOW_OK"
        })
        const out = await execute({ ssh_key: "dev", path: "/etc/app.json" })
        expect(out).toBe("FLOW_OK")
        expect(configs).toHaveLength(1)
        expect(configs[0].key).toBe("dev")
        expect(seen[0].file_path).toBe("/etc/app.json")
    })
})
