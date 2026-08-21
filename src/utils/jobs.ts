import path from "node:path"
import type { Dirent } from "node:fs"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { cleanSessionTitleSuffix } from "./session_title"

export type SessionJobContext = {
    sessionID: string
    directory: string
    worktree: string
}

export type JobDesignFileSystem = {
    readdir: (directory: string, options: { withFileTypes: true }) => Promise<Dirent[]>
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
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

export type DirectoryFileSystem = {
    readdir: (dirPath: string, options?: { withFileTypes?: boolean }) => Promise<string[] | Dirent[]>
    mkdir?: JobToolFileSystem["mkdir"] | undefined
    readFile?: JobToolFileSystem["readFile"] | undefined
    rename?: JobToolFileSystem["rename"] | undefined
    rm?: JobToolFileSystem["rm"] | undefined
    stat?: JobToolFileSystem["stat"] | undefined
    writeFile?: JobToolFileSystem["writeFile"] | undefined
}

export type JobWorkspaceEntry = {
    job_name: string
    job_path: string
    absolute_path: string
}

export type ListJobWorkspacesResult = {
    jobs: JobWorkspaceEntry[]
}

export type ResolveJobWorkspaceResult =
    | { type: "found", workspace: JobWorkspaceEntry }
    | { type: "missing" }

export type JobWorkspaceIdentityResolution = {
    resolution: "found" | "missing"
    job_name?: string
    workspace?: JobWorkspaceEntry
    session_title?: string
    title_derived_candidate?: string
    warning?: string
}

export type ResolveJobWorkspaceIdentityOptions = {
    sessionOnly?: boolean
}

type SessionTitleClient = Pick<OpencodeClient, "session"> & {
    session: {
        get?: (args: { path: { id: string }, query: { directory: string } }) => Promise<{ data?: { title?: string | null }, error?: string }>
    }
}

export const jobWorkspacesDirectory = ".agents/jobs"

function resolveNonRootProjectPath(candidate: string | undefined): string | undefined {
    const trimmed = candidate?.trim()
    if (!trimmed) return undefined

    const resolved = path.resolve(trimmed)
    return resolved === path.parse(resolved).root ? undefined : resolved
}

function formatJobName(jobName: string): string {
    return jobName
        .split("_")
        .map((word: string): string => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ")
}

function readSessionID(sessionFile: string): string | undefined {
    const match = sessionFile.match(/^session_id:\s*(\S+)\s*$/m)
    return match?.[1]
}

async function readWorkspaceDirectoryNames(fileSystem: Pick<DirectoryFileSystem, "readdir">, storageRoot: string): Promise<string[]> {
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

function createJobWorkspaceEntry(storageRoot: string, workspaceName: string): JobWorkspaceEntry {
    const jobName = parseJobWorkspaceDirectory(workspaceName)
    if (jobName === undefined) {
        throw new Error(`Invalid job workspace: ${workspaceName}`)
    }

    return {
        job_name: jobName,
        job_path: `${jobWorkspacesDirectory}/${workspaceName}/`,
        absolute_path: path.join(storageRoot, jobWorkspacesDirectory, workspaceName),
    }
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

export function formatJobWorkspaceTitle(jobName: string): string {
    return formatJobName(jobName)
}

export function getRelativeConceptFilePath(label: string): string {
    if (
        label === "."
        || label === ".."
        || label.includes("/")
        || label.includes("\\")
        || path.isAbsolute(label)
        || path.win32.isAbsolute(label)
        || /^[a-zA-Z]:/.test(label)
    ) {
        throw new Error(`Invalid concept label: ${label}`)
    }

    const fileName = label.endsWith(".md") ? label : `${label}.md`
    return `.agents/concepts/${fileName}`
}

export function isMissingFile(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "ENOENT"
}

export function normalizeReaddirEntries(entries: readonly string[] | readonly Dirent[]): string[] {
    return entries
        .filter((entry: string | Dirent): boolean => typeof entry === "string" || entry.isDirectory())
        .map((entry: string | Dirent): string => typeof entry === "string" ? entry : entry.name)
}

export function createDirectoryFileSystem<T extends DirectoryFileSystem>(fileSystem: T): T & DirectoryFileSystem {
    return {
        ...fileSystem,
        readdir: async (dirPath: string, options?: { withFileTypes?: boolean }): Promise<string[]> => {
            return normalizeReaddirEntries(await fileSystem.readdir(dirPath, options))
        },
    }
}

export function isCompatibleJobName(value: string): boolean {
    return /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(value) && value.length <= 100
}

const jobDesignDirectoryTimestampPattern = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/

export function isMatchingJobDesignDirectory(directoryName: string, designName: string): boolean {
    return directoryName.length === 20 + designName.length
        && directoryName.charAt(19) === "_"
        && jobDesignDirectoryTimestampPattern.test(directoryName.slice(0, 19))
        && directoryName.slice(20) === designName
}

export function parseJobWorkspaceDirectory(directoryName: string): string | undefined {
    if (directoryName.length <= 20 || directoryName.charAt(19) !== "_" || !jobDesignDirectoryTimestampPattern.test(directoryName.slice(0, 19))) {
        return undefined
    }

    const jobName = directoryName.slice(20)
    return isCompatibleJobName(jobName) ? jobName : undefined
}

export function getJobWorkspaceFilePath(workspace: JobWorkspaceEntry, fileName: "design.md" | "plan.md" | "session.yml"): string {
    return path.join(workspace.absolute_path, fileName)
}

export async function listJobWorkspaces(
    fileSystem: Pick<DirectoryFileSystem, "readdir">,
    storageRoot: string,
): Promise<ListJobWorkspacesResult> {
    const workspaceNames = await readWorkspaceDirectoryNames(fileSystem, storageRoot)
    return { jobs: workspaceNames.map((workspaceName: string): JobWorkspaceEntry => createJobWorkspaceEntry(storageRoot, workspaceName)) }
}

export async function resolveJobWorkspace(
    fileSystem: Pick<DirectoryFileSystem, "readdir">,
    storageRoot: string,
    jobName: string,
): Promise<ResolveJobWorkspaceResult> {
    if (!isCompatibleJobName(jobName)) return { type: "missing" }

    const workspaceName = (await readWorkspaceDirectoryNames(fileSystem, storageRoot))
        .find((candidate: string): boolean => parseJobWorkspaceDirectory(candidate) === jobName)
    return workspaceName === undefined
        ? { type: "missing" }
        : { type: "found", workspace: createJobWorkspaceEntry(storageRoot, workspaceName) }
}

async function resolveJobWorkspaceBySessionID(
    fileSystem: Pick<JobToolFileSystem, "readFile" | "readdir">,
    storageRoot: string,
    sessionID: string,
): Promise<JobWorkspaceEntry | undefined> {
    const workspaceNames = await readWorkspaceDirectoryNames(fileSystem, storageRoot)
    for (const workspaceName of workspaceNames) {
        const workspace = createJobWorkspaceEntry(storageRoot, workspaceName)
        try {
            const content = await fileSystem.readFile(getJobWorkspaceFilePath(workspace, "session.yml"), "utf8")
            if (readSessionID(content) === sessionID) return workspace
        }
        catch (error) {
            if (!isMissingFile(error)) throw error
        }
    }

    return undefined
}

async function resolveUniqueJobWorkspaceBySessionID(
    fileSystem: Pick<JobToolFileSystem, "readFile" | "readdir">,
    storageRoot: string,
    sessionID: string,
): Promise<JobWorkspaceEntry> {
    const matchingWorkspaces: JobWorkspaceEntry[] = []
    const workspaceNames = await readWorkspaceDirectoryNames(fileSystem, storageRoot)
    for (const workspaceName of workspaceNames) {
        const workspace = createJobWorkspaceEntry(storageRoot, workspaceName)
        let content: string
        try {
            content = await fileSystem.readFile(getJobWorkspaceFilePath(workspace, "session.yml"), "utf8")
        }
        catch (error) {
            if (isMissingFile(error)) continue

            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`Unable to read job workspace session metadata at ${workspace.job_path}session.yml: ${message}`)
        }

        const workspaceSessionID = readSessionID(content)
        if (workspaceSessionID === undefined) {
            throw new Error(`Invalid job workspace session metadata at ${workspace.job_path}session.yml: session_id is required.`)
        }
        if (workspaceSessionID === sessionID) matchingWorkspaces.push(workspace)
    }

    if (matchingWorkspaces.length === 0) {
        throw new Error(`No job workspace is owned by current session: ${sessionID}. Ensure session.yml records current session_id.`)
    }
    if (matchingWorkspaces.length > 1) {
        throw new Error(`Multiple job workspaces are owned by current session: ${sessionID}. Remove stale session.yml ownership metadata before retrying.`)
    }

    return matchingWorkspaces[0]
}

export async function resolveJobWorkspaceIdentity(
    fileSystem: Pick<JobToolFileSystem, "readFile" | "readdir">,
    client: OpencodeClient | undefined,
    context: Pick<SessionJobContext, "sessionID" | "directory"> & Partial<Pick<SessionJobContext, "worktree">>,
    options: ResolveJobWorkspaceIdentityOptions = {},
): Promise<JobWorkspaceIdentityResolution> {
    const storageRoot = resolveAgentsStorageRoot({
        directory: context.directory,
        worktree: context.worktree ?? context.directory,
    })
    if (options.sessionOnly) {
        const workspace = await resolveUniqueJobWorkspaceBySessionID(fileSystem, storageRoot, context.sessionID)
        return {
            resolution: "found",
            job_name: workspace.job_name,
            workspace,
        }
    }

    const currentSession = await getCurrentSessionTitle(client, context)
    const sessionTitle = currentSession.title
    const titleDerivedCandidate = sessionTitle
        ? deriveJobNameFromTitle(cleanSessionTitleSuffix(sessionTitle))
        : undefined
    const persistedWorkspace = await resolveJobWorkspaceBySessionID(fileSystem, storageRoot, context.sessionID)

    if (persistedWorkspace !== undefined) {
        return {
            resolution: "found",
            job_name: persistedWorkspace.job_name,
            workspace: persistedWorkspace,
            session_title: sessionTitle,
            title_derived_candidate: titleDerivedCandidate,
            warning: currentSession.warning,
        }
    }

    if (!titleDerivedCandidate) {
        return {
            resolution: "missing",
            session_title: sessionTitle,
            warning: currentSession.warning,
        }
    }

    const resolved = await resolveJobWorkspace(fileSystem, storageRoot, titleDerivedCandidate)
    return resolved.type === "found"
        ? {
            resolution: "found",
            job_name: resolved.workspace.job_name,
            workspace: resolved.workspace,
            session_title: sessionTitle,
            title_derived_candidate: titleDerivedCandidate,
            warning: currentSession.warning,
        }
        : {
            resolution: "missing",
            job_name: titleDerivedCandidate,
            session_title: sessionTitle,
            title_derived_candidate: titleDerivedCandidate,
            warning: currentSession.warning,
        }
}

export async function findLatestJobDesignFile(fileSystem: JobDesignFileSystem, storageRoot: string, designName: string): Promise<{ content: string, path: string } | undefined> {
    const jobsDirectory = path.join(storageRoot, jobWorkspacesDirectory)
    let entries: Dirent[]
    try {
        entries = await fileSystem.readdir(jobsDirectory, { withFileTypes: true })
    }
    catch (error) {
        if (isMissingFile(error)) return undefined
        throw error
    }

    const matchingDirectories = entries
        .filter((entry: Dirent): boolean => entry.isDirectory() && isMatchingJobDesignDirectory(entry.name, designName))
        .sort((left: Dirent, right: Dirent): number => right.name.localeCompare(left.name))
    for (const directory of matchingDirectories) {
        const designPath = path.join(jobsDirectory, directory.name, "design.md")
        try {
            return { content: await fileSystem.readFile(designPath, "utf8"), path: designPath }
        }
        catch (error) {
            if (!isMissingFile(error)) throw error
        }
    }

    return undefined
}

export async function getCurrentSessionTitle(
    client: OpencodeClient | undefined,
    context: Pick<SessionJobContext, "sessionID" | "directory">,
): Promise<{ title?: string, warning?: string }> {
    const sessionClient = client as SessionTitleClient | undefined
    if (!sessionClient?.session.get) {
        return { warning: "Current session title lookup is unavailable; provide a title if needed." }
    }

    try {
        const response = await sessionClient.session.get({
            path: { id: context.sessionID },
            query: { directory: context.directory },
        })
        const title = response.data?.title?.trim()
        if (!title) {
            return { warning: `Unable to read current session title: ${response.error ?? context.sessionID}` }
        }

        return { title }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { warning: `Unable to read current session title: ${message}` }
    }
}
