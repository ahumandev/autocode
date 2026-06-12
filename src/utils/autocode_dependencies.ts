import { homedir } from "os"
import path from "path"
import { flattenError } from "@/utils/tools"
import { defaultSandboxDependencies, detectSandboxBackend, hasTermuxEnvironmentSignal, type SandboxDependencies } from "@/utils/sandbox"

export const MINIMUM_OPENCODE_VERSION = "1.14.28"

export type DependencyStatus = "ok" | "upgrade_required" | "missing" | "unknown" | "unsupported" | "unusable"

export type DependencyReport = Record<string, unknown> & {
    ok: boolean
    status: DependencyStatus
    guidance?: string
}

export type DependencyInspectionContext = {
    directory?: string
    worktree?: string
}

export type DependencyDebugEvent = {
    dependency: string
    stage: "path_check" | "config_paths" | "config_file" | "config_match" | "final"
    status?: string
    reason?: string
    command?: string
    exists?: boolean
    path?: string
    version?: string
    config_path?: string
    config_paths?: string[]
    outcome?: "read" | "missing" | "parse_failed"
    error?: string
    section?: string
    key?: string
    detection_source?: "config_entry" | "launcher_command"
    configured_command?: string
}

export type DependencyInspectionOptions = {
    debug?: boolean
    debugLog?: (event: DependencyDebugEvent) => void
}

type OptionalDependencyDefinition = {
    key: string
    packageName: string
    bins: readonly string[]
    aliases: readonly string[]
    installCommand: string
    docsUrl: string
    guidance: string
    notes?: string
}

type ConfigDetection = {
    configPath: string
    configuredCommand?: string
    detectionSource: "config_entry" | "launcher_command"
    section?: string
    key?: string
}

type CommandInspection = {
    command: string
    path?: string
    version?: string
}

type OptionalDependencyStatus = DependencyStatus | "skipped"

type Version = {
    major: number
    minor: number
    patch: number
}

type ParsedConfigFile = {
    status: "read" | "missing" | "parse_failed"
    parsed?: unknown
    error?: string
}

type DebugEmitter = (event: DependencyDebugEvent) => void

function createDebugEmitter(options: DependencyInspectionOptions): DebugEmitter {
    if (options.debug !== true && typeof options.debugLog !== "function") {
        return (): void => {}
    }

    return (event: DependencyDebugEvent): void => {
        options.debugLog?.(event)
    }
}

function stripJsoncComments(raw: string): string {
    let result = ""
    let i = 0
    while (i < raw.length) {
        if (raw[i] === '"') {
            result += raw[i++]
            while (i < raw.length) {
                const ch = raw[i]
                result += ch
                if (ch === "\\" && i + 1 < raw.length) {
                    i++
                    result += raw[i]
                } else if (ch === '"') {
                    break
                }
                i++
            }
            i++
            continue
        }
        if (raw[i] === "/" && raw[i + 1] === "/") {
            while (i < raw.length && raw[i] !== "\n") i++
            continue
        }
        if (raw[i] === "/" && raw[i + 1] === "*") {
            i += 2
            while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++
            i += 2
            continue
        }
        result += raw[i++]
    }

    return result.replace(/,(\s*[}\]])/g, "$1")
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeMatcherValue(value: string): string {
    return value.toLowerCase().replace(/\\/g, "/")
}

function normalizeCommandValue(value: string): string {
    return value.trim().replace(/\\/g, "/")
}

function normalizeAliasValue(value: string): string {
    return normalizeMatcherValue(value).replace(/\.(cmd|exe|bat|ps1|mjs|cjs|js|py|jar)$/g, "")
}

