import { describe, expect, mock, test } from "bun:test"
import { EventEmitter } from "events"
import type { Dirent } from "fs"
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { bubblewrapProxyEnvNames } from "@/utils/autocode_sandbox_helpers"
import { getSandboxPaths, type SandboxDependencies } from "@/utils/sandbox"
import { createAskEffect, createToolContext } from "./test_context"
import { createAutocodeSandboxCliTool } from "./autocode_sandbox_cli"
import { createAutocodeSandboxCreateTool } from "./autocode_sandbox_create"
import { createAutocodeSandboxDeleteTool } from "./autocode_sandbox_delete"
import { createAutocodeSandboxCopyTool, createAutocodeSandboxEditTool, createAutocodeSandboxGlobTool, createAutocodeSandboxGrepTool, createAutocodeSandboxReadTool } from "./autocode_sandbox_file_tools"

type FakeChild = EventEmitter & { stdout: EventEmitter & { setEncoding: (encoding: string) => void }, stderr: EventEmitter & { setEncoding: (encoding: string) => void }, pid: number, kill: ReturnType<typeof mock> }

function parseResult(result: string | { output: string }): Record<string, unknown> {
    return JSON.parse(typeof result === "string" ? result : result.output) as Record<string, unknown>
}

function missingError(): NodeJS.ErrnoException {
    const error = new Error("missing") as NodeJS.ErrnoException
    error.code = "ENOENT"
    return error
}

function dirent(name: string): Dirent {
    return { name, isDirectory: () => true, isFile: () => false } as Dirent
}

function createClient(title = "My Feature", directory = "/workspace"): OpencodeClient {
    return { session: { get: mock(async () => ({ data: { id: "session-1", title, directory } })) } } as unknown as OpencodeClient
}

function createProjectToolContext(projectRoot: string): ReturnType<typeof createToolContext> {
    return { ...createToolContext(), directory: projectRoot, worktree: projectRoot }
}

function hasBindTriple(args: readonly string[], flag: string, source: string, target: string): boolean {
    return args.some((arg, index) => arg === flag && args[index + 1] === source && args[index + 2] === target)
}

function hasSetenvTriple(args: readonly string[], name: string, value: string): boolean {
    return args.some((arg, index) => arg === "--setenv" && args[index + 1] === name && args[index + 2] === value)
}

