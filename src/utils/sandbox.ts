import type { OpencodeClient } from "@opencode-ai/sdk"
import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { resolveAgentsStorageRoot, resolveJobWorkspaceIdentity, type JobToolFileSystem, type JobWorkspaceEntry, type SessionJobContext } from "./jobs"

export const allowedSandboxDistros = ["alpine", "debian", "ubuntu", "archlinux", "opensuse"] as const
export const supportedAlpineArchitectures = ["x86_64", "aarch64", "armv7"] as const
export const supportedManualArchitectures = ["x86_64", "aarch64", "armv7"] as const

export type SandboxDistro = typeof allowedSandboxDistros[number]
export type AlpineArchitecture = typeof supportedAlpineArchitectures[number]
export type ManualArchitecture = typeof supportedManualArchitectures[number]
export type ManualRootfsArchiveFormat = "gzip" | "xz" | "zstd"
export type SandboxBackend = "bubblewrap" | "termux_proot_distro" | "manual_proot" | "macos_unsupported" | "unsupported"
export type SandboxDistroMode = "quick" | "rootfs"
export type SandboxSyncMethod = "auto" | "overlayfs" | "reflink" | "copy"
export type EffectiveSandboxSyncMethod = "overlayfs" | "reflink" | "copy"
export type SandboxValidationResult<T> = { ok: true, value: T } | { ok: false, reason: string }

export type ManualRootfsDefinition = {
    architecture: ManualArchitecture
    url: string
    archive_format: ManualRootfsArchiveFormat
    strip_components?: number
}

export type SandboxDistroManualMetadata =
    | { feasible: true, backend: "manual_proot", downloads: readonly ManualRootfsDefinition[], unsupported_reason: string }
    | { feasible: false, backend: "manual_proot", status: "unsupported" | "not_feasible", reason: string }

export type SandboxDistroMetadata = {
    name: SandboxDistro
    display_name: string
    manual_rootfs: SandboxDistroManualMetadata
}

export type SandboxCommandResult = {
    exitCode: number | null
    stdout: string
    stderr: string
}

export type SandboxSpawn = (command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv, cwd?: string, shell?: boolean }) => Promise<SandboxCommandResult>

export type SandboxCommandChecker = (command: string) => Promise<boolean>

export type SandboxFetch = (url: string, init?: RequestInit) => Promise<Response>

export type SandboxProcessInfo = {
    platform: NodeJS.Platform
    arch: string
    env: NodeJS.ProcessEnv
}

export type SandboxFileSystem = Omit<JobToolFileSystem, "writeFile"> & {
    writeFile: (filePath: string, content: string | Uint8Array) => Promise<void>
    cp?: typeof cp
    lstat?: (filePath: string) => Promise<unknown>
}

export type SandboxCleanupFileSystem = Pick<JobToolFileSystem, "readFile" | "readdir" | "rm" | "stat">

export type SandboxDependencies = {
    fileSystem: SandboxFileSystem
    spawn: SandboxSpawn
    commandExists?: SandboxCommandChecker
    fetch?: SandboxFetch
    process: SandboxProcessInfo
}

export type SandboxConfig = {
    sync_method?: SandboxSyncMethod
    distro_cache_path?: string
    distro_expire?: string | number
}

export type SandboxCacheEntry = {
    entry_path: string
    rootfs_path: string
    metadata_file: string
    source_url: string
    archive_format: ManualRootfsArchiveFormat | "oci"
    created_at: string
    verified_at: string
    version: string
    architecture: ManualArchitecture
    verification: Record<string, string | number | boolean | undefined>
}

export type SandboxRootfsResolution =
    | { ok: true, cache: SandboxCacheEntry, downloaded: boolean }
    | { ok: false, reason: string, status?: string, source_url?: string, command?: string, stdout?: string, stderr?: string, exit_code?: number | null }

export type SandboxCleanupDependencies = Omit<SandboxDependencies, "fileSystem"> & {
    fileSystem: SandboxCleanupFileSystem
}

export type SandboxBackendDetection = {
    backend: SandboxBackend
    reason?: string
    guidance?: string
    signals: readonly string[]
}

export type SandboxPlatformSupportOptions = {
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
    bwrapUsable?: boolean
}

export type SandboxOwner = {
    storageRoot: string
    workspace: JobWorkspaceEntry
    jobName: string
    workspacePath: string
    jobSandboxRoot: string
}

export type SandboxPaths = SandboxOwner & {
    sandboxName: string
    sandboxPath: string
    metadataFile: string
}

export type SandboxOwnerResolution =
    | { ok: true, owner: SandboxOwner }
    | { ok: false, reason: string, jobName?: string }

export type NamedSandboxOwnerResolution =
    | { ok: true, owner: SandboxPaths }
    | { ok: false, reason: string, jobName?: string }

export type SandboxMetadata = {
    sandbox_name: string
    job_name: string
    distro: SandboxDistro | "quick"
    backend: SandboxBackend
    root_path: string
    created_at?: string
    updated_at?: string
    backend_data?: Record<string, string | number | boolean | undefined>
}

export type SandboxCleanupItemResult = {
    sandbox_name: string
    status: "deleted" | "missing" | "warning"
    warning?: string
}

export type SandboxCleanupResult = {
    ok: boolean
    status: "deleted" | "missing" | "warning"
    job_name: string
    deleted: number
    warnings: string[]
    items: SandboxCleanupItemResult[]
    guidance: string
}

export type ManualRootfsDownloadResolution =
    | { ok: true, distro: SandboxDistro, architecture: ManualArchitecture, url: string, archive_format: ManualRootfsArchiveFormat, strip_components?: number, version?: string, verification?: Record<string, string | number | boolean | undefined> }
    | { ok: false, distro: SandboxDistro, architecture?: string, status: string, reason: string, source_url?: string }

type AlpineReleaseMetadata = {
    arch?: string
    file?: string
    filename?: string
    flavor?: string
    sha256?: string
    sha512?: string
    title?: string
    url?: string
    version?: string
}

const alpineReleaseMetadataKeys = ["arch", "file", "filename", "flavor", "sha256", "sha512", "title", "url", "version"] as const
type AlpineReleaseMetadataKey = typeof alpineReleaseMetadataKeys[number]

const sandboxNamePattern = /^[a-z0-9_]+$/
const metadataFileName = "sandbox.json"
const termuxEnvironmentSignalNames = ["TERMUX_VERSION", "PREFIX", "ANDROID_ROOT", "ANDROID_DATA"] as const

function getAlpineLatestReleasesMetadataUrl(architecture: AlpineArchitecture): string {
    return `https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/${architecture}/latest-releases.yaml`
}

function manualDownload(architecture: ManualArchitecture, url: string, archiveFormat: ManualRootfsArchiveFormat, stripComponents?: number): ManualRootfsDefinition {
    return stripComponents === undefined
        ? { architecture, url, archive_format: archiveFormat }
        : { architecture, url, archive_format: archiveFormat, strip_components: stripComponents }
}

