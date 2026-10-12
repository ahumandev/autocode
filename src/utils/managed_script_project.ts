import { spawn as spawnChild } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readdirSync, type Dirent } from "node:fs"
import { link, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { hostname } from "node:os"
import path from "node:path"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { createWorkspaceTimestamp, deriveJobNameFromTitle, getCurrentSessionTitle, isCompatibleJobName, isMissingFile, type JobToolFileSystem, type SessionJobContext } from "./jobs"
import { acquireInstallerLock, inspectInstallerLock, type InstallerLockConfig, type InstallerLockOwner } from "./managed_script_install_lock"
import { cleanSessionTitleSuffix } from "./session_title"
import { flattenError } from "./tools"

export type ManagedScriptProjectCommandResult = {
    exitCode: number | null
    stdout: string
    stderr: string
}

export type ManagedScriptProjectSpawn = (
    command: string,
    args: readonly string[],
    options?: { cwd?: string, env?: NodeJS.ProcessEnv },
) => Promise<ManagedScriptProjectCommandResult>

export type ManagedScriptProjectFileStats = {
    isDirectory: () => boolean
    isFile: () => boolean
    isSymbolicLink: () => boolean
}

export type ManagedScriptProjectFileSystem = Pick<JobToolFileSystem, "mkdir" | "readFile" | "readdir" | "rename" | "rm" | "stat"> & {
    link: typeof link
    writeFile: (filePath: string, content: string, options?: { encoding?: "utf8", flag?: string }) => Promise<void>
    lstat?: (filePath: string) => Promise<ManagedScriptProjectFileStats>
}

export type ManagedScriptProjectRuntime = {
    env: NodeJS.ProcessEnv
    nodeVersion?: () => Promise<ManagedScriptProjectCommandResult>
    npmVersion?: () => Promise<ManagedScriptProjectCommandResult>
}

export type ManagedScriptProjectOwner = {
    jobName: string
    directory: string
}

export type ManagedScriptProjectOwnerResolution =
    | { ok: true, owner: ManagedScriptProjectOwner }
    | { ok: false, reason: string, jobName?: string }

export type ManagedScriptProjectResolvedPackage = {
    packagePath: string
    version: string
    workspacePath: string
}

export type ManagedScriptProjectDependencies = {
    context: SessionJobContext & { agent?: string }
    client?: OpencodeClient
    fileSystem?: ManagedScriptProjectFileSystem
    spawn?: ManagedScriptProjectSpawn
    platform?: NodeJS.Platform
    runtime?: Partial<ManagedScriptProjectRuntime>
    resolveOwner?: () => Promise<ManagedScriptProjectOwnerResolution>
    resolvePackage?: (packageName: string, fromFile: string) => Promise<ManagedScriptProjectResolvedPackage | undefined>
    installerLock?: InstallerLockConfig
}

export type ManagedScriptProjectPaths = {
    directory: string
    jobName: string
    scriptsRoot: string
    sourceRoot: string
    manifestPath: string
    lockfilePath: string
    metaRoot: string
    logsRoot: string
    servicesRoot: string
    lockPath: string
    journalPath: string
    nodeModulesPath: string
    agentsPath: string
}

export type ManagedScriptProjectDependency = {
    name: string
    requestedRange: string
    status: "satisfied" | "missing" | "incompatible"
    source?: "inherited" | "local"
    version?: string
    packagePath?: string
    workspacePath?: string
}

export type ManagedScriptProjectNpmResult = ManagedScriptProjectCommandResult & {
    command: readonly string[]
    logPath: string
}

export type ManagedScriptProjectBlocker = {
    code: "job_workspace_required" | "runtime_unavailable" | "invalid_dependency" | "invalid_manifest" | "project_not_initialized" | "upgrade_required"
    message: string
}

export type ManagedScriptProjectFailure = {
    code: "filesystem_error" | "package_resolution_error" | "npm_install_failed" | "dependency_missing" | "dependency_incompatible" | "install_interrupted" | "install_incomplete" | "install_lock_timeout"
    message: string
}

export type ManagedScriptProjectResult =
    | {
        ok: true
        paths: ManagedScriptProjectPaths
        dependencies: ManagedScriptProjectDependency[]
        npm?: ManagedScriptProjectNpmResult
    }
    | {
        ok: false
        paths?: ManagedScriptProjectPaths
        dependencies?: ManagedScriptProjectDependency[]
        npm?: ManagedScriptProjectNpmResult
        blocker?: ManagedScriptProjectBlocker
        error?: ManagedScriptProjectFailure
    }

export type ManagedScriptProjectSetupInput = {
    dependencies?: Record<string, string>
}

export type ManagedScriptProjectInstallInput = ManagedScriptProjectSetupInput & {
    upgrade?: boolean
}

export type ManagedScriptProjectVerifyResult =
    | { ok: true }
    | {
        ok: false
        paths?: ManagedScriptProjectPaths
        dependencies?: ManagedScriptProjectDependency[]
        blocker?: ManagedScriptProjectBlocker
        error?: ManagedScriptProjectFailure
    }

export type ManagedScriptProject = {
    setup: (input?: ManagedScriptProjectSetupInput) => Promise<ManagedScriptProjectResult>
    install: (input?: ManagedScriptProjectInstallInput) => Promise<ManagedScriptProjectResult>
    verify: () => Promise<ManagedScriptProjectVerifyResult>
}

type JsonRecord = Record<string, unknown>

type InheritedDependency = {
    version: string
    packagePath: string
    workspacePath: string
    requestedRange: string
}

type RegistryTagBinding = {
    requestedRange: string
    version: string
}

type ManagedManifest = {
    value: JsonRecord
    dependencies: Record<string, string>
    inheritedDependencies: Record<string, InheritedDependency>
    registryTagBindings: Record<string, RegistryTagBinding>
}

type ManifestSnapshot = {
    manifest: string
    lockfile: string | null
}

type SharedProjectPaths = Omit<ManagedScriptProjectPaths, "jobName" | "sourceRoot">

type InstalledPackage = {
    source: "local" | "inherited"
    packagePath: string
    workspacePath?: string
    version?: string
}

type ProjectEnvironment = {
    dependencies: ManagedScriptProjectDependencies
    fileSystem: ManagedScriptProjectFileSystem
    spawn: ManagedScriptProjectSpawn
    platform: NodeJS.Platform
    runtime: ManagedScriptProjectRuntime
    now: () => number
}

type InstallJournal = {
    schema: typeof installJournalSchema
    version: typeof installJournalVersion
    pid: number
    host: string
    token: string
    startedAt: number
    requests: Record<string, string>
    upgrade: boolean
    prior: ManifestSnapshot
    plannedManifest?: string
}

const npmInstallArgs = ["install", "--ignore-scripts", "--no-audit", "--no-fund"] as const
const repairGuidance = "Call autocode_script_install with no dependencies to repair."
const pendingInstallGuidance = `Managed dependency installation has a pending recovery journal. ${repairGuidance}`
const installJournalSchema = "autocode-script-install"
const installJournalVersion = 1
const sourceTimestampPattern = /^\d{2}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/
const sourceTimestampLength = 17
const sourceDirectoryNames = new Map<string, string>()

async function defaultSpawn(command: string, args: readonly string[], options?: { cwd?: string, env?: NodeJS.ProcessEnv }): Promise<ManagedScriptProjectCommandResult> {
    return await new Promise<ManagedScriptProjectCommandResult>((resolve): void => {
        let settled = false
        const stdout: Buffer[] = []
        const stderr: Buffer[] = []
        const child = spawnChild(command, [...args], { cwd: options?.cwd, env: options?.env })
        const finish = (result: ManagedScriptProjectCommandResult): void => {
            if (settled) return
            settled = true
            resolve(result)
        }

        child.stdout?.on("data", (chunk: Buffer): void => {
            stdout.push(chunk)
        })
        child.stderr?.on("data", (chunk: Buffer): void => {
            stderr.push(chunk)
        })
        child.on("error", (error: Error): void => finish({ exitCode: null, stdout: Buffer.concat(stdout).toString("utf8"), stderr: `${Buffer.concat(stderr).toString("utf8")}${error.message}` }))
        child.on("close", (exitCode: number | null): void => finish({
            exitCode,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
        }))
    })
}

async function defaultReadDirectory(dirPath: string, options?: { withFileTypes?: boolean }): Promise<string[] | import("node:fs").Dirent[]> {
    return options?.withFileTypes ? await readdir(dirPath, { withFileTypes: true }) : await readdir(dirPath)
}

const defaultFileSystem: ManagedScriptProjectFileSystem = { link, lstat, mkdir, readFile, readdir: defaultReadDirectory, rename, rm, stat, writeFile }

function createSharedProjectPaths(directory: string): SharedProjectPaths {
    if (typeof directory !== "string" || !directory.trim()) throw new Error("Managed script project directory must not be empty.")
    const scriptsRoot = path.join(directory, ".opencode", "autocode", "scripts")
    const metaRoot = path.join(scriptsRoot, ".meta")
    return {
        directory,
        scriptsRoot,
        manifestPath: path.join(scriptsRoot, "package.json"),
        lockfilePath: path.join(scriptsRoot, "package-lock.json"),
        nodeModulesPath: path.join(scriptsRoot, "node_modules"),
        metaRoot,
        logsRoot: path.join(metaRoot, "logs"),
        servicesRoot: path.join(metaRoot, "services"),
        lockPath: path.join(metaRoot, "install.lock"),
        journalPath: path.join(metaRoot, "install-journal.json"),
        agentsPath: path.join(scriptsRoot, "AGENTS.md"),
    }
}

function validateJobName(jobName: string): string | undefined {
    if (typeof jobName !== "string" || !isCompatibleJobName(jobName)) return "Current session title must produce a compatible job name containing lowercase letters, numbers, and underscores. Rename the session before calling autocode_script_project."
    if (jobName === "node_modules") return "Current session title produces reserved job name node_modules. Rename the session before calling autocode_script_project."
    return undefined
}

function isManagedScriptSourceDirectoryName(directoryName: string, jobName: string): boolean {
    if (directoryName.charAt(sourceTimestampLength) !== "_" || directoryName.slice(sourceTimestampLength + 1) !== jobName) return false
    const timestamp = directoryName.slice(0, sourceTimestampLength)
    if (!sourceTimestampPattern.test(timestamp)) return false
    const date = new Date(`20${timestamp.slice(0, 8)}T${timestamp.slice(9).replace(/-/g, ":")}Z`)
    return Number.isFinite(date.getTime()) && createWorkspaceTimestamp((): Date => date).slice(2) === timestamp
}

function findManagedScriptSourceDirectoryName(scriptsRoot: string, jobName: string): string | undefined {
    try {
        // Keep synchronous path-only and lifecycle callers on the same directory resolver.
        return readdirSync(scriptsRoot, { withFileTypes: true })
            .filter((entry: Dirent): boolean => entry.isDirectory() && isManagedScriptSourceDirectoryName(entry.name, jobName))
            .map((entry: Dirent): string => entry.name)
            .sort()
            .at(-1)
    }
    catch (error) {
        if (isMissingFile(error)) return undefined
        throw error
    }
}

export function createManagedScriptProjectPaths(directory: string, jobName: string, now: () => Date = (): Date => new Date()): ManagedScriptProjectPaths {
    const error = validateJobName(jobName)
    if (error) throw new Error(error)
    const paths = createSharedProjectPaths(directory)
    const key = path.resolve(paths.scriptsRoot, jobName)
    let directoryName = sourceDirectoryNames.get(key)
    if (directoryName === undefined) {
        directoryName = findManagedScriptSourceDirectoryName(paths.scriptsRoot, jobName) ?? `${createWorkspaceTimestamp(now).slice(2)}_${jobName}`
        // Pin the name before mkdir so all tools and missing-source recreation keep the same path.
        sourceDirectoryNames.set(key, directoryName)
    }
    return { ...paths, jobName, sourceRoot: path.join(paths.scriptsRoot, directoryName) }
}

export async function resolveManagedScriptProjectOwner(dependencies: Pick<ManagedScriptProjectDependencies, "client" | "context" | "fileSystem">): Promise<ManagedScriptProjectOwnerResolution> {
    try {
        const current = await getCurrentSessionTitle(dependencies.client, { sessionID: dependencies.context.sessionID, directory: dependencies.context.directory })
        if (!current.title) return { ok: false, reason: current.warning ?? "Current session title is required." }
        const jobName = deriveJobNameFromTitle(cleanSessionTitleSuffix(current.title))
        if (!jobName) return { ok: false, reason: "Current session title must contain letters or numbers." }
        const error = validateJobName(jobName)
        if (error) return { ok: false, reason: error, jobName }
        return { ok: true, owner: { jobName, directory: dependencies.context.directory } }
    }
    catch (error) {
        return { ok: false, reason: `Unable to resolve current managed script job: ${flattenError(error)}` }
    }
}

async function readOptionalFile(fileSystem: Pick<ManagedScriptProjectFileSystem, "readFile">, filePath: string): Promise<string | undefined> {
    try {
        return await fileSystem.readFile(filePath, "utf8")
    }
    catch (error) {
        if (isMissingFile(error)) return undefined
        throw error
    }
}

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPlainRecord(value: unknown): value is JsonRecord {
    return isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function emptyMap<T>(): Record<string, T> {
    return Object.create(null) as Record<string, T>
}

function ownValue<T>(record: Record<string, T>, name: string): T | undefined {
    return Object.hasOwn(record, name) ? record[name] : undefined
}

function readStringMap(value: unknown): Record<string, string> {
    if (value === undefined) return emptyMap<string>()
    if (!isRecord(value)) throw new Error("Dependency map must be an object.")
    return Object.entries(value).reduce<Record<string, string>>((result: Record<string, string>, [name, version]: [string, unknown]): Record<string, string> => {
        if (typeof version !== "string") throw new Error(`Dependency ${name} must have a string requested version range.`)
        result[name] = version
        return result
    }, emptyMap<string>())
}

function readInheritedDependencies(value: unknown): Record<string, InheritedDependency> {
    if (value === undefined) return emptyMap<InheritedDependency>()
    if (!isRecord(value)) throw new Error("Inherited dependencies must be an object.")
    return Object.entries(value).reduce<Record<string, InheritedDependency>>((result: Record<string, InheritedDependency>, [name, candidate]: [string, unknown]): Record<string, InheritedDependency> => {
        if (!isRecord(candidate) || typeof candidate.version !== "string" || typeof candidate.packagePath !== "string" || typeof candidate.workspacePath !== "string" || typeof candidate.requestedRange !== "string") throw new Error(`Inherited dependency ${name} metadata is invalid.`)
        result[name] = {
            version: candidate.version,
            packagePath: candidate.packagePath,
            workspacePath: candidate.workspacePath,
            requestedRange: candidate.requestedRange,
        }
        return result
    }, emptyMap<InheritedDependency>())
}

function readRegistryTagBindings(value: unknown): Record<string, RegistryTagBinding> {
    if (value === undefined) return emptyMap<RegistryTagBinding>()
    if (!isRecord(value)) throw new Error("Registry tag bindings must be an object.")
    return Object.entries(value).reduce<Record<string, RegistryTagBinding>>((result: Record<string, RegistryTagBinding>, [name, candidate]: [string, unknown]): Record<string, RegistryTagBinding> => {
        if (!isValidPackageName(name) || !isRecord(candidate) || typeof candidate.requestedRange !== "string" || !isNpmTag(candidate.requestedRange) || typeof candidate.version !== "string" || !parseManagedScriptVersion(candidate.version)) throw new Error(`Registry tag binding ${name} metadata is invalid.`)
        result[name] = { ...candidate, requestedRange: candidate.requestedRange, version: candidate.version }
        return result
    }, emptyMap<RegistryTagBinding>())
}

function parseManifest(content: string): ManagedManifest {
    const value: unknown = JSON.parse(content)
    if (!isRecord(value)) throw new Error("scripts/package.json must contain a JSON object.")
    if (value.dependencies !== undefined && !isRecord(value.dependencies)) throw new Error("scripts/package.json dependencies must be an object.")
    const dependencies = readStringMap(value.dependencies)
    const dependencyError = validateDependencies(dependencies)
    if (dependencyError) throw new Error(`scripts/package.json ${dependencyError}`)
    const autocode = value.autocode
    if (autocode !== undefined && !isRecord(autocode)) throw new Error("scripts/package.json autocode metadata must be an object.")
    if (autocode?.inheritedDependencies !== undefined && !isRecord(autocode.inheritedDependencies)) throw new Error("scripts/package.json autocode.inheritedDependencies must be an object.")
    const inheritedDependencies = readInheritedDependencies(autocode?.inheritedDependencies)
    const inheritedRequests = Object.entries(inheritedDependencies).reduce<Record<string, string>>((result: Record<string, string>, [name, dependency]: [string, InheritedDependency]): Record<string, string> => {
        result[name] = dependency.requestedRange
        return result
    }, emptyMap<string>())
    const inheritedDependencyError = validateDependencies(inheritedRequests)
    if (inheritedDependencyError) throw new Error(`scripts/package.json autocode.inheritedDependencies ${inheritedDependencyError}`)
    const registryTagBindings = readRegistryTagBindings(autocode?.registryTagBindings)
    return { value, dependencies, inheritedDependencies, registryTagBindings }
}

function writeManifest(manifest: ManagedManifest): string {
    const value: JsonRecord = { ...manifest.value }
    if (Object.keys(manifest.dependencies).length > 0 || manifest.value.dependencies !== undefined) value.dependencies = manifest.dependencies
    else delete value.dependencies
    const autocode: JsonRecord = isRecord(manifest.value.autocode) ? { ...manifest.value.autocode } : {}
    if (Object.keys(manifest.inheritedDependencies).length > 0 || autocode.inheritedDependencies !== undefined) autocode.inheritedDependencies = manifest.inheritedDependencies
    if (Object.keys(manifest.registryTagBindings).length > 0 || autocode.registryTagBindings !== undefined) autocode.registryTagBindings = manifest.registryTagBindings
    if (Object.keys(autocode).length > 0 || manifest.value.autocode !== undefined) value.autocode = autocode
    return `${JSON.stringify(value, undefined, 2)}\n`
}

function readPackageLock(content: string | undefined): { value: JsonRecord, packages: JsonRecord, dependencies: JsonRecord } | undefined {
    if (content === undefined) return undefined
    try {
        const value: unknown = JSON.parse(content)
        if (!isRecord(value) || (value.lockfileVersion !== 2 && value.lockfileVersion !== 3) || !isRecord(value.packages)) return undefined
        const root = ownValue(value.packages, "")
        if (!isRecord(root) || !isRecord(root.dependencies)) return undefined
        return { value, packages: value.packages, dependencies: root.dependencies }
    }
    catch {
        return undefined
    }
}

function matchingRegistryTagBinding(bindings: Record<string, RegistryTagBinding>, name: string, requestedRange: string): RegistryTagBinding | undefined {
    const binding = ownValue(bindings, name)
    return binding?.requestedRange === requestedRange.trim() ? binding : undefined
}

async function availableRegistryTagBindings(fileSystem: Pick<ManagedScriptProjectFileSystem, "readFile">, paths: SharedProjectPaths, manifest: ManagedManifest, lockfileContent?: string | null): Promise<Record<string, RegistryTagBinding>> {
    const bindings = Object.assign(emptyMap<RegistryTagBinding>(), manifest.registryTagBindings)
    const declarations = declaredRequests(manifest)
    if (!Object.entries(declarations).some(([name, range]: [string, string]): boolean => isNpmTag(range.trim()) && !matchingRegistryTagBinding(bindings, name, range))) return bindings
    const lock = readPackageLock(lockfileContent === undefined ? await readOptionalFile(fileSystem, paths.lockfilePath) : lockfileContent ?? undefined)
    if (!lock) return bindings
    for (const [name, range] of Object.entries(declarations)) {
        if (!isNpmTag(range.trim()) || matchingRegistryTagBinding(bindings, name, range) || ownValue(lock.dependencies, name) !== range) continue
        const installed = ownValue(lock.packages, `node_modules/${name}`)
        if (isRecord(installed) && installed.link !== true && typeof installed.version === "string" && parseManagedScriptVersion(installed.version)) bindings[name] = { requestedRange: range.trim(), version: installed.version }
    }
    return bindings
}

function isValidPackageName(name: string): boolean {
    return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)
}

function isManagedScriptRange(spec: string): boolean {
    return parseManagedScriptRange(spec) !== undefined
}

function isNpmTag(value: string): boolean {
    return /^[A-Za-z][A-Za-z0-9._-]*$/.test(value) && !/^[vV]?\d/.test(value) && !/^[xX*](?:\.|$)/.test(value) && !isManagedScriptRange(value)
}

export function isManagedScriptDependencySpec(spec: string): boolean {
    spec = spec.trim()
    if (spec.includes("/") || spec.includes("\\") || /^(?:[A-Za-z][A-Za-z0-9+.-]*:|git@)/.test(spec)) return false
    if (/^(?:\.{1,2}|~)(?:$|[\\/])/.test(spec) || /\.(?:tgz|tar(?:\.[A-Za-z0-9]+)?|zip)$/i.test(spec)) return false
    return isManagedScriptRange(spec) || isNpmTag(spec)
}

function validateDependencies(dependencies: Record<string, string>): string | undefined {
    for (const [name, range] of Object.entries(dependencies)) {
        if (!isValidPackageName(name)) return `Invalid npm package name: ${name}.`
        if (!range.trim()) return `Dependency ${name} must have a non-empty requested version range.`
        if (!isManagedScriptDependencySpec(range)) return `Dependency ${name} must use an npm registry semver version, range, or tag.`
    }
    return undefined
}

function findNodeModulesDirectory(packagePath: string): string | undefined {
    let current = path.dirname(packagePath)
    while (current !== path.dirname(current)) {
        if (path.basename(current) === "node_modules") return current
        current = path.dirname(current)
    }
    return undefined
}

async function findResolvedManifest(fileSystem: Pick<ManagedScriptProjectFileSystem, "readFile">, packageName: string, entryPath: string): Promise<{ packagePath: string, version: string, workspacePath: string } | undefined> {
    let current = path.dirname(entryPath)
    while (current !== path.dirname(current)) {
        const manifestPath = path.join(current, "package.json")
        const content = await readOptionalFile(fileSystem, manifestPath)
        if (content !== undefined) {
            try {
                const manifest: unknown = JSON.parse(content)
                if (isRecord(manifest) && manifest.name === packageName && typeof manifest.version === "string") {
                    const nodeModulesPath = findNodeModulesDirectory(current)
                    if (!nodeModulesPath) return undefined
                    return { packagePath: current, version: manifest.version, workspacePath: path.dirname(nodeModulesPath) }
                }
            }
            catch {
                return undefined
            }
        }
        current = path.dirname(current)
    }
    return undefined
}

async function defaultResolvePackage(fileSystem: Pick<ManagedScriptProjectFileSystem, "readFile">, packageName: string, fromFile: string): Promise<ManagedScriptProjectResolvedPackage | undefined> {
    let entryPath: string
    try {
        entryPath = createRequire(fromFile).resolve(packageName)
    }
    catch {
        return undefined
    }
    const resolved = await findResolvedManifest(fileSystem, packageName, entryPath)
    return resolved === undefined ? undefined : resolved
}

function ancestorDirectories(filePath: string): string[] {
    const directories: string[] = []
    let current = path.dirname(filePath)
    while (true) {
        directories.push(current)
        const parent = path.dirname(current)
        if (parent === current) return directories
        current = parent
    }
}

async function readInstalledPackage(fileSystem: Pick<ManagedScriptProjectFileSystem, "readFile" | "lstat" | "stat">, packagePath: string, packageName: string, source: "local" | "inherited", workspacePath?: string): Promise<InstalledPackage | undefined> {
    const installed: InstalledPackage = { source, packagePath, ...(workspacePath ? { workspacePath } : {}) }
    let content: string
    try {
        content = await fileSystem.readFile(path.join(packagePath, "package.json"), "utf8")
    }
    catch (error) {
        // ENOTDIR can mean the package root is a file that still shadows ancestor packages.
        if (!isMissingFile(error) && (!isRecord(error) || error.code !== "ENOTDIR")) throw error
        try {
            if (fileSystem.lstat) await fileSystem.lstat(packagePath)
            else await fileSystem.stat(packagePath)
        }
        catch (rootError) {
            if (isMissingFile(error) && isMissingFile(rootError)) return undefined
            throw rootError
        }
        return installed
    }
    try {
        const value: unknown = JSON.parse(content)
        if (!isRecord(value) || value.name !== packageName || typeof value.version !== "string") return installed
        return { ...installed, version: value.version }
    }
    catch {
        return installed
    }
}

// port of node-semver v7 non-loose, includePrerelease=false
type ManagedScriptVersion = { major: number, minor: number, patch: number, prerelease: string[] }
type ManagedScriptPartialVersion = { major?: number, minor?: number, patch?: number, prerelease: string }
type ManagedScriptComparatorOperator = "<" | "<=" | ">" | ">=" | "="
const managedScriptAny = Symbol("ANY")
type ManagedScriptComparator = { operator: ManagedScriptComparatorOperator, version: ManagedScriptVersion } | typeof managedScriptAny
type ComparatorSet = ManagedScriptComparator[]

const managedScriptMaxVersionLength = 256
const managedScriptNumericIdentifier = "(?:0|[1-9]\\d*)"
const managedScriptPrereleaseIdentifier = `(?:${managedScriptNumericIdentifier}|\\d*[A-Za-z-][0-9A-Za-z-]*)`
const managedScriptPrereleaseSource = `${managedScriptPrereleaseIdentifier}(?:\\.${managedScriptPrereleaseIdentifier})*`
const managedScriptBuildSource = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*"
const managedScriptFullSource = `v?(${managedScriptNumericIdentifier})\\.(${managedScriptNumericIdentifier})\\.(${managedScriptNumericIdentifier})(?:-(${managedScriptPrereleaseSource}))?(?:\\+(${managedScriptBuildSource}))?`
const managedScriptVersionPattern = new RegExp(`^${managedScriptFullSource}$`)
const managedScriptXIdentifier = `(?:${managedScriptNumericIdentifier}|x|X|\\*)`
const managedScriptXRangeSource = `[v=\\s]*(${managedScriptXIdentifier})(?:\\.(${managedScriptXIdentifier})(?:\\.(${managedScriptXIdentifier})(?:-(${managedScriptPrereleaseSource}))?(?:\\+(${managedScriptBuildSource}))?)?)?`
const managedScriptXRangePattern = new RegExp(`^${managedScriptXRangeSource}$`)
const managedScriptNullSet = "<0.0.0-0"

function parseManagedScriptVersion(value: string): ManagedScriptVersion | undefined {
    const trimmed = value.trim()
    if (trimmed.length > managedScriptMaxVersionLength) return undefined
    const match = managedScriptVersionPattern.exec(trimmed)
    if (!match) return undefined
    const major = Number(match[1])
    const minor = Number(match[2])
    const patch = Number(match[3])
    if (![major, minor, patch].every(Number.isSafeInteger)) return undefined
    return { major, minor, patch, prerelease: match[4]?.split(".") ?? [] }
}

function compareManagedScriptIdentifier(left: string, right: string): number {
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
        const leftNumber = Number(left)
        const rightNumber = Number(right)
        return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return left === right ? 0 : left < right ? -1 : 1
}

function compareManagedScriptVersions(left: ManagedScriptVersion, right: ManagedScriptVersion): number {
    for (const key of ["major", "minor", "patch"] as const) {
        if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
    }
    if (!left.prerelease.length && right.prerelease.length) return 1
    if (left.prerelease.length && !right.prerelease.length) return -1
    const sharedLength = Math.min(left.prerelease.length, right.prerelease.length)
    for (let index = 0; index < sharedLength; index++) {
        const comparison = compareManagedScriptIdentifier(left.prerelease[index], right.prerelease[index])
        if (comparison !== 0) return comparison
    }
    return Math.sign(left.prerelease.length - right.prerelease.length)
}

function parseManagedScriptPartialVersion(value: string): ManagedScriptPartialVersion | undefined {
    const match = managedScriptXRangePattern.exec(value)
    if (!match) return undefined
    let wildcard = false
    for (const component of match.slice(1, 4)) {
        if (component === undefined || /^[xX*]$/.test(component)) {
            wildcard = true
            continue
        }
        if (!Number.isSafeInteger(Number(component)) || wildcard) return undefined
    }
    const major = /^\d+$/.test(match[1]) ? Number(match[1]) : undefined
    const minor = major !== undefined && /^\d+$/.test(match[2] ?? "") ? Number(match[2]) : undefined
    const patch = minor !== undefined && /^\d+$/.test(match[3] ?? "") ? Number(match[3]) : undefined
    return { major, minor, patch, prerelease: match[4] ? `-${match[4]}` : "" }
}

function managedScriptPartialBase(version: ManagedScriptPartialVersion): string {
    const prerelease = version.patch !== undefined ? version.prerelease : ""
    return `${version.major}.${version.minor ?? 0}.${version.patch ?? 0}${prerelease}`
}

function managedScriptPartialUpper(version: ManagedScriptPartialVersion): string {
    if (version.minor === undefined) return `${Number(version.major) + 1}.0.0-0`
    return `${version.major}.${version.minor + 1}.0-0`
}

function expandManagedScriptHyphen(range: string): string {
    const match = /^(.*?)\s+-\s+(.*?)$/.exec(range)
    if (!match) return range
    const lower = parseManagedScriptPartialVersion(match[1])
    const upper = parseManagedScriptPartialVersion(match[2])
    if (!lower || !upper) return range
    const from = lower.major === undefined ? "" : `>=${lower.patch === undefined ? managedScriptPartialBase(lower) : match[1]}`
    const to = managedScriptHyphenUpper(upper, match[2])
    return `${from} ${to}`.trim()
}

function managedScriptHyphenUpper(version: ManagedScriptPartialVersion, raw: string): string {
    if (version.major === undefined) return ""
    if (version.patch === undefined) return `<${managedScriptPartialUpper(version)}`
    if (version.prerelease) return `<=${managedScriptPartialBase(version)}`
    return `<=${raw}`
}

function expandManagedScriptCaret(version: ManagedScriptPartialVersion): string {
    if (version.major === undefined) return ""
    let upper = `${version.major + 1}.0.0-0`
    if (version.major === 0 && version.minor !== undefined) {
        upper = version.minor === 0 && version.patch !== undefined
            ? `0.0.${version.patch + 1}-0`
            : `0.${version.minor + 1}.0-0`
    }
    return `>=${managedScriptPartialBase(version)} <${upper}`
}

function expandManagedScriptTilde(version: ManagedScriptPartialVersion): string {
    if (version.major === undefined) return ""
    return `>=${managedScriptPartialBase(version)} <${managedScriptPartialUpper(version)}`
}

function expandManagedScriptXComparator(operator: string, version: ManagedScriptPartialVersion): string {
    const major = Number(version.major)
    const minor = version.minor ?? 0
    if (operator === ">" || operator === "<=") {
        const upper = version.minor === undefined ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`
        return operator === ">" ? `>=${upper}` : `<${upper}-0`
    }
    return `${operator}${major}.${minor}.0${operator === "<" ? "-0" : ""}`
}

function expandManagedScriptXRange(token: string): string {
    const match = /^(>=|<=|>|<|=)?(.*)$/.exec(token)
    if (!match) return token
    const version = parseManagedScriptPartialVersion(match[2])
    if (!version) return token
    const operator = match[1] ?? ""
    if (version.major === undefined) return operator === ">" || operator === "<" ? managedScriptNullSet : ""
    if (version.patch !== undefined) return token
    if (operator && operator !== "=") return expandManagedScriptXComparator(operator, version)
    return `>=${managedScriptPartialBase(version)} <${managedScriptPartialUpper(version)}`
}

function expandManagedScriptToken(token: string): string {
    const match = /^(\^|~>?)(.*)$/.exec(token)
    if (match) {
        const version = parseManagedScriptPartialVersion(match[2])
        if (!version) return token
        return match[1] === "^" ? expandManagedScriptCaret(version) : expandManagedScriptTilde(version)
    }
    return expandManagedScriptXRange(token)
}

function parseManagedScriptComparator(value: string): ManagedScriptComparator | undefined {
    if (!value || value === ">=0.0.0") return managedScriptAny
    const match = /^(>=|<=|>|<|=)?(.*)$/.exec(value)
    if (!match) return undefined
    const version = parseManagedScriptVersion(match[2])
    if (!version) return undefined
    return { operator: (match[1] ?? "=") as ManagedScriptComparatorOperator, version }
}

function isManagedScriptNullComparator(comparator: ManagedScriptComparator): boolean {
    if (comparator === managedScriptAny || comparator.operator !== "<") return false
    const version = comparator.version
    return version.major === 0 && version.minor === 0 && version.patch === 0 && version.prerelease.join(".") === "0"
}

function parseManagedScriptComparatorSet(range: string): ComparatorSet | undefined {
    const expanded = expandManagedScriptHyphen(range).replace(/(>=|<=|>|<|=|~>|~|\^)\s+/g, "$1")
    const values = expanded.split(/\s+/).map(expandManagedScriptToken).join(" ").trim().split(/\s+/)
    const comparators: ComparatorSet = []
    for (const value of values) {
        const comparator = parseManagedScriptComparator(value)
        if (comparator === undefined) return undefined
        comparators.push(comparator)
    }
    const nullComparator = comparators.find(isManagedScriptNullComparator)
    if (nullComparator !== undefined) return [nullComparator]
    const nonAny = comparators.filter((comparator: ManagedScriptComparator): boolean => comparator !== managedScriptAny)
    return nonAny.length ? nonAny : [managedScriptAny]
}

function parseManagedScriptRange(range: string): ComparatorSet[] | undefined {
    const alternatives = range.trim().split(/\s*\|\|\s*/)
    const sets: ComparatorSet[] = []
    for (const alternative of alternatives) {
        if (!alternative.trim()) return undefined
        const set = parseManagedScriptComparatorSet(alternative.trim())
        if (!set) return undefined
        sets.push(set)
    }
    const anySet = sets.find((set: ComparatorSet): boolean => set.length === 1 && set[0] === managedScriptAny)
    return anySet ? [anySet] : sets
}

function testManagedScriptComparator(version: ManagedScriptVersion, comparator: ManagedScriptComparator): boolean {
    if (comparator === managedScriptAny) return true
    const comparison = compareManagedScriptVersions(version, comparator.version)
    if (comparator.operator === ">=") return comparison >= 0
    if (comparator.operator === "<=") return comparison <= 0
    if (comparator.operator === ">") return comparison > 0
    if (comparator.operator === "<") return comparison < 0
    return comparison === 0
}

function allowsManagedScriptPrerelease(version: ManagedScriptVersion, comparator: ManagedScriptComparator): boolean {
    if (comparator === managedScriptAny || !comparator.version.prerelease.length) return false
    const allowed = comparator.version
    return allowed.major === version.major && allowed.minor === version.minor && allowed.patch === version.patch
}

export function satisfiesManagedScriptRange(version: string, range: string): boolean {
    const parsed = parseManagedScriptVersion(version)
    if (!parsed) return false
    const sets = parseManagedScriptRange(range)
    if (!sets) return false
    return sets.some((set: ComparatorSet): boolean =>
        set.every((comparator: ManagedScriptComparator): boolean => testManagedScriptComparator(parsed, comparator))
        && (!parsed.prerelease.length || set.some((comparator: ManagedScriptComparator): boolean => allowsManagedScriptPrerelease(parsed, comparator))))
}

function satisfiesDependencySpec(installedVersion: string, spec: string, binding?: RegistryTagBinding): boolean {
    if (!isManagedScriptDependencySpec(spec)) return false
    const requested = spec.trim()
    if (isNpmTag(requested)) return binding?.requestedRange === requested && binding.version === installedVersion
    return satisfiesManagedScriptRange(installedVersion, requested)
}

function createManagedAgentsContent(lineBreak: string): string {
    return [
        "# Managed scripts",
        "",
        "- Jobs share npm environment: `.opencode/autocode/scripts/package.json`, `.opencode/autocode/scripts/node_modules`",
        "- `.opencode/autocode/scripts/.meta/` holds shared logs, service records, installer lock, recovery journal; never job sources.",
    ].join(lineBreak)
}

function getManagedAgentsLineBreak(content: string | undefined): string {
    return content?.includes("\r\n") ? "\r\n" : "\n"
}

const fileReplacementRetryDelaysMs = [10, 20, 40, 80] as const
const windowsFileReplacementRetryDelaysMs = [...fileReplacementRetryDelaysMs, 160, ...Array<number>(14).fill(320)] as const

function isRetryableFileReplacementError(error: unknown): boolean {
    const code = isRecord(error) ? error.code : undefined
    return code === "EPERM" || code === "EBUSY" || code === "EACCES"
}

async function sleepBeforeFileReplacementRetry(environment: ProjectEnvironment, milliseconds: number): Promise<void> {
    const sleep = environment.dependencies.installerLock?.sleep
    if (sleep) {
        await sleep(milliseconds)
        return
    }
    await new Promise<void>((resolve): void => {
        setTimeout(resolve, milliseconds)
    })
}

async function refreshManagedAgents(
    environment: ProjectEnvironment,
    paths: ManagedScriptProjectPaths,
): Promise<void> {
    const current = await readOptionalFile(environment.fileSystem, paths.agentsPath)
    const lineBreak = getManagedAgentsLineBreak(current)
    const content = createManagedAgentsContent(lineBreak)
    if (content === current) return
    try {
        // writeAtomically owns the retry budget and keeps the same temporary source across attempts.
        await writeAtomically(environment, paths.agentsPath, content)
    }
    catch (error) {
        if (!isRetryableFileReplacementError(error)) throw error
        const latest = await readOptionalFile(environment.fileSystem, paths.agentsPath)
        // Concurrent setups can finish the same guidance replacement despite a Windows rename failure.
        if (latest === content) return
        throw error
    }
}

function createTemporaryPath(environment: ProjectEnvironment, filePath: string): string {
    return `${filePath}.autocode-tmp-${environment.now()}-${randomUUID()}`
}

async function writeAtomically(environment: ProjectEnvironment, filePath: string, content: string): Promise<void> {
    const temporaryPath = createTemporaryPath(environment, filePath)
    const retryDelaysMs = environment.platform === "win32" ? windowsFileReplacementRetryDelaysMs : fileReplacementRetryDelaysMs
    try {
        await environment.fileSystem.writeFile(temporaryPath, content, { flag: "wx" })
        for (let attempt = 0; ; attempt++) {
            try {
                await environment.fileSystem.rename(temporaryPath, filePath)
                return
            }
            catch (error) {
                const delayMs = retryDelaysMs[attempt]
                if (!isRetryableFileReplacementError(error) || delayMs === undefined) throw error
                await sleepBeforeFileReplacementRetry(environment, delayMs)
            }
        }
    }
    finally {
        await environment.fileSystem.rm(temporaryPath, { force: true }).catch((): void => undefined)
    }
}

async function checkRuntime(spawn: ManagedScriptProjectSpawn, runtime: ManagedScriptProjectRuntime): Promise<ManagedScriptProjectBlocker | undefined> {
    const node = runtime.nodeVersion ? await runtime.nodeVersion() : await spawn("node", ["--version"], { env: runtime.env })
    const nodeMajor = /^v?(\d+)\./.exec(node.stdout.trim())?.[1]
    if (node.exitCode !== 0 || !nodeMajor || Number(nodeMajor) < 20) {
        return { code: "runtime_unavailable", message: "Node.js 20 or newer is required to install dependencies. Install Node.js 20+ and retry autocode_script_install." }
    }
    const npm = runtime.npmVersion ? await runtime.npmVersion() : await spawn("npm", ["--version"], { env: runtime.env })
    if (npm.exitCode !== 0 || !npm.stdout.trim()) return { code: "runtime_unavailable", message: "npm is required to install dependencies. Make npm available and retry autocode_script_install." }
    return undefined
}

function createNpmLogPath(environment: ProjectEnvironment, paths: ManagedScriptProjectPaths): string {
    return path.join(paths.logsRoot, `npm-${new Date(environment.now()).toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.log`)
}

async function writeNpmLog(fileSystem: Pick<ManagedScriptProjectFileSystem, "mkdir" | "writeFile">, logPath: string, command: readonly string[], result: ManagedScriptProjectCommandResult): Promise<void> {
    const content = [`command: npm ${command.join(" ")}`, `exit_code: ${result.exitCode}`, "", "stdout:", result.stdout, "", "stderr:", result.stderr, ""].join("\n")
    await fileSystem.mkdir(path.dirname(logPath), { recursive: true })
    await fileSystem.writeFile(logPath, content, { flag: "wx" })
}

async function resolveRegistryTag(environment: ProjectEnvironment, paths: ManagedScriptProjectPaths, name: string, tag: string): Promise<{ ok: true, binding: RegistryTagBinding } | Extract<ManagedScriptProjectResult, { ok: false }>> {
    const command = ["view", `${name}@${tag}`, "version", "--json", ...npmInstallArgs.slice(1)]
    const logPath = createNpmLogPath(environment, paths)
    let result: ManagedScriptProjectCommandResult
    try {
        result = await environment.spawn("npm", command, { cwd: paths.scriptsRoot, env: environment.runtime.env })
    }
    catch (error) {
        result = { exitCode: null, stdout: "", stderr: flattenError(error) }
    }
    const npm: ManagedScriptProjectNpmResult = { ...result, command, logPath }
    let version: string | undefined
    if (result.exitCode === 0) {
        try {
            const value: unknown = JSON.parse(result.stdout)
            if (typeof value === "string" && parseManagedScriptVersion(value)) version = value
        }
        catch {
            version = undefined
        }
    }
    let failure: ManagedScriptProjectFailure | undefined = version !== undefined ? undefined : {
        code: "npm_install_failed",
        message: result.exitCode === 0
            ? `npm view ${name}@${tag} did not return one concrete valid version. Inspect ${logPath} and retry autocode_script_install.`
            : `npm view ${name}@${tag} failed (exit code ${result.exitCode}): ${result.stderr.trim() || "no stderr output"}. Inspect ${logPath} and retry autocode_script_install.`,
    }
    try {
        await writeNpmLog(environment.fileSystem, logPath, command, result)
    }
    catch (error) {
        const message = `Unable to write npm registry query log ${logPath}: ${flattenError(error)}.`
        failure = failure ? { ...failure, message: `${failure.message} ${message}` } : { code: "filesystem_error", message }
    }
    if (failure || version === undefined) return { ok: false, paths, npm, error: failure ?? { code: "npm_install_failed", message: `Unable to resolve registry tag ${name}@${tag}. Retry autocode_script_install.` } }
    return { ok: true, binding: { requestedRange: tag, version } }
}

function writePinnedManifest(manifest: ManagedManifest, bindings: Record<string, RegistryTagBinding>): string {
    const dependencies = Object.assign(emptyMap<string>(), manifest.dependencies)
    // Pin omitted local tags too, so npm cannot refresh an unrelated bound contract.
    for (const [name, range] of Object.entries(dependencies)) {
        if (!isNpmTag(range.trim())) continue
        const binding = matchingRegistryTagBinding(bindings, name, range)
        if (!binding) throw new Error(`Registry tag ${name}@${range} has no concrete binding.`)
        dependencies[name] = binding.version
    }
    return writeManifest({ ...manifest, dependencies })
}

async function synchronizeRegistryTagLock(environment: ProjectEnvironment, paths: ManagedScriptProjectPaths, manifest: ManagedManifest, bindings: Record<string, RegistryTagBinding>): Promise<void> {
    if (!Object.values(manifest.dependencies).some((range: string): boolean => isNpmTag(range.trim()))) return
    const lock = readPackageLock(await readOptionalFile(environment.fileSystem, paths.lockfilePath))
    if (!lock) return
    let changed = false
    for (const [name, range] of Object.entries(manifest.dependencies)) {
        if (!isNpmTag(range.trim()) || !matchingRegistryTagBinding(bindings, name, range) || ownValue(lock.dependencies, name) === range) continue
        lock.dependencies[name] = range
        changed = true
    }
    if (changed) await writeAtomically(environment, paths.lockfilePath, `${JSON.stringify(lock.value, undefined, 2)}\n`)
}

function projectNotInitialized(): ManagedScriptProjectBlocker {
    return { code: "project_not_initialized", message: "Managed script project is not initialized. Call autocode_script_project first." }
}

function readManifest(content: string, paths: SharedProjectPaths): { ok: true, manifest: ManagedManifest } | { ok: false, blocker: ManagedScriptProjectBlocker } {
    try {
        return { ok: true, manifest: parseManifest(content) }
    }
    catch (error) {
        return { ok: false, blocker: { code: "invalid_manifest", message: `Invalid ${paths.manifestPath}: ${flattenError(error)} Correct package.json before retrying autocode_script_project or autocode_script_install.` } }
    }
}

function validateInput(input: unknown, allowUpgrade: boolean): { ok: true, requests: Record<string, string>, upgrade: boolean } | { ok: false, blocker: ManagedScriptProjectBlocker } {
    try {
        let message: string | undefined
        const requests = emptyMap<string>()
        if (!isPlainRecord(input)) message = "Managed script project input must be an object."
        else if (input.upgrade !== undefined && typeof input.upgrade !== "boolean") message = "upgrade must be a boolean."
        else if (input.dependencies !== undefined && !isPlainRecord(input.dependencies)) message = "dependencies must be a plain object of npm package names and string version ranges."
        else {
            for (const [rawName, range] of Object.entries<unknown>(input.dependencies ?? {})) {
                const name = rawName.trim()
                if (typeof range !== "string") {
                    message = `Dependency ${name} must have a string requested version range.`
                    break
                }
                if (ownValue(requests, name) !== undefined) {
                    message = `Duplicate npm package name after trimming: ${name}.`
                    break
                }
                requests[name] = range.trim()
            }
            message ??= validateDependencies(requests)
        }
        if (message) return { ok: false, blocker: { code: "invalid_dependency", message: `${message} Use registry semver ranges or tags with autocode_script_project or autocode_script_install.` } }
        return { ok: true, requests, upgrade: allowUpgrade && isPlainRecord(input) && input.upgrade === true }
    }
    catch (error) {
        return { ok: false, blocker: { code: "invalid_dependency", message: `Unable to read dependency input: ${flattenError(error)} Pass a plain dependency map and boolean upgrade to autocode_script_install.` } }
    }
}

async function resolveProjectPaths(dependencies: ManagedScriptProjectDependencies): Promise<{ ok: true, paths: ManagedScriptProjectPaths } | { ok: false, blocker: ManagedScriptProjectBlocker }> {
    try {
        const resolution = dependencies.resolveOwner ? await dependencies.resolveOwner() : await resolveManagedScriptProjectOwner(dependencies)
        if (!resolution.ok) return { ok: false, blocker: { code: "job_workspace_required", message: resolution.reason } }
        if (resolution.owner.directory !== dependencies.context.directory) return { ok: false, blocker: { code: "job_workspace_required", message: "Resolved job directory must equal context.directory. Correct resolveOwner before calling autocode_script_project or autocode_script_install." } }
        return { ok: true, paths: createManagedScriptProjectPaths(dependencies.context.directory, resolution.owner.jobName) }
    }
    catch (error) {
        return { ok: false, blocker: { code: "job_workspace_required", message: `Unable to resolve current managed script job: ${flattenError(error)}` } }
    }
}

async function probePackage(
    fileSystem: Pick<ManagedScriptProjectFileSystem, "readFile" | "lstat" | "stat">,
    paths: SharedProjectPaths,
    name: string,
    resolvePackage?: ManagedScriptProjectDependencies["resolvePackage"],
): Promise<InstalledPackage | undefined> {
    const ownPackage = await readInstalledPackage(fileSystem, path.join(paths.nodeModulesPath, ...name.split("/")), name, "local")
    if (ownPackage) return ownPackage
    const ancestors = ancestorDirectories(paths.scriptsRoot)
    const resolved = resolvePackage ? await resolvePackage(name, path.join(path.dirname(paths.scriptsRoot), "package.json")) : undefined
    const resolvedWorkspace = resolved && ancestors.find((directory: string): boolean => path.normalize(directory) === path.normalize(resolved.workspacePath))
    const resolvedIsAncestorPackage = resolved && resolvedWorkspace !== undefined && path.normalize(resolved.packagePath) === path.normalize(path.join(resolved.workspacePath, "node_modules", ...name.split("/")))
    for (const workspacePath of ancestors) {
        const inherited = await readInstalledPackage(fileSystem, path.join(workspacePath, "node_modules", ...name.split("/")), name, "inherited", workspacePath)
        // The nearest package wins even when incompatible; Node will not use a farther compatible one.
        if (inherited) return inherited
        if (resolved && resolvedIsAncestorPackage && workspacePath === resolvedWorkspace) return { source: "inherited", ...resolved }
    }
    return undefined
}

function classifyDependency(name: string, requestedRange: string, installed: InstalledPackage | undefined, bindings: Record<string, RegistryTagBinding>): ManagedScriptProjectDependency {
    const status = !installed?.version ? "missing" : parseManagedScriptVersion(installed.version) && satisfiesDependencySpec(installed.version, requestedRange, matchingRegistryTagBinding(bindings, name, requestedRange)) ? "satisfied" : "incompatible"
    return { name, requestedRange, status, ...(installed ?? {}) }
}

function declaredRequests(manifest: ManagedManifest): Record<string, string> {
    const inherited = Object.entries(manifest.inheritedDependencies).map(([name, dependency]: [string, InheritedDependency]): [string, string] => [name, dependency.requestedRange])
    return Object.assign(emptyMap<string>(), Object.fromEntries(inherited), manifest.dependencies)
}

async function classifyRequests(fileSystem: Pick<ManagedScriptProjectFileSystem, "readFile" | "lstat" | "stat">, paths: SharedProjectPaths, requests: Record<string, string>, bindings: Record<string, RegistryTagBinding>, resolvePackage?: ManagedScriptProjectDependencies["resolvePackage"]): Promise<ManagedScriptProjectDependency[]> {
    const result: ManagedScriptProjectDependency[] = []
    for (const [name, range] of Object.entries(requests)) result.push(classifyDependency(name, range, await probePackage(fileSystem, paths, name, resolvePackage), bindings))
    return result
}

function dependencyFailure(dependencies: ManagedScriptProjectDependency[]): ManagedScriptProjectFailure | undefined {
    const unhealthy = dependencies.find((dependency: ManagedScriptProjectDependency): boolean => dependency.status !== "satisfied")
    if (!unhealthy) return undefined
    if (unhealthy.status === "missing") return { code: "dependency_missing", message: `Dependency ${unhealthy.name} (${unhealthy.requestedRange}) is missing or has malformed installed package metadata. ${repairGuidance}` }
    return { code: "dependency_incompatible", message: `Dependency ${unhealthy.name} version ${unhealthy.version} does not satisfy ${unhealthy.requestedRange}. ${repairGuidance}` }
}

type InstallPlan = {
    manifest: ManagedManifest
    registryTagBindings: Record<string, RegistryTagBinding>
    manifestChanged: boolean
    needsNpm: boolean
    dependencies: ManagedScriptProjectDependency[]
}

function trackSatisfiedDependency(manifest: ManagedManifest, dependency: ManagedScriptProjectDependency): void {
    if (ownValue(manifest.dependencies, dependency.name) !== undefined || ownValue(manifest.inheritedDependencies, dependency.name) !== undefined) return
    // First-use bookkeeping registers an already installed package without running npm.
    if (dependency.source === "local") manifest.dependencies[dependency.name] = dependency.requestedRange
    else if (dependency.version && dependency.packagePath && dependency.workspacePath) manifest.inheritedDependencies[dependency.name] = {
        version: dependency.version,
        packagePath: dependency.packagePath,
        workspacePath: dependency.workspacePath,
        requestedRange: dependency.requestedRange,
    }
}

async function planInstall(environment: ProjectEnvironment, paths: ManagedScriptProjectPaths, current: ManagedManifest, requests: Record<string, string>, upgrade: boolean, journalPresent: boolean, explicitInstall: boolean): Promise<{ ok: true, plan: InstallPlan } | Extract<ManagedScriptProjectResult, { ok: false }>> {
    const resolvedRequests: ManagedScriptProjectDependency[] = []
    let resolutionError: string | undefined
    const resolver = environment.dependencies.resolvePackage ?? (async (name: string, fromFile: string): Promise<ManagedScriptProjectResolvedPackage | undefined> => await defaultResolvePackage(environment.fileSystem, name, fromFile))
    const resolvePackage = async (name: string, fromFile: string): Promise<ManagedScriptProjectResolvedPackage | undefined> => {
        try {
            return await resolver(name, fromFile)
        }
        catch (error) {
            resolutionError = flattenError(error)
            throw error
        }
    }
    try {
        const declarations = declaredRequests(current)
        const setupProvisioningTags = new Set<string>()
        if (!explicitInstall && !journalPresent) {
            for (const [name, range] of Object.entries(requests)) {
                if (ownValue(declarations, name) === undefined && isNpmTag(range)) setupProvisioningTags.add(name)
            }
        }
        const currentBindings = await availableRegistryTagBindings(environment.fileSystem, paths, current)
        const bindings = Object.assign(emptyMap<RegistryTagBinding>(), currentBindings)
        for (const [name, range] of Object.entries(requests)) {
            const binding = matchingRegistryTagBinding(current.registryTagBindings, name, range)
            if (binding) bindings[name] = binding
        }
        const targets = Object.assign(emptyMap<string>(), declarations, requests)
        const installedPackages = emptyMap<InstalledPackage | undefined>()
        let runtimeChecked = false
        for (const [name, range] of Object.entries(targets)) {
            const installed = await probePackage(environment.fileSystem, paths, name, resolvePackage)
            installedPackages[name] = installed
            const tag = range.trim()
            if (!isNpmTag(tag)) continue
            if (!explicitInstall && !setupProvisioningTags.has(name)) {
                const declared = ownValue(declarations, name) ?? range
                const dependencies = [classifyDependency(name, declared, installed, currentBindings)]
                if (declared.trim() !== tag) dependencies.push(classifyDependency(name, range, installed, bindings))
                const failure = dependencyFailure(dependencies)
                if (failure) return { ok: false, dependencies, error: failure }
                continue
            }
            if (matchingRegistryTagBinding(bindings, name, tag)) continue
            if (!runtimeChecked) {
                let blocker: ManagedScriptProjectBlocker | undefined
                try {
                    blocker = await checkRuntime(environment.spawn, environment.runtime)
                }
                catch (error) {
                    blocker = { code: "runtime_unavailable", message: `Unable to check registry query runtime: ${flattenError(error)} Make Node.js 20+ and npm available and retry autocode_script_install.` }
                }
                if (blocker) return { ok: false, dependencies: resolvedRequests, blocker }
                runtimeChecked = true
            }
            const resolved = await resolveRegistryTag(environment, paths, name, tag)
            if (!resolved.ok) return { ...resolved, dependencies: resolvedRequests }
            bindings[name] = resolved.binding
            if (ownValue(requests, name) === undefined && installed?.version && installed.version !== resolved.binding.version) {
                const dependency = classifyDependency(name, range, installed, bindings)
                return { ok: false, dependencies: [dependency], blocker: { code: "upgrade_required", message: `Registry tag ${name}@${tag} resolves to ${resolved.binding.version}, but installed version is ${installed.version}. Explicitly request ${name}:${tag} with upgrade:true in autocode_script_install; omitted dependencies cannot be upgraded.` } }
            }
        }
        for (const [name, range] of Object.entries(requests)) resolvedRequests.push(classifyDependency(name, range, ownValue(installedPackages, name), bindings))
        const conflicts: string[] = []
        for (const dependency of resolvedRequests) {
            const declared = ownValue(declarations, dependency.name)
            if (dependency.status === "incompatible") conflicts.push(`${dependency.name}: installed ${dependency.version}, requested ${dependency.requestedRange}`)
            else if (declared !== undefined && declared.trim() !== dependency.requestedRange) {
                if (dependency.status === "missing" || (dependency.version !== undefined && !satisfiesDependencySpec(dependency.version, declared, matchingRegistryTagBinding(currentBindings, dependency.name, declared)))) {
                    conflicts.push(`${dependency.name}: declared ${declared}, requested ${dependency.requestedRange}`)
                }
            }
        }
        if (!upgrade && conflicts.length > 0) return { ok: false, dependencies: resolvedRequests, blocker: { code: "upgrade_required", message: `Dependency range conflict: ${conflicts.join("; ")}. Call autocode_script_install with upgrade:true to change only these requested dependencies.` } }

        const manifest: ManagedManifest = {
            value: current.value,
            dependencies: Object.assign(emptyMap<string>(), current.dependencies),
            inheritedDependencies: Object.assign(emptyMap<InheritedDependency>(), current.inheritedDependencies),
            registryTagBindings: Object.assign(emptyMap<RegistryTagBinding>(), explicitInstall ? bindings : current.registryTagBindings),
        }
        for (const dependency of resolvedRequests) {
            if (!explicitInstall && !setupProvisioningTags.has(dependency.name) && dependency.status === "satisfied" && isNpmTag(dependency.requestedRange)) continue
            if (dependency.status === "satisfied") {
                const declared = ownValue(declarations, dependency.name)
                if (declared !== undefined && declared.trim() !== dependency.requestedRange && (
                    (upgrade && dependency.version !== undefined && !satisfiesDependencySpec(dependency.version, declared, matchingRegistryTagBinding(currentBindings, dependency.name, declared)))
                    || (explicitInstall && (isNpmTag(declared.trim()) || isNpmTag(dependency.requestedRange)))
                )) {
                    if (dependency.source === "local") {
                        manifest.dependencies[dependency.name] = dependency.requestedRange
                        delete manifest.inheritedDependencies[dependency.name]
                    }
                    else if (dependency.source === "inherited" && dependency.version && dependency.packagePath && dependency.workspacePath) {
                        // Reset this requested contract change so first-use bookkeeping can refresh inherited metadata.
                        delete manifest.dependencies[dependency.name]
                        delete manifest.inheritedDependencies[dependency.name]
                    }
                }
                trackSatisfiedDependency(manifest, dependency)
            }
            else {
                manifest.dependencies[dependency.name] = dependency.requestedRange
                delete manifest.inheritedDependencies[dependency.name]
            }
            if (explicitInstall || setupProvisioningTags.has(dependency.name)) {
                if (!isNpmTag(dependency.requestedRange) || !matchingRegistryTagBinding(manifest.registryTagBindings, dependency.name, dependency.requestedRange)) delete manifest.registryTagBindings[dependency.name]
                const binding = matchingRegistryTagBinding(bindings, dependency.name, dependency.requestedRange)
                if (binding) manifest.registryTagBindings[dependency.name] = binding
            }
        }
        const declarationBindings = explicitInstall ? bindings : Object.assign(emptyMap<RegistryTagBinding>(), currentBindings)
        for (const name of setupProvisioningTags) {
            const binding = ownValue(manifest.registryTagBindings, name)
            if (binding) declarationBindings[name] = binding
        }
        const declared = await classifyRequests(environment.fileSystem, paths, declaredRequests(manifest), declarationBindings, resolvePackage)
        for (const dependency of declared) {
            if (!explicitInstall && !setupProvisioningTags.has(dependency.name) && isNpmTag(dependency.requestedRange.trim())) continue
            const inherited = ownValue(manifest.inheritedDependencies, dependency.name)
            if (!inherited || ownValue(manifest.dependencies, dependency.name) !== undefined) continue
            if (dependency.status !== "satisfied") {
                manifest.dependencies[dependency.name] = inherited.requestedRange
            }
            else if (dependency.source === "inherited" && dependency.version && dependency.packagePath && dependency.workspacePath) {
                manifest.inheritedDependencies[dependency.name] = { ...inherited, version: dependency.version, packagePath: dependency.packagePath, workspacePath: dependency.workspacePath }
            }
        }
        const needsNpm = journalPresent || [...resolvedRequests, ...declared].some((dependency: ManagedScriptProjectDependency): boolean => dependency.status !== "satisfied")
        if (!explicitInstall && needsNpm) {
            const unhealthyTags = [...resolvedRequests, ...declared].filter((dependency: ManagedScriptProjectDependency): boolean => dependency.status !== "satisfied" && isNpmTag(dependency.requestedRange.trim()) && !setupProvisioningTags.has(dependency.name))
            const failure = dependencyFailure(unhealthyTags)
            if (failure) return { ok: false, dependencies: resolvedRequests.length > 0 ? resolvedRequests : declared, error: failure }
        }
        return { ok: true, plan: {
            manifest,
            registryTagBindings: declarationBindings,
            manifestChanged: writeManifest(manifest) !== writeManifest(current),
            needsNpm,
            dependencies: resolvedRequests.length > 0 ? resolvedRequests : declared,
        } }
    }
    catch (error) {
        return { ok: false, dependencies: resolvedRequests, error: { code: resolutionError === undefined ? "filesystem_error" : "package_resolution_error", message: `Unable to classify managed script dependencies: ${flattenError(error)} Correct package access and retry autocode_script_install.` } }
    }
}

function parseJournal(content: string | undefined): InstallJournal | undefined {
    if (content === undefined) return undefined
    try {
        const value: unknown = JSON.parse(content)
        if (!isRecord(value) || value.schema !== installJournalSchema || value.version !== installJournalVersion || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0 || typeof value.host !== "string" || !value.host || typeof value.token !== "string" || !value.token || typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt) || typeof value.upgrade !== "boolean" || !isPlainRecord(value.requests) || !isRecord(value.prior)) return undefined
        if (typeof value.prior.manifest !== "string" || !(value.prior.lockfile === null || typeof value.prior.lockfile === "string")) return undefined
        const requests = readStringMap(value.requests)
        if (validateDependencies(requests)) return undefined
        parseManifest(value.prior.manifest)
        if (value.plannedManifest !== undefined) {
            if (typeof value.plannedManifest !== "string") return undefined
            const plannedManifest = parseManifest(value.plannedManifest)
            writePinnedManifest(plannedManifest, plannedManifest.registryTagBindings)
        }
        return {
            schema: installJournalSchema,
            version: installJournalVersion,
            pid: value.pid,
            host: value.host,
            token: value.token,
            startedAt: value.startedAt,
            requests,
            upgrade: value.upgrade,
            prior: { manifest: value.prior.manifest, lockfile: value.prior.lockfile },
            ...(typeof value.plannedManifest === "string" ? { plannedManifest: value.plannedManifest } : {}),
        }
    }
    catch {
        return undefined
    }
}

async function restoreSnapshot(environment: ProjectEnvironment, paths: ManagedScriptProjectPaths, snapshot: ManifestSnapshot): Promise<string[]> {
    const failures: string[] = []
    try {
        await writeAtomically(environment, paths.manifestPath, snapshot.manifest)
    }
    catch (error) {
        failures.push(`package.json restore failed: ${flattenError(error)}`)
    }
    try {
        if (snapshot.lockfile === null) await environment.fileSystem.rm(paths.lockfilePath, { force: true })
        else await writeAtomically(environment, paths.lockfilePath, snapshot.lockfile)
    }
    catch (error) {
        failures.push(`package-lock.json restore failed: ${flattenError(error)}`)
    }
    return failures
}

async function restoreAfterFailure(environment: ProjectEnvironment, paths: ManagedScriptProjectPaths, journal: InstallJournal, dependencies: ManagedScriptProjectDependency[], failure: ManagedScriptProjectFailure, npmAttempted: boolean, repairing: boolean, npm?: ManagedScriptProjectNpmResult): Promise<ManagedScriptProjectResult> {
    const details = await restoreSnapshot(environment, paths, journal.prior)
    try {
        const priorManifest = parseManifest(journal.prior.manifest)
        const bindings = await availableRegistryTagBindings(environment.fileSystem, paths, priorManifest, journal.prior.lockfile)
        const restored = await classifyRequests(environment.fileSystem, paths, declaredRequests(priorManifest), bindings, environment.dependencies.resolvePackage)
        const treeError = dependencyFailure(restored)
        if (treeError) details.push(`Prior declared dependencies remain unhealthy: ${treeError.message}`)
    }
    catch (error) {
        details.push(`Prior dependency verification failed: ${flattenError(error)}`)
    }
    if (repairing) details.push("Interrupted install repair did not complete; its recovery journal is retained.")
    // Metadata rollback proves safety only before npm install invocation and without a preexisting recovery journal.
    if (!npmAttempted && !repairing && details.length === 0) {
        try {
            await environment.fileSystem.rm(paths.journalPath, { force: true })
            return { ok: false, paths, dependencies, ...(npm ? { npm } : {}), error: { code: failure.code, message: `${failure.message} npm install was not invoked; package.json and package-lock.json were restored; prior declared dependencies are healthy. Retry autocode_script_install with corrected dependencies if needed.` } }
        }
        catch (error) {
            details.push(`Recovery journal removal failed: ${flattenError(error)}`)
        }
    }
    try {
        await writeAtomically(environment, paths.journalPath, `${JSON.stringify(journal, undefined, 2)}\n`)
    }
    catch (error) {
        details.push(`Recovery journal could not be retained: ${flattenError(error)}`)
    }
    const state = npmAttempted ? "Install incomplete; node_modules may be partially updated." : "Install preparation incomplete; npm install was not invoked."
    return { ok: false, paths, dependencies, ...(npm ? { npm } : {}), error: { code: "install_incomplete", message: `${state} ${repairGuidance} Original failure: ${failure.message} ${details.join("; ")}` } }
}

async function applyInstall(environment: ProjectEnvironment, paths: ManagedScriptProjectPaths, currentContent: string, plan: InstallPlan, requests: Record<string, string>, upgrade: boolean, token: string, repairing: boolean, prior?: ManifestSnapshot): Promise<ManagedScriptProjectResult> {
    let runtimeBlocker: ManagedScriptProjectBlocker | undefined
    try {
        runtimeBlocker = await checkRuntime(environment.spawn, environment.runtime)
    }
    catch (error) {
        runtimeBlocker = { code: "runtime_unavailable", message: `Unable to check dependency installation runtime: ${flattenError(error)} Make Node.js 20+ and npm available and retry autocode_script_install.` }
    }
    if (runtimeBlocker) return { ok: false, paths, dependencies: plan.dependencies, blocker: runtimeBlocker }

    let journal: InstallJournal | undefined
    let mutationAttempted = false
    let npmAttempted = false
    let npm: ManagedScriptProjectNpmResult | undefined
    let resolvedDependencies = plan.dependencies
    try {
        const snapshot = prior ?? { manifest: currentContent, lockfile: await readOptionalFile(environment.fileSystem, paths.lockfilePath) ?? null }
        const logPath = createNpmLogPath(environment, paths)
        const finalContent = writeManifest(plan.manifest)
        const pinnedContent = writePinnedManifest(plan.manifest, plan.registryTagBindings)
        journal = {
            schema: installJournalSchema,
            version: installJournalVersion,
            pid: environment.dependencies.installerLock?.pid ?? process.pid,
            host: environment.dependencies.installerLock?.host ?? hostname(),
            token,
            startedAt: environment.now(),
            requests,
            upgrade,
            prior: snapshot,
            plannedManifest: finalContent,
        }
        mutationAttempted = true
        await writeAtomically(environment, paths.journalPath, `${JSON.stringify(journal, undefined, 2)}\n`)
        if (plan.manifestChanged || pinnedContent !== finalContent) await writeAtomically(environment, paths.manifestPath, pinnedContent)

        let commandResult: ManagedScriptProjectCommandResult
        try {
            npmAttempted = true
            commandResult = await environment.spawn("npm", npmInstallArgs, { cwd: paths.scriptsRoot, env: environment.runtime.env })
        }
        catch (error) {
            commandResult = { exitCode: null, stdout: "", stderr: flattenError(error) }
        }
        npm = { ...commandResult, command: npmInstallArgs, logPath }
        let failure: ManagedScriptProjectFailure | undefined = commandResult.exitCode === 0 ? undefined : { code: "npm_install_failed", message: `npm install failed (exit code ${commandResult.exitCode}): ${commandResult.stderr.trim() || "no stderr output"}. Inspect ${logPath} and retry autocode_script_install.` }
        try {
            await writeNpmLog(environment.fileSystem, logPath, npmInstallArgs, commandResult)
        }
        catch (error) {
            const message = `Unable to write npm install log ${logPath}: ${flattenError(error)}.`
            failure = failure ? { ...failure, message: `${failure.message} ${message}` } : { code: "filesystem_error", message }
        }
        if (failure) return await restoreAfterFailure(environment, paths, journal, resolvedDependencies, failure, npmAttempted, repairing, npm)

        const declared = await classifyRequests(environment.fileSystem, paths, declaredRequests(plan.manifest), plan.registryTagBindings, environment.dependencies.resolvePackage)
        const requestedBindings = Object.assign(emptyMap<RegistryTagBinding>(), plan.registryTagBindings)
        for (const [name, range] of Object.entries(requests)) {
            const binding = matchingRegistryTagBinding(plan.manifest.registryTagBindings, name, range)
            if (binding) requestedBindings[name] = binding
        }
        const requested = await classifyRequests(environment.fileSystem, paths, requests, requestedBindings, environment.dependencies.resolvePackage)
        resolvedDependencies = requested.length > 0 ? requested : declared
        const treeError = dependencyFailure([...declared, ...requested])
        if (treeError) return await restoreAfterFailure(environment, paths, journal, resolvedDependencies, treeError, npmAttempted, repairing, npm)
        if (pinnedContent !== finalContent) await writeAtomically(environment, paths.manifestPath, finalContent)
        await synchronizeRegistryTagLock(environment, paths, plan.manifest, plan.registryTagBindings)
        try {
            await environment.fileSystem.rm(paths.journalPath, { force: true })
        }
        catch (error) {
            return { ok: false, paths, dependencies: resolvedDependencies, npm, error: { code: "install_incomplete", message: `Install completed and dependencies are healthy, but recovery journal could not be cleared: ${flattenError(error)} ${repairGuidance}` } }
        }
        return { ok: true, paths, dependencies: resolvedDependencies, npm }
    }
    catch (error) {
        const failure: ManagedScriptProjectFailure = { code: "filesystem_error", message: `Managed dependency installation failed: ${flattenError(error)} Correct filesystem access and retry autocode_script_install.` }
        if (journal && mutationAttempted) return await restoreAfterFailure(environment, paths, journal, resolvedDependencies, failure, npmAttempted, repairing, npm)
        return { ok: false, paths, dependencies: resolvedDependencies, ...(npm ? { npm } : {}), error: failure }
    }
}

async function installLocked(environment: ProjectEnvironment, paths: ManagedScriptProjectPaths, requests: Record<string, string>, upgrade: boolean, token: string, explicitInstall: boolean): Promise<ManagedScriptProjectResult> {
    const content = await readOptionalFile(environment.fileSystem, paths.manifestPath)
    if (content === undefined) return { ok: false, paths, blocker: projectNotInitialized() }
    const parsed = readManifest(content, paths)
    if (!parsed.ok) return { ok: false, paths, blocker: parsed.blocker }
    const journalContent = await readOptionalFile(environment.fileSystem, paths.journalPath)
    if (!explicitInstall && journalContent !== undefined) return { ok: false, paths, error: { code: "install_interrupted", message: pendingInstallGuidance } }
    const journal = parseJournal(journalContent)
    let manifest = parsed.manifest
    if (journal?.plannedManifest) {
        const plannedManifest = parseManifest(journal.plannedManifest)
        // A crashed install must not leave its temporary exact pins as the public tag declarations.
        if (writeManifest(manifest) === writePinnedManifest(plannedManifest, plannedManifest.registryTagBindings)) manifest = plannedManifest
    }
    // Repeated repairs keep the original rollback snapshot, not an interrupted request's manifest.
    const planned = await planInstall(environment, paths, manifest, requests, upgrade, journalContent !== undefined, explicitInstall)
    if (!planned.ok) return { ok: false, paths, dependencies: planned.dependencies, ...(planned.npm ? { npm: planned.npm } : {}), ...(planned.blocker ? { blocker: planned.blocker } : {}), ...(planned.error ? { error: planned.error } : {}) }
    if (!planned.plan.needsNpm) {
        try {
            if (planned.plan.manifestChanged) await writeAtomically(environment, paths.manifestPath, writeManifest(planned.plan.manifest))
        }
        catch (error) {
            return { ok: false, paths, dependencies: planned.plan.dependencies, error: { code: "filesystem_error", message: `Unable to register reused dependencies in ${paths.manifestPath}: ${flattenError(error)} Correct filesystem access and retry autocode_script_install.` } }
        }
        return { ok: true, paths, dependencies: planned.plan.dependencies }
    }
    return await applyInstall(environment, paths, content, planned.plan, requests, upgrade, token, journalContent !== undefined, journal?.prior)
}

async function installProject(environment: ProjectEnvironment, paths: ManagedScriptProjectPaths, requests: Record<string, string>, upgrade: boolean, explicitInstall: boolean): Promise<ManagedScriptProjectResult> {
    try {
        try {
            await environment.fileSystem.stat(paths.metaRoot)
        }
        catch (error) {
            if (isMissingFile(error)) return { ok: false, paths, blocker: projectNotInitialized() }
            throw error
        }
        if (!explicitInstall && await readOptionalFile(environment.fileSystem, paths.journalPath) !== undefined) return { ok: false, paths, error: { code: "install_interrupted", message: pendingInstallGuidance } }
        const acquired = await acquireInstallerLock(environment.fileSystem, paths.lockPath, environment.dependencies.installerLock)
        if (!acquired.ok) return { ok: false, paths, error: { code: "install_lock_timeout", message: `${acquired.message} Retry autocode_script_install after the active installer finishes.` } }
        try {
            return await installLocked(environment, paths, requests, upgrade, acquired.lock.token, explicitInstall)
        }
        finally {
            await acquired.lock.release()
        }
    }
    catch (error) {
        return { ok: false, paths, error: { code: "filesystem_error", message: `Unable to access shared managed script project: ${flattenError(error)} Correct filesystem access and retry autocode_script_install; call autocode_script_project if project directories were deleted.` } }
    }
}

async function bootstrapManifest(environment: ProjectEnvironment, manifestPath: string): Promise<void> {
    const fileSystem = environment.fileSystem
    if (await readOptionalFile(fileSystem, manifestPath) !== undefined) return
    const temporaryPath = createTemporaryPath(environment, manifestPath)
    try {
        await fileSystem.writeFile(temporaryPath, `${JSON.stringify({ private: true, type: "module" }, undefined, 2)}\n`, { flag: "wx" })
        try {
            // Hard-link publication exposes complete JSON without replacing an existing manifest.
            await fileSystem.link(temporaryPath, manifestPath)
        }
        catch (error) {
            if (!isRecord(error) || error.code !== "EEXIST") throw error
        }
    }
    finally {
        await fileSystem.rm(temporaryPath, { force: true }).catch((): void => undefined)
    }
}

async function setupProject(environment: ProjectEnvironment, paths: ManagedScriptProjectPaths, requests: Record<string, string>): Promise<ManagedScriptProjectResult> {
    const fileSystem = environment.fileSystem
    try {
        await fileSystem.mkdir(paths.scriptsRoot, { recursive: true })
        await fileSystem.mkdir(paths.logsRoot, { recursive: true })
        await fileSystem.mkdir(paths.servicesRoot, { recursive: true })
        await fileSystem.mkdir(paths.sourceRoot, { recursive: true })
        await bootstrapManifest(environment, paths.manifestPath)
        const content = await readOptionalFile(fileSystem, paths.manifestPath)
        if (content === undefined) return { ok: false, paths, blocker: projectNotInitialized() }
        const parsed = readManifest(content, paths)
        if (!parsed.ok) return { ok: false, paths, blocker: parsed.blocker }
        await refreshManagedAgents(environment, paths)
        if (Object.keys(requests).length === 0) return { ok: true, paths, dependencies: [] }
        return await installProject(environment, paths, requests, false, false)
    }
    catch (error) {
        return { ok: false, paths, error: { code: "filesystem_error", message: `Unable to prepare shared managed script project: ${flattenError(error)} Correct filesystem access and retry autocode_script_project.` } }
    }
}

function isValidInstallerOwner(owner: InstallerLockOwner | undefined): boolean {
    return owner !== undefined && Number.isInteger(owner.pid) && owner.pid > 0 && Boolean(owner.host.trim()) && Boolean(owner.token.trim()) && Number.isFinite(owner.startedAt) && Number.isFinite(owner.heartbeatAt)
}

async function verifyProject(environment: ProjectEnvironment): Promise<ManagedScriptProjectVerifyResult> {
    try {
        const paths = createSharedProjectPaths(environment.dependencies.context.directory)
        const content = await readOptionalFile(environment.fileSystem, paths.manifestPath)
        if (content === undefined) return { ok: false, blocker: projectNotInitialized() }
        const parsed = readManifest(content, paths)
        if (!parsed.ok) return { ok: false, blocker: parsed.blocker }
        const journal = await readOptionalFile(environment.fileSystem, paths.journalPath)
        if (journal !== undefined) {
            const lock = await inspectInstallerLock(environment.fileSystem, paths.lockPath, environment.dependencies.installerLock)
            if (lock.state !== "active" || !isValidInstallerOwner(lock.owner)) return { ok: false, error: { code: "install_interrupted", message: `Managed dependency installation was interrupted or has no valid active owner. ${repairGuidance}` } }
        }
        const bindings = await availableRegistryTagBindings(environment.fileSystem, paths, parsed.manifest)
        const dependencies = await classifyRequests(environment.fileSystem, paths, declaredRequests(parsed.manifest), bindings)
        const failure = dependencyFailure(dependencies)
        return failure ? { ok: false, dependencies, error: failure } : { ok: true }
    }
    catch (error) {
        return { ok: false, error: { code: "filesystem_error", message: `Unable to read managed script readiness: ${flattenError(error)} Correct filesystem access; use autocode_script_project to prepare or autocode_script_install to repair.` } }
    }
}

export function createManagedScriptProject(dependencies: ManagedScriptProjectDependencies): ManagedScriptProject {
    const environment: ProjectEnvironment = {
        dependencies,
        fileSystem: dependencies.fileSystem ?? defaultFileSystem,
        spawn: dependencies.spawn ?? defaultSpawn,
        platform: dependencies.platform ?? process.platform,
        runtime: {
            env: dependencies.runtime?.env ?? process.env,
            ...(dependencies.runtime?.nodeVersion ? { nodeVersion: dependencies.runtime.nodeVersion } : {}),
            ...(dependencies.runtime?.npmVersion ? { npmVersion: dependencies.runtime.npmVersion } : {}),
        },
        now: dependencies.installerLock?.now ?? Date.now,
    }
    const setup = async (input: ManagedScriptProjectSetupInput = {}): Promise<ManagedScriptProjectResult> => {
        const validated = validateInput(input, false)
        if (!validated.ok) return { ok: false, blocker: validated.blocker }
        const resolved = await resolveProjectPaths(dependencies)
        if (!resolved.ok) return { ok: false, blocker: resolved.blocker }
        return await setupProject(environment, resolved.paths, validated.requests)
    }
    const install = async (input: ManagedScriptProjectInstallInput = {}): Promise<ManagedScriptProjectResult> => {
        const validated = validateInput(input, true)
        if (!validated.ok) return { ok: false, blocker: validated.blocker }
        const resolved = await resolveProjectPaths(dependencies)
        if (!resolved.ok) return { ok: false, blocker: resolved.blocker }
        return await installProject(environment, resolved.paths, validated.requests, validated.upgrade, true)
    }
    return { setup, install, verify: async (): Promise<ManagedScriptProjectVerifyResult> => await verifyProject(environment) }
}
