import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import path from "path"
import { createAbortResponse, createRetryResponse, flattenError } from "@/utils/tools"
import { assertSafeSandboxDeletionPath, assertSafeSandboxPath, cleanupExpiredSandboxCacheEntries, defaultSandboxDependencies, detectEffectiveSandboxSyncMethod, detectSandboxBackend, ensureSandboxRootfsCache, getSandboxPaths, materializeSandboxRootfs, normalizeOptionalDistro, normalizeSandboxName, readSandboxMetadata, resolveSandboxJob, writeSandboxMetadata, type EffectiveSandboxSyncMethod, type SandboxConfig, type SandboxDependencies, type SandboxDistro, type SandboxMetadata } from "@/utils/sandbox"
import { addBubblewrapBind, addOptionalBubblewrapReadOnlyBind, bubblewrapQuickEtcReadOnlyBinds, bubblewrapQuickRootReadOnlyBinds, pathExists } from "@/utils/autocode_sandbox_helpers"

const limitationGuidance = "Sandbox uses bubblewrap (bwrap) only; proot and proot-distro are unsupported."

type InternetValidationCleanupDiagnostics = {
    attempted_path: string
    success: boolean
    status: "succeeded" | "failed" | "skipped"
    reason?: string
    error?: string
}

function createMetadata(sandboxName: string, jobName: string, distro: SandboxDistro | "quick", backend: SandboxMetadata["backend"], rootPath: string, backendData?: SandboxMetadata["backend_data"]): SandboxMetadata {
    const now = new Date().toISOString()
    return {
        sandbox_name: sandboxName,
        job_name: jobName,
        distro,
        backend,
        root_path: rootPath,
        created_at: now,
        updated_at: now,
        backend_data: backendData,
    }
}

function internetEnabled(input: unknown): boolean {
    return input === true
}

async function createBubblewrapSandbox(deps: SandboxDependencies, paths: ReturnType<typeof getSandboxPaths>, distro: SandboxDistro | "quick", backendData: SandboxMetadata["backend_data"]): Promise<SandboxMetadata | string> {
    const safePath = assertSafeSandboxPath(paths.sandboxPath, paths.jobSandboxRoot)
    if (!safePath.ok) return JSON.stringify({ ok: false, status: "unsafe_path", reason: safePath.reason, guidance: limitationGuidance })

    await deps.fileSystem.mkdir(safePath.value, { recursive: true })
    await deps.fileSystem.mkdir(`${safePath.value}/home/root`, { recursive: true })
    const metadata = createMetadata(paths.sandboxName, paths.jobName, distro, "bubblewrap", safePath.value, backendData)
    await writeSandboxMetadata(deps.fileSystem, paths.metadataFile, metadata)
    return metadata
}

async function validateInternet(deps: SandboxDependencies, metadata: SandboxMetadata): Promise<{ ok: true } | { ok: false, diagnostics: Record<string, unknown> }> {
    const filesystemMode = metadata.backend_data?.filesystem_mode === "rootfs" ? "rootfs" : "quick"
    const rootfsPath = typeof metadata.backend_data?.rootfs_path === "string" ? metadata.backend_data.rootfs_path : undefined
    const args = ["--die-with-parent", "--unshare-all", "--share-net", "--new-session"]
    if (filesystemMode === "rootfs" && rootfsPath) {
        addBubblewrapBind(args, rootfsPath, "/", false)
    }
    else {
        for (const hostPath of bubblewrapQuickRootReadOnlyBinds) {
            await addOptionalBubblewrapReadOnlyBind(deps, args, hostPath)
        }
    }
    args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/sandbox", "--dir", "/home", "--setenv", "PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
    if (filesystemMode === "quick") args.push("--dir", "/etc")
    if (filesystemMode === "quick") {
        for (const hostPath of bubblewrapQuickEtcReadOnlyBinds) {
            await addOptionalBubblewrapReadOnlyBind(deps, args, hostPath)
        }
    }
    else if (await pathExists(deps, "/etc/resolv.conf")) {
        addBubblewrapBind(args, "/etc/resolv.conf", "/etc/resolv.conf", true)
    }
    args.push("--bind", metadata.root_path, "/sandbox", "--bind", path.join(metadata.root_path, "home"), "/home", "/bin/sh", "-lc", "(command -v curl >/dev/null && curl -fsSI https://github.com >/dev/null) || (command -v wget >/dev/null && wget -q --spider https://github.com)")
    const result = await deps.spawn("bwrap", args, { env: deps.process.env })
    if (result.exitCode === 0) return { ok: true }
    return { ok: false, diagnostics: { error: "GitHub connectivity validation failed.", stdout: result.stdout, stderr: result.stderr, status: result.exitCode, command: `bwrap ${args.join(" ")}`, context: { url: "https://github.com", filesystem_mode: filesystemMode } } }
}

