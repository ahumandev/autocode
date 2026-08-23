import { spawn as spawnChild } from "node:child_process"
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { createSessionJobWorkspace, isMissingFile, resolveJobWorkspaceIdentity, type JobToolFileSystem, type SessionJobContext } from "./jobs"
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

export type ManagedScriptProjectFileSystem = Pick<JobToolFileSystem, "mkdir" | "readFile" | "readdir" | "rename" | "rm" | "stat" | "writeFile"> & {
    lstat?: (filePath: string) => Promise<ManagedScriptProjectFileStats>
}

export type ManagedScriptProjectRuntime = {
    env: NodeJS.ProcessEnv
    nodeVersion?: () => Promise<ManagedScriptProjectCommandResult>
    npmVersion?: () => Promise<ManagedScriptProjectCommandResult>
}

export type ManagedScriptProjectOwner = {
    jobName: string
    workspacePath: string
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
    runtime?: Partial<ManagedScriptProjectRuntime>
    resolveOwner?: () => Promise<ManagedScriptProjectOwnerResolution>
    resolvePackage?: (packageName: string, fromFile: string) => Promise<ManagedScriptProjectResolvedPackage | undefined>
}

export type ManagedScriptProjectPaths = {
    workspacePath: string
    scriptsRoot: string
    sourceRoot: string
    manifestPath: string
    lockPath: string
    nodeModulesPath: string
    logsPath: string
    servicesPath: string
    agentsPath: string
}

export type ManagedScriptProjectDependency = {
    name: string
    requestedRange: string
    source: "inherited" | "local"
    version: string
    packagePath: string
    workspacePath?: string
}

export type ManagedScriptProjectNpmResult = ManagedScriptProjectCommandResult & {
    command: readonly string[]
    logPath: string
}

export type ManagedScriptProjectBlocker = {
    code: "job_workspace_required" | "runtime_unavailable" | "invalid_dependency" | "invalid_manifest"
    message: string
}

export type ManagedScriptProjectFailure = {
    code: "filesystem_error" | "package_resolution_error" | "npm_install_failed" | "dependency_unsatisfied"
    message: string
}

