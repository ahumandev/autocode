import type { Dirent } from "node:fs"
import path from "node:path"
import { tool, type ToolContext } from "@opencode-ai/plugin"
import { defaultSandboxDependencies, type SandboxDependencies } from "@/utils/sandbox"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

type AutocodeKillArgs = {
    port?: unknown
    name?: string
}

type AutocodeKillContext = {
    cwd?: string
    directory?: string
}

type PortMatch = {
    config_file: string
    config_match: string
    port: number
}

type Listener = {
    port: number
    process_name: string
    process_owner: string
    pid?: string
}

type SignalProcess = (pid: number, signal: NodeJS.Signals) => void

type KillCandidate = PortMatch & {
    process_name: string
    process_owner: string
}

type AutocodeKillDependencies = SandboxDependencies & {
    getCwd?: () => string
    signalProcess?: SignalProcess
}

const candidateSuffixes = [".yaml", ".yml", ".conf", ".json", ".jsonc", ".ts", ".env"]
const requiredLinuxCommands = ["ss", "ps"]
const skippedDirs = new Set([".git", "node_modules", "dist", "build", "coverage", "caches", ".cache", "tmp", "temp"])
const hostPortPattern = /\b(?:localhost|127\.0\.0\.1):(\d{1,5})\b/g
const keywordPortPattern = /(?:\bport\b|\bPORT\b|--port)\D{0,40}(\d{1,5})/g
const unsupportedPlatformInstruction = "Use native CLI commands for your OS instead, such as macOS/BSD `lsof -nP -iTCP:<port> -sTCP:LISTEN` then `kill <pid>`, or Windows `netstat -ano | findstr :<port>` then `taskkill /PID <pid> /T`."
const missingCommandInstruction = "Install/provide the missing Linux commands, or use native CLI commands such as `ss -ltnp`, `ps -o user= -o comm= -p <pid>`, and `kill <pid>`."

function isBlank(value: unknown): boolean {
    return value === undefined || value === null || (typeof value === "string" && !value.trim())
}

function resolveProjectRoot(context: AutocodeKillContext | undefined, deps: AutocodeKillDependencies): string {
    if (context?.cwd?.trim()) return context.cwd.trim()
    if (context?.directory?.trim()) return context.directory.trim()
    return deps.getCwd?.() ?? process.cwd()
}

function shouldSkipDirectory(relativePath: string, entryName: string): boolean {
    if (skippedDirs.has(entryName)) return true
    return relativePath === path.join(".agents", "sandboxes") || relativePath.startsWith(`${path.join(".agents", "sandboxes")}${path.sep}`)
}

function isCandidateFile(relativePath: string): boolean {
    const fileName = path.basename(relativePath)
    if (relativePath === "application.yml" || relativePath === "application.yaml") return true
    return candidateSuffixes.some((suffix) => fileName.endsWith(suffix))
}

function normalizePort(input: string): number | undefined {
    const port = Number(input)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
    return port
}

function normalizePortArg(input: unknown): number | undefined {
    if (typeof input === "number" && Number.isInteger(input)) return normalizePort(String(input))
    if (typeof input === "string" && input.trim()) return normalizePort(input.trim())
    return undefined
}

function signalProcess(pid: number, deps: AutocodeKillDependencies): void {
    const kill = deps.signalProcess ?? ((targetPid: number, signal: NodeJS.Signals): void => {
        globalThis.process.kill(targetPid, signal)
    })
    kill(pid, "SIGTERM")
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    return String(error)
}

async function commandExists(command: string, deps: AutocodeKillDependencies): Promise<boolean> {
    if (deps.commandExists) return deps.commandExists(command)

    try {
        const result = await deps.spawn("sh", ["-c", `command -v ${command}`], { env: deps.process.env })
        return result.exitCode === 0
    }
    catch {
        return false
    }
}

async function validateAutocodeKillEnvironment(deps: AutocodeKillDependencies): Promise<string | undefined> {
    if (deps.process.platform !== "linux") {
        return createAbortResponse(
            "validate autocode_kill environment",
            `Current OS/platform '${deps.process.platform}' is unsupported for autocode_kill; Linux is required.`,
            unsupportedPlatformInstruction
        )
    }

    const missingCommands: string[] = []
    for (const command of requiredLinuxCommands) {
        if (!await commandExists(command, deps)) missingCommands.push(command)
    }

    if (missingCommands.length === 0) return undefined
    return createAbortResponse(
        "validate autocode_kill environment",
        `Missing required Linux command(s) for autocode_kill: ${missingCommands.join(", ")}.`,
        missingCommandInstruction
    )
}

