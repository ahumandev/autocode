import path from "path"
import type { AssistantMessage, Message, OpencodeClient, Part } from "@opencode-ai/sdk"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "fs/promises"
import type { Dirent } from "fs"
import { readLatestSolutionStatus } from "./solution"

export const activeJobLifecycleDirectories = ["concepts", "drafts", "assist", "executing", "facilitate", "review"] as const
export const completedJobLifecycleDirectory = "shelved" as const
export const jobStatuses = ["concepts", "drafts", "assist", "executing", "facilitate", "review", "shelved"] as const
export const listedActiveJobStatuses = ["concepts", "drafts", "assist", "executing", "facilitate", "review"] as const satisfies readonly JobStatus[]
export const selectableExecutionJobStatuses = ["drafts", "assist", "executing"] as const satisfies readonly JobStatus[]

export type ActiveJobLifecycleDirectory = typeof activeJobLifecycleDirectories[number]
export type CompletedJobLifecycleDirectory = typeof completedJobLifecycleDirectory
export type JobStatus = typeof jobStatuses[number]
export type JobDirectory = ActiveJobLifecycleDirectory | CompletedJobLifecycleDirectory

const canonicalDirectoryPriority: readonly JobDirectory[] = [
    ...activeJobLifecycleDirectories,
    completedJobLifecycleDirectory,
]

export type SessionJobContext = {
    sessionID: string
    directory: string
    worktree: string
}

function resolveNonRootProjectPath(candidate: string | undefined): string | undefined {
    const trimmed = candidate?.trim()
    if (!trimmed) return undefined

    const resolved = path.resolve(trimmed)
    return resolved === path.parse(resolved).root ? undefined : resolved
}

export function resolveAgentsStorageRoot(context: Pick<SessionJobContext, "directory" | "worktree">): string {
    return resolveNonRootProjectPath(context.worktree)
        ?? resolveNonRootProjectPath(context.directory)
        ?? context.worktree
}

export function getStorageRelativePath(storageRoot: string, filePath: string): string {
    if (!storageRoot.trim()) return filePath

    const relativePath = path.relative(storageRoot, filePath)
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return filePath
    }

    return relativePath.split(path.sep).join("/")
}

type SessionMessage = {
    info: Message
    parts: Part[]
}

type SessionTitleClient = Pick<OpencodeClient, "session"> & {
    session: {
        get?: (args: { path: { id: string }, query: { directory: string } }) => Promise<{ data?: { title?: string | null }, error?: string }>
        update?: (args: { path: { id: string }, query: { directory: string }, body: { title: string } }) => Promise<{ data?: unknown, error?: string }>
    }
}

type SessionMessagesClient = Pick<OpencodeClient, "session"> & {
    session: {
        messages?: (args: { path: { id: string }, query: { directory: string, limit: number } }) => Promise<{ data?: SessionMessage[], error?: string }>
    }
}

type UserSessionTitleFallback = {
    title: string
}

type DirectoryEntry = {
    name: string
    isDirectory: boolean
    isFile: boolean
}

type ReadFileSystem = {
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
}

export type DirectoryFileSystem = ReadFileSystem & {
    mkdir: (dirPath: string, options?: { recursive?: boolean }) => Promise<string | undefined | void>
    readdir: (dirPath: string, options: { withFileTypes: true }) => Promise<Dirent[]>
    rename?: (oldPath: string, newPath: string) => Promise<void>
    rm?: (path: string, options?: { recursive?: boolean, force?: boolean }) => Promise<void>
    stat: (path: string) => Promise<{ mtimeMs: number }>
    writeFile: (filePath: string, content: string) => Promise<void>
}

export type JobToolFileSystem = {
    mkdir: (dirPath: string, options?: { recursive?: boolean }) => Promise<string | undefined | void>
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
    readdir: (dirPath: string, options?: { withFileTypes?: boolean }) => Promise<string[] | Dirent[]>
    rename?: (oldPath: string, newPath: string) => Promise<void>
    rm?: (path: string, options?: { recursive?: boolean, force?: boolean }) => Promise<void>
    stat: (path: string) => Promise<{ mtimeMs: number }>
    writeFile: (filePath: string, content: string) => Promise<void>
}

export type PlannedJobListItem = {
    label: string
    job_name: string
    status: JobStatus
    job_path: string
    description: string
}

export type PlannedJobListResult = {
    jobs: PlannedJobListItem[]
    collisions: PlannedJobCollision[]
}

export type MoveJobFileSystem = DirectoryFileSystem & {
    rename: (oldPath: string, newPath: string) => Promise<void>
}

type ResolveOptions = {
    includeShelved?: boolean
    ignoreCollisions?: boolean
}

type ResolvePlannedJobIdentityOptions = ResolveOptions & {
    jobNameOverride?: string
}

export type PlannedJobIdentityResolution = {
    mode: "planned" | "ad_hoc"
    resolution: "found" | "missing" | "collision" | "no_title" | "title_unavailable" | "title_read_failed"
    explicit_override: boolean
    job_name?: string
    resolved_job?: ResolvedPlannedJob
    collision?: PlannedJobCollision
    session_title?: string
    title_derived_candidate?: string
    warning?: string
}

type StatusReportInfo = {
    fileName: string
    timestamp: string
    status: JobStatus
    suffix: number
}

async function readDirectory(filePath: string, options: { withFileTypes: true }): Promise<Dirent[]> {
    return readdir(filePath, options)
}

const defaultDirectoryFileSystem: DirectoryFileSystem = {
    mkdir,
    readFile,
    readdir: readDirectory,
    rm,
    stat,
    writeFile,
}

