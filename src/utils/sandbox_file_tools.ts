import type { OpencodeClient } from "@opencode-ai/sdk"
import { cp, lstat, realpath } from "fs/promises"
import path from "path"
import { assertSafeSandboxPath, findSandboxLookupMatches, getSandboxPaths, normalizeSandboxName, readSandboxMetadata, resolveSandboxJob, type SandboxDependencies, type SandboxLookupMatch, type SandboxMetadata, type SandboxPaths } from "@/utils/sandbox"
import { pathExists } from "@/utils/autocode_sandbox_helpers"
import { createRetryResponse } from "@/utils/tools"
import type { SessionJobContext } from "@/utils/jobs"

export type SandboxFileToolResolution =
    | { ok: true, storageRoot: string, paths: SandboxPaths, metadata: SandboxMetadata }
    | { ok: false, response: string }

export type SafeResolvedPath = {
    absolutePath: string
    relativePath: string
}

const limitationGuidance = "Sandbox uses bubblewrap (bwrap) only; proot and proot-distro metadata must be recreated."

function isPathInside(child: string, root: string): boolean {
    const relative = path.relative(root, child)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function normalizeRelativePath(input: unknown, label: string, rejectWorkspace: boolean): { ok: true, value: string } | { ok: false, reason: string } {
    if (typeof input !== "string") return { ok: false, reason: `${label} must be a string.` }
    const value = input.trim().replaceAll("\\", "/")
    if (!value) return { ok: false, reason: `${label} must be a non-empty relative path.` }
    if (value.includes("\0")) return { ok: false, reason: `${label} must not contain NUL bytes.` }
    if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return { ok: false, reason: `${label} must be relative.` }
    const normalized = path.posix.normalize(value)
    if (normalized === ".." || normalized.startsWith("../")) return { ok: false, reason: `${label} must not escape its root.` }
    if (rejectWorkspace && (normalized === "workspace" || normalized.startsWith("workspace/"))) return { ok: false, reason: `${label} must not target /workspace; /workspace is a read-only CLI mount only.` }
    return { ok: true, value: normalized }
}

async function resolveExistingSafePath(root: string, relativePath: string): Promise<{ ok: true, value: string } | { ok: false, reason: string }> {
    const resolvedRoot = await realpath(root)
    const resolvedPath = path.resolve(resolvedRoot, relativePath)
    if (!isPathInside(resolvedPath, resolvedRoot)) return { ok: false, reason: "Path must stay inside its root." }
    const existingPath = await realpath(resolvedPath).catch(() => undefined)
    if (!existingPath) return { ok: false, reason: "Path does not exist." }
    if (!isPathInside(existingPath, resolvedRoot)) return { ok: false, reason: "Symlink target must stay inside its root." }
    return { ok: true, value: existingPath }
}

export async function resolveSafeRelativePath(root: string, input: unknown, label: string, rejectWorkspace: boolean, mustExist: boolean): Promise<{ ok: true, value: SafeResolvedPath } | { ok: false, reason: string }> {
    const normalized = normalizeRelativePath(input, label, rejectWorkspace)
    if (!normalized.ok) return normalized
    const resolvedRoot = await realpath(root)
    const absolutePath = path.resolve(resolvedRoot, normalized.value)
    if (!isPathInside(absolutePath, resolvedRoot)) return { ok: false, reason: `${label} must stay inside its root.` }
    if (mustExist) {
        const existing = await resolveExistingSafePath(resolvedRoot, normalized.value)
        if (!existing.ok) return existing
        return { ok: true, value: { absolutePath: existing.value, relativePath: normalized.value } }
    }
    return { ok: true, value: { absolutePath, relativePath: normalized.value } }
}

export async function validateSafeWriteTarget(root: string, input: unknown, label: string, rejectWorkspace: boolean): Promise<{ ok: true, value: SafeResolvedPath } | { ok: false, reason: string }> {
    const target = await resolveSafeRelativePath(root, input, label, rejectWorkspace, false)
    if (!target.ok) return target
    const resolvedRoot = await realpath(root)
    const parentRealPath = await resolveNearestExistingParent(path.dirname(target.value.absolutePath), resolvedRoot)
    if (!parentRealPath.ok) return parentRealPath
    if (!isPathInside(parentRealPath.value, resolvedRoot)) return { ok: false, reason: `${label} parent symlink must stay inside its root.` }
    if (await lstat(target.value.absolutePath).then(() => true).catch(() => false)) {
        const existing = await resolveExistingSafePath(resolvedRoot, target.value.relativePath)
        if (!existing.ok) return existing
    }
    return target
}

async function resolveNearestExistingParent(parentPath: string, root: string): Promise<{ ok: true, value: string } | { ok: false, reason: string }> {
    let current = parentPath
    while (isPathInside(current, root)) {
        const resolved = await realpath(current).catch(() => undefined)
        if (resolved) return { ok: true, value: resolved }
        const next = path.dirname(current)
        if (next === current) break
        current = next
    }
    return { ok: false, reason: "Parent path must stay inside its root." }
}

export async function resolveSandboxForFileTool(client: OpencodeClient | undefined, context: SessionJobContext, deps: SandboxDependencies, sandboxNameInput: unknown, action: string): Promise<SandboxFileToolResolution> {
    const sandboxName = normalizeSandboxName(sandboxNameInput)
    if (!sandboxName.ok) return { ok: false, response: createRetryResponse(action, sandboxName.reason, "Use an existing sandbox name with lowercase letters, numbers, and underscores only.") }
    const job = await resolveSandboxJob(client, context, deps.fileSystem)
    if (!job.ok) return { ok: false, response: createRetryResponse(action, job.reason, "Start or select a planned lifecycle job before using a sandbox.") }
    const paths = getSandboxPaths(job.storageRoot, job.jobName, sandboxName.value)
    const safePath = assertSafeSandboxPath(paths.sandboxPath, paths.jobSandboxRoot)
    if (!safePath.ok) return { ok: false, response: JSON.stringify({ ok: false, status: "unsafe_path", reason: safePath.reason, guidance: limitationGuidance }) }
    const currentPathExists = await pathExists(deps, paths.sandboxPath)
    const metadata = currentPathExists ? await readSandboxMetadata(deps.fileSystem, paths.metadataFile) : undefined
    if (metadata) {
        const safeRootPath = assertSafeSandboxPath(metadata.root_path, paths.jobSandboxRoot)
        if (!safeRootPath.ok) return { ok: false, response: JSON.stringify({ ok: false, status: "unsafe_path", reason: safeRootPath.reason, guidance: limitationGuidance }) }
        return { ok: true, storageRoot: job.storageRoot, paths, metadata }
    }
    const matches = await findSandboxLookupMatches(deps.fileSystem, job.storageRoot, sandboxName.value)
    if (matches.length === 1) return { ok: true, storageRoot: job.storageRoot, paths: matches[0].paths, metadata: matches[0].metadata }
    if (matches.length > 1) return { ok: false, response: createAmbiguousSandboxResponse(sandboxName.value, matches) }
    return { ok: false, response: JSON.stringify({ ok: false, status: currentPathExists ? "missing_metadata" : "missing", sandbox_name: sandboxName.value, job_name: job.jobName, guidance: limitationGuidance }) }
}

function createAmbiguousSandboxResponse(sandboxName: string, matches: SandboxLookupMatch[]): string {
    return JSON.stringify({
        ok: false,
        status: "ambiguous",
        sandbox_name: sandboxName,
        candidate_job_names: matches.map((match) => match.paths.jobName),
        guidance: "Multiple sandboxes have this name; run from the parent job namespace or recreate/delete duplicates before executing.",
    })
}

export function sandboxRelativePath(root: string, absolutePath: string): string {
    return path.relative(root, absolutePath).replaceAll(path.sep, "/") || "."
}

export async function copyPath(source: string, target: string): Promise<void> {
    await cp(source, target, { recursive: true, force: true })
}
