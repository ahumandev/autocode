import { describe, expect, mock, test } from "bun:test"
import { spawn as spawnChild } from "node:child_process"
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createManagedScriptRuntime, type ManagedScriptRuntimeChild, type ManagedScriptRuntimeDependencies, type ManagedScriptRuntimeFileSystem, type ManagedScriptRuntimeProcess, type ManagedScriptRuntimeSpawnOptions } from "./managed_script_runtime"
import { createManagedScriptProjectPaths, type ManagedScriptProject, type ManagedScriptProjectOwner } from "./managed_script_project"

const sessionID = "session-runtime"
const ownerName = "runtime-job"
const runID = "01".repeat(24)

type ProcessIdentity = { startTime: string, processGroup: number, state: string, command: string[] }

function missingFile(): Error & { code: string } {
    return Object.assign(new Error("missing"), { code: "ENOENT" })
}

function createFileSystem(overrides: Partial<ManagedScriptRuntimeFileSystem> = {}): ManagedScriptRuntimeFileSystem {
    return {
        appendFile: async (filePath, content) => await appendFile(filePath, content),
        lstat: async (filePath) => await lstat(filePath),
        mkdir: async (directory, options) => await mkdir(directory, options),
        readFile: async (filePath, encoding) => await readFile(filePath, encoding),
        readdir: async (directory, options) => options?.withFileTypes ? await readdir(directory, { withFileTypes: true }) : await readdir(directory),
        realpath: async (filePath) => await realpath(filePath),
        rename: async (oldPath, newPath) => await rename(oldPath, newPath),
        rm: async (filePath, options) => await rm(filePath, options),
        stat: async (filePath) => await stat(filePath),
        writeFile: async (filePath, content) => await writeFile(filePath, content),
        ...overrides,
    }
}

function projectFor(workspacePath: string): ManagedScriptProject {
    const paths = createManagedScriptProjectPaths(workspacePath)
    const result = {
        ok: true as const,
        paths,
        dependencies: [],
        npm: { exitCode: 0, stdout: "", stderr: "", command: [], logPath: join(paths.logsPath, "reconcile.log") },
    }
    return {
        setup: async () => result,
        install: async () => result,
        reconcile: async () => result,
    }
}

function runtimeFor(workspacePath: string, overrides: Partial<ManagedScriptRuntimeDependencies> = {}) {
    const owner: ManagedScriptProjectOwner = { jobName: ownerName, workspacePath }
    const runtimeProcess: ManagedScriptRuntimeProcess = {
        execPath: process.execPath,
        env: { PATH: process.env.PATH },
        platform: "linux",
        spawn: () => { throw new Error("spawn not configured") },
        kill: () => {},
    }
    return createManagedScriptRuntime({
        context: { sessionID, directory: workspacePath, worktree: workspacePath },
        project: projectFor(workspacePath),
        resolveOwner: async () => ({ ok: true, owner }),
        process: runtimeProcess,
        fileSystem: createFileSystem(),
        now: () => 1_700_000_000_000,
        randomBytes: (size) => Buffer.alloc(size, 1),
        sleep: async () => {},
        ...overrides,
    })
}

function processStat(identity: ProcessIdentity): string {
    const fields = Array.from({ length: 20 }, () => "0")
    fields[0] = identity.state
    fields[2] = `${identity.processGroup}`
    fields[19] = identity.startTime
    return `123 (node) ${fields.join(" ")}`
}

function processFileSystem(identities: Map<number, ProcessIdentity>, overrides: Partial<ManagedScriptRuntimeFileSystem> = {}): ManagedScriptRuntimeFileSystem {
    return createFileSystem({
        readFile: async (filePath, encoding) => {
            const match = /^\/proc\/(\d+)\/(stat|cmdline)$/.exec(filePath)
            if (!match) return await readFile(filePath, encoding)
            const identity = identities.get(Number(match[1]))
            if (!identity) throw missingFile()
            return match[2] === "stat" ? processStat(identity) : `${identity.command.join("\0")}\0`
        },
        ...overrides,
    })
}

function serviceState(owner: ManagedScriptProjectOwner, id: string, pid: number, entry: string, command: string = process.execPath): string {
    return `${JSON.stringify({
        version: 1,
        ownership: { job_name: owner.jobName, workspace_path: owner.workspacePath, session_id: sessionID },
        run_id: id,
        pid,
        pgid: pid,
        process_start_time: "100",
        command,
        entry,
        argv: ["service-arg"],
        started_at: "2023-11-14T22:13:20.000Z",
        stdout_log_path: join(owner.workspacePath, "scripts", "logs", `service-${id}.stdout.log`),
        stderr_log_path: join(owner.workspacePath, "scripts", "logs", `service-${id}.stderr.log`),
    }, undefined, 2)}\n`
}