function tokenizeCommandLine(input: string): string[] {
    return input.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^['"]|['"]$/g, "")) ?? []
}

function getNormalizedAliases(definition: OptionalDependencyDefinition): string[] {
    return Array.from(new Set([definition.packageName, ...definition.bins, ...definition.aliases].map(normalizeAliasValue).filter(Boolean)))
}

function getTokenAliasForms(token: string): string[] {
    const normalizedToken = normalizeMatcherValue(token)
    const basename = path.posix.basename(normalizedToken)
    const forms = new Set<string>([
        normalizeAliasValue(normalizedToken),
        normalizeAliasValue(basename),
    ])

    for (const segment of normalizedToken.split("/")) {
        const normalizedSegment = normalizeAliasValue(segment)
        if (normalizedSegment) forms.add(normalizedSegment)
    }

    return [...forms].filter(Boolean)
}

function tokenMatchesAliases(token: string, aliases: readonly string[]): boolean {
    const forms = getTokenAliasForms(token)
    return aliases.some((alias) => forms.includes(alias))
}

function stripPackageVersion(token: string): string {
    const trimmed = token.trim()
    if (!trimmed.startsWith("@")) return trimmed.replace(/@[^/]+$/, "")
    const slashIndex = trimmed.indexOf("/")
    if (slashIndex === -1) return trimmed
    const versionIndex = trimmed.indexOf("@", slashIndex + 1)
    return versionIndex === -1 ? trimmed : trimmed.slice(0, versionIndex)
}

function getFirstNonOption(args: readonly string[], start = 0): string | undefined {
    for (let index = start; index < args.length; index++) {
        if (!args[index]?.startsWith("-")) return args[index]
    }
    return undefined
}

function unwrapWindowsCommand(command: string, args: readonly string[]): { command: string, args: readonly string[] } {
    const base = normalizeAliasValue(path.posix.basename(normalizeMatcherValue(command)))
    if (base !== "cmd") return { command, args }

    const switchIndex = args.findIndex((arg) => /^(\/(c|s))$/i.test(arg))
    if (switchIndex === -1) return { command, args }

    const nested = args.slice(switchIndex + 1)
    if (nested.length === 0) return { command, args }
    if (nested.length === 1) {
        const tokens = tokenizeCommandLine(nested[0])
        if (tokens.length === 0) return { command, args }
        return { command: tokens[0], args: tokens.slice(1) }
    }

    return { command: nested[0], args: nested.slice(1) }
}

function getStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function matchLauncherCommand(command: string, args: readonly string[], definition: OptionalDependencyDefinition): string | undefined {
    const aliases = getNormalizedAliases(definition)
    const normalizedCommand = normalizeCommandValue(command)
    const base = normalizeAliasValue(path.posix.basename(normalizeMatcherValue(command)))
    if (tokenMatchesAliases(normalizedCommand, aliases)) return [command, ...args].join(" ")

    if (base === "npx" || base === "uvx") {
        const target = getFirstNonOption(args)
        if (target && tokenMatchesAliases(stripPackageVersion(target), aliases)) return [command, ...args].join(" ")
        return undefined
    }

    if (base === "pipx") {
        const runIndex = args.findIndex((arg) => arg === "run")
        const target = runIndex >= 0 ? getFirstNonOption(args, runIndex + 1) : getFirstNonOption(args)
        if (target && tokenMatchesAliases(stripPackageVersion(target), aliases)) return [command, ...args].join(" ")
        return undefined
    }

    if (["node", "python", "python3", "java"].includes(base)) {
        for (let index = 0; index < args.length; index++) {
            const token = args[index]
            if (base === "java" && token === "-jar") continue
            if (tokenMatchesAliases(token, aliases)) return [command, ...args].join(" ")
            if (base === "java" && args[index - 1] === "-jar" && tokenMatchesAliases(token, aliases)) return [command, ...args].join(" ")
        }
    }

    return undefined
}

function getConfigCommand(value: Record<string, unknown>): { command: string, args: readonly string[] } | undefined {
    const extraArgs = getStringArray(value.args)
    if (typeof value.command === "string") return unwrapWindowsCommand(value.command, extraArgs)

    const commandTokens = getStringArray(value.command)
    if (commandTokens.length === 0) return undefined
    return unwrapWindowsCommand(commandTokens[0], [...commandTokens.slice(1), ...extraArgs])
}

function getConfigEntryAliases(value: Record<string, unknown>): string[] {
    const aliases: string[] = []
    for (const key of ["name", "id", "server", "package", "module"] as const) {
        if (typeof value[key] === "string") aliases.push(value[key])
    }
    return aliases
}

function resolveConfigPath(candidate: string, context: DependencyInspectionContext): string {
    if (path.isAbsolute(candidate)) return path.resolve(candidate)
    if (context.directory) return path.resolve(context.directory, candidate)
    if (context.worktree) return path.resolve(context.worktree, candidate)
    return path.resolve(candidate)
}

function isSupplementalConfigFileName(name: string): boolean {
    return /\.opencode\.jsonc?$/.test(name)
}

async function addConfigDirectoryCandidates(directory: string, deps: SandboxDependencies, candidates: Set<string>): Promise<void> {
    candidates.add(path.resolve(path.join(directory, "opencode.jsonc")))
    candidates.add(path.resolve(path.join(directory, "opencode.json")))

    try {
        const entries = await deps.fileSystem.readdir(directory)
        for (const entry of entries) {
            const name = typeof entry === "string" ? entry : entry.name
            if (!isSupplementalConfigFileName(name)) continue
            candidates.add(path.resolve(path.join(directory, name)))
        }
    }
    catch {
        return
    }
}

async function getCandidateConfigPaths(env: NodeJS.ProcessEnv, context: DependencyInspectionContext, deps: SandboxDependencies): Promise<string[]> {
    const candidates = new Set<string>()
    const globalBase = path.join(env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "opencode")

    await addConfigDirectoryCandidates(globalBase, deps, candidates)
    if (typeof env.OPENCODE_CONFIG === "string" && env.OPENCODE_CONFIG.length > 0) {
        candidates.add(resolveConfigPath(env.OPENCODE_CONFIG, context))
    }

    if (context.worktree) await addConfigDirectoryCandidates(path.join(path.resolve(context.worktree), ".opencode"), deps, candidates)
    if (context.directory) await addConfigDirectoryCandidates(path.join(path.resolve(context.directory), ".opencode"), deps, candidates)

    if (context.worktree && context.directory) {
        const resolvedWorktree = path.resolve(context.worktree)
        let current = path.resolve(context.directory)
        const relative = path.relative(resolvedWorktree, current)
        if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
            while (true) {
                await addConfigDirectoryCandidates(path.join(current, ".opencode"), deps, candidates)
                if (current === resolvedWorktree) break
                const parent = path.dirname(current)
                if (parent === current) break
                current = parent
            }
        }
    }

    return [...candidates]
}

