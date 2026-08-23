import { describe, expect, test } from "bun:test"
import { resolveAgentsStorageRoot, resolveJobWorkspaceIdentity, type JobToolFileSystem } from "./jobs"

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

    test("session-only resolver reports missing without title fallback", async () => {
        const workspace = "2026-08-20_10-30-00_matching_title"
        const result = await resolveJobWorkspaceIdentity(
            createIdentityFileSystem([workspace], { [`/workspace/.agents/jobs/${workspace}/session.yml`]: "session_id: another-session\n" }),
            { session: { get: async () => ({ data: { title: "Matching title" } }) } } as never,
            { sessionID: "session-1", directory: "/workspace", worktree: "/workspace" },
            { sessionOnly: true },
        )

        expect(result).toEqual({ resolution: "missing" })
    })
})
