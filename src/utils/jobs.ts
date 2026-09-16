import path from "node:path"
import type { Dirent } from "node:fs"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { cleanSessionTitleSuffix } from "./session_title"

export type SessionJobContext = {
    sessionID: string
    directory: string
    worktree: string
}

export type JobToolFileSystem = {
    mkdir: (dirPath: string, options?: { recursive?: boolean }) => Promise<string | undefined>
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
    readdir: (dirPath: string, options?: { withFileTypes?: boolean }) => Promise<string[] | Dirent[]>
    rename: (oldPath: string, newPath: string) => Promise<void>
    rm: (filePath: string, options?: { recursive?: boolean, force?: boolean }) => Promise<void>
    stat: (filePath: string) => Promise<unknown>
    writeFile: (filePath: string, content: string) => Promise<void>
}

export type JobWorkspaceEntry = {
    job_name: string
    job_path: string
    absolute_path: string
}

export type ListJobWorkspacesResult = {
    jobs: JobWorkspaceEntry[]
}

export type EnsureSessionJobWorkspaceOptions = {
    now?: () => Date
}

type SessionTitleClient = Pick<OpencodeClient, "session"> & {
    session: {
        get?: (args: { path: { id: string }, query: { directory: string } }) => Promise<{
            data?: { title?: string | null }
            error?: string
        }>
    }
}

export const jobWorkspacesDirectory = ".agents/jobs"

const workspaceTimestampPattern = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/
const workspaceCreationAttempts = 10
const workspaceLocks = new Map<string, Promise<JobWorkspaceEntry>>()

function resolveNonRootProjectPath(candidate: string | undefined): string | undefined {
    const trimmed = candidate?.trim()
    if (!trimmed) return undefined
    const resolved = path.resolve(trimmed)
    return resolved === path.parse(resolved).root ? undefined : resolved
}

function createJobWorkspaceEntry(storageRoot: string, workspaceName: string): JobWorkspaceEntry {
    const jobName = parseJobWorkspaceDirectory(workspaceName)
    if (jobName === undefined) throw new Error(`Invalid job workspace: ${workspaceName}`)
    return {
        job_name: jobName,
        job_path: `${jobWorkspacesDirectory}/${workspaceName}/`,
        absolute_path: path.join(storageRoot, jobWorkspacesDirectory, workspaceName),
    }
}

function isExistingDirectory(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
}

function createWorkspaceTimestamp(now: () => Date): string {
    return now().toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-")
}

function createCollisionWorkspaceName(timestamp: string, jobName: string, attempt: number): string {
    if (attempt === 0) return `${timestamp}_${jobName}`
    const suffix = `_${attempt + 1}`
    return `${timestamp}_${jobName.slice(0, 100 - suffix.length)}${suffix}`
}

function isPathInside(candidatePath: string, rootPath: string): boolean {
    const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath))
    return Boolean(relativePath) && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
}

async function readWorkspaceDirectoryNames(fileSystem: Pick<JobToolFileSystem, "readdir">, storageRoot: string): Promise<string[]> {
    try {
        return normalizeReaddirEntries(await fileSystem.readdir(path.join(storageRoot, jobWorkspacesDirectory)))
            .filter((entry: string): boolean => parseJobWorkspaceDirectory(entry) !== undefined)
            .sort((left: string, right: string): number => left === right ? 0 : left < right ? 1 : -1)
    }
    catch (error) {
        if (isMissingFile(error)) return []
        throw error
    }
}

async function findWorkspaceForTitle(fileSystem: Pick<JobToolFileSystem, "readdir">, storageRoot: string, jobName: string): Promise<JobWorkspaceEntry | undefined> {
    const workspaceName = (await readWorkspaceDirectoryNames(fileSystem, storageRoot))
        .find((candidate: string): boolean => parseJobWorkspaceDirectory(candidate) === jobName)
    return workspaceName === undefined ? undefined : createJobWorkspaceEntry(storageRoot, workspaceName)
}

async function ensureSessionJobWorkspaceUnlocked(
    fileSystem: Pick<JobToolFileSystem, "mkdir" | "readdir">,
    storageRoot: string,
    jobName: string,
    options: EnsureSessionJobWorkspaceOptions,
): Promise<JobWorkspaceEntry> {
    const existing = await findWorkspaceForTitle(fileSystem, storageRoot, jobName)
    if (existing) return existing

    const jobsRoot = path.join(storageRoot, jobWorkspacesDirectory)
    await fileSystem.mkdir(jobsRoot, { recursive: true })
    const timestamp = createWorkspaceTimestamp(options.now ?? (() => new Date()))
    for (let attempt = 0; attempt < workspaceCreationAttempts; attempt += 1) {
        const workspace = createJobWorkspaceEntry(storageRoot, createCollisionWorkspaceName(timestamp, jobName, attempt))
        if (!isPathInside(workspace.absolute_path, jobsRoot)) throw new Error("Resolved job workspace path is unsafe.")
        try {
            await fileSystem.mkdir(workspace.absolute_path)
            return workspace
        }
        catch (error) {
            if (!isExistingDirectory(error)) throw error
            const concurrentWorkspace = await findWorkspaceForTitle(fileSystem, storageRoot, jobName)
            if (concurrentWorkspace) return concurrentWorkspace
        }
    }
    throw new Error("Unable to create unique timestamped job workspace; retry setup.")
}