export type ManagedScriptProjectResult =
    | {
        ok: true
        paths: ManagedScriptProjectPaths
        dependencies: ManagedScriptProjectDependency[]
        npm: ManagedScriptProjectNpmResult
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

export type ManagedScriptProject = {
    setup: (input?: ManagedScriptProjectSetupInput) => Promise<ManagedScriptProjectResult>
    install: (input?: ManagedScriptProjectSetupInput) => Promise<ManagedScriptProjectResult>
    reconcile: (input?: ManagedScriptProjectSetupInput) => Promise<ManagedScriptProjectResult>
}

type JsonRecord = Record<string, unknown>

type InheritedDependency = {
    version: string
    packagePath: string
    workspacePath: string
    requestedRange: string
}

type ManagedManifest = {
    value: JsonRecord
    dependencies: Record<string, string>
    inheritedDependencies: Record<string, InheritedDependency>
}

type ManifestSnapshot = {
    manifest?: string
    lock?: string
}

type NodeModulesStage = {
    backupPath?: string
}

const legacyAgentsInstructions = "# Managed scripts\n\nKeep script sources in `src/`. Use npm for dependencies; do not edit `node_modules` or `package-lock.json`.\n"
const managedAgentsStartMarker = "<!-- AUTOCODE:MANAGED-SCRIPTS:START -->"
const managedAgentsEndMarker = "<!-- AUTOCODE:MANAGED-SCRIPTS:END -->"
const npmInstallArgs = ["install", "--ignore-scripts", "--no-audit", "--no-fund"] as const

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

const defaultFileSystem: ManagedScriptProjectFileSystem = { lstat, mkdir, readFile, readdir: defaultReadDirectory, rename, rm, stat, writeFile }

export function createManagedScriptProjectPaths(workspacePath: string): ManagedScriptProjectPaths {
    const resolvedWorkspacePath = path.resolve(workspacePath)
    const scriptsRoot = path.join(resolvedWorkspacePath, "scripts")
    return {
        workspacePath: resolvedWorkspacePath,
        scriptsRoot,
        sourceRoot: path.join(scriptsRoot, "src"),
        manifestPath: path.join(scriptsRoot, "package.json"),
        lockPath: path.join(scriptsRoot, "package-lock.json"),
        nodeModulesPath: path.join(scriptsRoot, "node_modules"),
        logsPath: path.join(scriptsRoot, "logs"),
        servicesPath: path.join(scriptsRoot, "services"),
        agentsPath: path.join(scriptsRoot, "AGENTS.md"),
    }
}

export async function resolveManagedScriptProjectOwner(dependencies: Pick<ManagedScriptProjectDependencies, "client" | "context" | "fileSystem">): Promise<ManagedScriptProjectOwnerResolution> {
    try {
        const fileSystem = dependencies.fileSystem ?? defaultFileSystem
        const identity = await resolveJobWorkspaceIdentity(fileSystem, dependencies.client, dependencies.context, { sessionOnly: true })
        if (identity.resolution === "found" && identity.workspace && identity.job_name) {
            return { ok: true, owner: { jobName: identity.job_name, workspacePath: identity.workspace.absolute_path } }
        }
        if (dependencies.context.agent !== "execute_script") {
            return { ok: false, reason: "No timestamped job workspace was found for the current session.", jobName: identity.job_name }
        }
        const workspace = await createSessionJobWorkspace(fileSystem, dependencies.client, dependencies.context)
        return { ok: true, owner: { jobName: workspace.job_name, workspacePath: workspace.absolute_path } }
    }
    catch (error) {
        return { ok: false, reason: `Unable to resolve or create current job workspace: ${flattenError(error)}` }
    }
}

async function pathExists(fileSystem: Pick<ManagedScriptProjectFileSystem, "stat">, candidatePath: string): Promise<boolean> {
    try {
        await fileSystem.stat(candidatePath)
        return true
    }
    catch (error) {
        if (isMissingFile(error)) return false
        throw error
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

function readStringMap(value: unknown): Record<string, string> {
    if (!isRecord(value)) return {}
    return Object.entries(value).reduce<Record<string, string>>((result: Record<string, string>, [name, version]: [string, unknown]): Record<string, string> => {
        if (typeof version === "string") result[name] = version
        return result
    }, {})
}

function readInheritedDependencies(value: unknown): Record<string, InheritedDependency> {
    if (!isRecord(value)) return {}
    return Object.entries(value).reduce<Record<string, InheritedDependency>>((result: Record<string, InheritedDependency>, [name, candidate]: [string, unknown]): Record<string, InheritedDependency> => {
        if (!isRecord(candidate)) return result
        if (typeof candidate.version !== "string" || typeof candidate.packagePath !== "string" || typeof candidate.workspacePath !== "string" || typeof candidate.requestedRange !== "string") return result
        result[name] = {
            version: candidate.version,
            packagePath: candidate.packagePath,
            workspacePath: candidate.workspacePath,
            requestedRange: candidate.requestedRange,
        }
        return result
    }, {})
}

function parseManifest(content: string | undefined): ManagedManifest {
    if (content === undefined) return { value: { private: true }, dependencies: {}, inheritedDependencies: {} }
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
    }, {})
    const inheritedDependencyError = validateDependencies(inheritedRequests)
    if (inheritedDependencyError) throw new Error(`scripts/package.json autocode.inheritedDependencies ${inheritedDependencyError}`)
    return { value, dependencies, inheritedDependencies }
}

function writeManifest(manifest: ManagedManifest): string {
    const value: JsonRecord = { ...manifest.value }
    if (Object.keys(manifest.dependencies).length > 0 || manifest.value.dependencies !== undefined) value.dependencies = manifest.dependencies
    else delete value.dependencies
    if (Object.keys(manifest.inheritedDependencies).length > 0 || manifest.value.autocode !== undefined) {
        value.autocode = { ...(isRecord(manifest.value.autocode) ? manifest.value.autocode : {}), inheritedDependencies: manifest.inheritedDependencies }
    }
    else delete value.autocode
    return `${JSON.stringify(value, undefined, 2)}\n`
}

function isValidPackageName(name: string): boolean {
    return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)
}

function isSemverVersion(value: string): boolean {
    return /^[vV]?(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)
}

function isSemverRange(value: string): boolean {
    const alternatives = value.trim().split(/\s*\|\|\s*/)
    if (alternatives.some((alternative: string): boolean => !alternative)) return false
    return alternatives.every((alternative: string): boolean => {
        const hyphenRange = /^(\S+)\s+-\s+(\S+)$/.exec(alternative)
        if (hyphenRange) return isSemverVersion(hyphenRange[1]) && isSemverVersion(hyphenRange[2])
        const comparators = alternative.replace(/(>=|<=|>|<|=|~|\^)\s+/g, "$1").split(/\s+/)
        return comparators.every((comparator: string): boolean => /^(?:>=|<=|>|<|=|~|\^)?[vV]?(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(comparator))
    })
}

function isNpmTag(value: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
}

function isNpmRegistryDependencySpec(value: string): boolean {
    const spec = value.trim()
    if (spec.includes("/") || spec.includes("\\") || /^(?:[A-Za-z][A-Za-z0-9+.-]*:|git@)/.test(spec)) return false
    if (/^(?:\.{1,2}|~)(?:$|[\\/])/.test(spec) || /\.(?:tgz|tar(?:\.[A-Za-z0-9]+)?|zip)$/i.test(spec)) return false
    return isSemverRange(spec) || isNpmTag(spec)
}

function validateDependencies(dependencies: Record<string, string>): string | undefined {
    for (const [name, range] of Object.entries(dependencies)) {
        if (!isValidPackageName(name)) return `Invalid npm package name: ${name}.`
        if (!range.trim()) return `Dependency ${name} must have a non-empty requested version range.`
        if (!isNpmRegistryDependencySpec(range)) return `Dependency ${name} must use an npm registry semver version, range, or tag.`
    }
    return undefined
}

function isInside(candidatePath: string, rootPath: string): boolean {
    const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath))
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
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