export const sandboxDistroMetadata: Record<SandboxDistro, SandboxDistroMetadata> = {
    alpine: {
        name: "alpine",
        display_name: "Alpine",
        manual_rootfs: {
            feasible: true,
            backend: "manual_proot",
            // Runtime resolver reads latest-releases.yaml for versioned minirootfs archives, so static downloads stay empty.
            downloads: [],
            unsupported_reason: "Alpine manual rootfs download resolves x86_64, aarch64, and armv7 minirootfs archives from upstream latest-releases metadata.",
        },
    },
    debian: {
        name: "debian",
        display_name: "Debian",
        manual_rootfs: {
            feasible: true,
            backend: "manual_proot",
            // Runtime resolver pulls docker.io/library/debian:bookworm with skopeo and unpacks it with umoci, so static downloads stay empty.
            downloads: [],
            unsupported_reason: "Debian Bookworm rootfs creation uses the official OCI image through skopeo and umoci.",
        },
    },
    ubuntu: {
        name: "ubuntu",
        display_name: "Ubuntu",
        manual_rootfs: {
            feasible: true,
            backend: "manual_proot",
            downloads: [
                manualDownload("x86_64", "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04-base-amd64.tar.gz", "gzip"),
                manualDownload("aarch64", "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04-base-arm64.tar.gz", "gzip"),
                manualDownload("armv7", "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04-base-armhf.tar.gz", "gzip"),
            ],
            unsupported_reason: "Ubuntu manual rootfs download supports only x86_64, aarch64, and armv7 via Ubuntu Base 24.04.",
        },
    },
    archlinux: {
        name: "archlinux",
        display_name: "Arch Linux",
        manual_rootfs: {
            feasible: true,
            backend: "manual_proot",
            downloads: [manualDownload("x86_64", "https://geo.mirror.pkgbuild.com/iso/latest/archlinux-bootstrap-x86_64.tar.zst", "zstd", 1)],
            unsupported_reason: "Arch Linux manual rootfs download supports only x86_64 from the official bootstrap archive.",
        },
    },
    opensuse: {
        name: "opensuse",
        display_name: "openSUSE",
        manual_rootfs: {
            feasible: true,
            backend: "manual_proot",
            downloads: [
                manualDownload("x86_64", "https://download.opensuse.org/tumbleweed/appliances/openSUSE-Tumbleweed-JeOS.x86_64-rootfs.tar.xz", "xz"),
                manualDownload("aarch64", "https://download.opensuse.org/tumbleweed/appliances/openSUSE-Tumbleweed-JeOS.aarch64-rootfs.tar.xz", "xz"),
            ],
            unsupported_reason: "openSUSE manual rootfs download supports only x86_64 and aarch64 JeOS rootfs archives.",
        },
    },
}

export function getManualRootfsDownload(distro: SandboxDistro, architecture: string): ManualRootfsDownloadResolution {
    const metadata = sandboxDistroMetadata[distro].manual_rootfs
    if (!metadata.feasible) {
        return { ok: false, distro, architecture, status: metadata.status, reason: metadata.reason }
    }
    const download = metadata.downloads.find((candidate) => candidate.architecture === architecture)
    if (!download) return { ok: false, distro, architecture, status: "not_feasible", reason: metadata.unsupported_reason }

    return download.strip_components === undefined
        ? { ok: true, distro, architecture: download.architecture, url: download.url, archive_format: download.archive_format }
        : { ok: true, distro, architecture: download.architecture, url: download.url, archive_format: download.archive_format, strip_components: download.strip_components }
}

async function defaultSpawn(command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv, cwd?: string, shell?: boolean }): Promise<SandboxCommandResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, [...args], { env: options?.env, cwd: options?.cwd, ...(options?.shell === undefined ? {} : { shell: options.shell }) })
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []

        child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
        child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
        child.on("error", reject)
        child.on("close", (exitCode) => resolve({
            exitCode,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
        }))
    })
}

async function readDirectory(dirPath: string, options?: { withFileTypes?: boolean }): Promise<string[] | import("fs").Dirent[]> {
    return options?.withFileTypes ? readdir(dirPath, { withFileTypes: true }) : readdir(dirPath)
}

export const defaultSandboxDependencies: SandboxDependencies = {
    fileSystem: {
        mkdir,
        readFile,
        readdir: readDirectory,
        rename,
        rm,
        stat,
        lstat,
        writeFile,
        cp,
    },
    spawn: defaultSpawn,
    fetch: typeof fetch === "function" ? fetch : undefined,
    process: {
        platform: process.platform,
        arch: process.arch,
        env: process.env,
    },
}

export function normalizeSandboxName(input: unknown): SandboxValidationResult<string> {
    if (typeof input !== "string") return { ok: false, reason: "sandbox_name must be a string." }

    const value = input.trim()
    if (!value) return { ok: false, reason: "sandbox_name must be a non-empty string." }
    if (!sandboxNamePattern.test(value)) return { ok: false, reason: "sandbox_name must contain lowercase letters, numbers, and underscores only." }

    return { ok: true, value }
}

export function normalizeDistro(input: unknown): SandboxValidationResult<SandboxDistro> {
    if (typeof input !== "string") return { ok: false, reason: "distro must be a string." }

    const value = input.trim().toLowerCase()
    if ((allowedSandboxDistros as readonly string[]).includes(value)) return { ok: true, value: value as SandboxDistro }

    return { ok: false, reason: "distro must be one of: alpine, debian, ubuntu, archlinux, opensuse." }
}

export function normalizeOptionalDistro(input: unknown): SandboxValidationResult<SandboxDistro | undefined> {
    if (input === undefined || input === null) return { ok: true, value: undefined }
    if (typeof input !== "string") return { ok: false, reason: "distro must be a string when provided." }

    const value = input.trim()
    if (!value) return { ok: true, value: undefined }

    return normalizeDistro(value)
}

export function resolveSandboxCachePath(config: SandboxConfig | undefined, deps: Pick<SandboxDependencies, "process"> = defaultSandboxDependencies): string {
    const configured = config?.distro_cache_path?.trim()
    const base = configured || path.join(deps.process.env.HOME || deps.process.env.USERPROFILE || process.cwd(), ".cache", "autocode", "distros")
    if (base.startsWith("~/")) return path.join(deps.process.env.HOME || process.cwd(), base.slice(2))
    if (base === "~") return deps.process.env.HOME || process.cwd()
    return base
}

function getArchitecture(arch: string): ManualArchitecture {
    if (arch === "arm64") return "aarch64"
    if (arch === "arm") return "armv7"
    return "x86_64"
}