async function readConfigFile(filePath: string, deps: SandboxDependencies): Promise<ParsedConfigFile> {
    try {
        const content = await deps.fileSystem.readFile(filePath, "utf8")
        try {
            return { status: "read", parsed: JSON.parse(stripJsoncComments(content)) }
        }
        catch (error) {
            return { status: "parse_failed", error: flattenError(error) }
        }
    }
    catch (error) {
        const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined
        return { status: code === "ENOENT" ? "missing" : "parse_failed", error: flattenError(error) }
    }
}

function getConfigNodeName(value: Record<string, unknown>, index: number): string | undefined {
    for (const key of ["name", "id", "server", "package", "module"] as const) {
        if (typeof value[key] === "string" && value[key].length > 0) return value[key]
    }
    return `index:${index}`
}

function detectMcpConfigNode(value: unknown, definition: OptionalDependencyDefinition, parentKey?: string): Omit<ConfigDetection, "configPath"> | undefined {
    if (!isRecord(value)) return undefined

    const aliases = getNormalizedAliases(definition)
    if (parentKey && tokenMatchesAliases(parentKey, aliases)) {
        const command = getConfigCommand(value)
        const matchedCommand = command ? matchLauncherCommand(command.command, command.args, definition) : undefined
        return matchedCommand === undefined
            ? { detectionSource: "config_entry", key: parentKey }
            : { detectionSource: "launcher_command", configuredCommand: matchedCommand, key: parentKey }
    }

    const entryAliases = getConfigEntryAliases(value)
    if (entryAliases.some((alias) => tokenMatchesAliases(alias, aliases))) {
        const command = getConfigCommand(value)
        const matchedCommand = command ? matchLauncherCommand(command.command, command.args, definition) : undefined
        return matchedCommand === undefined
            ? { detectionSource: "config_entry", key: parentKey }
            : { detectionSource: "launcher_command", configuredCommand: matchedCommand, key: parentKey }
    }

    const command = getConfigCommand(value)
    const matchedCommand = command ? matchLauncherCommand(command.command, command.args, definition) : undefined
    if (matchedCommand) return { detectionSource: "launcher_command", configuredCommand: matchedCommand, key: parentKey }

    return undefined
}

function inspectMcpSection(value: unknown, definition: OptionalDependencyDefinition, section: string): Omit<ConfigDetection, "configPath"> | undefined {
    if (isRecord(value)) {
        for (const [key, child] of Object.entries(value)) {
            const detection = detectMcpConfigNode(child, definition, key)
            if (detection) return { ...detection, section }
        }
    }

    if (Array.isArray(value)) {
        for (const [index, child] of value.entries()) {
            const key = isRecord(child) ? getConfigNodeName(child, index) : `index:${index}`
            const detection = detectMcpConfigNode(child, definition, key)
            if (detection) return { ...detection, section }
        }
    }

    return undefined
}

