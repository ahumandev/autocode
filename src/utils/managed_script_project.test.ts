import { describe, expect, mock, test } from "bun:test"
import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process"
import { link, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { createManagedScriptProject, createManagedScriptProjectPaths, isManagedScriptDependencySpec, resolveManagedScriptProjectOwner, satisfiesManagedScriptRange, type ManagedScriptProject, type ManagedScriptProjectCommandResult, type ManagedScriptProjectDependencies, type ManagedScriptProjectFileSystem, type ManagedScriptProjectInstallInput, type ManagedScriptProjectResult, type ManagedScriptProjectSpawn } from "./managed_script_project"
import { acquireInstallerLock, inspectInstallerLock } from "./managed_script_install_lock"

const npmInstallSuccess: ManagedScriptProjectCommandResult = { exitCode: 0, stdout: "installed\n", stderr: "" }
const npmInstallArgs = ["install", "--ignore-scripts", "--no-audit", "--no-fund"] as const
const fileReplacementRetryDelaysMs = [10, 20, 40, 80] as const
const windowsFileReplacementRetryDelaysMs = [...fileReplacementRetryDelaysMs, 160, ...Array<number>(14).fill(320)] as const
const esmTaskTestTimeoutMs = process.platform === "win32" ? 60_000 : 15_000
const esmTaskTimeoutMs = process.platform === "win32" ? 15_000 : 5_000
const esmTaskCloseTimeoutMs = process.platform === "win32" ? 5_000 : 1_000
const esmTaskRegressionTimeoutMs = process.platform === "win32" ? 1_000 : 250
const esmTaskDirectoryRemovalOptions = { recursive: true, force: true, maxRetries: process.platform === "win32" ? 5 : 0, retryDelay: 100 } as const
const esmTaskKeepAliveSource = "setInterval(() => {}, 1_000)\n"
const esmTaskChildren = new Map<ChildProcessWithoutNullStreams, { cwd: string, closed: Promise<void>, stop: () => void }>()
const managedAgentsContent = [
    "# Managed scripts",
    "",
    "- Jobs share npm environment: `.opencode/autocode/scripts/package.json`, `.opencode/autocode/scripts/node_modules`",
    "- `.opencode/autocode/scripts/.meta/` holds shared logs, service records, installer lock, recovery journal; never job sources.",
].join("\n")

const scratchRoot = join(tmpdir(), "opencode")

async function createTemporaryRoot(prefix: string): Promise<string> {
    await mkdir(scratchRoot, { recursive: true })
    return await mkdtemp(join(scratchRoot, prefix))
}

function createFileSystem(): ManagedScriptProjectFileSystem {
    return {
        link: async (existingPath, newPath): Promise<void> => await link(existingPath, newPath),
        mkdir: async (directory, options): Promise<string | undefined> => await mkdir(directory, options),
        readFile: async (filePath, encoding): Promise<string> => await readFile(filePath, encoding),
        lstat: async (filePath): Promise<Awaited<ReturnType<typeof lstat>>> => await lstat(filePath),
        readdir: async (directory, options): Promise<Awaited<ReturnType<ManagedScriptProjectFileSystem["readdir"]>>> => options?.withFileTypes
            ? await readdir(directory, { withFileTypes: true })
            : await readdir(directory),
        rename: async (oldPath, newPath): Promise<void> => await rename(oldPath, newPath),
        rm: async (filePath, options): Promise<void> => await rm(filePath, options),
        stat: async (filePath): Promise<Awaited<ReturnType<typeof stat>>> => await stat(filePath),
        writeFile: async (filePath, content, options): Promise<void> => await writeFile(filePath, content, options),
    }
}

async function exists(filePath: string): Promise<boolean> {
    try {
        await stat(filePath)
        return true
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
        throw error
    }
}

async function expectReleasedInstallerLock(fileSystem: ManagedScriptProjectFileSystem, lockPath: string): Promise<void> {
    expect((await stat(lockPath)).isDirectory()).toBe(true)
    expect(await inspectInstallerLock(fileSystem, lockPath)).toEqual({ state: "free" })
    const generationPattern = /^generation-\d{16}$/
    const ownerFile = "owner.json"
    const releasedFile = "released.json"
    const generations = (await readdir(lockPath)).filter((entry: string): boolean => generationPattern.test(entry)).sort()
    const retained = await Promise.all(generations.map(async (generation: string): Promise<{ directory: string, owner: string, released: string }> => {
        const directory = join(lockPath, generation)
        return { directory, owner: await readFile(join(directory, ownerFile), "utf8"), released: await readFile(join(directory, releasedFile), "utf8") }
    }))
    const latest = retained.at(-1)
    if (!latest) throw new Error("Expected retained installer lock generation")
    const owner = JSON.parse(latest.owner) as Record<string, unknown>
    expect(JSON.parse(latest.released)).toMatchObject({ protocol: owner.protocol, claimId: owner.claimId, token: owner.token })
    const acquired = await acquireInstallerLock(fileSystem, lockPath, { waitTimeoutMs: 0 })
    if (!acquired.ok) throw new Error("Expected released installer lock to allow reacquisition")
    try {
        expect(await inspectInstallerLock(fileSystem, lockPath)).toMatchObject({ state: "active", owner: { token: acquired.lock.token } })
        expect((await readdir(lockPath)).filter((entry: string): boolean => generationPattern.test(entry))).toHaveLength(generations.length + 1)
    }
    finally {
        await acquired.lock.release()
    }
    expect(await inspectInstallerLock(fileSystem, lockPath)).toEqual({ state: "free" })
    for (const snapshot of retained) {
        expect(await readFile(join(snapshot.directory, ownerFile), "utf8")).toBe(snapshot.owner)
        expect(await readFile(join(snapshot.directory, releasedFile), "utf8")).toBe(snapshot.released)
    }
}

async function writeInstalledPackage(packagePath: string, name: string, version: string): Promise<void> {
    await mkdir(packagePath, { recursive: true })
    await writeFile(join(packagePath, "package.json"), `${JSON.stringify({ name, version, type: "module", exports: { ".": "./index.js" } })}\n`)
    await writeFile(join(packagePath, "index.js"), `export const version = ${JSON.stringify(version)}\n`)
}

async function writeNpmArtifacts(cwd: string, versions: Record<string, string> = {}): Promise<void> {
    const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as { dependencies?: Record<string, string> }
    let lock: Record<string, unknown> = {}
    try {
        lock = JSON.parse(await readFile(join(cwd, "package-lock.json"), "utf8")) as Record<string, unknown>
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const packages = typeof lock.packages === "object" && lock.packages !== null ? lock.packages as Record<string, Record<string, unknown>> : {}
    const rootPackage = packages[""] ?? {}
    const dependencies = manifest.dependencies ?? {}
    await mkdir(join(cwd, "node_modules"), { recursive: true })
    for (const name of Object.keys(dependencies)) {
        const packagePath = join(cwd, "node_modules", ...name.split("/"))
        const installed = await exists(join(packagePath, "package.json"))
            ? JSON.parse(await readFile(join(packagePath, "package.json"), "utf8")) as { version: string }
            : undefined
        const version = versions[name] ?? installed?.version ?? "1.0.0"
        if (installed?.version !== version) await writeInstalledPackage(packagePath, name, version)
        packages[`node_modules/${name}`] = { ...packages[`node_modules/${name}`], version }
    }
    await writeFile(join(cwd, "package-lock.json"), `${JSON.stringify({
        ...lock,
        lockfileVersion: 3,
        packages: { ...packages, "": { ...rootPackage, dependencies: { ...(rootPackage.dependencies as Record<string, string> | undefined), ...dependencies } } },
    }, undefined, 2)}\n`)
}

function createProject(directory: string, spawn: ManagedScriptProjectSpawn, overrides: Partial<ManagedScriptProjectDependencies> = {}): ManagedScriptProject {
    return createManagedScriptProject({
        context: { sessionID: "session-1", directory, worktree: directory },
        fileSystem: createFileSystem(),
        spawn,
        runtime: {
            env: { PATH: "/managed/bin" },
            nodeVersion: async (): Promise<ManagedScriptProjectCommandResult> => ({ exitCode: 0, stdout: "v20.11.1\n", stderr: "" }),
            npmVersion: async (): Promise<ManagedScriptProjectCommandResult> => ({ exitCode: 0, stdout: "10.2.0\n", stderr: "" }),
        },
        resolveOwner: async (): Promise<Awaited<ReturnType<typeof resolveManagedScriptProjectOwner>>> => ({ ok: true, owner: { jobName: "job", directory } }),
        resolvePackage: async (): Promise<undefined> => undefined,
        ...overrides,
    })
}

function expectSuccess(result: ManagedScriptProjectResult): Extract<ManagedScriptProjectResult, { ok: true }> {
    if (!result.ok) throw new Error(`Expected success: ${JSON.stringify(result)}`)
    return result
}

function runEsmTask(filePath: string, cwd: string, timeoutMs: number = esmTaskTimeoutMs): Promise<ManagedScriptProjectCommandResult> {
    const env = { ...process.env }
    delete env.NODE_PATH
    delete env.NODE_OPTIONS
    const task = new Promise<ManagedScriptProjectCommandResult>((resolve, reject): void => {
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        const child = spawnChild(Bun.which("node") ?? process.execPath, [filePath], { cwd, env })
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined
        let settled = false
        let isClosed = false
        let terminationRequested = false
        const onStdout = (chunk: Buffer): void => { stdout.push(chunk) }
        const onStderr = (chunk: Buffer): void => { stderr.push(chunk) }
        const stop = (error: Error): void => {
            if (isClosed) return
            clearTimeout(deadlineTimer)
            if (!settled) {
                settled = true
                reject(error)
            }
            if (terminationRequested) return
            terminationRequested = true
            try {
                child.kill("SIGKILL")
            }
            catch (killError) {
                error.cause = killError
            }
        }
        const onError = (error: Error): void => { stop(error) }
        const closed = new Promise<void>((resolveClosed): void => {
            child.once("close", (exitCode: number | null): void => {
                isClosed = true
                clearTimeout(deadlineTimer)
                child.stdout.removeListener("data", onStdout)
                child.stderr.removeListener("data", onStderr)
                child.removeListener("error", onError)
                esmTaskChildren.delete(child)
                resolveClosed()
                if (settled) return
                settled = true
                resolve({ exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") })
            })
        })
        child.stdout.on("data", onStdout)
        child.stderr.on("data", onStderr)
        child.on("error", onError)
        esmTaskChildren.set(child, { cwd, closed, stop: (): void => { stop(new Error(`ESM task stopped during cleanup: ${filePath}`)) } })
        deadlineTimer = setTimeout((): void => {
            stop(new Error(`ESM task timed out after ${timeoutMs}ms: ${filePath}\nstdout: ${Buffer.concat(stdout).toString("utf8")}\nstderr: ${Buffer.concat(stderr).toString("utf8")}`))
        }, timeoutMs)
    })
    // Return the handled promise directly so runner aborts cannot leave an unhandled async wrapper.
    void task.catch((): void => {})
    return task
}

async function cleanupEsmTasks(cwd: string, directory: string = cwd): Promise<void> {
    const owned = [...esmTaskChildren].filter(([, task]): boolean => task.cwd === cwd)
    for (const [, task] of owned) task.stop()
    if (owned.length > 0) {
        let closeTimer: ReturnType<typeof setTimeout> | undefined
        try {
            await Promise.race([
                Promise.all(owned.map(([, task]): Promise<void> => task.closed)),
                new Promise<never>((_resolve, reject): void => {
                    closeTimer = setTimeout((): void => {
                        reject(new Error(`ESM children did not close within ${esmTaskCloseTimeoutMs}ms before removing ${directory}: ${owned.map(([child]): number | undefined => child.pid).join(", ")}`))
                    }, esmTaskCloseTimeoutMs)
                }),
            ])
        }
        finally {
            clearTimeout(closeTimer)
        }
    }
    await rm(directory, esmTaskDirectoryRemovalOptions)
}

describe("managed script project", (): void => {
    test("kills a timed-out ESM child before directory cleanup", async (): Promise<void> => {
        const directory = await createTemporaryRoot("managed-script-esm-timeout-")
        try {
            const filePath = join(directory, "task.mjs")
            await writeFile(filePath, esmTaskKeepAliveSource)
            const task = runEsmTask(filePath, directory, esmTaskRegressionTimeoutMs)
            const child = [...esmTaskChildren].find(([, owned]): boolean => owned.cwd === directory)?.[0]
            if (!child) throw new Error("Expected owned ESM child")

            await expect(task).rejects.toThrow(`ESM task timed out after ${esmTaskRegressionTimeoutMs}ms`)
            expect(child.killed).toBe(true)
            await cleanupEsmTasks(directory)
            expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
            expect(esmTaskChildren.has(child)).toBe(false)
            expect(await exists(directory)).toBe(false)
        }
        finally {
            await cleanupEsmTasks(directory)
        }
    }, esmTaskTestTimeoutMs)

    test("handles ESM cleanup rejection before the caller awaits it", async (): Promise<void> => {
        const directory = await createTemporaryRoot("managed-script-esm-cleanup-")
        try {
            const filePath = join(directory, "task.mjs")
            await writeFile(filePath, esmTaskKeepAliveSource)
            const task = runEsmTask(filePath, directory)
            const child = [...esmTaskChildren].find(([, owned]): boolean => owned.cwd === directory)?.[0]
            if (!child) throw new Error("Expected owned ESM child")

            await cleanupEsmTasks(directory)
            await new Promise<void>((resolve): void => { setTimeout(resolve, 0) })
            await expect(task).rejects.toThrow("ESM task stopped during cleanup")
            expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
            expect(esmTaskChildren.has(child)).toBe(false)
            expect(await exists(directory)).toBe(false)
        }
        finally {
            await cleanupEsmTasks(directory)
        }
    }, esmTaskTestTimeoutMs)

    test("settles ESM spawn errors before directory cleanup", async (): Promise<void> => {
        const directory = await createTemporaryRoot("managed-script-esm-spawn-error-")
        const cwd = join(directory, "missing")
        try {
            const filePath = join(directory, "task.mjs")
            await writeFile(filePath, "export {}\n")

            await expect(runEsmTask(filePath, cwd)).rejects.toMatchObject({ code: "ENOENT" })
            await cleanupEsmTasks(cwd, directory)
            expect([...esmTaskChildren.values()].some((owned): boolean => owned.cwd === cwd)).toBe(false)
            expect(await exists(directory)).toBe(false)
        }
        finally {
            await cleanupEsmTasks(cwd, directory)
        }
    }, esmTaskTestTimeoutMs)

    test.each([
        ["2004-01-02T00:03:04.000Z", "04-01-02_00-03-04_job"],
        ["2004-01-02T16:03:04.000+02:00", "04-01-02_14-03-04_job"],
        ["2026-10-08T23:59:58.999Z", "26-10-08_23-59-58_job"],
    ])("formats %s as zero-padded 24-hour UTC source directory %s", async (date: string, directoryName: string): Promise<void> => {
        const directory = await createTemporaryRoot("managed-script-timestamp-format-")
        try {
            const paths = createManagedScriptProjectPaths(directory, "job", (): Date => new Date(date))

            expect(paths.sourceRoot).toBe(join(paths.scriptsRoot, directoryName))
            expect(paths.jobName).toBe("job")
            expect(await readdir(directory)).toEqual([])
        }
        finally {
            await rm(directory, { recursive: true, force: true })
        }
    })

    test("pins source paths before mkdir and reuses them across time and project instances", async (): Promise<void> => {
        const directory = await createTemporaryRoot("managed-script-timestamp-stable-")
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }): Promise<ManagedScriptProjectCommandResult> => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd)
            return npmInstallSuccess
        })
        try {
            let date = "2026-01-02T03:04:05.000Z"
            const now = mock((): Date => new Date(date))
            const initial = createManagedScriptProjectPaths(directory, "job", now)
            expect(basename(initial.sourceRoot)).toBe("26-01-02_03-04-05_job")
            expect(await exists(initial.sourceRoot)).toBe(false)
            date = "2027-02-03T14:15:16.000Z"
            expect(createManagedScriptProjectPaths(directory, "job", now)).toEqual(initial)
            expect(createManagedScriptProjectPaths(join(directory, "."), "job", now).sourceRoot).toBe(initial.sourceRoot)
            expect(now).toHaveBeenCalledTimes(1)
            expect(await readdir(directory)).toEqual([])

            const project = createProject(directory, spawn)
            expect(expectSuccess(await project.setup()).paths).toEqual(initial)
            expect(expectSuccess(await createProject(directory, spawn).setup()).paths).toEqual(initial)
            expect(expectSuccess(await project.install()).paths).toEqual(initial)
            expect(await project.verify()).toEqual({ ok: true })
            expect((await readdir(initial.scriptsRoot)).filter((entry: string): boolean => entry.endsWith("_job"))).toEqual([basename(initial.sourceRoot)])
        }
        finally {
            await rm(directory, { recursive: true, force: true })
        }
    })

    test("discovers newest exact valid timestamped directory without touching other job or shared directories", async (): Promise<void> => {
        const directory = await createTemporaryRoot("managed-script-timestamp-reuse-")
        const scriptsRoot = join(directory, ".opencode", "autocode", "scripts")
        const newest = "26-02-28_23-59-59_job"
        const directoryNames = [
            newest,
            "24-02-29_01-02-03_job",
            "26-02-28_23-59-58_job",
            "99-12-31_23-59-59_job_2",
            "99-12-31_23-59-59_other_job",
            "99-12-31_23-59-59_job_more",
            "99-02-29_23-59-59_job",
            "99-02-30_23-59-59_job",
            "99-13-31_23-59-59_job",
            "99-00-31_23-59-59_job",
            "99-12-00_23-59-59_job",
            "99-12-31_24-59-59_job",
            "99-12-31_23-60-59_job",
            "99-12-31_23-59-60_job",
            "99-1-02_03-04-05_job",
            "2099-12-31_23-59-59_job",
            "99-12-31_23-59-59 job",
            "99-12-31_23-59-59__job",
            "job",
            ".meta",
            "node_modules",
        ]
        const spawn = mock(async (): Promise<ManagedScriptProjectCommandResult> => npmInstallSuccess)
        try {
            for (const directoryName of directoryNames) {
                const sourceRoot = join(scriptsRoot, directoryName)
                await mkdir(sourceRoot, { recursive: true })
                await writeFile(join(sourceRoot, "keep.mjs"), directoryName)
            }
            const timestampedFile = join(scriptsRoot, "99-12-31_23-59-59_job")
            await writeFile(timestampedFile, "keep file")

            const project = createProject(directory, spawn)
            const setup = expectSuccess(await project.setup())
            expect(setup.paths.sourceRoot).toBe(join(scriptsRoot, newest))
            expect(setup.paths.jobName).toBe("job")
            expect(expectSuccess(await createProject(directory, spawn).setup()).paths).toEqual(setup.paths)
            for (const directoryName of directoryNames) {
                expect(await readFile(join(scriptsRoot, directoryName, "keep.mjs"), "utf8")).toBe(directoryName)
            }
            expect(await readFile(timestampedFile, "utf8")).toBe("keep file")
            expect(spawn).not.toHaveBeenCalled()
        }
        finally {
            await rm(directory, { recursive: true, force: true })
        }
    })

    test("leaves untimestamped and space-separated sources untouched when assigning a new source directory", async (): Promise<void> => {
        const directory = await createTemporaryRoot("managed-script-timestamp-legacy-")
        const scriptsRoot = join(directory, ".opencode", "autocode", "scripts")
        const legacySource = join(scriptsRoot, "job")
        const spaceSeparatedSource = join(scriptsRoot, "26-01-02_03-04-05 job")
        const spawn = mock(async (): Promise<ManagedScriptProjectCommandResult> => npmInstallSuccess)
        try {
            await mkdir(legacySource, { recursive: true })
            await writeFile(join(legacySource, "keep.mjs"), "legacy source")
            await mkdir(spaceSeparatedSource)
            await writeFile(join(spaceSeparatedSource, "keep.mjs"), "space-separated source")
            const paths = createManagedScriptProjectPaths(directory, "job", (): Date => new Date("2026-01-02T03:04:05.000Z"))
            const setup = expectSuccess(await createProject(directory, spawn).setup())

            expect(setup.paths).toEqual(paths)
            expect(paths.sourceRoot).toBe(join(scriptsRoot, "26-01-02_03-04-05_job"))
            expect(await exists(paths.sourceRoot)).toBe(true)
            expect(await readFile(join(legacySource, "keep.mjs"), "utf8")).toBe("legacy source")
            expect(await readdir(legacySource)).toEqual(["keep.mjs"])
            expect(await readFile(join(spaceSeparatedSource, "keep.mjs"), "utf8")).toBe("space-separated source")
            expect(await readdir(spaceSeparatedSource)).toEqual(["keep.mjs"])
            expect(spawn).not.toHaveBeenCalled()
        }
        finally {
            await rm(directory, { recursive: true, force: true })
        }
    })

    test("uses context.directory for title-owned sources and one durable shared project", async (): Promise<void> => {
        const rootPath = await createTemporaryRoot("managed-script-project-")
        const directory = join(rootPath, "directory")
        const worktree = join(rootPath, "distinct-worktree")
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }): Promise<ManagedScriptProjectCommandResult> => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd)
            return npmInstallSuccess
        })
        try {
            let title = "Inspect data (running)"
            const get = mock(async (): Promise<{ data: { title: string } }> => ({ data: { title } }))
            const context = { sessionID: "session-1", directory, worktree, agent: "execute-script" }
            const client = { session: { get } } as unknown as NonNullable<ManagedScriptProjectDependencies["client"]>
            const fileSystem = createFileSystem()
            const linkSpy = mock(fileSystem.link)
            const writeSpy = mock(fileSystem.writeFile)
            fileSystem.link = linkSpy
            fileSystem.mkdir = mock(fileSystem.mkdir)
            fileSystem.writeFile = writeSpy
            fileSystem.rename = mock(fileSystem.rename)
            fileSystem.rm = mock(fileSystem.rm)
            expect(await resolveManagedScriptProjectOwner({ context, client, fileSystem })).toEqual({ ok: true, owner: { jobName: "inspect_data", directory } })
            expect(get).toHaveBeenCalledWith({ path: { id: "session-1" }, query: { directory } })
            for (const mutation of [fileSystem.link, fileSystem.mkdir, fileSystem.writeFile, fileSystem.rename, fileSystem.rm]) expect(mutation).not.toHaveBeenCalled()
            expect(await readdir(rootPath)).toEqual([])

            const project = createProject(directory, spawn, { context, client, fileSystem, resolveOwner: undefined })
            const setup = expectSuccess(await project.setup())
            const expectedPaths = createManagedScriptProjectPaths(directory, "inspect_data")
            expect(setup.paths).toEqual(expectedPaths)
            expect(setup.paths).toMatchObject({
                directory,
                jobName: "inspect_data",
                scriptsRoot: join(directory, ".opencode", "autocode", "scripts"),
                sourceRoot: expectedPaths.sourceRoot,
                manifestPath: join(directory, ".opencode", "autocode", "scripts", "package.json"),
                lockfilePath: join(directory, ".opencode", "autocode", "scripts", "package-lock.json"),
                nodeModulesPath: join(directory, ".opencode", "autocode", "scripts", "node_modules"),
                metaRoot: join(directory, ".opencode", "autocode", "scripts", ".meta"),
            })
            expect(basename(setup.paths.sourceRoot)).toMatch(/^\d{2}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_inspect_data$/)
            expect(setup.npm).toBeUndefined()
            expect(spawn).not.toHaveBeenCalled()
            const bootstrapManifest = await readFile(setup.paths.manifestPath, "utf8")
            expect(JSON.parse(bootstrapManifest)).toEqual({ private: true, type: "module" })
            expect(linkSpy).toHaveBeenCalledTimes(1)
            const publication = linkSpy.mock.calls[0]
            if (!publication) throw new Error("Expected atomic bootstrap publication")
            if (typeof publication[0] !== "string") throw new Error("Expected string bootstrap publication path")
            expect(publication[0]).toStartWith(`${setup.paths.manifestPath}.autocode-tmp-`)
            expect(publication[1]).toBe(setup.paths.manifestPath)
            expect(writeSpy).toHaveBeenCalledWith(publication[0], bootstrapManifest, { flag: "wx" })
            expect(writeSpy.mock.calls.some(([filePath]): boolean => filePath === setup.paths.manifestPath)).toBe(false)
            expect(await exists(publication[0])).toBe(false)
            expect(await exists(setup.paths.lockfilePath)).toBe(false)
            expect(await exists(setup.paths.nodeModulesPath)).toBe(false)
            await writeFile(join(setup.paths.sourceRoot, "task.mjs"), "export const keep = true\n")
            await writeFile(setup.paths.manifestPath, `${JSON.stringify({ name: "trusted-scripts", private: true, type: "module", scripts: { check: `node "${basename(setup.paths.sourceRoot)}/task.mjs"` }, dependencies: { keep: "^1.0.0" } }, undefined, 2)}\n`)
            await writeFile(join(setup.paths.logsRoot, "keep.log"), "keep log\n")
            await writeFile(join(setup.paths.servicesRoot, "keep.json"), "{\"keep\":true}\n")

            expectSuccess(await project.install())
            expect(spawn.mock.calls[0]?.[2]?.cwd).toBe(join(directory, ".opencode", "autocode", "scripts"))
            const manifest = await readFile(setup.paths.manifestPath, "utf8")
            const lockfile = await readFile(setup.paths.lockfilePath, "utf8")
            const reused = expectSuccess(await project.setup())
            expect(reused.paths).toEqual(setup.paths)
            expect(await project.verify()).toEqual({ ok: true })
            expect(expectSuccess(await project.install()).npm).toBeUndefined()

            title = "Compare data (running)"
            const second = expectSuccess(await project.setup())
            expect(second.paths.sourceRoot).toBe(createManagedScriptProjectPaths(directory, "compare_data").sourceRoot)
            expect(basename(second.paths.sourceRoot)).toMatch(/^\d{2}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_compare_data$/)
            expect(second.paths.sourceRoot).not.toBe(setup.paths.sourceRoot)
            expect(second.paths.scriptsRoot).toBe(join(directory, ".opencode", "autocode", "scripts"))
            expect(second.paths.scriptsRoot).toBe(setup.paths.scriptsRoot)
            expect(second.paths.manifestPath).toBe(setup.paths.manifestPath)
            expect(second.paths.lockfilePath).toBe(setup.paths.lockfilePath)
            expect(second.paths.nodeModulesPath).toBe(setup.paths.nodeModulesPath)
            expect(second.paths.agentsPath).toBe(setup.paths.agentsPath)
            expect(await exists(second.paths.sourceRoot)).toBe(true)
            title = "Inspect-data (done)"
            expect(expectSuccess(await project.setup()).paths.sourceRoot).toBe(setup.paths.sourceRoot)
            const otherDirectory = join(rootPath, "other-directory")
            const other = expectSuccess(await createProject(otherDirectory, spawn, {
                resolveOwner: async (): Promise<Awaited<ReturnType<typeof resolveManagedScriptProjectOwner>>> => ({ ok: true, owner: { jobName: "inspect_data", directory: otherDirectory } }),
            }).setup())
            expect(other.paths.scriptsRoot).toBe(join(otherDirectory, ".opencode", "autocode", "scripts"))
            expect(other.paths.scriptsRoot).not.toBe(setup.paths.scriptsRoot)
            expect(await readFile(setup.paths.manifestPath, "utf8")).toBe(manifest)
            expect(await readFile(setup.paths.lockfilePath, "utf8")).toBe(lockfile)
            expect(await readFile(join(setup.paths.sourceRoot, "task.mjs"), "utf8")).toBe("export const keep = true\n")
            expect(await readFile(join(setup.paths.logsRoot, "keep.log"), "utf8")).toBe("keep log\n")
            expect(await readFile(join(setup.paths.servicesRoot, "keep.json"), "utf8")).toBe("{\"keep\":true}\n")
            expect(await exists(join(setup.paths.nodeModulesPath, "keep", "package.json"))).toBe(true)
            expect(setup.paths.logsRoot).toBe(join(setup.paths.metaRoot, "logs"))
            expect(setup.paths.servicesRoot).toBe(join(setup.paths.metaRoot, "services"))
            expect(setup.paths.lockPath).toBe(join(setup.paths.metaRoot, "install.lock"))
            expect(setup.paths.journalPath).toBe(join(setup.paths.metaRoot, "install-journal.json"))
            await expectReleasedInstallerLock(fileSystem, setup.paths.lockPath)
            expect(await exists(setup.paths.journalPath)).toBe(false)
            expect(await exists(join(directory, ".agents", "jobs"))).toBe(false)
            expect(await exists(worktree)).toBe(false)
            expect(linkSpy.mock.calls.filter(([, newPath]): boolean => newPath === setup.paths.manifestPath)).toHaveLength(1)
            expect(spawn).toHaveBeenCalledTimes(1)
        }
        finally {
            await rm(rootPath, { recursive: true, force: true })
        }
    })

    test("writes canonical minimal unmarked guidance without rewriting unchanged LF content", async (): Promise<void> => {
        const directory = await createTemporaryRoot("managed-script-agents-initial-")
        const spawn = mock(async (): Promise<ManagedScriptProjectCommandResult> => npmInstallSuccess)
        try {
            const fileSystem = createFileSystem()
            const writeSpy = mock(fileSystem.writeFile)
            const renameSpy = mock(fileSystem.rename)
            fileSystem.writeFile = writeSpy
            fileSystem.rename = renameSpy
            const sleep = mock(async (_milliseconds: number): Promise<void> => undefined)
            const project = createProject(directory, spawn, { fileSystem, platform: "win32", installerLock: { sleep } })
            const result = expectSuccess(await project.setup())
            const agents = await readFile(result.paths.agentsPath, "utf8")

            expect(agents).toBe(managedAgentsContent)
            expect(agents).not.toContain("AUTOCODE:MANAGED-SCRIPTS")
            writeSpy.mockClear()
            renameSpy.mockClear()
            expectSuccess(await project.setup())
            expect(await readFile(result.paths.agentsPath, "utf8")).toBe(agents)
            expect(writeSpy).not.toHaveBeenCalled()
            expect(renameSpy).not.toHaveBeenCalled()
            expect(spawn).not.toHaveBeenCalled()
            expect(sleep).not.toHaveBeenCalled()
        }
        finally {
            await rm(directory, { recursive: true, force: true })
        }
    })

    test("replaces entire marked guidance and custom text while preserving CRLF idempotently", async (): Promise<void> => {
        const directory = await createTemporaryRoot("managed-script-agents-refresh-")
        const spawn = mock(async (): Promise<ManagedScriptProjectCommandResult> => npmInstallSuccess)
        try {
            const project = createProject(directory, spawn)
            const initial = expectSuccess(await project.setup())
            const initialContent = (await readFile(initial.paths.agentsPath, "utf8")).replaceAll("\n", "\r\n")
            const outdated = initialContent.replace("Jobs share npm environment", "Obsolete dependency guidance")
            await writeFile(initial.paths.agentsPath, `Team rules.\r\n\r\n<!-- AUTOCODE:MANAGED-SCRIPTS:START -->\r\n${outdated}\r\n<!-- AUTOCODE:MANAGED-SCRIPTS:END -->\r\n\r\nCustom footer.\r\n`)
            const refreshed = expectSuccess(await project.setup())
            const agents = await readFile(refreshed.paths.agentsPath, "utf8")

            expect(agents).toBe(managedAgentsContent.replaceAll("\n", "\r\n"))
            expect(agents.replace(/\r\n/g, "")).not.toContain("\n")
            expect(agents).not.toContain("Obsolete dependency guidance")
            expect(agents).not.toContain("AUTOCODE:MANAGED-SCRIPTS")
            const fileSystem = createFileSystem()
            fileSystem.writeFile = mock(fileSystem.writeFile)
            fileSystem.rename = mock(fileSystem.rename)
            expectSuccess(await createProject(directory, spawn, { fileSystem }).setup())
            expect(await readFile(initial.paths.agentsPath, "utf8")).toBe(agents)
            expect(fileSystem.writeFile).not.toHaveBeenCalled()
            expect(fileSystem.rename).not.toHaveBeenCalled()
            expect(spawn).not.toHaveBeenCalled()
        }
        finally {
            await rm(directory, { recursive: true, force: true })
        }
    })

    test("replaces custom, legacy, and malformed guidance entirely while preserving LF or CRLF", async (): Promise<void> => {
        const rootPath = await createTemporaryRoot("managed-script-agents-migration-")
        const spawn = mock(async (): Promise<ManagedScriptProjectCommandResult> => npmInstallSuccess)
        const cases = [
            { name: "custom", content: "# Team rules\n\nCustom guidance.\n" },
            { name: "legacy", content: "# Managed scripts\n\nKeep script sources in `src/`. Use npm for dependencies; do not edit `node_modules` or `package-lock.json`.\n" },
            { name: "unclosed", content: "Custom guidance.\n<!-- AUTOCODE:MANAGED-SCRIPTS:START -->\nUnclosed marker.\n" },
            { name: "reversed", content: "<!-- AUTOCODE:MANAGED-SCRIPTS:END -->\nCustom guidance.\n<!-- AUTOCODE:MANAGED-SCRIPTS:START -->\n" },
        ]
        try {
            for (const { name, content } of cases) {
                for (const lineBreak of ["\n", "\r\n"]) {
                    const directory = join(rootPath, `${name}-${lineBreak === "\n" ? "lf" : "crlf"}`)
                    const paths = createManagedScriptProjectPaths(directory, "job")
                    await mkdir(paths.scriptsRoot, { recursive: true })
                    await writeFile(paths.agentsPath, content.replaceAll("\n", lineBreak))
                    const project = createProject(directory, spawn)
                    const result = expectSuccess(await project.setup())
                    const agents = await readFile(result.paths.agentsPath, "utf8")

                    expect(agents).toBe(managedAgentsContent.replaceAll("\n", lineBreak))
                    expect(agents).not.toContain("AUTOCODE:MANAGED-SCRIPTS")
                    expectSuccess(await project.setup())
                    expect(await readFile(result.paths.agentsPath, "utf8")).toBe(agents)
                }
            }
            expect(spawn).not.toHaveBeenCalled()
        }
        finally {
            await rm(rootPath, { recursive: true, force: true })
        }
    })

    test("does not consult live sources for guidance and recreates a missing source directory", async (): Promise<void> => {
        const directory = await createTemporaryRoot("managed-script-agents-sources-")
        const spawn = mock(async (): Promise<ManagedScriptProjectCommandResult> => npmInstallSuccess)
        try {
            const fileSystem = createFileSystem()
            fileSystem.readdir = mock(async (): Promise<never> => { throw new Error("Live scripts must not be scanned") })
            fileSystem.lstat = mock(async (): Promise<never> => { throw new Error("Live scripts must not be inspected") })
            const project = createProject(directory, spawn, { fileSystem })
            const initial = expectSuccess(await project.setup())
            const agents = await readFile(initial.paths.agentsPath, "utf8")
            await writeFile(join(initial.paths.sourceRoot, "task.mjs"), "export {}\n")
            expectSuccess(await project.setup())
            expect(await readFile(initial.paths.agentsPath, "utf8")).toBe(agents)
            await rm(initial.paths.sourceRoot, { recursive: true })
            expect(expectSuccess(await project.setup()).paths.sourceRoot).toBe(initial.paths.sourceRoot)
            expect(expectSuccess(await createProject(directory, spawn, { fileSystem }).setup()).paths.sourceRoot).toBe(initial.paths.sourceRoot)
            expect(await exists(initial.paths.sourceRoot)).toBe(true)
            expect(await readFile(initial.paths.agentsPath, "utf8")).toBe(agents)
            expect(fileSystem.readdir).not.toHaveBeenCalled()
            expect(fileSystem.lstat).not.toHaveBeenCalled()
            expect(spawn).not.toHaveBeenCalled()
        }
        finally {
            await rm(directory, { recursive: true, force: true })
        }
    })

    test("blocks missing, throwing, or mismatched owners before filesystem mutation or npm", async (): Promise<void> => {
        const workspacePath = await createTemporaryRoot("managed-script-owner-")
        const spawn = mock(async (): Promise<ManagedScriptProjectCommandResult> => npmInstallSuccess)
        try {
            const missing = createProject(workspacePath, spawn, { resolveOwner: async (): Promise<Awaited<ReturnType<typeof resolveManagedScriptProjectOwner>>> => ({ ok: false, reason: "No current title." }) })
            const throwing = createProject(workspacePath, spawn, { resolveOwner: async (): Promise<never> => { throw new Error("owner lookup failed") } })
            const mismatched = createProject(workspacePath, spawn, { resolveOwner: async (): Promise<Awaited<ReturnType<typeof resolveManagedScriptProjectOwner>>> => ({ ok: true, owner: { jobName: "job", directory: join(workspacePath, "other") } }) })
            const missingResult = await missing.setup()
            const throwingResult = await throwing.install()
            const mismatchedResult = await mismatched.setup()

            expect(missingResult).toMatchObject({ ok: false, blocker: { code: "job_workspace_required", message: "No current title." } })
            expect(throwingResult).toMatchObject({ ok: false, blocker: { code: "job_workspace_required" } })
            expect(mismatchedResult).toMatchObject({ ok: false, blocker: { code: "job_workspace_required" } })
            expect(await readdir(workspacePath)).toEqual([])
            expect(spawn).not.toHaveBeenCalled()
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("allows logs and services job names without metadata collisions", async (): Promise<void> => {
        const storageRoot = await createTemporaryRoot("managed-script-title-metadata-")
        const spawn = mock(async (): Promise<ManagedScriptProjectCommandResult> => npmInstallSuccess)
        try {
            for (const title of ["logs", "services"]) {
                const setup = expectSuccess(await createProject(storageRoot, spawn, {
                    client: { session: { get: async (): Promise<{ data: { title: string } }> => ({ data: { title } }) } } as unknown as NonNullable<ManagedScriptProjectDependencies["client"]>,
                    resolveOwner: undefined,
                }).setup())
                expect(setup.paths.sourceRoot).toBe(createManagedScriptProjectPaths(storageRoot, title).sourceRoot)
                expect(basename(setup.paths.sourceRoot)).toMatch(new RegExp(`^\\d{2}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}_${title}$`))
                expect(setup.paths.sourceRoot).not.toBe(setup.paths.logsRoot)
                expect(setup.paths.sourceRoot).not.toBe(setup.paths.servicesRoot)
                expect(await exists(setup.paths.sourceRoot)).toBe(true)
                expect(await exists(setup.paths.logsRoot)).toBe(true)
                expect(await exists(setup.paths.servicesRoot)).toBe(true)
            }
            expect(await exists(join(storageRoot, ".agents", "jobs"))).toBe(false)
            expect(spawn).not.toHaveBeenCalled()
        }
        finally {
            await rm(storageRoot, { recursive: true, force: true })
        }
    })

    test("rejects blank, invalid, and node_modules titles or names before project creation", async (): Promise<void> => {
        const storageRoot = await createTemporaryRoot("managed-script-blank-title-")
        const spawn = mock(async (): Promise<ManagedScriptProjectCommandResult> => npmInstallSuccess)
        try {
            for (const title of ["   ", "***", "node_modules", "Node modules (running)"]) {
                const result = await createProject(storageRoot, spawn, {
                    client: { session: { get: async (): Promise<{ data: { title: string } }> => ({ data: { title } }) } } as unknown as NonNullable<ManagedScriptProjectDependencies["client"]>,
                    resolveOwner: undefined,
                }).setup()

                expect(result).toMatchObject({ ok: false, blocker: { code: "job_workspace_required" } })
            }
            expect(() => createManagedScriptProjectPaths(storageRoot, "node_modules")).toThrow("reserved job name node_modules")
            for (const jobName of ["node_modules", "../escape", "Bad Name"]) {
                expect(await createProject(storageRoot, spawn, {
                    resolveOwner: async (): Promise<Awaited<ReturnType<typeof resolveManagedScriptProjectOwner>>> => ({ ok: true, owner: { jobName, directory: storageRoot } }),
                }).setup()).toMatchObject({ ok: false, blocker: { code: "job_workspace_required" } })
            }
            expect(await exists(join(storageRoot, ".agents"))).toBe(false)
            expect(await readdir(storageRoot)).toEqual([])
            expect(spawn).not.toHaveBeenCalled()
        }
        finally {
            await rm(storageRoot, { recursive: true, force: true })
        }
    })

    test("reports invalid dependencies and manifests as blockers before npm", async (): Promise<void> => {
        const workspacePath = await createTemporaryRoot("managed-script-blockers-")
        const spawn = mock(async (): Promise<ManagedScriptProjectCommandResult> => npmInstallSuccess)
        try {
            const project = createProject(workspacePath, spawn)
            const invalidDependency = await project.setup({ dependencies: { "bad/package/name": "1.0.0" } })
            expect(invalidDependency).toMatchObject({ ok: false, blocker: { code: "invalid_dependency" } })
            const invalidInputs: unknown[] = [
                null,
                [],
                { dependencies: null },
                { dependencies: [] },
                { dependencies: { empty: " " } },
                { dependencies: { numeric: 1 } },
                { dependencies: { yaml: "^2.0.0", " yaml ": "^2.0.0" } },
                { upgrade: "yes" },
            ]
            for (const input of invalidInputs) {
                expect(await project.install(input as ManagedScriptProjectInstallInput)).toMatchObject({ ok: false, blocker: { code: "invalid_dependency" } })
            }
            expect(await readdir(workspacePath)).toEqual([])
            const paths = createManagedScriptProjectPaths(workspacePath, "job")
            await mkdir(paths.scriptsRoot, { recursive: true })
            for (const content of ["[]\n", "{broken", '{"dependencies":[]}\n', '{"dependencies":{"bad":"file:../bad"}}\n', '{"autocode":{"inheritedDependencies":{"bad":{}}}}\n']) {
                await writeFile(paths.manifestPath, content)
                expect(await project.setup()).toMatchObject({ ok: false, blocker: { code: "invalid_manifest" } })
                expect(await project.install()).toMatchObject({ ok: false, blocker: { code: "invalid_manifest" } })
                expect(await project.verify()).toMatchObject({ ok: false, blocker: { code: "invalid_manifest" } })
                expect(await readFile(paths.manifestPath, "utf8")).toBe(content)
            }
            expect(spawn).not.toHaveBeenCalled()
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("accepts supported registry specs and rejects unsupported inputs before npm", async (): Promise<void> => {
        const workspacePath = await createTemporaryRoot("managed-script-dependency-specs-")
        let viewQueries = 0
        let installOperations = 0
        const spawn = mock(async (command: string, args: readonly string[], options?: { cwd?: string }): Promise<ManagedScriptProjectCommandResult> => {
            expect(command).toBe("npm")
            if (args[0] === "view") {
                viewQueries++
                expect(args).toEqual(["view", "tagged@latest", "version", "--json", ...npmInstallArgs.slice(1)])
                return { exitCode: 0, stdout: `${JSON.stringify("3.0.0")}\n`, stderr: "" }
            }
            expect(args).toEqual(npmInstallArgs)
            installOperations++
            if (options?.cwd) await writeNpmArtifacts(options.cwd, { exact: "1.2.3", ranged: "1.5.0", tagged: "3.0.0" })
            return npmInstallSuccess
        })
        try {
            const project = createProject(workspacePath, spawn)
            const accepted = await project.setup({ dependencies: { exact: "1.2.3", ranged: ">=1.0.0 <2.0.0", tagged: "latest" } })

            expect(accepted.ok).toBe(true)
            expect(viewQueries).toBe(1)
            expect(installOperations).toBe(1)
            expect(spawn).toHaveBeenCalledTimes(2)

            for (const spec of ["file:../package", "link:../package", "../package", "/tmp/package", "C:\\package", "https://registry.example/package.tgz", "git+https://github.com/acme/package.git", "git@github.com:acme/package.git", "github:acme/package", "npm:other@^1", "../package.tgz", "package.zip", "1.2.3.4", "01.2.3", "^banana", "1.0.0 || invalid", "1.2.3 ||", "|| 1.2.3", "1.2.3 || || 2.0.0"]) {
                expect(isManagedScriptDependencySpec(spec)).toBe(false)
                expect(satisfiesManagedScriptRange("1.2.3", spec)).toBe(false)
                const rejected = await project.setup({ dependencies: { rejected: spec } })

                expect(rejected).toMatchObject({ ok: false, blocker: { code: "invalid_dependency" } })
            }
            expect(viewQueries).toBe(1)
            expect(installOperations).toBe(1)
            expect(spawn).toHaveBeenCalledTimes(2)
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("reports missing, incompatible, filesystem, and package-resolution failures without mutating verify", async (): Promise<void> => {
        const workspacePath = await createTemporaryRoot("managed-script-errors-")
        let omitPackage = true
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }): Promise<ManagedScriptProjectCommandResult> => {
            if (options?.cwd) {
                await writeNpmArtifacts(options.cwd, { absent: "1.0.0" })
                if (omitPackage) await rm(join(options.cwd, "node_modules", "absent"), { recursive: true, force: true })
            }
            return npmInstallSuccess
        })
        try {
            const fileSystem = createFileSystem()
            const mutations = {
                mkdir: mock(fileSystem.mkdir),
                writeFile: mock(fileSystem.writeFile),
                rename: mock(fileSystem.rename),
                rm: mock(fileSystem.rm),
            }
            const project = createProject(workspacePath, spawn, { fileSystem: { ...fileSystem, ...mutations } })
            expect(await project.verify()).toMatchObject({ ok: false, blocker: { code: "project_not_initialized" } })
            expect(await project.install()).toMatchObject({ ok: false, blocker: { code: "project_not_initialized" } })
            const unsatisfied = await project.setup({ dependencies: { absent: "^1.0.0" } })
            const filesystemFailure = await createProject(workspacePath, spawn, {
                fileSystem: { ...fileSystem, mkdir: async (): Promise<never> => { throw new Error("mkdir denied") } },
            }).setup()

            expect(unsatisfied).toMatchObject({ ok: false, error: { code: "install_incomplete" }, dependencies: [{ name: "absent", status: "missing" }], npm: { exitCode: 0 } })
            const paths = createManagedScriptProjectPaths(workspacePath, "job")
            expect(await exists(paths.journalPath)).toBe(true)
            const recoveryJournal = await readFile(paths.journalPath, "utf8")
            for (const mutation of Object.values(mutations)) mutation.mockClear()
            expect(await project.verify()).toMatchObject({ ok: false, error: { code: "install_interrupted" } })
            expect(await readFile(paths.journalPath, "utf8")).toBe(recoveryJournal)
            for (const mutation of Object.values(mutations)) expect(mutation).not.toHaveBeenCalled()
            expect(spawn).toHaveBeenCalledTimes(1)
            expect(filesystemFailure).toMatchObject({ ok: false, error: { code: "filesystem_error" } })
            expect(await createProject(workspacePath, spawn, {
                resolvePackage: async (): Promise<never> => { throw new Error("resolver denied") },
            }).install({ dependencies: { unresolved: "^1.0.0" } })).toMatchObject({ ok: false, error: { code: "package_resolution_error", message: expect.stringContaining("resolver denied") } })

            omitPackage = false
            const installed = expectSuccess(await project.install({ dependencies: { absent: "^1.0.0" } }))
            expect(installed.npm).toMatchObject({ exitCode: 0 })
            expect(await exists(paths.journalPath)).toBe(false)
            expect(spawn).toHaveBeenCalledTimes(2)
            await expectReleasedInstallerLock(fileSystem, paths.lockPath)
            const manifest = await readFile(installed.paths.manifestPath, "utf8")
            const lockfile = await readFile(installed.paths.lockfilePath, "utf8")
            const packagePath = join(installed.paths.nodeModulesPath, "absent")
            await rm(packagePath, { recursive: true })
            for (const mutation of Object.values(mutations)) mutation.mockClear()
            const npmCalls = spawn.mock.calls.length
            expect(await project.verify()).toMatchObject({ ok: false, error: { code: "dependency_missing" }, dependencies: [{ name: "absent", status: "missing" }] })
            await writeInstalledPackage(packagePath, "absent", "2.0.0")
            expect(await project.verify()).toMatchObject({ ok: false, error: { code: "dependency_incompatible" }, dependencies: [{ name: "absent", status: "incompatible", version: "2.0.0" }] })
            await writeFile(join(packagePath, "package.json"), "{malformed")
            expect(await project.verify()).toMatchObject({ ok: false, error: { code: "dependency_missing" } })
            for (const mutation of Object.values(mutations)) expect(mutation).not.toHaveBeenCalled()
            expect(spawn).toHaveBeenCalledTimes(npmCalls)
            expect(await readFile(installed.paths.manifestPath, "utf8")).toBe(manifest)
            expect(await readFile(installed.paths.lockfilePath, "utf8")).toBe(lockfile)
            await rm(packagePath, { recursive: true })
            expectSuccess(await project.install())
            expect(await project.verify()).toEqual({ ok: true })
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    }, process.platform === "win32" ? 60_000 : 5_000)

    test("retries Windows manifest replacement beyond eight attempts without changing missing dependency failures", async (): Promise<void> => {
        const workspacePath = await createTemporaryRoot("managed-script-manifest-transient-")
        const paths = createManagedScriptProjectPaths(workspacePath, "job")
        const fileSystem = createFileSystem()
        const transientFailures = 12
        let remainingFailures = transientFailures
        const renameSpy = mock<ManagedScriptProjectFileSystem["rename"]>(async (oldPath, newPath): Promise<void> => {
            if (newPath === paths.manifestPath && remainingFailures > 0) {
                remainingFailures--
                const error = new Error("Fixture manifest sharing violation") as NodeJS.ErrnoException
                error.code = "EPERM"
                throw error
            }
            await fileSystem.rename(oldPath, newPath)
        })
        const rmSpy = mock(fileSystem.rm)
        const sleep = mock(async (_milliseconds: number): Promise<void> => undefined)
        const spawn = mock<ManagedScriptProjectSpawn>(async (command, args): Promise<ManagedScriptProjectCommandResult> => {
            expect(command).toBe("npm")
            expect(args).toEqual(npmInstallArgs)
            expect(JSON.parse(await readFile(paths.manifestPath, "utf8"))).toMatchObject({ dependencies: { absent: "^1.0.0" } })
            return npmInstallSuccess
        })
        try {
            const project = createProject(workspacePath, spawn, {
                fileSystem: { ...fileSystem, rename: renameSpy, rm: rmSpy },
                platform: "win32",
                installerLock: { sleep },
            })
            expectSuccess(await project.setup())
            const originalManifest = await readFile(paths.manifestPath, "utf8")
            rmSpy.mockClear()
            const result = await project.setup({ dependencies: { absent: "^1.0.0" } })

            expect(result).toMatchObject({ ok: false, error: { code: "install_incomplete" }, dependencies: [{ name: "absent", status: "missing" }], npm: { exitCode: 0 } })
            expect(remainingFailures).toBe(0)
            expect(spawn).toHaveBeenCalledTimes(1)
            expect(sleep.mock.calls.map(([milliseconds]): number => milliseconds)).toEqual(windowsFileReplacementRetryDelaysMs.slice(0, transientFailures))
            const replacements = renameSpy.mock.calls.filter(([, newPath]): boolean => newPath === paths.manifestPath)
            expect(replacements).toHaveLength(transientFailures + 2)
            expect(new Set(replacements.slice(0, transientFailures + 1).map(([oldPath]): string => oldPath)).size).toBe(1)
            for (const [oldPath] of replacements) {
                expect(oldPath).toStartWith(`${paths.manifestPath}.autocode-tmp-`)
                expect(await exists(oldPath)).toBe(false)
            }
            for (const [filePath] of rmSpy.mock.calls) expect(filePath).not.toBe(paths.manifestPath)
            expect(await readFile(paths.manifestPath, "utf8")).toBe(originalManifest)
            expect(await exists(paths.journalPath)).toBe(true)
            expect(await project.verify()).toMatchObject({ ok: false, error: { code: "install_interrupted" } })
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test.each([
        ["win32", "EPERM", 20, windowsFileReplacementRetryDelaysMs, 4_790],
        ["win32", "EBUSY", 20, windowsFileReplacementRetryDelaysMs, 4_790],
        ["win32", "EACCES", 20, windowsFileReplacementRetryDelaysMs, 4_790],
        ["win32", "EIO", 1, [], 0],
        ["linux", "EPERM", 5, fileReplacementRetryDelaysMs, 150],
        ["darwin", "EPERM", 5, fileReplacementRetryDelaysMs, 150],
    ] as const)("bounds %s manifest replacement failures for %s to %s attempts", async (platform: NodeJS.Platform, code: string, attempts: number, delays: readonly number[], delayBudgetMs: number): Promise<void> => {
        const workspacePath = await createTemporaryRoot("managed-script-manifest-persistent-")
        const paths = createManagedScriptProjectPaths(workspacePath, "job")
        const fileSystem = createFileSystem()
        const spawn = mock(async (): Promise<ManagedScriptProjectCommandResult> => npmInstallSuccess)
        const renameSpy = mock<ManagedScriptProjectFileSystem["rename"]>(async (oldPath, newPath): Promise<void> => {
            if (newPath === paths.manifestPath) {
                const error = new Error(`Fixture ${code} manifest replacement failure`) as NodeJS.ErrnoException
                error.code = code
                throw error
            }
            await fileSystem.rename(oldPath, newPath)
        })
        const rmSpy = mock(fileSystem.rm)
        let elapsedMs = 0
        const sleep = mock(async (milliseconds: number): Promise<void> => { elapsedMs += milliseconds })
        try {
            expectSuccess(await createProject(workspacePath, spawn, { platform, installerLock: { sleep } }).setup())
            sleep.mockClear()
            elapsedMs = 0
            const originalManifest = await readFile(paths.manifestPath, "utf8")
            const originalLockfile = '{"lockfileVersion":3}\n'
            await writeFile(paths.lockfilePath, originalLockfile)
            const project = createProject(workspacePath, spawn, {
                fileSystem: { ...fileSystem, rename: renameSpy, rm: rmSpy },
                platform,
                installerLock: { now: (): number => elapsedMs, sleep },
            })
            const result = await project.install({ dependencies: { absent: "^1.0.0" } })

            if (result.ok || !result.error) throw new Error(`Expected manifest replacement failure: ${JSON.stringify(result)}`)
            expect(result.error.code).toBe("install_incomplete")
            expect(result.error.message).toContain("npm install was not invoked")
            expect(result.error.message).toContain("package.json restore failed")
            expect(result.npm).toBeUndefined()
            expect(spawn).not.toHaveBeenCalled()
            const replacements = renameSpy.mock.calls.filter(([, newPath]): boolean => newPath === paths.manifestPath)
            expect(replacements).toHaveLength(attempts * 2)
            const temporarySources = new Set(replacements.map(([oldPath]): string => oldPath))
            expect(temporarySources.size).toBe(2)
            expect(new Set(replacements.slice(0, attempts).map(([oldPath]): string => oldPath)).size).toBe(1)
            expect(new Set(replacements.slice(attempts).map(([oldPath]): string => oldPath)).size).toBe(1)
            expect(sleep.mock.calls.map(([milliseconds]): number => milliseconds)).toEqual([...delays, ...delays])
            expect(sleep).toHaveBeenCalledTimes((attempts - 1) * 2)
            expect(elapsedMs).toBe(delayBudgetMs * 2)
            for (const temporarySource of temporarySources) {
                expect(temporarySource).toStartWith(`${paths.manifestPath}.autocode-tmp-`)
                expect(rmSpy).toHaveBeenCalledWith(temporarySource, { force: true })
                expect(await exists(temporarySource)).toBe(false)
            }
            for (const [filePath] of rmSpy.mock.calls) expect(filePath).not.toBe(paths.manifestPath)
            expect(await readFile(paths.manifestPath, "utf8")).toBe(originalManifest)
            expect(await readFile(paths.lockfilePath, "utf8")).toBe(originalLockfile)
            const journal = await readFile(paths.journalPath, "utf8")
            expect(JSON.parse(journal)).toMatchObject({ requests: { absent: "^1.0.0" }, prior: { manifest: originalManifest, lockfile: originalLockfile } })
            expect(await project.verify()).toMatchObject({ ok: false, error: { code: "install_interrupted" } })
            expect(await readFile(paths.journalPath, "utf8")).toBe(journal)
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("tracks inherited dependencies from a deterministic shared origin without npm", async (): Promise<void> => {
        const workspacePath = await createTemporaryRoot("managed-script-inherited-")
        const packagePath = join(workspacePath, "node_modules", "ancestor-package")
        const resolutionOrigin = join(workspacePath, ".opencode", "autocode", "package.json")
        const resolutionCalls: string[] = []
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }): Promise<ManagedScriptProjectCommandResult> => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd)
            return npmInstallSuccess
        })
        try {
            const project = createProject(workspacePath, spawn, {
                resolvePackage: async (_name, fromFile): Promise<Awaited<ReturnType<NonNullable<ManagedScriptProjectDependencies["resolvePackage"]>>>> => {
                    resolutionCalls.push(fromFile)
                    return fromFile === resolutionOrigin
                        ? { packagePath, version: "2.1.0", workspacePath }
                        : undefined
                },
            })
            const result = expectSuccess(await project.setup({ dependencies: { "ancestor-package": "2.1.0" } }))

            expect(result.dependencies).toEqual([{ name: "ancestor-package", requestedRange: "2.1.0", status: "satisfied", source: "inherited", version: "2.1.0", packagePath, workspacePath }])
            expect(resolutionCalls.length).toBeGreaterThan(0)
            expect(resolutionCalls.every((fromFile: string): boolean => fromFile === resolutionOrigin)).toBe(true)
            expect(await exists(join(result.paths.nodeModulesPath, "ancestor-package"))).toBe(false)
            const manifest = JSON.parse(await readFile(result.paths.manifestPath, "utf8")) as { dependencies?: Record<string, string>, autocode: { inheritedDependencies: Record<string, unknown> } }
            expect(manifest.dependencies).toBeUndefined()
            expect(manifest.autocode.inheritedDependencies).toEqual({ "ancestor-package": { version: "2.1.0", packagePath, workspacePath, requestedRange: "2.1.0" } })
            expect(result.npm).toBeUndefined()
            expect(spawn).not.toHaveBeenCalled()
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("installs local packages when compatible-looking ancestors lack valid package metadata", async (): Promise<void> => {
        const workspacePath = await createTemporaryRoot("managed-script-malformed-inherited-")
        const scriptsRoot = createManagedScriptProjectPaths(workspacePath, "job").scriptsRoot
        const missingPackage = "managed-script-missing-metadata"
        const malformedPackage = "managed-script-malformed-metadata"
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }): Promise<ManagedScriptProjectCommandResult> => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd, { [missingPackage]: "2.0.0", [malformedPackage]: "2.0.0" })
            return npmInstallSuccess
        })
        try {
            for (const name of [missingPackage, malformedPackage]) {
                const packagePath = join(workspacePath, "node_modules", name)
                await mkdir(packagePath, { recursive: true })
                await writeFile(join(packagePath, "index.js"), "module.exports = {}\n")
            }
            await writeFile(join(workspacePath, "node_modules", malformedPackage, "package.json"), '{"name":"managed-script-malformed-metadata"\n')
            const result = expectSuccess(await createProject(workspacePath, spawn).setup({ dependencies: { [missingPackage]: "^2.0.0", [malformedPackage]: "^2.0.0" } }))
            const manifest = JSON.parse(await readFile(join(scriptsRoot, "package.json"), "utf8")) as { dependencies: Record<string, string>, autocode?: { inheritedDependencies?: Record<string, unknown> } }

            expect(result.dependencies).toEqual([
                { name: missingPackage, requestedRange: "^2.0.0", status: "satisfied", source: "local", version: "2.0.0", packagePath: join(scriptsRoot, "node_modules", missingPackage) },
                { name: malformedPackage, requestedRange: "^2.0.0", status: "satisfied", source: "local", version: "2.0.0", packagePath: join(scriptsRoot, "node_modules", malformedPackage) },
            ])
            expect(manifest.dependencies).toEqual({ [missingPackage]: "^2.0.0", [malformedPackage]: "^2.0.0" })
            expect(manifest.autocode?.inheritedDependencies ?? {}).toEqual({})
            expect(spawn).toHaveBeenCalledTimes(1)
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("falls back to a local install when no root or ancestor package resolves", async (): Promise<void> => {
        const workspacePath = await createTemporaryRoot("managed-script-no-package-")
        const packageName = "managed-script-unresolvable-package"
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }): Promise<ManagedScriptProjectCommandResult> => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd)
            return npmInstallSuccess
        })
        try {
            const result = expectSuccess(await createProject(workspacePath, spawn).setup({ dependencies: { [packageName]: "^1.0.0" } }))

            expect(result.dependencies).toEqual([{ name: packageName, requestedRange: "^1.0.0", status: "satisfied", source: "local", version: "1.0.0", packagePath: join(result.paths.nodeModulesPath, packageName) }])
            expect(await exists(join(result.paths.nodeModulesPath, packageName, "package.json"))).toBe(true)
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("resolves exported ESM ancestor packages without NODE_PATH or a local package", async (): Promise<void> => {
        const rootPath = await createTemporaryRoot("managed-script-esm-ancestor-")
        const workspacePath = join(rootPath, "job")
        const packageName = "managed-script-esm-ancestor"
        const packagePath = join(rootPath, "node_modules", packageName)
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }): Promise<ManagedScriptProjectCommandResult> => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd)
            return npmInstallSuccess
        })
        try {
            await mkdir(packagePath, { recursive: true })
            await writeFile(join(packagePath, "package.json"), `${JSON.stringify({ name: packageName, version: "2.1.0", type: "module", exports: { ".": "./index.js" } })}\n`)
            await writeFile(join(packagePath, "index.js"), "export {}\n")
            const project = createProject(workspacePath, spawn, { resolvePackage: undefined })
            const result = expectSuccess(await project.setup({ dependencies: { [packageName]: "^2.0.0" } }))

            expect(result.dependencies).toEqual([{ name: packageName, requestedRange: "^2.0.0", status: "satisfied", source: "inherited", version: "2.1.0", packagePath, workspacePath: rootPath }])
            expect(await exists(join(result.paths.nodeModulesPath, packageName))).toBe(false)
            expect(result.npm).toBeUndefined()
            expect(spawn).not.toHaveBeenCalled()
            expect(await project.verify()).toEqual({ ok: true })
        }
        finally {
            await rm(rootPath, { recursive: true, force: true })
        }
    })

    test("honors nearest ancestors and local precedence, then repairs removed or drifted ancestors", async (): Promise<void> => {
        const rootPath = await createTemporaryRoot("managed-script-real-fallback-")
        const workspacePath = join(rootPath, "job")
        const scriptsRoot = createManagedScriptProjectPaths(workspacePath, "job").scriptsRoot
        const packagePath = (name: string): string => join(rootPath, "node_modules", name)
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }): Promise<ManagedScriptProjectCommandResult> => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd, {
                "managed-script-incompatible": "2.0.0",
                "managed-script-local-wins": "2.0.0",
                "managed-script-removed": "2.0.0",
                "managed-script-drifted": "2.0.0",
            })
            return npmInstallSuccess
        })
        try {
            for (const [name, version] of [["managed-script-incompatible", "2.0.0"], ["managed-script-local-wins", "1.0.0"], ["managed-script-removed", "2.0.0"], ["managed-script-drifted", "2.0.0"]]) {
                await mkdir(packagePath(name), { recursive: true })
                await writeFile(join(packagePath(name), "package.json"), `${JSON.stringify({ name, version })}\n`)
                await writeFile(join(packagePath(name), "index.js"), "module.exports = {}\n")
            }
            await mkdir(join(scriptsRoot, "node_modules", "managed-script-local-wins"), { recursive: true })
            await writeFile(join(scriptsRoot, "package.json"), `${JSON.stringify({ private: true, dependencies: { "managed-script-local-wins": "2.0.0" } })}\n`)
            await writeFile(join(scriptsRoot, "node_modules", "managed-script-local-wins", "package.json"), '{"name":"managed-script-local-wins","version":"2.0.0"}\n')
            const nearestPackagePath = join(workspacePath, "node_modules", "managed-script-incompatible")
            await writeInstalledPackage(nearestPackagePath, "managed-script-incompatible", "1.0.0")
            const project = createProject(workspacePath, spawn)
            const requests = {
                "managed-script-incompatible": "^2.0.0",
                "managed-script-local-wins": "2.0.0",
                "managed-script-removed": "^2.0.0",
                "managed-script-drifted": "^2.0.0",
            }
            const blocked = await project.setup({ dependencies: requests })
            expect(blocked).toMatchObject({ ok: false, blocker: { code: "upgrade_required" } })
            expect(blocked.dependencies?.[0]).toMatchObject({ name: "managed-script-incompatible", status: "incompatible", version: "1.0.0", source: "inherited", packagePath: nearestPackagePath, workspacePath })
            expect(spawn).not.toHaveBeenCalled()
            const initial = expectSuccess(await project.install({ dependencies: requests, upgrade: true }))

            expect(initial.dependencies.find((dependency) => dependency.name === "managed-script-incompatible")?.source).toBe("local")
            expect(initial.dependencies.find((dependency) => dependency.name === "managed-script-local-wins")?.source).toBe("local")
            expect(initial.dependencies.filter((dependency) => dependency.source === "inherited").map((dependency) => dependency.name)).toEqual(["managed-script-removed", "managed-script-drifted"])

            await rm(packagePath("managed-script-removed"), { recursive: true, force: true })
            await writeFile(join(packagePath("managed-script-drifted"), "package.json"), '{"name":"managed-script-drifted","version":"1.0.0"}\n')
            expect(await project.verify()).toMatchObject({ ok: false, error: { code: "dependency_missing" } })
            const repaired = expectSuccess(await project.install())

            expect(repaired.dependencies.filter((dependency): boolean => ["managed-script-removed", "managed-script-drifted"].includes(dependency.name))).toEqual([
                { name: "managed-script-removed", requestedRange: "^2.0.0", status: "satisfied", source: "local", version: "2.0.0", packagePath: join(scriptsRoot, "node_modules", "managed-script-removed") },
                { name: "managed-script-drifted", requestedRange: "^2.0.0", status: "satisfied", source: "local", version: "2.0.0", packagePath: join(scriptsRoot, "node_modules", "managed-script-drifted") },
            ])
            expect(repaired.dependencies.every((dependency): boolean => dependency.status === "satisfied")).toBe(true)
            expect(await readFile(join(nearestPackagePath, "package.json"), "utf8")).toContain('"version":"1.0.0"')
            expect(await readFile(join(packagePath("managed-script-local-wins"), "package.json"), "utf8")).toContain('"version":"1.0.0"')
            expect(await project.verify()).toEqual({ ok: true })
        }
        finally {
            await rm(rootPath, { recursive: true, force: true })
        }
    })

    test("keeps unrelated manifest and lock ownership when injected npm installs local packages", async (): Promise<void> => {
        const workspacePath = await createTemporaryRoot("managed-script-lock-owner-")
        const scriptsRoot = createManagedScriptProjectPaths(workspacePath, "job").scriptsRoot
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }): Promise<ManagedScriptProjectCommandResult> => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd, { unrelated: "1.0.0", installed: "2.0.0" })
            return npmInstallSuccess
        })
        try {
            await mkdir(scriptsRoot, { recursive: true })
            await writeFile(join(scriptsRoot, "package.json"), '{"private":true,"dependencies":{"unrelated":"^1.0.0"}}\n')
            await writeFile(join(scriptsRoot, "package-lock.json"), '{"lockfileVersion":3,"custom_lock_owner":"local","packages":{"":{"owner":"local","dependencies":{"unrelated":"^1.0.0"}},"node_modules/unrelated":{"version":"1.0.0","integrity":"keep"}}}\n')
            const result = expectSuccess(await createProject(workspacePath, spawn).setup({ dependencies: { installed: "^2.0.0" } }))
            const manifest = JSON.parse(await readFile(join(scriptsRoot, "package.json"), "utf8")) as { dependencies: Record<string, string> }
            const lock = JSON.parse(await readFile(join(scriptsRoot, "package-lock.json"), "utf8")) as { lockfileVersion: number, custom_lock_owner: string, packages: Record<string, Record<string, unknown>> }

            expect(result.dependencies).toEqual([{ name: "installed", requestedRange: "^2.0.0", status: "satisfied", source: "local", version: "2.0.0", packagePath: join(scriptsRoot, "node_modules", "installed") }])
            expect(manifest.dependencies).toEqual({ unrelated: "^1.0.0", installed: "^2.0.0" })
            expect(lock).toMatchObject({ lockfileVersion: 3, custom_lock_owner: "local", packages: { "": { owner: "local", dependencies: { unrelated: "^1.0.0", installed: "^2.0.0" } }, "node_modules/unrelated": { version: "1.0.0", integrity: "keep" } } })
            expect(await readFile(join(scriptsRoot, "node_modules", "installed", "package.json"), "utf8")).toContain('"version":"2.0.0"')
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("repairs inherited declarations while retaining unrelated ownership and preferring installed local packages", async (): Promise<void> => {
        const workspacePath = await createTemporaryRoot("managed-script-local-")
        const scriptsRoot = createManagedScriptProjectPaths(workspacePath, "job").scriptsRoot
        const resolverCalls: string[] = []
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }): Promise<ManagedScriptProjectCommandResult> => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd, { shadow: "2.0.0", drift: "1.0.0", missing: "1.0.0", incompatible: "2.0.0" })
            return npmInstallSuccess
        })
        try {
            await mkdir(scriptsRoot, { recursive: true })
            await writeInstalledPackage(join(scriptsRoot, "node_modules", "shadow"), "shadow", "2.0.0")
            await writeFile(join(scriptsRoot, "package.json"), `${JSON.stringify({
                private: true,
                dependencies: { shadow: "^2.0.0" },
                autocode: { inheritedDependencies: {
                    drift: { version: "1.0.0", packagePath: "/old/drift", workspacePath, requestedRange: "^1.0.0" },
                    missing: { version: "1.0.0", packagePath: "/old/missing", workspacePath, requestedRange: "^1.0.0" },
                    incompatible: { version: "1.0.0", packagePath: "/old/incompatible", workspacePath, requestedRange: "^1.0.0" },
                } },
            }, undefined, 2)}\n`)
            const project = createProject(workspacePath, spawn, {
                resolvePackage: async (name): Promise<Awaited<ReturnType<NonNullable<ManagedScriptProjectDependencies["resolvePackage"]>>>> => {
                    resolverCalls.push(name)
                    if (name === "drift") return { packagePath: join(workspacePath, "node_modules", "drift"), version: "2.0.0", workspacePath }
                    if (name === "incompatible") return { packagePath: join(workspacePath, "node_modules", "incompatible"), version: "1.0.0", workspacePath }
                    return undefined
                },
            })
            expectSuccess(await project.setup())
            expect(await project.install({ dependencies: { shadow: "^2.0.0", incompatible: "^2.0.0" } })).toMatchObject({ ok: false, blocker: { code: "upgrade_required" } })
            const result = expectSuccess(await project.install({ dependencies: { shadow: "^2.0.0", incompatible: "^2.0.0" }, upgrade: true }))
            const manifest = JSON.parse(await readFile(join(scriptsRoot, "package.json"), "utf8")) as { dependencies: Record<string, string>, autocode: { inheritedDependencies: Record<string, unknown> } }

            expect(result.dependencies.map((dependency): string[] => [dependency.name, dependency.source ?? ""])).toEqual([
                ["shadow", "local"], ["incompatible", "local"],
            ])
            expect(resolverCalls).not.toContain("shadow")
            expect(manifest.dependencies).toMatchObject({ shadow: "^2.0.0", drift: "^1.0.0", missing: "^1.0.0", incompatible: "^2.0.0" })
            expect(Object.keys(manifest.autocode.inheritedDependencies)).toEqual(["drift", "missing"])
            expect(await exists(join(scriptsRoot, "node_modules", "drift", "package.json"))).toBe(true)
            expect(await exists(join(scriptsRoot, "node_modules", "missing", "package.json"))).toBe(true)
            expect(await exists(join(scriptsRoot, "node_modules", "incompatible", "package.json"))).toBe(true)
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("repairs dependency maps after manifest edits while retaining local and inherited ownership", async (): Promise<void> => {
        const workspacePath = await createTemporaryRoot("managed-script-manifest-edits-")
        const scriptsRoot = createManagedScriptProjectPaths(workspacePath, "job").scriptsRoot
        let inheritedAvailable = true
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }): Promise<ManagedScriptProjectCommandResult> => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd, { unrelated: "1.0.0", added: "1.0.0", edited: "1.0.0", inherited: "2.0.0" })
            return npmInstallSuccess
        })
        try {
            await mkdir(join(scriptsRoot, "node_modules", "unrelated"), { recursive: true })
            await writeFile(join(scriptsRoot, "node_modules", "unrelated", "package.json"), '{"name":"unrelated","version":"1.0.0"}\n')
            await writeFile(join(scriptsRoot, "package.json"), `${JSON.stringify({
                name: "owned-project",
                private: true,
                dependencies: { unrelated: "^1.0.0" },
                autocode: { inheritedDependencies: { inherited: { version: "1.0.0", packagePath: "/old/inherited", workspacePath, requestedRange: "^2.0.0" } } },
            }, undefined, 2)}\n`)
            await writeFile(join(scriptsRoot, "package-lock.json"), `${JSON.stringify({ lockfileVersion: 3, custom_lock_owner: "local", packages: { "": { owner: "local", dependencies: { unrelated: "^1.0.0" } } } }, undefined, 2)}\n`)
            const project = createProject(workspacePath, spawn, {
                resolvePackage: async (name): Promise<Awaited<ReturnType<NonNullable<ManagedScriptProjectDependencies["resolvePackage"]>>>> => inheritedAvailable && name === "inherited"
                    ? { packagePath: join(workspacePath, "node_modules", "inherited"), version: "2.0.0", workspacePath }
                    : undefined,
            })
            expectSuccess(await project.setup({ dependencies: { inherited: "^2.0.0", added: "^1.0.0" } }))
            const refreshed = JSON.parse(await readFile(join(scriptsRoot, "package.json"), "utf8")) as { dependencies: Record<string, string>, autocode: { inheritedDependencies: Record<string, { version: string, requestedRange: string }> } }
            expect(refreshed.dependencies).toMatchObject({ unrelated: "^1.0.0", added: "^1.0.0" })
            expect(refreshed.autocode.inheritedDependencies.inherited).toMatchObject({ version: "2.0.0", requestedRange: "^2.0.0" })

            refreshed.dependencies.edited = "^1.0.0"
            await writeFile(join(scriptsRoot, "package.json"), `${JSON.stringify(refreshed, undefined, 2)}\n`)
            inheritedAvailable = false
            expectSuccess(await project.setup())
            expect(spawn).toHaveBeenCalledTimes(1)
            expect(await project.verify()).toMatchObject({ ok: false, error: { code: "dependency_missing" } })
            expectSuccess(await project.install())
            const finalManifest = JSON.parse(await readFile(join(scriptsRoot, "package.json"), "utf8")) as { dependencies: Record<string, string>, autocode: { inheritedDependencies: Record<string, unknown> } }
            const lock = JSON.parse(await readFile(join(scriptsRoot, "package-lock.json"), "utf8")) as { custom_lock_owner: string, packages: Record<string, { owner: string, dependencies: Record<string, string> }> }

            expect(finalManifest.dependencies).toMatchObject({ unrelated: "^1.0.0", added: "^1.0.0", edited: "^1.0.0", inherited: "^2.0.0" })
            expect(finalManifest.autocode.inheritedDependencies).toEqual(refreshed.autocode.inheritedDependencies)
            expect(lock.custom_lock_owner).toBe("local")
            expect(lock.packages[""]).toMatchObject({ owner: "local", dependencies: { unrelated: "^1.0.0" } })
            expect(await project.verify()).toEqual({ ok: true })
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test.each([false, true])("preserves satisfied declared ranges without npm when upgrade is %s", async (upgrade: boolean): Promise<void> => {
        const directory = await createTemporaryRoot("managed-script-compatible-ranges-")
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }): Promise<ManagedScriptProjectCommandResult> => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd, { semver: "7.6.3", yaml: "2.4.5" })
            return npmInstallSuccess
        })
        try {
            const project = createProject(directory, spawn)
            const setup = expectSuccess(await project.setup({ dependencies: { semver: "^7.6.0", yaml: "^2.4.0" } }))
            const manifest = await readFile(setup.paths.manifestPath, "utf8")
            const lockfile = await readFile(setup.paths.lockfilePath, "utf8")
            expect(JSON.parse(manifest)).toMatchObject({ dependencies: { semver: "^7.6.0", yaml: "^2.4.0" } })
            expect(spawn).toHaveBeenCalledTimes(1)
            spawn.mockClear()
            const result = expectSuccess(await project.install({ dependencies: { semver: "^7.0.0", yaml: ">=2 <3" }, upgrade }))
            expect(result.dependencies).toMatchObject([
                { name: "semver", requestedRange: "^7.0.0", status: "satisfied", source: "local", version: "7.6.3" },
                { name: "yaml", requestedRange: ">=2 <3", status: "satisfied", source: "local", version: "2.4.5" },
            ])
            expect(await readFile(setup.paths.manifestPath, "utf8")).toBe(manifest)
            expect(await readFile(setup.paths.lockfilePath, "utf8")).toBe(lockfile)
            expect(result.npm).toBeUndefined()
            expect(spawn).not.toHaveBeenCalled()
        }
        finally {
            await rm(directory, { recursive: true, force: true })
        }
    })

    test("incrementally installs into one shared tree, reuses satisfied ranges, and upgrades only explicit conflicts", async (): Promise<void> => {
        const directory = await createTemporaryRoot("managed-script-incremental-")
        const paths = createManagedScriptProjectPaths(directory, "inspect_data")
        const fileSystem = createFileSystem()
        let failManifestReplacement = false
        const renameSpy = mock<ManagedScriptProjectFileSystem["rename"]>(async (oldPath, newPath): Promise<void> => {
            if (failManifestReplacement && newPath === paths.manifestPath) {
                failManifestReplacement = false
                const error = new Error("Fixture manifest sharing violation") as NodeJS.ErrnoException
                error.code = "EPERM"
                throw error
            }
            await fileSystem.rename(oldPath, newPath)
        })
        const rmSpy = mock(fileSystem.rm)
        const markerPath = join(paths.nodeModulesPath, ".keep-existing-tree")
        let semverVersion = "7.6.3"
        const tagVersion = "3.0.0"
        let viewQueries = 0
        let installOperations = 0
        const spawn = mock<ManagedScriptProjectSpawn>(async (command, args, options): Promise<ManagedScriptProjectCommandResult> => {
            expect(command).toBe("npm")
            expect(options?.cwd).toBe(paths.scriptsRoot)
            expect(await readFile(markerPath, "utf8")).toBe("existing yaml tree\n")
            if (args[0] === "view") {
                viewQueries++
                expect(args).toEqual(["view", "tagged@latest", "version", "--json", ...npmInstallArgs.slice(1)])
                expect(await exists(join(paths.nodeModulesPath, "tagged"))).toBe(false)
                return { exitCode: 0, stdout: `${JSON.stringify(tagVersion)}\n`, stderr: "" }
            }
            expect(args).toEqual(npmInstallArgs)
            installOperations++
            const installing = JSON.parse(await readFile(paths.manifestPath, "utf8")) as { dependencies: Record<string, string> }
            if (installing.dependencies.tagged !== undefined) expect(installing.dependencies.tagged).toBe(tagVersion)
            await writeNpmArtifacts(paths.scriptsRoot, { semver: semverVersion, tagged: tagVersion })
            return npmInstallSuccess
        })
        try {
            const sharedFileSystem = { ...fileSystem, rename: renameSpy, rm: rmSpy }
            const firstProject = createProject(directory, spawn, {
                fileSystem: sharedFileSystem,
                resolveOwner: async (): Promise<Awaited<ReturnType<typeof resolveManagedScriptProjectOwner>>> => ({ ok: true, owner: { jobName: "inspect_data", directory } }),
            })
            const first = expectSuccess(await firstProject.setup())
            await writeFile(paths.manifestPath, `${JSON.stringify({ private: true, type: "module", dependencies: { yaml: "^2.4.0" } }, undefined, 2)}\n`)
            await writeNpmArtifacts(paths.scriptsRoot, { yaml: "2.4.5" })
            await writeFile(markerPath, "existing yaml tree\n")
            const yamlManifestPath = join(paths.nodeModulesPath, "yaml", "package.json")
            const yamlManifest = await readFile(yamlManifestPath, "utf8")
            const yamlSource = await readFile(join(paths.nodeModulesPath, "yaml", "index.js"), "utf8")
            const initialLock = JSON.parse(await readFile(paths.lockfilePath, "utf8")) as { packages: Record<string, unknown> }
            const secondProject = createProject(directory, spawn, {
                fileSystem: sharedFileSystem,
                resolveOwner: async (): Promise<Awaited<ReturnType<typeof resolveManagedScriptProjectOwner>>> => ({ ok: true, owner: { jobName: "compare_data", directory } }),
            })
            const second = expectSuccess(await secondProject.setup())
            const tasks = [join(first.paths.sourceRoot, "task.mjs"), join(second.paths.sourceRoot, "task.mjs")]
            for (const task of tasks) await writeFile(task, 'import { version } from "semver"\nprocess.stdout.write(version)\n')
            expect(first.paths.sourceRoot).not.toBe(second.paths.sourceRoot)
            expect(first.paths.nodeModulesPath).toBe(second.paths.nodeModulesPath)
            expect(await exists(join(paths.nodeModulesPath, "semver"))).toBe(false)
            expect(spawn).not.toHaveBeenCalled()
            expect(installOperations).toBe(0)
            expect(viewQueries).toBe(0)
            renameSpy.mockClear()
            rmSpy.mockClear()

            const installed = expectSuccess(await firstProject.install({ dependencies: { semver: "^7.6.0" } }))
            expect(spawn).toHaveBeenCalledTimes(1)
            expect(installOperations).toBe(1)
            expect(installed.npm).toMatchObject({ exitCode: 0 })
            expect(installed.dependencies).toEqual([{ name: "semver", requestedRange: "^7.6.0", status: "satisfied", source: "local", version: "7.6.3", packagePath: join(paths.nodeModulesPath, "semver") }])
            expect(await readFile(markerPath, "utf8")).toBe("existing yaml tree\n")
            expect(await readFile(yamlManifestPath, "utf8")).toBe(yamlManifest)
            const incrementalLock = JSON.parse(await readFile(paths.lockfilePath, "utf8")) as { packages: Record<string, unknown> }
            expect(incrementalLock.packages["node_modules/yaml"]).toEqual(initialLock.packages["node_modules/yaml"])
            for (const task of tasks) {
                expect(createRequire(task).resolve("semver")).toBe(join(paths.nodeModulesPath, "semver", "index.js"))
                expect(await runEsmTask(task, paths.scriptsRoot)).toEqual({ exitCode: 0, stdout: "7.6.3", stderr: "" })
            }

            const manifestBeforeReuse = await readFile(paths.manifestPath, "utf8")
            const lockBeforeReuse = await readFile(paths.lockfilePath, "utf8")
            const repeated = expectSuccess(await secondProject.install({ dependencies: { semver: "^7.6.0" } }))
            expect(repeated.npm).toBeUndefined()
            expect(repeated.dependencies).toMatchObject([{ name: "semver", status: "satisfied", version: "7.6.3" }])
            const broader = expectSuccess(await secondProject.setup({ dependencies: { semver: ">=7 <8" } }))
            expect(broader.npm).toBeUndefined()
            const satisfiedUpgrade = expectSuccess(await firstProject.install({ dependencies: { semver: "^7.0.0", yaml: ">=2 <3" }, upgrade: true }))
            expect(satisfiedUpgrade.npm).toBeUndefined()
            expect(satisfiedUpgrade.dependencies.map((dependency): string | undefined => dependency.version)).toEqual(["7.6.3", "2.4.5"])
            expect(spawn).toHaveBeenCalledTimes(1)
            expect(installOperations).toBe(1)
            expect(viewQueries).toBe(0)
            expect(await readFile(paths.manifestPath, "utf8")).toBe(manifestBeforeReuse)
            expect(await readFile(paths.lockfilePath, "utf8")).toBe(lockBeforeReuse)

            const conflict = await secondProject.install({ dependencies: { semver: "^8.0.0" } })
            expect(conflict).toMatchObject({ ok: false, blocker: { code: "upgrade_required" }, dependencies: [{ name: "semver", requestedRange: "^8.0.0", status: "incompatible", version: "7.6.3" }] })
            expect(conflict.npm).toBeUndefined()
            expect(spawn).toHaveBeenCalledTimes(1)
            expect(await readFile(paths.manifestPath, "utf8")).toBe(manifestBeforeReuse)
            expect(await readFile(paths.lockfilePath, "utf8")).toBe(lockBeforeReuse)
            semverVersion = "8.0.0"
            const upgraded = expectSuccess(await secondProject.install({ dependencies: { semver: "^8.0.0", yaml: ">=2 <3" }, upgrade: true }))
            expect(spawn).toHaveBeenCalledTimes(2)
            expect(installOperations).toBe(2)
            expect(viewQueries).toBe(0)
            expect(upgraded.npm).toMatchObject({ exitCode: 0 })
            expect(upgraded.dependencies).toMatchObject([{ name: "semver", status: "satisfied", version: "8.0.0" }, { name: "yaml", status: "satisfied", version: "2.4.5" }])
            const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8")) as { dependencies: Record<string, string> }
            expect(manifest.dependencies).toEqual({ yaml: "^2.4.0", semver: "^8.0.0" })
            expect(Object.values(manifest.dependencies)).not.toContain("latest")
            for (const [, args] of spawn.mock.calls) expect(args).toEqual(npmInstallArgs)
            expect(await readFile(yamlManifestPath, "utf8")).toBe(yamlManifest)
            expect(await readFile(join(paths.nodeModulesPath, "yaml", "index.js"), "utf8")).toBe(yamlSource)
            expect(await readFile(markerPath, "utf8")).toBe("existing yaml tree\n")
            const finalLock = JSON.parse(await readFile(paths.lockfilePath, "utf8")) as { packages: Record<string, unknown> }
            expect(finalLock.packages["node_modules/yaml"]).toEqual(initialLock.packages["node_modules/yaml"])
            expect(finalLock.packages["node_modules/semver"]).toMatchObject({ version: "8.0.0" })

            const lockBeforeReplan = await readFile(paths.lockfilePath, "utf8")
            manifest.dependencies.semver = "^7.6.0"
            await writeFile(paths.manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
            const staleDeclaration = await readFile(paths.manifestPath, "utf8")
            expect(await firstProject.verify()).toMatchObject({ ok: false, error: { code: "dependency_incompatible" } })
            expect(await firstProject.install({ dependencies: { semver: "^8.0.0" } })).toMatchObject({ ok: false, blocker: { code: "upgrade_required" }, dependencies: [{ name: "semver", status: "satisfied", version: "8.0.0" }] })
            expect(await readFile(paths.manifestPath, "utf8")).toBe(staleDeclaration)
            const priorRenameAttempts = renameSpy.mock.calls.length
            failManifestReplacement = true
            const replanned = expectSuccess(await firstProject.install({ dependencies: { semver: "^8.0.0" }, upgrade: true }))
            expect(replanned.npm).toBeUndefined()
            expect(replanned.dependencies).toMatchObject([{ name: "semver", requestedRange: "^8.0.0", status: "satisfied", version: "8.0.0" }])
            expect(failManifestReplacement).toBe(false)
            expect(renameSpy.mock.calls.slice(priorRenameAttempts).filter(([, newPath]): boolean => newPath === paths.manifestPath)).toHaveLength(2)
            expect(JSON.parse(await readFile(paths.manifestPath, "utf8"))).toMatchObject({ dependencies: { yaml: "^2.4.0", semver: "^8.0.0" } })
            expect(await readFile(paths.lockfilePath, "utf8")).toBe(lockBeforeReplan)
            expect(installOperations).toBe(2)
            expect(viewQueries).toBe(0)
            expect(spawn).toHaveBeenCalledTimes(2)
            expect(await firstProject.verify()).toEqual({ ok: true })

            const tagged = expectSuccess(await firstProject.install({ dependencies: { tagged: "latest" } }))
            expect(tagged.npm).toMatchObject({ exitCode: 0, command: npmInstallArgs })
            expect(tagged.dependencies).toMatchObject([{ name: "tagged", requestedRange: "latest", status: "satisfied", version: tagVersion, source: "local" }])
            expect(viewQueries).toBe(1)
            expect(installOperations).toBe(3)
            const tagManifest = await readFile(paths.manifestPath, "utf8")
            const tagLock = await readFile(paths.lockfilePath, "utf8")
            expect(JSON.parse(tagManifest)).toMatchObject({ dependencies: { yaml: "^2.4.0", semver: "^8.0.0", tagged: "latest" }, autocode: { registryTagBindings: { tagged: { requestedRange: "latest", version: tagVersion } } } })
            expect(JSON.parse(tagLock)).toMatchObject({ packages: { "": { dependencies: { tagged: "latest" } }, "node_modules/tagged": { version: tagVersion } } })
            expect(expectSuccess(await secondProject.setup({ dependencies: { tagged: "latest" } })).npm).toBeUndefined()
            expect(expectSuccess(await secondProject.install({ dependencies: { tagged: "latest" } })).npm).toBeUndefined()
            expect(await readFile(paths.manifestPath, "utf8")).toBe(tagManifest)
            expect(await readFile(paths.lockfilePath, "utf8")).toBe(tagLock)
            expect(viewQueries).toBe(1)
            expect(installOperations).toBe(3)
            expect(spawn).toHaveBeenCalledTimes(4)

            await rm(join(paths.nodeModulesPath, "tagged"), { recursive: true })
            expect(await secondProject.verify()).toMatchObject({ ok: false, error: { code: "dependency_missing" } })
            const tagRepair = expectSuccess(await secondProject.install())
            expect(tagRepair.npm).toMatchObject({ exitCode: 0, command: npmInstallArgs })
            expect(tagRepair.dependencies.find((dependency): boolean => dependency.name === "tagged")).toMatchObject({ requestedRange: "latest", status: "satisfied", version: tagVersion })
            expect(viewQueries).toBe(1)
            expect(installOperations).toBe(4)
            expect(spawn).toHaveBeenCalledTimes(5)
            expect(await readFile(paths.manifestPath, "utf8")).toBe(tagManifest)
            expect(await readFile(yamlManifestPath, "utf8")).toBe(yamlManifest)
            expect(await readFile(join(paths.nodeModulesPath, "yaml", "index.js"), "utf8")).toBe(yamlSource)
            expect(await readFile(markerPath, "utf8")).toBe("existing yaml tree\n")
            expect(await exists(paths.journalPath)).toBe(false)
            await expectReleasedInstallerLock(fileSystem, paths.lockPath)
            expect(renameSpy.mock.calls.length).toBeGreaterThan(0)
            expect(rmSpy.mock.calls.length).toBeGreaterThan(0)
            for (const [oldPath, newPath] of renameSpy.mock.calls) {
                expect(oldPath).not.toContain("node_modules")
                expect(newPath).not.toContain("node_modules")
            }
            for (const [filePath] of rmSpy.mock.calls) expect(filePath).not.toContain("node_modules")
            expect(await firstProject.verify()).toEqual({ ok: true })
            expect(await secondProject.verify()).toEqual({ ok: true })
        }
        finally {
            await cleanupEsmTasks(paths.scriptsRoot, directory)
        }
    }, esmTaskTestTimeoutMs)

    test.each([
        ["1.9.0", "^1.2.3 || ^2.4.0", true],
        ["2.4.9", "^1.2.3 || ^2.4.0", true],
        ["3.0.0", "^1.2.3 || ^2.4.0", false],
        ["1.2.3", "1.2.3 - 2.3.4", true],
        ["2.3.4", "1.2.3 - 2.3.4", true],
        ["2.3.5", "1.2.3 - 2.3.4", false],
        ["2.3.9", "1.2 - 2.3", true],
        ["2.4.0", "1.2 - 2.3", false],
        ["1.9.9", "^1.2.3", true],
        ["2.0.0", "^1.2.3", false],
        ["0.2.9", "^0.2.3", true],
        ["0.2.2", "^0.2.3", false],
        ["0.3.0", "^0.2.3", false],
        ["0.0.3", "^0.0.3", true],
        ["0.0.4", "^0.0.3", false],
        ["0.0.9", "^0.0", true],
        ["0.1.0", "^0.0", false],
        ["0.2.9", "^0.2", true],
        ["0.3.0", "^0.2", false],
        ["0.9.9", "^0", true],
        ["1.0.0", "^0", false],
        ["1.2.9", "~1.2.3", true],
        ["1.3.0", "~1.2.3", false],
        ["1.9.9", "~1", true],
        ["2.0.0", "~1", false],
        ["0.0.9", "~0.0.3", true],
        ["0.1.0", "~0.0.3", false],
        ["1.2.3", ">=1.2.3 <2.0.0", true],
        ["1.9.9", ">=1.2.3 <2.0.0", true],
        ["2.0.0", ">=1.2.3 <2.0.0", false],
        ["1.2.3", "<=1.2.3", true],
        ["1.2.4", "<=1.2.3", false],
        ["1.2.3", ">1.2.3 <=2.0.0", false],
        ["2.0.0", ">1.2.3 <=2.0.0", true],
        ["1.2.99", "<=1.2", true],
        ["1.3.0", "<=1.2", false],
        ["1.2.99", ">1.2", false],
        ["1.3.0", ">1.2", true],
        ["1.1.9", "<1.2", true],
        ["1.2.0", "<1.2", false],
        ["1.5.0", ">= 1.2.3 < 2.0.0", true],
        ["1.2.3-beta.2", "^1.2.3", false],
        ["1.2.3-beta.2", "*", false],
        ["1.2.3-beta.2", ">=1.2.3-beta.1 <2.0.0", true],
        ["1.3.0-beta.1", ">=1.2.3-beta.1 <2.0.0", false],
        ["1.2.3-beta.10", ">=1.2.3-beta.2 <1.2.3", true],
        ["1.2.3-beta.1", ">=1.2.3-beta.2 <1.2.3", false],
        ["1.2.3-beta.2", "^1.2.3-beta.1", true],
        ["1.2.3", "^1.2.3-beta.1", true],
        ["1.3.0-beta.1", "^1.2.3-beta.1", false],
        ["1.2.3-beta.2", "=1.2.3-beta.2", true],
        ["1.2.3-alpha", "=1.2.3-beta.2", false],
        ["1.2.9", "1.2.x", true],
        ["1.3.0", "1.2.x", false],
        ["1.9.9", "1.X", true],
        ["2.0.0", "1.X", false],
        ["2.4.9", "2.*", true],
        ["3.0.0", "2.*", false],
        ["9.9.9", "*", true],
        ["9.9.9", "x", true],
        ["1.2.3+build.7", "1.2.3", true],
        ["1.2.3", "v1.2.3", true],
    ] satisfies [string, string, boolean][])("reuses supported semver ranges: %s satisfies %s -> %s", async (version: string, range: string, expected: boolean): Promise<void> => {
        expect(isManagedScriptDependencySpec(range)).toBe(true)
        expect(satisfiesManagedScriptRange(version, range)).toBe(expected)
        const directory = await createTemporaryRoot("managed-script-range-reuse-")
        const spawn = mock(async (): Promise<never> => { throw new Error("Satisfied or incompatible installed ranges must not run npm") })
        try {
            const project = createProject(directory, spawn)
            const setup = expectSuccess(await project.setup())
            await writeInstalledPackage(join(setup.paths.nodeModulesPath, "range-fixture"), "range-fixture", version)
            const manifest = `${JSON.stringify({ private: true, type: "module", dependencies: { "range-fixture": version } }, undefined, 2)}\n`
            await writeFile(setup.paths.manifestPath, manifest)
            const result = await project.install({ dependencies: { "range-fixture": range } })
            expect(result.dependencies).toMatchObject([{ name: "range-fixture", requestedRange: range, status: expected ? "satisfied" : "incompatible", version, source: "local" }])
            if (expected) expectSuccess(result)
            else expect(result).toMatchObject({ ok: false, blocker: { code: "upgrade_required" } })
            expect(result.npm).toBeUndefined()
            expect(spawn).not.toHaveBeenCalled()
            expect(await readFile(setup.paths.manifestPath, "utf8")).toBe(manifest)
            expect(await exists(setup.paths.lockfilePath)).toBe(false)
        }
        finally {
            await rm(directory, { recursive: true, force: true })
        }
    })

    test.each(["latest", "next", "beta", "canary", "release-2026"])("accepts npm tag %s without treating it as a semver range", (tag: string): void => {
        expect(isManagedScriptDependencySpec(tag)).toBe(true)
        expect(satisfiesManagedScriptRange("1.2.3", tag)).toBe(false)
    })

    test.each(["1.2", "01.2.3", "1.2.3-01", "not-a-version", "9007199254740992.0.0"])("does not silently satisfy invalid installed version %s", (version: string): void => {
        expect(satisfiesManagedScriptRange(version, "*")).toBe(false)
    })

    test("records natural npm completion diagnostics", async (): Promise<void> => {
        const workspacePath = await createTemporaryRoot("managed-script-completion-")
        const commandResult: ManagedScriptProjectCommandResult = { exitCode: 0, stdout: "completed output", stderr: "completed warning" }
        const spawn = mock<ManagedScriptProjectSpawn>(async (_command, _args, options): Promise<ManagedScriptProjectCommandResult> => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd)
            return commandResult
        })
        try {
            const result = expectSuccess(await createProject(workspacePath, spawn).setup({ dependencies: { installed: "^1.0.0" } }))
            if (!result.npm) throw new Error("Expected npm diagnostics")
            const log = await readFile(result.npm.logPath, "utf8")
            const options = spawn.mock.calls[0]?.[2] as { cwd?: string, env?: NodeJS.ProcessEnv } | undefined

            expect(result.npm).toMatchObject({ command: npmInstallArgs, exitCode: 0, stdout: "completed output", stderr: "completed warning" })
            expect(result.npm.logPath).toStartWith(result.paths.logsRoot)
            expect(options?.cwd).toBe(result.paths.scriptsRoot)
            expect(options?.env).toEqual({ PATH: "/managed/bin" })
            expect(options?.env?.NODE_PATH).toBeUndefined()
            expect(log).toBe("command: npm install --ignore-scripts --no-audit --no-fund\nexit_code: 0\n\nstdout:\ncompleted output\n\nstderr:\ncompleted warning\n")
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    }, process.platform === "win32" ? 35_000 : 5_000)

    test.each([false, true])("restores only metadata after npm network failure; damaged prior tree: %s", async (damagePriorTree: boolean): Promise<void> => {
        const workspacePath = await createTemporaryRoot("managed-script-rollback-")
        const paths = createManagedScriptProjectPaths(workspacePath, "job")
        const scriptsRoot = paths.scriptsRoot
        const originalManifest = '{"private":true,"dependencies":{"old":"^1.0.0"}}\n'
        const originalLock = '{"lockfileVersion":3,"old":true}\n'
        let failNpm = true
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }): Promise<ManagedScriptProjectCommandResult> => {
            if (options?.cwd) {
                await writeNpmArtifacts(options.cwd, { old: "1.0.0", next: "1.0.0" })
                if (failNpm && damagePriorTree) await rm(join(options.cwd, "node_modules", "old"), { recursive: true })
            }
            return failNpm ? { exitCode: 1, stdout: "npm stdout", stderr: "npm ERR! code ENETUNREACH\nnpm ERR! network request failed" } : npmInstallSuccess
        })
        try {
            await mkdir(join(scriptsRoot, "node_modules", "old"), { recursive: true })
            await writeFile(join(scriptsRoot, "package.json"), originalManifest)
            await writeFile(join(scriptsRoot, "package-lock.json"), originalLock)
            await writeFile(join(scriptsRoot, "node_modules", "old", "package.json"), '{"name":"old","version":"1.0.0"}\n')
            const markerPath = join(paths.nodeModulesPath, ".keep-existing-tree")
            await writeFile(markerPath, "existing tree\n")
            const fileSystem = createFileSystem()
            const mutations = {
                mkdir: mock(fileSystem.mkdir),
                rename: mock(fileSystem.rename),
                rm: mock(fileSystem.rm),
                writeFile: mock(fileSystem.writeFile),
            }
            const project = createProject(workspacePath, spawn, { fileSystem: { ...fileSystem, ...mutations } })
            const result = await project.setup({ dependencies: { next: "^1.0.0" } })
            if (result.ok || !result.npm) throw new Error("Expected npm failure")
            const log = await readFile(result.npm.logPath, "utf8")

            expect(result).toMatchObject({ ok: false, error: { code: "install_incomplete" } })
            expect(await readFile(join(scriptsRoot, "package.json"), "utf8")).toBe(originalManifest)
            expect(await readFile(join(scriptsRoot, "package-lock.json"), "utf8")).toBe(originalLock)
            expect(await exists(join(scriptsRoot, "node_modules", "old", "package.json"))).toBe(!damagePriorTree)
            expect(await exists(join(scriptsRoot, "node_modules", "next", "package.json"))).toBe(true)
            expect(await readFile(markerPath, "utf8")).toBe("existing tree\n")
            expect(await exists(paths.journalPath)).toBe(true)
            await expectReleasedInstallerLock(fileSystem, paths.lockPath)
            expect(log).toContain("ENETUNREACH")
            expect(log).toContain("network request failed")
            expect(result.npm).toMatchObject({ exitCode: 1, stdout: "npm stdout", stderr: "npm ERR! code ENETUNREACH\nnpm ERR! network request failed" })
            for (const mutation of Object.values(mutations)) mutation.mockClear()
            const journal = damagePriorTree ? await readFile(paths.journalPath, "utf8") : undefined
            const recoveryJournal = await readFile(paths.journalPath, "utf8")
            expect(await project.verify()).toEqual({ ok: false, error: { code: "install_interrupted", message: expect.stringContaining("autocode_script_install") } })
            expect(await readFile(paths.journalPath, "utf8")).toBe(recoveryJournal)
            for (const mutation of Object.values(mutations)) expect(mutation).not.toHaveBeenCalled()
            expect(spawn).toHaveBeenCalledTimes(1)
            if (damagePriorTree) {
                if (journal === undefined) throw new Error("Expected prior journal for damaged dependency tree")
                expect(await readFile(paths.journalPath, "utf8")).toBe(journal)
            }
            expectSuccess(await project.setup())
            expect(spawn).toHaveBeenCalledTimes(1)
            expect(await readFile(paths.journalPath, "utf8")).toBe(recoveryJournal)
            failNpm = false
            const repaired = expectSuccess(await project.install())
            expect(repaired.npm).toMatchObject({ exitCode: 0 })
            expect(repaired.dependencies).toMatchObject([{ name: "old", requestedRange: "^1.0.0", status: "satisfied", version: "1.0.0" }])
            expect(await exists(paths.journalPath)).toBe(false)
            expect(await exists(join(paths.nodeModulesPath, "old", "package.json"))).toBe(true)
            expect(await readFile(markerPath, "utf8")).toBe("existing tree\n")
            expect(await project.verify()).toEqual({ ok: true })
            expect(spawn).toHaveBeenCalledTimes(2)
            await expectReleasedInstallerLock(fileSystem, paths.lockPath)
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("requires Node 20 and npm only for needed dependency installation", async (): Promise<void> => {
        const workspacePath = await createTemporaryRoot("managed-script-runtime-")
        const spawn = mock(async (): Promise<ManagedScriptProjectCommandResult> => npmInstallSuccess)
        try {
            const oldNodeProbe = mock(async (): Promise<ManagedScriptProjectCommandResult> => ({ exitCode: 0, stdout: "v18.19.0", stderr: "" }))
            const npmProbe = mock(async (): Promise<ManagedScriptProjectCommandResult> => ({ exitCode: 127, stdout: "", stderr: "not found" }))
            const oldNode = createProject(workspacePath, spawn, { runtime: { env: {}, nodeVersion: oldNodeProbe, npmVersion: npmProbe } })
            const missingNpm = createProject(workspacePath, spawn, { runtime: { env: {}, nodeVersion: async (): Promise<ManagedScriptProjectCommandResult> => ({ exitCode: 0, stdout: "v20.0.0", stderr: "" }), npmVersion: npmProbe } })
            const setup = expectSuccess(await oldNode.setup())
            expect(setup.npm).toBeUndefined()
            expect(expectSuccess(await oldNode.install()).npm).toBeUndefined()
            expect(await oldNode.verify()).toEqual({ ok: true })
            expect(oldNodeProbe).not.toHaveBeenCalled()
            expect(npmProbe).not.toHaveBeenCalled()
            const manifest = await readFile(setup.paths.manifestPath, "utf8")
            expect(await oldNode.install({ dependencies: { needed: "^1.0.0" } })).toMatchObject({ ok: false, blocker: { code: "runtime_unavailable", message: expect.stringContaining("Node.js 20 or newer") } })
            expect(npmProbe).not.toHaveBeenCalled()
            expect(await missingNpm.setup({ dependencies: { needed: "^1.0.0" } })).toMatchObject({ ok: false, blocker: { code: "runtime_unavailable", message: expect.stringContaining("npm is required") } })
            expect(await readFile(setup.paths.manifestPath, "utf8")).toBe(manifest)
            expect(await exists(setup.paths.lockfilePath)).toBe(false)
            expect(await exists(setup.paths.journalPath)).toBe(false)
            expect(await exists(setup.paths.nodeModulesPath)).toBe(false)
            expect(spawn).not.toHaveBeenCalled()
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })
})
