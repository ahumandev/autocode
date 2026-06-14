import { describe, expect, mock, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { createShelvedCollisionJobName, deriveJobNameFromTitle, deriveJobTitleFromFileName, formatJobSessionTitle, getCanonicalDirectoryForStatus, getCanonicalDirectoryPathForStatus, getCurrentSessionTitle, getDefaultStatusForDirectory, getStorageRelativePath, isCompatibleJobName, isJobStatus, jobStatuses, moveResolvedPlannedJobToStatus, resolveAgentsStorageRoot, resolvePlannedJobIdentity } from "./jobs"

function createFileSystem(activeJobs: Record<string, string[]> = {}, files: Record<string, string> = {}) {
    return {
        readFile: mock(async (filePath: string, _encoding: "utf8") => {
            if (filePath in files) return files[filePath]
            const error = new Error("missing") as NodeJS.ErrnoException
            error.code = "ENOENT"
            throw error
        }),
        readdir: mock(async (dirPath: string, _options: { withFileTypes: true }) => {
            const lifecycle = dirPath.replace("/workspace/.agents/jobs/", "").replace(/\/$/, "")
            return (activeJobs[lifecycle] ?? []).map((name) => ({
                name,
                isDirectory: () => true,
                isFile: () => false,
            })) as import("fs").Dirent[]
        }),
    }
}

function createClient(title: string | null | undefined, messages: Array<{ info: { id: string, role: "user" | "assistant", time: { created: number } }, parts: Array<{ type: "text", text: string, messageID?: string }> }> = []): OpencodeClient {
    return {
        session: {
            get: mock(async (args: { path: { id: string }, query: { directory: string } }) => ({
                data: {
                    id: args.path.id,
                    title,
                },
            })),
            messages: mock(async () => ({ data: messages })),
        },
    } as unknown as OpencodeClient
}

function createCollisionError(): NodeJS.ErrnoException {
    const error = new Error("collision") as NodeJS.ErrnoException
    error.code = "EEXIST"
    return error
}

const sessionContext = {
    sessionID: "session-1",
    directory: "/workspace",
    worktree: "/workspace",
}

describe("jobs utilities", () => {
    test("sanitizes session titles into compatible job names", () => {
        expect(deriveJobNameFromTitle("  Feature: Fix API / UI  ")).toBe("feature_fix_api_ui")
        expect(deriveJobNameFromTitle("Already___slugged")).toBe("already_slugged")
        expect(deriveJobNameFromTitle("Jira 25422 (executing)")).toBe("jira_25422")
        expect(deriveJobNameFromTitle("Jira 25422 (custom)")).toBe("jira_25422_custom")
        expect(deriveJobNameFromTitle("***")).toBe("")
        expect(deriveJobNameFromTitle("A".repeat(120))).toHaveLength(100)
        expect(isCompatibleJobName("feature_fix_api_ui")).toBe(true)
        expect(isCompatibleJobName("Feature_Fix")).toBe(false)
        expect(isCompatibleJobName("feature-fix")).toBe(false)
    })

    test("formats job names as title-cased session titles with optional lifecycle status", () => {
        expect(formatJobSessionTitle("jira_25422")).toBe("Jira 25422")
        expect(formatJobSessionTitle("jira_25422", "executing")).toBe("Jira 25422 (executing)")
    })

    test("maps canonical directories and statuses without legacy final status", () => {
        const legacyFinalStatus = ["termi", "nated"].join("")

        expect(getCanonicalDirectoryForStatus("concepts")).toBe("concepts")
        expect(getCanonicalDirectoryForStatus("drafts")).toBe("drafts")
        expect(getCanonicalDirectoryForStatus("assist")).toBe("assist")
        expect(getCanonicalDirectoryForStatus("executing")).toBe("executing")
        expect(getCanonicalDirectoryForStatus("facilitate")).toBe("facilitate")
        expect(getCanonicalDirectoryForStatus("review")).toBe("review")
        expect(getCanonicalDirectoryForStatus("shelved")).toBe("shelved")
        expect(getCanonicalDirectoryPathForStatus("drafts")).toBe(".agents/jobs/drafts")
        expect(getCanonicalDirectoryPathForStatus("facilitate")).toBe(".agents/jobs/facilitate")
        expect(getCanonicalDirectoryPathForStatus("shelved")).toBe(".agents/jobs/shelved")
        expect(getDefaultStatusForDirectory("drafts")).toBe("drafts")
        expect(getDefaultStatusForDirectory("facilitate")).toBe("facilitate")
        expect(getDefaultStatusForDirectory("executing")).toBe("executing")
        expect(isJobStatus("facilitate")).toBe(true)
        expect(isJobStatus("shelved")).toBe(true)
        expect(isJobStatus("failed")).toBe(false)
        expect(isJobStatus(legacyFinalStatus)).toBe(false)
        expect(jobStatuses).toContain("shelved")
        expect(jobStatuses).not.toContain(legacyFinalStatus)
    })

    test("resolves a safe .agents storage root and relative path", () => {
        expect(resolveAgentsStorageRoot({ worktree: "/", directory: "/workspace/project" })).toBe("/workspace/project")
        expect(resolveAgentsStorageRoot({ worktree: "", directory: "/workspace/project" })).toBe("/workspace/project")
        expect(resolveAgentsStorageRoot({ worktree: "/workspace/project", directory: "/other" })).toBe("/workspace/project")
        expect(resolveAgentsStorageRoot({ worktree: "/", directory: "/" })).toBe("/")
        expect(getStorageRelativePath("/workspace/project", "/workspace/project/.agents/jobs/drafts/my_feature/plan.md")).toBe(".agents/jobs/drafts/my_feature/plan.md")
    })

    test("derives job titles from timestamped filenames with extensions", () => {
        expect(deriveJobTitleFromFileName("26-01-31_12-59-59.Some_Job_Name.md", "drafts")).toBe("Some Job Name (drafts)")
    })

    test("derives job titles from non-timestamped filenames with extensions", () => {
        expect(deriveJobTitleFromFileName("Some_Job_Name.md", "executing")).toBe("Some Job Name (executing)")
    })

    test("derives job titles from timestamped filenames without extensions", () => {
        expect(deriveJobTitleFromFileName("26-01-31_12-59-59.Some_Job_Name", "facilitate")).toBe("Some Job Name (facilitate)")
    })

    test("appends required status suffixes to derived job titles", () => {
        expect(deriveJobTitleFromFileName("Some_Job_Name.md", "drafts")).toBe("Some Job Name (drafts)")
        expect(deriveJobTitleFromFileName("Some_Job_Name.md", "assist")).toBe("Some Job Name (assist)")
        expect(deriveJobTitleFromFileName("Some_Job_Name.md", "executing")).toBe("Some Job Name (executing)")
        expect(deriveJobTitleFromFileName("Some_Job_Name.md", "facilitate")).toBe("Some Job Name (facilitate)")
        expect(deriveJobTitleFromFileName("Some_Job_Name.md", "review")).toBe("Some Job Name (review)")
        expect(deriveJobTitleFromFileName("Some_Job_Name.md", "shelved")).toBe("Some Job Name (shelved)")
    })

    test("derives job titles from path-qualified filenames using the basename", () => {
        expect(deriveJobTitleFromFileName("nested/path/26-01-31_12-59-59.Some_Job_Name.md", "review")).toBe("Some Job Name (review)")
    })

    test("postfixes shelved collision job names with timestamp", () => {
        expect(createShelvedCollisionJobName("some_job", new Date("2026-05-27T10:11:12Z"))).toBe("some_job_26-05-27_10-11-12")
    })

    test("renames shelved job with timestamp when destination already exists", async () => {
        const fileSystem = {
            mkdir: mock(async () => undefined as string | undefined),
            readFile: mock(async () => ""),
            readdir: mock(async () => [] as import("fs").Dirent[]),
            rename: mock(async (_oldPath: string, newPath: string) => {
                if (newPath === "/workspace/.agents/jobs/shelved/my_feature") throw createCollisionError()
            }),
            rm: mock(async () => { }),
            stat: mock(async () => ({ mtimeMs: Date.now() })),
            writeFile: mock(async () => { }),
        }

        const result = await moveResolvedPlannedJobToStatus("/workspace", {
            job_name: "my_feature",
            status: "review",
            directory: "review",
            absolute_path: "/workspace/.agents/jobs/review/my_feature",
            job_path: ".agents/jobs/review/my_feature/",
            relative_job_path: ".agents/jobs/review/my_feature/",
        }, "shelved", fileSystem, {
            shelvedCollisionTimestamp: new Date("2026-05-27T10:11:12Z"),
        })

        expect(result).toEqual({
            type: "success",
            job: {
                job_name: "my_feature_26-05-27_10-11-12",
                status: "shelved",
                directory: "shelved",
                absolute_path: "/workspace/.agents/jobs/shelved/my_feature_26-05-27_10-11-12",
                job_path: ".agents/jobs/shelved/my_feature_26-05-27_10-11-12/",
                relative_job_path: ".agents/jobs/shelved/my_feature_26-05-27_10-11-12/",
            },
            from_status: "review",
        })
        expect(fileSystem.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/review/my_feature", "/workspace/.agents/jobs/shelved/my_feature")
        expect(fileSystem.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/review/my_feature", "/workspace/.agents/jobs/shelved/my_feature_26-05-27_10-11-12")
    })

    test("infers planned identity from matching session title and lets explicit job_name override stale title", async () => {
        const fileSystem = createFileSystem({ drafts: ["active_job"], review: ["review_job"] })
        const inferred = await resolvePlannedJobIdentity(fileSystem, createClient("Active Job (drafts)"), sessionContext)
        const overridden = await resolvePlannedJobIdentity(fileSystem, createClient("Wrong Title"), sessionContext, "review_job")

        expect(inferred).toMatchObject({
            mode: "planned",
            resolution: "found",
            explicit_override: false,
            job_name: "active_job",
            session_title: "Active Job (drafts)",
            title_derived_candidate: "active_job",
        })
        expect(overridden).toMatchObject({
            mode: "planned",
            resolution: "found",
            explicit_override: true,
            job_name: "review_job",
        })
        expect(overridden.session_title).toBeUndefined()
    })

    test("uses title-derived lookup as the fast path before persisted session_id fallback", async () => {
        const fileSystem = createFileSystem({ drafts: ["active_job"], executing: ["session_job"] }, {
            "/workspace/.agents/jobs/executing/session_job/session.yml": "session_id: session-1\n",
        })

        const identity = await resolvePlannedJobIdentity(fileSystem, createClient("Active Job"), sessionContext)

        expect(identity).toMatchObject({
            mode: "planned",
            resolution: "found",
            job_name: "active_job",
            title_derived_candidate: "active_job",
        })
        expect(fileSystem.readFile).not.toHaveBeenCalledWith("/workspace/.agents/jobs/executing/session_job/session.yml", "utf8")
    })

    test("falls back to persisted session_id when title-derived lookup misses", async () => {
        const fileSystem = createFileSystem({ executing: ["session_job"] }, {
            "/workspace/.agents/jobs/executing/session_job/session.yml": "session_id: session-1\n",
        })

        const identity = await resolvePlannedJobIdentity(fileSystem, createClient("Mutated Title"), sessionContext)

        expect(identity).toMatchObject({
            mode: "planned",
            resolution: "found",
            explicit_override: false,
            job_name: "session_job",
            session_title: "Mutated Title",
            title_derived_candidate: "mutated_title",
        })
        expect(identity.warning).toContain("Resolved planned job session_job from persisted session_id session-1")
    })

    test("resolves planned identity after session title mutation", async () => {
        const identity = await resolvePlannedJobIdentity(createFileSystem({ review: ["stable_job"] }, {
            "/workspace/.agents/jobs/review/stable_job/session.yml": "session_id: session-1\n",
        }), createClient("User Renamed This Session"), sessionContext)

        expect(identity).toMatchObject({
            mode: "planned",
            resolution: "found",
            job_name: "stable_job",
            resolved_job: {
                directory: "review",
                status: "review",
            },
        })
    })

    test("returns a collision when persisted session_id matches multiple active jobs", async () => {
        const identity = await resolvePlannedJobIdentity(createFileSystem({ drafts: ["first_job"], executing: ["second_job"] }, {
            "/workspace/.agents/jobs/drafts/first_job/session.yml": "session_id: session-1\n",
            "/workspace/.agents/jobs/executing/second_job/session.yml": "session_id: session-1\n",
        }), createClient("Missing Job"), sessionContext)

        expect(identity).toMatchObject({
            mode: "ad_hoc",
            resolution: "collision",
            job_name: "session_id session-1",
        })
        expect(identity.collision?.entries.map((entry) => entry.job_name)).toEqual(["first_job", "second_job"])
    })

    test("returns ad_hoc identity when current session title does not resolve to a lifecycle job", async () => {
        const identity = await resolvePlannedJobIdentity(createFileSystem({ drafts: ["other_job"] }), createClient("Missing Job"), sessionContext)

        expect(identity).toMatchObject({
            mode: "ad_hoc",
            resolution: "missing",
            explicit_override: false,
            job_name: "missing_job",
            session_title: "Missing Job",
            title_derived_candidate: "missing_job",
        })
        expect(identity.warning).toContain("did not match a planned job")
    })

    test("falls back to the first user prompt when the session title is blank or default", async () => {
        const blank = await getCurrentSessionTitle(createClient("", [{
            info: { id: "user-1", role: "user", time: { created: 1 } },
            parts: [{ type: "text", text: "Implement my feature request with tests.", messageID: "user-1" }],
        }]), sessionContext)
        const defaultTitle = await getCurrentSessionTitle(createClient("New Session", [{
            info: { id: "user-1", role: "user", time: { created: 1 } },
            parts: [{ type: "text", text: "   Improve dashboard exports immediately   ", messageID: "user-1" }],
        }]), sessionContext)

        expect(blank).toEqual({ title: "Implement my feature request with tests." })
        expect(defaultTitle).toEqual({ title: "Improve dashboard exports immediately" })
    })

    test("falls back to a timestamp title when the first user prompt is not valid text", async () => {
        const title = await getCurrentSessionTitle(createClient("New Session", [{
            info: { id: "user-1", role: "user", time: { created: 1 } },
            parts: [{ type: "text", text: "!!!", messageID: "user-1" }],
        }]), sessionContext)

        expect(title.title).toMatch(/^\d{2}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/)
    })
})
