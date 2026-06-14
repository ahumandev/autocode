import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Dirent } from "fs"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { createRetryResponse, resetRetryCounts } from "@/utils/tools"
import { createAutocodeJobShelveTool } from "./autocode_job_shelve"
import { createToolContext } from "./test_context"

function createMissingError(): NodeJS.ErrnoException {
    const error = new Error("missing") as NodeJS.ErrnoException
    error.code = "ENOENT"
    return error
}

function createCollisionError(): NodeJS.ErrnoException {
    const error = new Error("collision") as NodeJS.ErrnoException
    error.code = "EEXIST"
    return error
}

function createDirent(name: string): Dirent {
    return { name, isDirectory: () => true, isFile: () => false } as Dirent
}

function createMockFs() {
    const files: Record<string, string> = {}
    return {
        mkdir: mock(async (_path: string, _opts?: { recursive?: boolean }) => undefined as string | undefined),
        readFile: mock(async (filePath: string, _encoding: "utf8"): Promise<string> => {
            if (filePath in files) return files[filePath]
            throw createMissingError()
        }),
        readdir: mock(async (_path: string, _opts?: { withFileTypes?: boolean }): Promise<string[] | Dirent[]> => []),
        rename: mock(async (_oldPath: string, _newPath: string) => { }),
        rm: mock(async (_path: string, _opts?: { recursive?: boolean, force?: boolean }) => { }),
        stat: mock(async (_path: string) => ({ mtimeMs: Date.now() })),
        writeFile: mock(async (filePath: string, content: string) => { files[filePath] = content }),
    }
}

function createClient(title: string | null | undefined, assistantText = "Shelving job after accepted review."): OpencodeClient & { session: { update: ReturnType<typeof mock>, promptAsync: ReturnType<typeof mock> } } {
    return {
        session: {
            get: mock(async (args: { path: { id: string }, query: { directory: string } }) => ({
                data: { id: args.path.id, title, directory: args.query.directory },
            })),
            update: mock(async (args: { path: { id: string }, query: { directory: string }, body: { title: string } }) => ({
                data: { id: args.path.id, title: args.body.title, directory: args.query.directory },
            })),
            messages: mock(async () => ({
                data: [{
                    info: { id: "assistant-1", role: "assistant", time: { created: 2 } },
                    parts: assistantText ? [{ type: "text", text: assistantText, messageID: "assistant-1" }] : [],
                }],
            })),
            promptAsync: mock(async () => ({})),
        },
    } as unknown as OpencodeClient & { session: { update: ReturnType<typeof mock>, promptAsync: ReturnType<typeof mock> } }
}