async function resolveInheritedPackage(
    packageName: string,
    requestedRange: string,
    resolutionFile: string,
    paths: ManagedScriptProjectPaths,
    resolvePackage: (packageName: string, fromFile: string) => Promise<ManagedScriptProjectResolvedPackage | undefined>,
): Promise<ManagedScriptProjectResolvedPackage | undefined> {
    for (const directory of ancestorDirectories(resolutionFile)) {
        const candidate = await resolvePackage(packageName, path.join(directory, "__autocode_resolution__.cjs"))
        if (!candidate || !isInside(directory, candidate.workspacePath) || isInside(candidate.packagePath, paths.nodeModulesPath)) continue
        if (satisfiesVersion(candidate.version, requestedRange)) return candidate
    }
    return undefined
}

async function readLocalPackage(fileSystem: Pick<ManagedScriptProjectFileSystem, "readFile">, paths: ManagedScriptProjectPaths, packageName: string): Promise<ManagedScriptProjectResolvedPackage | undefined> {
    const packagePath = path.join(paths.nodeModulesPath, ...packageName.split("/"))
    const content = await readOptionalFile(fileSystem, path.join(packagePath, "package.json"))
    if (content === undefined) return undefined
    try {
        const value: unknown = JSON.parse(content)
        if (!isRecord(value) || value.name !== packageName || typeof value.version !== "string") return undefined
        return { packagePath, version: value.version, workspacePath: paths.scriptsRoot }
    }
    catch {
        return undefined
    }
}

type ParsedVersion = { major: number, minor: number, patch: number, prerelease?: string }

function parseVersion(value: string): ParsedVersion | undefined {
    const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
    if (!match) return undefined
    return { major: Number(match[1]), minor: Number(match[2] ?? 0), patch: Number(match[3] ?? 0), ...(match[4] ? { prerelease: match[4] } : {}) }
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
    for (const key of ["major", "minor", "patch"] as const) {
        if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1
    }
    if (!left.prerelease && right.prerelease) return 1
    if (left.prerelease && !right.prerelease) return -1
    return (left.prerelease ?? "").localeCompare(right.prerelease ?? "")
}

function satisfiesComparator(version: ParsedVersion, comparator: string): boolean | undefined {
    const match = /^(>=|<=|>|<|=)?\s*(v?\d+(?:\.\d+)?(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)$/.exec(comparator.trim())
    if (!match) return undefined
    const target = parseVersion(match[2])
    if (!target) return undefined
    const comparison = compareVersions(version, target)
    const operator = match[1] ?? "="
    if (operator === ">=") return comparison >= 0
    if (operator === "<=") return comparison <= 0
    if (operator === ">") return comparison > 0
    if (operator === "<") return comparison < 0
    return comparison === 0
}

function satisfiesSimpleRange(version: ParsedVersion, range: string): boolean | undefined {
    const trimmed = range.trim()
    if (trimmed === "*" || trimmed === "latest") return true
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed)
    if (hyphen) {
        const minimum = satisfiesComparator(version, `>=${hyphen[1]}`)
        const maximum = satisfiesComparator(version, `<=${hyphen[2]}`)
        return minimum === undefined || maximum === undefined ? undefined : minimum && maximum
    }
    if (trimmed.startsWith("^") || trimmed.startsWith("~")) {
        const rawBase = trimmed.slice(1).replace(/^v/, "")
        const base = parseVersion(rawBase)
        if (!base) return undefined
        const specifiedParts = rawBase.split(".").length
        const lower = compareVersions(version, base) >= 0
        const upper = trimmed.startsWith("~")
            ? specifiedParts === 1
                ? version.major === base.major
                : version.major === base.major && version.minor === base.minor
            : base.major > 0
                ? version.major === base.major
                : specifiedParts === 1
                    ? version.major === 0
                : base.minor > 0
                    ? version.major === 0 && version.minor === base.minor
                    : specifiedParts === 2
                        ? version.major === 0 && version.minor === 0
                    : version.major === 0 && version.minor === 0 && version.patch === base.patch
        return lower && upper
    }
    if (/^[v\d]+(?:\.[xX*\d]+){0,2}$/.test(trimmed) && /[xX*]|^v?\d+$|^v?\d+\.\d+$/.test(trimmed)) {
        const parts = trimmed.replace(/^v/, "").split(".")
        const numbers = parts.map((part: string): number | undefined => /^[xX*]$/.test(part) ? undefined : Number(part))
        return (numbers[0] === undefined || version.major === numbers[0])
            && (numbers[1] === undefined || version.minor === numbers[1])
            && (numbers[2] === undefined || version.patch === numbers[2])
    }
    const comparators = trimmed.split(/\s+/).filter((part: string): boolean => Boolean(part))
    if (comparators.length === 0) return undefined
    const results = comparators.map((comparator: string): boolean | undefined => satisfiesComparator(version, comparator))
    return results.some((result: boolean | undefined): boolean => result === undefined) ? undefined : results.every(Boolean)
}

