import path from "path"

const solutionLifecycleDirectories = ["concepts", "drafts", "assist", "executing", "facilitate", "review", "shelved"] as const
const statusEventPattern = /^# (\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) - Update Status To (concepts|drafts|assist|executing|facilitate|review|shelved)$/m

export enum SolutionLogEvent {
    UpdateStatus = "update_status",
    AcceptedCriteria = "accepted_criteria",
}

type SolutionFileSystem = {
    appendFile?: (filePath: string, content: string) => Promise<void>
    mkdir?: (dirPath: string, options?: { recursive?: boolean }) => Promise<string | undefined | void>
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
    readdir?: (dirPath: string, options?: { withFileTypes?: boolean }) => Promise<string[] | import("fs").Dirent[]>
    writeFile: (filePath: string, content: string) => Promise<void>
}

type CreateSolutionUtilsOptions = {
    getDirectory?: (job_name: string) => Promise<string | undefined> | string | undefined
    now?: () => Date
}

type ResolvedSolutionPath = {
    directory: string
    solutionPath: string
    relativeSolutionPath: string
}

function isMissingFile(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
}

function formatTimestamp(date: Date): string {
    const pad = (value: number): string => String(value).padStart(2, "0")
    return `${String(date.getFullYear()).slice(-2)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function createEventTitle(event: SolutionLogEvent, name: string): string {
    if (event === SolutionLogEvent.UpdateStatus) return `Update Status To ${name}`
    return `Accepted Criteria ${name}`
}

function normalizeBulletList(actions: string): string {
    const lines = actions
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

    return lines.map((line) => line.match(/^[-*]\s+/) ? line : `- ${line}`).join("\n")
}

function formatSolutionEntry(timestamp: string, event: SolutionLogEvent, name: string, actions: string, reason: string): string {
    return `# ${timestamp} - ${createEventTitle(event, name)}\n\n## Actions\n\n${normalizeBulletList(actions)}\n\n## Reason\n\n${reason.trim()}\n\n---\n`
}

async function directoryExists(fileSystem: SolutionFileSystem, directoryPath: string): Promise<boolean> {
    if (!fileSystem.readdir) return false

    try {
        await fileSystem.readdir(directoryPath)
        return true
    }
    catch (error) {
        if (isMissingFile(error)) return false
        throw error
    }
}

async function resolveSolutionPath(fileSystem: SolutionFileSystem, worktree: string, job_name: string, getDirectory?: CreateSolutionUtilsOptions["getDirectory"]): Promise<ResolvedSolutionPath> {
    const hintedDirectory = await getDirectory?.(job_name)
    const directories = hintedDirectory
        ? [hintedDirectory, ...solutionLifecycleDirectories.filter((directory) => directory !== hintedDirectory)]
        : [...solutionLifecycleDirectories]

    for (const directory of directories) {
        const jobDirectoryPath = path.join(worktree, ".agents", "jobs", directory, job_name)
        if (await directoryExists(fileSystem, jobDirectoryPath)) {
            return {
                directory,
                solutionPath: path.join(jobDirectoryPath, "solution.md"),
                relativeSolutionPath: `.agents/jobs/${directory}/${job_name}/solution.md`,
            }
        }
    }

    const directory = hintedDirectory ?? "executing"
    const jobDirectoryPath = path.join(worktree, ".agents", "jobs", directory, job_name)
    await (fileSystem.mkdir ?? (async () => undefined))(jobDirectoryPath, { recursive: true })

    return {
        directory,
        solutionPath: path.join(jobDirectoryPath, "solution.md"),
        relativeSolutionPath: `.agents/jobs/${directory}/${job_name}/solution.md`,
    }
}

async function appendSolution(fileSystem: SolutionFileSystem, solutionPath: string, content: string): Promise<void> {
    if (fileSystem.appendFile) {
        await fileSystem.appendFile(solutionPath, content)
        return
    }

    let existing = ""
    try {
        existing = await fileSystem.readFile(solutionPath, "utf8")
    }
    catch (error) {
        if (!isMissingFile(error)) throw error
    }

    await fileSystem.writeFile(solutionPath, `${existing}${content}`)
}

export function readLatestSolutionStatus(content: string, statuses: readonly string[]): string | undefined {
    const matches = Array.from(content.matchAll(new RegExp(statusEventPattern.source, "gm")))
        .map((match) => ({ timestamp: match[1], status: match[2] }))
        .filter((match) => statuses.includes(match.status))
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp))

    return matches[matches.length - 1]?.status
}

export function createSolutionUtils(fileSystem: SolutionFileSystem, worktree: string, options: CreateSolutionUtilsOptions = {}) {
    return {
        async log(job_name: string, event: SolutionLogEvent, name: string, actions: string, reason: string): Promise<{ solutionPath: string, relativeSolutionPath: string }> {
            const resolved = await resolveSolutionPath(fileSystem, worktree, job_name, options.getDirectory)
            await (fileSystem.mkdir ?? (async () => undefined))(path.dirname(resolved.solutionPath), { recursive: true })
            await appendSolution(fileSystem, resolved.solutionPath, formatSolutionEntry(formatTimestamp((options.now ?? (() => new Date()))()), event, name, actions, reason))

            return {
                solutionPath: resolved.solutionPath,
                relativeSolutionPath: resolved.relativeSolutionPath,
            }
        },
    }
}