describe("autocode_job_shelve tool", () => {
    let xdgConfigHome: string | undefined
    let previousXdgConfigHome: string | undefined

    beforeEach(() => {
        previousXdgConfigHome = process.env.XDG_CONFIG_HOME
        xdgConfigHome = mkdtempSync(join(tmpdir(), "autocode-config-home-"))
        process.env.XDG_CONFIG_HOME = xdgConfigHome
    })

    beforeEach(() => { resetRetryCounts() })

    afterEach(() => {
        if (previousXdgConfigHome === undefined) {
            delete process.env.XDG_CONFIG_HOME
        } else {
            process.env.XDG_CONFIG_HOME = previousXdgConfigHome
        }

        if (xdgConfigHome) {
            rmSync(xdgConfigHome, { recursive: true, force: true })
        }
    })

    test("shelves current planned job without git checks or handoff", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string, options?: { withFileTypes?: boolean }) => {
            if (dirPath === "/workspace/.agents/jobs/review") return ["my_feature"]
            if (dirPath === "/workspace/.agents/jobs/shelved/my_feature") return []
            if (dirPath === "/workspace/.agents/sandboxes/my_feature" && options?.withFileTypes) return [createDirent("dev")]
            return []
        })
        fs.stat.mockImplementation(async (filePath: string) => {
            if (filePath === "/workspace/.agents/sandboxes/my_feature" || filePath === "/workspace/.agents/sandboxes/my_feature/dev") return { mtimeMs: Date.now() }
            if (filePath === "/workspace/.agents/jobs/shelved/my_feature/sandboxes/dev") throw createMissingError()
            return { mtimeMs: Date.now() }
        })
        const client = createClient("My Feature (review)")
        const tool = createAutocodeJobShelveTool(client, fs)

        const parsed = JSON.parse(await tool.execute({}, createToolContext()) as string)

        expect(parsed.current_status).toBe("shelved")
        expect(client.session.promptAsync).not.toHaveBeenCalled()
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/review/my_feature", "/workspace/.agents/jobs/shelved/my_feature")
    })

    test("resolves current planned job, shelves it, logs assistant actions, updates title, and archives sandboxes", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string, options?: { withFileTypes?: boolean }) => {
            if (dirPath === "/workspace/.agents/jobs/review") return ["my_feature"]
            if (dirPath === "/workspace/.agents/jobs/shelved/my_feature") return []
            if (dirPath === "/workspace/.agents/sandboxes/my_feature" && options?.withFileTypes) return [createDirent("dev")]
            return []
        })
        fs.stat.mockImplementation(async (filePath: string) => {
            if (filePath === "/workspace/.agents/sandboxes/my_feature" || filePath === "/workspace/.agents/sandboxes/my_feature/dev") return { mtimeMs: Date.now() }
            if (filePath === "/workspace/.agents/jobs/shelved/my_feature/sandboxes/dev") throw createMissingError()
            return { mtimeMs: Date.now() }
        })
        const client = createClient("My Feature (review)", "Accepted review. Action: archive sandbox and shelve job.")
        const tool = createAutocodeJobShelveTool(client, fs, () => new Date("2026-05-27T10:11:12Z"))

        const parsed = JSON.parse(await tool.execute({}, createToolContext()) as string)

        expect(parsed).toEqual({
            job_name: "my_feature",
            current_status: "shelved",
            job_path: ".agents/jobs/shelved/my_feature/",
            solution_path: ".agents/jobs/shelved/my_feature/solution.md",
            sandbox_archive: expect.objectContaining({ ok: true, status: "archived", archived: 1, job_name: "my_feature" }),
            next_action: "Shelve complete; the job has no active lifecycle directory.",
        })
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/review/my_feature", "/workspace/.agents/jobs/shelved/my_feature")
        expect(fs.writeFile).toHaveBeenCalledWith("/workspace/.agents/jobs/shelved/my_feature/solution.md", expect.stringContaining("# 26-05-27 10:11:12 - Update Status To shelved"))
        expect(fs.writeFile).toHaveBeenCalledWith("/workspace/.agents/jobs/shelved/my_feature/solution.md", expect.stringContaining("Accepted review. Action: archive sandbox and shelve job."))
        expect(client.session.update).toHaveBeenCalledWith({
            path: { id: "session-1" },
            query: { directory: "/workspace" },
            body: { title: "My Feature (shelved)" },
        })
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/sandboxes/my_feature/dev", "/workspace/.agents/jobs/shelved/my_feature/sandboxes/dev")
    })

    test("requires latest assistant response text before moving lifecycle directory", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string) => dirPath === "/workspace/.agents/jobs/review" ? ["my_feature"] : [])
        const tool = createAutocodeJobShelveTool(createClient("My Feature (review)", ""), fs)

        const result = await tool.execute({}, createToolContext())

        expect(result).toBe(createRetryResponse(
            "shelve job",
            "No assistant response text was found in the current session.",
            "First present the user-facing lifecycle update in assistant text with concrete actions and a separate reason/evidence summary, then call autocode_job_shelve again."
        ))
        expect(fs.rename).not.toHaveBeenCalled()
        expect(fs.writeFile).not.toHaveBeenCalled()
    })

    test("maps sandbox archive failure to retry JSON", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string, options?: { withFileTypes?: boolean }) => {
            if (dirPath === "/workspace/.agents/jobs/review") return ["my_feature"]
            if (dirPath === "/workspace/.agents/jobs/shelved/my_feature") return []
            if (dirPath === "/workspace/.agents/sandboxes/my_feature" && options?.withFileTypes) return [createDirent("dev")]
            return []
        })
        fs.stat.mockImplementation(async (filePath: string) => {
            if (filePath === "/workspace/.agents/sandboxes/my_feature" || filePath === "/workspace/.agents/sandboxes/my_feature/dev" || filePath === "/workspace/.agents/jobs/shelved/my_feature/sandboxes/dev") return { mtimeMs: Date.now() }
            throw createMissingError()
        })
        const tool = createAutocodeJobShelveTool(createClient("My Feature (review)"), fs)

        const result = await tool.execute({}, createToolContext())

        expect(result).toBe(createRetryResponse(
            "archive job sandboxes",
            "Sandbox archive destination already exists: /workspace/.agents/jobs/shelved/my_feature/sandboxes/dev",
            "Resolve the sandbox archive collision or unsafe path before retrying. Do not overwrite existing sandbox archives."
        ))
    })

    test("renames shelved destination with timestamp when job directory already exists", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string, options?: { withFileTypes?: boolean }) => {
            if (dirPath === "/workspace/.agents/jobs/review") return ["my_feature"]
            if (dirPath === "/workspace/.agents/jobs/shelved/my_feature_26-05-27_10-11-12") return []
            if (dirPath === "/workspace/.agents/sandboxes/my_feature" && options?.withFileTypes) return [createDirent("dev")]
            return []
        })
        fs.rename.mockImplementation(async (oldPath: string, newPath: string) => {
            if (oldPath === "/workspace/.agents/jobs/review/my_feature" && newPath === "/workspace/.agents/jobs/shelved/my_feature") {
                throw createCollisionError()
            }
        })
        fs.stat.mockImplementation(async (filePath: string) => {
            if (filePath === "/workspace/.agents/sandboxes/my_feature" || filePath === "/workspace/.agents/sandboxes/my_feature/dev") return { mtimeMs: Date.now() }
            if (filePath === "/workspace/.agents/jobs/shelved/my_feature_26-05-27_10-11-12/sandboxes/dev") throw createMissingError()
            return { mtimeMs: Date.now() }
        })
        const client = createClient("My Feature (review)")
        const tool = createAutocodeJobShelveTool(client, fs, () => new Date("2026-05-27T10:11:12Z"))

        const parsed = JSON.parse(await tool.execute({}, createToolContext()) as string)

        expect(parsed).toEqual({
            job_name: "my_feature_26-05-27_10-11-12",
            current_status: "shelved",
            job_path: ".agents/jobs/shelved/my_feature_26-05-27_10-11-12/",
            solution_path: ".agents/jobs/shelved/my_feature_26-05-27_10-11-12/solution.md",
            sandbox_archive: expect.objectContaining({ ok: true, status: "archived", archived: 1, job_name: "my_feature_26-05-27_10-11-12" }),
            next_action: "Shelve complete; the job has no active lifecycle directory.",
        })
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/review/my_feature", "/workspace/.agents/jobs/shelved/my_feature")
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/review/my_feature", "/workspace/.agents/jobs/shelved/my_feature_26-05-27_10-11-12")
        expect(fs.writeFile).toHaveBeenCalledWith("/workspace/.agents/jobs/shelved/my_feature_26-05-27_10-11-12/solution.md", expect.stringContaining("# 26-05-27 10:11:12 - Update Status To shelved"))
        expect(client.session.update).toHaveBeenCalledWith({
            path: { id: "session-1" },
            query: { directory: "/workspace" },
            body: { title: "My Feature 26-05-27 10-11-12 (shelved)" },
        })
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/sandboxes/my_feature/dev", "/workspace/.agents/jobs/shelved/my_feature_26-05-27_10-11-12/sandboxes/dev")
    })

    test("still shelves when current directory has no git behavior involved", async () => {
        const fs = createMockFs()
        fs.readdir.mockImplementation(async (dirPath: string, options?: { withFileTypes?: boolean }) => {
            if (dirPath === "/workspace/.agents/jobs/review") return ["my_feature"]
            if (dirPath === "/workspace/.agents/jobs/shelved/my_feature") return []
            if (dirPath === "/workspace/.agents/sandboxes/my_feature" && options?.withFileTypes) return [createDirent("dev")]
            return []
        })
        fs.stat.mockImplementation(async (filePath: string) => {
            if (filePath === "/workspace/.agents/sandboxes/my_feature" || filePath === "/workspace/.agents/sandboxes/my_feature/dev") return { mtimeMs: Date.now() }
            if (filePath === "/workspace/.agents/jobs/shelved/my_feature/sandboxes/dev") throw createMissingError()
            return { mtimeMs: Date.now() }
        })
        const client = createClient("My Feature (review)", "Accepted review. Action: archive sandbox and shelve job.")
        const tool = createAutocodeJobShelveTool(client, fs, () => new Date("2026-05-27T10:11:12Z"))

        const parsed = JSON.parse(await tool.execute({}, createToolContext()) as string)

        expect(parsed.current_status).toBe("shelved")
        expect(client.session.promptAsync).not.toHaveBeenCalled()
        expect(fs.rename).toHaveBeenCalledWith("/workspace/.agents/jobs/review/my_feature", "/workspace/.agents/jobs/shelved/my_feature")
    })
})
