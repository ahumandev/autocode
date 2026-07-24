import { describe, expect, mock, test } from "bun:test"
import { spawn as nodeSpawn } from "node:child_process"
import type { Dirent } from "node:fs"
import { cp, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { archiveJobSandboxesForShelvedJob, assertSafeSandboxDeletionPath, assertSafeSandboxPath, cleanupExpiredSandboxCacheEntries, cleanupJobSandboxes, createSandboxAlias, deleteSandboxPath, detectEffectiveSandboxSyncMethod, detectSandboxBackend, ensureSandboxRootfsCache, getJobSandboxRoot, getNamedSandboxPath, getSandboxPaths, materializeSandboxRootfs, normalizeDistro, normalizeOptionalDistro, normalizeSandboxName, resolveSandboxCachePath, resolveSandboxJob, type SandboxCacheEntry, type SandboxDependencies } from "./sandbox"
import { copyPath, resolveSafeRelativePath, validateSafeWriteTarget } from "./sandbox_file_tools"

function missingError(): NodeJS.ErrnoException {
    const error = new Error("missing") as NodeJS.ErrnoException
    error.code = "ENOENT"
    return error
}

function dirent(name: string, directory = true): Dirent {
    return { name, isDirectory: () => directory, isFile: () => !directory } as Dirent
}

function createDeps(options?: { platform?: NodeJS.Platform, arch?: string, env?: NodeJS.ProcessEnv, commands?: Record<string, boolean>, files?: Record<string, string>, existing?: string[], spawnExit?: number, fetchOk?: boolean, fetch?: SandboxDependencies["fetch"], tarCreatesBinSh?: boolean }): SandboxDependencies {
    const existing = new Set(options?.existing ?? [])
    const files = { ...(options?.files ?? {}) }
    return {
        fileSystem: {
            mkdir: mock(async (filePath: string): Promise<string | undefined> => {
                existing.add(filePath)
                return undefined
            }),
            readFile: mock(async (filePath: string) => {
                if (filePath in files) return files[filePath]
                throw missingError()
            }),
            readdir: mock(async () => []),
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
            if (command === "tar" && options?.tarCreatesBinSh !== false) {
                const directory = args.find((arg) => arg.startsWith("--directory="))?.slice("--directory=".length)
                if (directory) existing.add(path.join(directory, "bin", "sh"))
            }
            return { exitCode: options?.spawnExit ?? 0, stdout: "", stderr: "" }
        }),
        commandExists: mock(async (command: string) => Boolean(options?.commands?.[command])),
        fetch: options?.fetch ?? mock(async () => ({ ok: options?.fetchOk ?? true, status: options?.fetchOk === false ? 500 : 200, text: async () => alpineLatestReleasesYaml(), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as Response)),
        process: { platform: options?.platform ?? "linux", arch: options?.arch ?? "arm64", env: options?.env ?? {} },
    }
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
  sha512: x86-sha512
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

function getMetadataWrite(deps: SandboxDependencies, metadataFile: string): Record<string, unknown> {
    const writeFile = deps.fileSystem.writeFile as ReturnType<typeof mock>
    const call = writeFile.mock.calls.find((candidate) => candidate[0] === metadataFile)
    return JSON.parse(call?.[1] as string) as Record<string, unknown>
}

function createClient(title: string): OpencodeClient {
    return { session: { get: mock(async () => ({ data: { title } })) } } as unknown as OpencodeClient
}

async function runCommand(command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv, cwd?: string }): Promise<{ exitCode: number | null, stdout: string, stderr: string }> {
    return await new Promise((resolve, reject) => {
        const child = nodeSpawn(command, [...args], { env: options?.env, cwd: options?.cwd })
        let stdout = ""
        let stderr = ""
        child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
        child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
        child.on("error", reject)
        child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }))
    })
}