function createDeps(options?: { existing?: string[], files?: Record<string, string>, platform?: NodeJS.Platform, arch?: string, env?: NodeJS.ProcessEnv, commands?: Record<string, boolean>, fetchOk?: boolean, spawnExit?: number }): SandboxDependencies & { spawnProcess: ReturnType<typeof mock> } {
    const existing = new Set(options?.existing ?? [])
    const files = { ...(options?.files ?? {}) }
    const deps = {
        fileSystem: {
            mkdir: mock(async (filePath: string) => { existing.add(filePath) }),
            readFile: mock(async (filePath: string) => {
                if (filePath in files) return files[filePath]
                throw missingError()
            }),
            readdir: mock(async (filePath: string) => filePath === "/workspace/.agents/jobs/drafts" ? ["my_feature"] : []),
            rename: mock(async () => { }),
            rm: mock(async (filePath: string) => { existing.delete(filePath) }),
            stat: mock(async (filePath: string) => {
                if (existing.has(filePath)) return { mtimeMs: 1 }
                throw missingError()
            }),
            lstat: mock(async (filePath: string) => {
                if (existing.has(filePath)) return { mtimeMs: 1 }
                throw missingError()
            }),
            writeFile: mock(async (filePath: string, content: string | Uint8Array) => { files[filePath] = String(content) }),
            cp: mock(async (_source: unknown, destination: unknown) => { existing.add(String(destination)) }),
        },
        spawn: mock(async (command: string, args: readonly string[]) => {
            if (command === "tar" && (options?.spawnExit ?? 0) === 0) {
                const rootfsPath = String(args.find((arg) => arg.startsWith("--directory=")) ?? "").slice("--directory=".length)
                existing.add(rootfsPath)
                existing.add(path.join(rootfsPath, "bin", "sh"))
            }
            if (command === "cp" && (options?.spawnExit ?? 0) === 0) {
                const destination = String(args[args.length - 1])
                existing.add(destination)
                existing.add(path.join(destination, "bin", "sh"))
            }
            return { exitCode: options?.spawnExit ?? 0, stdout: "out", stderr: "err" }
        }),
        commandExists: mock(async (command: string) => Boolean(options?.commands?.[command])),
        fetch: mock(async () => ({ ok: options?.fetchOk ?? true, status: options?.fetchOk === false ? 500 : 200, text: async () => alpineLatestReleasesYaml(), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Response)),
        process: { platform: options?.platform ?? "linux", arch: options?.arch ?? "arm64", env: options?.env ?? {} },
        spawnProcess: mock((command: string, args: string[]) => createChild(command, args)),
    }
    return deps as SandboxDependencies & { spawnProcess: ReturnType<typeof mock> }
}

function alpineLatestReleasesYaml(): string {
    return `---
-
  title: "Mini root filesystem"
  desc: |
    version: ignored-description-line
  branch: v3.24
  arch: x86_64
  version: 3.24.0
  flavor: alpine-minirootfs
  file: alpine-minirootfs-3.24.0-x86_64.tar.gz
  sha256: x86-sha256
-
  title: "Mini root filesystem"
  desc: |
    version: ignored-description-line
  branch: v3.24
  arch: aarch64
  version: 3.24.0
  flavor: alpine-minirootfs
  file: alpine-minirootfs-3.24.0-aarch64.tar.gz
  sha256: aarch64-sha256
`
}

function getMetadataWrite(deps: ReturnType<typeof createDeps>, metadataFile: string): Record<string, unknown> {
    const writeFile = deps.fileSystem.writeFile as ReturnType<typeof mock>
    const call = writeFile.mock.calls.find((candidate) => candidate[0] === metadataFile)
    return JSON.parse(call?.[1] as string) as Record<string, unknown>
}

function createChild(_command: string, _args: string[]): FakeChild {
    const child = new EventEmitter() as FakeChild
    child.stdout = new EventEmitter() as FakeChild["stdout"]
    child.stderr = new EventEmitter() as FakeChild["stderr"]
    child.stdout.setEncoding = () => { }
    child.stderr.setEncoding = () => { }
    child.pid = 123
    child.kill = mock(() => true)
    queueMicrotask(() => {
        child.stdout.emit("data", "stdout")
        child.stderr.emit("data", "stderr")
        child.emit("close", 0, null)
    })
    return child
}

function createBubblewrapMetadata(paths: ReturnType<typeof getSandboxPaths>, backendData: Record<string, string | number | boolean | undefined> = { bwrap: "bwrap" }): string {
    return JSON.stringify({ sandbox_name: paths.sandboxName, job_name: paths.jobName, distro: "alpine", backend: "bubblewrap", root_path: paths.sandboxPath, backend_data: backendData })
}

function createRealDeps(): SandboxDependencies {
    return {
        fileSystem: { mkdir, readFile: readFile as SandboxDependencies["fileSystem"]["readFile"], readdir: readdir as SandboxDependencies["fileSystem"]["readdir"], rename: async () => { }, rm, stat, lstat, writeFile, cp },
        spawn: mock(async () => ({ exitCode: 0, stdout: "out", stderr: "err" })),
        commandExists: mock(async (command: string) => command === "bwrap"),
        fetch: mock(async () => ({ ok: true, status: 200, text: async () => alpineLatestReleasesYaml(), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Response)),
        process: { platform: "linux", arch: "arm64", env: {} },
    }
}

async function withSandboxFixture<T>(fn: (fixture: { projectRoot: string, paths: ReturnType<typeof getSandboxPaths>, deps: SandboxDependencies, client: OpencodeClient, context: ReturnType<typeof createToolContext> }) => Promise<T>): Promise<T> {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "autocode-sandbox-tools-"))
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

describe("autocode sandbox tools", () => {
    test("create refuses existing sandbox overwrite", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: [paths.sandboxPath], files: { [paths.metadataFile]: createBubblewrapMetadata(paths) } })
        const tool = createAutocodeSandboxCreateTool(createClient(), deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", distro: "alpine" }, createToolContext()))

        expect(result.status).toBe("exists")
        expect(deps.spawn).not.toHaveBeenCalled()
        expect(deps.fileSystem.rm).not.toHaveBeenCalled()
    })

    test("create repairs stale sandbox directory without metadata", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: [paths.sandboxPath], commands: { bwrap: true } })
        const tool = createAutocodeSandboxCreateTool(createClient(), deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", distro: "alpine" }, createToolContext()))

        expect(result).toEqual(expect.objectContaining({ ok: true, status: "created", repaired: true, sandbox_path: paths.sandboxPath, root_path: paths.sandboxPath }))
        expect(result.status).not.toBe("exists")
        expect(deps.fileSystem.rm).toHaveBeenCalledWith(paths.sandboxPath, { recursive: true, force: true })
        expect(deps.fileSystem.writeFile).toHaveBeenCalledWith(paths.metadataFile, expect.stringContaining('"sandbox_name": "dev"'))
        expect(deps.spawn).toHaveBeenCalledWith("bwrap", expect.arrayContaining(["/bin/sh", "-lc", "true"]), expect.any(Object))
    })

    test("create reports unsupported without usable bwrap and avoids destructive actions", async () => {
        const deps = createDeps({ commands: { "proot-distro": true, proot: true } })
        const tool = createAutocodeSandboxCreateTool(createClient(), deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", distro: "alpine" }, createToolContext()))

        expect(result.status).toBe("unsupported")
        expect(result.backend).toBe("unsupported")
        expect(String(result.reason)).toContain("usable bwrap")
        expect(String(result.guidance)).toContain("bubblewrap (bwrap)")
        expect(deps.fileSystem.mkdir).not.toHaveBeenCalled()
        expect(deps.fileSystem.rm).not.toHaveBeenCalled()
        expect(deps.spawn).not.toHaveBeenCalled()
        expect(deps.fetch).not.toHaveBeenCalled()
    })

    test("create defaults omitted distro and internet_enabled to quick offline mode", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ commands: { bwrap: true } })
        const tool = createAutocodeSandboxCreateTool(createClient(), deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev" }, createToolContext()))

        expect(result).toEqual(expect.objectContaining({ ok: true, status: "created", backend: "bubblewrap", sandbox_path: paths.sandboxPath, root_path: paths.sandboxPath, distro: "quick", distro_mode: "quick", filesystem_mode: "quick", internet_enabled: false }))
        expect(result.rootfs_path).toBeUndefined()
        expect(deps.fetch).not.toHaveBeenCalled()
        expect(deps.spawn).toHaveBeenCalledWith("bwrap", expect.arrayContaining(["--die-with-parent", "--unshare-all", "--new-session", "--proc", "/proc", "/bin/sh", "-lc", "true"]), expect.any(Object))
        expect(deps.fileSystem.mkdir).toHaveBeenCalledWith(paths.sandboxPath, { recursive: true })
        expect(deps.fileSystem.mkdir).toHaveBeenCalledWith(`${paths.sandboxPath}/home/root`, { recursive: true })
        expect(deps.fileSystem.writeFile).toHaveBeenCalledWith(paths.metadataFile, expect.stringContaining('"backend": "bubblewrap"'))
        const metadata = getMetadataWrite(deps, paths.metadataFile)
        expect(metadata).toEqual(expect.objectContaining({ sandbox_name: "dev", job_name: "my_feature", distro: "quick", backend: "bubblewrap", root_path: paths.sandboxPath, created_at: expect.any(String), updated_at: expect.any(String), backend_data: expect.objectContaining({ bwrap: "bwrap", internet_enabled: false, distro_mode: "quick", filesystem_mode: "quick", requested_sync_method: "auto" }) }))
    })

    test("blank distro uses quick mode with host read-only binds and writable sandbox/home", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: [paths.sandboxPath, `${paths.sandboxPath}/home`, "/bin", "/usr", "/lib", "/etc/passwd"], commands: { bwrap: true } })
        const tool = createAutocodeSandboxCreateTool(createClient(), deps)

        const created = parseResult(await tool.execute({ sandbox_name: "dev", distro: "   " }, createToolContext()))
        const cli = createAutocodeSandboxCliTool(createClient(), deps as Parameters<typeof createAutocodeSandboxCliTool>[1])
        const result = parseResult(await cli.execute({ sandbox_name: "dev", command: "pwd" }, createToolContext()))

        expect(created).toEqual(expect.objectContaining({ ok: true, distro: "quick", filesystem_mode: "quick" }))
        expect(result.status).toBe("completed")
        expect(deps.spawnProcess).toHaveBeenCalledWith("bwrap", expect.arrayContaining(["--ro-bind", "/bin", "/bin", "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--dir", "/etc", "--ro-bind", "/etc/passwd", "/etc/passwd", "--bind", paths.sandboxPath, "/sandbox", "--bind", `${paths.sandboxPath}/home`, "/home"]), expect.any(Object))
        expect(JSON.stringify(deps.spawnProcess.mock.calls[0]?.[1])).not.toContain("--bind,/bin,/")
    })

    test("optional quick bind tolerates broken symlink reported by lstat", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: [paths.sandboxPath, `${paths.sandboxPath}/home`, "/bin", "/etc/passwd"], commands: { bwrap: true } })
        deps.fileSystem.stat = mock(async (filePath: string) => {
            if (filePath === "/etc/passwd") throw missingError()
            if ([paths.sandboxPath, `${paths.sandboxPath}/home`, "/bin"].includes(filePath)) return { mtimeMs: 1 }
            throw missingError()
        })
        const tool = createAutocodeSandboxCreateTool(createClient(), deps)

        await tool.execute({ sandbox_name: "dev" }, createToolContext())
        const cli = createAutocodeSandboxCliTool(createClient(), deps as Parameters<typeof createAutocodeSandboxCliTool>[1])
        await cli.execute({ sandbox_name: "dev", command: "pwd" }, createToolContext())

        expect(deps.spawnProcess).toHaveBeenCalledWith("bwrap", expect.arrayContaining(["--ro-bind", "/etc/passwd", "/etc/passwd"]), expect.any(Object))
    })

    test("nonblank alpine and debian distro create rootfs metadata and CLI binds rootfs instead of host OS", async () => {
        for (const distro of ["alpine", "debian"]) {
            const paths = getSandboxPaths("/workspace", "my_feature", `dev_${distro}`)
            const deps = createDeps({ commands: { bwrap: true, xz: true }, arch: "x64" })
            const tool = createAutocodeSandboxCreateTool(createClient(), deps, { distro_cache_path: "/cache/distros", sync_method: "copy" })

            const created = parseResult(await tool.execute({ sandbox_name: `dev_${distro}`, distro }, createToolContext()))
            const metadata = getMetadataWrite(deps, paths.metadataFile)
            const cli = createAutocodeSandboxCliTool(createClient(), deps as Parameters<typeof createAutocodeSandboxCliTool>[1])
            await cli.execute({ sandbox_name: `dev_${distro}`, command: "cat /etc/os-release" }, createToolContext())

            expect(created).toEqual(expect.objectContaining({ ok: true, distro, filesystem_mode: "rootfs", rootfs_path: `${paths.sandboxPath}/rootfs`, cache_entry_path: expect.stringContaining(`/cache/distros/${distro}/x86_64/`), effective_sync_method: "copy" }))
            expect(metadata).toEqual(expect.objectContaining({ distro, backend_data: expect.objectContaining({ distro_mode: "rootfs", filesystem_mode: "rootfs", rootfs_path: `${paths.sandboxPath}/rootfs`, cache_entry_path: expect.stringContaining(`/cache/distros/${distro}/x86_64/`), cache_rootfs_path: expect.stringContaining(`/cache/distros/${distro}/x86_64/`), requested_sync_method: "copy", effective_sync_method: "copy" }) }))
            const cliArgs = deps.spawnProcess.mock.calls[0]?.[1] as string[]
            expect(cliArgs).toEqual(expect.arrayContaining(["--bind", `${paths.sandboxPath}/rootfs`, "/", "--bind", paths.sandboxPath, "/sandbox"]))
            expect(cliArgs).not.toEqual(expect.arrayContaining(["--ro-bind", "/bin", "/bin"]))
            expect(cliArgs).not.toEqual(expect.arrayContaining(["--ro-bind", "/usr", "/usr"]))
        }
    })

    test("internet_enabled true validates endpoints through sandbox network and removes storage on failure", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: ["/bin", "/usr", "/etc/resolv.conf"], commands: { bwrap: true } })
        deps.spawn = mock(async (command: string, args: readonly string[]) => {
            if (command === "bwrap" && args.at(-1) === "true") return { exitCode: 0, stdout: "out", stderr: "err" }
            if (command === "bwrap") return { exitCode: 7, stdout: "curl out", stderr: "curl err" }
            return { exitCode: 0, stdout: "out", stderr: "err" }
        })
        const tool = createAutocodeSandboxCreateTool(createClient(), deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", internet_enabled: true }, createToolContext()))

        expect(result).toEqual(expect.objectContaining({ ok: false, error: "Internet connectivity validation failed.", status: "internet_validation_failed", validation_status: "all_endpoints_failed", command: expect.stringContaining("https://github.com"), context: expect.objectContaining({ attempted_urls: expect.arrayContaining(["https://github.com", "https://registry.npmjs.org"]), filesystem_mode: "quick" }) }))
        expect(result.endpoint_diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ url: "https://github.com", stdout: "curl out", stderr: "curl err" }), expect.objectContaining({ url: "https://registry.npmjs.org", stdout: "curl out", stderr: "curl err" })]))
        expect(result.cleanup_diagnostics).toEqual(expect.objectContaining({ attempted_path: expect.stringContaining(paths.sandboxPath), success: true, status: "succeeded" }))
        expect(deps.spawn).toHaveBeenCalledWith("bwrap", expect.arrayContaining(["--share-net"]), expect.any(Object))
        expect(JSON.stringify((deps.spawn as ReturnType<typeof mock>).mock.calls)).toContain("https://github.com")
        expect(JSON.stringify((deps.spawn as ReturnType<typeof mock>).mock.calls)).toContain("https://registry.npmjs.org")
        expect(deps.fileSystem.rm).toHaveBeenCalledWith(paths.sandboxPath, { recursive: true, force: true })
    })

    test("internet validation passes host proxy env and redacts proxy credentials in diagnostics", async () => {
        const deps = createDeps({ existing: ["/bin", "/usr", "/etc/resolv.conf"], commands: { bwrap: true }, env: { HTTP_PROXY: "http://user:pass@localhost:1234", https_proxy: "http://localhost:1234", NO_PROXY: "localhost,127.0.0.1" } })
        deps.spawn = mock(async (command: string, args: readonly string[]) => {
            if (command === "bwrap" && args.at(-1) === "true") return { exitCode: 0, stdout: "out", stderr: "err" }
            if (command === "bwrap") return { exitCode: 7, stdout: "", stderr: "proxy http://user:pass@localhost:1234 failed" }
            return { exitCode: 0, stdout: "out", stderr: "err" }
        })
        const tool = createAutocodeSandboxCreateTool(createClient(), deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", internet_enabled: true }, createToolContext()))

        const validationArgs = (deps.spawn as ReturnType<typeof mock>).mock.calls.find((call) => call[0] === "bwrap" && (call[1] as readonly string[]).some((arg) => arg.includes("https://github.com")))?.[1] as string[]
        expect(validationArgs).toEqual(expect.arrayContaining(["--setenv", "HTTP_PROXY", "http://user:pass@localhost:1234", "--setenv", "https_proxy", "http://localhost:1234", "--setenv", "NO_PROXY", "localhost,127.0.0.1"]))
        expect(String(result.command)).toContain("http://[redacted]@localhost:1234")
        expect(String(result.command)).not.toContain("user:pass")
        expect(String(result.stderr)).not.toContain("user:pass")
    })

    test("internet_enabled true succeeds when GitHub fails but npm validates", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: ["/bin", "/usr", "/etc/resolv.conf"], commands: { bwrap: true } })
        deps.spawn = mock(async (command: string, args: readonly string[]) => {
            if (command === "bwrap" && args.at(-1) === "true") return { exitCode: 0, stdout: "out", stderr: "err" }
            if (command === "bwrap" && args.some((arg) => arg.includes("https://github.com"))) return { exitCode: 7, stdout: "github out", stderr: "github err" }
            if (command === "bwrap" && args.some((arg) => arg.includes("https://registry.npmjs.org"))) return { exitCode: 0, stdout: "npm out", stderr: "npm err" }
            return { exitCode: 1, stdout: "out", stderr: "err" }
        })
        const tool = createAutocodeSandboxCreateTool(createClient(), deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", internet_enabled: true }, createToolContext()))

        expect(result).toEqual(expect.objectContaining({ ok: true, internet_enabled: true }))
        expect(JSON.stringify((deps.spawn as ReturnType<typeof mock>).mock.calls)).toContain("https://github.com")
        expect(JSON.stringify((deps.spawn as ReturnType<typeof mock>).mock.calls)).toContain("https://registry.npmjs.org")
        expect(JSON.stringify((deps.spawn as ReturnType<typeof mock>).mock.calls)).not.toContain("https://dl-cdn.alpinelinux.org")
        expect(deps.fileSystem.rm).not.toHaveBeenCalledWith(paths.sandboxPath, { recursive: true, force: true })
    })

    test("internet_enabled true succeeds when HTTPS endpoints fail but HTTP fallback validates", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: ["/bin", "/usr", "/etc/resolv.conf"], commands: { bwrap: true } })
        deps.spawn = mock(async (command: string, args: readonly string[]) => {
            if (command === "bwrap" && args.at(-1) === "true") return { exitCode: 0, stdout: "out", stderr: "err" }
            if (command === "bwrap" && args.some((arg) => arg.includes("http://example.com"))) return { exitCode: 0, stdout: "example out", stderr: "example err" }
            if (command === "bwrap") return { exitCode: 7, stdout: "https out", stderr: "https err" }
            return { exitCode: 1, stdout: "out", stderr: "err" }
        })
        const tool = createAutocodeSandboxCreateTool(createClient(), deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", internet_enabled: true }, createToolContext()))
        const calls = JSON.stringify((deps.spawn as ReturnType<typeof mock>).mock.calls)

        expect(result).toEqual(expect.objectContaining({ ok: true, internet_enabled: true }))
        expect(calls).toContain("https://github.com")
        expect(calls).toContain("https://registry.npmjs.org")
        expect(calls).toContain("https://dl-cdn.alpinelinux.org")
        expect(calls).toContain("http://example.com")
        expect(calls).not.toContain("http://dl-cdn.alpinelinux.org")
        expect(deps.fileSystem.rm).not.toHaveBeenCalledWith(paths.sandboxPath, { recursive: true, force: true })
    })

    test("internet validation failure preserves diagnostics when cleanup rm throws", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: ["/bin", "/usr", "/etc/resolv.conf"], commands: { bwrap: true } })
        deps.spawn = mock(async (command: string, args: readonly string[]) => {
            if (command === "bwrap" && args.at(-1) === "true") return { exitCode: 0, stdout: "out", stderr: "err" }
            if (command === "bwrap") return { exitCode: 7, stdout: "curl out", stderr: "curl err" }
            return { exitCode: 0, stdout: "out", stderr: "err" }
        })
        deps.fileSystem.rm = mock(async () => { throw new Error("cleanup rm failed") })
        const tool = createAutocodeSandboxCreateTool(createClient(), deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", internet_enabled: true }, createToolContext()))

        expect(result).toEqual(expect.objectContaining({ ok: false, status: "internet_validation_failed", command: expect.stringContaining("https://github.com"), context: expect.objectContaining({ attempted_urls: expect.arrayContaining(["https://github.com", "https://registry.npmjs.org"]) }) }))
        expect(result.status).not.toBe("aborted")
        expect(result.cleanup_diagnostics).toEqual(expect.objectContaining({ attempted_path: expect.stringContaining(paths.sandboxPath), success: false, status: "failed", reason: "rm threw", error: expect.stringContaining("cleanup rm failed") }))
    })

    test("internet validation failure reports skipped cleanup when rm is unavailable", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: ["/bin", "/usr", "/etc/resolv.conf"], commands: { bwrap: true } })
        deps.spawn = mock(async (command: string, args: readonly string[]) => {
            if (command === "bwrap" && args.at(-1) === "true") return { exitCode: 0, stdout: "out", stderr: "err" }
            if (command === "bwrap") return { exitCode: 7, stdout: "curl out", stderr: "curl err" }
            return { exitCode: 0, stdout: "out", stderr: "err" }
        })
        ;(deps.fileSystem as { rm?: unknown }).rm = undefined
        const tool = createAutocodeSandboxCreateTool(createClient(), deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", internet_enabled: true }, createToolContext()))

        expect(result).toEqual(expect.objectContaining({ ok: false, status: "internet_validation_failed", command: expect.stringContaining("https://github.com"), context: expect.objectContaining({ attempted_urls: expect.arrayContaining(["https://github.com", "https://registry.npmjs.org"]) }) }))
        expect(result.cleanup_diagnostics).toEqual(expect.objectContaining({ attempted_path: expect.stringContaining(paths.sandboxPath), success: false, status: "skipped", reason: expect.stringContaining("rm unavailable") }))
    })

    test("internet_enabled true persists metadata after successful validation", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: ["/etc/ssl", "/etc/ssl/certs/ca-certificates.crt"], commands: { bwrap: true } })
        const tool = createAutocodeSandboxCreateTool(createClient(), deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", internet_enabled: true }, createToolContext()))
        const metadata = getMetadataWrite(deps, paths.metadataFile)

        expect(result).toEqual(expect.objectContaining({ ok: true, internet_enabled: true }))
        expect(metadata.backend_data).toEqual(expect.objectContaining({ internet_enabled: true }))
        expect(deps.spawn).toHaveBeenCalledWith("bwrap", expect.arrayContaining(["--share-net"]), expect.any(Object))
        expect(deps.spawn).toHaveBeenCalledWith("bwrap", expect.arrayContaining(["--ro-bind", "/etc/ssl", "/etc/ssl", "--ro-bind", "/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/certs/ca-certificates.crt"]), expect.any(Object))
        expect(JSON.stringify((deps.spawn as ReturnType<typeof mock>).mock.calls)).toContain("https://github.com")
    })

    test("rootfs create downloads and extracts on host before internet validation bwrap", async () => {
        const events: string[] = []
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ commands: { bwrap: true, xz: true }, arch: "x64" })
        deps.fetch = mock(async () => {
            events.push("fetch")
            return { ok: true, status: 200, text: async () => alpineLatestReleasesYaml(), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Response
        })
        deps.spawn = mock(async (command: string, args: readonly string[]) => {
            if (command === "tar") {
                events.push("tar")
                const rootfsPath = String(args.find((arg) => arg.startsWith("--directory=")) ?? "").slice("--directory=".length)
                const rootfsEntryExists = mock(async (filePath: string) => filePath === path.join(rootfsPath, "bin", "sh") || filePath === paths.sandboxPath || filePath === `${paths.sandboxPath}/rootfs` ? { mtimeMs: 1 } : Promise.reject(missingError()))
                deps.fileSystem.stat = rootfsEntryExists
                deps.fileSystem.lstat = rootfsEntryExists
            }
            if (command === "bwrap" && args.some((arg) => arg.includes("https://github.com"))) events.push("validation-bwrap")
            return { exitCode: 0, stdout: "out", stderr: "err" }
        })
        const tool = createAutocodeSandboxCreateTool(createClient(), deps, { distro_cache_path: "/cache/distros", sync_method: "copy" })

        const result = parseResult(await tool.execute({ sandbox_name: "dev", distro: "debian", internet_enabled: true }, createToolContext()))

        expect(result.ok).toBe(true)
        expect(events).toEqual(["fetch", "tar", "validation-bwrap"])
    })

    test("rootfs internet validation binds existing host CA and network config only", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: ["/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/hosts", "/etc/ssl", "/etc/ssl/certs/ca-certificates.crt"], commands: { bwrap: true, xz: true }, arch: "x64", env: { HTTP_PROXY: "http://localhost:1234" } })
        const tool = createAutocodeSandboxCreateTool(createClient(), deps, { distro_cache_path: "/cache/distros", sync_method: "copy" })

        const result = parseResult(await tool.execute({ sandbox_name: "dev", distro: "alpine", internet_enabled: true }, createToolContext()))

        const validationArgs = (deps.spawn as ReturnType<typeof mock>).mock.calls.find((call) => call[0] === "bwrap" && (call[1] as readonly string[]).some((arg) => arg.includes("https://github.com")))?.[1] as string[]
        expect(result.ok).toBe(true)
        expect(hasBindTriple(validationArgs, "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf")).toBe(true)
        expect(hasBindTriple(validationArgs, "--ro-bind", "/etc/nsswitch.conf", "/etc/nsswitch.conf")).toBe(true)
        expect(hasBindTriple(validationArgs, "--ro-bind", "/etc/hosts", "/etc/hosts")).toBe(true)
        expect(hasBindTriple(validationArgs, "--ro-bind", "/etc/ssl", "/etc/ssl")).toBe(true)
        expect(hasBindTriple(validationArgs, "--ro-bind", "/etc/ssl/certs/ca-certificates.crt", "/etc/ssl/certs/ca-certificates.crt")).toBe(true)
        expect(hasBindTriple(validationArgs, "--ro-bind", "/etc/pki", "/etc/pki")).toBe(false)
        expect(hasBindTriple(validationArgs, "--ro-bind", "/etc/ca-certificates", "/etc/ca-certificates")).toBe(false)
        expect(hasBindTriple(validationArgs, "--bind", `${paths.sandboxPath}/rootfs`, "/")).toBe(true)
        expect(validationArgs).toEqual(expect.arrayContaining(["--setenv", "HTTP_PROXY", "http://localhost:1234"]))
    })

    test("create returns rootfs source URL and status on download failure", async () => {
        const deps = createDeps({ commands: { bwrap: true }, arch: "x64", fetchOk: false })
        const tool = createAutocodeSandboxCreateTool(createClient(), deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", distro: "debian" }, createToolContext()))

        expect(result).toEqual(expect.objectContaining({ ok: false, status: "500", source_url: "https://raw.githubusercontent.com/debuerreotype/docker-debian-artifacts/dist-amd64/bookworm/rootfs.tar.xz", reason: expect.stringContaining("HTTP 500") }))
    })

    test("create uses title-derived sandbox path when lifecycle directories are empty", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ commands: { bwrap: true } })
        deps.fileSystem.readdir = mock(async () => [])
        const tool = createAutocodeSandboxCreateTool(createClient(), deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", distro: "alpine" }, createToolContext()))

        expect(result.root_path).toBe(paths.sandboxPath)
        expect(deps.fileSystem.writeFile).toHaveBeenCalledWith(paths.metadataFile, expect.stringContaining('"job_name": "my_feature"'))
    })

    test("create reports unsupported on macOS or bwrap probe failure", async () => {
        const mac = parseResult(await createAutocodeSandboxCreateTool(createClient(), createDeps({ platform: "darwin" })).execute({ sandbox_name: "dev", distro: "alpine" }, createToolContext()))
        const failedProbe = parseResult(await createAutocodeSandboxCreateTool(createClient(), createDeps({ commands: { bwrap: true }, spawnExit: 1 })).execute({ sandbox_name: "dev", distro: "debian" }, createToolContext()))

        expect(mac.backend).toBe("macos_unsupported")
        expect(failedProbe.status).toBe("unsupported")
        expect(failedProbe.reason).toContain("usable bwrap")
    })

    test("cli validates sandbox, metadata, arguments, lock, result, and bubblewrap command", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const metadata = createBubblewrapMetadata(paths, { bwrap: "/tmp/evil" })
        const deps = createDeps({ existing: [paths.sandboxPath, `${paths.sandboxPath}/home`, "/bin", "/usr"], files: { [paths.metadataFile]: metadata }, commands: { bwrap: true } })
        const tool = createAutocodeSandboxCliTool(createClient(), deps as Parameters<typeof createAutocodeSandboxCliTool>[1])

        expect(parseResult(await tool.execute({ sandbox_name: "dev", command: "pwd", working_dir: "relative" }, createToolContext())).error).toContain("working_dir")
        expect(parseResult(await tool.execute({ sandbox_name: "dev", command: "pwd", timeout: 0 }, createToolContext())).error).toContain("timeout")
        expect(parseResult(await tool.execute({ sandbox_name: "missing", command: "pwd" }, createToolContext())).status).toBe("missing")

        const result = parseResult(await tool.execute({ sandbox_name: "dev", command: "pwd", working_dir: "/", timeout: 1000 }, createToolContext()))

        expect(result).toEqual(expect.objectContaining({ status: "completed", stdout: "stdout", stderr: "stderr", output: "stdoutstderr", exit_code: 0, timed_out: false, success: true }))
        expect(deps.spawnProcess).toHaveBeenCalledWith("bwrap", expect.arrayContaining(["--die-with-parent", "--unshare-all", "--new-session", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/home", "--dir", "/sandbox", "--bind", paths.sandboxPath, "/sandbox", "--bind", `${paths.sandboxPath}/home`, "/home", "--chdir", "/", "/bin/sh", "-lc", "pwd"]), expect.any(Object))
        const cliArgs = deps.spawnProcess.mock.calls[0]?.[1] as string[]
        expect(hasBindTriple(cliArgs, "--ro-bind", "/workspace", "/workspace")).toBe(true)
        expect(hasBindTriple(cliArgs, "--bind", "/workspace", "/workspace")).toBe(false)
        expect(deps.spawnProcess.mock.calls[0]?.[0]).toBe("bwrap")
        expect(JSON.stringify(deps.spawnProcess.mock.calls)).not.toContain("proot")
    })

    test("rootfs CLI binds project root read-only at /workspace", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: [paths.sandboxPath, `${paths.sandboxPath}/home`, `${paths.sandboxPath}/rootfs`], files: { [paths.metadataFile]: createBubblewrapMetadata(paths, { bwrap: "bwrap", rootfs_path: `${paths.sandboxPath}/rootfs`, filesystem_mode: "rootfs" }) }, commands: { bwrap: true } })
        const tool = createAutocodeSandboxCliTool(createClient(), deps as Parameters<typeof createAutocodeSandboxCliTool>[1])

        await tool.execute({ sandbox_name: "dev", command: "pwd" }, createToolContext())

        const cliArgs = deps.spawnProcess.mock.calls[0]?.[1] as string[]
        expect(hasBindTriple(cliArgs, "--ro-bind", "/workspace", "/workspace")).toBe(true)
        expect(hasBindTriple(cliArgs, "--bind", "/workspace", "/workspace")).toBe(false)
        expect(hasBindTriple(cliArgs, "--bind", `${paths.sandboxPath}/rootfs`, "/")).toBe(true)
    })

    test("rootfs CLI runtime internet binds existing host CA and network config only", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: [paths.sandboxPath, `${paths.sandboxPath}/home`, `${paths.sandboxPath}/rootfs`, "/etc/resolv.conf", "/etc/hosts", "/etc/ssl"], files: { [paths.metadataFile]: createBubblewrapMetadata(paths, { bwrap: "bwrap", rootfs_path: `${paths.sandboxPath}/rootfs`, filesystem_mode: "rootfs", internet_enabled: true }) }, commands: { bwrap: true } })
        const tool = createAutocodeSandboxCliTool(createClient(), deps as Parameters<typeof createAutocodeSandboxCliTool>[1])

        await tool.execute({ sandbox_name: "dev", command: "pwd" }, createToolContext())

        const cliArgs = deps.spawnProcess.mock.calls[0]?.[1] as string[]
        expect(cliArgs).toContain("--share-net")
        expect(hasBindTriple(cliArgs, "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf")).toBe(true)
        expect(hasBindTriple(cliArgs, "--ro-bind", "/etc/hosts", "/etc/hosts")).toBe(true)
        expect(hasBindTriple(cliArgs, "--ro-bind", "/etc/ssl", "/etc/ssl")).toBe(true)
        expect(hasBindTriple(cliArgs, "--ro-bind", "/etc/pki", "/etc/pki")).toBe(false)
    })

    test("CLI runtime gates host proxy env by metadata internet_enabled", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const proxyEnv = Object.fromEntries(bubblewrapProxyEnvNames.map((name) => [name, `http://localhost/${name}`])) as NodeJS.ProcessEnv
        const offlineDeps = createDeps({ existing: [paths.sandboxPath, `${paths.sandboxPath}/home`, "/bin", "/usr"], files: { [paths.metadataFile]: createBubblewrapMetadata(paths, { bwrap: "bwrap", internet_enabled: false }) }, commands: { bwrap: true }, env: proxyEnv })
        const onlineDeps = createDeps({ existing: [paths.sandboxPath, `${paths.sandboxPath}/home`, "/bin", "/usr"], files: { [paths.metadataFile]: createBubblewrapMetadata(paths, { bwrap: "bwrap", internet_enabled: true }) }, commands: { bwrap: true }, env: proxyEnv })
        const offlineTool = createAutocodeSandboxCliTool(createClient(), offlineDeps as Parameters<typeof createAutocodeSandboxCliTool>[1])
        const onlineTool = createAutocodeSandboxCliTool(createClient(), onlineDeps as Parameters<typeof createAutocodeSandboxCliTool>[1])

        await offlineTool.execute({ sandbox_name: "dev", command: "env" }, createToolContext())
        await onlineTool.execute({ sandbox_name: "dev", command: "env" }, createToolContext())

        const offlineArgs = offlineDeps.spawnProcess.mock.calls[0]?.[1] as string[]
        const onlineArgs = onlineDeps.spawnProcess.mock.calls[0]?.[1] as string[]
        expect(offlineArgs).not.toContain("--share-net")
        expect(onlineArgs).toContain("--share-net")
        for (const name of bubblewrapProxyEnvNames) {
            expect(offlineArgs).not.toContain(name)
            expect(hasSetenvTriple(onlineArgs, name, proxyEnv[name] ?? "")).toBe(true)
        }
    })

    test("read returns OpenCode-like file pages and directory entries", async () => withSandboxFixture(async ({ paths, deps, client, context }) => {
        await mkdir(path.join(paths.sandboxPath, "src"), { recursive: true })
        await writeFile(path.join(paths.sandboxPath, "src/app.ts"), "one\ntwo\nthree")
        await writeFile(path.join(paths.sandboxPath, "src/a.txt"), "alpha")
        const tool = createAutocodeSandboxReadTool(client, deps)

        const file = parseResult(await tool.execute({ sandbox_name: "dev", path: "src/app.ts", offset: 2, limit: 1 }, context))
        const directory = parseResult(await tool.execute({ sandbox_name: "dev", path: "src", limit: 1 }, context))

        expect(file).toEqual({ path: "src/app.ts", type: "file", content: "two", offset: 2, limit: 1, lines: 1, truncated: true })
        expect(directory).toEqual(expect.objectContaining({ path: "src", type: "directory", entries: [expect.objectContaining({ path: "src/a.txt", type: "file" })] }))
    }))

    test("edit creates files, replaces exact text, replaces all matches, and retries invalid replacements", async () => withSandboxFixture(async ({ paths, deps, client, context }) => {
        const tool = createAutocodeSandboxEditTool(client, deps)
        const created = parseResult(await tool.execute({ sandbox_name: "dev", path: "docs/readme.md", oldString: "", newString: "hello" }, context))
        const replaced = parseResult(await tool.execute({ sandbox_name: "dev", path: "docs/readme.md", oldString: "ell", newString: "ipp" }, context))
        await mkdir(path.join(paths.sandboxPath, "docs"), { recursive: true })
        await writeFile(path.join(paths.sandboxPath, "docs/repeat.md"), "x x x")
        const replaceAll = parseResult(await tool.execute({ sandbox_name: "dev", path: "docs/repeat.md", oldString: "x", newString: "y", replaceAll: true }, context))

        expect(created).toEqual(expect.objectContaining({ operation: "write", target: "docs/readme.md", path: "docs/readme.md", resource: "sandbox:dev/docs/readme.md", existed: false, replacements: 0 }))
        expect(replaced).toEqual(expect.objectContaining({ operation: "write", target: "docs/readme.md", resource: "sandbox:dev/docs/readme.md", existed: true, replacements: 1 }))
        expect(replaceAll).toEqual(expect.objectContaining({ replacements: 3 }))
        expect(await readFile(path.join(paths.sandboxPath, "docs/repeat.md"), "utf8")).toBe("y y y")
        expect(parseResult(await tool.execute({ sandbox_name: "dev", path: "docs/readme.md", oldString: "same", newString: "same" }, context)).error).toContain("must differ")
        expect(parseResult(await tool.execute({ sandbox_name: "dev", path: "docs/readme.md", newString: "missing" } as never, context)).error).toContain("oldString")
        expect(parseResult(await tool.execute({ sandbox_name: "dev", path: "docs/readme.md", oldString: "missing", newString: "value" }, context)).error).toContain("not found")
        expect(parseResult(await tool.execute({ sandbox_name: "dev", path: "docs/repeat.md", oldString: "y", newString: "z" }, context)).error).toContain("multiple")
    }))

    test("glob and grep return deterministic sorted limited results", async () => withSandboxFixture(async ({ paths, deps, client, context }) => {
        await mkdir(path.join(paths.sandboxPath, "src/nested"), { recursive: true })
        await writeFile(path.join(paths.sandboxPath, "src/b.ts"), "skip\nneedle b")
        await writeFile(path.join(paths.sandboxPath, "src/a.ts"), "needle a")
        await writeFile(path.join(paths.sandboxPath, "src/nested/c.txt"), "needle c")
        const globTool = createAutocodeSandboxGlobTool(client, deps)
        const grepTool = createAutocodeSandboxGrepTool(client, deps)

        const globbed = parseResult(await globTool.execute({ sandbox_name: "dev", path: "src", pattern: "*.ts", limit: 2 }, context)) as unknown as unknown[]
        const grepped = parseResult(await grepTool.execute({ sandbox_name: "dev", path: "src", pattern: "needle", include: "**/*.ts", limit: 2 }, context)) as unknown as unknown[]

        expect(globbed).toEqual([expect.objectContaining({ path: "src/a.ts", type: "file" }), expect.objectContaining({ path: "src/b.ts", type: "file" })])
        expect(grepped).toEqual([expect.objectContaining({ path: "src/a.ts", line: 1, column: 1, text: "needle a" }), expect.objectContaining({ path: "src/b.ts", line: 2, column: 1, text: "needle b" })])
    }))

    test("file tools reject unsafe paths and symlink traversal outside sandbox", async () => withSandboxFixture(async ({ projectRoot, paths, deps, client, context }) => {
        await writeFile(path.join(projectRoot, "outside.txt"), "outside")
        await symlink(path.join(projectRoot, "outside.txt"), path.join(paths.sandboxPath, "escape"))
        const readTool = createAutocodeSandboxReadTool(client, deps)
        const editTool = createAutocodeSandboxEditTool(client, deps)

        for (const [value, error] of [
            ["", "path must be a non-empty relative path."],
            ["bad\0path", "path must not contain NUL bytes."],
            ["/absolute", "path must be relative."],
            ["../escape", "path must not escape its root."],
            ["workspace/file", "path must not target /workspace; /workspace is a read-only CLI mount only."],
        ]) {
            expect(parseResult(await readTool.execute({ sandbox_name: "dev", path: value }, context)).error).toBe(error)
        }
        expect(parseResult(await readTool.execute({ sandbox_name: "dev", path: "escape" }, context)).error).toContain("Symlink")
        expect(parseResult(await editTool.execute({ sandbox_name: "dev", path: "escape", oldString: "outside", newString: "inside" }, context)).error).toContain("Symlink")
        expect(await realpath(path.join(paths.sandboxPath, "escape"))).toBe(path.join(projectRoot, "outside.txt"))
    }))

    test("file tools reject tampered metadata root outside job sandbox root", async () => withSandboxFixture(async ({ projectRoot, paths, deps, client, context }) => {
        const outsideRoot = path.join(projectRoot, "outside-root")
        await mkdir(outsideRoot, { recursive: true })
        await writeFile(path.join(outsideRoot, "secret.txt"), "secret")
        await writeFile(paths.metadataFile, JSON.stringify({ sandbox_name: paths.sandboxName, job_name: paths.jobName, distro: "alpine", backend: "bubblewrap", root_path: outsideRoot, backend_data: { bwrap: "bwrap" } }))
        const readTool = createAutocodeSandboxReadTool(client, deps)

        const result = parseResult(await readTool.execute({ sandbox_name: "dev", path: "secret.txt" }, context))

        expect(result.ok).toBe(false)
        expect(result.status).toBe("unsafe_path")
        expect(String(result.reason)).toContain("inside the current job sandbox root")
    }))

    test("copy validates source and target selection and copies local/sandbox paths", async () => withSandboxFixture(async ({ projectRoot, paths, deps, client, context }) => {
        await mkdir(path.join(projectRoot, "local_dir"), { recursive: true })
        await writeFile(path.join(projectRoot, "local.txt"), "local")
        await writeFile(path.join(projectRoot, "local_dir/a.txt"), "a")
        await writeFile(path.join(paths.sandboxPath, "sandbox.txt"), "sandbox")
        const tool = createAutocodeSandboxCopyTool(client, deps)

        expect(parseResult(await tool.execute({ sandbox_name: "dev", local_source: "local.txt" }, context)).error).toContain("exactly one target")
        expect(parseResult(await tool.execute({ sandbox_name: "dev", local_source: "local.txt", sandbox_source: "sandbox.txt", sandbox_target: "copy.txt" }, context)).error).toContain("Exactly one source")
        expect(parseResult(await tool.execute({ sandbox_name: "dev", local_source: "local.txt", local_target: "other.txt" }, context)).error).toContain("local to local")
        expect(parseResult(await tool.execute({ sandbox_name: "dev", local_source: "local.txt", sandbox_target: "workspace/out.txt" }, context)).error).toContain("/workspace")

        expect(parseResult(await tool.execute({ sandbox_name: "dev", local_source: "local.txt", sandbox_target: "copy.txt" }, context))).toEqual(expect.objectContaining({ operation: "copy", source: "local.txt", target: "copy.txt", resource: "sandbox:dev/copy.txt" }))
        expect(await readFile(path.join(paths.sandboxPath, "copy.txt"), "utf8")).toBe("local")
        await tool.execute({ sandbox_name: "dev", sandbox_source: "copy.txt", local_target: "roundtrip.txt" }, context)
        expect(await readFile(path.join(projectRoot, "roundtrip.txt"), "utf8")).toBe("local")
        await tool.execute({ sandbox_name: "dev", sandbox_source: "copy.txt", sandbox_target: "nested/copy.txt" }, context)
        expect(await readFile(path.join(paths.sandboxPath, "nested/copy.txt"), "utf8")).toBe("local")
        await tool.execute({ sandbox_name: "dev", local_source: "local_dir", sandbox_target: "merged" }, context)
        await writeFile(path.join(projectRoot, "local_dir/a.txt"), "overwritten")
        await tool.execute({ sandbox_name: "dev", local_source: "local_dir", sandbox_target: "merged" }, context)
        expect(await readFile(path.join(paths.sandboxPath, "merged/a.txt"), "utf8")).toBe("overwritten")
        expect(parseResult(await tool.execute({ sandbox_name: "dev", local_source: "local.txt", sandbox_target: "merged" }, context)).error).toContain("file onto existing directory")
        expect(parseResult(await tool.execute({ sandbox_name: "dev", local_source: "local_dir", sandbox_target: "copy.txt" }, context)).error).toContain("directory onto existing file")
    }))

    test("copy rejects invalid source and target counts before permission request", async () => withSandboxFixture(async ({ projectRoot, paths, deps, client, context }) => {
        const requests: unknown[] = []
        await writeFile(path.join(projectRoot, "local.txt"), "local")
        await writeFile(path.join(paths.sandboxPath, "sandbox.txt"), "sandbox")
        const tool = createAutocodeSandboxCopyTool(client, deps)
        const askContext = { ...context, ask: createAskEffect((request) => { requests.push(request) }) }

        expect(parseResult(await tool.execute({ sandbox_name: "dev", sandbox_target: "copy.txt" }, askContext)).error).toContain("Exactly one source")
        expect(parseResult(await tool.execute({ sandbox_name: "dev", local_source: "local.txt", sandbox_source: "sandbox.txt", sandbox_target: "copy.txt" }, askContext)).error).toContain("Exactly one source")
        expect(parseResult(await tool.execute({ sandbox_name: "dev", local_source: "local.txt" }, askContext)).error).toContain("exactly one target")
        expect(parseResult(await tool.execute({ sandbox_name: "dev", local_source: "local.txt", local_target: "other.txt", sandbox_target: "copy.txt" }, askContext)).error).toContain("exactly one target")
        expect(requests).toEqual([])
    }))

    test("copy permission request picks sandbox_target for local source", async () => withSandboxFixture(async ({ projectRoot, paths, deps, client, context }) => {
        const requests: unknown[] = []
        await writeFile(path.join(projectRoot, "local.txt"), "local")
        const tool = createAutocodeSandboxCopyTool(client, deps)

        await tool.execute({ sandbox_name: "dev", local_source: "local.txt", sandbox_target: "copy.txt" }, { ...context, ask: createAskEffect((request) => { requests.push(request) }) })

        expect(requests).toEqual([expect.objectContaining({
            permission: "autocode_sandbox_copy",
            patterns: ["sandbox_target"],
            always: ["sandbox_target"],
            metadata: expect.objectContaining({ target_type: "sandbox_target" }),
        })])
        expect(requests).toEqual([expect.not.objectContaining({ metadata: expect.objectContaining({ direction: expect.any(String) }) })])
        expect(await readFile(path.join(paths.sandboxPath, "copy.txt"), "utf8")).toBe("local")
    }))

    test("copy permission request picks local_target", async () => withSandboxFixture(async ({ projectRoot, paths, deps, client, context }) => {
        const requests: unknown[] = []
        await writeFile(path.join(paths.sandboxPath, "sandbox.txt"), "sandbox")
        const tool = createAutocodeSandboxCopyTool(client, deps)

        await tool.execute({ sandbox_name: "dev", sandbox_source: "sandbox.txt", local_target: "roundtrip.txt" }, { ...context, ask: createAskEffect((request) => { requests.push(request) }) })

        expect(requests).toEqual([expect.objectContaining({
            permission: "autocode_sandbox_copy",
            patterns: ["local_target"],
            always: ["local_target"],
            metadata: expect.objectContaining({ target_type: "local_target" }),
        })])
        expect(requests).toEqual([expect.not.objectContaining({ metadata: expect.objectContaining({ direction: expect.any(String) }) })])
        expect(await readFile(path.join(projectRoot, "roundtrip.txt"), "utf8")).toBe("sandbox")
    }))

    test("copy permission request picks sandbox_target for sandbox source", async () => withSandboxFixture(async ({ paths, deps, client, context }) => {
        const requests: unknown[] = []
        await writeFile(path.join(paths.sandboxPath, "sandbox.txt"), "sandbox")
        const tool = createAutocodeSandboxCopyTool(client, deps)

        await tool.execute({ sandbox_name: "dev", sandbox_source: "sandbox.txt", sandbox_target: "nested/copy.txt" }, { ...context, ask: createAskEffect((request) => { requests.push(request) }) })

        expect(requests).toEqual([expect.objectContaining({
            permission: "autocode_sandbox_copy",
            patterns: ["sandbox_target"],
            always: ["sandbox_target"],
            metadata: expect.objectContaining({ target_type: "sandbox_target" }),
        })])
        expect(requests).toEqual([expect.not.objectContaining({ metadata: expect.objectContaining({ direction: expect.any(String) }) })])
        expect(await readFile(path.join(paths.sandboxPath, "nested/copy.txt"), "utf8")).toBe("sandbox")
    }))

    test("copy preserves simple permission behavior through same permission key", async () => withSandboxFixture(async ({ projectRoot, deps, client, context }) => {
        const requests: unknown[] = []
        await writeFile(path.join(projectRoot, "local.txt"), "local")
        const tool = createAutocodeSandboxCopyTool(client, deps)

        await tool.execute({ sandbox_name: "dev", local_source: "local.txt", sandbox_target: "copy.txt" }, { ...context, ask: createAskEffect((request) => { requests.push(request) }) })

        expect(requests).toEqual([expect.objectContaining({ permission: "autocode_sandbox_copy" })])
    }))

    test("copy rejects local_to_local before permission request", async () => withSandboxFixture(async ({ projectRoot, deps, client, context }) => {
        const requests: unknown[] = []
        await writeFile(path.join(projectRoot, "local.txt"), "local")
        const tool = createAutocodeSandboxCopyTool(client, deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", local_source: "local.txt", local_target: "other.txt" }, { ...context, ask: createAskEffect((request) => { requests.push(request) }) }))

        expect(result.error).toContain("local to local")
        expect(requests).toEqual([])
    }))

    test("cli network mode comes only from metadata and schema has no per-run network option", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const offlineDeps = createDeps({ existing: [paths.sandboxPath, `${paths.sandboxPath}/home`, "/bin", "/usr"], files: { [paths.metadataFile]: createBubblewrapMetadata(paths, { bwrap: "bwrap", internet_enabled: false }) }, commands: { bwrap: true } })
        const onlineDeps = createDeps({ existing: [paths.sandboxPath, `${paths.sandboxPath}/home`, "/bin", "/usr"], files: { [paths.metadataFile]: createBubblewrapMetadata(paths, { bwrap: "bwrap", internet_enabled: true }) }, commands: { bwrap: true } })
        const offlineTool = createAutocodeSandboxCliTool(createClient(), offlineDeps as Parameters<typeof createAutocodeSandboxCliTool>[1])
        const onlineTool = createAutocodeSandboxCliTool(createClient(), onlineDeps as Parameters<typeof createAutocodeSandboxCliTool>[1])

        await offlineTool.execute({ sandbox_name: "dev", command: "id", internet_enabled: true } as never, createToolContext())
        await onlineTool.execute({ sandbox_name: "dev", command: "id" }, createToolContext())

        expect(Object.keys((offlineTool as unknown as { args: Record<string, unknown> }).args)).not.toContain("internet_enabled")
        expect(offlineDeps.spawnProcess.mock.calls[0]?.[1]).not.toContain("--share-net")
        expect(onlineDeps.spawnProcess.mock.calls[0]?.[1]).toContain("--share-net")
    })

    test("cli requires sandbox metadata", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: [paths.sandboxPath] })
        const tool = createAutocodeSandboxCliTool(createClient(), deps as Parameters<typeof createAutocodeSandboxCliTool>[1])

        expect(parseResult(await tool.execute({ sandbox_name: "dev", command: "pwd" }, createToolContext())).status).toBe("missing_metadata")
    })

    test("cli finds parent-created sandbox from different derived namespace", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: [paths.sandboxPath, `${paths.sandboxPath}/home`, "/bin", "/usr"], files: { [paths.metadataFile]: createBubblewrapMetadata(paths) }, commands: { bwrap: true } })
        deps.fileSystem.readdir = mock(async (filePath: string, options?: { withFileTypes?: boolean }) => {
            if (filePath === "/workspace/.agents/jobs/drafts") return []
            if (filePath === "/workspace/.agents/sandboxes" && options?.withFileTypes) return [dirent("my_feature")]
            return []
        })
        const tool = createAutocodeSandboxCliTool(createClient("Sandbox Task"), deps as Parameters<typeof createAutocodeSandboxCliTool>[1])

        const result = parseResult(await tool.execute({ sandbox_name: "dev", command: "pwd" }, createToolContext()))

        expect(result).toEqual(expect.objectContaining({ ok: true, status: "completed", job_name: "my_feature" }))
        expect(deps.spawnProcess).toHaveBeenCalledWith("bwrap", expect.arrayContaining(["--bind", paths.sandboxPath, "/sandbox"]), expect.any(Object))
    })

    test("cli reports ambiguous sandbox fallback without spawning", async () => {
        const firstPaths = getSandboxPaths("/workspace", "my_feature", "dev")
        const secondPaths = getSandboxPaths("/workspace", "other_feature", "dev")
        const deps = createDeps({
            existing: [firstPaths.sandboxPath, secondPaths.sandboxPath],
            files: { [firstPaths.metadataFile]: createBubblewrapMetadata(firstPaths), [secondPaths.metadataFile]: createBubblewrapMetadata(secondPaths) },
            commands: { bwrap: true },
        })
        deps.fileSystem.readdir = mock(async (filePath: string, options?: { withFileTypes?: boolean }) => {
            if (filePath === "/workspace/.agents/jobs/drafts") return []
            if (filePath === "/workspace/.agents/sandboxes" && options?.withFileTypes) return [dirent("my_feature"), dirent("other_feature")]
            return []
        })
        const tool = createAutocodeSandboxCliTool(createClient("Sandbox Task"), deps as Parameters<typeof createAutocodeSandboxCliTool>[1])

        const result = parseResult(await tool.execute({ sandbox_name: "dev", command: "pwd" }, createToolContext()))

        expect(result).toEqual(expect.objectContaining({ ok: false, status: "ambiguous", candidate_job_names: ["my_feature", "other_feature"] }))
        expect(deps.spawnProcess).not.toHaveBeenCalled()
    })

    test("cli times out, falls back to child kill, and releases lock", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const lockPath = `${paths.sandboxPath}/.autocode_run_lock`
        const metadata = createBubblewrapMetadata(paths)
        const deps = createDeps({ existing: [paths.sandboxPath], files: { [paths.metadataFile]: metadata }, commands: { bwrap: true } })
        const child = new EventEmitter() as FakeChild
        child.stdout = new EventEmitter() as FakeChild["stdout"]
        child.stderr = new EventEmitter() as FakeChild["stderr"]
        child.stdout.setEncoding = () => { }
        child.stderr.setEncoding = () => { }
        child.pid = 456
        child.kill = mock(() => {
            queueMicrotask(() => child.emit("close", null, "SIGTERM"))
            return true
        })
        deps.spawnProcess = mock(() => {
            queueMicrotask(() => {
                child.stdout.emit("data", "partial stdout")
                child.stderr.emit("data", "partial stderr")
            })
            return child
        })
        const originalKill = process.kill
        process.kill = mock(() => { throw new Error("no process group") }) as unknown as typeof process.kill
        const tool = createAutocodeSandboxCliTool(createClient(), deps as Parameters<typeof createAutocodeSandboxCliTool>[1])

        try {
            const result = parseResult(await tool.execute({ sandbox_name: "dev", command: "sleep 10", timeout: 1 }, createToolContext()))

            expect(result).toEqual(expect.objectContaining({ ok: false, status: "timeout", timed_out: true, success: false, stdout: "partial stdout", stderr: "partial stderr" }))
            expect(child.kill).toHaveBeenCalledWith("SIGTERM")
            expect(deps.fileSystem.rm).toHaveBeenCalledWith(lockPath, { recursive: true, force: true })
            await expect(deps.fileSystem.stat(lockPath)).rejects.toEqual(expect.objectContaining({ code: "ENOENT" }))
        }
        finally {
            process.kill = originalKill
        }
    })

    test("cli defaults working dir, reports busy lock, and builds bubblewrap command", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const metadata = createBubblewrapMetadata(paths)
        const deps = createDeps({ existing: [paths.sandboxPath], files: { [paths.metadataFile]: metadata }, commands: { bwrap: true } })
        const tool = createAutocodeSandboxCliTool(createClient(), deps as Parameters<typeof createAutocodeSandboxCliTool>[1])

        await tool.execute({ sandbox_name: "dev", command: "id" }, createToolContext())
        expect(deps.spawnProcess).toHaveBeenCalledWith("bwrap", expect.arrayContaining(["--chdir", "/home/root", "/bin/sh", "-lc", "id"]), expect.any(Object))

        deps.fileSystem.mkdir = mock(async (filePath: string) => {
            if (filePath.endsWith(".autocode_run_lock")) {
                const error = new Error("busy") as NodeJS.ErrnoException
                error.code = "EEXIST"
                throw error
            }
        })
        expect(parseResult(await tool.execute({ sandbox_name: "dev", command: "id" }, createToolContext())).status).toBe("busy")
    })

    test("cli rejects legacy sandbox metadata without spawning", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: [paths.sandboxPath], files: { [paths.metadataFile]: JSON.stringify({ sandbox_name: "dev", job_name: "my_feature", distro: "alpine", backend: "manual_proot", root_path: `${paths.sandboxPath}/rootfs` }) } })
        const tool = createAutocodeSandboxCliTool(createClient(), deps as Parameters<typeof createAutocodeSandboxCliTool>[1])

        const result = parseResult(await tool.execute({ sandbox_name: "dev", command: "pwd" }, createToolContext()))

        expect(result).toEqual(expect.objectContaining({ status: "unsupported", backend: "manual_proot", guidance: expect.stringContaining("bubblewrap") }))
        expect(deps.spawnProcess).not.toHaveBeenCalled()
    })

    test("cli validates bubblewrap usability before spawning", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: [paths.sandboxPath], files: { [paths.metadataFile]: createBubblewrapMetadata(paths) } })
        const tool = createAutocodeSandboxCliTool(createClient(), deps as Parameters<typeof createAutocodeSandboxCliTool>[1])

        const result = parseResult(await tool.execute({ sandbox_name: "dev", command: "pwd" }, createToolContext()))

        expect(result).toEqual(expect.objectContaining({ status: "unsupported", backend: "unsupported" }))
        expect(deps.spawnProcess).not.toHaveBeenCalled()
    })

    test("delete removes all current-job bubblewrap sandboxes idempotently", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: [paths.jobSandboxRoot, paths.sandboxPath], commands: { "proot-distro": true }, files: { [paths.metadataFile]: createBubblewrapMetadata(paths) } })
        let jobRootEntries = [dirent("dev")]
        deps.fileSystem.readdir = mock(async (filePath: string, options?: { withFileTypes?: boolean }) => {
            if (filePath === "/workspace/.agents/jobs/drafts") return ["my_feature"]
            if (filePath === paths.jobSandboxRoot && options?.withFileTypes) {
                const entries = jobRootEntries
                jobRootEntries = []
                return entries
            }
            return []
        })
        const tool = createAutocodeSandboxDeleteTool(createClient(), deps)

        const all = parseResult(await tool.execute({}, createToolContext()))
        const namedMissing = parseResult(await tool.execute({ sandbox_name: "missing" }, createToolContext()))

        expect(all).toEqual(expect.objectContaining({ status: "deleted", deleted: 1 }))
        expect(deps.spawn).not.toHaveBeenCalled()
        expect(deps.fileSystem.rm).toHaveBeenCalledWith(paths.sandboxPath, { recursive: true, force: true })
        expect(deps.fileSystem.rm).toHaveBeenCalledWith(paths.jobSandboxRoot, { recursive: true, force: true })
        expect(namedMissing.status).toBe("missing")
    })

    test("named delete keeps job sandbox root when sibling sandbox remains", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const siblingPaths = getSandboxPaths("/workspace", "my_feature", "other")
        const existing = new Set([paths.jobSandboxRoot, paths.sandboxPath, siblingPaths.sandboxPath])
        const deps = createDeps({ files: { [paths.metadataFile]: createBubblewrapMetadata(paths) } })
        deps.fileSystem.rm = mock(async (filePath: string) => { existing.delete(filePath) })
        deps.fileSystem.stat = mock(async (filePath: string) => {
            if (existing.has(filePath)) return { mtimeMs: 1 }
            throw missingError()
        })
        deps.fileSystem.readdir = mock(async (filePath: string, options?: { withFileTypes?: boolean }) => {
            if (filePath === "/workspace/.agents/jobs/drafts") return ["my_feature"]
            if (filePath === paths.jobSandboxRoot && options?.withFileTypes) return existing.has(siblingPaths.sandboxPath) ? [dirent("other")] : []
            return []
        })
        const tool = createAutocodeSandboxDeleteTool(createClient(), deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev" }, createToolContext()))

        expect(result).toEqual(expect.objectContaining({ status: "deleted", sandbox_name: "dev" }))
        expect(deps.fileSystem.rm).toHaveBeenCalledWith(paths.sandboxPath, { recursive: true, force: true })
        expect(deps.fileSystem.rm).not.toHaveBeenCalledWith(paths.jobSandboxRoot, { recursive: true, force: true })
    })

    test("named delete removes job sandbox root when last sandbox is deleted", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const existing = new Set([paths.jobSandboxRoot, paths.sandboxPath])
        const deps = createDeps({ files: { [paths.metadataFile]: createBubblewrapMetadata(paths) } })
        deps.fileSystem.rm = mock(async (filePath: string) => { existing.delete(filePath) })
        deps.fileSystem.stat = mock(async (filePath: string) => {
            if (existing.has(filePath)) return { mtimeMs: 1 }
            throw missingError()
        })
        deps.fileSystem.readdir = mock(async (filePath: string, options?: { withFileTypes?: boolean }) => {
            if (filePath === "/workspace/.agents/jobs/drafts") return ["my_feature"]
            if (filePath === paths.jobSandboxRoot && options?.withFileTypes) return []
            return []
        })
        const tool = createAutocodeSandboxDeleteTool(createClient(), deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev" }, createToolContext()))

        expect(result).toEqual(expect.objectContaining({ status: "deleted", sandbox_name: "dev" }))
        expect(deps.fileSystem.rm).toHaveBeenCalledWith(paths.sandboxPath, { recursive: true, force: true })
        expect(deps.fileSystem.rm).toHaveBeenCalledWith(paths.jobSandboxRoot, { recursive: true, force: true })
    })

    test("delete warns and removes legacy metadata storage without spawning", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: [paths.sandboxPath], commands: { "proot-distro": true }, files: { [paths.metadataFile]: JSON.stringify({ sandbox_name: "dev", job_name: "my_feature", distro: "alpine", backend: "termux_proot_distro", root_path: paths.sandboxPath }) } })
        const tool = createAutocodeSandboxDeleteTool(createClient(), deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev" }, createToolContext()))

        expect(result).toEqual(expect.objectContaining({ ok: false, status: "warning", warning: expect.stringContaining("Recreate the sandbox under bubblewrap") }))
        expect(deps.spawn).not.toHaveBeenCalled()
        expect(deps.fileSystem.rm).toHaveBeenCalledWith(paths.sandboxPath, { recursive: true, force: true })
    })
})
