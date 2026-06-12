import type { OpencodeClient } from "@opencode-ai/sdk"
import { archiveJobSandboxesForShelvedJob, defaultSandboxDependencies, type SandboxArchiveDependencies, type SandboxArchiveResult } from "./sandbox"
import { createSolutionUtils, SolutionLogEvent } from "./solution"
import { moveResolvedPlannedJobToStatus, updateCurrentSessionTitleToJobName, type JobToolFileSystem, type MoveJobFileSystem, type MovePlannedJobResult, type ResolvedPlannedJob, type SessionJobContext } from "./jobs"

export type ShelveResolvedPlannedJobResult =
    | {
        type: "success"
        moved: Extract<MovePlannedJobResult, { type: "success" }>
        solution: { solutionPath: string, relativeSolutionPath: string }
        title: { updated: boolean, warning?: string }
        sandbox_archive: SandboxArchiveResult
    }
    | Exclude<MovePlannedJobResult, { type: "success" }>

export type ShelveResolvedPlannedJobOptions = {
    storageRoot: string
    client: OpencodeClient | undefined
    context: Pick<SessionJobContext, "sessionID" | "directory">
    fileSystem: JobToolFileSystem
    moveFileSystem: MoveJobFileSystem
    now: () => Date
    resolvedJob: ResolvedPlannedJob
    assistantResponseText: string
    sandboxDependencies?: SandboxArchiveDependencies
}

export async function shelveResolvedPlannedJob(options: ShelveResolvedPlannedJobOptions): Promise<ShelveResolvedPlannedJobResult> {
    const moved = await moveResolvedPlannedJobToStatus(options.storageRoot, options.resolvedJob, "shelved", options.moveFileSystem)
    if (moved.type !== "success") return moved

    const solution = createSolutionUtils(options.fileSystem, options.storageRoot, {
        getDirectory: async () => moved.job.directory,
        now: options.now,
    })
    const logged = await solution.log(moved.job.job_name, SolutionLogEvent.UpdateStatus, "shelved", options.assistantResponseText, "Job shelved.")
    const title = await updateCurrentSessionTitleToJobName(options.client, options.context, moved.job.job_name, moved.job.status)
    const sandboxDeps = options.sandboxDependencies ?? { ...defaultSandboxDependencies, fileSystem: options.fileSystem }
    const sandboxArchive = await archiveJobSandboxesForShelvedJob(options.storageRoot, moved.job.job_name, moved.job.absolute_path, sandboxDeps)

    return {
        type: "success",
        moved,
        solution: logged,
        title,
        sandbox_archive: sandboxArchive,
    }
}