function isPermissionFailure(error: unknown): boolean {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : ""
    const message = errorMessage(error).toLowerCase()
    return code === "EPERM" || message.includes("permission denied") || message.includes("operation not permitted")
}

function trimConfigMatch(line: string, hostToken?: string): string {
    const trimmed = line.trim()
    if (trimmed.length <= 160) return trimmed
    return hostToken ?? trimmed.slice(0, 157).trimEnd() + "..."
}

function addMatch(matches: PortMatch[], seen: Set<string>, configFile: string, configMatch: string, port: number): void {
    const key = `${configFile}\0${configMatch}\0${port}`
    if (seen.has(key)) return
    seen.add(key)
    matches.push({ config_file: configFile, config_match: configMatch, port })
}

function extractPortMatches(configFile: string, content: string): PortMatch[] {
    const matches: PortMatch[] = []
    const seen = new Set<string>()

    for (const line of content.split(/\r?\n/)) {
        hostPortPattern.lastIndex = 0
        for (const match of line.matchAll(hostPortPattern)) {
            const port = normalizePort(match[1])
            if (port !== undefined) addMatch(matches, seen, configFile, trimConfigMatch(line, match[0]), port)
        }

        if (!/(?:\bport\b|\bPORT\b|--port)/.test(line)) continue
        keywordPortPattern.lastIndex = 0
        for (const match of line.matchAll(keywordPortPattern)) {
            const port = normalizePort(match[1])
            if (port !== undefined) addMatch(matches, seen, configFile, trimConfigMatch(line), port)
        }
    }

    return matches
}

async function listCandidateFiles(projectRoot: string, deps: AutocodeKillDependencies): Promise<string[]> {
    const files: string[] = []

    async function visit(directory: string): Promise<void> {
        const entries = await deps.fileSystem.readdir(directory, { withFileTypes: true }) as Dirent[]
        for (const entry of entries) {
            const fullPath = path.join(directory, entry.name)
            const relativePath = path.relative(projectRoot, fullPath)
            if (entry.isDirectory()) {
                if (!shouldSkipDirectory(relativePath, entry.name)) await visit(fullPath)
                continue
            }
            if (entry.isFile() && isCandidateFile(relativePath)) files.push(fullPath)
        }
    }

    await visit(projectRoot)
    return files
}

async function discoverConfigMatches(projectRoot: string, deps: AutocodeKillDependencies): Promise<PortMatch[]> {
    const matches: PortMatch[] = []
    const files = await listCandidateFiles(projectRoot, deps)

    for (const filePath of files) {
        const relativePath = path.relative(projectRoot, filePath)
        const content = await deps.fileSystem.readFile(filePath, "utf8")
        matches.push(...extractPortMatches(relativePath, String(content)))
    }

    return matches
}

function parseSsListeners(output: string): Listener[] {
    const listeners: Listener[] = []
    for (const line of output.split(/\r?\n/)) {
        if (!line.trim() || line.startsWith("State")) continue
        const portMatch = line.match(/(?:^|\s)(?:\S+:|\[[^\]]+\]:)(\d{1,5})(?=\s)/)
        const port = portMatch ? normalizePort(portMatch[1]) : undefined
        if (port === undefined) continue
        const name = line.match(/users:\(\("([^"]+)"/)?.[1] ?? ""
        const pid = line.match(/pid=(\d+)/)?.[1]
        listeners.push({ port, process_name: name, process_owner: "", pid })
    }
    return listeners
}

async function addProcessOwners(listeners: Listener[], deps: AutocodeKillDependencies): Promise<Listener[]> {
    const byPid = new Map<string, { owner: string, name: string }>()
    for (const listener of listeners) {
        if (!listener.pid || byPid.has(listener.pid)) continue
        try {
            const result = await deps.spawn("ps", ["-o", "user=", "-o", "comm=", "-p", listener.pid])
            const firstLine = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ""
            const [owner = "", ...nameParts] = firstLine.split(/\s+/)
            byPid.set(listener.pid, { owner: result.exitCode === 0 ? owner : "", name: result.exitCode === 0 ? nameParts.join(" ") : "" })
        }
        catch {
            byPid.set(listener.pid, { owner: "", name: "" })
        }
    }

    return listeners.map((listener) => {
        const processInfo = listener.pid ? byPid.get(listener.pid) : undefined
        return {
            ...listener,
            process_name: listener.process_name || processInfo?.name || "",
            process_owner: processInfo?.owner || "",
        }
    })
}

async function listListeners(deps: AutocodeKillDependencies): Promise<Listener[]> {
    const result = await deps.spawn("ss", ["-ltnp"])
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Unable to list TCP listeners with ss -ltnp.")
    return addProcessOwners(parseSsListeners(result.stdout), deps)
}