function satisfiesVersion(version: string, range: string): boolean {
    const parsed = parseVersion(version)
    if (!parsed) return false
    const requestedRange = range.trim()
    if (isNpmTag(requestedRange) && !isSemverRange(requestedRange)) return true
    const alternatives = requestedRange.split("||")
    return alternatives.some((alternative: string): boolean => satisfiesSimpleRange(parsed, alternative) === true)
}

type ManagedAgentsBlock = { startIndex: number, endIndex: number }
type ManagedScriptAuthoringContext = { directory: string, worktree: string }

function findManagedAgentsBlock(content: string): ManagedAgentsBlock | undefined {
    let startIndex = content.indexOf(managedAgentsStartMarker)
    while (startIndex !== -1) {
        const afterStart = startIndex + managedAgentsStartMarker.length
        const endIndex = content.indexOf(managedAgentsEndMarker, afterStart)
        const nextStartIndex = content.indexOf(managedAgentsStartMarker, afterStart)
        if (endIndex !== -1 && (nextStartIndex === -1 || endIndex < nextStartIndex)) {
            return { startIndex, endIndex: endIndex + managedAgentsEndMarker.length }
        }
        startIndex = nextStartIndex
    }
    return undefined
}

async function collectSourceScripts(
    fileSystem: ManagedScriptProjectFileSystem,
    sourceRoot: string,
): Promise<string[]> {
    const readStats = fileSystem.lstat
    if (!readStats) return []

    const readSourceStats = async (candidatePath: string): Promise<ManagedScriptProjectFileStats | undefined> => {
        try {
            return await readStats(candidatePath)
        }
        catch (error) {
            if (isMissingFile(error)) return undefined
            throw error
        }
    }
    const rootStats = await readSourceStats(sourceRoot)
    if (!rootStats) return []
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) return []

    const scripts: string[] = []
    const visit = async (directoryPath: string, relativeDirectory: string): Promise<void> => {
        let entries: string[] | import("node:fs").Dirent[]
        try {
            entries = await fileSystem.readdir(directoryPath, { withFileTypes: true })
        }
        catch (error) {
            if (isMissingFile(error)) return
            throw error
        }
        for (const entry of entries) {
            if (typeof entry === "string" || entry.isSymbolicLink()) continue
            const entryPath = path.join(directoryPath, entry.name)
            const relativePath = path.join(relativeDirectory, entry.name)
            const entryStats = await readSourceStats(entryPath)
            if (!entryStats) continue
            if (entryStats.isSymbolicLink()) continue
            if (entryStats.isFile()) {
                scripts.push(relativePath)
                continue
            }
            if (entryStats.isDirectory()) await visit(entryPath, relativePath)
        }
    }

    await visit(sourceRoot, "")
    return scripts.sort()
}