async function cleanupInternetValidationFailure(deps: SandboxDependencies, sandboxPath: string): Promise<InternetValidationCleanupDiagnostics> {
    if (!deps.fileSystem.rm) {
        return { attempted_path: sandboxPath, success: false, status: "skipped", reason: "rm unavailable" }
    }

    try {
        await deps.fileSystem.rm(sandboxPath, { recursive: true, force: true })
        return { attempted_path: sandboxPath, success: true, status: "succeeded" }
    }
    catch (error) {
        return { attempted_path: sandboxPath, success: false, status: "failed", reason: "rm threw", error: flattenError(error) }
    }
}

function createSuccessResponse(paths: ReturnType<typeof getSandboxPaths>, metadata: SandboxMetadata, repaired: boolean): string {
    const backendData = metadata.backend_data ?? {}
    return JSON.stringify({
        ok: true,
        status: "created",
        backend: "bubblewrap",
        sandbox_name: paths.sandboxName,
        job_name: paths.jobName,
        sandbox_path: paths.sandboxPath,
        root_path: metadata.root_path,
        distro: metadata.distro,
        distro_mode: backendData.distro_mode ?? "quick",
        filesystem_mode: backendData.filesystem_mode ?? "quick",
        internet_enabled: backendData.internet_enabled === true,
        rootfs_path: backendData.rootfs_path,
        cache_entry_path: backendData.cache_entry_path,
        cache_rootfs_path: backendData.cache_rootfs_path,
        requested_sync_method: backendData.requested_sync_method,
        effective_sync_method: backendData.effective_sync_method,
        ...(repaired ? { repaired: true } : {}),
        guidance: limitationGuidance,
    })
}

function createInternetValidationFailureResponse(validationDiagnostics: Record<string, unknown>, cleanupDiagnostics: InternetValidationCleanupDiagnostics): string {
    const { status: validationStatus, ...topLevelDiagnostics } = validationDiagnostics
    return JSON.stringify({
        ok: false,
        status: "internet_validation_failed",
        ...topLevelDiagnostics,
        validation_diagnostics: validationDiagnostics,
        ...(validationStatus !== undefined ? { validation_status: validationStatus } : {}),
        cleanup_diagnostics: cleanupDiagnostics,
        guidance: limitationGuidance,
    })
}

