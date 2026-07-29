import type { OpencodeClient } from "@opencode-ai/sdk"
import { archiveJobSandboxesForShelvedJob, defaultSandboxDependencies, type SandboxArchiveDependencies, type SandboxArchiveResult } from "./sandbox"
import { moveResolvedPlannedJobToStatus, updateCurrentSessionTitleToJobName, type JobToolFileSystem, type MoveJobFileSystem, type MovePlannedJobResult, type ResolvedPlannedJob, type SessionJobContext } from "./jobs"

export type ShelveResolvedPlannedJobResult =
    | {
        type: "success"
        moved: Extract<MovePlannedJobResult, { type: "success" }>
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
    sandboxDependencies?: SandboxArchiveDependencies
}

export async function shelveResolvedPlannedJob(options: ShelveResolvedPlannedJobOptions): Promise<ShelveResolvedPlannedJobResult> {
    const timestamp = options.now()
    const moved = await moveResolvedPlannedJobToStatus(options.storageRoot, options.resolvedJob, "shelved", options.moveFileSystem, {
        shelvedCollisionTimestamp: timestamp,
    })
    if (moved.type !== "success") return moved

    const title = await updateCurrentSessionTitleToJobName(options.client, options.context, moved.job.job_name, moved.job.status)
    const sandboxDeps = options.sandboxDependencies ?? { ...defaultSandboxDependencies, fileSystem: options.fileSystem }
    const sandboxArchive = await archiveJobSandboxesForShelvedJob(options.storageRoot, options.resolvedJob.job_name, moved.job.absolute_path, sandboxDeps)

    return {
        type: "success",
        moved,
        title,
        sandbox_archive: {
            ...sandboxArchive,
            job_name: moved.job.job_name,
        },
    }
}