async function createManagedAgentsBlock(
    fileSystem: ManagedScriptProjectFileSystem,
    paths: ManagedScriptProjectPaths,
    authoringContext: ManagedScriptAuthoringContext,
    lineBreak: string,
): Promise<string> {
    const sourceScripts = await collectSourceScripts(fileSystem, paths.sourceRoot)
    const sourceIndex = sourceScripts.length === 0
        ? ["- None."]
        : sourceScripts.map((sourceScript: string): string => `- \`${sourceScript}\``)
    return [
        managedAgentsStartMarker,
        "# Managed scripts",
        "",
        "## Authoring context",
        "",
        `- Original authoring directory: \`${authoringContext.directory}\``,
        `- Original authoring worktree: \`${authoringContext.worktree}\``,
        "",
        "## Managed project paths",
        "",
        `- Workspace job root: \`${paths.workspacePath}\``,
        `- Scripts project root: \`${paths.scriptsRoot}\``,
        `- Source root: \`${paths.sourceRoot}\``,
        `- Manifest: \`${paths.manifestPath}\``,
        `- Lockfile: \`${paths.lockPath}\``,
        `- node_modules: \`${paths.nodeModulesPath}\``,
        `- Logs root: \`${paths.logsPath}\``,
        `- Services state root: \`${paths.servicesPath}\``,
        `- Guidance file: \`${paths.agentsPath}\``,
        "",
        "## Existing source scripts",
        "",
        "Regular files relative to `src`:",
        ...sourceIndex,
        "",
        "Keep script sources in `src`.",
        "",
        "Inspect and reuse existing source files before editing. Use built-in `read`, `write`, `edit`, `glob`, and `grep` tools under returned `src` root.",
        "",
        "## Managed tools and lifecycle",
        "",
        "- Use `autocode_script_project` to set up or reuse this project.",
        "- After `package.json` or dependency-manifest edits, use `autocode_script_install`.",
        "- Use `autocode_script_run` for finite work.",
        "- Use `autocode_script_service` with `start`, `status`, or `stop` for long-lived work; retain and use its `run_id`.",
        "- Owned services stop automatically on abort, terminal session events, and disposal; explicitly stop services when no longer needed.",
        "- Never edit `node_modules` or `package-lock.json` manually.",
        "- Never use direct shell, PTY, sandbox CLI, or generic process kill tools.",
        managedAgentsEndMarker,
    ].join(lineBreak)
}

function readManagedAuthoringContext(content: string, block: ManagedAgentsBlock): ManagedScriptAuthoringContext | undefined {
    const managedContent = content.slice(block.startIndex, block.endIndex)
    const match = /(?:^|\r?\n)## Authoring context\r?\n\r?\n- Original authoring directory: `([^`\r\n]+)`\r?\n- Original authoring worktree: `([^`\r\n]+)`(?=\r?\n|$)/.exec(managedContent)
    return match ? { directory: match[1], worktree: match[2] } : undefined
}

function getManagedAgentsLineBreak(content: string | undefined): string {
    return content?.includes("\r\n") ? "\r\n" : "\n"
}

function appendManagedAgentsBlock(content: string, block: string, lineBreak: string): string {
    if (!content) return block
    const separator = content.endsWith(`${lineBreak}${lineBreak}`)
        ? ""
        : content.endsWith(lineBreak)
            ? lineBreak
            : `${lineBreak}${lineBreak}`
    return `${content}${separator}${block}`
}

function updateManagedAgentsContent(current: string | undefined, block: string, lineBreak: string): string {
    if (current === undefined || current === legacyAgentsInstructions) return block
    const existingBlock = findManagedAgentsBlock(current)
    return existingBlock
        ? `${current.slice(0, existingBlock.startIndex)}${block}${current.slice(existingBlock.endIndex)}`
        : appendManagedAgentsBlock(current, block, lineBreak)
}

async function refreshManagedAgents(
    fileSystem: ManagedScriptProjectFileSystem,
    paths: ManagedScriptProjectPaths,
    context: SessionJobContext,
): Promise<void> {
    const current = await readOptionalFile(fileSystem, paths.agentsPath)
    const existingBlock = current === undefined ? undefined : findManagedAgentsBlock(current)
    const authoringContext = existingBlock && current
        ? readManagedAuthoringContext(current, existingBlock) ?? { directory: context.directory, worktree: context.worktree }
        : { directory: context.directory, worktree: context.worktree }
    const lineBreak = getManagedAgentsLineBreak(current)
    const block = await createManagedAgentsBlock(fileSystem, paths, authoringContext, lineBreak)
    const content = updateManagedAgentsContent(current, block, lineBreak)
    if (content !== current) await writeAtomically(fileSystem, paths.agentsPath, content)
}

async function ensureProjectLayout(
    fileSystem: ManagedScriptProjectFileSystem,
    paths: ManagedScriptProjectPaths,
    context: SessionJobContext,
): Promise<void> {
    await fileSystem.mkdir(paths.sourceRoot, { recursive: true })
    await fileSystem.mkdir(paths.logsPath, { recursive: true })
    await refreshManagedAgents(fileSystem, paths, context)
}