const defaultMoveJobFileSystem: MoveJobFileSystem = {
    ...defaultDirectoryFileSystem,
    rename,
}

export type ResolvedPlannedJob = {
    job_name: string
    status: JobStatus
    directory: JobDirectory
    absolute_path: string
    job_path: string
    relative_job_path: string
}

export type PlannedJobCollision = {
    job_name: string
    entries: ResolvedPlannedJob[]
}

export type StartLifecycleTransition = "draft_to_executing" | "resume_to_executing" | "already_executing"

export type ScannedPlannedJobs = {
    jobs: ResolvedPlannedJob[]
    collisions: PlannedJobCollision[]
}

type ResolvePlannedJobResult =
    | { type: "found", job: ResolvedPlannedJob }
    | { type: "missing" }
    | { type: "collision", collision: PlannedJobCollision }

export type MovePlannedJobResult =
    | { type: "success", job: ResolvedPlannedJob, from_status: JobStatus }
    | { type: "missing" }
    | { type: "collision", collision: PlannedJobCollision }
    | { type: "destination_collision", destinationDir: string }

export type MovePlannedJobOptions = {
    shelvedCollisionTimestamp?: Date
}

type ResolvePlannedJobBySessionResult = ResolvePlannedJobResult

export function isMissingFile(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
}

function parsePersistedSessionID(content: string): string | undefined {
    return content.match(/^\s*session_id\s*:\s*(\S+)\s*$/m)?.[1]?.trim() || undefined
}

export function normalizeReaddirEntries(entries: Array<string | Dirent>): Dirent[] {
    return entries.map((entry) => typeof entry === "string"
        ? ({ name: entry, isDirectory: () => !/\.[^/]+$/.test(entry), isFile: () => /\.[^/]+$/.test(entry) } as Dirent)
        : entry)
}

function isCollisionError(error: unknown): boolean {
    return ["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")
}

function createDirectoryScanFileSystem(fileSystem: Pick<JobToolFileSystem, "readFile" | "readdir">): Pick<DirectoryFileSystem, "readFile" | "readdir"> {
    return {
        readFile: fileSystem.readFile,
        readdir: async (dirPath: string, options: { withFileTypes: true }): Promise<Dirent[]> => {
            const entries = await fileSystem.readdir(dirPath, options)
            return normalizeReaddirEntries(entries)
        },
    }
}

export function getPlannedJobDescription(planMarkdown: string): string {
    const line = planMarkdown
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find((entry) => entry !== "" && !entry.startsWith("#") && !/^---+$/.test(entry)) ?? ""

    return line.length > 80 ? `${line.slice(0, 80)}...` : line
}

async function readPlannedJobDescription(
    fileSystem: Pick<JobToolFileSystem, "readFile">,
    worktree: string,
    job: ResolvedPlannedJob,
): Promise<string> {
    const planPath = getJobFilePath(worktree, job.directory, job.job_name, "plan.md")

    try {
        const content = await fileSystem.readFile(planPath, "utf8")
        return getPlannedJobDescription(content)
    }
    catch (error) {
        if (isMissingFile(error)) {
            return ""
        }

        throw error
    }
}

export async function listPlannedJobs(
    fileSystem: Pick<JobToolFileSystem, "readFile" | "readdir">,
    worktree: string,
    options: {
        filter?: JobStatus
        includeShelved?: boolean
    } = {},
): Promise<PlannedJobListResult> {
    const scanned = await scanPlannedJobs(createDirectoryScanFileSystem(fileSystem), worktree, { includeShelved: options.includeShelved })
    const jobs = await Promise.all(scanned.jobs
        .filter((job) => options.filter === undefined || job.status === options.filter)
        .sort((left, right) => left.job_name.localeCompare(right.job_name))
        .map(async (job): Promise<PlannedJobListItem> => ({
            label: job.job_name,
            job_name: job.job_name,
            status: job.status,
            job_path: job.job_path,
            description: await readPlannedJobDescription(fileSystem, worktree, job),
        })))

    return {
        jobs,
        collisions: scanned.collisions,
    }
}

export function deriveJobNameFromTitle(title: string): string {
    const titleWithoutStatus = title.replace(/\s+\(([a-z]+)\)\s*$/, (_match, status: string) => isJobStatus(status) ? "" : _match)

    return titleWithoutStatus
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 100)
}

export function formatJobSessionTitle(jobName: string, status?: JobStatus): string {
    const title = jobName
        .replace(/_/g, " ")
        .split(" ")
        .filter((word) => word.length > 0)
        .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
        .join(" ")

    return status ? `${title} (${status})` : title
}

