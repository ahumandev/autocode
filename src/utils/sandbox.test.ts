import { describe, expect, mock, test } from "bun:test"
import { spawn as nodeSpawn } from "node:child_process"
import type { Dirent } from "node:fs"
import { cp, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { assertDirectSandboxPath, assertSafeSandboxDeletionPath, assertSafeSandboxPath, cleanupEmptyJobSandboxRoot, cleanupExpiredSandboxCacheEntries, cleanupJobSandboxes, deleteSandboxPath, detectEffectiveSandboxSyncMethod, detectSandboxBackend, ensureSandboxRootfsCache, materializeSandboxRootfs, normalizeDistro, normalizeOptionalDistro, normalizeSandboxName, resolveSandboxCachePath, resolveSandboxOwner, type SandboxCacheEntry, type SandboxDependencies, type SandboxOwner, type SandboxPaths } from "./sandbox"
import { resolveJobWorkspaceIdentity } from "./jobs"
import { copyPath, resolveSafeRelativePath, validateSafeWriteTarget } from "./sandbox_file_tools"

function missingError(): NodeJS.ErrnoException {
    const error = new Error("missing") as NodeJS.ErrnoException
    error.code = "ENOENT"
    return error
}

function dirent(name: string, directory = true): Dirent {
    return { name, isDirectory: () => directory, isFile: () => !directory } as Dirent
}

function createDeps(options?: { platform?: NodeJS.Platform, arch?: string, env?: NodeJS.ProcessEnv, commands?: Record<string, boolean>, files?: Record<string, string>, existing?: string[], spawnExit?: number, spawnResults?: Partial<Record<"skopeo" | "umoci", Partial<{ exitCode: number | null, stdout: string, stderr: string }>>>, fetchOk?: boolean, fetch?: SandboxDependencies["fetch"], tarCreatesBinSh?: boolean, umociCreatesBinSh?: boolean }): SandboxDependencies {
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
            rename: mock(async (source: string, destination: string) => {
                for (const entry of [...existing]) {
                    if (entry !== source && !entry.startsWith(`${source}${path.sep}`)) continue
                    existing.delete(entry)
                    existing.add(`${destination}${entry.slice(source.length)}`)
                }
                for (const [filePath, content] of Object.entries(files)) {
                    if (filePath !== source && !filePath.startsWith(`${source}${path.sep}`)) continue
                    delete files[filePath]
                    files[`${destination}${filePath.slice(source.length)}`] = content
                }
            }),
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
            const result = command === "skopeo" || command === "umoci" ? options?.spawnResults?.[command] : undefined
            const exitCode = result?.exitCode ?? options?.spawnExit ?? 0
            if (command === "tar" && options?.tarCreatesBinSh !== false) {
                const directory = args.find((arg) => arg.startsWith("--directory="))?.slice("--directory=".length)
                if (directory) existing.add(path.join(directory, "bin", "sh"))
            }
            if (command === "umoci" && exitCode === 0) {
                const bundlePath = args[args.length - 1]
                if (bundlePath && options?.umociCreatesBinSh !== false) {
                    existing.add(path.join(bundlePath, "rootfs"))
                    existing.add(path.join(bundlePath, "rootfs", "bin", "sh"))
                }
            }
            return { exitCode, stdout: result?.stdout ?? "", stderr: result?.stderr ?? "" }
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

function createSandboxOwner(storageRoot: string, jobName: string, workspaceName = `2026-08-20_10-30-00_${jobName}`): SandboxOwner {
    const workspacePath = path.join(storageRoot, ".agents", "jobs", workspaceName)
    return {
        storageRoot,
        workspace: {
            job_name: jobName,
            job_path: `.agents/jobs/${workspaceName}/`,
            absolute_path: workspacePath,
        },
        jobName,
        workspacePath,
        jobSandboxRoot: path.join(workspacePath, "sandboxes"),
    }
}

function createSandboxPaths(storageRoot: string, jobName: string, sandboxName: string, workspaceName?: string): SandboxPaths {
    const owner = createSandboxOwner(storageRoot, jobName, workspaceName)
    const sandboxPath = path.join(owner.jobSandboxRoot, sandboxName)
    return { ...owner, sandboxName, sandboxPath, metadataFile: path.join(sandboxPath, "sandbox.json") }
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

    test("Debian OCI rootfs cache pulls, unpacks, and reuses Bookworm entries", async () => {
        const deps = createDeps({ env: { HOME: "/home/user" }, arch: "x64", commands: { skopeo: true, umoci: true } })

        const first = await ensureSandboxRootfsCache("debian", undefined, deps)
        const second = await ensureSandboxRootfsCache("debian", undefined, deps)

        expect(first).toEqual(expect.objectContaining({ ok: true, downloaded: true }))
        expect(second).toEqual(expect.objectContaining({ ok: true, downloaded: false }))
        if (first.ok && second.ok) {
            expect(first.cache.entry_path).toBe(second.cache.entry_path)
            expect(first.cache.entry_path).toContain("/home/user/.cache/autocode/distros/debian/x86_64/debian-x86_64-bookworm-oci-")
            expect(first.cache.version).toBe("bookworm")
            expect(first.cache.archive_format).toBe("oci")
            expect(deps.fileSystem.rename).toHaveBeenCalledWith(expect.stringMatching(/\/debian\/x86_64\/debian-x86_64-bookworm-oci-[^/]+\.tmp-[^/]+$/), first.cache.entry_path)
        }
        expect(deps.spawn).toHaveBeenCalledWith("skopeo", expect.arrayContaining(["copy", "--override-os", "linux", "--override-arch", "amd64", "docker://docker.io/library/debian:bookworm"]), expect.any(Object))
        expect(deps.spawn).toHaveBeenCalledWith("umoci", ["unpack", "--rootless", "--image", expect.stringMatching(/:bookworm$/), expect.stringMatching(/\/bundle$/)], expect.any(Object))
        expect(deps.fetch).not.toHaveBeenCalled()
        expect(deps.fileSystem.writeFile).toHaveBeenCalledWith(expect.stringMatching(/\/debian\/x86_64\/debian-x86_64-bookworm-oci-[^/]+\.tmp-[^/]+\/metadata\.json$/), expect.stringContaining('"version": "bookworm"'))
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

    test("Debian OCI rootfs cache reports pull errors with image source", async () => {
        const deps = createDeps({ env: { HOME: "/home/user" }, arch: "x64", commands: { skopeo: true, umoci: true }, spawnResults: { skopeo: { exitCode: 1, stdout: "pull output", stderr: "pull failed" } } })

        const result = await ensureSandboxRootfsCache("debian", undefined, deps)

        expect(result).toEqual({ ok: false, reason: "Debian OCI image pull failed.", command: expect.stringContaining("skopeo copy"), stdout: "pull output", stderr: "pull failed", exit_code: 1, source_url: "docker://docker.io/library/debian:bookworm" })
        expect(deps.spawn).toHaveBeenCalledWith("skopeo", expect.arrayContaining(["docker://docker.io/library/debian:bookworm"]), expect.any(Object))
        expect(deps.spawn).not.toHaveBeenCalledWith("umoci", expect.any(Array), expect.any(Object))
        expect(deps.fetch).not.toHaveBeenCalled()
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

    test("Debian OCI unpack reports malformed rootfs before cache metadata", async () => {
        const deps = createDeps({ env: { HOME: "/home/user" }, arch: "x64", commands: { skopeo: true, umoci: true }, umociCreatesBinSh: false })

        const result = await ensureSandboxRootfsCache("debian", undefined, deps)

        expect(result).toEqual(expect.objectContaining({ ok: false, source_url: "docker://docker.io/library/debian:bookworm", reason: "Debian OCI image unpack produced malformed rootfs: missing /bin/sh." }))
        expect(deps.spawn).toHaveBeenCalledWith("skopeo", expect.any(Array), expect.any(Object))
        expect(deps.spawn).toHaveBeenCalledWith("umoci", ["unpack", "--rootless", "--image", expect.stringMatching(/:bookworm$/), expect.stringMatching(/\/bundle$/)], expect.any(Object))
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
        const owner = createSandboxOwner("/repo", "job")
        const sandboxPath = path.join(owner.jobSandboxRoot, "dev")
        const deps = createDeps({
            existing: [sandboxPath],
            files: {
                [oldCache.metadata_file]: JSON.stringify(oldCache),
                [referencedCache.metadata_file]: JSON.stringify(referencedCache),
                [path.join(sandboxPath, "sandbox.json")]: JSON.stringify({ sandbox_name: "dev", job_name: "job", distro: "alpine", backend: "bubblewrap", root_path: sandboxPath, backend_data: { cache_entry_path: referencedCache.entry_path } }),
            },
        })
        deps.fileSystem.readdir = mock(async (dirPath: string, options?: { withFileTypes?: boolean }) => {
            if (dirPath === "/cache/alpine/aarch64" && options?.withFileTypes) return [dirent("current"), dirent("old"), dirent("referenced")]
            if (dirPath === owner.jobSandboxRoot && options?.withFileTypes) return [dirent("dev")]
            return []
        })

        await cleanupExpiredSandboxCacheEntries(cache, owner, undefined, "copy", deps)
        await cleanupExpiredSandboxCacheEntries(cache, owner, undefined, "reflink", deps)

        expect(deps.fileSystem.rm).toHaveBeenCalledWith(oldCache.entry_path, { recursive: true, force: true })
        expect(deps.fileSystem.rm).not.toHaveBeenCalledWith(referencedCache.entry_path, expect.any(Object))
        expect(deps.fileSystem.rm).not.toHaveBeenCalledWith(cache.entry_path, expect.any(Object))
    })

    test("builds sandbox paths under resolved job workspace", async () => {
        const workspaceName = "2026-08-20_10-30-00_my_job"
        const deps = createDeps({
            files: { [`/repo/.agents/jobs/${workspaceName}/session.yml`]: "session_id: session-1\n" },
        })
        deps.fileSystem.readdir = mock(async (dirPath: string) => dirPath === "/repo/.agents/jobs" ? [workspaceName] : [])

        const result = await resolveSandboxOwner(deps.fileSystem, createClient("Other Title"), { sessionID: "session-1", directory: "/repo", worktree: "/repo" }, "dev")

        expect(result).toEqual(expect.objectContaining({ ok: true, owner: expect.objectContaining({
            jobName: "my_job",
            workspacePath: "/repo/.agents/jobs/2026-08-20_10-30-00_my_job",
            jobSandboxRoot: "/repo/.agents/jobs/2026-08-20_10-30-00_my_job/sandboxes",
            sandboxPath: "/repo/.agents/jobs/2026-08-20_10-30-00_my_job/sandboxes/dev",
        }),
        }))
    })

    test("guards sandbox paths and deletion targets", () => {
        const root = "/repo/.agents/jobs/2026-08-20_10-30-00_my_job/sandboxes"

        expect(assertSafeSandboxPath(`${root}/dev`, root).ok).toBe(true)
        expect(assertSafeSandboxDeletionPath(`${root}/dev`, root).ok).toBe(true)
        expect(assertDirectSandboxPath(`${root}/dev/nested`, root).ok).toBe(false)
        for (const unsafe of [`${root}/../other`, "/repo/outside", root, "/repo/.agents", "/repo/.agents/jobs"]) {
            expect(assertSafeSandboxDeletionPath(unsafe, root).ok).toBe(false)
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

    test("exact session-linked sandbox workspace takes precedence over newer title match", async () => {
        const linkedWorkspace = "2026-08-19_10-30-00_my_feature"
        const newerWorkspace = "2026-08-20_10-30-00_my_feature"
        const deps = createDeps({
            files: {
                [`/repo/.agents/jobs/${linkedWorkspace}/session.yml`]: "session_id: session-1\n",
                [`/repo/.agents/jobs/${newerWorkspace}/session.yml`]: "session_id: session-2\n",
            },
        })
        deps.fileSystem.readdir = mock(async (dirPath: string) => dirPath === "/repo/.agents/jobs" ? [newerWorkspace, linkedWorkspace] : [])

        const owner = await resolveSandboxOwner(deps.fileSystem, createClient("My Feature"), { sessionID: "session-1", directory: "/repo", worktree: "/repo" })

        expect(owner).toEqual(expect.objectContaining({ ok: true, owner: expect.objectContaining({ workspacePath: `/repo/.agents/jobs/${linkedWorkspace}` }) }))
    })

    test("sandbox owner selects newest title-matched workspace when session is not linked", async () => {
        const olderWorkspace = "2026-08-19_10-30-00_my_feature"
        const newerWorkspace = "2026-08-20_10-30-00_my_feature"
        const deps = createDeps()
        deps.fileSystem.readdir = mock(async (dirPath: string) => dirPath === "/repo/.agents/jobs" ? [olderWorkspace, newerWorkspace] : [])

        const owner = await resolveSandboxOwner(deps.fileSystem, createClient("My Feature"), { sessionID: "session-1", directory: "/repo", worktree: "/repo" })

        expect(owner).toEqual(expect.objectContaining({ ok: true, owner: expect.objectContaining({ workspacePath: `/repo/.agents/jobs/${newerWorkspace}` }) }))
    })

    test("sandbox owner reports normal resolver error when linked and title workspaces are absent", async () => {
        const workspace = "2026-08-20_10-30-00_my_feature"
        const deps = createDeps()
        deps.fileSystem.readdir = mock(async (dirPath: string) => dirPath === "/repo/.agents/jobs" ? [workspace] : [])
        const context = { sessionID: "session-1", directory: "/repo", worktree: "/repo" }

        const normal = await resolveJobWorkspaceIdentity(deps.fileSystem, createClient("Other Feature"), context)
        const owner = await resolveSandboxOwner(deps.fileSystem, createClient("Other Feature"), context)

        expect(normal).toEqual(expect.objectContaining({ resolution: "missing", job_name: "other_feature" }))
        expect(owner).toEqual({
            ok: false,
            reason: "No timestamped job workspace was found for the current session.",
            jobName: "other_feature",
        })
    })

    test("deletes sandbox paths safely and warns for legacy metadata", async () => {
        const paths = createSandboxPaths("/repo", "my_job", "dev")
        const deps = createDeps({ existing: [paths.sandboxPath], commands: { "proot-distro": true }, files: { [paths.metadataFile]: JSON.stringify({ sandbox_name: "dev", job_name: "my_job", distro: "alpine", backend: "termux_proot_distro", root_path: paths.sandboxPath }) } })

        expect(await deleteSandboxPath(paths, deps)).toEqual({ sandbox_name: "dev", status: "warning", warning: expect.stringContaining("Recreate the sandbox under bubblewrap") })
        expect(deps.spawn).not.toHaveBeenCalled()
        expect(await deleteSandboxPath(paths, deps)).toEqual({ sandbox_name: "dev", status: "missing" })
    })

    test("deletes sandbox directory symlink without deleting external target", async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), "autocode-sandbox-delete-"))
        const paths = createSandboxPaths(tempRoot, "my_job", "dev")
        const externalDirectory = path.join(tempRoot, "external")
        const markerFile = path.join(externalDirectory, "marker.txt")
        try {
            await mkdir(paths.jobSandboxRoot, { recursive: true })
            await mkdir(externalDirectory, { recursive: true })
            await writeFile(markerFile, "unchanged")
            await symlink(externalDirectory, paths.sandboxPath, "dir")
            const deps = createDeps()
            deps.fileSystem = { ...deps.fileSystem, readFile, rm, stat }

            expect(await deleteSandboxPath(paths, deps)).toEqual({ sandbox_name: "dev", status: "deleted" })
            await expect(lstat(paths.sandboxPath)).rejects.toMatchObject({ code: "ENOENT" })
            expect((await stat(externalDirectory)).isDirectory()).toBe(true)
            expect(await readFile(markerFile, "utf8")).toBe("unchanged")
        }
        finally {
            await rm(tempRoot, { recursive: true, force: true })
        }
    })

    test("cleans only valid named sandbox children", async () => {
        const owner = createSandboxOwner("/repo", "my_job")
        const sandboxPath = path.join(owner.jobSandboxRoot, "dev")
        const deps = createDeps({ existing: [sandboxPath] })
        deps.fileSystem.stat = mock(async (filePath: string) => filePath === owner.jobSandboxRoot || filePath === sandboxPath ? { mtimeMs: 1 } : Promise.reject(missingError()))
        deps.fileSystem.readdir = mock(async () => [dirent("dev"), dirent("bad-name")])

        const result = await cleanupJobSandboxes(owner, deps)

        expect(result.items.map((item) => item.sandbox_name)).toEqual(["dev", "bad-name"])
        expect(deps.fileSystem.rm).toHaveBeenCalledWith(sandboxPath, { recursive: true, force: true })
        expect(deps.fileSystem.rm).not.toHaveBeenCalledWith(owner.jobSandboxRoot, { recursive: true, force: true })
    })

    test("cleans job sandbox root after deleting all sandbox children", async () => {
        const paths = createSandboxPaths("/repo", "my_job", "dev")
        const deps = createDeps({ existing: [paths.jobSandboxRoot, paths.sandboxPath] })
        let remainingEntries = [dirent("dev")]
        deps.fileSystem.readdir = mock(async (filePath: string) => {
            if (filePath !== paths.jobSandboxRoot) return []
            const entries = remainingEntries
            remainingEntries = []
            return entries
        })

        const result = await cleanupJobSandboxes(paths, deps)

        expect(result).toEqual(expect.objectContaining({ status: "deleted", deleted: 1 }))
        expect(deps.fileSystem.rm).toHaveBeenCalledWith(paths.sandboxPath, { recursive: true, force: true })
        expect(deps.fileSystem.rm).toHaveBeenCalledWith(paths.jobSandboxRoot, { recursive: true, force: true })
    })

    test("removes only an empty workspace sandbox directory", async () => {
        const owner = createSandboxOwner("/repo", "my_job")
        const deps = createDeps({ existing: [owner.jobSandboxRoot, owner.workspacePath] })
        deps.fileSystem.readdir = mock(async () => [])

        expect(await cleanupEmptyJobSandboxRoot(owner, deps)).toBe(true)
        expect(deps.fileSystem.rm).toHaveBeenCalledWith(owner.jobSandboxRoot, { recursive: true, force: true })
        expect(deps.fileSystem.rm).not.toHaveBeenCalledWith(owner.workspacePath, expect.any(Object))
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