function findConfigDetection(value: unknown, definition: OptionalDependencyDefinition): Omit<ConfigDetection, "configPath"> | undefined {
    if (!isRecord(value)) return undefined

    const sections: Array<{ name: string, value: unknown }> = []
    sections.push({ name: "mcp", value: value.mcp })
    if (isRecord(value.mcp)) {
        const mcp = value.mcp
        sections.push({ name: "mcp.servers", value: mcp.servers })
        sections.push({ name: "mcp.mcpServers", value: mcp.mcpServers })
    }
    sections.push({ name: "mcpServers", value: value.mcpServers })

    for (const section of sections) {
        const detection = inspectMcpSection(section.value, definition, section.name)
        if (detection) return detection
    }

    return undefined
}

async function inspectConfigForOptionalMcp(definition: OptionalDependencyDefinition, deps: SandboxDependencies, context: DependencyInspectionContext, emitDebug: DebugEmitter): Promise<ConfigDetection | undefined> {
    const candidateConfigPaths = await getCandidateConfigPaths(deps.process.env, context, deps)
    emitDebug({ dependency: definition.key, stage: "config_paths", config_paths: candidateConfigPaths })

    for (const configPath of candidateConfigPaths) {
        const parsedConfig = await readConfigFile(configPath, deps)
        emitDebug({
            dependency: definition.key,
            stage: "config_file",
            config_path: configPath,
            outcome: parsedConfig.status,
            error: parsedConfig.error,
        })
        if (parsedConfig.status !== "read") continue

        const detection = findConfigDetection(parsedConfig.parsed, definition)
        if (detection) {
            emitDebug({
                dependency: definition.key,
                stage: "config_match",
                config_path: configPath,
                section: detection.section,
                key: detection.key,
                detection_source: detection.detectionSource,
                configured_command: detection.configuredCommand,
            })
            return { ...detection, configPath }
        }
    }

    return undefined
}

const bwrapInstallSuggestions: Record<string, string> = {
    alpine: "sudo apk add bubblewrap",
    arch: "sudo pacman -S bubblewrap",
    archlinux: "sudo pacman -S bubblewrap",
    centos: "sudo dnf install -y bubblewrap",
    debian: "sudo apt-get install -y bubblewrap",
    fedora: "sudo dnf install -y bubblewrap",
    opensuse: "sudo zypper install bubblewrap",
    rhel: "sudo dnf install -y bubblewrap",
    ubuntu: "sudo apt-get install -y bubblewrap",
}

function compareVersions(left: Version, right: Version): number {
    for (const key of ["major", "minor", "patch"] as const) {
        if (left[key] > right[key]) return 1
        if (left[key] < right[key]) return -1
    }

    return 0
}

export function parseTolerantSemver(output: string): Version | undefined {
    const match = /(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:[^0-9]|$)/.exec(output)
    if (!match) return undefined

    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
    }
}

function formatVersion(version: Version): string {
    return `${version.major}.${version.minor}.${version.patch}`
}

export function isAtLeastMinimumOpencodeVersion(version: Version, minimum = parseTolerantSemver(MINIMUM_OPENCODE_VERSION)!): boolean {
    return compareVersions(version, minimum) >= 0
}

async function inspectOpencode(deps: SandboxDependencies): Promise<DependencyReport> {
    try {
        const result = await deps.spawn("opencode", ["--version"], { env: deps.process.env })
        const output = `${result.stdout}\n${result.stderr}`.trim()
        if (result.exitCode !== 0) return { ok: false, status: "missing", command: "opencode --version", minimum_version: MINIMUM_OPENCODE_VERSION, output, exit_code: result.exitCode, suggested_fix: "opencode upgrade", guidance: "Run `opencode upgrade`." }

        const version = parseTolerantSemver(output)
        if (!version) return { ok: false, status: "unknown", command: "opencode --version", minimum_version: MINIMUM_OPENCODE_VERSION, output, suggested_fix: "opencode upgrade", guidance: "Run `opencode upgrade`." }

        const versionText = formatVersion(version)
        if (!isAtLeastMinimumOpencodeVersion(version)) return { ok: false, status: "upgrade_required", legacy_status: "outdated", command: "opencode --version", version: versionText, minimum_version: MINIMUM_OPENCODE_VERSION, output, suggested_fix: "opencode upgrade", guidance: "Run `opencode upgrade`." }

        return { ok: true, status: "ok", command: "opencode --version", version: versionText, minimum_version: MINIMUM_OPENCODE_VERSION, output }
    }
    catch (error) {
        return { ok: false, status: "missing", command: "opencode --version", minimum_version: MINIMUM_OPENCODE_VERSION, error: flattenError(error), suggested_fix: "opencode upgrade", guidance: "Run `opencode upgrade`." }
    }
}

