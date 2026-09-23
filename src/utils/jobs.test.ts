import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { ensureSessionJobWorkspace, resolveAgentsStorageRoot, type JobToolFileSystem } from "./jobs"

function missingError(): NodeJS.ErrnoException {
    const error = new Error("missing") as NodeJS.ErrnoException
    error.code = "ENOENT"
    return error
}

function existingError(): NodeJS.ErrnoException {
    const error = new Error("exists") as NodeJS.ErrnoException
    error.code = "EEXIST"
    return error
}

function createFileSystem(): Pick<JobToolFileSystem, "mkdir" | "readdir"> & { directories: Set<string> } {
    const directories = new Set<string>()
    return {
        directories,
        async mkdir(directoryPath: string, options?: { recursive?: boolean }): Promise<string | undefined> {
            if (directories.has(directoryPath) && !options?.recursive) throw existingError()
            directories.add(directoryPath)
            return undefined
        },
        async readdir(directoryPath: string): Promise<string[]> {
            if (!directories.has(directoryPath)) throw missingError()
            return [...directories]
                .filter((entry: string): boolean => entry.startsWith(`${directoryPath}${path.sep}`))
                .map((entry: string): string => entry.slice(directoryPath.length + 1))
                .filter((entry: string): boolean => !entry.includes(path.sep))
        },
    }
}

function client(title: string): OpencodeClient {
    return { session: { get: async () => ({ data: { title } }) } } as unknown as OpencodeClient
}

const workspaceRoot = path.resolve("/workspace")
const context = { sessionID: "session-1", directory: workspaceRoot, worktree: workspaceRoot }
const fixedNow = (): Date => new Date("2026-08-20T10:30:00.000Z")

describe("session job workspaces", () => {
    test("uses context directory when worktree is filesystem root", () => {
        expect(resolveAgentsStorageRoot({ worktree: path.parse(workspaceRoot).root, directory: path.join(workspaceRoot, "project") })).toBe(path.join(workspaceRoot, "project"))
    })

    test("creates and deterministically reuses title-derived workspace without state files", async () => {
        const fileSystem = createFileSystem()
        const first = await ensureSessionJobWorkspace(fileSystem, client("My Feature"), context, { now: fixedNow })
        const second = await ensureSessionJobWorkspace(fileSystem, client("My Feature"), context, { now: fixedNow })

        expect(first).toEqual({
            job_name: "my_feature",
            job_path: ".agents/jobs/2026-08-20_10-30-00_my_feature/",
            absolute_path: path.join(workspaceRoot, ".agents", "jobs", "2026-08-20_10-30-00_my_feature"),
        })
        expect(second).toEqual(first)
        expect([...fileSystem.directories]).toEqual(expect.not.arrayContaining([expect.stringContaining("session.yml")]))
    })

    test("sanitizes title and keeps workspace inside job storage", async () => {
        const fileSystem = createFileSystem()
        const workspace = await ensureSessionJobWorkspace(fileSystem, client("Feature ../../ Escape"), context, { now: fixedNow })

        expect(workspace.job_name).toBe("feature_escape")
        expect(workspace.absolute_path).toBe(path.join(workspaceRoot, ".agents", "jobs", "2026-08-20_10-30-00_feature_escape"))
    })

    test("shares one in-flight creation across concurrent sessions with same title", async () => {
        const fileSystem = createFileSystem()
        const workspaces = await Promise.all(Array.from({ length: 8 }, async (_, index) => await ensureSessionJobWorkspace(
            fileSystem,
            client("Concurrent Feature"),
            { ...context, sessionID: `session-${index}` },
            { now: fixedNow },
        )))

        expect(new Set(workspaces.map((workspace) => workspace.absolute_path))).toEqual(new Set([path.join(workspaceRoot, ".agents", "jobs", "2026-08-20_10-30-00_concurrent_feature")]))
    })
})