function mockedChild(pid: number | undefined): { child: ManagedScriptRuntimeChild, emitStdout: (content: string) => void, emitStderr: (content: string) => void, error: (error: Error) => void, close: (exitCode: number | null, signal?: NodeJS.Signals | null) => void } {
    let stdoutListener: ((chunk: Buffer) => void) | undefined
    let stderrListener: ((chunk: Buffer) => void) | undefined
    let closeListener: ((exitCode: number | null, signal: NodeJS.Signals | null) => void) | undefined
    let errorListener: ((error: Error) => void) | undefined
    const child: ManagedScriptRuntimeChild = {
        ...(pid === undefined ? {} : { pid }),
        stdout: { on: (_event, listener) => { stdoutListener = listener } },
        stderr: { on: (_event, listener) => { stderrListener = listener } },
        on: ((event: "error" | "close", listener: ((error: Error) => void) | ((exitCode: number | null, signal: NodeJS.Signals | null) => void)) => {
            if (event === "error") errorListener = listener as (error: Error) => void
            else closeListener = listener as (exitCode: number | null, signal: NodeJS.Signals | null) => void
        }) as ManagedScriptRuntimeChild["on"],
    }
    return {
        child,
        emitStdout: (content) => stdoutListener?.(Buffer.from(content)),
        emitStderr: (content) => stderrListener?.(Buffer.from(content)),
        error: (error) => errorListener?.(error),
        close: (exitCode, signal = null) => closeListener?.(exitCode, signal),
    }
}

async function inTemporaryWorkspace(prefix: string, action: (workspacePath: string) => Promise<void>): Promise<void> {
    const workspacePath = await mkdtemp(join(tmpdir(), prefix))
    try {
        await action(workspacePath)
    }
    finally {
        await rm(workspacePath, { recursive: true, force: true })
    }
}

async function waitForFileContent(filePath: string): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            const content = await readFile(filePath, "utf8")
            if (content.trim()) return content
        }
        catch {
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`Timed out waiting for ${filePath}`)
}

async function waitForProcessExit(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            process.kill(pid, 0)
        }
        catch (error) {
            if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return
            throw error
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`Managed script process ${pid} did not exit`)
}

function killProcessGroupAndMembers(parentPID: number | undefined, childPID: number | undefined): void {
    if (parentPID && parentPID > 0) {
        try {
            process.kill(-parentPID, "SIGKILL")
        }
        catch {
        }
    }
    for (const pid of [parentPID, childPID]) {
        if (!pid || pid < 1) continue
        try {
            process.kill(pid, "SIGKILL")
        }
        catch {
        }
    }
}