function formatSessionTitleFallbackTimestamp(date: Date = new Date()): string {
    const pad = (value: number): string => String(value).padStart(2, "0")
    return `${String(date.getFullYear()).slice(-2)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

function isDefaultSessionTitle(title: string | undefined): boolean {
    return title?.trim().toLowerCase() === "new session"
}

export function deriveJobTitleFromFileName(fileName: string, status: JobStatus): string {
    const baseName = path.basename(fileName)
    const withoutTimestampPrefix = baseName.replace(/^\d{2}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\./, "")
    const withoutExtension = withoutTimestampPrefix.replace(/\.[^.]+$/, "")
    return formatJobSessionTitle(withoutExtension, status)
}

export function isCompatibleJobName(value: string): boolean {
    return /^[a-z0-9_]{1,100}$/.test(value)
}

export function getCanonicalDirectoryForStatus(status: JobStatus): ActiveJobLifecycleDirectory | CompletedJobLifecycleDirectory {
    switch (status) {
        case "concepts":
            return "concepts"
        case "drafts":
            return "drafts"
        case "assist":
            return "assist"
        case "executing":
            return "executing"
        case "facilitate":
            return "facilitate"
        case "review":
            return "review"
        case "shelved":
            return "shelved"
    }
}

export function getDefaultStatusForDirectory(directory: JobDirectory): JobStatus {
    switch (directory) {
        case "concepts":
            return "concepts"
        case "drafts":
            return "drafts"
        case "assist":
            return "assist"
        case "executing":
            return "executing"
        case "facilitate":
            return "facilitate"
        case "review":
            return "review"
        case "shelved":
            return "shelved"
    }
}

export function getCanonicalDirectoryPathForStatus(status: JobStatus): string {
    return `.agents/jobs/${getCanonicalDirectoryForStatus(status)}`
}

export function getRelativeJobDirectoryPath(directory: JobDirectory, job: string): string {
    return `.agents/jobs/${directory}/${job}/`
}

export function getRelativeJobFilePath(directory: JobDirectory, job: string, fileName: string): string {
    return `.agents/jobs/${directory}/${job}/${fileName}`
}

export function getRelativeConceptFilePath(label: string): string {
    const fileName = label.endsWith(".md") ? label : `${label}.md`
    return `.agents/jobs/concepts/${fileName}`
}

export function getJobDirectoryPath(worktree: string, directory: JobDirectory, job: string): string {
    return path.join(worktree, ".agents", "jobs", directory, job)
}

export function getJobFilePath(worktree: string, directory: JobDirectory, job: string, fileName: string): string {
    return path.join(getJobDirectoryPath(worktree, directory, job), fileName)
}

export function isJobStatus(value: string): value is JobStatus {
    return (jobStatuses as readonly string[]).includes(value)
}

export function normalizeJobStatusInput(value: string): JobStatus | undefined {
    const normalizedValue = value.trim().toLowerCase()
    return isJobStatus(normalizedValue) ? normalizedValue : undefined
}

function mapDirent(entry: Dirent | string): DirectoryEntry {
    if (typeof entry !== "string") {
        const isDirectory = entry.isDirectory()
        return {
            name: entry.name,
            isDirectory,
            isFile: typeof entry.isFile === "function" ? entry.isFile() : !isDirectory,
        }
    }

    const looksLikeFile = /\.[^/]+$/.test(entry)
    return {
        name: entry,
        isDirectory: !looksLikeFile,
        isFile: looksLikeFile,
    }
}

export function createDirectoryFileSystem(fileSystem: JobToolFileSystem): DirectoryFileSystem {
    return {
        mkdir: fileSystem.mkdir,
        readFile: fileSystem.readFile,
        readdir: async (dirPath: string, options: { withFileTypes: true }): Promise<Dirent[]> => {
            const entries = await fileSystem.readdir(dirPath, options)
            return normalizeReaddirEntries(entries)
        },
        rename: fileSystem.rename,
        rm: fileSystem.rm,
        stat: fileSystem.stat,
        writeFile: fileSystem.writeFile,
    }
}

async function readDirectoryEntries(fileSystem: Pick<DirectoryFileSystem, "readdir">, dirPath: string): Promise<DirectoryEntry[]> {
    try {
        const entries = await fileSystem.readdir(dirPath, { withFileTypes: true })
        return entries.map(mapDirent)
    }
    catch (error) {
        if (isMissingFile(error)) {
            return []
        }

        throw error
    }
}

function parseStatusReportFileName(fileName: string): StatusReportInfo | undefined {
    const match = fileName.match(/^(\d{2}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}) - ([a-z]+)(?: - (\d+))?\.md$/)
    const status = normalizeJobStatusInput(match?.[2] ?? "")
    if (!match || !status) {
        return undefined
    }

    return {
        fileName,
        timestamp: match[1],
        status,
        suffix: Number(match[3] ?? "1"),
    }
}

function compareStatusReports(left: StatusReportInfo, right: StatusReportInfo): number {
    return left.timestamp.localeCompare(right.timestamp) || left.suffix - right.suffix || left.fileName.localeCompare(right.fileName)
}

async function readLatestStatusReport(fileSystem: Pick<DirectoryFileSystem, "readdir">, jobDirectoryPath: string, expectedStatuses: readonly JobStatus[]): Promise<StatusReportInfo | undefined> {
    const entries = await readDirectoryEntries(fileSystem, jobDirectoryPath)
    const reports = entries
        .filter((entry) => entry.isFile)
        .map((entry) => parseStatusReportFileName(entry.name))
        .filter((entry): entry is StatusReportInfo => entry !== undefined && expectedStatuses.includes(entry.status))
        .sort(compareStatusReports)

    return reports[reports.length - 1]
}

async function inferLogicalStatus(
    fileSystem: Pick<DirectoryFileSystem, "readFile" | "readdir">,
    worktree: string,
    directory: JobDirectory,
    jobName: string,
): Promise<JobStatus> {
    if (directory === "concepts") {
        const solutionStatus = await readLatestSolutionStatusFile(fileSystem, getJobFilePath(worktree, directory, jobName, "solution.md"), ["concepts"])
        return solutionStatus
            ?? (await readLatestStatusReport(fileSystem, getJobDirectoryPath(worktree, directory, jobName), ["concepts"]))?.status
            ?? "concepts"
    }

    if (directory === "drafts") {
        const solutionStatus = await readLatestSolutionStatusFile(fileSystem, getJobFilePath(worktree, directory, jobName, "solution.md"), ["drafts"])
        return solutionStatus
            ?? (await readLatestStatusReport(fileSystem, getJobDirectoryPath(worktree, directory, jobName), ["drafts"]))?.status
            ?? "drafts"
    }

    if (directory === "assist") {
        const solutionStatus = await readLatestSolutionStatusFile(fileSystem, getJobFilePath(worktree, directory, jobName, "solution.md"), ["assist"])
        return solutionStatus
            ?? (await readLatestStatusReport(fileSystem, getJobDirectoryPath(worktree, directory, jobName), ["assist"]))?.status
            ?? "assist"
    }

    if (directory === "facilitate") {
        const solutionStatus = await readLatestSolutionStatusFile(fileSystem, getJobFilePath(worktree, directory, jobName, "solution.md"), ["facilitate"])
        return solutionStatus
            ?? (await readLatestStatusReport(fileSystem, getJobDirectoryPath(worktree, directory, jobName), ["facilitate"]))?.status
            ?? "facilitate"
    }

    return getDefaultStatusForDirectory(directory)
}

async function createResolvedPlannedJob(
    fileSystem: Pick<DirectoryFileSystem, "readFile" | "readdir">,
    worktree: string,
    directory: JobDirectory,
    jobName: string,
): Promise<ResolvedPlannedJob> {
    const status = await inferLogicalStatus(fileSystem, worktree, directory, jobName)
    const relative_job_path = getRelativeJobDirectoryPath(directory, jobName)

    return {
        job_name: jobName,
        status,
        directory,
        absolute_path: getJobDirectoryPath(worktree, directory, jobName),
        job_path: relative_job_path,
        relative_job_path,
    }
}

async function readLatestSolutionStatusFile(
    fileSystem: Pick<DirectoryFileSystem, "readFile">,
    solutionPath: string,
    statuses: readonly JobStatus[],
): Promise<JobStatus | undefined> {
    try {
        const status = readLatestSolutionStatus(await fileSystem.readFile(solutionPath, "utf8"), statuses)
        return status as JobStatus | undefined
    }
    catch (error) {
        if (isMissingFile(error)) return undefined
        throw error
    }
}

function compareResolvedPlannedJobs(left: ResolvedPlannedJob, right: ResolvedPlannedJob): number {
    return canonicalDirectoryPriority.indexOf(left.directory) - canonicalDirectoryPriority.indexOf(right.directory)
        || left.directory.localeCompare(right.directory)
        || left.status.localeCompare(right.status)
        || left.job_name.localeCompare(right.job_name)
}

export function formatPlannedJobCollision(collision: PlannedJobCollision): string {
    return `${collision.job_name} (${collision.entries.map((entry) => entry.relative_job_path).join(", ")})`
}

export function formatPlannedJobCollisions(collisions: PlannedJobCollision[]): string {
    return collisions.map(formatPlannedJobCollision).join("; ")
}

async function collectDirectoryJobs(
    fileSystem: Pick<DirectoryFileSystem, "readFile" | "readdir">,
    worktree: string,
    directory: JobDirectory,
    jobsByName: Map<string, ResolvedPlannedJob[]>,
): Promise<void> {
    const entries = await readDirectoryEntries(fileSystem, getJobDirectoryPath(worktree, directory, ""))
    for (const entry of entries) {
        if (!entry.isDirectory) continue
        const jobs = jobsByName.get(entry.name) ?? []
        jobs.push(await createResolvedPlannedJob(fileSystem, worktree, directory, entry.name))
        jobsByName.set(entry.name, jobs)
    }
}

export async function scanPlannedJobs(
    fileSystem: Pick<DirectoryFileSystem, "readFile" | "readdir">,
    worktree: string,
    options: ResolveOptions = {},
): Promise<ScannedPlannedJobs> {
    const jobsByName = new Map<string, ResolvedPlannedJob[]>()

    for (const directory of activeJobLifecycleDirectories) {
        await collectDirectoryJobs(fileSystem, worktree, directory, jobsByName)
    }

    if (options.includeShelved) {
        await collectDirectoryJobs(fileSystem, worktree, completedJobLifecycleDirectory, jobsByName)
    }

    const jobs: ResolvedPlannedJob[] = []
    const collisions: PlannedJobCollision[] = []

    for (const [jobName, entries] of [...jobsByName.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const sortedEntries = [...entries].sort(compareResolvedPlannedJobs)
        if (sortedEntries.length > 1) {
            collisions.push({ job_name: jobName, entries: sortedEntries })
        }

        jobs.push(sortedEntries[0])
    }

    return { jobs, collisions }
}

export async function resolvePlannedJob(
    fileSystem: Pick<DirectoryFileSystem, "readFile" | "readdir">,
    worktree: string,
    jobName: string,
    options: ResolveOptions = {},
): Promise<ResolvePlannedJobResult> {
    const scanned = await scanPlannedJobs(fileSystem, worktree, options)
    const collision = scanned.collisions.find((entry) => entry.job_name === jobName)
    if (collision && !options.ignoreCollisions) {
        return { type: "collision", collision }
    }

    const job = scanned.jobs.find((entry) => entry.job_name === jobName)
    if (!job) {
        return { type: "missing" }
    }

    return { type: "found", job }
}

function allScannedPlannedJobEntries(scanned: ScannedPlannedJobs): ResolvedPlannedJob[] {
    const jobsByPath = new Map<string, ResolvedPlannedJob>()
    for (const job of scanned.jobs) {
        jobsByPath.set(job.relative_job_path, job)
    }
    for (const collision of scanned.collisions) {
        for (const job of collision.entries) {
            jobsByPath.set(job.relative_job_path, job)
        }
    }

    return [...jobsByPath.values()].sort(compareResolvedPlannedJobs)
}

async function readJobSessionID(fileSystem: Pick<DirectoryFileSystem, "readFile">, worktree: string, job: ResolvedPlannedJob): Promise<string | undefined> {
    try {
        return parsePersistedSessionID(await fileSystem.readFile(getJobFilePath(worktree, job.directory, job.job_name, "session.yml"), "utf8"))
    }
    catch (error) {
        if (isMissingFile(error)) return undefined
        throw error
    }
}

async function resolvePlannedJobBySessionID(
    fileSystem: Pick<DirectoryFileSystem, "readFile" | "readdir">,
    worktree: string,
    sessionID: string,
    options: ResolveOptions = {},
): Promise<ResolvePlannedJobBySessionResult> {
    const scanned = await scanPlannedJobs(fileSystem, worktree, options)
    const matchingJobs: ResolvedPlannedJob[] = []
    for (const job of allScannedPlannedJobEntries(scanned)) {
        if (await readJobSessionID(fileSystem, worktree, job) === sessionID) {
            matchingJobs.push(job)
        }
    }

    if (matchingJobs.length === 0) {
        return { type: "missing" }
    }

    const matchingNameCollision = scanned.collisions.find((collision) => matchingJobs.some((job) => job.job_name === collision.job_name))
    if (matchingNameCollision && !options.ignoreCollisions) {
        return { type: "collision", collision: matchingNameCollision }
    }

    if (matchingJobs.length > 1 && !options.ignoreCollisions) {
        return {
            type: "collision",
            collision: {
                job_name: `session_id ${sessionID}`,
                entries: matchingJobs.sort(compareResolvedPlannedJobs),
            },
        }
    }

    return { type: "found", job: matchingJobs[0] }
}

function getMissingTitleResolution(sessionTitle: { warning?: string }): PlannedJobIdentityResolution["resolution"] {
    if (!sessionTitle.warning) return "no_title"
    if (sessionTitle.warning.startsWith("Current session title lookup is unavailable")) return "title_unavailable"
    return "title_read_failed"
}

function shouldFallbackToSessionID(resolution: PlannedJobIdentityResolution["resolution"]): boolean {
    return ["missing", "no_title", "title_unavailable", "title_read_failed"].includes(resolution)
}

function createSessionIDFallbackWarning(prefix: string | undefined, sessionID: string, jobName: string): string {
    const suffix = `Resolved planned job ${jobName} from persisted session_id ${sessionID}.`
    return prefix ? `${prefix} ${suffix}` : suffix
}

export async function getCurrentSessionTitle(client: OpencodeClient | undefined, context: Pick<SessionJobContext, "sessionID" | "directory">): Promise<{ title?: string, warning?: string }> {
    const sessionClient = client as SessionTitleClient | undefined
    if (!sessionClient?.session.get) {
        return {
            warning: "Current session title lookup is unavailable; provide job_name if needed.",
        }
    }

    try {
        const sessionResponse = await sessionClient.session.get({
            path: { id: context.sessionID },
            query: { directory: context.directory },
        })

        if (sessionResponse.error || !sessionResponse.data) {
            return {
                warning: `Unable to read current session title: ${sessionResponse.error ?? context.sessionID}`,
            }
        }

        const title = sessionResponse.data.title?.trim()
        if (!title || isDefaultSessionTitle(title)) {
            return getFallbackSessionTitle(client, context)
        }

        return { title }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
            warning: `Unable to read current session title: ${message}`,
        }
    }
}

function isAssistantMessage(message: Message): message is AssistantMessage {
    return message.role === "assistant"
}

function isUserMessage(message: Message): boolean {
    return message.role === "user"
}

function getPartTimestamp(part: Part): number | undefined {
    switch (part.type) {
        case "tool":
            if (part.state.status === "running") {
                return part.state.time.start
            }
            if (part.state.status === "completed" || part.state.status === "error") {
                return part.state.time.end
            }
            return undefined
        case "text":
        case "reasoning":
            return part.time?.end ?? part.time?.start
        case "retry":
            return part.time.created
        default:
            return undefined
    }
}

function getLatestAssistantResponseText(messages: SessionMessage[]): string | undefined {
    const latestAssistantMessage = [...messages]
        .filter((message) => isAssistantMessage(message.info))
        .sort((left, right) => left.info.time.created - right.info.time.created)
        .at(-1)

    if (!latestAssistantMessage || !isAssistantMessage(latestAssistantMessage.info)) {
        return undefined
    }

    const text = latestAssistantMessage.parts
        .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && (part.messageID === undefined || part.messageID === latestAssistantMessage.info.id))
        .sort((left, right) => (getPartTimestamp(left) ?? 0) - (getPartTimestamp(right) ?? 0))
        .map((part) => part.text)
        .join("")

    return text.length > 0 ? text : undefined
}

function getMessageText(message: SessionMessage): string | undefined {
    const text = message.parts
        .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && (part.messageID === undefined || part.messageID === message.info.id))
        .sort((left, right) => (getPartTimestamp(left) ?? 0) - (getPartTimestamp(right) ?? 0))
        .map((part) => part.text)
        .join("")
        .trim()

    return text.length > 0 ? text : undefined
}

function deriveSessionTitleFromFirstUserPrompt(messages: SessionMessage[]): UserSessionTitleFallback | undefined {
    const firstUserMessage = [...messages]
        .filter((message) => isUserMessage(message.info))
        .sort((left, right) => left.info.time.created - right.info.time.created)
        .at(0)

    const text = firstUserMessage ? getMessageText(firstUserMessage) : undefined
    const candidate = text?.replace(/\s+/g, " ").trim().slice(0, 40).trim()
    if (!candidate || !deriveJobNameFromTitle(candidate)) {
        return undefined
    }

    return { title: candidate }
}

async function getFallbackSessionTitle(client: OpencodeClient | undefined, context: Pick<SessionJobContext, "sessionID" | "directory">): Promise<UserSessionTitleFallback> {
    const sessionClient = client as SessionMessagesClient | undefined
    if (sessionClient?.session.messages) {
        try {
            const response = await sessionClient.session.messages({
                path: { id: context.sessionID },
                query: {
                    directory: context.directory,
                    limit: 100,
                },
            })

            if (response.data) {
                const fallback = deriveSessionTitleFromFirstUserPrompt(response.data)
                if (fallback) {
                    return fallback
                }
            }
        }
        catch {
        }
    }

    return { title: formatSessionTitleFallbackTimestamp() }
}

export async function readLatestAssistantResponseText(client: OpencodeClient | undefined, context: Pick<SessionJobContext, "sessionID" | "directory">): Promise<{ text?: string, limitation?: string, error?: unknown }> {
    const sessionClient = client as SessionMessagesClient | undefined
    if (!sessionClient?.session.messages) {
        return {
            limitation: "Current session message lookup is unavailable; autocode_job_status cannot persist the last assistant response on this runtime.",
        }
    }

    try {
        const response = await sessionClient.session.messages({
            path: { id: context.sessionID },
            query: {
                directory: context.directory,
                limit: 30,
            },
        })

        if (response.error || !response.data) {
            return {
                limitation: `Unable to read current session messages: ${response.error ?? context.sessionID}`,
            }
        }

        return {
            text: getLatestAssistantResponseText(response.data),
        }
    }
    catch (error) {
        return { error }
    }
}

export async function countCurrentSessionUserMessages(client: OpencodeClient | undefined, context: Pick<SessionJobContext, "sessionID" | "directory">): Promise<{ count?: number, limitation?: string, error?: unknown }> {
    const sessionClient = client as SessionMessagesClient | undefined
    if (!sessionClient?.session.messages) {
        return {
            limitation: "Current session message lookup is unavailable; autocode_job_execute cannot inspect prior user context on this runtime.",
        }
    }

    try {
        const response = await sessionClient.session.messages({
            path: { id: context.sessionID },
            query: {
                directory: context.directory,
                limit: 30,
            },
        })

        if (response.error || !response.data) {
            return {
                limitation: `Unable to read current session messages: ${response.error ?? context.sessionID}`,
            }
        }

        return {
            count: response.data.filter((message) => isUserMessage(message.info)).length,
        }
    }
    catch (error) {
        return { error }
    }
}

export function getEffectiveJobStatus(requestedStatus: JobStatus, currentStatus: JobStatus): JobStatus {
    if (requestedStatus === "review" && currentStatus === "review") {
        return "shelved"
    }

    return requestedStatus
}

export async function resolvePlannedJobIdentity(
    fileSystem: Pick<DirectoryFileSystem, "readFile" | "readdir">,
    client: OpencodeClient | undefined,
    context: SessionJobContext,
    overrideOrOptions: string | ResolvePlannedJobIdentityOptions = {},
): Promise<PlannedJobIdentityResolution> {
    const storageRoot = resolveAgentsStorageRoot(context)
    const options = typeof overrideOrOptions === "string"
        ? { jobNameOverride: overrideOrOptions }
        : overrideOrOptions

    const requestedJobName = options.jobNameOverride?.trim()
    if (requestedJobName) {
        const resolved = await resolvePlannedJob(fileSystem, storageRoot, requestedJobName, options)
        if (resolved.type === "found") {
            return {
                mode: "planned",
                resolution: "found",
                explicit_override: true,
                job_name: requestedJobName,
                resolved_job: resolved.job,
            }
        }

        return {
            mode: "ad_hoc",
            resolution: resolved.type,
            explicit_override: true,
            job_name: requestedJobName,
            collision: resolved.type === "collision" ? resolved.collision : undefined,
            warning: resolved.type === "collision"
                ? `Explicit job_name override matched multiple planned jobs for ${requestedJobName}.`
                : `Explicit job_name override did not match a planned job: ${requestedJobName}`,
        }
    }

    async function resolveFromSessionIDFallback(
        resolution: PlannedJobIdentityResolution["resolution"],
        warning?: string,
        sessionTitle?: string,
        titleDerivedCandidate?: string,
    ): Promise<PlannedJobIdentityResolution | undefined> {
        if (!shouldFallbackToSessionID(resolution)) {
            return undefined
        }

        const resolved = await resolvePlannedJobBySessionID(fileSystem, storageRoot, context.sessionID, options)
        if (resolved.type === "found") {
            return {
                mode: "planned",
                resolution: "found",
                explicit_override: false,
                job_name: resolved.job.job_name,
                resolved_job: resolved.job,
                session_title: sessionTitle,
                title_derived_candidate: titleDerivedCandidate,
                warning: createSessionIDFallbackWarning(warning, context.sessionID, resolved.job.job_name),
            }
        }
        if (resolved.type === "collision") {
            return {
                mode: "ad_hoc",
                resolution: "collision",
                explicit_override: false,
                job_name: resolved.collision.job_name,
                collision: resolved.collision,
                session_title: sessionTitle,
                title_derived_candidate: titleDerivedCandidate,
                warning: `Current session_id ${context.sessionID} matched multiple planned jobs.`,
            }
        }

        return undefined
    }

    const sessionTitle = await getCurrentSessionTitle(client, context)
    if (!sessionTitle.title) {
        const resolution = getMissingTitleResolution(sessionTitle)
        const fallback = await resolveFromSessionIDFallback(resolution, sessionTitle.warning)
        if (fallback) return fallback

        return {
            mode: "ad_hoc",
            resolution,
            explicit_override: false,
            warning: sessionTitle.warning,
        }
    }

    const candidate = deriveJobNameFromTitle(sessionTitle.title)
    if (!candidate) {
        const fallback = await resolveFromSessionIDFallback("missing", `Current session title did not produce a planned job candidate: ${sessionTitle.title}`, sessionTitle.title, candidate)
        if (fallback) return fallback

        return {
            mode: "ad_hoc",
            resolution: "missing",
            explicit_override: false,
            session_title: sessionTitle.title,
            title_derived_candidate: candidate,
            warning: `Current session title did not produce a planned job candidate: ${sessionTitle.title}`,
        }
    }

    const resolved = await resolvePlannedJob(fileSystem, storageRoot, candidate, options)
    if (resolved.type === "found") {
        return {
            mode: "planned",
            resolution: "found",
            explicit_override: false,
            job_name: candidate,
            resolved_job: resolved.job,
            session_title: sessionTitle.title,
            title_derived_candidate: candidate,
        }
    }

    const fallback = await resolveFromSessionIDFallback(
        resolved.type,
        resolved.type === "collision"
            ? `Current session title matched multiple planned jobs for candidate ${candidate}.`
            : `Current session title did not match a planned job: ${sessionTitle.title}`,
        sessionTitle.title,
        candidate,
    )
    if (fallback) return fallback

    return {
        mode: "ad_hoc",
        resolution: resolved.type,
        explicit_override: false,
        job_name: candidate,
        collision: resolved.type === "collision" ? resolved.collision : undefined,
        session_title: sessionTitle.title,
        title_derived_candidate: candidate,
        warning: resolved.type === "collision"
            ? `Current session title matched multiple planned jobs for candidate ${candidate}.`
            : `Current session title did not match a planned job: ${sessionTitle.title}`,
    }
}

export async function updateCurrentSessionTitleToJobName(client: OpencodeClient | undefined, context: Pick<SessionJobContext, "sessionID" | "directory">, jobName: string, status?: JobStatus): Promise<{ updated: boolean, warning?: string }> {
    const sessionClient = client as SessionTitleClient | undefined
    const title = formatJobSessionTitle(jobName, status)
    if (!sessionClient?.session.update) {
        return {
            updated: false,
            warning: "Current session title update is unavailable; continuing without renaming the session.",
        }
    }

    try {
        const response = await sessionClient.session.update({
            path: { id: context.sessionID },
            query: { directory: context.directory },
            body: { title },
        })

        if (response.error) {
            return {
                updated: false,
                warning: `Unable to update current session title to ${title}: ${response.error}`,
            }
        }

        return { updated: true }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
            updated: false,
            warning: `Unable to update current session title to ${title}: ${message}`,
        }
    }
}

export async function ensurePlannedJobFiles(fileSystem: Pick<DirectoryFileSystem, "mkdir">, directoryPath: string): Promise<void> {
    await fileSystem.mkdir(directoryPath, { recursive: true })
}

export async function readJobStatuses(fileSystem: Pick<DirectoryFileSystem, "readFile" | "readdir">, worktree: string): Promise<Record<string, JobStatus>> {
    const scanned = await scanPlannedJobs(fileSystem, worktree)
    const statuses: Record<string, JobStatus> = {}

    for (const job of scanned.jobs) {
        statuses[job.job_name] = job.status
    }

    return statuses
}

export function createTimestampedJobFileName(prefix: string, date = new Date()): string {
    const pad = (value: number): string => String(value).padStart(2, "0")
    return `${prefix}_${pad(date.getFullYear() % 100)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}.md`
}

export function formatTimestampPostfix(date: Date = new Date()): string {
    const pad = (value: number): string => String(value).padStart(2, "0")
    return `${String(date.getFullYear()).slice(-2)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

export function createShelvedCollisionJobName(jobName: string, date: Date = new Date()): string {
    return `${jobName}_${formatTimestampPostfix(date)}`
}

function formatStatusReportTimestamp(date: Date): string {
    const pad = (value: number): string => String(value).padStart(2, "0")
    return `${String(date.getFullYear()).slice(-2)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

export async function writeJobStatusReport(
    fileSystem: Pick<DirectoryFileSystem, "mkdir" | "readdir" | "writeFile">,
    jobDirectoryPath: string,
    status: JobStatus,
    content: string,
    now: Date = new Date(),
): Promise<{ fileName: string, filePath: string }> {
    const timestamp = formatStatusReportTimestamp(now)
    const baseName = `${timestamp} - ${status}`

    await fileSystem.mkdir(jobDirectoryPath, { recursive: true })
    const existingEntries = await readDirectoryEntries(fileSystem, jobDirectoryPath)
    const siblingReports = existingEntries
        .filter((entry) => entry.isFile)
        .map((entry) => parseStatusReportFileName(entry.name))
        .filter((entry): entry is StatusReportInfo => entry !== undefined && entry.timestamp === timestamp && entry.status === status)

    const suffix = siblingReports.length === 0 ? 1 : Math.max(...siblingReports.map((entry) => entry.suffix)) + 1
    const fileName = suffix === 1 ? `${baseName}.md` : `${baseName} - ${suffix}.md`
    const filePath = path.join(jobDirectoryPath, fileName)
    await fileSystem.writeFile(filePath, content)

    return { fileName, filePath }
}

export async function moveResolvedPlannedJobToStatus(
    worktree: string,
    source: ResolvedPlannedJob,
    status: JobStatus,
    fileSystem: MoveJobFileSystem = defaultMoveJobFileSystem,
    options: MovePlannedJobOptions = {},
): Promise<MovePlannedJobResult> {
    const destinationDirectory = getCanonicalDirectoryForStatus(status)
    let destinationJobName = source.job_name
    let destinationDir = getJobDirectoryPath(worktree, destinationDirectory, destinationJobName)
    if (source.absolute_path !== destinationDir) {
        await fileSystem.mkdir(getJobDirectoryPath(worktree, destinationDirectory, ""), { recursive: true })
        try {
            await fileSystem.rename!(source.absolute_path, destinationDir)
        }
        catch (error) {
            if (isCollisionError(error)) {
                if (status !== "shelved" || !options.shelvedCollisionTimestamp) {
                    return { type: "destination_collision", destinationDir }
                }

                destinationJobName = createShelvedCollisionJobName(source.job_name, options.shelvedCollisionTimestamp)
                destinationDir = getJobDirectoryPath(worktree, destinationDirectory, destinationJobName)

                try {
                    await fileSystem.rename!(source.absolute_path, destinationDir)
                }
                catch (retryError) {
                    if (isCollisionError(retryError)) {
                        return { type: "destination_collision", destinationDir }
                    }

                    throw retryError
                }
            }
            else {
                throw error
            }
        }
    }

    await ensurePlannedJobFiles(fileSystem, destinationDir)

    return {
        type: "success",
        job: {
            job_name: destinationJobName,
            status,
            directory: destinationDirectory,
            absolute_path: destinationDir,
            job_path: getRelativeJobDirectoryPath(destinationDirectory, destinationJobName),
            relative_job_path: getRelativeJobDirectoryPath(destinationDirectory, destinationJobName),
        },
        from_status: source.status,
    }
}

export async function movePlannedJobToStatus(
    worktree: string,
    jobName: string,
    status: JobStatus,
    fileSystem: MoveJobFileSystem = defaultMoveJobFileSystem,
    options: MovePlannedJobOptions = {},
): Promise<MovePlannedJobResult> {
    const resolved = await resolvePlannedJob(fileSystem, worktree, jobName)
    if (resolved.type !== "found") {
        return resolved.type === "missing" ? { type: "missing" } : { type: "collision", collision: resolved.collision }
    }

    return moveResolvedPlannedJobToStatus(worktree, resolved.job, status, fileSystem, options)
}

export async function findExistingJobFile(
    fileSystem: Pick<DirectoryFileSystem, "readFile">,
    worktree: string,
    job: string,
    fileName: string,
    directories: readonly JobDirectory[] = [...activeJobLifecycleDirectories, completedJobLifecycleDirectory],
): Promise<{ content: string, directory: JobDirectory, path: string } | null> {
    const matches: Array<{ content: string, directory: JobDirectory, path: string }> = []

    for (const directory of directories) {
        const filePath = getJobFilePath(worktree, directory, job, fileName)
        try {
            const content = await fileSystem.readFile(filePath, "utf8")
            matches.push({ content, directory, path: getRelativeJobFilePath(directory, job, fileName) })
        }
        catch (error) {
            if (isMissingFile(error)) {
                continue
            }

            throw error
        }
    }

    if (matches.length > 1) {
        throw new Error(`Planned job lifecycle collision: ${job} (${matches.map((match) => match.path).join(", ")})`)
    }

    return matches[0] ?? null
}

export type StartJobFileSystem = DirectoryFileSystem & {
    rename: (oldPath: string, newPath: string) => Promise<void>
}

export type StartActiveJobResult =
    | {
        type: "success"
        alreadyStarted: boolean
        lifecycleTransition: StartLifecycleTransition
        startedJobDir: string
        job: ResolvedPlannedJob
        previousStatus: JobStatus
    }
    | {
        type: "missing_job"
    }
    | {
        type: "collision"
        collision?: PlannedJobCollision
    }
    | {
        type: "destination_collision"
        destinationDir: string
    }

export async function startResolvedActiveJob(worktree: string, current: ResolvedPlannedJob, fileSystem: StartJobFileSystem): Promise<StartActiveJobResult> {
    const moved = await moveResolvedPlannedJobToStatus(worktree, current, "executing", fileSystem)
    if (moved.type === "missing") {
        return { type: "missing_job" }
    }
    if (moved.type === "collision") {
        return { type: "collision", collision: moved.collision }
    }
    if (moved.type === "destination_collision") {
        return { type: "destination_collision", destinationDir: moved.destinationDir }
    }

    let lifecycleTransition: StartLifecycleTransition = "resume_to_executing"
    if (current.status === "drafts") lifecycleTransition = "draft_to_executing"
    else if (current.status === "executing") lifecycleTransition = "already_executing"

    return {
        type: "success",
        alreadyStarted: current.status === "executing" && current.directory === "executing",
        lifecycleTransition,
        startedJobDir: moved.job.absolute_path,
        job: moved.job,
        previousStatus: current.status,
    }
}

export async function startActiveJob(worktree: string, jobName: string, fileSystem: StartJobFileSystem): Promise<StartActiveJobResult> {
    const resolved = await resolvePlannedJob(fileSystem, worktree, jobName)
    if (resolved.type === "missing") {
        return { type: "missing_job" }
    }
    if (resolved.type === "collision") {
        return { type: "collision", collision: resolved.collision }
    }

    return startResolvedActiveJob(worktree, resolved.job, fileSystem)
}
