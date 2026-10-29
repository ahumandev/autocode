import { describe, expect, mock, test } from "bun:test"
import { spawn as spawnChild, spawnSync } from "node:child_process"
import { appendFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { cleanupManagedScriptServices, createManagedScriptRuntime, type ManagedScriptRuntime, type ManagedScriptRuntimeChild, type ManagedScriptRuntimeDependencies, type ManagedScriptRuntimeFileSystem, type ManagedScriptRuntimeProcess, type ManagedScriptRuntimeSpawnOptions } from "./managed_script_runtime"
import { createManagedScriptProjectPaths, type ManagedScriptProject, type ManagedScriptProjectOwner, type ManagedScriptProjectOwnerResolution, type ManagedScriptProjectResult, type ManagedScriptProjectVerifyResult } from "./managed_script_project"

const sessionID = "session-runtime"
const ownerName = "runtime_job"
const runID = "01".repeat(24)
const logCapBytes = 1_048_576
const inlineHalfBytes = 32_768
const interleavedLogHeader = "stdout/stderr (interleaved):\n"
const entryConfinementMessage = "Managed script entry must remain confined to the current job source root under the real project directory; managed root and job-source symlink aliases are not allowed."
const missingEntryMessage = "Managed script entry must be an existing regular file."
const nodeAvailable = spawnSync("node", ["--version"], { stdio: "ignore" }).status === 0
const temporaryRoot = tmpdir()

async function canCreateFileSymlinks(): Promise<boolean> {
    const root = await mkdtemp(join(temporaryRoot, "managed-runtime-symlink-probe-"))
    try {
        await writeFile(join(root, "target"), "target")
        await symlink(join(root, "target"), join(root, "link"), "file")
        return true
    }
    catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) return false
        throw error
    }
    finally {
        await rm(root, { recursive: true, force: true })
    }
}

const fileSymlinksAvailable = await canCreateFileSymlinks()

type ProcessIdentity = { startTime: string, processGroup: number, state: string, command: string[] }

function missingFile(): Error & { code: string } {
    return Object.assign(new Error("missing"), { code: "ENOENT" })
}