export function resolveAgentsStorageRoot(context: Pick<SessionJobContext, "directory" | "worktree">): string {
    return resolveNonRootProjectPath(context.worktree)
        ?? resolveNonRootProjectPath(context.directory)
        ?? context.worktree
}

export function deriveJobNameFromTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 100)
}

export function getRelativeConceptFilePath(label: string): string {
    if (label === "." || label === ".." || label.includes("/") || label.includes("\\") || path.isAbsolute(label) || path.win32.isAbsolute(label) || /^[a-zA-Z]:/.test(label)) {
        throw new Error(`Invalid concept label: ${label}`)
    }
    return `.agents/concepts/${label.endsWith(".md") ? label : `${label}.md`}`
}

export function isMissingFile(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

export function normalizeReaddirEntries(entries: readonly string[] | readonly Dirent[]): string[] {
    return entries
        .filter((entry: string | Dirent): boolean => typeof entry === "string" || entry.isDirectory())
        .map((entry: string | Dirent): string => typeof entry === "string" ? entry : entry.name)
}

export function isCompatibleJobName(value: string): boolean {
    return /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(value) && value.length <= 100
}

export function parseJobWorkspaceDirectory(directoryName: string): string | undefined {
    if (directoryName.length <= 20 || directoryName.charAt(19) !== "_" || !workspaceTimestampPattern.test(directoryName.slice(0, 19))) return undefined
    const jobName = directoryName.slice(20)
    return isCompatibleJobName(jobName) ? jobName : undefined
}

export async function listJobWorkspaces(fileSystem: Pick<JobToolFileSystem, "readdir">, storageRoot: string): Promise<ListJobWorkspacesResult> {
    const workspaceNames = await readWorkspaceDirectoryNames(fileSystem, storageRoot)
    return { jobs: workspaceNames.map((workspaceName: string): JobWorkspaceEntry => createJobWorkspaceEntry(storageRoot, workspaceName)) }
}

export async function getCurrentSessionTitle(client: OpencodeClient | undefined, context: Pick<SessionJobContext, "sessionID" | "directory">): Promise<{ title?: string, warning?: string }> {
    const sessionClient = client as SessionTitleClient | undefined
    if (!sessionClient?.session.get) return { warning: "Current session title lookup is unavailable." }
    try {
        const response = await sessionClient.session.get({ path: { id: context.sessionID }, query: { directory: context.directory } })
        const title = response.data?.title?.trim()
        return title ? { title } : { warning: `Unable to read current session title: ${response.error ?? context.sessionID}` }
    }
    catch (error) {
        return { warning: `Unable to read current session title: ${error instanceof Error ? error.message : String(error)}` }
    }
}

export async function findSessionJobWorkspace(
    fileSystem: Pick<JobToolFileSystem, "readdir">,
    client: OpencodeClient | undefined,
    context: SessionJobContext,
): Promise<JobWorkspaceEntry | undefined> {
    const currentSession = await getCurrentSessionTitle(client, context)
    if (!currentSession.title) return undefined
    const jobName = deriveJobNameFromTitle(cleanSessionTitleSuffix(currentSession.title))
    if (!jobName) return undefined
    return await findWorkspaceForTitle(fileSystem, path.resolve(resolveAgentsStorageRoot(context)), jobName)
}

export async function ensureSessionJobWorkspace(
    fileSystem: Pick<JobToolFileSystem, "mkdir" | "readdir">,
    client: OpencodeClient | undefined,
    context: SessionJobContext,
    options: EnsureSessionJobWorkspaceOptions = {},
): Promise<JobWorkspaceEntry> {
    const storageRoot = path.resolve(resolveAgentsStorageRoot(context))
    if (storageRoot === path.parse(storageRoot).root) throw new Error("Current job storage root is invalid.")
    const currentSession = await getCurrentSessionTitle(client, context)
    if (!currentSession.title) throw new Error(currentSession.warning ?? "Current session title is required.")
    const jobName = deriveJobNameFromTitle(cleanSessionTitleSuffix(currentSession.title))
    if (!jobName) throw new Error("Current session title must contain letters or numbers.")
    const lockKey = `${storageRoot}\u0000${jobName}`
    const locked = workspaceLocks.get(lockKey)
    if (locked) return await locked
    const creation = ensureSessionJobWorkspaceUnlocked(fileSystem, storageRoot, jobName, options)
    workspaceLocks.set(lockKey, creation)
    try {
        return await creation
    }
    finally {
        if (workspaceLocks.get(lockKey) === creation) workspaceLocks.delete(lockKey)
    }
}