async function writeAtomically(fileSystem: Pick<ManagedScriptProjectFileSystem, "mkdir" | "rename" | "writeFile">, filePath: string, content: string): Promise<void> {
    const temporaryPath = `${filePath}.autocode-tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await fileSystem.mkdir(path.dirname(filePath), { recursive: true })
    await fileSystem.writeFile(temporaryPath, content)
    await fileSystem.rename(temporaryPath, filePath)
}

async function snapshotProject(fileSystem: Pick<ManagedScriptProjectFileSystem, "readFile">, paths: ManagedScriptProjectPaths): Promise<ManifestSnapshot> {
    return { manifest: await readOptionalFile(fileSystem, paths.manifestPath), lock: await readOptionalFile(fileSystem, paths.lockPath) }
}

async function restoreSnapshot(fileSystem: ManagedScriptProjectFileSystem, paths: ManagedScriptProjectPaths, snapshot: ManifestSnapshot): Promise<void> {
    if (snapshot.manifest === undefined) await fileSystem.rm(paths.manifestPath, { force: true })
    else await writeAtomically(fileSystem, paths.manifestPath, snapshot.manifest)
    if (snapshot.lock === undefined) await fileSystem.rm(paths.lockPath, { force: true })
    else await writeAtomically(fileSystem, paths.lockPath, snapshot.lock)
}

async function stageNodeModules(fileSystem: ManagedScriptProjectFileSystem, paths: ManagedScriptProjectPaths): Promise<NodeModulesStage> {
    if (!await pathExists(fileSystem, paths.nodeModulesPath)) return {}
    const backupPath = `${paths.nodeModulesPath}.autocode-backup-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await fileSystem.rename(paths.nodeModulesPath, backupPath)
    return { backupPath }
}

async function restoreStagedNodeModules(fileSystem: ManagedScriptProjectFileSystem, paths: ManagedScriptProjectPaths, stage: NodeModulesStage): Promise<void> {
    if (!stage.backupPath) {
        if (await pathExists(fileSystem, paths.nodeModulesPath)) await fileSystem.rm(paths.nodeModulesPath, { recursive: true, force: true })
        return
    }
    if (!await pathExists(fileSystem, stage.backupPath)) throw new Error("Managed node_modules backup is missing; refusing to remove current node_modules.")
    if (await pathExists(fileSystem, paths.nodeModulesPath)) await fileSystem.rm(paths.nodeModulesPath, { recursive: true, force: true })
    await fileSystem.rename(stage.backupPath, paths.nodeModulesPath)
}

async function discardStagedNodeModules(fileSystem: ManagedScriptProjectFileSystem, stage: NodeModulesStage): Promise<void> {
    if (stage.backupPath) await fileSystem.rm(stage.backupPath, { recursive: true, force: true })
}

async function rollbackProject(fileSystem: ManagedScriptProjectFileSystem, paths: ManagedScriptProjectPaths, snapshot: ManifestSnapshot, stage: NodeModulesStage): Promise<string | undefined> {
    const failures: string[] = []
    try {
        await restoreStagedNodeModules(fileSystem, paths, stage)
    }
    catch (error) {
        failures.push(`node_modules restore failed: ${flattenError(error)}`)
    }
    try {
        await restoreSnapshot(fileSystem, paths, snapshot)
    }
    catch (error) {
        failures.push(`manifest rollback failed: ${flattenError(error)}`)
    }
    return failures.length > 0 ? failures.join("; ") : undefined
}

async function createRollbackFailure(
    fileSystem: ManagedScriptProjectFileSystem,
    paths: ManagedScriptProjectPaths,
    snapshot: ManifestSnapshot,
    stage: NodeModulesStage,
    dependencies: ManagedScriptProjectDependency[],
    error: ManagedScriptProjectFailure,
    npm?: ManagedScriptProjectNpmResult,
): Promise<ManagedScriptProjectResult> {
    const rollbackError = await rollbackProject(fileSystem, paths, snapshot, stage)
    return {
        ok: false,
        paths,
        dependencies,
        ...(npm ? { npm } : {}),
        error: rollbackError
            ? { code: error.code, message: `${error.message} ${rollbackError}` }
            : { code: error.code, message: `${error.message} Prior manifest, lockfile, and node_modules state was restored.` },
    }
}

async function checkRuntime(spawn: ManagedScriptProjectSpawn, runtime: ManagedScriptProjectRuntime): Promise<ManagedScriptProjectBlocker | undefined> {
    const node = runtime.nodeVersion ? await runtime.nodeVersion() : await spawn("node", ["--version"], { env: runtime.env })
    const nodeMajor = /^v?(\d+)\./.exec(node.stdout.trim())?.[1]
    if (node.exitCode !== 0 || !nodeMajor || Number(nodeMajor) < 20) {
        return { code: "runtime_unavailable", message: "Node.js 20 or newer is required for managed scripts." }
    }
    const npm = runtime.npmVersion ? await runtime.npmVersion() : await spawn("npm", ["--version"], { env: runtime.env })
    if (npm.exitCode !== 0 || !npm.stdout.trim()) return { code: "runtime_unavailable", message: "npm is required for managed scripts." }
    return undefined
}

function createNpmLogPath(paths: ManagedScriptProjectPaths): string {
    return path.join(paths.logsPath, `npm-${new Date().toISOString().replace(/[:.]/g, "-")}.log`)
}