async function killExplicitPort(port: number, expectedName: string | undefined, deps: AutocodeKillDependencies): Promise<string> {
    const listeners = (await listListeners(deps)).filter((listener) => listener.port === port)
    if (listeners.length === 0) {
        return createRetryResponse(
            `kill listener on port ${port}`,
            `No TCP listener found on port ${port}.`,
            "Check the port and start the dev server if needed, then retry autocode_kill with the correct port."
        )
    }

    if (listeners.length > 1) {
        return createRetryResponse(
            `kill listener on port ${port}`,
            `Ambiguous listeners found on port ${port}.`,
            "Stop the listeners manually or retry with a clearer target after only one listener remains on that port."
        )
    }

    const listener = listeners[0]
    if (expectedName !== undefined && listener.process_name !== expectedName) {
        const actualName = listener.process_name ? ` Actual name: ${listener.process_name}.` : " Actual name is unknown."
        return createRetryResponse(
            `kill listener on port ${port}`,
            `Process name mismatch for port ${port}. Expected name: ${expectedName}.${actualName}`,
            "Check the port and process name, then retry autocode_kill with the exact listener name."
        )
    }

    if (listener.pid === undefined) return createAbortResponse(`kill listener on port ${port}`, `Unable to identify PID for listener on port ${port}.`)

    const pid = Number(listener.pid)
    if (!Number.isInteger(pid)) return createAbortResponse(`kill listener on port ${port}`, `Invalid PID for listener on port ${port}: ${listener.pid}`)

    try {
        signalProcess(pid, deps)
    }
    catch (error) {
        const failedAction = `kill listener on port ${port}`
        if (isPermissionFailure(error)) return createAbortResponse(failedAction, `Permission denied sending SIGTERM to PID ${pid}: ${errorMessage(error)}`)
        return createAbortResponse(failedAction, error)
    }

    return JSON.stringify({
        ok: true,
        mode: "kill",
        action: "kill",
        port,
        name: listener.process_name,
        pid,
        ...(listener.process_owner ? { owner: listener.process_owner } : {}),
    })
}

function mapCandidates(matches: PortMatch[], listeners: Listener[], processName?: string): KillCandidate[] {
    const listenersByPort = new Map<number, Listener>()
    for (const listener of listeners) {
        if (!listenersByPort.has(listener.port)) listenersByPort.set(listener.port, listener)
    }

    return matches.flatMap((match) => {
        const listener = listenersByPort.get(match.port)
        if (!listener) return []
        if (processName !== undefined && listener.process_name !== processName) return []
        return [{
            config_file: match.config_file,
            config_match: match.config_match,
            process_name: listener.process_name,
            process_owner: listener.process_owner,
            port: match.port,
        }]
    })
}

export async function runAutocodeKill(rawArgs: AutocodeKillArgs = {}, context?: AutocodeKillContext, deps: AutocodeKillDependencies = defaultSandboxDependencies): Promise<string> {
    const environmentError = await validateAutocodeKillEnvironment(deps)
    if (environmentError !== undefined) return environmentError

    if (!isBlank(rawArgs.port)) {
        const port = normalizePortArg(rawArgs.port)
        if (port === undefined) {
            return createRetryResponse("kill listener on port", `Invalid port: ${String(rawArgs.port)}`, "Provide port as an integer from 1 to 65535.")
        }

        const expectedName = isBlank(rawArgs.name) ? undefined : rawArgs.name
        return killExplicitPort(port, expectedName, deps)
    }

    try {
        const projectRoot = resolveProjectRoot(context, deps)
        const matches = await discoverConfigMatches(projectRoot, deps)
        const listeners = await listListeners(deps)
        const processName = isBlank(rawArgs.name) ? undefined : rawArgs.name
        return JSON.stringify({ ok: true, mode: "list", candidates: mapCandidates(matches, listeners, processName) })
    }
    catch (error) {
        return createAbortResponse("list autocode_kill candidates", error)
    }
}

export function createAutocodeKillTool(deps: AutocodeKillDependencies = defaultSandboxDependencies): ReturnType<typeof tool> {
    return tool({
        description: "List config-backed local dev server candidates, or SIGTERM one exact listener when port is supplied.",
        args: {
            port: tool.schema.unknown().optional().describe("Optional exact port to kill with SIGTERM."),
            name: tool.schema.string().optional().describe("Optional exact process name required before killing."),
        },
        async execute(args: AutocodeKillArgs, context: ToolContext): Promise<string> {
            return runAutocodeKill(args, context, deps)
        },
    })
}