function cacheEntryId(distro: SandboxDistro, download: ManualRootfsDownloadResolution & { ok: true }, version: string): string {
    const verificationHash = createHash("sha256").update(`${download.url}:${download.archive_format}:${download.strip_components ?? 0}:${JSON.stringify(download.verification ?? {})}`).digest("hex").slice(0, 16)
    const sourceHash = createHash("sha256").update(download.url).digest("hex").slice(0, 16)
    return `${distro}-${download.architecture}-${version}-${download.archive_format}-${sourceHash}-${verificationHash}`
}

const debianBookwormImage = "docker://docker.io/library/debian:bookworm"

function getDebianOciArchitecture(architecture: ManualArchitecture): { architecture: string, variant?: string } {
    if (architecture === "aarch64") return { architecture: "arm64", variant: "v8" }
    if (architecture === "armv7") return { architecture: "arm", variant: "v7" }
    return { architecture: "amd64" }
}

function parseAlpineLatestReleasesYaml(content: string): AlpineReleaseMetadata[] | undefined {
    const releases: AlpineReleaseMetadata[] = []
    let current: AlpineReleaseMetadata | undefined
    let blockScalarIndent: number | undefined

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line === "---" || line.startsWith("#")) continue
        const indent = rawLine.length - rawLine.trimStart().length
        if (blockScalarIndent !== undefined) {
            if (indent > blockScalarIndent) continue
            blockScalarIndent = undefined
        }
        if (line === "-") {
            if (current && Object.keys(current).length > 0) releases.push(current)
            current = {}
            continue
        }
        if (line.startsWith("- ")) {
            const next: AlpineReleaseMetadata = {}
            parseAlpineMetadataField(line.slice(2), next)
            if (current && Object.keys(current).length > 0) releases.push(current)
            current = next
            continue
        }
        if (!current) continue
        if (parseAlpineMetadataField(line, current)) blockScalarIndent = indent
    }
    if (current && Object.keys(current).length > 0) releases.push(current)

    return releases.length > 0 ? releases : undefined
}