async function writeNpmLog(fileSystem: Pick<ManagedScriptProjectFileSystem, "writeFile">, logPath: string, command: readonly string[], result: ManagedScriptProjectCommandResult): Promise<void> {
    const content = [`command: npm ${command.join(" ")}`, `exit_code: ${result.exitCode}`, "", "stdout:", result.stdout, "", "stderr:", result.stderr, ""].join("\n")
    await fileSystem.writeFile(logPath, content)
}

async function createReconciledManifest(
    fileSystem: Pick<ManagedScriptProjectFileSystem, "readFile">,
    paths: ManagedScriptProjectPaths,
    requestedDependencies: Record<string, string>,
    resolutionFile: string,
    resolvePackage: (packageName: string, fromFile: string) => Promise<ManagedScriptProjectResolvedPackage | undefined>,
): Promise<{ manifest: ManagedManifest, inherited: ManagedScriptProjectDependency[], requestedDependencies: Record<string, string> }> {
    const manifest = parseManifest(await readOptionalFile(fileSystem, paths.manifestPath))
    const inheritedRequests = Object.entries(manifest.inheritedDependencies).reduce<Record<string, string>>((result: Record<string, string>, [name, dependency]: [string, InheritedDependency]): Record<string, string> => {
        result[name] = dependency.requestedRange
        return result
    }, {})
    const managedDependencies = { ...inheritedRequests, ...requestedDependencies }
    const inherited: ManagedScriptProjectDependency[] = []
    for (const [name, requestedRange] of Object.entries(managedDependencies)) {
        if (manifest.dependencies[name] !== undefined) {
            manifest.dependencies[name] = requestedRange
            delete manifest.inheritedDependencies[name]
            continue
        }
        const resolved = await resolveInheritedPackage(name, requestedRange, resolutionFile, paths, resolvePackage)
        if (!resolved) {
            manifest.dependencies[name] = requestedRange
            delete manifest.inheritedDependencies[name]
            continue
        }
        manifest.inheritedDependencies[name] = {
            version: resolved.version,
            packagePath: resolved.packagePath,
            workspacePath: resolved.workspacePath,
            requestedRange,
        }
        inherited.push({ name, requestedRange, source: "inherited", version: resolved.version, packagePath: resolved.packagePath, workspacePath: resolved.workspacePath })
    }
    return { manifest, inherited, requestedDependencies: managedDependencies }
}

async function verifyLocalDependencies(
    fileSystem: Pick<ManagedScriptProjectFileSystem, "readFile">,
    paths: ManagedScriptProjectPaths,
    manifest: ManagedManifest,
    requestedDependencies: Record<string, string>,
): Promise<ManagedScriptProjectDependency[] | ManagedScriptProjectFailure> {
    const local: ManagedScriptProjectDependency[] = []
    for (const [name, requestedRange] of Object.entries(requestedDependencies)) {
        if (manifest.dependencies[name] === undefined) continue
        const resolved = await readLocalPackage(fileSystem, paths, name)
        if (!resolved || !satisfiesVersion(resolved.version, requestedRange)) {
            return { code: "dependency_unsatisfied", message: `Local dependency ${name} does not satisfy requested range ${requestedRange} after npm install.` }
        }
        local.push({ name, requestedRange, source: "local", version: resolved.version, packagePath: resolved.packagePath })
    }
    return local
}

function isFailure(value: ManagedScriptProjectDependency[] | ManagedScriptProjectFailure): value is ManagedScriptProjectFailure {
    return !Array.isArray(value)
}

