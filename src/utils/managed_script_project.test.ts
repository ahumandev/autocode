import { describe, expect, mock, test } from "bun:test"
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createManagedScriptProject, type ManagedScriptProjectCommandResult, type ManagedScriptProjectDependencies, type ManagedScriptProjectFileSystem, type ManagedScriptProjectResult, type ManagedScriptProjectSpawn } from "./managed_script_project"

const npmInstallSuccess: ManagedScriptProjectCommandResult = { exitCode: 0, stdout: "installed\n", stderr: "" }

function createFileSystem(): ManagedScriptProjectFileSystem {
    return {
        mkdir: async (directory, options) => await mkdir(directory, options),
        readFile: async (filePath, encoding) => await readFile(filePath, encoding),
        lstat: async (filePath) => await lstat(filePath),
        readdir: async (directory, options) => options?.withFileTypes
            ? await readdir(directory, { withFileTypes: true })
            : await readdir(directory),
        rename: async (oldPath, newPath) => await rename(oldPath, newPath),
        rm: async (filePath, options) => await rm(filePath, options),
        stat: async (filePath) => await stat(filePath),
        writeFile: async (filePath, content) => await writeFile(filePath, content),
    }
}

async function exists(filePath: string): Promise<boolean> {
    try {
        await stat(filePath)
        return true
    }
    catch {
        return false
    }
}

async function writeNpmArtifacts(cwd: string, versions: Record<string, string> = {}): Promise<void> {
    const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as { dependencies?: Record<string, string> }
    let lock: Record<string, unknown> = {}
    try {
        lock = JSON.parse(await readFile(join(cwd, "package-lock.json"), "utf8")) as Record<string, unknown>
    }
    catch {
    }
    const packages = typeof lock.packages === "object" && lock.packages !== null ? lock.packages as Record<string, Record<string, unknown>> : {}
    const rootPackage = packages[""] ?? {}
    const dependencies = manifest.dependencies ?? {}
    await writeFile(join(cwd, "package-lock.json"), `${JSON.stringify({
        ...lock,
        lockfileVersion: lock.lockfileVersion ?? 3,
        packages: { ...packages, "": { ...rootPackage, dependencies: { ...(rootPackage.dependencies as Record<string, string> | undefined), ...dependencies } }, },
    }, undefined, 2)}\n`)
    await mkdir(join(cwd, "node_modules"), { recursive: true })
    for (const [name, range] of Object.entries(dependencies)) {
        const packagePath = join(cwd, "node_modules", ...name.split("/"))
        const version = versions[name] ?? (range.includes("2") ? "2.0.0" : "1.0.0")
        await mkdir(packagePath, { recursive: true })
        await writeFile(join(packagePath, "package.json"), `${JSON.stringify({ name, version })}\n`)
    }
}

function createProject(workspacePath: string, spawn: ManagedScriptProjectDependencies["spawn"], overrides: Partial<ManagedScriptProjectDependencies> = {}) {
    return createManagedScriptProject({
        context: { sessionID: "session-1", directory: workspacePath, worktree: workspacePath },
        fileSystem: createFileSystem(),
        spawn,
        runtime: {
            env: { PATH: "/managed/bin" },
            nodeVersion: async () => ({ exitCode: 0, stdout: "v20.11.1\n", stderr: "" }),
            npmVersion: async () => ({ exitCode: 0, stdout: "10.2.0\n", stderr: "" }),
        },
        resolveOwner: async () => ({ ok: true, owner: { jobName: "job", workspacePath } }),
        ...overrides,
    })
}

function expectSuccess(result: ManagedScriptProjectResult): Extract<ManagedScriptProjectResult, { ok: true }> {
    if (!result.ok) throw new Error(`Expected success: ${JSON.stringify(result)}`)
    return result
}