function parseAlpineMetadataField(line: string, release: AlpineReleaseMetadata): boolean {
    const separator = line.indexOf(":")
    if (separator <= 0) return false
    const key = line.slice(0, separator).trim()
    const rawValue = line.slice(separator + 1).trim()
    const isBlockScalar = rawValue === "|" || rawValue === ">"
    const value = rawValue.replace(/^['"]|['"]$/g, "")
    if ((alpineReleaseMetadataKeys as readonly string[]).includes(key)) release[key as AlpineReleaseMetadataKey] = value
    return isBlockScalar
}

function isAlpineMinirootfsRelease(release: AlpineReleaseMetadata, architecture: AlpineArchitecture): boolean {
    const file = release.file ?? release.filename ?? release.url ?? ""
    const flavor = release.flavor ?? release.title ?? file
    const archMatches = release.arch === undefined || release.arch === architecture

    return archMatches && flavor.toLowerCase().includes("minirootfs") && file.includes("minirootfs") && file.endsWith(".tar.gz")
}

function buildAlpineMinirootfsDownload(metadataUrl: string, architecture: AlpineArchitecture, release: AlpineReleaseMetadata): ManualRootfsDownloadResolution & { ok: true } | undefined {
    const source = release.url ?? release.file ?? release.filename
    if (!source || !release.version) return undefined

    const url = source.startsWith("http://") || source.startsWith("https://") ? source : new URL(source, metadataUrl).toString()
    const verification: Record<string, string | number | boolean | undefined> = {}
    if (release.sha256) verification.sha256 = release.sha256
    if (release.sha512) verification.sha512 = release.sha512

    return { ok: true, distro: "alpine", architecture, url, archive_format: "gzip", version: release.version, verification }
}

async function resolveAlpineMinirootfsDownload(architecture: ManualArchitecture, deps: Pick<SandboxDependencies, "fetch">): Promise<ManualRootfsDownloadResolution> {
    if (!(supportedAlpineArchitectures as readonly string[]).includes(architecture)) {
        return { ok: false, distro: "alpine", architecture, status: "not_feasible", reason: sandboxDistroMetadata.alpine.manual_rootfs.feasible ? sandboxDistroMetadata.alpine.manual_rootfs.unsupported_reason : "Alpine manual rootfs download is unavailable." }
    }
    if (!deps.fetch) return { ok: false, distro: "alpine", architecture, status: "not_feasible", reason: "Unable to resolve Alpine rootfs metadata: fetch is unavailable." }

    const alpineArchitecture = architecture as AlpineArchitecture
    const metadataUrl = getAlpineLatestReleasesMetadataUrl(alpineArchitecture)
    let response: Response
    try {
        response = await deps.fetch(metadataUrl)
    }
    catch (error) {
        return { ok: false, distro: "alpine", architecture, status: "not_feasible", reason: `Alpine rootfs metadata fetch failed for ${metadataUrl}: ${error instanceof Error ? error.message : String(error)}`, source_url: metadataUrl }
    }
    if (!response.ok) return { ok: false, distro: "alpine", architecture, status: String(response.status), reason: `Alpine rootfs metadata fetch failed for ${metadataUrl} with HTTP ${response.status}.`, source_url: metadataUrl }

    let releases: AlpineReleaseMetadata[] | undefined
    try {
        releases = parseAlpineLatestReleasesYaml(await response.text())
    }
    catch {
        return { ok: false, distro: "alpine", architecture, status: "not_feasible", reason: `Alpine rootfs metadata is malformed: ${metadataUrl}.`, source_url: metadataUrl }
    }
    if (!releases) return { ok: false, distro: "alpine", architecture, status: "not_feasible", reason: `Alpine rootfs metadata is malformed: ${metadataUrl}.`, source_url: metadataUrl }

    const release = releases.find((candidate) => isAlpineMinirootfsRelease(candidate, alpineArchitecture))
    const download = release ? buildAlpineMinirootfsDownload(metadataUrl, alpineArchitecture, release) : undefined
    if (!download) return { ok: false, distro: "alpine", architecture, status: "not_feasible", reason: `Alpine rootfs metadata does not include a matching minirootfs release: ${metadataUrl}.`, source_url: metadataUrl }

    return download
}

export async function detectEffectiveSandboxSyncMethod(config: SandboxConfig | undefined, deps: SandboxDependencies = defaultSandboxDependencies): Promise<EffectiveSandboxSyncMethod> {
    const requested = config?.sync_method ?? "auto"
    if (requested === "copy") return "copy"
    // overlayfs is accepted as a requested method, but rootfs materialization falls back unless a safe mount path is implemented.
    if (requested === "overlayfs") return "copy"
    if (requested === "reflink" || requested === "auto") {
        try {
            const result = await deps.spawn("cp", ["--version"], { env: deps.process.env })
            if (result.exitCode === 0 && requested === "reflink") return "reflink"
            if (result.exitCode === 0 && requested === "auto") return "reflink"
        }
        catch {
            return "copy"
        }
    }
    return "copy"
}

async function readJsonFile<T>(fileSystem: Pick<SandboxFileSystem, "readFile">, filePath: string): Promise<T | undefined> {
    try {
        return JSON.parse(await fileSystem.readFile(filePath, "utf8")) as T
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
    }
}

async function writeJsonFile(fileSystem: Pick<SandboxFileSystem, "mkdir" | "writeFile">, filePath: string, value: unknown): Promise<void> {
    await fileSystem.mkdir(path.dirname(filePath), { recursive: true })
    await fileSystem.writeFile(filePath, `${JSON.stringify(value, undefined, 2)}\n`)
}

async function ensureDebianBookwormRootfsCache(architecture: ManualArchitecture, config: SandboxConfig | undefined, deps: SandboxDependencies): Promise<SandboxRootfsResolution> {
    const version = "bookworm"
    const sourceHash = createHash("sha256").update(debianBookwormImage).digest("hex").slice(0, 16)
    const entryPath = path.join(resolveSandboxCachePath(config, deps), "debian", architecture, `debian-${architecture}-${version}-oci-${sourceHash}`)
    const rootfsPath = path.join(entryPath, "rootfs")
    const metadataFile = path.join(entryPath, "metadata.json")
    const existing = await readJsonFile<SandboxCacheEntry>(deps.fileSystem, metadataFile)
    if (existing && await pathExists(deps.fileSystem, existing.rootfs_path) && await optionalPathExists(deps.fileSystem, path.join(existing.rootfs_path, "bin", "sh"))) return { ok: true, cache: existing, downloaded: false }

    const missingTools = (await Promise.all(["skopeo", "umoci"].map(async (command) => await isCommandCallable(command, deps)))).flatMap((available, index) => available ? [] : [index === 0 ? "skopeo" : "umoci"])
    if (missingTools.length > 0) {
        return { ok: false, status: "missing_dependency", source_url: debianBookwormImage, reason: `Missing host dependencies ${missingTools.join(" and ")} required to create Debian Bookworm rootfs. Install with: sudo apt install skopeo umoci.` }
    }

    await deps.fileSystem.rm?.(entryPath, { recursive: true, force: true })
    const workPath = `${entryPath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const layoutPath = path.join(workPath, "oci")
    const bundlePath = path.join(workPath, "bundle")
    const unpackedRootfsPath = path.join(bundlePath, "rootfs")
    const workRootfsPath = path.join(workPath, "rootfs")
    const workMetadataFile = path.join(workPath, "metadata.json")
    const ociArchitecture = getDebianOciArchitecture(architecture)
    const skopeoArgs = ["copy", "--override-os", "linux", "--override-arch", ociArchitecture.architecture, ...(ociArchitecture.variant ? ["--override-variant", ociArchitecture.variant] : []), debianBookwormImage, `oci:${layoutPath}:bookworm`]
    let completed = false

    try {
        await deps.fileSystem.mkdir(workPath, { recursive: true })
        const pull = await deps.spawn("skopeo", skopeoArgs, { env: deps.process.env })
        if (pull.exitCode !== 0) {
            return { ok: false, reason: "Debian OCI image pull failed.", command: `skopeo ${skopeoArgs.join(" ")}`, stdout: pull.stdout, stderr: pull.stderr, exit_code: pull.exitCode, source_url: debianBookwormImage }
        }

        const umociArgs = ["unpack", "--rootless", "--image", `${layoutPath}:bookworm`, bundlePath]
        const unpack = await deps.spawn("umoci", umociArgs, { env: deps.process.env })
        if (unpack.exitCode !== 0) {
            return { ok: false, reason: "Debian OCI image unpack failed.", command: `umoci ${umociArgs.join(" ")}`, stdout: unpack.stdout, stderr: unpack.stderr, exit_code: unpack.exitCode, source_url: debianBookwormImage }
        }
        if (!await optionalPathExists(deps.fileSystem, path.join(unpackedRootfsPath, "bin", "sh"))) {
            return { ok: false, reason: "Debian OCI image unpack produced malformed rootfs: missing /bin/sh.", source_url: debianBookwormImage }
        }

        const rename = deps.fileSystem.rename
        if (!rename) throw new Error("Unable to create Debian OCI rootfs cache: rename is unavailable")
        await rename(unpackedRootfsPath, workRootfsPath)
        await deps.fileSystem.rm?.(layoutPath, { recursive: true, force: true })
        await deps.fileSystem.rm?.(bundlePath, { recursive: true, force: true })
        const now = new Date().toISOString()
        const cache: SandboxCacheEntry = {
            entry_path: entryPath,
            rootfs_path: rootfsPath,
            metadata_file: metadataFile,
            source_url: debianBookwormImage,
            archive_format: "oci",
            created_at: now,
            verified_at: now,
            version,
            architecture,
            verification: { source_url_sha256: createHash("sha256").update(debianBookwormImage).digest("hex"), skopeo_digest_verification: true },
        }
        await writeJsonFile(deps.fileSystem, workMetadataFile, cache)
        await rename(workPath, entryPath)
        completed = true
        return { ok: true, cache, downloaded: true }
    }
    catch (error) {
        return { ok: false, reason: `Debian OCI rootfs creation failed: ${error instanceof Error ? error.message : String(error)}.`, source_url: debianBookwormImage }
    }
    finally {
        if (!completed) {
            await deps.fileSystem.rm?.(workPath, { recursive: true, force: true })
            await deps.fileSystem.rm?.(entryPath, { recursive: true, force: true })
        }
    }
}

export async function ensureSandboxRootfsCache(distro: SandboxDistro, config: SandboxConfig | undefined, deps: SandboxDependencies = defaultSandboxDependencies): Promise<SandboxRootfsResolution> {
    const architecture = getArchitecture(deps.process.arch)
    if (distro === "debian") return await ensureDebianBookwormRootfsCache(architecture, config, deps)

    const download = distro === "alpine" ? await resolveAlpineMinirootfsDownload(architecture, deps) : getManualRootfsDownload(distro, architecture)
    if (!download.ok) return { ok: false, reason: download.reason, status: download.status, source_url: download.source_url }
    if (!deps.fetch) return { ok: false, reason: "Unable to download distro rootfs: fetch is unavailable." }

    const version = download.version ?? "latest-stable"
    const entryPath = path.join(resolveSandboxCachePath(config, deps), distro, architecture, cacheEntryId(distro, download, version))
    const rootfsPath = path.join(entryPath, "rootfs")
    const metadataFile = path.join(entryPath, "metadata.json")
    const existing = await readJsonFile<SandboxCacheEntry>(deps.fileSystem, metadataFile)
    if (existing && await pathExists(deps.fileSystem, existing.rootfs_path) && await optionalPathExists(deps.fileSystem, path.join(existing.rootfs_path, "bin", "sh"))) return { ok: true, cache: existing, downloaded: false }
    if (existing && deps.fileSystem.rm) await deps.fileSystem.rm(entryPath, { recursive: true, force: true })

    await deps.fileSystem.mkdir(rootfsPath, { recursive: true })
    const archivePath = path.join(entryPath, `rootfs.tar.${download.archive_format}`)
    let response: Response
    try {
        response = await deps.fetch(download.url)
    }
    catch (error) {
        await deps.fileSystem.rm?.(entryPath, { recursive: true, force: true })
        return { ok: false, reason: `Rootfs download failed for ${download.url}: ${error instanceof Error ? error.message : String(error)}.`, source_url: download.url }
    }
    if (!response.ok) {
        await deps.fileSystem.rm?.(entryPath, { recursive: true, force: true })
        return { ok: false, reason: `Rootfs download failed for ${download.url} with HTTP ${response.status}.`, status: String(response.status), source_url: download.url }
    }
    const archive = new Uint8Array(await response.arrayBuffer())
    await deps.fileSystem.writeFile(archivePath, archive)

    const missingCompressor = await getMissingRootfsArchiveCompressor(download.archive_format, deps)
    if (missingCompressor) {
        await deps.fileSystem.rm?.(entryPath, { recursive: true, force: true })
        return { ok: false, reason: `Missing host dependency ${missingCompressor} required to extract ${download.archive_format} rootfs archive; rootfs download already succeeded.`, source_url: download.url }
    }

    const tarArgs = createRootfsTarExtractArgs(archivePath, rootfsPath, download.archive_format, download.strip_components)
    const extract = await deps.spawn("tar", tarArgs, { env: deps.process.env })
    if (extract.exitCode !== 0) {
        await deps.fileSystem.rm?.(entryPath, { recursive: true, force: true })
        return { ok: false, reason: "Rootfs extraction failed.", command: `tar ${tarArgs.join(" ")}`, stdout: extract.stdout, stderr: extract.stderr, exit_code: extract.exitCode }
    }
    if (!await optionalPathExists(deps.fileSystem, path.join(rootfsPath, "bin", "sh"))) {
        await deps.fileSystem.rm?.(entryPath, { recursive: true, force: true })
        return { ok: false, reason: `Rootfs extraction produced malformed ${distro} rootfs: missing /bin/sh. Verify archive strip_components setting for ${download.url}.`, source_url: download.url }
    }

    const now = new Date().toISOString()
    const cache: SandboxCacheEntry = {
        entry_path: entryPath,
        rootfs_path: rootfsPath,
        metadata_file: metadataFile,
        source_url: download.url,
        archive_format: download.archive_format,
        created_at: now,
        verified_at: now,
        version,
        architecture: download.architecture,
        verification: { source_url_sha256: createHash("sha256").update(download.url).digest("hex"), ...download.verification },
    }
    await writeJsonFile(deps.fileSystem, metadataFile, cache)
    return { ok: true, cache, downloaded: true }
}

async function getMissingRootfsArchiveCompressor(archiveFormat: ManualRootfsArchiveFormat, deps: Pick<SandboxDependencies, "commandExists" | "spawn" | "process">): Promise<string | undefined> {
    const command = getRootfsArchiveCompressorCommand(archiveFormat)
    if (!command) return undefined

    return await isCommandCallable(command, deps) ? undefined : command
}

function getRootfsArchiveCompressorCommand(archiveFormat: ManualRootfsArchiveFormat): string | undefined {
    if (archiveFormat === "xz") return "xz"
    if (archiveFormat === "zstd") return "zstd"
    return undefined
}

function createRootfsTarExtractArgs(archivePath: string, rootfsPath: string, archiveFormat: ManualRootfsArchiveFormat, stripComponents?: number): string[] {
    const args = ["--extract"]
    if (archiveFormat === "gzip") args.push("--gzip")
    if (archiveFormat === "xz") args.push("--xz")
    if (archiveFormat === "zstd") args.push("--zstd")
    if (stripComponents !== undefined) args.push(`--strip-components=${stripComponents}`)
    args.push(`--file=${archivePath}`, `--directory=${rootfsPath}`)
    return args
}

export async function materializeSandboxRootfs(cacheRootfsPath: string, destinationRootfsPath: string, method: EffectiveSandboxSyncMethod, deps: SandboxDependencies = defaultSandboxDependencies): Promise<EffectiveSandboxSyncMethod> {
    await deps.fileSystem.rm?.(destinationRootfsPath, { recursive: true, force: true })
    await deps.fileSystem.mkdir(destinationRootfsPath, { recursive: true })
    if (method === "reflink") {
        const result = await deps.spawn("cp", ["-a", "--reflink=always", `${cacheRootfsPath}/.`, `${destinationRootfsPath}/`], { env: deps.process.env })
        if (result.exitCode === 0) return "reflink"
    }
    const archiveCopy = await copySandboxRootfsWithCpArchive(cacheRootfsPath, destinationRootfsPath, deps)
    if (archiveCopy) return "copy"
    if (deps.fileSystem.cp) {
        await deps.fileSystem.cp(path.join(cacheRootfsPath, "."), destinationRootfsPath, { recursive: true, force: true, preserveTimestamps: true, dereference: false, verbatimSymlinks: true })
        return "copy"
    }
    throw new Error("Rootfs copy failed: cp -a failed and fs.cp is unavailable.")
}

async function copySandboxRootfsWithCpArchive(cacheRootfsPath: string, destinationRootfsPath: string, deps: SandboxDependencies): Promise<boolean> {
    try {
        const result = await deps.spawn("cp", ["-a", `${cacheRootfsPath}/.`, `${destinationRootfsPath}/`], { env: deps.process.env })
        if (result.exitCode === 0) return true
        if (!deps.fileSystem.cp) throw new Error(`Rootfs copy failed: ${result.stderr || result.stdout}`)
    }
    catch (error) {
        if (!deps.fileSystem.cp) throw error
    }
    return false
}

function parseExpire(value: string | number | undefined, effectiveMethod: EffectiveSandboxSyncMethod): number | undefined {
    if (value === undefined) return effectiveMethod === "copy" ? 30 * 24 * 60 * 60 * 1000 : undefined
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined
    const normalized = value.trim().toLowerCase()
    if (!normalized || normalized === "never") return undefined
    const match = /^(\d+)\s*(ms|d|day|days|month|months)?$/.exec(normalized)
    if (!match) return undefined
    const amount = Number(match[1])
    const unit = match[2] ?? "ms"
    if (unit === "d" || unit === "day" || unit === "days") return amount * 24 * 60 * 60 * 1000
    if (unit === "month" || unit === "months") return amount * 30 * 24 * 60 * 60 * 1000
    return amount
}

async function collectReferencedCacheEntries(fileSystem: Pick<SandboxFileSystem, "readFile" | "readdir" | "stat">, jobSandboxRoot: string): Promise<Set<string>> {
    const references = new Set<string>()
    for (const sandboxEntry of await readDirectoryEntries(fileSystem, jobSandboxRoot)) {
        if (!sandboxEntry.isDirectory()) continue
        const metadata = await readSandboxMetadata(fileSystem, path.join(jobSandboxRoot, sandboxEntry.name, metadataFileName))
        const entry = metadata?.backend_data?.cache_entry_path
        if (typeof entry === "string") references.add(path.resolve(entry))
    }
    return references
}

export async function cleanupExpiredSandboxCacheEntries(cache: SandboxCacheEntry, owner: SandboxOwner, config: SandboxConfig | undefined, effectiveMethod: EffectiveSandboxSyncMethod, deps: SandboxDependencies = defaultSandboxDependencies): Promise<void> {
    const ttl = parseExpire(config?.distro_expire, effectiveMethod)
    if (ttl === undefined) return
    const parent = path.dirname(cache.entry_path)
    const references = await collectReferencedCacheEntries(deps.fileSystem, owner.jobSandboxRoot)
    const now = Date.now()
    for (const entry of await readDirectoryEntries(deps.fileSystem, parent)) {
        if (!entry.isDirectory()) continue
        const entryPath = path.join(parent, entry.name)
        if (path.resolve(entryPath) === path.resolve(cache.entry_path) || references.has(path.resolve(entryPath))) continue
        const metadata = await readJsonFile<SandboxCacheEntry>(deps.fileSystem, path.join(entryPath, "metadata.json"))
        const createdAt = metadata?.created_at ? Date.parse(metadata.created_at) : NaN
        if (Number.isFinite(createdAt) && now - createdAt > ttl) await deps.fileSystem.rm?.(entryPath, { recursive: true, force: true })
    }
}

export function assertSafeSandboxPath(candidatePath: string, jobSandboxRoot: string): SandboxValidationResult<string> {
    if (!candidatePath.trim()) return { ok: false, reason: "Sandbox path must be non-empty." }
    if (candidatePath.split(/[\\/]+/).includes("..")) {
        return { ok: false, reason: "Sandbox path must not contain unsafe relative traversal." }
    }

    const resolvedRoot = path.resolve(jobSandboxRoot)
    const resolvedPath = path.resolve(candidatePath)
    const relativePath = path.relative(resolvedRoot, resolvedPath)
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return { ok: false, reason: "Sandbox path must be inside the current job sandbox root." }
    }
    if (relativePath.split(path.sep).includes("..")) {
        return { ok: false, reason: "Sandbox path must not contain unsafe relative traversal." }
    }

    return { ok: true, value: resolvedPath }
}

export function assertDirectSandboxPath(candidatePath: string, jobSandboxRoot: string): SandboxValidationResult<string> {
    const safePath = assertSafeSandboxPath(candidatePath, jobSandboxRoot)
    if (!safePath.ok) return safePath
    if (path.dirname(safePath.value) !== path.resolve(jobSandboxRoot)) {
        return { ok: false, reason: "Sandbox path must be a direct child of the current job sandbox root." }
    }
    return safePath
}

export function assertSandboxDescendantPath(candidatePath: string, paths: SandboxPaths): SandboxValidationResult<string> {
    const safePath = assertSafeSandboxPath(candidatePath, paths.jobSandboxRoot)
    if (!safePath.ok) return safePath
    const relativePath = path.relative(path.resolve(paths.sandboxPath), safePath.value)
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return { ok: false, reason: "Sandbox path must be inside the resolved sandbox directory." }
    }
    return safePath
}

export function assertOwnedSandboxRootPath(candidatePath: string, sandboxPath: string, jobSandboxRoot: string): SandboxValidationResult<string> {
    const safePath = assertDirectSandboxPath(candidatePath, jobSandboxRoot)
    if (!safePath.ok) return safePath
    if (safePath.value !== path.resolve(sandboxPath)) {
        return { ok: false, reason: "Sandbox root path must match the resolved sandbox directory." }
    }
    return safePath
}

export function validateSandboxMetadata(paths: SandboxPaths, metadata: SandboxMetadata): SandboxValidationResult<SandboxMetadata> {
    const metadataValue: unknown = metadata
    if (typeof metadataValue !== "object" || metadataValue === null || Array.isArray(metadataValue)) {
        return { ok: false, reason: "Sandbox metadata must be an object." }
    }

    const record = metadataValue as Record<string, unknown>
    if (record.sandbox_name !== paths.sandboxName) {
        return { ok: false, reason: "Sandbox metadata name must match the resolved sandbox name." }
    }
    if (record.job_name !== paths.jobName) {
        return { ok: false, reason: "Sandbox metadata job name must match the resolved job workspace." }
    }
    if (typeof record.root_path !== "string") {
        return { ok: false, reason: "Sandbox metadata root path must be a string." }
    }

    const safeRootPath = assertOwnedSandboxRootPath(record.root_path, paths.sandboxPath, paths.jobSandboxRoot)
    if (!safeRootPath.ok) return safeRootPath
    return { ok: true, value: metadata }
}

export function getSandboxHomePath(paths: SandboxPaths): string {
    return path.join(paths.sandboxPath, "home")
}

export function getSandboxRootHomePath(paths: SandboxPaths): string {
    return path.join(getSandboxHomePath(paths), "root")
}

export function getSandboxRootfsPath(paths: SandboxPaths): string {
    return path.join(paths.sandboxPath, "rootfs")
}

export function getSandboxRunLockPath(paths: SandboxPaths): string {
    return path.join(paths.sandboxPath, ".autocode_run_lock")
}

export function assertSafeSandboxDeletionPath(candidatePath: string, jobSandboxRoot: string): SandboxValidationResult<string> {
    const resolvedJobSandboxRoot = path.resolve(jobSandboxRoot)
    const resolvedPath = path.resolve(candidatePath)

    if (resolvedPath === resolvedJobSandboxRoot) {
        return { ok: false, reason: "Refusing to delete protected sandbox storage directory." }
    }

    return assertDirectSandboxPath(candidatePath, jobSandboxRoot)
}

function assertSafeJobSandboxRootDeletionPath(candidatePath: string, owner: SandboxOwner): SandboxValidationResult<string> {
    const resolvedWorkspacePath = path.resolve(owner.workspacePath)
    const resolvedExpectedRoot = path.join(resolvedWorkspacePath, "sandboxes")
    const resolvedPath = path.resolve(candidatePath)

    if (path.resolve(owner.jobSandboxRoot) !== resolvedExpectedRoot || resolvedPath !== resolvedExpectedRoot || resolvedPath === resolvedWorkspacePath) {
        return { ok: false, reason: "Refusing to delete protected sandbox storage directory." }
    }

    return { ok: true, value: resolvedPath }
}

export function resolveSandboxOwner(
    fileSystem: Pick<JobToolFileSystem, "readFile" | "readdir">,
    client: OpencodeClient | undefined,
    context: SessionJobContext,
): Promise<SandboxOwnerResolution>
export function resolveSandboxOwner(
    fileSystem: Pick<JobToolFileSystem, "readFile" | "readdir">,
    client: OpencodeClient | undefined,
    context: SessionJobContext,
    sandboxName: string,
): Promise<NamedSandboxOwnerResolution>
export async function resolveSandboxOwner(
    fileSystem: Pick<JobToolFileSystem, "readFile" | "readdir">,
    client: OpencodeClient | undefined,
    context: SessionJobContext,
    sandboxName?: string,
): Promise<SandboxOwnerResolution | NamedSandboxOwnerResolution> {
    const identity = await resolveJobWorkspaceIdentity(fileSystem, client, {
        sessionID: context.sessionID,
        directory: context.directory,
        worktree: context.worktree,
    })
    if (identity.resolution !== "found" || !identity.workspace || !identity.job_name) {
        return {
            ok: false,
            reason: "No timestamped job workspace was found for the current session.",
            jobName: identity.job_name,
        }
    }

    const owner: SandboxOwner = {
        storageRoot: resolveAgentsStorageRoot(context),
        workspace: identity.workspace,
        jobName: identity.job_name,
        workspacePath: identity.workspace.absolute_path,
        jobSandboxRoot: path.join(identity.workspace.absolute_path, "sandboxes"),
    }
    if (sandboxName === undefined) return { ok: true, owner }

    return { ok: true, owner: createSandboxPaths(owner, sandboxName) }
}

function createSandboxPaths(owner: SandboxOwner, sandboxName: string): SandboxPaths {
    const sandboxPath = path.join(owner.jobSandboxRoot, sandboxName)
    return {
        ...owner,
        sandboxName,
        sandboxPath,
        metadataFile: path.join(sandboxPath, metadataFileName),
    }
}

async function isCommandCallable(command: string, deps: Pick<SandboxDependencies, "commandExists" | "spawn" | "process">): Promise<boolean> {
    if (deps.commandExists) return deps.commandExists(command)

    try {
        const result = await deps.spawn("sh", ["-c", `command -v ${command}`], { env: deps.process.env })
        return result.exitCode === 0
    }
    catch {
        return false
    }
}

function addSandboxProbeBind(args: string[], hostPath: string, guestPath: string = hostPath): void {
    args.push("--ro-bind", hostPath, guestPath)
}

async function addOptionalSandboxProbeBind(deps: Pick<SandboxDependencies, "fileSystem">, args: string[], hostPath: string, guestPath: string = hostPath): Promise<void> {
    if (await optionalPathExists(deps.fileSystem, hostPath)) addSandboxProbeBind(args, hostPath, guestPath)
}

async function createBwrapUsabilityProbeArgs(deps: Pick<SandboxDependencies, "fileSystem">): Promise<string[]> {
    const args = [
        "--die-with-parent",
        "--unshare-all",
        "--new-session",
        "--proc", "/proc",
        "--dev", "/dev",
        "--tmpfs", "/tmp",
        "--dir", "/etc",
        "--setenv", "PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ]

    for (const hostPath of ["/bin", "/usr", "/lib", "/lib64", "/sbin", "/etc/alternatives"]) {
        await addOptionalSandboxProbeBind(deps, args, hostPath)
    }
    await addOptionalSandboxProbeBind(deps, args, "/etc/resolv.conf")
    await addOptionalSandboxProbeBind(deps, args, "/etc/nsswitch.conf")
    await addOptionalSandboxProbeBind(deps, args, "/etc/hosts")
    await addOptionalSandboxProbeBind(deps, args, "/etc/passwd")
    await addOptionalSandboxProbeBind(deps, args, "/etc/group")

    args.push("/bin/sh", "-lc", "true")
    return args
}

function createBwrapUsabilityProbeArgsSync(): string[] {
    const args = [
        "--die-with-parent",
        "--unshare-all",
        "--new-session",
        "--proc", "/proc",
        "--dev", "/dev",
        "--tmpfs", "/tmp",
        "--dir", "/etc",
        "--setenv", "PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ]

    for (const hostPath of ["/bin", "/usr", "/lib", "/lib64", "/sbin", "/etc/alternatives"]) {
        if (existsSync(hostPath)) addSandboxProbeBind(args, hostPath)
    }
    for (const hostPath of ["/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/hosts", "/etc/passwd", "/etc/group"]) {
        if (existsSync(hostPath)) addSandboxProbeBind(args, hostPath)
    }

    args.push("/bin/sh", "-lc", "true")
    return args
}

async function isBwrapUsable(deps: Pick<SandboxDependencies, "commandExists" | "fileSystem" | "spawn" | "process">): Promise<boolean> {
    if (!await isCommandCallable("bwrap", deps)) return false

    try {
        const result = await deps.spawn("bwrap", await createBwrapUsabilityProbeArgs(deps), { env: deps.process.env })
        return result.exitCode === 0
    }
    catch {
        return false
    }
}

function isBwrapUsableSync(env: NodeJS.ProcessEnv): boolean {
    const command = spawnSync("sh", ["-c", "command -v bwrap"], { env, timeout: 1000, stdio: "ignore" })
    if (command.status !== 0) return false

    // Runtime validation is still required because bwrap availability and kernel capabilities can change after startup.
    const probe = spawnSync("bwrap", createBwrapUsabilityProbeArgsSync(), { env, timeout: 3000, stdio: "ignore" })
    return probe.status === 0
}

export function hasTermuxEnvironmentSignal(env: NodeJS.ProcessEnv): boolean {
    return termuxEnvironmentSignalNames.some((name) => Boolean(env[name]))
}

export function isSandboxPlatformSupported(options: SandboxPlatformSupportOptions = {}): boolean {
    const platform = options.platform ?? process.platform
    const env = options.env ?? process.env
    if (platform !== "linux") return false
    if (hasTermuxEnvironmentSignal(env)) return false
    if (options.bwrapUsable !== undefined) return options.bwrapUsable

    return isBwrapUsableSync(env)
}

async function readKernelSignal(fileSystem: Pick<SandboxFileSystem, "readFile">, filePath: string): Promise<string | undefined> {
    try {
        return await fileSystem.readFile(filePath, "utf8")
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
    }
}

function collectEnvironmentSignals(processInfo: SandboxProcessInfo, procVersion?: string, osRelease?: string): string[] {
    const signals: string[] = [`platform:${processInfo.platform}`]
    for (const name of [...termuxEnvironmentSignalNames, "WSL_DISTRO_NAME", "WSL_INTEROP"] as const) {
        if (processInfo.env[name]) signals.push(`env:${name}`)
    }
    if (procVersion?.toLowerCase().includes("microsoft") || osRelease?.toLowerCase().includes("microsoft")) signals.push("kernel:wsl")
    return signals
}

export async function detectSandboxBackend(deps: SandboxDependencies = defaultSandboxDependencies): Promise<SandboxBackendDetection> {
    const [procVersion, osRelease] = await Promise.all([
        readKernelSignal(deps.fileSystem, "/proc/version"),
        readKernelSignal(deps.fileSystem, "/proc/sys/kernel/osrelease"),
    ])
    const signals = collectEnvironmentSignals(deps.process, procVersion, osRelease)

    if (deps.process.platform === "darwin") {
        return { backend: "macos_unsupported", reason: "macOS is not supported for sandbox backends.", signals }
    }

    if (deps.process.platform === "linux") {
        if (hasTermuxEnvironmentSignal(deps.process.env)) {
            return { backend: "unsupported", reason: "Termux-on-Linux is not supported for sandbox backends.", signals }
        }

        return await isBwrapUsable(deps)
            ? { backend: "bubblewrap", signals }
            : { backend: "unsupported", reason: "Linux sandbox backend requires a callable and usable bwrap binary.", guidance: "Install or expose bubblewrap (bwrap) before creating a sandbox; proot and proot-distro are not supported fallbacks.", signals }
    }

    return { backend: "unsupported", reason: `Unsupported platform: ${deps.process.platform}.`, signals }
}

export async function readSandboxMetadata(fileSystem: Pick<SandboxFileSystem, "readFile">, metadataFile: string): Promise<SandboxMetadata | undefined> {
    try {
        return JSON.parse(await fileSystem.readFile(metadataFile, "utf8")) as SandboxMetadata
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
    }
}

export async function writeSandboxMetadata(fileSystem: Pick<SandboxFileSystem, "mkdir" | "writeFile">, metadataFile: string, metadata: SandboxMetadata): Promise<void> {
    await fileSystem.mkdir(path.dirname(metadataFile), { recursive: true })
    await fileSystem.writeFile(metadataFile, `${JSON.stringify(metadata, undefined, 2)}\n`)
}

async function readDirectoryEntries(fileSystem: Pick<SandboxFileSystem, "readdir">, directoryPath: string): Promise<import("fs").Dirent[]> {
    try {
        return await fileSystem.readdir(directoryPath, { withFileTypes: true }) as import("fs").Dirent[]
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
        throw error
    }
}

async function pathExists(fileSystem: Pick<SandboxFileSystem, "stat">, candidatePath: string): Promise<boolean> {
    try {
        await fileSystem.stat(candidatePath)
        return true
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
        throw error
    }
}

async function optionalPathExists(fileSystem: Pick<SandboxFileSystem, "stat" | "lstat">, candidatePath: string): Promise<boolean> {
    try {
        await (fileSystem.lstat ?? fileSystem.stat)(candidatePath)
        return true
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
        throw error
    }
}

async function removePath(fileSystem: Pick<SandboxCleanupFileSystem, "rm">, candidatePath: string): Promise<void> {
    if (!fileSystem.rm) throw new Error("Unable to remove sandbox path: rm is unavailable")
    await fileSystem.rm(candidatePath, { recursive: true, force: true })
}

export async function cleanupEmptyJobSandboxRoot(
    owner: SandboxOwner,
    deps: SandboxCleanupDependencies = defaultSandboxDependencies,
): Promise<boolean> {
    const safePath = assertSafeJobSandboxRootDeletionPath(owner.jobSandboxRoot, owner)
    if (!safePath.ok) return false
    if (!await pathExists(deps.fileSystem, safePath.value)) return false

    const entries = await deps.fileSystem.readdir(safePath.value, { withFileTypes: true }) as import("fs").Dirent[]
    if (entries.length > 0) return false

    await removePath(deps.fileSystem, safePath.value)
    return true
}

export async function deleteSandboxPath(
    paths: SandboxPaths,
    deps: SandboxCleanupDependencies = defaultSandboxDependencies,
): Promise<SandboxCleanupItemResult> {
    const safePath = assertSafeSandboxDeletionPath(paths.sandboxPath, paths.jobSandboxRoot)
    if (!safePath.ok) return { sandbox_name: paths.sandboxName, status: "warning", warning: safePath.reason }
    if (!await pathExists(deps.fileSystem, safePath.value)) return { sandbox_name: paths.sandboxName, status: "missing" }

    const metadata = await readSandboxMetadata(deps.fileSystem, paths.metadataFile)
    if (metadata !== undefined) {
        const metadataValidation = validateSandboxMetadata(paths, metadata)
        if (!metadataValidation.ok) return { sandbox_name: paths.sandboxName, status: "warning", warning: metadataValidation.reason }
    }
    const warning = metadata?.backend === "termux_proot_distro" || metadata?.backend === "manual_proot"
        ? `Legacy sandbox backend ${metadata.backend} is unsupported; deleted sandbox storage only. Recreate the sandbox under bubblewrap.`
        : undefined

    await removePath(deps.fileSystem, safePath.value)
    return warning
        ? { sandbox_name: paths.sandboxName, status: "warning", warning }
        : { sandbox_name: paths.sandboxName, status: "deleted" }
}

export async function cleanupJobSandboxes(
    owner: SandboxOwner,
    deps: SandboxCleanupDependencies = defaultSandboxDependencies,
): Promise<SandboxCleanupResult> {
    const jobSandboxRoot = owner.jobSandboxRoot
    const guidance = "Sandbox cleanup removes bubblewrap sandbox storage directories; legacy proot metadata is not executed or removed through proot-distro."
    if (!await pathExists(deps.fileSystem, jobSandboxRoot)) {
        return { ok: true, status: "missing", job_name: owner.jobName, deleted: 0, warnings: [], items: [], guidance }
    }

    const entries = await deps.fileSystem.readdir(jobSandboxRoot, { withFileTypes: true }) as import("fs").Dirent[]
    const items: SandboxCleanupItemResult[] = []
    for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const name = entry.name
        const validName = normalizeSandboxName(name)
        if (!validName.ok) {
            items.push({ sandbox_name: name, status: "warning", warning: validName.reason })
            continue
        }
        items.push(await deleteSandboxPath(createSandboxPaths(owner, validName.value), deps))
    }
    await cleanupEmptyJobSandboxRoot(owner, deps)

    const warnings = items.flatMap((item) => item.warning ? [item.warning] : [])
    return {
        ok: warnings.length === 0,
        status: warnings.length > 0 ? "warning" : "deleted",
        job_name: owner.jobName,
        deleted: items.filter((item) => item.status === "deleted").length,
        warnings,
        items,
        guidance,
    }
}
