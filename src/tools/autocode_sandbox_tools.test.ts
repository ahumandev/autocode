import { describe, expect, mock, test } from "bun:test"
import { EventEmitter } from "events"
import type { Dirent } from "fs"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { getSandboxPaths, type SandboxDependencies } from "@/utils/sandbox"
import { createToolContext } from "./test_context"
import { createAutocodeSandboxCliTool } from "./autocode_sandbox_cli"
import { createAutocodeSandboxCreateTool } from "./autocode_sandbox_create"
import { createAutocodeSandboxDeleteTool } from "./autocode_sandbox_delete"

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

function createClient(title = "My Feature"): OpencodeClient {
    return { session: { get: mock(async () => ({ data: { id: "session-1", title, directory: "/workspace" } })) } } as unknown as OpencodeClient
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
            writeFile: mock(async (filePath: string, content: string | Uint8Array) => { files[filePath] = String(content) }),
            cp: mock(async (_source: unknown, destination: unknown) => { existing.add(String(destination)) }),
        },
        spawn: mock(async () => ({ exitCode: options?.spawnExit ?? 0, stdout: "out", stderr: "err" })),
        commandExists: mock(async (command: string) => Boolean(options?.commands?.[command])),
        fetch: mock(async () => ({ ok: options?.fetchOk ?? true, status: options?.fetchOk === false ? 500 : 200, text: async () => alpineLatestReleasesYaml(), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Response)),
        process: { platform: options?.platform ?? "linux", arch: options?.arch ?? "arm64", env: options?.env ?? {} },
        spawnProcess: mock((command: string, args: string[]) => createChild(command, args)),
    }
    return deps as SandboxDependencies & { spawnProcess: ReturnType<typeof mock> }
}