describe("sandbox utils", () => {
    test("normalizes sandbox names", () => {
        expect(normalizeSandboxName(" sandbox_123 ")).toEqual({ ok: true, value: "sandbox_123" })

        for (const value of [undefined, 1, "", "   ", "Upper", "has-hyphen", "../escape", "a/b"] as unknown[]) {
            expect(normalizeSandboxName(value).ok).toBe(false)
        }
    })

    test("normalizes distro allowlist", () => {
        expect(normalizeDistro(" Alpine ")).toEqual({ ok: true, value: "alpine" })
        expect(normalizeDistro("DEBIAN")).toEqual({ ok: true, value: "debian" })
        expect(normalizeOptionalDistro(undefined)).toEqual({ ok: true, value: undefined })
        expect(normalizeOptionalDistro("  ")).toEqual({ ok: true, value: undefined })
        expect(normalizeDistro("fedora").ok).toBe(false)
    })

    test("resolves global distro cache path with home default and override", () => {
        expect(resolveSandboxCachePath(undefined, createDeps({ env: { HOME: "/home/user" } }))).toBe("/home/user/.cache/autocode/distros")
        expect(resolveSandboxCachePath({ distro_cache_path: "~/.custom/autocode-distros" }, createDeps({ env: { HOME: "/home/user" } }))).toBe("/home/user/.custom/autocode-distros")
        expect(resolveSandboxCachePath({ distro_cache_path: "/shared/cache" }, createDeps())).toBe("/shared/cache")
    })

    test("detects requested sync methods and conservative auto fallback", async () => {
        const reflinkDeps = createDeps()
        const copyDeps = createDeps({ spawnExit: 1 })

        expect(await detectEffectiveSandboxSyncMethod({ sync_method: "copy" }, reflinkDeps)).toBe("copy")
        expect(await detectEffectiveSandboxSyncMethod({ sync_method: "reflink" }, reflinkDeps)).toBe("reflink")
        expect(await detectEffectiveSandboxSyncMethod({ sync_method: "overlayfs" }, reflinkDeps)).toBe("copy")
        expect(await detectEffectiveSandboxSyncMethod({ sync_method: "auto" }, reflinkDeps)).toBe("reflink")
        expect(await detectEffectiveSandboxSyncMethod(undefined, copyDeps)).toBe("copy")
    })

    test("rootfs materialization copies broken symlinks without dereferencing targets", async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), "autocode-rootfs-copy-"))
        const cacheRootfs = path.join(tempRoot, "cache", "rootfs")
        const destinationRootfs = path.join(tempRoot, "sandbox", "rootfs")
        try {
            await mkdir(path.join(cacheRootfs, "etc"), { recursive: true })
            await symlink("/proc/self/mounts", path.join(cacheRootfs, "etc", "mtab"))
            const deps = createDeps()
            deps.spawn = runCommand
            deps.fileSystem = { ...deps.fileSystem, mkdir, rm, stat, lstat, cp }

            await materializeSandboxRootfs(cacheRootfs, destinationRootfs, "copy", deps)

            expect((await lstat(path.join(destinationRootfs, "etc", "mtab"))).isSymbolicLink()).toBe(true)
        }
        finally {
            await rm(tempRoot, { recursive: true, force: true })
        }
    })

    test("rootfs materialization copies rootfs contents without nesting rootfs directory", async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), "autocode-rootfs-copy-"))
        const cacheRootfs = path.join(tempRoot, "cache", "rootfs")
        const destinationRootfs = path.join(tempRoot, "sandbox", "rootfs")
        try {
            await mkdir(path.join(cacheRootfs, "bin"), { recursive: true })
            await writeFile(path.join(cacheRootfs, "bin", "busybox"), "busybox")
            const deps = createDeps()
            deps.spawn = runCommand
            deps.fileSystem = { ...deps.fileSystem, mkdir, rm, stat, lstat, cp }

            await materializeSandboxRootfs(cacheRootfs, destinationRootfs, "copy", deps)

            expect((await stat(path.join(destinationRootfs, "bin", "busybox"))).isFile()).toBe(true)
            let nestedRootfsExists = true
            try {
                await lstat(path.join(destinationRootfs, "rootfs", "bin", "busybox"))
            }
            catch {
                nestedRootfsExists = false
            }
            expect(nestedRootfsExists).toBe(false)
        }
        finally {
            await rm(tempRoot, { recursive: true, force: true })
        }
    })

    test("rootfs cache downloads versioned entries and reuses them across projects", async () => {
        const deps = createDeps({ env: { HOME: "/home/user" }, arch: "x64", commands: { xz: true } })

        const first = await ensureSandboxRootfsCache("debian", undefined, deps)
        const metadataFile = first.ok ? first.cache.metadata_file : ""
        const second = await ensureSandboxRootfsCache("debian", undefined, deps)

        expect(first).toEqual(expect.objectContaining({ ok: true, downloaded: true }))
        expect(second).toEqual(expect.objectContaining({ ok: true, downloaded: false }))
        if (first.ok && second.ok) {
            expect(first.cache.entry_path).toBe(second.cache.entry_path)
            expect(first.cache.entry_path).toContain("/home/user/.cache/autocode/distros/debian/x86_64/debian-x86_64-bookworm-xz-")
            expect(first.cache.version).toBe("bookworm")
        }
        expect(deps.fetch).toHaveBeenCalledTimes(1)
        expect(deps.fileSystem.writeFile).toHaveBeenCalledWith(metadataFile, expect.stringContaining('"version": "bookworm"'))
    })

    test("alpine rootfs cache resolves versioned minirootfs metadata for process architecture", async () => {
        const metadataUrl = "https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/x86_64/latest-releases.yaml"
        const versionedUrl = "https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/x86_64/alpine-minirootfs-3.24.0-x86_64.tar.gz"
        const versionlessUrl = "alpine-minirootfs-latest-x86_64.tar.gz"
        const fetch = mock(async (url: string) => {
            if (url === metadataUrl) return { ok: true, status: 200, text: async () => alpineLatestReleasesYaml() } as Response
            return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([4, 5, 6]).buffer } as Response
        })
        const deps = createDeps({ env: { HOME: "/home/user" }, arch: "x64", fetch })

        const result = await ensureSandboxRootfsCache("alpine", undefined, deps)

        expect(result).toEqual(expect.objectContaining({ ok: true, downloaded: true }))
        expect(fetch).toHaveBeenCalledWith(metadataUrl)
        expect(fetch).toHaveBeenCalledWith(versionedUrl)
        expect(fetch).toHaveBeenCalledTimes(2)
        if (result.ok) {
            const metadata = getMetadataWrite(deps, result.cache.metadata_file)
            const serializedMetadata = JSON.stringify(metadata)
            expect(metadata).toEqual(expect.objectContaining({ architecture: "x86_64", version: "3.24.0", source_url: versionedUrl, verification: expect.objectContaining({ sha256: "x86-sha256", sha512: "x86-sha512", source_url_sha256: expect.any(String) }) }))
            expect(String(metadata.entry_path)).toContain("/alpine/x86_64/alpine-x86_64-3.24.0-gzip-")
            expect(serializedMetadata).not.toContain(versionlessUrl)
            expect(serializedMetadata).not.toMatch(/alpine-minirootfs-(latest|x86_64)\.tar\.gz/)
        }
        const fetchCalls = JSON.stringify(fetch.mock.calls)
        expect(fetchCalls).not.toContain(versionlessUrl)
        expect(fetchCalls).not.toMatch(/alpine-minirootfs-(latest|x86_64)\.tar\.gz/)
    })

    test("alpine rootfs cache metadata failure is structured", async () => {
        const metadataUrl = "https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/x86_64/latest-releases.yaml"
        const fetch = mock(async () => ({ ok: false, status: 503, text: async () => "" } as Response))
        const deps = createDeps({ env: { HOME: "/home/user" }, arch: "x64", fetch })

        const result = await ensureSandboxRootfsCache("alpine", undefined, deps)

        expect(result).toEqual({ ok: false, status: "503", reason: `Alpine rootfs metadata fetch failed for ${metadataUrl} with HTTP 503.`, source_url: metadataUrl })
        expect(fetch).toHaveBeenCalledWith(metadataUrl)
        expect(fetch).toHaveBeenCalledTimes(1)
        expect(deps.fileSystem.writeFile).not.toHaveBeenCalled()
    })

    test("rootfs cache reports source URL on rootfs download failure", async () => {
        const deps = createDeps({ env: { HOME: "/home/user" }, arch: "x64", fetchOk: false })

        const result = await ensureSandboxRootfsCache("debian", undefined, deps)

        expect(result).toEqual(expect.objectContaining({ ok: false, status: "500", source_url: "https://raw.githubusercontent.com/debuerreotype/docker-debian-artifacts/dist-amd64/bookworm/rootfs.tar.xz", reason: expect.stringContaining("rootfs.tar.xz") }))
    })

    test("rootfs extraction puts tar options before file operand", async () => {
        const deps = createDeps({ env: { HOME: "/home/user" }, arch: "x64", commands: { zstd: true } })

        await ensureSandboxRootfsCache("archlinux", undefined, deps)

        const tarCall = (deps.spawn as ReturnType<typeof mock>).mock.calls.find((call) => call[0] === "tar")
        const tarArgs = tarCall?.[1] as string[]
        expect(tarArgs).toEqual(expect.arrayContaining(["--extract", "--zstd", "--strip-components=1"]))
        expect(tarArgs.indexOf("--strip-components=1")).toBeLessThan(tarArgs.findIndex((arg) => arg.startsWith("--file=")))
        expect(tarArgs.find((arg) => arg.startsWith("--file="))).toContain("rootfs.tar.zstd")
        expect(tarArgs.find((arg) => arg.startsWith("--directory="))).toContain("/rootfs")
    })

    test("alpine rootfs extraction does not strip archive paths", async () => {
        const deps = createDeps({ env: { HOME: "/home/user" }, arch: "x64" })

        await ensureSandboxRootfsCache("alpine", undefined, deps)

        const tarCall = (deps.spawn as ReturnType<typeof mock>).mock.calls.find((call) => call[0] === "tar")
        const tarArgs = tarCall?.[1] as string[]
        expect(tarArgs).toEqual(expect.arrayContaining(["--extract", "--gzip"]))
        expect(tarArgs).not.toContain("--strip-components=1")
        expect(tarArgs.some((arg) => arg.startsWith("--strip-components="))).toBe(false)
    })

    test("rootfs extraction accepts /bin/sh symlink without following it", async () => {
        const deps = createDeps({ env: { HOME: "/home/user" }, arch: "x64" })
        const originalStat = deps.fileSystem.stat
        const binShPath = path.join("rootfs", "bin", "sh")
        deps.fileSystem.stat = mock(async (filePath: string) => {
            if (filePath.endsWith(binShPath)) throw missingError()
            return originalStat(filePath)
        })

        const result = await ensureSandboxRootfsCache("alpine", undefined, deps)

        expect(result).toEqual(expect.objectContaining({ ok: true }))
        expect(deps.fileSystem.lstat).toHaveBeenCalledWith(expect.stringContaining(binShPath))
    })

    test("rootfs extraction reports malformed rootfs before cache metadata", async () => {
        const deps = createDeps({ env: { HOME: "/home/user" }, arch: "x64", commands: { xz: true }, tarCreatesBinSh: false })

        const result = await ensureSandboxRootfsCache("debian", undefined, deps)

        expect(result).toEqual(expect.objectContaining({ ok: false, source_url: "https://raw.githubusercontent.com/debuerreotype/docker-debian-artifacts/dist-amd64/bookworm/rootfs.tar.xz", reason: expect.stringContaining("missing /bin/sh") }))
        expect(deps.fileSystem.writeFile).not.toHaveBeenCalledWith(expect.stringContaining("metadata.json"), expect.any(String))
    })

    test("rootfs extraction reports missing zstd before tar", async () => {
        const deps = createDeps({ env: { HOME: "/home/user" }, arch: "x64", commands: { zstd: false } })

        const result = await ensureSandboxRootfsCache("archlinux", undefined, deps)

        expect(result).toEqual(expect.objectContaining({ ok: false, source_url: "https://geo.mirror.pkgbuild.com/iso/latest/archlinux-bootstrap-x86_64.tar.zst", reason: "Missing host dependency zstd required to extract zstd rootfs archive; rootfs download already succeeded." }))
        expect(deps.fetch).toHaveBeenCalledTimes(1)
        expect(deps.fileSystem.writeFile).toHaveBeenCalledWith(expect.stringContaining("rootfs.tar.zstd"), expect.any(Uint8Array))
        expect((deps.spawn as ReturnType<typeof mock>).mock.calls.find((call) => call[0] === "tar")).toBeUndefined()
    })

    test("cache cleanup expires copy entries and protects metadata references", async () => {
        const cache: SandboxCacheEntry = {
            entry_path: "/cache/alpine/aarch64/current",
            rootfs_path: "/cache/alpine/aarch64/current/rootfs",
            metadata_file: "/cache/alpine/aarch64/current/metadata.json",
            source_url: "https://example.invalid/rootfs.tar.gz",
            archive_format: "gzip",
            created_at: new Date().toISOString(),
            verified_at: new Date().toISOString(),
            version: "latest-stable",
            architecture: "aarch64",
            verification: {},
        }
        const oldCache = { ...cache, entry_path: "/cache/alpine/aarch64/old", rootfs_path: "/cache/alpine/aarch64/old/rootfs", metadata_file: "/cache/alpine/aarch64/old/metadata.json", created_at: "2020-01-01T00:00:00.000Z" }
        const referencedCache = { ...oldCache, entry_path: "/cache/alpine/aarch64/referenced", rootfs_path: "/cache/alpine/aarch64/referenced/rootfs", metadata_file: "/cache/alpine/aarch64/referenced/metadata.json" }
        const deps = createDeps({
            existing: ["/repo/.agents/sandboxes/job/dev"],
            files: {
                [oldCache.metadata_file]: JSON.stringify(oldCache),
                [referencedCache.metadata_file]: JSON.stringify(referencedCache),
                "/repo/.agents/sandboxes/job/dev/sandbox.json": JSON.stringify({ sandbox_name: "dev", job_name: "job", distro: "alpine", backend: "bubblewrap", root_path: "/repo/.agents/sandboxes/job/dev", backend_data: { cache_entry_path: referencedCache.entry_path } }),
            },
        })
        deps.fileSystem.readdir = mock(async (dirPath: string, options?: { withFileTypes?: boolean }) => {
            if (dirPath === "/cache/alpine/aarch64" && options?.withFileTypes) return [dirent("current"), dirent("old"), dirent("referenced")]
            if (dirPath === "/repo/.agents/sandboxes" && options?.withFileTypes) return [dirent("job")]
            if (dirPath === "/repo/.agents/sandboxes/job" && options?.withFileTypes) return [dirent("dev")]
            return []
        })

        await cleanupExpiredSandboxCacheEntries(cache, "/repo", undefined, "copy", deps)
        await cleanupExpiredSandboxCacheEntries(cache, "/repo", undefined, "reflink", deps)

        expect(deps.fileSystem.rm).toHaveBeenCalledWith(oldCache.entry_path, { recursive: true, force: true })
        expect(deps.fileSystem.rm).not.toHaveBeenCalledWith(referencedCache.entry_path, expect.any(Object))
        expect(deps.fileSystem.rm).not.toHaveBeenCalledWith(cache.entry_path, expect.any(Object))
    })

    test("builds sandbox paths under .agents/sandboxes", () => {
        const paths = getSandboxPaths("/repo", "my_job", "dev")

        expect(paths.sandboxesRoot).toBe("/repo/.agents/sandboxes")
        expect(paths.jobSandboxRoot).toBe("/repo/.agents/sandboxes/my_job")
        expect(paths.sandboxPath).toBe("/repo/.agents/sandboxes/my_job/dev")
        expect(getJobSandboxRoot("/repo", "my_job")).toBe("/repo/.agents/sandboxes/my_job")
        expect(getNamedSandboxPath("/repo", "my_job", "dev")).toBe("/repo/.agents/sandboxes/my_job/dev")
        expect(paths.sandboxPath).not.toContain(".agents/jobs")
    })

    test("guards sandbox paths and deletion targets", () => {
        const root = "/repo/.agents/sandboxes/my_job"

        expect(assertSafeSandboxPath(`${root}/dev`, root).ok).toBe(true)
        expect(assertSafeSandboxDeletionPath(`${root}/dev`, "/repo", root).ok).toBe(true)
        for (const unsafe of [`${root}/../other`, "/repo/outside", root, "/repo/.agents", "/repo/.agents/sandboxes"]) {
            expect(assertSafeSandboxDeletionPath(unsafe, "/repo", root).ok).toBe(false)
        }
    })

    test("detects strict bubblewrap backend from injected dependencies", async () => {
        expect((await detectSandboxBackend(createDeps({ platform: "darwin" }))).backend).toBe("macos_unsupported")

        const bubblewrapDeps = createDeps({ commands: { bwrap: true }, existing: ["/bin", "/usr"] })
        const bubblewrap = await detectSandboxBackend(bubblewrapDeps)
        expect(bubblewrap.backend).toBe("bubblewrap")
        expect(bubblewrapDeps.spawn).toHaveBeenCalledWith("bwrap", expect.arrayContaining(["--die-with-parent", "--unshare-all", "--new-session", "--proc", "/proc", "/bin/sh", "-lc", "true"]), expect.any(Object))
        const probeArgs = (bubblewrapDeps.spawn as ReturnType<typeof mock>).mock.calls[0]?.[1] as string[]
        expect(probeArgs).toEqual(expect.arrayContaining(["--proc", "/proc", "--ro-bind", "/bin", "/bin", "--ro-bind", "/usr", "/usr"]))

        const prootOnly = await detectSandboxBackend(createDeps({ commands: { "proot-distro": true, proot: true } }))
        expect(prootOnly.backend).toBe("unsupported")
        expect(prootOnly.guidance).toContain("bubblewrap (bwrap)")
        expect(prootOnly.guidance).toContain("proot and proot-distro are not supported fallbacks")

        const failedProbe = await detectSandboxBackend(createDeps({ commands: { bwrap: true }, spawnExit: 1 }))
        expect(failedProbe.backend).toBe("unsupported")

        const termux = await detectSandboxBackend(createDeps({ env: { TERMUX_VERSION: "1" }, commands: { bwrap: true } }))
        expect(termux.backend).toBe("unsupported")
        expect(termux.reason).toContain("Termux")
    })

    test("reports unsupported when bubblewrap probe fails", async () => {
        const deps = createDeps({ commands: { bwrap: true } })
        deps.spawn = mock(async () => ({ exitCode: 1, stdout: "", stderr: "failed" }))

        const result = await detectSandboxBackend(deps)

        expect(result.backend).toBe("unsupported")
        expect(result.reason).toContain("usable bwrap")
    })

    test("creates deterministic bounded aliases", () => {
        const alias = createSandboxAlias("my_job", "sandbox_with_long_name_that_gets_trimmed")

        expect(alias).toBe(createSandboxAlias("my_job", "sandbox_with_long_name_that_gets_trimmed"))
        expect(alias).toContain("sandbox")
        expect(alias.length).toBeLessThanOrEqual(48)
    })

    test("resolves title-derived sandbox job without lifecycle directories", async () => {
        const result = await resolveSandboxJob(createClient("My Feature"), { sessionID: "session-1", directory: "/repo", worktree: "/repo" }, createDeps().fileSystem)

        expect(result).toEqual({ ok: true, storageRoot: "/repo", jobName: "my_feature" })
    })

    test("fails sandbox job resolution without usable title or job name", async () => {
        const result = await resolveSandboxJob(undefined, { sessionID: "session-1", directory: "/repo", worktree: "/repo" }, createDeps().fileSystem)

        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.identity.resolution).toBe("title_unavailable")
            expect(result.identity.job_name).toBeUndefined()
        }
    })

    test("deletes sandbox paths safely and warns for legacy metadata", async () => {
        const paths = getSandboxPaths("/repo", "my_job", "dev")
        const deps = createDeps({ existing: [paths.sandboxPath], commands: { "proot-distro": true }, files: { [paths.metadataFile]: JSON.stringify({ sandbox_name: "dev", job_name: "my_job", distro: "alpine", backend: "termux_proot_distro", root_path: paths.sandboxPath, backend_data: { alias: createSandboxAlias("my_job", "dev") } }) } })

        expect(await deleteSandboxPath(paths, deps)).toEqual({ sandbox_name: "dev", status: "warning", warning: expect.stringContaining("Recreate the sandbox under bubblewrap") })
        expect(deps.spawn).not.toHaveBeenCalled()
        expect(await deleteSandboxPath(paths, deps)).toEqual({ sandbox_name: "dev", status: "missing" })
    })

    test("cleans only valid named sandbox children", async () => {
        const deps = createDeps({ existing: ["/repo/.agents/sandboxes/my_job/dev"] })
        deps.fileSystem.stat = mock(async (filePath: string) => filePath === "/repo/.agents/sandboxes/my_job" || filePath.endsWith("/dev") ? { mtimeMs: 1 } : Promise.reject(missingError()))
        deps.fileSystem.readdir = mock(async () => [dirent("dev"), dirent("bad-name")])

        const result = await cleanupJobSandboxes("/repo", "my_job", deps)

        expect(result.items.map((item) => item.sandbox_name)).toEqual(["dev", "bad-name"])
        expect(deps.fileSystem.rm).toHaveBeenCalledWith("/repo/.agents/sandboxes/my_job/dev", { recursive: true, force: true })
        expect(deps.fileSystem.rm).not.toHaveBeenCalledWith("/repo/.agents/sandboxes/my_job", { recursive: true, force: true })
    })

    test("cleans job sandbox root after deleting all sandbox children", async () => {
        const paths = getSandboxPaths("/repo", "my_job", "dev")
        const deps = createDeps({ existing: [paths.jobSandboxRoot, paths.sandboxPath] })
        let remainingEntries = [dirent("dev")]
        deps.fileSystem.readdir = mock(async (filePath: string) => {
            if (filePath !== paths.jobSandboxRoot) return []
            const entries = remainingEntries
            remainingEntries = []
            return entries
        })

        const result = await cleanupJobSandboxes("/repo", "my_job", deps)

        expect(result).toEqual(expect.objectContaining({ status: "deleted", deleted: 1 }))
        expect(deps.fileSystem.rm).toHaveBeenCalledWith(paths.sandboxPath, { recursive: true, force: true })
        expect(deps.fileSystem.rm).toHaveBeenCalledWith(paths.jobSandboxRoot, { recursive: true, force: true })
    })

    test("archives job sandboxes into shelved job directory", async () => {
        const deps = createDeps({ existing: ["/repo/.agents/sandboxes/my_job", "/repo/.agents/sandboxes/my_job/dev", "/repo/.agents/sandboxes/my_job/other"] })
        deps.fileSystem.readdir = mock(async (filePath: string, options?: { withFileTypes?: boolean }) => filePath === "/repo/.agents/sandboxes/my_job" && options?.withFileTypes ? [dirent("dev"), dirent("other"), dirent("note.txt", false)] : [])
        deps.fileSystem.stat = mock(async (filePath: string) => filePath === "/repo/.agents/jobs/shelved/my_job/sandboxes/dev" || filePath === "/repo/.agents/jobs/shelved/my_job/sandboxes/other" ? Promise.reject(missingError()) : { mtimeMs: 1 })

        const result = await archiveJobSandboxesForShelvedJob("/repo", "my_job", "/repo/.agents/jobs/shelved/my_job", deps)

        expect(result).toEqual(expect.objectContaining({ ok: true, status: "archived", job_name: "my_job", archived: 2 }))
        expect(deps.fileSystem.mkdir).toHaveBeenCalledWith("/repo/.agents/jobs/shelved/my_job/sandboxes", { recursive: true })
        expect(deps.fileSystem.rename).toHaveBeenCalledWith("/repo/.agents/sandboxes/my_job/dev", "/repo/.agents/jobs/shelved/my_job/sandboxes/dev")
        expect(deps.fileSystem.rename).toHaveBeenCalledWith("/repo/.agents/sandboxes/my_job/other", "/repo/.agents/jobs/shelved/my_job/sandboxes/other")
    })

    test("does not create shelved sandbox archive directory when root is missing or empty", async () => {
        const missingDeps = createDeps()
        const emptyDeps = createDeps({ existing: ["/repo/.agents/sandboxes/my_job"] })
        emptyDeps.fileSystem.readdir = mock(async () => [])

        expect(await archiveJobSandboxesForShelvedJob("/repo", "my_job", "/repo/.agents/jobs/shelved/my_job", missingDeps)).toEqual({ ok: true, status: "missing", job_name: "my_job", archived: 0, items: [] })
        expect(await archiveJobSandboxesForShelvedJob("/repo", "my_job", "/repo/.agents/jobs/shelved/my_job", emptyDeps)).toEqual({ ok: true, status: "empty", job_name: "my_job", archived: 0, items: [] })
        expect(missingDeps.fileSystem.mkdir).not.toHaveBeenCalledWith("/repo/.agents/jobs/shelved/my_job/sandboxes", expect.any(Object))
        expect(emptyDeps.fileSystem.mkdir).not.toHaveBeenCalledWith("/repo/.agents/jobs/shelved/my_job/sandboxes", expect.any(Object))
    })

    test("sandbox archive collision does not overwrite destination", async () => {
        const deps = createDeps({ existing: ["/repo/.agents/sandboxes/my_job", "/repo/.agents/sandboxes/my_job/dev", "/repo/.agents/jobs/shelved/my_job/sandboxes/dev"] })
        deps.fileSystem.readdir = mock(async (filePath: string, options?: { withFileTypes?: boolean }) => filePath === "/repo/.agents/sandboxes/my_job" && options?.withFileTypes ? [dirent("dev")] : [])

        const result = await archiveJobSandboxesForShelvedJob("/repo", "my_job", "/repo/.agents/jobs/shelved/my_job", deps)

        expect(result).toEqual({ ok: false, status: "collision", job_name: "my_job", collision_path: "/repo/.agents/jobs/shelved/my_job/sandboxes/dev", collision_name: "dev", reason: "Sandbox archive destination already exists: /repo/.agents/jobs/shelved/my_job/sandboxes/dev" })
        expect(deps.fileSystem.rename).not.toHaveBeenCalled()
    })

    test("file tool path guards reject malformed roots and symlink escapes", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "autocode-sandbox-utils-"))
        const outside = await mkdtemp(path.join(tmpdir(), "autocode-sandbox-outside-"))
        try {
            await mkdir(path.join(root, "dir"), { recursive: true })
            await writeFile(path.join(root, "dir/file.txt"), "safe")
            await writeFile(path.join(outside, "escape.txt"), "escape")
            await symlink(path.join(outside, "escape.txt"), path.join(root, "escape"))
            await symlink(outside, path.join(root, "escape_dir"))

            for (const value of ["", "bad\0path", "/absolute", "../escape", "workspace/file"]) {
                expect((await resolveSafeRelativePath(root, value, "path", true, true)).ok).toBe(false)
                expect((await validateSafeWriteTarget(root, value, "target", true)).ok).toBe(false)
            }

            expect(await resolveSafeRelativePath(root, "dir/file.txt", "path", true, true)).toEqual({ ok: true, value: { absolutePath: path.join(root, "dir/file.txt"), relativePath: "dir/file.txt" } })
            expect((await resolveSafeRelativePath(root, "escape", "path", true, true)).ok).toBe(false)
            expect((await validateSafeWriteTarget(root, "escape_dir/file.txt", "target", true)).ok).toBe(false)
        }
        finally {
            await rm(root, { recursive: true, force: true })
            await rm(outside, { recursive: true, force: true })
        }
    })

    test("copyPath recursively copies files and directories with overwrite and merge semantics", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "autocode-sandbox-copy-"))
        try {
            await mkdir(path.join(root, "source_dir"), { recursive: true })
            await mkdir(path.join(root, "target_dir"), { recursive: true })
            await writeFile(path.join(root, "source.txt"), "source")
            await writeFile(path.join(root, "target.txt"), "old")
            await writeFile(path.join(root, "source_dir/a.txt"), "a")
            await writeFile(path.join(root, "target_dir/a.txt"), "old-a")
            await writeFile(path.join(root, "target_dir/b.txt"), "b")

            await copyPath(path.join(root, "source.txt"), path.join(root, "target.txt"))
            await copyPath(path.join(root, "source_dir"), path.join(root, "target_dir"))

            expect(await readFile(path.join(root, "target.txt"), "utf8")).toBe("source")
            expect(await readFile(path.join(root, "target_dir/a.txt"), "utf8")).toBe("a")
            expect(await readFile(path.join(root, "target_dir/b.txt"), "utf8")).toBe("b")
        }
        finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})