describe("managed script runtime", () => {
    test("runs real ESM scripts with direct Node argv after reconciliation", async () => {
        await inTemporaryWorkspace("managed-runtime-esm-", async (rootPath) => {
            const workspacePath = join(rootPath, "job")
            const paths = createManagedScriptProjectPaths(workspacePath)
            const packageName = "managed-runtime-inherited"
            await mkdir(join(rootPath, "node_modules", packageName), { recursive: true })
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(paths.logsPath, { recursive: true })
            await writeFile(join(rootPath, "node_modules", packageName, "package.json"), `${JSON.stringify({ name: packageName, type: "module", exports: "./index.js" })}\n`)
            await writeFile(join(rootPath, "node_modules", packageName, "index.js"), "export const value = 'inherited dependency'\n")
            await writeFile(join(paths.sourceRoot, "run.mjs"), `import { value } from "${packageName}"\nconsole.log(value, process.argv.slice(2).join("|"))\n`)
            await mkdir(join(paths.sourceRoot, "nested"), { recursive: true })
            await writeFile(join(paths.sourceRoot, "nested", "task.mjs"), `import { value } from "${packageName}"\nconsole.log(value)\n`)
            const reconcile = mock(projectFor(workspacePath).reconcile)
            const spawn = mock((command: string, args: readonly string[], options: ManagedScriptRuntimeSpawnOptions) => spawnChild(command, [...args], options))
            const runtime = runtimeFor(workspacePath, {
                project: { ...projectFor(workspacePath), reconcile },
                process: {
                    execPath: "node",
                    env: {
                        PATH: process.env.PATH,
                        KEEP: "yes",
                        NODE_OPTIONS: "--require=/malicious/injection.cjs",
                        NODE_PATH: "/malicious/node_modules",
                        AUTOCODE_SCRIPT_ROOT: "/malicious/scripts",
                        AUTOCODE_WORKSPACE_ROOT: "/malicious/workspace",
                    },
                    platform: "linux",
                    spawn,
                    kill: (pid, signal) => { process.kill(pid, signal) },
                },
            })

            const result = await runtime.run({ entry: "run.mjs", argv: ["one", "two words"] })
            const nestedResult = await runtime.run({ entry: "nested/task.mjs" })
            const options = spawn.mock.calls[0]?.[2]

            expect(reconcile).toHaveBeenCalledTimes(2)
            expect(result).toMatchObject({ exit_code: 0, stdout: "inherited dependency one|two words\n", stderr: "", timed_out: false })
            expect(nestedResult).toMatchObject({ exit_code: 0, stdout: "inherited dependency\n", stderr: "", timed_out: false })
            expect(spawn.mock.calls[0]?.[0]).toBe("node")
            expect(spawn.mock.calls[0]?.[0]).not.toBe(process.execPath)
            expect(spawn.mock.calls[0]?.[1]).toEqual([join(paths.sourceRoot, "run.mjs"), "one", "two words"])
            expect(spawn.mock.calls[1]?.[1]).toEqual([join(paths.sourceRoot, "nested", "task.mjs")])
            expect(options).toMatchObject({ cwd: paths.scriptsRoot, shell: false, detached: true, stdio: "pipe" })
            expect(options?.env).toEqual({ PATH: process.env.PATH, KEEP: "yes", AUTOCODE_SCRIPT_ROOT: paths.scriptsRoot, AUTOCODE_WORKSPACE_ROOT: workspacePath })
        })
    })

    test("uses PATH-resolved node instead of host executable by default", async () => {
        await inTemporaryWorkspace("managed-runtime-default-node-", async (workspacePath) => {
            const paths = createManagedScriptProjectPaths(workspacePath)
            const owner: ManagedScriptProjectOwner = { jobName: ownerName, workspacePath }
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(paths.logsPath, { recursive: true })
            await writeFile(join(paths.sourceRoot, "argv0.mjs"), "console.log(process.argv0)\n")
            const runtime = createManagedScriptRuntime({
                context: { sessionID, directory: workspacePath, worktree: workspacePath },
                project: projectFor(workspacePath),
                resolveOwner: async () => ({ ok: true, owner }),
            })

            const result = await runtime.run({ entry: "argv0.mjs" })

            expect(result).toMatchObject({ exit_code: 0, stdout: "node\n", stderr: "", timed_out: false })
            expect(result.stdout).not.toBe(`${process.execPath}\n`)
        })
    })

    test("rejects prefixed, unsafe, non-file, and escaping source-relative entries", async () => {
        await inTemporaryWorkspace("managed-runtime-entry-", async (workspacePath) => {
            const paths = createManagedScriptProjectPaths(workspacePath)
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(paths.logsPath, { recursive: true })
            await writeFile(join(paths.sourceRoot, "safe.mjs"), "export {}\n")
            await mkdir(join(paths.sourceRoot, "directory.mjs"))
            const outsidePath = join(workspacePath, "outside.mjs")
            await writeFile(outsidePath, "export {}\n")
            await symlink(outsidePath, join(paths.sourceRoot, "escape.mjs"))
            await symlink(join(paths.sourceRoot, "missing.mjs"), join(paths.sourceRoot, "broken.mjs"))
            const runtime = runtimeFor(workspacePath)

            for (const entry of ["src/safe.mjs", "../safe.mjs", "nested/../safe.mjs", "/tmp/absolute.mjs", "C:\\tmp\\absolute.mjs", "nested\\safe.mjs", "safe.js"]) {
                await expect(runtime.run({ entry })).rejects.toThrow("source-relative .mjs")
            }
            await expect(runtime.run({ entry: "escape.mjs" })).rejects.toThrow("symlink resolves outside")
            await expect(runtime.run({ entry: "broken.mjs" })).rejects.toThrow("existing regular file")
            await expect(runtime.run({ entry: "directory.mjs" })).rejects.toThrow("existing regular file")
        })
    })

    test("bounds inline output while retaining complete finite-run logs", async () => {
        await inTemporaryWorkspace("managed-runtime-output-", async (workspacePath) => {
            const paths = createManagedScriptProjectPaths(workspacePath)
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(paths.logsPath, { recursive: true })
            await writeFile(join(paths.sourceRoot, "output.mjs"), "export {}\n")
            const child = mockedChild(41)
            const stdout = `${"a".repeat(40_000)}stdout-middle${"b".repeat(40_000)}`
            const stderr = `${"c".repeat(40_000)}stderr-middle${"d".repeat(40_000)}`
            const runtime = runtimeFor(workspacePath, {
                process: { execPath: process.execPath, env: {}, platform: "linux", spawn: () => {
                    queueMicrotask(() => { child.emitStdout(stdout); child.emitStderr(stderr); child.close(0) })
                    return child.child
                }, kill: () => {} },
            })

            const result = await runtime.run({ entry: "output.mjs" })
            const log = await readFile(result.log_path, "utf8")

            expect(result).toMatchObject({ exit_code: 0, stdout_truncated: true, stderr_truncated: true })
            expect(Buffer.byteLength(result.stdout)).toBe(65_536)
            expect(Buffer.byteLength(result.stderr)).toBe(65_536)
            expect(result.stdout).toContain("a".repeat(32_768))
            expect(result.stdout).toContain("b".repeat(32_768))
            expect(result.stderr).toContain("c".repeat(32_768))
            expect(result.stderr).toContain("d".repeat(32_768))
            expect(log).toContain("stdout-middle")
            expect(log).toContain("stderr-middle")
            expect(log).toContain(`"stdout_bytes": ${Buffer.byteLength(stdout)}`)
        })
    })

    test("records thrown and emitted spawn failures plus missing child PIDs", async () => {
        await inTemporaryWorkspace("managed-runtime-spawn-", async (workspacePath) => {
            const paths = createManagedScriptProjectPaths(workspacePath)
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(paths.logsPath, { recursive: true })
            await writeFile(join(paths.sourceRoot, "run.mjs"), "export {}\n")
            const failed = runtimeFor(workspacePath, { process: { execPath: process.execPath, env: {}, platform: "linux", spawn: () => { throw new Error("spawn failed") }, kill: () => {} }, randomBytes: (size) => Buffer.alloc(size, 2) })
            const erroredChild = mockedChild(42)
            const emittedFailure = runtimeFor(workspacePath, { process: { execPath: process.execPath, env: {}, platform: "linux", spawn: () => {
                queueMicrotask(() => erroredChild.error(new Error("emitted spawn failed")))
                return erroredChild.child
            }, kill: () => {} }, randomBytes: (size) => Buffer.alloc(size, 3) })
            const absentPID = runtimeFor(workspacePath, { process: { execPath: process.execPath, env: {}, platform: "linux", spawn: () => mockedChild(undefined).child, kill: () => {} }, randomBytes: (size) => Buffer.alloc(size, 4) })

            const failedResult = await failed.run({ entry: "run.mjs" })
            const emittedFailureResult = await emittedFailure.run({ entry: "run.mjs" })
            const absentPIDResult = await absentPID.run({ entry: "run.mjs" })

            expect(failedResult).toMatchObject({ exit_code: null, stderr: "spawn failed", timed_out: false })
            expect(await readFile(failedResult.log_path, "utf8")).toContain("spawn failed")
            expect(emittedFailureResult).toMatchObject({ exit_code: null, stderr: "emitted spawn failed", timed_out: false })
            expect(absentPIDResult).toMatchObject({ exit_code: null, stderr: "Managed script process did not provide a PID.", timed_out: false })
        })
    })

    test("times out finite runs by signalling their process group", async () => {
        await inTemporaryWorkspace("managed-runtime-timeout-", async (workspacePath) => {
            const paths = createManagedScriptProjectPaths(workspacePath)
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(paths.logsPath, { recursive: true })
            await writeFile(join(paths.sourceRoot, "wait.mjs"), "export {}\n")
            const child = mockedChild(77)
            const kills: Array<[number, NodeJS.Signals | 0]> = []
            const runtime = runtimeFor(workspacePath, { process: {
                execPath: process.execPath,
                env: {},
                platform: "linux",
                spawn: () => child.child,
                kill: (pid, signal) => {
                    kills.push([pid, signal])
                    if (pid === -77 && signal === "SIGTERM") child.close(null, "SIGTERM")
                },
            } })

            const result = await runtime.run({ entry: "wait.mjs", timeoutMs: 1 })

            expect(result).toMatchObject({ exit_code: null, timed_out: true })
            expect(kills).toEqual([[-77, "SIGTERM"]])
        })
    })

    test("writes exact full finite output to durable logs while returning bounded head and tail", async () => {
        await inTemporaryWorkspace("managed-runtime-exact-log-", async (workspacePath) => {
            const paths = createManagedScriptProjectPaths(workspacePath)
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(paths.logsPath, { recursive: true })
            await writeFile(join(paths.sourceRoot, "output.mjs"), "export {}\n")
            const child = mockedChild(43)
            const stdout = `${"H".repeat(40_000)}stdout-full-marker${"T".repeat(40_000)}`
            const stderr = `${"E".repeat(40_000)}stderr-full-marker${"R".repeat(40_000)}`
            const runtime = runtimeFor(workspacePath, { process: { execPath: process.execPath, env: {}, platform: "linux", spawn: () => {
                queueMicrotask(() => { child.emitStdout(stdout); child.emitStderr(stderr); child.close(0) })
                return child.child
            }, kill: () => {} } })

            const result = await runtime.run({ entry: "output.mjs" })
            const expectedLog = `${JSON.stringify({ exit_code: 0, duration_ms: 0, timed_out: false, stdout_bytes: Buffer.byteLength(stdout), stderr_bytes: Buffer.byteLength(stderr) }, undefined, 2)}\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}\n`

            expect(result.stdout).toBe(`${"H".repeat(32_768)}${"T".repeat(32_768)}`)
            expect(result.stderr).toBe(`${"E".repeat(32_768)}${"R".repeat(32_768)}`)
            expect(result).toMatchObject({ stdout_truncated: true, stderr_truncated: true })
            expect(await readFile(result.log_path, "utf8")).toBe(expectedLog)
        })
    })

    test("passes shell-sensitive argv strings unchanged to real Node scripts", async () => {
        await inTemporaryWorkspace("managed-runtime-argv-", async (workspacePath) => {
            const paths = createManagedScriptProjectPaths(workspacePath)
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(paths.logsPath, { recursive: true })
            await writeFile(join(paths.sourceRoot, "argv.mjs"), "console.log(JSON.stringify(process.argv.slice(2)))\n")
            const argv = ["space value", "quote\"and'quote", "$(not-a-command)", "semi;colon", "*.mjs"]
            const spawn = mock((command: string, args: readonly string[], options: ManagedScriptRuntimeSpawnOptions) => spawnChild(command, [...args], options))
            const runtime = runtimeFor(workspacePath, { process: {
                execPath: process.execPath,
                env: { PATH: process.env.PATH },
                platform: "linux",
                spawn,
                kill: (pid, signal) => { process.kill(pid, signal) },
            } })

            const result = await runtime.run({ entry: "argv.mjs", argv })

            expect(result).toMatchObject({ exit_code: 0, stdout: `${JSON.stringify(argv)}\n`, stderr: "" })
            expect(spawn.mock.calls[0]?.[1]).toEqual([join(paths.sourceRoot, "argv.mjs"), ...argv])
            expect(spawn.mock.calls[0]?.[2]?.shell).toBe(false)
        })
    })

    test("forces SIGKILL after a timeout when SIGTERM does not close the child", async () => {
        await inTemporaryWorkspace("managed-runtime-force-kill-", async (workspacePath) => {
            const paths = createManagedScriptProjectPaths(workspacePath)
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(paths.logsPath, { recursive: true })
            await writeFile(join(paths.sourceRoot, "wait.mjs"), "export {}\n")
            const originalSetTimeout = globalThis.setTimeout
            const timers: Array<() => void> = []
            const child = mockedChild(78)
            const kills: Array<[number, NodeJS.Signals | 0]> = []
            let notifySpawned: (() => void) | undefined
            const spawned = new Promise<void>((resolve) => { notifySpawned = resolve })
            globalThis.setTimeout = ((callback: () => void): ReturnType<typeof setTimeout> => {
                timers.push(callback)
                return 0 as unknown as ReturnType<typeof setTimeout>
            }) as typeof setTimeout
            try {
                const runtime = runtimeFor(workspacePath, { process: {
                    execPath: process.execPath,
                    env: {},
                    platform: "linux",
                    spawn: () => {
                        notifySpawned?.()
                        return child.child
                    },
                    kill: (pid, signal) => { kills.push([pid, signal]) },
                } })
                const pending = runtime.run({ entry: "wait.mjs", timeoutMs: 1 })
                await spawned
                const terminate = timers.shift()
                if (!terminate) throw new Error("Expected timeout timer")
                terminate()
                const forceKill = timers.shift()
                if (!forceKill) throw new Error("Expected force-kill timer")
                forceKill()
                child.close(null, "SIGKILL")
                const result = await pending

                expect(kills).toEqual([[-78, "SIGTERM"], [-78, "SIGKILL"]])
                expect(result).toMatchObject({ exit_code: null, timed_out: true })
            }
            finally {
                globalThis.setTimeout = originalSetTimeout
            }
        })
    })

    test("blocks run and start before spawn when dependency reconciliation fails or changes ownership", async () => {
        await inTemporaryWorkspace("managed-runtime-reconcile-", async (workspacePath) => {
            const spawn = mock(() => mockedChild(1).child)
            const failingProject = projectFor(workspacePath)
            failingProject.reconcile = async () => ({ ok: false, blocker: { code: "invalid_dependency", message: "dependency validation denied" } })
            const changedWorkspaceProject = projectFor(join(workspacePath, "other-workspace"))
            const runtimeProcess: ManagedScriptRuntimeProcess = { execPath: process.execPath, env: {}, platform: "linux", spawn, kill: () => {} }
            const failed = runtimeFor(workspacePath, { project: failingProject, process: runtimeProcess })
            const changed = runtimeFor(workspacePath, { project: changedWorkspaceProject, process: runtimeProcess })

            await expect(failed.run({ entry: "run.mjs" })).rejects.toThrow("dependency validation denied")
            expect(spawn).not.toHaveBeenCalled()
            await expect(failed.start({ entry: "run.mjs" })).rejects.toThrow("dependency validation denied")
            expect(spawn).not.toHaveBeenCalled()
            await expect(changed.run({ entry: "run.mjs" })).rejects.toThrow("ownership changed during dependency reconciliation")
            expect(spawn).not.toHaveBeenCalled()
            await expect(changed.start({ entry: "run.mjs" })).rejects.toThrow("ownership changed during dependency reconciliation")
            expect(spawn).not.toHaveBeenCalled()
        })
    })

    if (process.platform === "linux") test("stops a real service process group with its descendant", async () => {
        await inTemporaryWorkspace("managed-runtime-real-service-", async (workspacePath) => {
            const paths = createManagedScriptProjectPaths(workspacePath)
            const parentPath = join(paths.sourceRoot, "parent.mjs")
            let parentPID: number | undefined
            let childPID: number | undefined
            try {
                await mkdir(paths.sourceRoot, { recursive: true })
                await writeFile(join(paths.sourceRoot, "child.mjs"), "setInterval(() => {}, 1_000)\n")
                await writeFile(parentPath, "import { spawn } from 'node:child_process'\nimport { fileURLToPath } from 'node:url'\nconst child = spawn(process.execPath, [fileURLToPath(new URL('./child.mjs', import.meta.url))], { stdio: 'ignore' })\nprocess.on('SIGTERM', () => { child.once('exit', () => process.exit(0)); child.kill('SIGTERM') })\nconsole.log(child.pid)\nsetInterval(() => {}, 1_000)\n")
                const runtime = runtimeFor(workspacePath, { process: {
                    execPath: process.execPath,
                    env: { PATH: process.env.PATH },
                    platform: "linux",
                    spawn: (command, args, options) => spawnChild(command, [...args], options),
                    kill: (pid, signal) => { process.kill(pid, signal) },
                }, now: Date.now, sleep: async (milliseconds) => await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)) })
                const started = await runtime.start({ entry: "parent.mjs" })
                const state = JSON.parse(await readFile(join(paths.scriptsRoot, "services", `${started.run_id}.json`), "utf8")) as { pid: number }
                parentPID = state.pid
                childPID = Number((await waitForFileContent(started.stdout_log_path)).trim())
                const verifiedParentPID = parentPID
                const verifiedChildPID = childPID
                if (!verifiedParentPID || !verifiedChildPID) throw new Error("Expected parent and child service PIDs")
                expect(verifiedParentPID).toBeGreaterThan(0)
                expect(verifiedChildPID).toBeGreaterThan(0)

                await runtime.stop({ run_id: started.run_id })
                await waitForProcessExit(verifiedParentPID)
                await waitForProcessExit(verifiedChildPID)
                expect(() => process.kill(verifiedParentPID, 0)).toThrow()
                expect(() => process.kill(verifiedChildPID, 0)).toThrow()
            }
            finally {
                killProcessGroupAndMembers(parentPID, childPID)
            }
        })
    })
    else test.skip("stops a real service process group with its descendant", () => {})

    test("starts, reports, and stops Linux services with durable state and group signals", async () => {
        await inTemporaryWorkspace("managed-runtime-service-", async (workspacePath) => {
            const paths = createManagedScriptProjectPaths(workspacePath)
            const entry = join(paths.sourceRoot, "service.mjs")
            await mkdir(paths.sourceRoot, { recursive: true })
            await writeFile(entry, "export {}\n")
            const child = mockedChild(91)
            const spawn = mock((_command: string, _args: readonly string[], _options: ManagedScriptRuntimeSpawnOptions) => child.child)
            const identities = new Map<number, ProcessIdentity>([[91, { startTime: "100", processGroup: 91, state: "S", command: ["node", entry, "service-arg"] }]])
            const appends: Promise<void>[] = []
            const fileSystem = processFileSystem(identities, { appendFile: (filePath, content) => {
                const appended = appendFile(filePath, content)
                appends.push(appended)
                return appended
            } })
            const kills: Array<[number, NodeJS.Signals | 0]> = []
            let alive = true
            const runtime = runtimeFor(workspacePath, { fileSystem, process: {
                execPath: "node",
                env: {
                    KEEP: "service yes",
                    node_options: "--require=/malicious/injection.cjs",
                    NoDe_PaTh: "/malicious/node_modules",
                    AUTOCODE_SCRIPT_ROOT: "/malicious/scripts",
                    AUTOCODE_WORKSPACE_ROOT: "/malicious/workspace",
                },
                platform: "linux",
                spawn,
                kill: (pid, signal) => {
                    kills.push([pid, signal])
                    if (pid === -91 && signal === "SIGTERM") alive = false
                    if (pid === -91 && signal === 0 && !alive) throw Object.assign(new Error("gone"), { code: "ESRCH" })
                },
            } })

            const started = await runtime.start({ entry: "service.mjs", argv: ["service-arg"] })
            child.emitStdout("service output\n")
            child.emitStderr("service error\n")
            await Promise.all(appends)
            expect(await readFile(join(paths.scriptsRoot, "services", `${runID}.json`), "utf8")).toContain(`"session_id": "${sessionID}"`)
            const status = await runtime.status({ run_id: started.run_id })
            const stopped = await runtime.stop({ run_id: started.run_id })

            expect(started.run_id).toBe(runID)
            expect(spawn.mock.calls[0]?.[0]).toBe("node")
            expect(spawn.mock.calls[0]?.[1]).toEqual([entry, "service-arg"])
            expect(spawn.mock.calls[0]?.[2]?.cwd).toBe(paths.scriptsRoot)
            expect(spawn.mock.calls[0]?.[2]?.env).toEqual({ KEEP: "service yes", AUTOCODE_SCRIPT_ROOT: paths.scriptsRoot, AUTOCODE_WORKSPACE_ROOT: workspacePath })
            expect(await readFile(started.stdout_log_path, "utf8")).toBe("service output\n")
            expect(await readFile(started.stderr_log_path, "utf8")).toBe("service error\n")
            expect(status).toMatchObject({ run_id: runID, running: true, entry, argv: ["service-arg"] })
            expect(stopped).toEqual({ run_id: runID, stopped: true })
            expect(kills).toEqual([[-91, "SIGTERM"], [-91, 0]])
            await expect(readFile(join(paths.scriptsRoot, "services", `${runID}.json`), "utf8")).rejects.toThrow()
        })
    })

    test("rejects foreign services, finalizes stale services, and refuses PID reuse without signalling", async () => {
        await inTemporaryWorkspace("managed-runtime-identity-", async (workspacePath) => {
            const paths = createManagedScriptProjectPaths(workspacePath)
            const entry = join(paths.sourceRoot, "service.mjs")
            const foreignID = "b".repeat(48)
            const staleID = "c".repeat(48)
            const reusedID = "d".repeat(48)
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(join(paths.scriptsRoot, "services"), { recursive: true })
            await writeFile(entry, "export {}\n")
            const owner: ManagedScriptProjectOwner = { jobName: ownerName, workspacePath }
            const foreign = JSON.parse(serviceState(owner, foreignID, 101, entry)) as { ownership: { session_id: string } }
            foreign.ownership.session_id = "another-session"
            await writeFile(join(paths.scriptsRoot, "services", `${foreignID}.json`), `${JSON.stringify(foreign)}\n`)
            await writeFile(join(paths.scriptsRoot, "services", `${staleID}.json`), serviceState(owner, staleID, 102, entry))
            await writeFile(join(paths.scriptsRoot, "services", `${reusedID}.json`), serviceState(owner, reusedID, 103, entry))
            const identities = new Map<number, ProcessIdentity>([[103, { startTime: "101", processGroup: 103, state: "S", command: [process.execPath, entry, "service-arg"] }]])
            const kills: Array<[number, NodeJS.Signals | 0]> = []
            const runtime = runtimeFor(workspacePath, { fileSystem: processFileSystem(identities), process: {
                execPath: process.execPath, env: {}, platform: "linux", spawn: () => mockedChild(1).child, kill: (pid, signal) => { kills.push([pid, signal]) },
            } })

            await expect(runtime.stop({ run_id: foreignID })).rejects.toThrow("belongs to another job or session")
            await expect(runtime.status({ run_id: staleID })).rejects.toThrow("has already exited")
            await expect(runtime.stop({ run_id: reusedID })).rejects.toThrow("process identity changed")

            expect(kills).toEqual([])
            await expect(readFile(join(paths.scriptsRoot, "services", `${staleID}.json`), "utf8")).rejects.toThrow()
        })
    })

    test("cleanup stops only current-owner services and is idempotent", async () => {
        await inTemporaryWorkspace("managed-runtime-cleanup-", async (workspacePath) => {
            const paths = createManagedScriptProjectPaths(workspacePath)
            const entry = join(paths.sourceRoot, "service.mjs")
            const currentID = "e".repeat(48)
            const foreignID = "f".repeat(48)
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(join(paths.scriptsRoot, "services"), { recursive: true })
            await writeFile(entry, "export {}\n")
            const owner: ManagedScriptProjectOwner = { jobName: ownerName, workspacePath }
            await writeFile(join(paths.scriptsRoot, "services", `${currentID}.json`), serviceState(owner, currentID, 111, entry))
            const foreign = JSON.parse(serviceState(owner, foreignID, 112, entry)) as { ownership: { job_name: string } }
            foreign.ownership.job_name = "other-job"
            await writeFile(join(paths.scriptsRoot, "services", `${foreignID}.json`), `${JSON.stringify(foreign)}\n`)
            const identities = new Map<number, ProcessIdentity>([[111, { startTime: "100", processGroup: 111, state: "S", command: [process.execPath, entry, "service-arg"] }]])
            let alive = true
            const kills: Array<[number, NodeJS.Signals | 0]> = []
            const runtime = runtimeFor(workspacePath, { fileSystem: processFileSystem(identities), process: {
                execPath: process.execPath,
                env: {},
                platform: "linux",
                spawn: () => mockedChild(1).child,
                kill: (pid, signal) => {
                    kills.push([pid, signal])
                    if (pid === -111 && signal === "SIGTERM") alive = false
                    if (pid === -111 && signal === 0 && !alive) throw Object.assign(new Error("gone"), { code: "ESRCH" })
                },
            } })

            expect(await runtime.cleanup()).toEqual({ stopped_run_ids: [currentID], finalized_run_ids: [] })
            expect(await runtime.cleanup()).toEqual({ stopped_run_ids: [], finalized_run_ids: [] })
            expect(kills).toEqual([[-111, "SIGTERM"], [-111, 0]])
            expect(await readFile(join(paths.scriptsRoot, "services", `${foreignID}.json`), "utf8")).toContain("other-job")
        })
    })

    test("gates every service action on Linux", async () => {
        await inTemporaryWorkspace("managed-runtime-platform-", async (workspacePath) => {
            const runtime = runtimeFor(workspacePath, { process: { execPath: process.execPath, env: {}, platform: "darwin", spawn: () => mockedChild(1).child, kill: () => {} } })

            await expect(runtime.start({ entry: "service.mjs" })).rejects.toThrow("supported only on Linux")
            await expect(runtime.status({ run_id: runID })).rejects.toThrow("supported only on Linux")
            await expect(runtime.stop({ run_id: runID })).rejects.toThrow("supported only on Linux")
            await expect(runtime.cleanup()).rejects.toThrow("supported only on Linux")
        })
    })
})
