import { tool } from "@opencode-ai/plugin"
import { createAbortResponse, flattenError } from "@/utils/tools"
import { defaultSandboxDependencies, detectSandboxBackend, hasTermuxEnvironmentSignal, type SandboxDependencies } from "@/utils/sandbox"

export const MINIMUM_OPENCODE_VERSION = "1.14.28"

type DependencyStatus = "ok" | "upgrade_required" | "missing" | "unknown" | "unsupported" | "unusable"

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

async function inspectOpencode(deps: SandboxDependencies): Promise<Record<string, unknown>> {
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

async function inspectBwrap(deps: SandboxDependencies): Promise<Record<string, unknown>> {
    const backend = await detectSandboxBackend(deps)
    if (backend.backend === "bubblewrap") return { ok: true, status: "ok" satisfies DependencyStatus, backend: "bubblewrap", signals: backend.signals }
    if (deps.process.platform !== "linux" || hasTermuxEnvironmentSignal(deps.process.env)) return { ok: false, status: "unsupported" satisfies DependencyStatus, backend: backend.backend, reason: backend.reason, signals: backend.signals, guidance: backend.guidance ?? "Bubblewrap sandbox support requires Linux outside Termux/Android." }

    const suggestedFix = getBwrapInstallSuggestion(await readOsRelease(deps))
    const status: DependencyStatus = await commandExists("bwrap", deps) ? "unusable" : "missing"
    const guidance = status === "missing" ? suggestedFix : "Fix bwrap usability, then retry. Kernel/user namespace restrictions may block bubblewrap."
    return { ok: false, status, backend: backend.backend, reason: backend.reason, signals: backend.signals, install_command: suggestedFix, guidance }
}

export async function inspectAutocodeDependencies(deps: SandboxDependencies = defaultSandboxDependencies): Promise<Record<string, unknown>> {
    const [opencode, bwrap] = await Promise.all([
        inspectOpencode(deps),
        inspectBwrap(deps),
    ])

    const ok = opencode.ok === true && bwrap.ok === true
    const nextActions = [opencode.guidance, bwrap.guidance].filter((action): action is string => typeof action === "string" && action.length > 0)

    return {
        ok,
        status: ok ? "ready" : "action_required",
        detect_only: true,
        opencode,
        bwrap,
        next_actions: nextActions,
    }
}

export function createAutocodeDependenciesTool(deps: SandboxDependencies = defaultSandboxDependencies) {
    return tool({
        description: "Detect Autocode runtime dependencies for initialization. Detect-only: never upgrades OpenCode or installs packages.",
        args: {},
        async execute() {
            try {
                return JSON.stringify(await inspectAutocodeDependencies(deps))
            }
            catch (error) {
                return createAbortResponse("detect dependencies", error)
            }
        },
    })
}