export function createAutocodeSandboxCreateTool(client?: OpencodeClient, deps: SandboxDependencies = defaultSandboxDependencies, sandboxConfig: SandboxConfig = {}) {
    return tool({
        description: "Create sandbox environment when you need to test deployments, isolate dependency problem, run experimental scripts in isolated environment. Always run `autocode_sandbox_create` before tasking `execute_sandbox` agents. Omit `distro` for fast startup using read-only host OS filesystem mounts. Use `alpine` for isolated OS/installation testing and experimentation. Use `debian` when Alpine is incompatible with project dependencies or glibc expectations.",
        args: {
            sandbox_name: tool.schema.string().describe("Lowercase sandbox name using letters, numbers, and underscores only."),
            distro: tool.schema.string().optional().describe("One of: alpine, debian, ubuntu, archlinux, opensuse. Omit or leave blank for quick mode."),
            internet_enabled: tool.schema.boolean().optional().describe("Enable sandbox network access; defaults to false."),
        },
        async execute(args, context) {
            const sandboxName = normalizeSandboxName(args.sandbox_name)
            if (!sandboxName.ok) return createRetryResponse("create sandbox", sandboxName.reason, "Use lowercase letters, numbers, and underscores only.")
            const distro = normalizeOptionalDistro(args.distro)
            if (!distro.ok) return createRetryResponse("create sandbox", distro.reason, "Use alpine, debian, ubuntu, archlinux, opensuse, or omit distro for quick mode.")
            const network = internetEnabled(args.internet_enabled)

            try {
                const job = await resolveSandboxJob(client, context, deps.fileSystem)
                if (!job.ok) return createRetryResponse("create sandbox", job.reason, "Start or select a planned lifecycle job before creating a sandbox.")
                const paths = getSandboxPaths(job.storageRoot, job.jobName, sandboxName.value)
                const safePath = assertSafeSandboxPath(paths.sandboxPath, paths.jobSandboxRoot)
                if (!safePath.ok) return JSON.stringify({ ok: false, status: "unsafe_path", reason: safePath.reason, guidance: limitationGuidance })
                let repaired = false
                if (await pathExists(deps, paths.sandboxPath)) {
                    const metadata = await readSandboxMetadata(deps.fileSystem, paths.metadataFile)
                    if (metadata) return JSON.stringify({ ok: true, status: "exists", warning: "Sandbox already exists; not overwriting.", sandbox_name: sandboxName.value, job_name: job.jobName, sandbox_path: paths.sandboxPath, guidance: limitationGuidance })

                    const safeDeletionPath = assertSafeSandboxDeletionPath(paths.sandboxPath, paths.storageRoot, paths.jobSandboxRoot)
                    if (!safeDeletionPath.ok) return JSON.stringify({ ok: false, status: "unsafe_path", reason: safeDeletionPath.reason, guidance: limitationGuidance })
                    if (!deps.fileSystem.rm) return JSON.stringify({ ok: false, status: "stale_directory_error", reason: "Unable to remove stale sandbox directory: rm is unavailable.", sandbox_name: sandboxName.value, job_name: job.jobName, sandbox_path: paths.sandboxPath, guidance: limitationGuidance })
                    await deps.fileSystem.rm(safeDeletionPath.value, { recursive: true, force: true })
                    repaired = true
                }

                const backend = await detectSandboxBackend(deps)
                if (backend.backend === "macos_unsupported" || backend.backend === "unsupported") {
                    return JSON.stringify({ ok: false, status: "unsupported", backend: backend.backend, reason: backend.reason, guidance: backend.guidance ?? limitationGuidance, signals: backend.signals })
                }
                const requestedSyncMethod = sandboxConfig.sync_method ?? "auto"
                let effectiveSyncMethod: EffectiveSandboxSyncMethod | undefined
                let backendData: SandboxMetadata["backend_data"] = { bwrap: "bwrap", policy: "autocode_bubblewrap_v1", internet_enabled: network }
                if (distro.value) {
                    effectiveSyncMethod = await detectEffectiveSandboxSyncMethod(sandboxConfig, deps)
                    const cache = await ensureSandboxRootfsCache(distro.value, sandboxConfig, deps)
                    if (!cache.ok) return JSON.stringify({ ok: false, status: cache.status ?? "rootfs_error", reason: cache.reason, stdout: cache.stdout, stderr: cache.stderr, exit_code: cache.exit_code, command: cache.command, guidance: limitationGuidance })
                    const rootfsPath = path.join(safePath.value, "rootfs")
                    const actualSyncMethod = await materializeSandboxRootfs(cache.cache.rootfs_path, rootfsPath, effectiveSyncMethod, deps)
                    await cleanupExpiredSandboxCacheEntries(cache.cache, paths.storageRoot, sandboxConfig, actualSyncMethod, deps)
                    backendData = { ...backendData, distro_mode: "rootfs", filesystem_mode: "rootfs", rootfs_path: rootfsPath, cache_entry_path: cache.cache.entry_path, cache_rootfs_path: cache.cache.rootfs_path, requested_sync_method: requestedSyncMethod, effective_sync_method: actualSyncMethod, cache_source_url: cache.cache.source_url, cache_version: cache.cache.version, cache_architecture: cache.cache.architecture }
                }
                else {
                    backendData = { ...backendData, distro_mode: "quick", filesystem_mode: "quick", requested_sync_method: requestedSyncMethod }
                }
                const metadataResult = await createBubblewrapSandbox(deps, paths, distro.value ?? "quick", backendData)
                if (typeof metadataResult === "string") return metadataResult
                if (network) {
                    const validation = await validateInternet(deps, metadataResult)
                    if (!validation.ok) {
                        const cleanupDiagnostics = await cleanupInternetValidationFailure(deps, paths.sandboxPath)
                        return createInternetValidationFailureResponse(validation.diagnostics, cleanupDiagnostics)
                    }
                }
                return createSuccessResponse(paths, metadataResult, repaired)
            }
            catch (error) {
                return createAbortResponse("create sandbox", error)
            }
        },
    })
}