describe("managed script project", () => {
    test("creates durable job-owned layout and preserves existing project content across reconcile entrypoints", async () => {
        const workspacePath = await mkdtemp(join(tmpdir(), "managed-script-project-"))
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }) => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd)
            return npmInstallSuccess
        })
        try {
            const project = createProject(workspacePath, spawn)
            const setup = expectSuccess(await project.setup())
            await writeFile(join(setup.paths.sourceRoot, "keep.ts"), "export const keep = true\n")
            await writeFile(setup.paths.manifestPath, `${JSON.stringify({ name: "trusted-scripts", private: true, scripts: { check: "node src/keep.ts" }, dependencies: { keep: "^1.0.0" } }, undefined, 2)}\n`)
            await writeFile(join(setup.paths.logsPath, "keep.log"), "keep log\n")
            await mkdir(setup.paths.servicesPath, { recursive: true })
            await writeFile(join(setup.paths.servicesPath, "keep.json"), "{\"keep\":true}\n")

            expectSuccess(await project.install())
            const reconciled = expectSuccess(await project.reconcile())
            const manifest = JSON.parse(await readFile(reconciled.paths.manifestPath, "utf8")) as Record<string, unknown>

            expect(reconciled.paths.scriptsRoot).toBe(join(workspacePath, "scripts"))
            expect(reconciled.paths.sourceRoot).toBe(join(workspacePath, "scripts", "src"))
            expect(await exists(reconciled.paths.sourceRoot)).toBe(true)
            expect(await exists(reconciled.paths.logsPath)).toBe(true)
            expect(await readFile(reconciled.paths.agentsPath, "utf8")).toContain("Keep script sources in `src`.")
            expect(await readFile(join(reconciled.paths.sourceRoot, "keep.ts"), "utf8")).toBe("export const keep = true\n")
            expect(await readFile(reconciled.paths.manifestPath, "utf8")).toContain('"check": "node src/keep.ts"')
            expect(await exists(reconciled.paths.lockPath)).toBe(true)
            expect(await readFile(join(reconciled.paths.logsPath, "keep.log"), "utf8")).toBe("keep log\n")
            expect(await exists(join(reconciled.paths.nodeModulesPath, "keep", "package.json"))).toBe(true)
            expect(await readFile(join(reconciled.paths.servicesPath, "keep.json"), "utf8")).toBe("{\"keep\":true}\n")
            expect(manifest).toMatchObject({ name: "trusted-scripts", private: true, scripts: { check: "node src/keep.ts" }, dependencies: { keep: "^1.0.0" } })
            expect(spawn).toHaveBeenCalledTimes(3)
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("writes initial managed guidance with authoring context, source index, and lifecycle rules", async () => {
        const workspacePath = await mkdtemp(join(tmpdir(), "managed-script-agents-initial-"))
        const sourceRoot = join(workspacePath, "scripts", "src")
        const originalDirectory = join(workspacePath, "original-directory")
        const originalWorktree = join(workspacePath, "original-worktree")
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }) => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd)
            return npmInstallSuccess
        })
        try {
            await mkdir(join(sourceRoot, "nested"), { recursive: true })
            await writeFile(join(sourceRoot, "zeta.ts"), "export {}\n")
            await writeFile(join(sourceRoot, "alpha.ts"), "export {}\n")
            await writeFile(join(sourceRoot, "nested", "beta.ts"), "export {}\n")
            await writeFile(join(workspacePath, "outside.ts"), "export {}\n")
            await symlink(join(workspacePath, "outside.ts"), join(sourceRoot, "linked.ts"))
            await symlink(join(sourceRoot, "nested"), join(sourceRoot, "linked-directory"))
            const result = expectSuccess(await createProject(workspacePath, spawn, {
                context: { sessionID: "session-1", directory: originalDirectory, worktree: originalWorktree },
            }).setup())
            const agents = await readFile(result.paths.agentsPath, "utf8")

            expect(agents).toContain(`- Original authoring directory: \`${originalDirectory}\``)
            expect(agents).toContain(`- Original authoring worktree: \`${originalWorktree}\``)
            for (const root of [result.paths.workspacePath, result.paths.scriptsRoot, result.paths.sourceRoot, result.paths.manifestPath, result.paths.lockPath, result.paths.nodeModulesPath, result.paths.logsPath, result.paths.servicesPath, result.paths.agentsPath]) {
                expect(root).toStartWith("/")
                expect(agents).toContain(`\`${root}\``)
            }
            expect(agents.indexOf("- `alpha.ts`")).toBeLessThan(agents.indexOf("- `nested/beta.ts`"))
            expect(agents.indexOf("- `nested/beta.ts`")).toBeLessThan(agents.indexOf("- `zeta.ts`"))
            expect(agents).not.toContain("linked.ts")
            expect(agents).not.toContain("linked-directory")
            expect(agents).toContain("Inspect and reuse existing source files before editing. Use built-in `read`, `write`, `edit`, `glob`, and `grep` tools under returned `src` root.")
            expect(agents).toContain("`autocode_script_project`")
            expect(agents).toContain("`autocode_script_install`")
            expect(agents).toContain("`autocode_script_run`")
            expect(agents).toContain("`autocode_script_service`")
            expect(agents).toContain("Use `autocode_script_project` to set up or reuse this project.")
            expect(agents).toContain("After `package.json` or dependency-manifest edits, use `autocode_script_install`.")
            expect(agents).toContain("Use `autocode_script_run` for finite work.")
            expect(agents).toContain("Use `autocode_script_service` with `start`, `status`, or `stop` for long-lived work; retain and use its `run_id`.")
            expect(agents).toContain("Owned services stop automatically on abort, terminal session events, and disposal; explicitly stop services when no longer needed.")
            expect(agents).toContain("Never edit `node_modules` or `package-lock.json` manually.")
            expect(agents).toContain("Never use direct shell, PTY, sandbox CLI, or generic process kill tools.")
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("refreshes valid managed blocks without replacing custom CRLF text or original authoring context", async () => {
        const workspacePath = await mkdtemp(join(tmpdir(), "managed-script-agents-refresh-"))
        const oldDirectory = join(workspacePath, "old-directory")
        const oldWorktree = join(workspacePath, "old-worktree")
        const newDirectory = join(workspacePath, "new-directory")
        const newWorktree = join(workspacePath, "new-worktree")
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }) => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd)
            return npmInstallSuccess
        })
        try {
            const initial = expectSuccess(await createProject(workspacePath, spawn, {
                context: { sessionID: "session-1", directory: oldDirectory, worktree: oldWorktree },
            }).setup())
            const initialBlock = (await readFile(initial.paths.agentsPath, "utf8")).replaceAll("\n", "\r\n")
            await writeFile(initial.paths.agentsPath, `Team rules stay.\r\n\r\n${initialBlock}\r\n\r\nCustom footer stays.\r\n`)
            await writeFile(join(initial.paths.sourceRoot, "refreshed.ts"), "export {}\n")
            const refreshed = expectSuccess(await createProject(workspacePath, spawn, {
                context: { sessionID: "session-1", directory: newDirectory, worktree: newWorktree },
            }).reconcile())
            const agents = await readFile(refreshed.paths.agentsPath, "utf8")

            expect(agents).toStartWith("Team rules stay.\r\n\r\n")
            expect(agents).toEndWith("\r\n\r\nCustom footer stays.\r\n")
            expect(agents.replace(/\r\n/g, "")).not.toContain("\n")
            expect(agents).toContain(`- Original authoring directory: \`${oldDirectory}\``)
            expect(agents).toContain(`- Original authoring worktree: \`${oldWorktree}\``)
            expect(agents).not.toContain(newDirectory)
            expect(agents).toContain("- `refreshed.ts`")
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("migrates exact legacy guidance and preserves malformed custom guidance", async () => {
        const legacyWorkspacePath = await mkdtemp(join(tmpdir(), "managed-script-agents-legacy-"))
        const customWorkspacePath = await mkdtemp(join(tmpdir(), "managed-script-agents-custom-"))
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }) => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd)
            return npmInstallSuccess
        })
        const legacyGuidance = "# Managed scripts\n\nKeep script sources in `src/`. Use npm for dependencies; do not edit `node_modules` or `package-lock.json`.\n"
        const malformedGuidance = "Custom guidance stays.\n<!-- AUTOCODE:MANAGED-SCRIPTS:START -->\nUnclosed marker stays.\n"
        try {
            await mkdir(join(legacyWorkspacePath, "scripts"), { recursive: true })
            await writeFile(join(legacyWorkspacePath, "scripts", "AGENTS.md"), legacyGuidance)
            const legacy = expectSuccess(await createProject(legacyWorkspacePath, spawn).setup())
            const migrated = await readFile(legacy.paths.agentsPath, "utf8")

            expect(migrated).toStartWith("<!-- AUTOCODE:MANAGED-SCRIPTS:START -->")
            expect(migrated).not.toContain("Use npm for dependencies; do not edit")

            await mkdir(join(customWorkspacePath, "scripts"), { recursive: true })
            await writeFile(join(customWorkspacePath, "scripts", "AGENTS.md"), malformedGuidance)
            const custom = expectSuccess(await createProject(customWorkspacePath, spawn).setup())
            const preserved = await readFile(custom.paths.agentsPath, "utf8")

            expect(preserved).toContain(malformedGuidance)
            expect(preserved.match(/<!-- AUTOCODE:MANAGED-SCRIPTS:START -->/g)).toHaveLength(2)
            expect(preserved.match(/<!-- AUTOCODE:MANAGED-SCRIPTS:END -->/g)).toHaveLength(1)
        }
        finally {
            await rm(legacyWorkspacePath, { recursive: true, force: true })
            await rm(customWorkspacePath, { recursive: true, force: true })
        }
    })

    test("lists None for empty or missing source roots", async () => {
        const emptyWorkspacePath = await mkdtemp(join(tmpdir(), "managed-script-agents-empty-"))
        const missingWorkspacePath = await mkdtemp(join(tmpdir(), "managed-script-agents-missing-"))
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }) => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd)
            return npmInstallSuccess
        })
        try {
            const empty = expectSuccess(await createProject(emptyWorkspacePath, spawn).setup())
            const fileSystem = createFileSystem()
            const missingSourceRoot = join(missingWorkspacePath, "scripts", "src")
            fileSystem.lstat = async (filePath) => {
                if (filePath === missingSourceRoot) {
                    const error = new Error("source root missing") as NodeJS.ErrnoException
                    error.code = "ENOENT"
                    throw error
                }
                return await lstat(filePath)
            }
            const missing = expectSuccess(await createProject(missingWorkspacePath, spawn, { fileSystem }).setup())

            expect(await readFile(empty.paths.agentsPath, "utf8")).toContain("Regular files relative to `src`:\n- None.")
            expect(await readFile(missing.paths.agentsPath, "utf8")).toContain("Regular files relative to `src`:\n- None.")
        }
        finally {
            await rm(emptyWorkspacePath, { recursive: true, force: true })
            await rm(missingWorkspacePath, { recursive: true, force: true })
        }
    })

    test("blocks missing or throwing owners before filesystem mutation or npm", async () => {
        const workspacePath = await mkdtemp(join(tmpdir(), "managed-script-owner-"))
        const spawn = mock(async () => npmInstallSuccess)
        try {
            const missing = createProject(workspacePath, spawn, { resolveOwner: async () => ({ ok: false, reason: "No job workspace." }) })
            const ambiguous = createProject(workspacePath, spawn, { resolveOwner: async () => ({ ok: false, reason: "Ambiguous job workspaces." }) })
            const throwing = createProject(workspacePath, spawn, { resolveOwner: async () => { throw new Error("owner lookup failed") } })
            const missingResult = await missing.setup()
            const ambiguousResult = await ambiguous.reconcile()
            const throwingResult = await throwing.install()

            expect(missingResult).toMatchObject({ ok: false, blocker: { code: "job_workspace_required", message: "No job workspace." } })
            expect(ambiguousResult).toMatchObject({ ok: false, blocker: { code: "job_workspace_required", message: "Ambiguous job workspaces." } })
            expect(throwingResult).toMatchObject({ ok: false, blocker: { code: "job_workspace_required" } })
            expect(await exists(join(workspacePath, "scripts"))).toBe(false)
            expect(spawn).not.toHaveBeenCalled()
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("lazily creates and reuses current execute_script session workspace", async () => {
        const storageRoot = await mkdtemp(join(tmpdir(), "managed-script-fresh-session-"))
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }) => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd)
            return npmInstallSuccess
        })
        try {
            const project = createManagedScriptProject({
                context: { sessionID: "child-session", directory: storageRoot, worktree: storageRoot, agent: "execute_script" },
                client: { session: { get: async () => ({ data: { title: "Fresh script task" } }) } } as never,
                fileSystem: createFileSystem(),
                spawn,
                runtime: {
                    env: { PATH: "/managed/bin" },
                    nodeVersion: async () => ({ exitCode: 0, stdout: "v20.11.1\n", stderr: "" }),
                    npmVersion: async () => ({ exitCode: 0, stdout: "10.2.0\n", stderr: "" }),
                },
            })

            const setup = expectSuccess(await project.setup())
            const reused = expectSuccess(await project.setup())
            const workspaceName = setup.paths.workspacePath.split("/").pop()

            expect(workspaceName).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_fresh_script_task$/)
            expect(setup.paths.workspacePath).toBe(reused.paths.workspacePath)
            expect(await readFile(join(setup.paths.workspacePath, "session.yml"), "utf8")).toBe("session_id: child-session\n")
            expect(await readdir(join(storageRoot, ".agents", "jobs"))).toHaveLength(1)
            expect(await exists(setup.paths.sourceRoot)).toBe(true)
        }
        finally {
            await rm(storageRoot, { recursive: true, force: true })
        }
    })

    test("keeps non-execute_script sessions blocked without creating a workspace", async () => {
        const storageRoot = await mkdtemp(join(tmpdir(), "managed-script-foreign-session-"))
        try {
            const result = await createManagedScriptProject({
                context: { sessionID: "session-1", directory: storageRoot, worktree: storageRoot, agent: "assist" },
                client: { session: { get: async () => ({ data: { title: "Foreign task" } }) } } as never,
                fileSystem: createFileSystem(),
            }).setup()

            expect(result).toMatchObject({ ok: false, blocker: { code: "job_workspace_required", message: "No timestamped job workspace was found for the current session." } })
            expect(await exists(join(storageRoot, ".agents"))).toBe(false)
        }
        finally {
            await rm(storageRoot, { recursive: true, force: true })
        }
    })

    test("removes newly created workspace when execute_script creation fails", async () => {
        const storageRoot = await mkdtemp(join(tmpdir(), "managed-script-create-failure-"))
        const fileSystem = createFileSystem()
        const write = fileSystem.writeFile
        fileSystem.writeFile = async (filePath, content) => {
            if (filePath.includes("session.yml.autocode-tmp-")) throw new Error("session write denied")
            await write(filePath, content)
        }
        try {
            const result = await createManagedScriptProject({
                context: { sessionID: "session-1", directory: storageRoot, worktree: storageRoot, agent: "execute_script" },
                client: { session: { get: async () => ({ data: { title: "Creation failure" } }) } } as never,
                fileSystem,
            }).setup()

            expect(result).toMatchObject({ ok: false, blocker: { code: "job_workspace_required" } })
            expect(await readdir(join(storageRoot, ".agents", "jobs"))).toEqual([])
        }
        finally {
            await rm(storageRoot, { recursive: true, force: true })
        }
    })

    test("rejects blank or invalid execute_script titles before creating a workspace", async () => {
        const storageRoot = await mkdtemp(join(tmpdir(), "managed-script-blank-title-"))
        try {
            for (const title of ["   ", "***"]) {
                const result = await createManagedScriptProject({
                    context: { sessionID: "session-1", directory: storageRoot, worktree: storageRoot, agent: "execute_script" },
                    client: { session: { get: async () => ({ data: { title } }) } } as never,
                    fileSystem: createFileSystem(),
                }).setup()

                expect(result).toMatchObject({ ok: false, blocker: { code: "job_workspace_required" } })
            }
            expect(await exists(join(storageRoot, ".agents"))).toBe(false)
        }
        finally {
            await rm(storageRoot, { recursive: true, force: true })
        }
    })

    test("reports invalid dependencies and manifests as blockers before npm", async () => {
        const workspacePath = await mkdtemp(join(tmpdir(), "managed-script-blockers-"))
        const spawn = mock(async () => npmInstallSuccess)
        try {
            const project = createProject(workspacePath, spawn)
            const invalidDependency = await project.setup({ dependencies: { "bad/package/name": "1.0.0" } })
            await mkdir(join(workspacePath, "scripts"), { recursive: true })
            await writeFile(join(workspacePath, "scripts", "package.json"), "[]\n")
            const invalidManifest = await project.setup()

            expect(invalidDependency).toMatchObject({ ok: false, blocker: { code: "invalid_dependency" } })
            expect(invalidManifest).toMatchObject({ ok: false, blocker: { code: "invalid_manifest" } })
            expect(spawn).not.toHaveBeenCalled()
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("accepts registry semver versions, ranges, and tags but rejects non-registry dependency specs before npm", async () => {
        const workspacePath = await mkdtemp(join(tmpdir(), "managed-script-dependency-specs-"))
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }) => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd, { exact: "1.2.3", ranged: "1.5.0", tagged: "3.0.0" })
            return npmInstallSuccess
        })
        try {
            const project = createProject(workspacePath, spawn)
            const accepted = await project.setup({ dependencies: { exact: "1.2.3", ranged: ">=1.0.0 <2.0.0", tagged: "latest" } })

            expect(accepted.ok).toBe(true)
            expect(spawn).toHaveBeenCalledTimes(1)

            for (const spec of ["file:../package", "link:../package", "../package", "/tmp/package", "C:\\package", "https://registry.example/package.tgz", "git+https://github.com/acme/package.git", "github:acme/package", "../package.tgz"]) {
                const rejected = await project.setup({ dependencies: { rejected: spec } })

                expect(rejected).toMatchObject({ ok: false, blocker: { code: "invalid_dependency" } })
            }
            expect(spawn).toHaveBeenCalledTimes(1)
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("returns filesystem and dependency verification failures from injected dependencies", async () => {
        const workspacePath = await mkdtemp(join(tmpdir(), "managed-script-errors-"))
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }) => {
            if (options?.cwd) {
                await writeNpmArtifacts(options.cwd, { absent: "1.0.0" })
                await rm(join(options.cwd, "node_modules", "absent"), { recursive: true, force: true })
            }
            return npmInstallSuccess
        })
        try {
            const unsatisfied = await createProject(workspacePath, spawn).setup({ dependencies: { absent: "^1.0.0" } })
            const fileSystem = createFileSystem()
            const filesystemFailure = await createProject(workspacePath, spawn, {
                fileSystem: { ...fileSystem, mkdir: async () => { throw new Error("mkdir denied") } },
            }).setup()

            expect(unsatisfied).toMatchObject({ ok: false, error: { code: "dependency_unsatisfied" }, npm: { exitCode: 0 } })
            expect(filesystemFailure).toMatchObject({ ok: false, error: { code: "filesystem_error" } })
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("resolves inherited dependencies from deterministic sourceRoot origin", async () => {
        const workspacePath = await mkdtemp(join(tmpdir(), "managed-script-inherited-"))
        const packagePath = join(workspacePath, "node_modules", "ancestor-package")
        const sourceRoot = join(workspacePath, "scripts", "src")
        const resolutionCalls: string[] = []
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }) => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd)
            return npmInstallSuccess
        })
        try {
            const project = createProject(workspacePath, spawn, {
                resolvePackage: async (_name, fromFile) => {
                    resolutionCalls.push(fromFile)
                    return fromFile === join(sourceRoot, "__autocode_resolution__.cjs")
                        ? { packagePath, version: "2.1.0", workspacePath }
                        : undefined
                },
            })
            const result = expectSuccess(await project.setup({ dependencies: { "ancestor-package": "2.1.0" } }))

            expect(result.dependencies).toEqual([{ name: "ancestor-package", requestedRange: "2.1.0", source: "inherited", version: "2.1.0", packagePath, workspacePath }])
            expect(resolutionCalls).toEqual([join(sourceRoot, "__autocode_resolution__.cjs")])
            expect(await exists(join(result.paths.nodeModulesPath, "ancestor-package"))).toBe(false)
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("installs local packages when compatible-looking ancestors lack valid package metadata", async () => {
        const workspacePath = await mkdtemp(join(tmpdir(), "managed-script-malformed-inherited-"))
        const scriptsRoot = join(workspacePath, "scripts")
        const missingPackage = "managed-script-missing-metadata"
        const malformedPackage = "managed-script-malformed-metadata"
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }) => {
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
            const result = expectSuccess(await createProject(workspacePath, spawn).reconcile({ dependencies: { [missingPackage]: "^2.0.0", [malformedPackage]: "^2.0.0" } }))
            const manifest = JSON.parse(await readFile(join(scriptsRoot, "package.json"), "utf8")) as { dependencies: Record<string, string>, autocode?: { inheritedDependencies?: Record<string, unknown> } }

            expect(result.dependencies).toEqual([
                { name: missingPackage, requestedRange: "^2.0.0", source: "local", version: "2.0.0", packagePath: join(scriptsRoot, "node_modules", missingPackage) },
                { name: malformedPackage, requestedRange: "^2.0.0", source: "local", version: "2.0.0", packagePath: join(scriptsRoot, "node_modules", malformedPackage) },
            ])
            expect(manifest.dependencies).toEqual({ [missingPackage]: "^2.0.0", [malformedPackage]: "^2.0.0" })
            expect(manifest.autocode?.inheritedDependencies ?? {}).toEqual({})
            expect(spawn).toHaveBeenCalledTimes(1)
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("falls back to a local install when no root or ancestor package resolves", async () => {
        const workspacePath = await mkdtemp(join(tmpdir(), "managed-script-no-package-"))
        const packageName = "managed-script-unresolvable-package"
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }) => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd)
            return npmInstallSuccess
        })
        try {
            const result = expectSuccess(await createProject(workspacePath, spawn).setup({ dependencies: { [packageName]: "^1.0.0" } }))

            expect(result.dependencies).toEqual([{ name: packageName, requestedRange: "^1.0.0", source: "local", version: "1.0.0", packagePath: join(workspacePath, "scripts", "node_modules", packageName) }])
            expect(await exists(join(workspacePath, "scripts", "node_modules", packageName, "package.json"))).toBe(true)
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("resolves exported ESM ancestor packages without NODE_PATH or a local package", async () => {
        const rootPath = await mkdtemp(join(tmpdir(), "managed-script-esm-ancestor-"))
        const workspacePath = join(rootPath, "job")
        const packageName = "managed-script-esm-ancestor"
        const packagePath = join(rootPath, "node_modules", packageName)
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }) => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd)
            return npmInstallSuccess
        })
        try {
            await mkdir(packagePath, { recursive: true })
            await writeFile(join(packagePath, "package.json"), `${JSON.stringify({ name: packageName, version: "2.1.0", type: "module", exports: { ".": "./index.js" } })}\n`)
            await writeFile(join(packagePath, "index.js"), "export {}\n")
            const result = expectSuccess(await createProject(workspacePath, spawn).setup({ dependencies: { [packageName]: "^2.0.0" } }))
            const options = spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined

            expect(result.dependencies).toEqual([{ name: packageName, requestedRange: "^2.0.0", source: "inherited", version: "2.1.0", packagePath, workspacePath: rootPath }])
            expect(await exists(join(result.paths.nodeModulesPath, packageName))).toBe(false)
            expect(options?.env?.NODE_PATH).toBeUndefined()
        }
        finally {
            await rm(rootPath, { recursive: true, force: true })
        }
    })

    test("uses local packages for incompatible, locally owned, removed, and drifted real ancestors", async () => {
        const rootPath = await mkdtemp(join(tmpdir(), "managed-script-real-fallback-"))
        const workspacePath = join(rootPath, "job")
        const scriptsRoot = join(workspacePath, "scripts")
        const packagePath = (name: string): string => join(rootPath, "node_modules", name)
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }) => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd, {
                "managed-script-incompatible": "2.0.0",
                "managed-script-local-wins": "2.0.0",
                "managed-script-removed": "2.0.0",
                "managed-script-drifted": "2.0.0",
            })
            return npmInstallSuccess
        })
        try {
            for (const [name, version] of [["managed-script-incompatible", "1.0.0"], ["managed-script-local-wins", "2.0.0"], ["managed-script-removed", "2.0.0"], ["managed-script-drifted", "2.0.0"]]) {
                await mkdir(packagePath(name), { recursive: true })
                await writeFile(join(packagePath(name), "package.json"), `${JSON.stringify({ name, version })}\n`)
                await writeFile(join(packagePath(name), "index.js"), "module.exports = {}\n")
            }
            await mkdir(join(scriptsRoot, "node_modules", "managed-script-local-wins"), { recursive: true })
            await writeFile(join(scriptsRoot, "package.json"), `${JSON.stringify({ private: true, dependencies: { "managed-script-local-wins": "2.0.0" } })}\n`)
            await writeFile(join(scriptsRoot, "node_modules", "managed-script-local-wins", "package.json"), '{"name":"managed-script-local-wins","version":"2.0.0"}\n')
            const project = createProject(workspacePath, spawn)
            const initial = expectSuccess(await project.setup({ dependencies: {
                "managed-script-incompatible": "^2.0.0",
                "managed-script-local-wins": "2.0.0",
                "managed-script-removed": "^2.0.0",
                "managed-script-drifted": "^2.0.0",
            } }))

            expect(initial.dependencies.find((dependency) => dependency.name === "managed-script-incompatible")?.source).toBe("local")
            expect(initial.dependencies.find((dependency) => dependency.name === "managed-script-local-wins")?.source).toBe("local")
            expect(initial.dependencies.filter((dependency) => dependency.source === "inherited").map((dependency) => dependency.name)).toEqual(["managed-script-removed", "managed-script-drifted"])

            await rm(packagePath("managed-script-removed"), { recursive: true, force: true })
            await writeFile(join(packagePath("managed-script-drifted"), "package.json"), '{"name":"managed-script-drifted","version":"1.0.0"}\n')
            const reconciled = expectSuccess(await project.install())

            expect(reconciled.dependencies).toEqual([
                { name: "managed-script-removed", requestedRange: "^2.0.0", source: "local", version: "2.0.0", packagePath: join(scriptsRoot, "node_modules", "managed-script-removed") },
                { name: "managed-script-drifted", requestedRange: "^2.0.0", source: "local", version: "2.0.0", packagePath: join(scriptsRoot, "node_modules", "managed-script-drifted") },
            ])
        }
        finally {
            await rm(rootPath, { recursive: true, force: true })
        }
    })

    test("keeps unrelated manifest and lock ownership when injected npm installs local packages", async () => {
        const workspacePath = await mkdtemp(join(tmpdir(), "managed-script-lock-owner-"))
        const scriptsRoot = join(workspacePath, "scripts")
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }) => {
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

            expect(result.dependencies).toEqual([{ name: "installed", requestedRange: "^2.0.0", source: "local", version: "2.0.0", packagePath: join(scriptsRoot, "node_modules", "installed") }])
            expect(manifest.dependencies).toEqual({ unrelated: "^1.0.0", installed: "^2.0.0" })
            expect(lock).toMatchObject({ lockfileVersion: 3, custom_lock_owner: "local", packages: { "": { owner: "local", dependencies: { unrelated: "^1.0.0", installed: "^2.0.0" } }, "node_modules/unrelated": { version: "1.0.0", integrity: "keep" } } })
            expect(await readFile(join(scriptsRoot, "node_modules", "installed", "package.json"), "utf8")).toContain('"version":"2.0.0"')
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("uses local packages when inherited packages mismatch, disappear, drift, or are already local", async () => {
        const workspacePath = await mkdtemp(join(tmpdir(), "managed-script-local-"))
        const scriptsRoot = join(workspacePath, "scripts")
        const resolverCalls: string[] = []
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }) => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd, { shadow: "2.0.0", drift: "1.0.0", missing: "1.0.0", incompatible: "2.0.0" })
            return npmInstallSuccess
        })
        try {
            await mkdir(scriptsRoot, { recursive: true })
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
                resolvePackage: async (name) => {
                    resolverCalls.push(name)
                    if (name === "drift") return { packagePath: join(workspacePath, "node_modules", "drift"), version: "2.0.0", workspacePath }
                    if (name === "incompatible") return { packagePath: join(workspacePath, "node_modules", "incompatible"), version: "1.0.0", workspacePath }
                    return undefined
                },
            })
            const result = expectSuccess(await project.reconcile({ dependencies: { shadow: "^2.0.0", incompatible: "^2.0.0" } }))
            const manifest = JSON.parse(await readFile(join(scriptsRoot, "package.json"), "utf8")) as { dependencies: Record<string, string>, autocode: { inheritedDependencies: Record<string, unknown> } }

            expect(result.dependencies.map((dependency) => [dependency.name, dependency.source])).toEqual([
                ["drift", "local"], ["missing", "local"], ["incompatible", "local"], ["shadow", "local"],
            ])
            expect(resolverCalls).not.toContain("shadow")
            expect(manifest.dependencies).toMatchObject({ shadow: "^2.0.0", drift: "^1.0.0", missing: "^1.0.0", incompatible: "^2.0.0" })
            expect(manifest.autocode.inheritedDependencies).toEqual({})
            expect(await exists(join(scriptsRoot, "node_modules", "incompatible", "package.json"))).toBe(true)
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("reconciles dependency maps after manifest edits while retaining unrelated local ownership", async () => {
        const workspacePath = await mkdtemp(join(tmpdir(), "managed-script-reconcile-"))
        const scriptsRoot = join(workspacePath, "scripts")
        let inheritedAvailable = true
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }) => {
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
                autocode: { inheritedDependencies: { inherited: { version: "1.0.0", packagePath: "/old/inherited", workspacePath, requestedRange: "^1.0.0" } } },
            }, undefined, 2)}\n`)
            await writeFile(join(scriptsRoot, "package-lock.json"), `${JSON.stringify({ lockfileVersion: 3, custom_lock_owner: "local", packages: { "": { owner: "local", dependencies: { unrelated: "^1.0.0" } } } }, undefined, 2)}\n`)
            const project = createProject(workspacePath, spawn, {
                resolvePackage: async (name) => inheritedAvailable && name === "inherited"
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
            expectSuccess(await project.install())
            const finalManifest = JSON.parse(await readFile(join(scriptsRoot, "package.json"), "utf8")) as { dependencies: Record<string, string>, autocode: { inheritedDependencies: Record<string, unknown> } }
            const lock = JSON.parse(await readFile(join(scriptsRoot, "package-lock.json"), "utf8")) as { custom_lock_owner: string, packages: Record<string, { owner: string, dependencies: Record<string, string> }> }

            expect(finalManifest.dependencies).toMatchObject({ unrelated: "^1.0.0", added: "^1.0.0", edited: "^1.0.0", inherited: "^2.0.0" })
            expect(finalManifest.autocode.inheritedDependencies).toEqual({})
            expect(lock.custom_lock_owner).toBe("local")
            expect(lock.packages[""]).toMatchObject({ owner: "local", dependencies: { unrelated: "^1.0.0" } })
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("records natural npm completion diagnostics", async () => {
        const workspacePath = await mkdtemp(join(tmpdir(), "managed-script-completion-"))
        const commandResult: ManagedScriptProjectCommandResult = { exitCode: 0, stdout: "completed output", stderr: "completed warning" }
        const spawn = mock<ManagedScriptProjectSpawn>(async (_command, _args, options) => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd)
            return commandResult
        })
        try {
            const result = expectSuccess(await createProject(workspacePath, spawn).setup())
            const log = await readFile(result.npm.logPath, "utf8")
            const options = spawn.mock.calls[0]?.[2] as { cwd?: string, env?: NodeJS.ProcessEnv } | undefined

            expect(result.npm).toMatchObject({ command: ["install", "--ignore-scripts", "--no-audit", "--no-fund"], exitCode: 0, stdout: "completed output", stderr: "completed warning" })
            expect(result.npm.logPath).toStartWith(result.paths.logsPath)
            expect(options?.cwd).toBe(result.paths.scriptsRoot)
            expect(options?.env?.NODE_PATH).toBeUndefined()
            expect(log).toBe("command: npm install --ignore-scripts --no-audit --no-fund\nexit_code: 0\n\nstdout:\ncompleted output\n\nstderr:\ncompleted warning\n")
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("rolls back and records network npm failures", async () => {
        const workspacePath = await mkdtemp(join(tmpdir(), "managed-script-rollback-"))
        const scriptsRoot = join(workspacePath, "scripts")
        const originalManifest = '{"private":true,"dependencies":{"old":"^1.0.0"}}\n'
        const originalLock = '{"lockfileVersion":3,"old":true}\n'
        const spawn = mock(async (_command: string, _args: readonly string[], options?: { cwd?: string }) => {
            if (options?.cwd) await writeNpmArtifacts(options.cwd, { next: "1.0.0" })
            return { exitCode: 1, stdout: "npm stdout", stderr: "npm ERR! code ENETUNREACH\nnpm ERR! network request failed" }
        })
        try {
            await mkdir(join(scriptsRoot, "node_modules", "old"), { recursive: true })
            await writeFile(join(scriptsRoot, "package.json"), originalManifest)
            await writeFile(join(scriptsRoot, "package-lock.json"), originalLock)
            await writeFile(join(scriptsRoot, "node_modules", "old", "package.json"), '{"name":"old","version":"1.0.0"}\n')
            const result = await createProject(workspacePath, spawn).setup({ dependencies: { next: "^1.0.0" } })
            if (result.ok || !result.npm) throw new Error("Expected npm failure")
            const log = await readFile(result.npm.logPath, "utf8")

            expect(result).toMatchObject({ ok: false, error: { code: "npm_install_failed" } })
            expect(await readFile(join(scriptsRoot, "package.json"), "utf8")).toBe(originalManifest)
            expect(await readFile(join(scriptsRoot, "package-lock.json"), "utf8")).toBe(originalLock)
            expect(await exists(join(scriptsRoot, "node_modules", "old", "package.json"))).toBe(true)
            expect(await exists(join(scriptsRoot, "node_modules", "next", "package.json"))).toBe(false)
            expect(log).toContain("ENETUNREACH")
            expect(log).toContain("network request failed")
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })

    test("blocks Node below 20 and missing npm before project creation", async () => {
        const workspacePath = await mkdtemp(join(tmpdir(), "managed-script-runtime-"))
        const spawn = mock(async () => npmInstallSuccess)
        try {
            const oldNode = createProject(workspacePath, spawn, { runtime: { env: {}, nodeVersion: async () => ({ exitCode: 0, stdout: "v18.19.0", stderr: "" }) } })
            const missingNpm = createProject(workspacePath, spawn, { runtime: { env: {}, nodeVersion: async () => ({ exitCode: 0, stdout: "v20.0.0", stderr: "" }), npmVersion: async () => ({ exitCode: 127, stdout: "", stderr: "not found" }) } })

            expect(await oldNode.setup()).toMatchObject({ ok: false, blocker: { code: "runtime_unavailable", message: "Node.js 20 or newer is required for managed scripts." } })
            expect(await missingNpm.setup()).toMatchObject({ ok: false, blocker: { code: "runtime_unavailable", message: "npm is required for managed scripts." } })
            expect(await exists(join(workspacePath, "scripts"))).toBe(false)
            expect(spawn).not.toHaveBeenCalled()
        }
        finally {
            await rm(workspacePath, { recursive: true, force: true })
        }
    })
})