async function commandExists(command: string, deps: SandboxDependencies): Promise<boolean> {
    if (deps.commandExists) return deps.commandExists(command)

    try {
        const result = await deps.spawn("sh", ["-c", `command -v ${command}`], { env: deps.process.env })
        return result.exitCode === 0
    }
    catch {
        return false
    }
}

function parseOsRelease(content: string | undefined): string[] {
    if (!content) return []
    const values: string[] = []
    for (const line of content.split(/\r?\n/)) {
        const match = /^(ID|ID_LIKE)=(.*)$/.exec(line)
        if (!match) continue
        values.push(...match[2].replace(/^['"]|['"]$/g, "").split(/\s+/).map((value) => value.toLowerCase()).filter(Boolean))
    }

    return values
}

async function readOsRelease(deps: SandboxDependencies): Promise<string | undefined> {
    try {
        return await deps.fileSystem.readFile("/etc/os-release", "utf8")
    }
    catch {
        return undefined
    }
}

function getBwrapInstallSuggestion(osRelease: string | undefined): string {
    for (const distro of parseOsRelease(osRelease)) {
        const suggestion = bwrapInstallSuggestions[distro]
        if (suggestion) return suggestion
    }

    return "Install bubblewrap using your OS package manager."
}

async function inspectBwrap(deps: SandboxDependencies): Promise<DependencyReport> {
    const backend = await detectSandboxBackend(deps)
    if (backend.backend === "bubblewrap") return { ok: true, status: "ok", backend: "bubblewrap", signals: backend.signals }
    if (deps.process.platform !== "linux" || hasTermuxEnvironmentSignal(deps.process.env)) return { ok: false, status: "unsupported", backend: backend.backend, reason: backend.reason, signals: backend.signals, guidance: backend.guidance ?? "Bubblewrap sandbox support requires Linux outside Termux/Android." }

    const suggestedFix = getBwrapInstallSuggestion(await readOsRelease(deps))
    const status: DependencyStatus = await commandExists("bwrap", deps) ? "unusable" : "missing"
    const guidance = status === "missing" ? suggestedFix : "Fix bwrap usability, then retry. Kernel/user namespace restrictions may block bubblewrap."
    return { ok: false, status, backend: backend.backend, reason: backend.reason, signals: backend.signals, install_command: suggestedFix, guidance }
}

async function safeInspect(name: string, fn: () => Promise<DependencyReport>, optional = false): Promise<DependencyReport> {
    try {
        return await fn()
    }
    catch (error) {
        return {
            ok: false,
            ...(optional ? { optional: true } : {}),
            status: "unknown",
            dependency: name,
            error: flattenError(error),
            guidance: `Inspect ${name} manually.`,
        }
    }
}

async function safeInspectOptional(name: string, dependency: string, fn: () => Promise<DependencyReport>, emitDebug: DebugEmitter): Promise<DependencyReport> {
    try {
        return await fn()
    }
    catch (error) {
        const result: DependencyReport = {
            ok: false,
            optional: true,
            status: "unknown",
            dependency: name,
            error: flattenError(error),
            guidance: `Inspect ${name} manually.`,
        }
        emitDebug({ dependency, stage: "final", status: "unknown", reason: `Inspection failed for ${name}.`, error: flattenError(error) })
        return result
    }
}

async function resolveCommandPath(command: string, deps: SandboxDependencies): Promise<string | undefined> {
    try {
        const result = await deps.spawn("sh", ["-c", `command -v ${command}`], { env: deps.process.env })
        const resolvedPath = result.stdout.trim().split(/\r?\n/)[0]
        return result.exitCode === 0 && resolvedPath.length > 0 ? resolvedPath : undefined
    }
    catch {
        return undefined
    }
}

async function readCommandVersion(command: string, deps: SandboxDependencies): Promise<string | undefined> {
    try {
        const result = await deps.spawn(command, ["--version"], { env: deps.process.env })
        const output = `${result.stdout}\n${result.stderr}`.trim()
        const firstLine = output.split(/\r?\n/).find((line) => line.trim().length > 0)
        return result.exitCode === 0 ? firstLine : undefined
    }
    catch {
        return undefined
    }
}

async function inspectFirstAvailableCommand(commands: readonly string[], deps: SandboxDependencies, dependency: string, emitDebug: DebugEmitter): Promise<CommandInspection | undefined> {
    for (const command of commands) {
        const exists = await commandExists(command, deps)
        emitDebug({ dependency, stage: "path_check", command, exists })
        if (!exists) continue

        const resolvedPath = await resolveCommandPath(command, deps)
        const version = await readCommandVersion(command, deps)
        emitDebug({ dependency, stage: "path_check", command, exists: true, path: resolvedPath, version })
        return resolvedPath === undefined
            ? { command, version }
            : { command, path: resolvedPath, version }
    }

    return undefined
}

async function inspectFirstAvailableCommandPath(commands: readonly string[], deps: SandboxDependencies, dependency: string, emitDebug: DebugEmitter): Promise<CommandInspection | undefined> {
    for (const command of commands) {
        const exists = await commandExists(command, deps)
        emitDebug({ dependency, stage: "path_check", command, exists })
        if (!exists) continue

        const resolvedPath = await resolveCommandPath(command, deps)
        emitDebug({ dependency, stage: "path_check", command, exists: true, path: resolvedPath })
        return resolvedPath === undefined
            ? { command }
            : { command, path: resolvedPath }
    }

    return undefined
}

function getMcpDetectionNotes(notes: string | undefined): string {
    const versionNote = "Version not probed to avoid starting MCP server."
    return notes === undefined ? versionNote : `${notes} ${versionNote}`
}

function emitFinalDebugEvent(definition: OptionalDependencyDefinition, result: DependencyReport, emitDebug: DebugEmitter, reason: string): void {
    emitDebug({
        dependency: definition.key,
        stage: "final",
        status: String(result.status),
        reason,
        detection_source: typeof result.detection_source === "string" ? result.detection_source as "config_entry" | "launcher_command" : undefined,
        configured_command: typeof result.configured_command === "string" ? result.configured_command : undefined,
        config_path: typeof result.config_path === "string" ? result.config_path : undefined,
        command: typeof result.command === "string" ? result.command : undefined,
        path: typeof result.path === "string" ? result.path : undefined,
    })
}

async function inspectOptionalMcp(definition: OptionalDependencyDefinition, deps: SandboxDependencies, context: DependencyInspectionContext, emitDebug: DebugEmitter): Promise<DependencyReport> {
    const detected = await inspectFirstAvailableCommandPath(definition.bins, deps, definition.key, emitDebug)
    if (detected) {
        const result: DependencyReport = {
            ok: true,
            optional: true,
            status: "ok",
            package: definition.packageName,
            bin: detected.command,
            command: detected.command,
            path: detected.path,
            detection_source: "path",
            install_command: definition.installCommand,
            docs_url: definition.docsUrl,
            guidance: `${definition.packageName} is available.`,
            notes: getMcpDetectionNotes(definition.notes),
        }
        emitFinalDebugEvent(definition, result, emitDebug, "Detected from PATH command lookup.")
        return result
    }

    const configDetected = await inspectConfigForOptionalMcp(definition, deps, context, emitDebug)
    if (configDetected) {
        const result: DependencyReport = {
            ok: true,
            optional: true,
            status: "ok",
            package: definition.packageName,
            bin: definition.bins[0],
            detection_source: configDetected.detectionSource,
            config_path: configDetected.configPath,
            configured_command: configDetected.configuredCommand,
            install_command: definition.installCommand,
            docs_url: definition.docsUrl,
            guidance: `${definition.packageName} is configured.`,
            notes: getMcpDetectionNotes(definition.notes),
        }
        emitFinalDebugEvent(definition, result, emitDebug, "Detected from OpenCode config.")
        return result
    }

    const result: DependencyReport = {
        ok: false,
        optional: true,
        status: "missing",
        package: definition.packageName,
        bin: definition.bins[0],
        install_command: definition.installCommand,
        docs_url: definition.docsUrl,
        guidance: definition.guidance,
        notes: getMcpDetectionNotes(definition.notes),
    }
    emitFinalDebugEvent(definition, result, emitDebug, "No PATH command or matching OpenCode config found.")
    return result
}

function getBrowserInstallSuggestion(): string {
    return "Install Google Chrome / Chrome for Testing manually: https://developer.chrome.com/docs/chrome-devtools/mcp"
}

async function inspectBrowserAvailability(deps: SandboxDependencies, emitDebug: DebugEmitter): Promise<DependencyReport> {
    const googleChrome = await inspectFirstAvailableCommand(["google-chrome", "google-chrome-stable", "chrome"], deps, "browser", emitDebug)
    const chromium = await inspectFirstAvailableCommand(["chromium", "chromium-browser"], deps, "browser", emitDebug)
    const installCommand = getBrowserInstallSuggestion()
    const docsUrl = "https://developer.chrome.com/docs/chrome-devtools/mcp"

    if (googleChrome) {
        const result: DependencyReport = {
            ok: true,
            optional: true,
            status: "ok",
            command: googleChrome.command,
            path: googleChrome.path,
            version: googleChrome.version,
            chromium_command: chromium?.command,
            chromium_path: chromium?.path,
            install_command: installCommand,
            docs_url: docsUrl,
            guidance: "Google Chrome is available for Chrome DevTools MCP.",
            notes: chromium ? "Google Chrome found. Chromium also found, but official Chrome DevTools MCP support is Google Chrome / Chrome for Testing." : "Google Chrome found. Chromium missing is not an issue.",
        }
        emitDebug({ dependency: "browser", stage: "final", status: "ok", reason: chromium ? "Google Chrome and Chromium found." : "Google Chrome found." })
        return result
    }

    if (chromium) {
        const result: DependencyReport = {
            ok: false,
            optional: true,
            status: "unknown",
            command: chromium.command,
            path: chromium.path,
            version: chromium.version,
            install_command: installCommand,
            docs_url: docsUrl,
            guidance: "Install Google Chrome / Chrome for Testing for official Chrome DevTools MCP support.",
            notes: "Chromium found. It may work with Chrome DevTools MCP but is not guaranteed by official support.",
        }
        emitDebug({ dependency: "browser", stage: "final", status: "unknown", reason: "Chromium found without Google Chrome.", command: chromium.command, path: chromium.path, version: chromium.version })
        return result
    }

    const result: DependencyReport = {
        ok: false,
        optional: true,
        status: "missing",
        command: "google-chrome",
        install_command: installCommand,
        docs_url: docsUrl,
        guidance: "Install Google Chrome / Chrome for Testing for official Chrome DevTools MCP support. Chromium may work but is not guaranteed.",
        notes: "Google Chrome missing. Chromium missing.",
    }
    emitDebug({ dependency: "browser", stage: "final", status: "missing", reason: "Google Chrome and Chromium not found." })
    return result
}

const optionalMcpDefinitions: readonly OptionalDependencyDefinition[] = [
    {
        key: "chrome_devtools_mcp",
        packageName: "chrome-devtools-mcp",
        bins: ["chrome-devtools-mcp"],
        aliases: ["chrome-devtools-mcp", "chrome-devtools", "server-chrome"],
        installCommand: "npm install -g chrome-devtools-mcp@latest or use `npx chrome-devtools-mcp@latest`",
        docsUrl: "https://developer.chrome.com/docs/chrome-devtools/mcp",
        guidance: "Install or use `chrome-devtools-mcp@latest` for Chrome DevTools MCP.",
        notes: "Official support is Google Chrome / Chrome for Testing; Chromium may work but is not guaranteed.",
    },
    {
        key: "context7_mcp",
        packageName: "@upstash/context7-mcp",
        bins: ["context7-mcp"],
        aliases: ["@upstash/context7-mcp", "context7-mcp", "context7"],
        installCommand: "npm install -g @upstash/context7-mcp or use `npx @upstash/context7-mcp`",
        docsUrl: "https://github.com/upstash/context7",
        guidance: "Install or use `@upstash/context7-mcp` for Context7 MCP.",
    },
    {
        key: "excel_mcp",
        packageName: "excel-mcp-server",
        bins: ["excel-mcp-server"],
        aliases: ["excel-mcp-server", "excel-mcp"],
        installCommand: "npm install -g excel-mcp-server or use `npx excel-mcp-server`",
        docsUrl: "https://www.npmjs.com/package/excel-mcp-server",
        guidance: "Install or use `excel-mcp-server` for Excel MCP.",
    },
    {
        key: "git_mcp",
        packageName: "mcp-server-git",
        bins: ["mcp-server-git"],
        aliases: ["mcp-server-git", "server-git", "git-mcp", "@modelcontextprotocol/server-git"],
        installCommand: "pipx install mcp-server-git or use `uvx mcp-server-git`",
        docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
        guidance: "Install or use `mcp-server-git` for Git MCP.",
    },
]

async function inspectGitMcp(deps: SandboxDependencies, context: DependencyInspectionContext, emitDebug: DebugEmitter): Promise<DependencyReport> {
    const mcp = await inspectOptionalMcp(optionalMcpDefinitions[3], deps, context, emitDebug)
    const git = await inspectFirstAvailableCommand(["git"], deps, "git_mcp", emitDebug)
    return {
        ...mcp,
        git_cli: git === undefined ? { ok: false, status: "missing" } : { ok: true, status: "ok", command: git.command, path: git.path, version: git.version },
    }
}

async function inspectOptionalDependencies(deps: SandboxDependencies, context: DependencyInspectionContext, emitDebug: DebugEmitter): Promise<Record<string, DependencyReport>> {
    const [chromeDevtoolsMcp, context7Mcp, excelMcp, gitMcp, browser] = await Promise.all([
        safeInspectOptional("chrome-devtools MCP", "chrome_devtools_mcp", () => inspectOptionalMcp(optionalMcpDefinitions[0], deps, context, emitDebug), emitDebug),
        safeInspectOptional("Context7 MCP", "context7_mcp", () => inspectOptionalMcp(optionalMcpDefinitions[1], deps, context, emitDebug), emitDebug),
        safeInspectOptional("Excel MCP", "excel_mcp", () => inspectOptionalMcp(optionalMcpDefinitions[2], deps, context, emitDebug), emitDebug),
        safeInspectOptional("Git MCP", "git_mcp", () => inspectGitMcp(deps, context, emitDebug), emitDebug),
        safeInspectOptional("browser availability", "browser", () => inspectBrowserAvailability(deps, emitDebug), emitDebug),
    ])

    return {
        chrome_devtools_mcp: chromeDevtoolsMcp,
        context7_mcp: context7Mcp,
        excel_mcp: excelMcp,
        git_mcp: gitMcp,
        browser,
    }
}

function hasActionableOptionalGuidance(dependency: DependencyReport): boolean {
    const status = dependency.status as OptionalDependencyStatus
    return ["missing", "unknown", "unusable", "upgrade_required"].includes(status) && typeof dependency.guidance === "string" && dependency.guidance.length > 0
}

export async function inspectAutocodeDependencies(
    deps: SandboxDependencies = defaultSandboxDependencies,
    context: DependencyInspectionContext = {},
    options: DependencyInspectionOptions = {},
): Promise<Record<string, unknown>> {
    const emitDebug = createDebugEmitter(options)
    const [opencode, bwrap, optionalDependencies] = await Promise.all([
        safeInspect("OpenCode", () => inspectOpencode(deps)),
        safeInspect("bwrap", () => inspectBwrap(deps)),
        inspectOptionalDependencies(deps, context, emitDebug),
    ])

    const requiredOk = opencode.ok === true && bwrap.ok === true
    const optionalActions = Object.values(optionalDependencies)
        .filter(hasActionableOptionalGuidance)
        .map((dependency) => dependency.guidance)
    const optionalOk = optionalActions.length === 0
    const nextActions = [opencode.ok === true ? undefined : opencode.guidance, bwrap.ok === true ? undefined : bwrap.guidance, ...optionalActions].filter((action): action is string => typeof action === "string" && action.length > 0)
    const dependencies = {
        opencode,
        bwrap,
        ...optionalDependencies,
    }

    return {
        ok: requiredOk,
        required_ok: requiredOk,
        optional_ok: optionalOk,
        status: requiredOk && optionalOk ? "ready" : "action_required",
        detect_only: true,
        opencode,
        bwrap,
        optional_dependencies: optionalDependencies,
        dependencies,
        next_actions: nextActions,
    }
}