function alpineLatestReleasesYaml(): string {
    return `- file: alpine-minirootfs-3.20.3-x86_64.tar.gz
  arch: x86_64
  flavor: minirootfs
  version: 3.20.3
  sha256: x86-sha256
- file: alpine-minirootfs-3.20.3-aarch64.tar.gz
  arch: aarch64
  flavor: minirootfs
  version: 3.20.3
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

    test("nonblank alpine and debian distro create rootfs metadata and CLI binds rootfs instead of host OS", async () => {
        for (const distro of ["alpine", "debian"]) {
            const paths = getSandboxPaths("/workspace", "my_feature", `dev_${distro}`)
            const deps = createDeps({ commands: { bwrap: true }, arch: "x64" })
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

    test("internet_enabled true validates GitHub through sandbox network and removes storage on failure", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: ["/bin", "/usr", "/etc/resolv.conf"], commands: { bwrap: true } })
        deps.spawn = mock(async (command: string, args: readonly string[]) => {
            if (command === "bwrap" && args.some((arg) => arg.includes("https://github.com"))) return { exitCode: 7, stdout: "curl out", stderr: "curl err" }
            return { exitCode: 0, stdout: "out", stderr: "err" }
        })
        const tool = createAutocodeSandboxCreateTool(createClient(), deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", internet_enabled: true }, createToolContext()))

        expect(result).toEqual(expect.objectContaining({ ok: false, error: "GitHub connectivity validation failed.", stdout: "curl out", stderr: "curl err", status: "internet_validation_failed", command: expect.stringContaining("https://github.com"), context: expect.objectContaining({ url: "https://github.com", filesystem_mode: "quick" }) }))
        expect(result.cleanup_diagnostics).toEqual(expect.objectContaining({ attempted_path: expect.stringContaining(paths.sandboxPath), success: true, status: "succeeded" }))
        expect(deps.spawn).toHaveBeenCalledWith("bwrap", expect.arrayContaining(["--share-net"]), expect.any(Object))
        expect(JSON.stringify((deps.spawn as ReturnType<typeof mock>).mock.calls)).toContain("https://github.com")
        expect(deps.fileSystem.rm).toHaveBeenCalledWith(paths.sandboxPath, { recursive: true, force: true })
    })

    test("internet validation failure preserves diagnostics when cleanup rm throws", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: ["/bin", "/usr", "/etc/resolv.conf"], commands: { bwrap: true } })
        deps.spawn = mock(async (command: string, args: readonly string[]) => {
            if (command === "bwrap" && args.some((arg) => arg.includes("https://github.com"))) return { exitCode: 7, stdout: "curl out", stderr: "curl err" }
            return { exitCode: 0, stdout: "out", stderr: "err" }
        })
        deps.fileSystem.rm = mock(async () => { throw new Error("cleanup rm failed") })
        const tool = createAutocodeSandboxCreateTool(createClient(), deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", internet_enabled: true }, createToolContext()))

        expect(result).toEqual(expect.objectContaining({ ok: false, status: "internet_validation_failed", stderr: "curl err", command: expect.stringContaining("https://github.com"), context: expect.objectContaining({ url: "https://github.com" }) }))
        expect(result.status).not.toBe("aborted")
        expect(result.cleanup_diagnostics).toEqual(expect.objectContaining({ attempted_path: expect.stringContaining(paths.sandboxPath), success: false, status: "failed", reason: "rm threw", error: expect.stringContaining("cleanup rm failed") }))
    })

    test("internet validation failure reports skipped cleanup when rm is unavailable", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ existing: ["/bin", "/usr", "/etc/resolv.conf"], commands: { bwrap: true } })
        deps.spawn = mock(async (command: string, args: readonly string[]) => {
            if (command === "bwrap" && args.some((arg) => arg.includes("https://github.com"))) return { exitCode: 7, stdout: "curl out", stderr: "curl err" }
            return { exitCode: 0, stdout: "out", stderr: "err" }
        })
        ;(deps.fileSystem as { rm?: unknown }).rm = undefined
        const tool = createAutocodeSandboxCreateTool(createClient(), deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", internet_enabled: true }, createToolContext()))

        expect(result).toEqual(expect.objectContaining({ ok: false, status: "internet_validation_failed", command: expect.stringContaining("https://github.com"), context: expect.objectContaining({ url: "https://github.com" }) }))
        expect(result.cleanup_diagnostics).toEqual(expect.objectContaining({ attempted_path: expect.stringContaining(paths.sandboxPath), success: false, status: "skipped", reason: expect.stringContaining("rm unavailable") }))
    })

    test("internet_enabled true persists metadata after successful validation", async () => {
        const paths = getSandboxPaths("/workspace", "my_feature", "dev")
        const deps = createDeps({ commands: { bwrap: true } })
        const tool = createAutocodeSandboxCreateTool(createClient(), deps)

        const result = parseResult(await tool.execute({ sandbox_name: "dev", internet_enabled: true }, createToolContext()))
        const metadata = getMetadataWrite(deps, paths.metadataFile)

        expect(result).toEqual(expect.objectContaining({ ok: true, internet_enabled: true }))
        expect(metadata.backend_data).toEqual(expect.objectContaining({ internet_enabled: true }))
        expect(deps.spawn).toHaveBeenCalledWith("bwrap", expect.arrayContaining(["--share-net"]), expect.any(Object))
        expect(JSON.stringify((deps.spawn as ReturnType<typeof mock>).mock.calls)).toContain("https://github.com")
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
        expect(deps.spawnProcess.mock.calls[0]?.[0]).toBe("bwrap")
        expect(JSON.stringify(deps.spawnProcess.mock.calls)).not.toContain("proot")
    })

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
        deps.fileSystem.readdir = mock(async (filePath: string, options?: { withFileTypes?: boolean }) => {
            if (filePath === "/workspace/.agents/jobs/drafts") return ["my_feature"]
            if (filePath === paths.jobSandboxRoot && options?.withFileTypes) return [dirent("dev")]
            return []
        })
        const tool = createAutocodeSandboxDeleteTool(createClient(), deps)

        const all = parseResult(await tool.execute({}, createToolContext()))
        const namedMissing = parseResult(await tool.execute({ sandbox_name: "missing" }, createToolContext()))

        expect(all).toEqual(expect.objectContaining({ status: "deleted", deleted: 1 }))
        expect(deps.spawn).not.toHaveBeenCalled()
        expect(deps.fileSystem.rm).toHaveBeenCalledWith(paths.sandboxPath, { recursive: true, force: true })
        expect(namedMissing.status).toBe("missing")
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
