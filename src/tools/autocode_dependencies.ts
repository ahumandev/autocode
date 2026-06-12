import { tool } from "@opencode-ai/plugin"
import { createAbortResponse, flattenError } from "@/utils/tools"
import { defaultSandboxDependencies, detectSandboxBackend, hasTermuxEnvironmentSignal, type SandboxDependencies } from "@/utils/sandbox"

export const MINIMUM_OPENCODE_VERSION = "1.14.28"

type DependencyStatus = "ok" | "upgrade_required" | "missing" | "unknown" | "unsupported" | "unusable"

type DependencyReport = Record<string, unknown> & {
    ok: boolean
    status: DependencyStatus
    guidance?: string
}

type OptionalDependencyDefinition = {
    key: string
    packageName: string
    bins: readonly string[]
    installCommand: string
    docsUrl: string
    guidance: string
    notes?: string
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
        if (result.exitCode !== 0) return { ok: false, status: "missing" satisfies DependencyStatus, command: "opencode --version", minimum_version: MINIMUM_OPENCODE_VERSION, output, exit_code: result.exitCode, suggested_fix: "opencode upgrade", guidance: "Run `opencode upgrade`." }

        const version = parseTolerantSemver(output)
        if (!version) return { ok: false, status: "unknown" satisfies DependencyStatus, command: "opencode --version", minimum_version: MINIMUM_OPENCODE_VERSION, output, suggested_fix: "opencode upgrade", guidance: "Run `opencode upgrade`." }

        const versionText = formatVersion(version)
        if (!isAtLeastMinimumOpencodeVersion(version)) return { ok: false, status: "upgrade_required" satisfies DependencyStatus, legacy_status: "outdated", command: "opencode --version", version: versionText, minimum_version: MINIMUM_OPENCODE_VERSION, output, suggested_fix: "opencode upgrade", guidance: "Run `opencode upgrade`." }

        return { ok: true, status: "ok" satisfies DependencyStatus, command: "opencode --version", version: versionText, minimum_version: MINIMUM_OPENCODE_VERSION, output }
    }
    catch (error) {
        return { ok: false, status: "missing" satisfies DependencyStatus, command: "opencode --version", minimum_version: MINIMUM_OPENCODE_VERSION, error: flattenError(error), suggested_fix: "opencode upgrade", guidance: "Run `opencode upgrade`." }
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
    if (backend.backend === "bubblewrap") return { ok: true, status: "ok" satisfies DependencyStatus, backend: "bubblewrap", signals: backend.signals }
    if (deps.process.platform !== "linux" || hasTermuxEnvironmentSignal(deps.process.env)) return { ok: false, status: "unsupported" satisfies DependencyStatus, backend: backend.backend, reason: backend.reason, signals: backend.signals, guidance: backend.guidance ?? "Bubblewrap sandbox support requires Linux outside Termux/Android." }

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

async function resolveCommandPath(command: string, deps: SandboxDependencies): Promise<string | undefined> {
    try {
        const result = await deps.spawn("sh", ["-c", `command -v ${command}`], { env: deps.process.env })
        const path = result.stdout.trim().split(/\r?\n/)[0]
        return result.exitCode === 0 && path.length > 0 ? path : undefined
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

async function inspectFirstAvailableCommand(commands: readonly string[], deps: SandboxDependencies): Promise<CommandInspection | undefined> {
    for (const command of commands) {
        if (!await commandExists(command, deps)) continue

        const path = await resolveCommandPath(command, deps)
        const version = await readCommandVersion(command, deps)
        return path === undefined
            ? { command, version }
            : { command, path, version }
    }

    return undefined
}

async function inspectFirstAvailableCommandPath(commands: readonly string[], deps: SandboxDependencies): Promise<CommandInspection | undefined> {
    for (const command of commands) {
        if (!await commandExists(command, deps)) continue

        const path = await resolveCommandPath(command, deps)
        return path === undefined
            ? { command }
            : { command, path }
    }

    return undefined
}

function getMcpDetectionNotes(notes: string | undefined): string {
    const versionNote = "Version not probed to avoid starting MCP server."
    return notes === undefined ? versionNote : `${notes} ${versionNote}`
}

async function inspectOptionalMcp(definition: OptionalDependencyDefinition, deps: SandboxDependencies): Promise<DependencyReport> {
    const detected = await inspectFirstAvailableCommandPath(definition.bins, deps)
    if (detected) {
        return {
            ok: true,
            optional: true,
            status: "ok",
            package: definition.packageName,
            bin: detected.command,
            command: detected.command,
            path: detected.path,
            install_command: definition.installCommand,
            docs_url: definition.docsUrl,
            guidance: `${definition.packageName} is available.`,
            notes: getMcpDetectionNotes(definition.notes),
        }
    }

    return {
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
}

function getBrowserInstallSuggestion(): string {
    return "Install Google Chrome / Chrome for Testing manually: https://developer.chrome.com/docs/chrome-devtools/mcp"
}

async function inspectBrowserAvailability(deps: SandboxDependencies): Promise<DependencyReport> {
    const googleChrome = await inspectFirstAvailableCommand(["google-chrome", "google-chrome-stable", "chrome"], deps)
    const chromium = await inspectFirstAvailableCommand(["chromium", "chromium-browser"], deps)
    const installCommand = getBrowserInstallSuggestion()
    const docsUrl = "https://developer.chrome.com/docs/chrome-devtools/mcp"

    if (googleChrome) {
        return {
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
    }

    if (chromium) {
        return {
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
    }

    return {
        ok: false,
        optional: true,
        status: "missing",
        command: "google-chrome",
        install_command: installCommand,
        docs_url: docsUrl,
        guidance: "Install Google Chrome / Chrome for Testing for official Chrome DevTools MCP support. Chromium may work but is not guaranteed.",
        notes: "Google Chrome missing. Chromium missing.",
    }
}

const optionalMcpDefinitions: readonly OptionalDependencyDefinition[] = [
    {
        key: "chrome_devtools_mcp",
        packageName: "chrome-devtools-mcp",
        bins: ["chrome-devtools-mcp"],
        installCommand: "npm install -g chrome-devtools-mcp@latest or use `npx chrome-devtools-mcp@latest`",
        docsUrl: "https://developer.chrome.com/docs/chrome-devtools/mcp",
        guidance: "Install or use `chrome-devtools-mcp@latest` for Chrome DevTools MCP.",
        notes: "Official support is Google Chrome / Chrome for Testing; Chromium may work but is not guaranteed.",
    },
    {
        key: "context7_mcp",
        packageName: "@upstash/context7-mcp",
        bins: ["context7-mcp"],
        installCommand: "npm install -g @upstash/context7-mcp or use `npx @upstash/context7-mcp`",
        docsUrl: "https://github.com/upstash/context7",
        guidance: "Install or use `@upstash/context7-mcp` for Context7 MCP.",
    },
    {
        key: "excel_mcp",
        packageName: "excel-mcp-server",
        bins: ["excel-mcp-server"],
        installCommand: "npm install -g excel-mcp-server or use `npx excel-mcp-server`",
        docsUrl: "https://www.npmjs.com/package/excel-mcp-server",
        guidance: "Install or use `excel-mcp-server` for Excel MCP.",
    },
    {
        key: "git_mcp",
        packageName: "mcp-server-git",
        bins: ["mcp-server-git"],
        installCommand: "pipx install mcp-server-git or use `uvx mcp-server-git`",
        docsUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
        guidance: "Install or use `mcp-server-git` for Git MCP.",
    },
]

async function inspectGitMcp(deps: SandboxDependencies): Promise<DependencyReport> {
    const mcp = await inspectOptionalMcp(optionalMcpDefinitions[3], deps)
    const git = await inspectFirstAvailableCommand(["git"], deps)
    return {
        ...mcp,
        git_cli: git === undefined ? { ok: false, status: "missing" } : { ok: true, status: "ok", command: git.command, path: git.path, version: git.version },
    }
}

async function inspectOptionalDependencies(deps: SandboxDependencies): Promise<Record<string, DependencyReport>> {
    const [chromeDevtoolsMcp, context7Mcp, excelMcp, gitMcp, browser] = await Promise.all([
        safeInspect("chrome-devtools MCP", () => inspectOptionalMcp(optionalMcpDefinitions[0], deps), true),
        safeInspect("Context7 MCP", () => inspectOptionalMcp(optionalMcpDefinitions[1], deps), true),
        safeInspect("Excel MCP", () => inspectOptionalMcp(optionalMcpDefinitions[2], deps), true),
        safeInspect("Git MCP", () => inspectGitMcp(deps), true),
        safeInspect("browser availability", () => inspectBrowserAvailability(deps), true),
    ])

    return {
        chrome_devtools_mcp: chromeDevtoolsMcp,
        context7_mcp: context7Mcp,
        excel_mcp: excelMcp,
        git_mcp: gitMcp,
        browser: browser,
    }
}

function hasActionableOptionalGuidance(dependency: DependencyReport): boolean {
    const status = dependency.status as OptionalDependencyStatus
    return ["missing", "unknown", "unusable", "upgrade_required"].includes(status) && typeof dependency.guidance === "string" && dependency.guidance.length > 0
}

export async function inspectAutocodeDependencies(deps: SandboxDependencies = defaultSandboxDependencies): Promise<Record<string, unknown>> {
    const [opencode, bwrap, optionalDependencies] = await Promise.all([
        safeInspect("OpenCode", () => inspectOpencode(deps)),
        safeInspect("bwrap", () => inspectBwrap(deps)),
        inspectOptionalDependencies(deps),
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

export function createAutocodeDependenciesTool(deps: SandboxDependencies = defaultSandboxDependencies): ReturnType<typeof tool> {
    return tool({
        description: "Detect Autocode runtime dependencies for initialization. Detect-only: never upgrades OpenCode or installs packages.",
        args: {},
        async execute(): Promise<string> {
            try {
                return JSON.stringify(await inspectAutocodeDependencies(deps))
            }
            catch (error) {
                return createAbortResponse("detect dependencies", error)
            }
        },
    })
}
