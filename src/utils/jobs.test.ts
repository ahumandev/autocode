import { describe, expect, test } from "bun:test"
import { createJobWorkspace, deriveJobNameFromTitle, resolveAgentsStorageRoot, resolveJobWorkspaceIdentity, type JobToolFileSystem, type JobWorkspaceFileSystem } from "./jobs"

function createFileSystem(): { fileSystem: JobWorkspaceFileSystem, files: Map<string, string> } {
    const directories = new Set<string>()
    const files = new Map<string, string>()
    const fileSystem: JobWorkspaceFileSystem = {
        async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<string | undefined> {
            if (!options?.recursive && directories.has(dirPath)) {
                const error = new Error("exists") as NodeJS.ErrnoException
                error.code = "EEXIST"
                throw error
            }

            directories.add(dirPath)
            return undefined
        },
        async writeFile(filePath: string, content: string): Promise<void> {
            files.set(filePath, content)
        },
    }

    return { fileSystem, files }
}

function createIdentityFileSystem(workspaces: string[], sessionFiles: Record<string, string>): Pick<JobToolFileSystem, "readFile" | "readdir"> {
    return {
        async readdir(): Promise<string[]> {
            return workspaces
        },
        async readFile(filePath: string): Promise<string> {
            const content = sessionFiles[filePath]
            if (content !== undefined) return content
            const error = new Error("missing") as NodeJS.ErrnoException
            error.code = "ENOENT"
            throw error
        },
    }
}

describe("job workspace utilities", () => {
    test("creates timestamped design workspace with stable title conversion", async () => {
        const { fileSystem, files } = createFileSystem()
        const workspace = await createJobWorkspace(
            fileSystem,
            { directory: "/workspace", worktree: "/workspace" },
            "Feature: Fix API / UI",
            "# Design\n",
            new Date("2026-06-02T10:11:12Z"),
        )

        expect(workspace).toEqual({
            jobName: "feature_fix_api_ui",
            designPath: "/workspace/.agents/jobs/2026-06-02_10-11-12_feature_fix_api_ui/design.md",
        })
        expect(files.get(workspace.designPath)).toBe("# Design\n")
    })

    test("rejects same timestamp and title without overwriting first design", async () => {
        const { fileSystem, files } = createFileSystem()
        const context = { directory: "/workspace", worktree: "/workspace" }
        const now = new Date("2026-06-02T10:11:12Z")
        const first = await createJobWorkspace(fileSystem, context, "Same Title", "first", now)

        await expect(createJobWorkspace(fileSystem, context, "Same Title", "second", now))
            .rejects.toThrow("Job workspace already exists: .agents/jobs/2026-06-02_10-11-12_same_title")
        expect(files.get(first.designPath)).toBe("first")
    })

    test("uses context directory when worktree is filesystem root", () => {
        expect(resolveAgentsStorageRoot({ worktree: "/", directory: "/workspace/project" })).toBe("/workspace/project")
    })

    test("normal resolver keeps title fallback when no session-owned workspace exists", async () => {
        const workspace = "2026-08-20_10-30-00_my_feature"
        const sessionFile = `/workspace/.agents/jobs/${workspace}/session.yml`
        const result = await resolveJobWorkspaceIdentity(
            createIdentityFileSystem([workspace], { [sessionFile]: "session_id: prior-session\n" }),
            { session: { get: async () => ({ data: { title: "My Feature" } }) } } as never,
            { sessionID: "session-1", directory: "/workspace", worktree: "/workspace" },
        )

        expect(result).toEqual(expect.objectContaining({ resolution: "found", job_name: "my_feature", title_derived_candidate: "my_feature" }))
    })

    test("session-only resolver uses exact session ownership after title changes", async () => {
        const workspace = "2026-08-20_10-30-00_original_feature"
        const workspacePath = `/workspace/.agents/jobs/${workspace}/session.yml`
        const result = await resolveJobWorkspaceIdentity(
            createIdentityFileSystem([workspace], { [workspacePath]: "session_id: session-1\n" }),
            { session: { get: async () => ({ data: { title: "Renamed Feature" } }) } } as never,
            { sessionID: "session-1", directory: "/workspace", worktree: "/workspace" },
            { sessionOnly: true },
        )

        expect(result).toEqual(expect.objectContaining({ resolution: "found", job_name: "original_feature" }))
        expect(result.session_title).toBeUndefined()
    })
})