function createFileSystem(overrides: Partial<ManagedScriptRuntimeFileSystem> = {}): ManagedScriptRuntimeFileSystem {
    return {
        appendFile: async (filePath, content) => await appendFile(filePath, content),
        link: async (existingPath, newPath): Promise<void> => await link(existingPath, newPath),
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
    const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
    const result = {
        ok: true as const,
        paths,
        dependencies: [],
    }
    return {
        setup: mock(async (): Promise<ManagedScriptProjectResult> => result),
        install: mock(async (): Promise<ManagedScriptProjectResult> => result),
        verify: mock(async (): Promise<ManagedScriptProjectVerifyResult> => ({ ok: true })),
    }
}

function runtimeFor(workspacePath: string, overrides: Partial<ManagedScriptRuntimeDependencies> = {}): ManagedScriptRuntime {
    const owner: ManagedScriptProjectOwner = { jobName: ownerName, directory: workspacePath }
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
        fileSystem: processFileSystem(new Map()),
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
    const paths = createManagedScriptProjectPaths(owner.directory, owner.jobName)
    return `${JSON.stringify({
        version: 1,
        ownership: { job_name: owner.jobName, workspace_path: owner.directory, session_id: sessionID },
        run_id: id,
        pid,
        pgid: pid,
        process_start_time: "100",
        command,
        entry,
        argv: ["service-arg"],
        started_at: "2023-11-14T22:13:20.000Z",
        stdout_log_path: join(paths.logsRoot, `service-${id}.stdout.log`),
        stderr_log_path: join(paths.logsRoot, `service-${id}.stderr.log`),
    }, undefined, 2)}\n`
}

function mockedChild(pid: number | undefined): { child: ManagedScriptRuntimeChild, emitStdout: (content: string) => void, emitStderr: (content: string) => void, error: (error: Error) => void, exit: (exitCode: number | null, signal?: NodeJS.Signals | null) => void, close: (exitCode: number | null, signal?: NodeJS.Signals | null) => void } {
    let stdoutListener: ((chunk: Buffer) => void) | undefined
    let stderrListener: ((chunk: Buffer) => void) | undefined
    let closeListener: ((exitCode: number | null, signal: NodeJS.Signals | null) => void) | undefined
    let exitListener: ((exitCode: number | null, signal: NodeJS.Signals | null) => void) | undefined
    let errorListener: ((error: Error) => void) | undefined
    const child: ManagedScriptRuntimeChild = {
        ...(pid === undefined ? {} : { pid }),
        stdout: { on: (_event, listener) => { stdoutListener = listener } },
        stderr: { on: (_event, listener) => { stderrListener = listener } },
        on: ((event: "spawn" | "exit" | "error" | "close", listener: (() => void) | ((error: Error) => void) | ((exitCode: number | null, signal: NodeJS.Signals | null) => void)): void => {
            if (event === "error") errorListener = listener as (error: Error) => void
            else if (event === "exit") exitListener = listener as (exitCode: number | null, signal: NodeJS.Signals | null) => void
            else if (event === "close") closeListener = listener as (exitCode: number | null, signal: NodeJS.Signals | null) => void
        }) as ManagedScriptRuntimeChild["on"],
    }
    return {
        child,
        emitStdout: (content) => stdoutListener?.(Buffer.from(content)),
        emitStderr: (content) => stderrListener?.(Buffer.from(content)),
        error: (error) => errorListener?.(error),
        exit: (exitCode, signal = null) => exitListener?.(exitCode, signal),
        close: (exitCode, signal = null) => closeListener?.(exitCode, signal),
    }
}

function linuxProcess(pid: number = 91): ManagedScriptRuntimeProcess {
    let alive = true
    return {
        execPath: process.execPath,
        env: { PATH: process.env.PATH },
        platform: "linux",
        spawn: mock((): ManagedScriptRuntimeChild => mockedChild(pid).child),
        kill: mock((target: number, signal: NodeJS.Signals | 0): void => {
            if (target !== -pid) throw new Error("unexpected process group")
            if (signal === "SIGTERM" || signal === "SIGKILL") alive = false
            if (signal === 0 && !alive) throw Object.assign(new Error("gone"), { code: "ESRCH" })
        }),
    }
}

async function inTemporaryWorkspace(prefix: string, action: (workspacePath: string) => Promise<void>): Promise<void> {
    const workspacePath = await realpath(await mkdtemp(join(temporaryRoot, prefix)))
    try {
        await action(workspacePath)
    }
    finally {
        await rm(workspacePath, { recursive: true, force: true })
    }
}

describe("managed script runtime", () => {
    test("reuses persisted timestamped sources for run and services with unchanged logical ownership", async (): Promise<void> => {
        await inTemporaryWorkspace("managed-runtime-timestamped-", async (workspacePath): Promise<void> => {
            const scriptsRoot = join(workspacePath, ".opencode", "autocode", "scripts")
            const sourceRoot = join(scriptsRoot, `26-01-02_03-04-05_${ownerName}`)
            const runEntry = join(sourceRoot, "run.mjs")
            const serviceEntry = join(sourceRoot, "service.mjs")
            await mkdir(sourceRoot, { recursive: true })
            await writeFile(runEntry, "export {}\n")
            await writeFile(serviceEntry, "export {}\n")
            await mkdir(join(scriptsRoot, `99-12-31_23-59-59_${ownerName}_2`))
            const outsideDirectory = join(workspacePath, "outside")
            await mkdir(outsideDirectory)
            await symlink(outsideDirectory, join(scriptsRoot, `99-12-31_23-59-59_${ownerName}`), process.platform === "win32" ? "junction" : "dir")
            const identities = new Map<number, ProcessIdentity>([[91, { startTime: "100", processGroup: 91, state: "S", command: [process.execPath, serviceEntry] }]])
            const runChild = mockedChild(81)
            const serviceChild = mockedChild(91)
            const spawn = mock((_command: string, args: readonly string[], _options: ManagedScriptRuntimeSpawnOptions): ManagedScriptRuntimeChild => {
                if (args[0] === runEntry) {
                    queueMicrotask((): void => { runChild.emitStdout("done\n"); runChild.close(0) })
                    return runChild.child
                }
                return serviceChild.child
            })
            const runtimeProcess = { ...linuxProcess(), spawn }
            const project = projectFor(workspacePath)
            const runtime = runtimeFor(workspacePath, { project, process: runtimeProcess, fileSystem: processFileSystem(identities) })
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)

            expect(paths.sourceRoot).toBe(sourceRoot)
            expect(await runtime.run({ entry: "run.mjs" })).toMatchObject({ exit_code: 0, stdout: "done\n", stderr: "", timed_out: false })
            const started = await runtime.start({ entry: "service.mjs" })
            expect(started.owner).toEqual({ jobName: ownerName, directory: workspacePath, sessionID })
            expect(started.stdout_log_path).toBe(join(paths.logsRoot, `service-${runID}.stdout.log`))
            expect(started.stderr_log_path).toBe(join(paths.logsRoot, `service-${runID}.stderr.log`))
            expect(spawn.mock.calls.map((call): readonly string[] => call[1])).toEqual([[runEntry], [serviceEntry]])
            for (const call of spawn.mock.calls) expect(call[2]).toMatchObject({ cwd: scriptsRoot, shell: false })
            const state: unknown = JSON.parse(await readFile(join(paths.servicesRoot, `${runID}.json`), "utf8"))
            expect(state).toMatchObject({ ownership: { job_name: ownerName, workspace_path: workspacePath, session_id: sessionID }, entry: serviceEntry })
            const restarted = runtimeFor(workspacePath, { process: runtimeProcess, fileSystem: processFileSystem(identities) })
            expect(await restarted.status({ run_id: runID })).toMatchObject({ running: true, entry: serviceEntry })
            expect(await restarted.stop({ run_id: runID })).toEqual({ run_id: runID, stopped: true })
            expect(project.setup).not.toHaveBeenCalled()
            expect(project.install).not.toHaveBeenCalled()
        })
    })

    test("runs real ESM scripts with direct executable argv after read-only verification", async () => {
        await inTemporaryWorkspace("managed-runtime-esm-", async (rootPath) => {
            const workspacePath = join(rootPath, "job")
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
            const packageName = "managed-runtime-inherited"
            await mkdir(join(rootPath, "node_modules", packageName), { recursive: true })
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(paths.logsRoot, { recursive: true })
            await writeFile(join(rootPath, "node_modules", packageName, "package.json"), `${JSON.stringify({ name: packageName, type: "module", exports: "./index.js" })}\n`)
            await writeFile(join(rootPath, "node_modules", packageName, "index.js"), "export const value = 'inherited dependency'\n")
            await writeFile(join(paths.sourceRoot, "run.mjs"), `import { value } from "${packageName}"\nconsole.log(value, process.argv.slice(2).join("|"))\n`)
            await mkdir(join(paths.sourceRoot, "nested"), { recursive: true })
            await writeFile(join(paths.sourceRoot, "nested", "task.mjs"), `import { value } from "${packageName}"\nconsole.log(value)\n`)
            const project = projectFor(workspacePath)
            const spawn = mock((command: string, args: readonly string[], options: ManagedScriptRuntimeSpawnOptions) => spawnChild(command, [...args], options))
            const executable = nodeAvailable ? "node" : process.execPath
            const runtime = runtimeFor(workspacePath, {
                project,
                fileSystem: createFileSystem(),
                process: {
                    execPath: executable,
                    env: {
                        PATH: process.env.PATH,
                        KEEP: "yes",
                        NODE_OPTIONS: "--require=/malicious/injection.cjs",
                        NODE_PATH: "/malicious/node_modules",
                        AUTOCODE_SCRIPT_ROOT: "/malicious/scripts",
                        AUTOCODE_WORKSPACE_ROOT: "/malicious/workspace",
                    },
                    platform: process.platform,
                    spawn,
                    kill: (pid, signal) => { process.kill(pid, signal) },
                },
            })

            const result = await runtime.run({ entry: "run.mjs", argv: ["one", "two words"] })
            const nestedResult = await runtime.run({ entry: "nested/task.mjs" })
            const options = spawn.mock.calls[0]?.[2]

            expect(project.verify).toHaveBeenCalledTimes(2)
            expect(project.setup).not.toHaveBeenCalled()
            expect(project.install).not.toHaveBeenCalled()
            expect(result).toMatchObject({ exit_code: 0, stdout: "inherited dependency one|two words\n", stderr: "", timed_out: false })
            expect(nestedResult).toMatchObject({ exit_code: 0, stdout: "inherited dependency\n", stderr: "", timed_out: false })
            expect(spawn.mock.calls[0]?.[0]).toBe(executable)
            expect(spawn.mock.calls[0]?.[1]).toEqual([join(paths.sourceRoot, "run.mjs"), "one", "two words"])
            expect(spawn.mock.calls[1]?.[1]).toEqual([join(paths.sourceRoot, "nested", "task.mjs")])
            expect(options).toMatchObject({ cwd: paths.scriptsRoot, shell: false, detached: true, stdio: "pipe" })
            expect(options?.env).toEqual({ PATH: process.env.PATH, KEEP: "yes", AUTOCODE_SCRIPT_ROOT: paths.scriptsRoot, AUTOCODE_WORKSPACE_ROOT: workspacePath })
        })
    })

    test.skipIf(!nodeAvailable)("uses PATH-resolved node instead of host executable by default", async () => {
        await inTemporaryWorkspace("managed-runtime-default-node-", async (workspacePath) => {
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
            const owner: ManagedScriptProjectOwner = { jobName: ownerName, directory: workspacePath }
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(paths.logsRoot, { recursive: true })
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

    test("rejects prefixed, unsafe, and non-file source-relative entries", async (): Promise<void> => {
        await inTemporaryWorkspace("managed-runtime-entry-", async (workspacePath): Promise<void> => {
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(paths.logsRoot, { recursive: true })
            await writeFile(join(paths.sourceRoot, "safe.mjs"), "export {}\n")
            await mkdir(join(paths.sourceRoot, "directory.mjs"))
            const runtime = runtimeFor(workspacePath)

            for (const entry of ["../safe.mjs", "nested/../safe.mjs", "/tmp/absolute.mjs", "C:\\tmp\\absolute.mjs", "nested\\safe.mjs", "safe.js"]) {
                await expect(runtime.run({ entry })).rejects.toThrow("Managed script entry must be a source-relative .mjs file without traversal.")
            }
            await expect(runtime.run({ entry: "src/safe.mjs" })).rejects.toThrow(missingEntryMessage)
            await expect(runtime.run({ entry: "directory.mjs" })).rejects.toThrow(missingEntryMessage)
        })
    })

    test.skipIf(!fileSymlinksAvailable)("rejects escaping and broken file-symlink entries", async (): Promise<void> => {
        await inTemporaryWorkspace("managed-runtime-file-symlink-", async (workspacePath): Promise<void> => {
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(paths.logsRoot, { recursive: true })
            const outsidePath = join(workspacePath, "outside.mjs")
            await writeFile(outsidePath, "export {}\n")
            await symlink(outsidePath, join(paths.sourceRoot, "escape.mjs"), "file")
            await symlink(join(paths.sourceRoot, "missing.mjs"), join(paths.sourceRoot, "broken.mjs"), "file")
            const runtime = runtimeFor(workspacePath)

            await expect(runtime.run({ entry: "escape.mjs" })).rejects.toThrow(entryConfinementMessage)
            await expect(runtime.run({ entry: "broken.mjs" })).rejects.toThrow(missingEntryMessage)
        })
    })

    test("permits contained entry-directory aliases and rejects escaping junctions", async (): Promise<void> => {
        await inTemporaryWorkspace("managed-runtime-junction-", async (workspacePath): Promise<void> => {
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
            const containedDirectory = join(paths.sourceRoot, "target")
            const outsideDirectory = join(workspacePath, "outside")
            await mkdir(containedDirectory, { recursive: true })
            await mkdir(outsideDirectory)
            await writeFile(join(containedDirectory, "task.mjs"), "export {}\n")
            await writeFile(join(outsideDirectory, "task.mjs"), "export {}\n")
            const linkType = process.platform === "win32" ? "junction" : "dir"
            await symlink(containedDirectory, join(paths.sourceRoot, "contained"), linkType)
            await symlink(outsideDirectory, join(paths.sourceRoot, "escaping"), linkType)
            const child = mockedChild(51)
            const spawn = mock((_command: string, _args: readonly string[], _options: ManagedScriptRuntimeSpawnOptions): ManagedScriptRuntimeChild => {
                queueMicrotask((): void => { child.emitStdout("contained\n"); child.close(0) })
                return child.child
            })
            const runtime = runtimeFor(workspacePath, { process: { ...linuxProcess(51), spawn } })

            expect(await runtime.run({ entry: "contained/task.mjs" })).toMatchObject({ exit_code: 0, stdout: "contained\n", stderr: "", timed_out: false })
            expect(spawn.mock.calls[0]?.[1]).toEqual([join(containedDirectory, "task.mjs")])
            expect(spawn.mock.calls[0]?.[2]?.cwd).toBe(paths.scriptsRoot)
            await expect(runtime.run({ entry: "escaping/task.mjs" })).rejects.toThrow(entryConfinementMessage)
            expect(spawn).toHaveBeenCalledTimes(1)
        })
    })

    test("bounds inline output while preserving finite-run logs below the disk cap", async () => {
        await inTemporaryWorkspace("managed-runtime-output-", async (workspacePath) => {
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(paths.logsRoot, { recursive: true })
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
            expect(dirname(result.log_path)).toBe(paths.logsRoot)
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
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(paths.logsRoot, { recursive: true })
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

    test("caps persisted output per stream during collection while retaining inline head, tail, and durable summary", async (): Promise<void> => {
        await inTemporaryWorkspace("managed-runtime-exact-log-", async (workspacePath) => {
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(paths.logsRoot, { recursive: true })
            await writeFile(join(paths.sourceRoot, "output.mjs"), "export {}\n")
            const child = mockedChild(43)
            const stdoutPrefix = `${"H".repeat(40_000)}stdout-prefix\n`
            const stderrPrefix = `${"E".repeat(40_000)}stderr-prefix\n`
            const stdoutTail = `${"M".repeat(logCapBytes)}${"T".repeat(40_000)}`
            const stderrTail = `${"N".repeat(logCapBytes)}${"R".repeat(40_000)}`
            const stdout = stdoutPrefix + stdoutTail
            const stderr = stderrPrefix + stderrTail
            const expectedPayloadBytes = logCapBytes * 2
            let payloadBytes = 0
            let resolvePayloadWritten: () => void = (): void => {}
            const payloadWritten = new Promise<void>((resolve): void => { resolvePayloadWritten = resolve })
            const payloadWrites: Promise<void>[] = []
            let logPath = ""
            const fileSystem = processFileSystem(new Map(), { appendFile: (filePath, content): Promise<void> => {
                logPath = filePath
                if (Buffer.isBuffer(content)) payloadBytes += content.length
                const written = appendFile(filePath, content)
                payloadWrites.push(written)
                return written.then((): void => { if (payloadBytes >= expectedPayloadBytes) resolvePayloadWritten() })
            } })
            const runtime = runtimeFor(workspacePath, { fileSystem, process: { execPath: process.execPath, env: {}, platform: "linux", spawn: () => {
                queueMicrotask((): void => { child.emitStdout(stdoutPrefix); child.emitStderr(stderrPrefix); child.emitStdout(stdoutTail); child.emitStderr(stderrTail) })
                return child.child
            }, kill: () => {} } })

            const pending = runtime.run({ entry: "output.mjs" })
            await payloadWritten
            await Promise.all(payloadWrites)
            const collectedLog = await readFile(logPath, "utf8")
            child.close(0)
            const result = await pending
            const cappedStdout = stdout.slice(0, logCapBytes)
            const cappedStderr = stderr.slice(0, logCapBytes)
            // Concurrent stream appenders preserve each stream's prefix, not cross-stream event order.
            const expectedCollectedLogs = [interleavedLogHeader + cappedStdout + cappedStderr, interleavedLogHeader + cappedStderr + cappedStdout]
            const summary = `\n\n${JSON.stringify({ exit_code: 0, duration_ms: 0, timed_out: false, stdout_bytes: Buffer.byteLength(stdout), stderr_bytes: Buffer.byteLength(stderr) }, undefined, 2)}\n`

            expect(result.stdout).toBe(`${"H".repeat(inlineHalfBytes)}${"T".repeat(inlineHalfBytes)}`)
            expect(result.stderr).toBe(`${"E".repeat(inlineHalfBytes)}${"R".repeat(inlineHalfBytes)}`)
            expect(result).toMatchObject({ exit_code: 0, timed_out: false, stdout_truncated: true, stderr_truncated: true })
            expect(payloadBytes).toBe(expectedPayloadBytes)
            expect(expectedCollectedLogs).toContain(collectedLog)
            expect(Buffer.byteLength(collectedLog)).toBe(Buffer.byteLength(interleavedLogHeader) + expectedPayloadBytes)
            expect(dirname(result.log_path)).toBe(paths.logsRoot)
            expect(await readFile(result.log_path, "utf8")).toBe(collectedLog + summary)
        })
    })

    test("passes shell-sensitive argv strings unchanged to real Node scripts", async () => {
        await inTemporaryWorkspace("managed-runtime-argv-", async (workspacePath) => {
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(paths.logsRoot, { recursive: true })
            await writeFile(join(paths.sourceRoot, "argv.mjs"), "console.log(JSON.stringify(process.argv.slice(2)))\n")
            const argv = ["", "space value", "quote\"and'quote", "$(not-a-command)", "semi;colon", "*.mjs"]
            const spawn = mock((command: string, args: readonly string[], options: ManagedScriptRuntimeSpawnOptions) => spawnChild(command, [...args], options))
            const runtime = runtimeFor(workspacePath, { fileSystem: createFileSystem(), process: {
                execPath: process.execPath,
                env: { PATH: process.env.PATH },
                platform: process.platform,
                spawn,
                kill: (pid, signal) => { process.kill(pid, signal) },
            } })

            const result = await runtime.run({ entry: "argv.mjs", argv })

            expect(result).toMatchObject({ exit_code: 0, stdout: `${JSON.stringify(argv)}\n`, stderr: "" })
            expect(spawn.mock.calls[0]?.[1]).toEqual([join(paths.sourceRoot, "argv.mjs"), ...argv])
            expect(spawn.mock.calls[0]?.[2]?.shell).toBe(false)
        })
    })

    test("blocks run and start before spawn when readiness fails or owner directory differs", async () => {
        await inTemporaryWorkspace("managed-runtime-verify-", async (workspacePath) => {
            const spawn = mock(() => mockedChild(1).child)
            const failingProject = projectFor(workspacePath)
            failingProject.verify = mock(async (): Promise<ManagedScriptProjectVerifyResult> => ({ ok: false, error: { code: "dependency_missing", message: "dependency readiness denied." } }))
            const changedWorkspaceProject = projectFor(workspacePath)
            const runtimeProcess: ManagedScriptRuntimeProcess = { execPath: process.execPath, env: {}, platform: "linux", spawn, kill: () => {} }
            const failed = runtimeFor(workspacePath, { project: failingProject, process: runtimeProcess })
            const changed = runtimeFor(workspacePath, { project: changedWorkspaceProject, process: runtimeProcess, resolveOwner: async () => ({ ok: true, owner: { jobName: ownerName, directory: join(workspacePath, "other-workspace") } }) })
            const readinessMessage = "Managed script project is not ready: dependency readiness denied. Call autocode_script_project to prepare the project and autocode_script_install for explicit dependency install or repair."
            const ownershipMessage = "Managed script owner directory must equal context.directory."

            await expect(failed.run({ entry: "run.mjs" })).rejects.toThrow(readinessMessage)
            expect(spawn).not.toHaveBeenCalled()
            await expect(failed.start({ entry: "run.mjs" })).rejects.toThrow(readinessMessage)
            expect(spawn).not.toHaveBeenCalled()
            await expect(changed.run({ entry: "run.mjs" })).rejects.toThrow(ownershipMessage)
            expect(spawn).not.toHaveBeenCalled()
            await expect(changed.start({ entry: "run.mjs" })).rejects.toThrow(ownershipMessage)
            expect(spawn).not.toHaveBeenCalled()
            expect(failingProject.verify).toHaveBeenCalledTimes(2)
            expect(failingProject.setup).not.toHaveBeenCalled()
            expect(failingProject.install).not.toHaveBeenCalled()
            expect(changedWorkspaceProject.verify).not.toHaveBeenCalled()
        })
    })

    test.skipIf(process.platform !== "linux")("starts, reports, and stops Linux services with durable state and group signals", async () => {
        await inTemporaryWorkspace("managed-runtime-service-", async (workspacePath) => {
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
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
            const project = projectFor(workspacePath)
            const runtime = runtimeFor(workspacePath, { project, fileSystem, process: {
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
            await Promise.resolve()
            await Promise.all(appends)
            const state: unknown = JSON.parse(await readFile(join(paths.servicesRoot, `${runID}.json`), "utf8"))
            expect(state).toMatchObject({ ownership: { job_name: ownerName, workspace_path: workspacePath, session_id: sessionID } })
            const status = await runtime.status({ run_id: started.run_id })
            const stopped = await runtime.stop({ run_id: started.run_id })

            expect(started.run_id).toBe(runID)
            expect(started.owner).toEqual({ jobName: ownerName, directory: workspacePath, sessionID })
            expect(project.verify).toHaveBeenCalledTimes(1)
            expect(project.setup).not.toHaveBeenCalled()
            expect(project.install).not.toHaveBeenCalled()
            expect(spawn.mock.calls[0]?.[0]).toBe("node")
            expect(spawn.mock.calls[0]?.[1]).toEqual([entry, "service-arg"])
            expect(spawn.mock.calls[0]?.[2]?.cwd).toBe(paths.scriptsRoot)
            expect(spawn.mock.calls[0]?.[2]?.env).toEqual({ KEEP: "service yes", AUTOCODE_SCRIPT_ROOT: paths.scriptsRoot, AUTOCODE_WORKSPACE_ROOT: workspacePath })
            expect(started.stdout_log_path).toBe(join(paths.logsRoot, `service-${runID}.stdout.log`))
            expect(started.stderr_log_path).toBe(join(paths.logsRoot, `service-${runID}.stderr.log`))
            expect(await readFile(started.stdout_log_path, "utf8")).toBe("service output\n")
            expect(await readFile(started.stderr_log_path, "utf8")).toBe("service error\n")
            expect(status).toMatchObject({ run_id: runID, running: true, entry, argv: ["service-arg"] })
            expect(stopped).toEqual({ run_id: runID, stopped: true })
            expect(kills).toEqual([[-91, "SIGTERM"], [-91, 0]])
            await expect(readFile(join(paths.servicesRoot, `${runID}.json`), "utf8")).rejects.toThrow()
        })
    })

    test.skipIf(process.platform !== "linux")("rejects foreign services, finalizes stale services, and refuses PID reuse without signalling", async () => {
        await inTemporaryWorkspace("managed-runtime-identity-", async (workspacePath) => {
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
            const entry = join(paths.sourceRoot, "service.mjs")
            const foreignID = "b".repeat(48)
            const staleID = "c".repeat(48)
            const reusedID = "d".repeat(48)
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(paths.servicesRoot, { recursive: true })
            await writeFile(entry, "export {}\n")
            const owner: ManagedScriptProjectOwner = { jobName: ownerName, directory: workspacePath }
            const foreign = JSON.parse(serviceState(owner, foreignID, 101, entry)) as { ownership: { session_id: string } }
            foreign.ownership.session_id = "another-session"
            await writeFile(join(paths.servicesRoot, `${foreignID}.json`), `${JSON.stringify(foreign)}\n`)
            await writeFile(join(paths.servicesRoot, `${staleID}.json`), serviceState(owner, staleID, 102, entry))
            await writeFile(join(paths.servicesRoot, `${reusedID}.json`), serviceState(owner, reusedID, 103, entry))
            const identities = new Map<number, ProcessIdentity>([[103, { startTime: "101", processGroup: 103, state: "S", command: [process.execPath, entry, "service-arg"] }]])
            const kills: Array<[number, NodeJS.Signals | 0]> = []
            const runtime = runtimeFor(workspacePath, { fileSystem: processFileSystem(identities), process: {
                execPath: process.execPath, env: {}, platform: "linux", spawn: () => mockedChild(1).child, kill: (pid, signal) => { kills.push([pid, signal]) },
            } })

            await expect(runtime.stop({ run_id: foreignID })).rejects.toThrow("belongs to another job or session")
            await expect(runtime.status({ run_id: staleID })).rejects.toThrow("has already exited")
            await expect(runtime.stop({ run_id: reusedID })).rejects.toThrow("process identity changed")

            expect(kills).toEqual([])
            await expect(readFile(join(paths.servicesRoot, `${staleID}.json`), "utf8")).rejects.toThrow()
        })
    })

    test.skipIf(process.platform !== "linux")("cleanup stops only current-owner services and is idempotent", async () => {
        await inTemporaryWorkspace("managed-runtime-cleanup-", async (workspacePath) => {
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
            const entry = join(paths.sourceRoot, "service.mjs")
            const currentID = "e".repeat(48)
            const foreignID = "f".repeat(48)
            await mkdir(paths.sourceRoot, { recursive: true })
            await mkdir(paths.servicesRoot, { recursive: true })
            await writeFile(entry, "export {}\n")
            const owner: ManagedScriptProjectOwner = { jobName: ownerName, directory: workspacePath }
            await writeFile(join(paths.servicesRoot, `${currentID}.json`), serviceState(owner, currentID, 111, entry))
            const foreign = JSON.parse(serviceState(owner, foreignID, 112, entry)) as { ownership: { job_name: string } }
            foreign.ownership.job_name = "other-job"
            await writeFile(join(paths.servicesRoot, `${foreignID}.json`), `${JSON.stringify(foreign)}\n`)
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
            expect(await readFile(join(paths.servicesRoot, `${foreignID}.json`), "utf8")).toContain("other-job")
        })
    })

    test("starts and manages Linux v1 state with exact argv, bounded logs, and owned group signals on every host", async (): Promise<void> => {
        await inTemporaryWorkspace("managed-runtime-linux-managed-", async (workspacePath): Promise<void> => {
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
            const entry = join(paths.sourceRoot, "service.mjs")
            await mkdir(paths.sourceRoot, { recursive: true })
            await writeFile(entry, "export {}\n")
            const argv = ["one", "two words", "quote\"and'quote", "$(not-code);&", "tail\\"]
            const identities = new Map<number, ProcessIdentity>([[91, { startTime: "100", processGroup: 91, state: "S", command: [process.execPath, entry, ...argv] }]])
            const appends: Promise<void>[] = []
            const fileSystem = processFileSystem(identities, { appendFile: (filePath, content): Promise<void> => {
                const appended = appendFile(filePath, content)
                appends.push(appended)
                return appended
            } })
            const child = mockedChild(91)
            const spawn = mock((_command: string, _args: readonly string[], _options: ManagedScriptRuntimeSpawnOptions): ManagedScriptRuntimeChild => child.child)
            const runtimeProcess = { ...linuxProcess(), spawn }
            const project = projectFor(workspacePath)
            const runtime = runtimeFor(workspacePath, { project, process: runtimeProcess, fileSystem })
            const started = await runtime.start({ entry: "service.mjs", argv })
            const stdout = `service output\n${"S".repeat(logCapBytes)}`
            const stderr = `service error\n${"E".repeat(logCapBytes)}`
            child.emitStdout(stdout)
            child.emitStderr(stderr)
            await Promise.resolve()
            await Promise.all(appends)
            const state: unknown = JSON.parse(await readFile(join(paths.servicesRoot, `${runID}.json`), "utf8"))
            expect(state).toMatchObject({ version: 1, run_id: runID, pid: 91, pgid: 91, process_start_time: "100", command: process.execPath, ownership: { job_name: ownerName, workspace_path: workspacePath, session_id: sessionID }, entry, argv, started_at: "2023-11-14T22:13:20.000Z", stdout_log_path: started.stdout_log_path, stderr_log_path: started.stderr_log_path })
            expect(state).not.toHaveProperty("identity")
            expect(started.owner).toEqual({ jobName: ownerName, directory: workspacePath, sessionID })
            expect(started.stdout_log_path).toBe(join(paths.logsRoot, `service-${runID}.stdout.log`))
            expect(started.stderr_log_path).toBe(join(paths.logsRoot, `service-${runID}.stderr.log`))
            expect(spawn.mock.calls[0]?.[0]).toBe(process.execPath)
            expect(spawn.mock.calls[0]?.[1]).toEqual([entry, ...argv])
            expect(spawn.mock.calls[0]?.[2]).toMatchObject({ cwd: paths.scriptsRoot, shell: false, detached: true, stdio: "pipe" })
            expect(await readFile(started.stdout_log_path, "utf8")).toBe(stdout.slice(0, logCapBytes))
            expect(await readFile(started.stderr_log_path, "utf8")).toBe(stderr.slice(0, logCapBytes))
            expect((await stat(started.stdout_log_path)).size).toBe(logCapBytes)
            expect((await stat(started.stderr_log_path)).size).toBe(logCapBytes)
            expect(await runtime.status({ run_id: runID })).toMatchObject({ run_id: runID, running: true, entry, argv, stdout_log_path: started.stdout_log_path, stderr_log_path: started.stderr_log_path })
            expect(await runtime.stop({ run_id: runID })).toEqual({ run_id: runID, stopped: true })
            expect(runtimeProcess.kill).toHaveBeenCalledTimes(2)
            expect(runtimeProcess.kill).toHaveBeenNthCalledWith(1, -91, "SIGTERM")
            expect(runtimeProcess.kill).toHaveBeenNthCalledWith(2, -91, 0)
            expect(project.verify).toHaveBeenCalledTimes(1)
            expect(project.setup).not.toHaveBeenCalled()
            expect(project.install).not.toHaveBeenCalled()
            await expect(readFile(join(paths.servicesRoot, `${runID}.json`), "utf8")).rejects.toThrow()
        })
    })

    test("preserves leading empty service argv through Linux process identity checks", async (): Promise<void> => {
        await inTemporaryWorkspace("managed-runtime-linux-empty-argv-", async (workspacePath): Promise<void> => {
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
            const entry = join(paths.sourceRoot, "service.mjs")
            await mkdir(paths.sourceRoot, { recursive: true })
            await writeFile(entry, "export {}\n")
            const argv = ["", "two words", "quote\"and'quote", "$(not-code);&", "tail\\"]
            const identities = new Map<number, ProcessIdentity>([[91, { startTime: "100", processGroup: 91, state: "S", command: [process.execPath, entry, ...argv] }]])
            const fileSystem = processFileSystem(identities)
            const cmdline = await fileSystem.readFile("/proc/91/cmdline", "utf8")
            expect(cmdline.endsWith("\0")).toBe(true)
            expect(cmdline.split("\0").slice(0, -1)).toEqual([process.execPath, entry, ...argv])
            const runtimeProcess = linuxProcess()
            const runtime = runtimeFor(workspacePath, { process: runtimeProcess, fileSystem })

            const started = await runtime.start({ entry: "service.mjs", argv })
            expect(runtimeProcess.spawn).toHaveBeenCalledWith(process.execPath, [entry, ...argv], expect.objectContaining({ cwd: paths.scriptsRoot, shell: false }))
            const state: unknown = JSON.parse(await readFile(join(paths.servicesRoot, `${started.run_id}.json`), "utf8"))
            expect(state).toMatchObject({ version: 1, pid: 91, pgid: 91, process_start_time: "100", command: process.execPath, entry, argv })
            expect(await runtime.status({ run_id: started.run_id })).toMatchObject({ running: true, entry, argv })
            expect(runtimeProcess.kill).not.toHaveBeenCalled()
            expect(await runtime.stop({ run_id: started.run_id })).toEqual({ run_id: started.run_id, stopped: true })
            expect(runtimeProcess.kill).toHaveBeenCalledTimes(2)
            expect(runtimeProcess.kill).toHaveBeenNthCalledWith(1, -91, "SIGTERM")
            expect(runtimeProcess.kill).toHaveBeenNthCalledWith(2, -91, 0)
        })
    })

    test("rejects malformed Linux identities, foreign sessions, and wrong-platform records before inspection or signals", async (): Promise<void> => {
        await inTemporaryWorkspace("managed-runtime-linux-parser-", async (workspacePath): Promise<void> => {
            const owner = { directory: workspacePath, jobName: ownerName }
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
            await mkdir(paths.servicesRoot, { recursive: true })
            const filePath = join(paths.servicesRoot, `${runID}.json`)
            const runtimeProcess = linuxProcess()
            const inspect = mock((): never => { throw new Error("must not inspect rejected service state") })
            const fileSystem = createFileSystem({ readFile: async (filePath, encoding): Promise<string> => filePath.startsWith("/proc/") ? inspect() : await readFile(filePath, encoding) })
            const runtime = runtimeFor(workspacePath, { process: runtimeProcess, fileSystem })
            const good = JSON.parse(serviceState(owner, runID, 91, join(paths.sourceRoot, "service.mjs"))) as Record<string, unknown>
            for (const patch of [
                { pid: "91" },
                { pid: 1.5 },
                { pid: null },
                { pgid: "91" },
                { pgid: 1.5 },
                { process_start_time: 100 },
                { ownership: { job_name: ownerName, workspace_path: workspacePath, session_id: 91 } },
                { run_id: "invalid" },
            ]) {
                await writeFile(filePath, JSON.stringify({ ...good, ...patch }))
                await expect(runtime.status({ run_id: runID })).rejects.toThrow("Managed script service state is malformed.")
            }
            await writeFile(filePath, JSON.stringify({ ...good, ownership: { job_name: ownerName, workspace_path: workspacePath, session_id: "foreign" } }))
            await expect(runtime.stop({ run_id: runID })).rejects.toThrow("Managed script service run ID belongs to another job or session.")
            const wrongPlatform = { ...good, version: 2, identity: { kind: "windows", pid: 91, creation_time_ticks: "638954123456789012" } }
            await writeFile(filePath, JSON.stringify(wrongPlatform))
            const platformMessage = "Managed script service state belongs to a different operating system; refusing process management."
            await expect(runtime.status({ run_id: runID })).rejects.toThrow(platformMessage)
            await expect(runtime.stop({ run_id: runID })).rejects.toThrow(platformMessage)
            expect(inspect).not.toHaveBeenCalled()
            expect(runtimeProcess.spawn).not.toHaveBeenCalled()
            expect(runtimeProcess.kill).not.toHaveBeenCalled()
            expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(wrongPlatform)
        })
    })

    test.each(["status", "stop"] as const)("Linux %s finalizes an absent identity without signalling on every host", async (action): Promise<void> => {
        await inTemporaryWorkspace("managed-runtime-linux-missing-", async (workspacePath): Promise<void> => {
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
            await mkdir(paths.servicesRoot, { recursive: true })
            const filePath = join(paths.servicesRoot, `${runID}.json`)
            await writeFile(filePath, serviceState({ directory: workspacePath, jobName: ownerName }, runID, 91, join(paths.sourceRoot, "service.mjs")))
            const runtimeProcess = linuxProcess()
            const runtime = runtimeFor(workspacePath, { process: runtimeProcess, fileSystem: processFileSystem(new Map()) })
            await expect(runtime[action]({ run_id: runID })).rejects.toThrow("Managed script service has already exited.")
            expect(runtimeProcess.kill).not.toHaveBeenCalled()
            expect(runtimeProcess.spawn).not.toHaveBeenCalled()
            await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
        })
    })

    test.each(["running", "missing", "mismatch", "denied"] as const)("Linux lifecycle cleanup handles %s identity with session isolation on every host", async (status): Promise<void> => {
        await inTemporaryWorkspace("managed-runtime-linux-cleanup-", async (workspacePath): Promise<void> => {
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
            await mkdir(paths.servicesRoot, { recursive: true })
            const owner = { directory: workspacePath, jobName: ownerName }
            const foreignID = "f".repeat(48)
            const entry = join(paths.sourceRoot, "service.mjs")
            const good = serviceState(owner, runID, 91, entry)
            const foreignState = JSON.parse(serviceState(owner, foreignID, 92, entry)) as Record<string, unknown>
            const foreign = JSON.stringify({ ...foreignState, ownership: { job_name: ownerName, workspace_path: workspacePath, session_id: "foreign" } })
            const filePath = join(paths.servicesRoot, `${runID}.json`)
            await writeFile(filePath, good)
            await writeFile(join(paths.servicesRoot, `${foreignID}.json`), foreign)
            const identities = new Map<number, ProcessIdentity>()
            if (status !== "missing") identities.set(91, { startTime: status === "mismatch" ? "101" : "100", processGroup: 91, state: "S", command: [process.execPath, entry, "service-arg"] })
            const runtimeProcess = linuxProcess()
            const allowedKill = runtimeProcess.kill
            if (status === "denied") runtimeProcess.kill = mock((): never => { throw Object.assign(new Error("access denied"), { code: "EACCES" }) })
            const deniedKill = runtimeProcess.kill
            const inspected: number[] = []
            const processFiles = processFileSystem(identities)
            const fileSystem = processFileSystem(identities, { readFile: async (filePath, encoding): Promise<string> => {
                const match = /^\/proc\/(\d+)\//.exec(filePath)
                if (match) inspected.push(Number(match[1]))
                return await processFiles.readFile(filePath, encoding)
            } })
            const runtime = runtimeFor(workspacePath, { process: runtimeProcess, fileSystem })
            if (status === "denied") {
                await expect(runtime.cleanup()).rejects.toThrow("Unable to signal managed script process group: access denied")
                expect(await readFile(filePath, "utf8")).toBe(good)
                expect(deniedKill).toHaveBeenCalledTimes(1)
                expect(deniedKill).toHaveBeenCalledWith(-91, "SIGTERM")
                runtimeProcess.kill = allowedKill
                expect(await runtime.cleanup()).toEqual({ stopped_run_ids: [runID], finalized_run_ids: [] })
            }
            else {
                const result = await runtime.cleanup()
                expect(result).toEqual({ stopped_run_ids: status === "running" ? [runID] : [], finalized_run_ids: status === "running" ? [] : [runID] })
            }
            expect(await runtime.cleanup()).toEqual({ stopped_run_ids: [], finalized_run_ids: [] })
            expect(allowedKill).toHaveBeenCalledTimes(status === "running" || status === "denied" ? 2 : 0)
            expect(runtimeProcess.spawn).not.toHaveBeenCalled()
            expect(inspected.length).toBeGreaterThan(0)
            expect(inspected.every((pid: number): boolean => pid === 91)).toBe(true)
            await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
            expect(await readFile(join(paths.servicesRoot, `${foreignID}.json`), "utf8")).toBe(foreign)
        })
    })

    test("loads legacy Linux v1 unchanged on every test host", async (): Promise<void> => {
        await inTemporaryWorkspace("managed-runtime-linux-v1-", async (workspacePath): Promise<void> => {
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
            const entry = join(paths.sourceRoot, "service.mjs")
            await mkdir(paths.servicesRoot, { recursive: true })
            await writeFile(join(paths.servicesRoot, `${runID}.json`), serviceState({ directory: workspacePath, jobName: ownerName }, runID, 91, entry))
            const identities = new Map<number, ProcessIdentity>([[91, { startTime: "100", processGroup: 91, state: "S", command: [process.execPath, entry, "service-arg"] }]])
            const runtimeProcess = linuxProcess()
            const runtime = runtimeFor(workspacePath, { process: runtimeProcess, fileSystem: processFileSystem(identities) })
            expect(await runtime.status({ run_id: runID })).toEqual({ run_id: runID, running: true, entry, argv: ["service-arg"], started_at: "2023-11-14T22:13:20.000Z", stdout_log_path: join(paths.logsRoot, `service-${runID}.stdout.log`), stderr_log_path: join(paths.logsRoot, `service-${runID}.stderr.log`) })
            expect(runtimeProcess.kill).not.toHaveBeenCalled()
            expect(runtimeProcess.spawn).not.toHaveBeenCalled()
        })
    })

    test("lifecycle adapter preserves tracked owner, surfaces signal failures, and finalizes changed Linux identities", async (): Promise<void> => {
        await inTemporaryWorkspace("managed-runtime-linux-adapter-", async (workspacePath): Promise<void> => {
            const owner: ManagedScriptProjectOwner = { directory: workspacePath, jobName: ownerName }
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
            const entry = join(paths.sourceRoot, "service.mjs")
            const filePath = join(paths.servicesRoot, `${runID}.json`)
            await mkdir(paths.servicesRoot, { recursive: true })
            const good = serviceState(owner, runID, 91, entry)
            await writeFile(filePath, good)
            const identity: ProcessIdentity = { startTime: "100", processGroup: 91, state: "S", command: [process.execPath, entry, "service-arg"] }
            const identities = new Map<number, ProcessIdentity>([[91, identity]])
            const runtimeProcess = linuxProcess()
            const deniedKill = mock((): never => { throw Object.assign(new Error("inspection denied"), { code: "EACCES" }) })
            runtimeProcess.kill = mock((_pid: number, signal: NodeJS.Signals | 0): void => { if (signal === 0) deniedKill() })
            const resolveOwner = mock(async (): Promise<ManagedScriptProjectOwnerResolution> => ({ ok: true, owner }))
            const runtime = runtimeFor(workspacePath, { process: runtimeProcess, fileSystem: processFileSystem(identities), resolveOwner })

            await expect(cleanupManagedScriptServices(runtime)).rejects.toThrow("Unable to inspect managed script process group: inspection denied")
            expect(await readFile(filePath, "utf8")).toBe(good)
            expect(runtimeProcess.kill).toHaveBeenNthCalledWith(1, -91, "SIGTERM")
            expect(runtimeProcess.kill).toHaveBeenNthCalledWith(2, -91, 0)
            identities.set(91, { ...identity, startTime: "101" })
            expect(await cleanupManagedScriptServices(runtime)).toEqual({ stopped_run_ids: [], finalized_run_ids: [runID] })
            expect(runtimeProcess.kill).toHaveBeenCalledTimes(2)
            await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
            expect(await cleanupManagedScriptServices(runtime)).toEqual({ stopped_run_ids: [], finalized_run_ids: [] })
            expect(resolveOwner).toHaveBeenCalledTimes(3)
            runtimeProcess.kill = linuxProcess().kill
            identities.set(91, identity)
            await writeFile(filePath, good)
            expect(await cleanupManagedScriptServices(runtime)).toEqual({ stopped_run_ids: [runID], finalized_run_ids: [] })
            expect(resolveOwner).toHaveBeenCalledTimes(4)
        })
    })

    test("settles finite runs with exited roots and stalled close/log writes without claiming descendant cleanup", async (): Promise<void> => {
        await inTemporaryWorkspace("managed-runtime-finite-settlement-", async (workspacePath): Promise<void> => {
            const paths = createManagedScriptProjectPaths(workspacePath, ownerName)
            const entry = join(paths.sourceRoot, "timing.mjs")
            await mkdir(paths.sourceRoot, { recursive: true })
            await writeFile(entry, "export {}\n")
            const child = mockedChild(201)
            const destroyStdout = mock((): void => {})
            const destroyStderr = mock((): void => {})
            if (!child.child.stdout || !child.child.stderr) throw new Error("Mocked child must provide stdout and stderr streams.")
            child.child.stdout.destroy = destroyStdout
            child.child.stderr.destroy = destroyStderr
            const argv = ["", "two words", "quote\"and'quote", "$(not-code);&", "tail\\"]
            const identities = new Map<number, ProcessIdentity>([[201, { startTime: "100", processGroup: 201, state: "S", command: [process.execPath, entry, ...argv] }]])
            const stdout = "finite output\n"
            const spawn = mock((_command: string, _args: readonly string[], _options: ManagedScriptRuntimeSpawnOptions): ManagedScriptRuntimeChild => {
                queueMicrotask((): void => { child.emitStdout(stdout) })
                return child.child
            })
            const kill = mock((_pid: number, signal: NodeJS.Signals | 0): void => { if (signal === "SIGTERM") child.exit(0) })
            let releaseWrite: () => void = (): void => {}
            const writeGate = new Promise<void>((resolve): void => { releaseWrite = resolve })
            const writes: Promise<void>[] = []
            const fileSystem = processFileSystem(identities, { appendFile: (filePath, content): Promise<void> => {
                const written = writeGate.then(async (): Promise<void> => await appendFile(filePath, content))
                writes.push(written)
                return written
            } })
            const runtime = runtimeFor(workspacePath, { now: Date.now, fileSystem, process: { ...linuxProcess(201), spawn, kill } })
            const startedAt = Date.now()
            try {
                const result = await runtime.run({ entry: "timing.mjs", argv, timeoutMs: 1 })
                expect(Date.now() - startedAt).toBeLessThan(10_000)
                expect(result).toMatchObject({ exit_code: null, timed_out: true, stdout, stdout_truncated: false, stderr_truncated: false })
                expect(result.stderr).toContain("Managed script root has exited; descendant cleanup was not attempted.")
                expect(result.stderr).toContain("Managed script logging did not finish within 1000 milliseconds; logs may be incomplete.")
                expect(spawn.mock.calls[0]?.[1]).toEqual([entry, ...argv])
                expect(kill.mock.calls).toEqual([[-201, "SIGTERM"]])
                expect(destroyStdout).toHaveBeenCalledTimes(1)
                expect(destroyStderr).toHaveBeenCalledTimes(1)
                expect(await readFile(result.log_path, "utf8")).toBe(interleavedLogHeader)
                releaseWrite()
                await Promise.all(writes)
                const log = await readFile(result.log_path, "utf8")
                expect(log).toContain(stdout)
                expect(log).not.toContain('"exit_code"')
            }
            finally {
                releaseWrite()
                await Promise.all(writes)
            }
        })
    }, 60_000)

    test("refuses every service action outside Linux before spawning, inspecting, or signalling", async (): Promise<void> => {
        await inTemporaryWorkspace("managed-runtime-platform-", async (workspacePath) => {
            for (const platform of ["darwin", "win32"] as const) {
                const spawn = mock((): never => { throw new Error("must not spawn services outside Linux") })
                const kill = mock((): never => { throw new Error("must not signal services outside Linux") })
                const readFile = mock((): never => { throw new Error("must not inspect services outside Linux") })
                const runtime = runtimeFor(workspacePath, { fileSystem: createFileSystem({ readFile }), process: { execPath: process.execPath, env: {}, platform, spawn, kill } })
                const platformMessage = "Managed script services are supported only on Linux."

                await expect(runtime.start({ entry: "service.mjs" })).rejects.toThrow(platformMessage)
                await expect(runtime.status({ run_id: runID })).rejects.toThrow(platformMessage)
                await expect(runtime.stop({ run_id: runID })).rejects.toThrow(platformMessage)
                await expect(runtime.cleanup()).rejects.toThrow(platformMessage)
                expect(spawn).not.toHaveBeenCalled()
                expect(readFile).not.toHaveBeenCalled()
                expect(kill).not.toHaveBeenCalled()
            }
        })
    })
})
