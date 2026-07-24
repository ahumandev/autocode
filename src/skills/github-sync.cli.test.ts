import { expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { GitHubSkillSyncOptions } from "./github-sync"

const repositoryRoot = join(import.meta.dir, "..", "..")
const scriptPath = join(repositoryRoot, "scripts", "sync-github-skills.ts")
const syncTraceEnvironmentVariable = "AUTOCODE_SYNC_GITHUB_SKILLS_TRACE"

interface ScriptResult {
    exitCode: number
    errors: string[]
    repositoryRoot: string
    syncCalls: GitHubSkillSyncOptions[]
}

async function runScript(arguments_: string[]): Promise<ScriptResult> {
    const root = await mkdtemp(join(repositoryRoot, ".sync-github-skills-cli-test-"))
    const isolatedScriptPath = join(root, "scripts", "sync-github-skills.ts")
    const tracePath = join(root, "sync-calls.jsonl")
    try {
        await mkdir(join(root, "scripts"), { recursive: true })
        await mkdir(join(root, "src", "skills"), { recursive: true })
        await copyFile(scriptPath, isolatedScriptPath)
        await writeFile(join(root, "src", "skills", "github-sync.ts"), [
            'import { appendFile } from "node:fs/promises"',
            "",
            "export async function syncGitHubSkillInventory(options: unknown): Promise<void> {",
            `    const tracePath = process.env.${syncTraceEnvironmentVariable}`,
            '    if (tracePath === undefined) throw new Error("Missing sync trace path")',
            '    await appendFile(tracePath, JSON.stringify(options) + "\\n")',
            "}",
            "",
        ].join("\n"))

        const child = Bun.spawn({
            cmd: [process.execPath, isolatedScriptPath, ...arguments_],
            cwd: root,
            env: { ...process.env, [syncTraceEnvironmentVariable]: tracePath },
            stdout: "pipe",
            stderr: "pipe",
        })
        const [stderr, exitCode] = await Promise.all([
            new Response(child.stderr).text(),
            child.exited,
        ])
        const trace = await readFile(tracePath, "utf8").catch(() => "")
        return {
            exitCode,
            errors: stderr.split(/\r?\n/).filter(Boolean),
            repositoryRoot: root,
            syncCalls: trace.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as GitHubSkillSyncOptions),
        }
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

test("accepts only exact force refresh flag before invoking GitHub sync", async () => {
    const forced = await runScript(["--force-refresh"])

    expect(forced.exitCode).toBe(0)
    expect(forced.errors).toEqual([])
    expect(forced.syncCalls).toHaveLength(1)
    expect(forced.syncCalls[0]).toEqual(expect.objectContaining({
        forceRefresh: true,
    }))

    const rejected = await runScript(["--force-refresh=true"])

    expect(rejected.exitCode).toBe(1)
    expect(rejected.errors).toEqual(["Unknown flag: --force-refresh=true"])
    expect(rejected.syncCalls).toEqual([])
})

test("invokes GitHub sync without force refresh when no arguments are given", async () => {
    const result = await runScript([])

    expect(result.exitCode).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.syncCalls).toHaveLength(1)
    expect(result.syncCalls[0]).toEqual(expect.objectContaining({ forceRefresh: false }))
    expect(result.syncCalls).not.toContainEqual(expect.objectContaining({ forceRefresh: true }))
})

test("wires exact home primary and project fallback GitHub cache roots into sync", async () => {
    const result = await runScript([])

    expect(result.exitCode).toBe(0)
    expect(result.syncCalls).toEqual([expect.objectContaining({
        cacheRoot: join(homedir(), ".cache", "autocode", "github"),
        fallbackCacheRoot: join(result.repositoryRoot, ".opencode", "autocode", "cache", "github"),
    })])
})