async function reconcileProject(
    dependencies: ManagedScriptProjectDependencies,
    fileSystem: ManagedScriptProjectFileSystem,
    spawn: ManagedScriptProjectSpawn,
    runtime: ManagedScriptProjectRuntime,
    input: ManagedScriptProjectSetupInput,
): Promise<ManagedScriptProjectResult> {
    let owner: ManagedScriptProjectOwnerResolution
    try {
        owner = dependencies.resolveOwner
            ? await dependencies.resolveOwner()
            : await resolveManagedScriptProjectOwner({ client: dependencies.client, context: dependencies.context, fileSystem })
    }
    catch (error) {
        return { ok: false, blocker: { code: "job_workspace_required", message: `Unable to resolve current job workspace: ${flattenError(error)}` } }
    }
    if (!owner.ok) return { ok: false, blocker: { code: "job_workspace_required", message: owner.reason } }

    const paths = createManagedScriptProjectPaths(owner.owner.workspacePath)
    const requestedDependencies = input.dependencies ?? {}
    const dependencyError = validateDependencies(requestedDependencies)
    if (dependencyError) return { ok: false, paths, blocker: { code: "invalid_dependency", message: dependencyError } }
    const resolutionFile = path.join(paths.sourceRoot, "__autocode_resolution__.cjs")

    let runtimeBlocker: ManagedScriptProjectBlocker | undefined
    try {
        runtimeBlocker = await checkRuntime(spawn, runtime)
    }
    catch (error) {
        runtimeBlocker = { code: "runtime_unavailable", message: `Unable to check managed-script runtime: ${flattenError(error)}` }
    }
    if (runtimeBlocker) return { ok: false, paths, blocker: runtimeBlocker }

    let snapshot: ManifestSnapshot | undefined
    let stage: NodeModulesStage | undefined
    let reconciled: { manifest: ManagedManifest, inherited: ManagedScriptProjectDependency[], requestedDependencies: Record<string, string> } | undefined
    let npm: ManagedScriptProjectNpmResult | undefined
    try {
        await ensureProjectLayout(fileSystem, paths, dependencies.context)
        snapshot = await snapshotProject(fileSystem, paths)
        const resolvePackage = dependencies.resolvePackage ?? (async (packageName: string, fromFile: string): Promise<ManagedScriptProjectResolvedPackage | undefined> => await defaultResolvePackage(fileSystem, packageName, fromFile))
        reconciled = await createReconciledManifest(fileSystem, paths, requestedDependencies, resolutionFile, resolvePackage)
        stage = await stageNodeModules(fileSystem, paths)
        await writeAtomically(fileSystem, paths.manifestPath, writeManifest(reconciled.manifest))

        let commandResult: ManagedScriptProjectCommandResult
        try {
            commandResult = await spawn("npm", npmInstallArgs, { cwd: paths.scriptsRoot, env: runtime.env })
        }
        catch (error) {
            commandResult = { exitCode: null, stdout: "", stderr: flattenError(error) }
        }
        npm = { ...commandResult, command: npmInstallArgs, logPath: createNpmLogPath(paths) }
        try {
            await writeNpmLog(fileSystem, npm.logPath, npmInstallArgs, commandResult)
        }
        catch (error) {
            return await createRollbackFailure(
                fileSystem,
                paths,
                snapshot,
                stage,
                reconciled.inherited,
                { code: "filesystem_error", message: `Unable to write npm install log: ${flattenError(error)}` },
                npm,
            )
        }
        if (commandResult.exitCode !== 0) {
            return await createRollbackFailure(fileSystem, paths, snapshot, stage, reconciled.inherited, { code: "npm_install_failed", message: "npm install failed." }, npm)
        }
        if (!await pathExists(fileSystem, paths.lockPath) || !await pathExists(fileSystem, paths.nodeModulesPath)) {
            return await createRollbackFailure(fileSystem, paths, snapshot, stage, reconciled.inherited, { code: "npm_install_failed", message: "npm install completed without creating required package-lock.json and node_modules." }, npm)
        }
        const local = await verifyLocalDependencies(fileSystem, paths, reconciled.manifest, reconciled.requestedDependencies)
        if (isFailure(local)) return await createRollbackFailure(fileSystem, paths, snapshot, stage, reconciled.inherited, local, npm)
        const resolvedDependencies = [...reconciled.inherited, ...local]
        try {
            await discardStagedNodeModules(fileSystem, stage)
        }
        catch (error) {
            return { ok: false, paths, dependencies: resolvedDependencies, npm, error: { code: "filesystem_error", message: `npm install succeeded, but prior node_modules backup could not be removed: ${flattenError(error)}` } }
        }
        return { ok: true, paths, dependencies: resolvedDependencies, npm }
    }
    catch (error) {
        const message = flattenError(error)
        const invalidManifest = message.includes("scripts/package.json")
        if (snapshot && stage) {
            return await createRollbackFailure(
                fileSystem,
                paths,
                snapshot,
                stage,
                reconciled?.inherited ?? [],
                { code: "filesystem_error", message: `Managed script setup failed: ${message}` },
                npm,
            )
        }
        return {
            ok: false,
            paths,
            blocker: invalidManifest ? { code: "invalid_manifest", message } : undefined,
            error: invalidManifest ? undefined : { code: "filesystem_error", message: `Managed script setup failed: ${message}` },
        }
    }
}

export function createManagedScriptProject(dependencies: ManagedScriptProjectDependencies): ManagedScriptProject {
    const fileSystem = dependencies.fileSystem ?? defaultFileSystem
    const spawn = dependencies.spawn ?? defaultSpawn
    const runtime: ManagedScriptProjectRuntime = {
        env: dependencies.runtime?.env ?? process.env,
        ...(dependencies.runtime?.nodeVersion ? { nodeVersion: dependencies.runtime.nodeVersion } : {}),
        ...(dependencies.runtime?.npmVersion ? { npmVersion: dependencies.runtime.npmVersion } : {}),
    }
    const reconcile = async (input: ManagedScriptProjectSetupInput = {}): Promise<ManagedScriptProjectResult> => await reconcileProject(dependencies, fileSystem, spawn, runtime, input)
    return { setup: reconcile, install: reconcile, reconcile }
}
