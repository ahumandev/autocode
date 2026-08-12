import { tool, type ToolContext } from "@opencode-ai/plugin"
import { defaultSandboxDependencies, type SandboxCommandResult, type SandboxDependencies } from "@/utils/sandbox"
import { createAbortResponse, createRetryResponse, flattenError } from "@/utils/tools"

type AutocodeProcessKillArgs = {
    server_port: unknown
}

type SignalProcess = (pid: number, signal: NodeJS.Signals | 0) => void

type AutocodeProcessKillDependencies = SandboxDependencies & {
    signalProcess?: SignalProcess
    sleep?: (milliseconds: number) => Promise<void>
}

const gracefulStopChecks = 10
const gracefulStopDelayMs = 100

function normalizePort(input: unknown): number | undefined {
    if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1 || input > 65535) return undefined
    return input
}

function getSignalProcess(deps: AutocodeProcessKillDependencies): SignalProcess {
    return deps.signalProcess ?? ((pid: number, signal: NodeJS.Signals | 0): void => {
        globalThis.process.kill(pid, signal)
    })
}

async function commandExists(command: string, deps: AutocodeProcessKillDependencies): Promise<boolean> {
    if (deps.commandExists) return deps.commandExists(command)

    try {
        const result = await deps.spawn("sh", ["-c", `command -v ${command}`], { env: deps.process.env })
        return result.exitCode === 0
    }
    catch {
        return false
    }
}

function parseListenerPids(output: string): number[] {
    const pids = new Set<number>()
    for (const line of output.split(/\r?\n/)) {
        const value = line.trim()
        if (!/^\d+$/.test(value)) continue
        const pid = Number(value)
        if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid)
    }
    return [...pids]
}

function hasErrorCode(error: unknown, code: string): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === code
}

function hasStopped(pid: number, signalProcess: SignalProcess): boolean {
    try {
        signalProcess(pid, 0)
        return false
    }
    catch (error) {
        if (hasErrorCode(error, "ESRCH")) return true
        throw new Error(`Failed to check whether PID ${pid} is running: ${flattenError(error)}`)
    }
}

async function stopProcess(pid: number, deps: AutocodeProcessKillDependencies): Promise<"graceful" | "forced"> {
    const signalProcess = getSignalProcess(deps)
    try {
        signalProcess(pid, "SIGTERM")
    }
    catch (error) {
        throw new Error(`Failed to send SIGTERM to PID ${pid}: ${flattenError(error)}`)
    }

    const sleep = deps.sleep ?? ((milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    for (let attempt = 0; attempt < gracefulStopChecks; attempt += 1) {
        if (hasStopped(pid, signalProcess)) return "graceful"
        await sleep(gracefulStopDelayMs)
    }

    try {
        signalProcess(pid, "SIGKILL")
    }
    catch (error) {
        if (hasErrorCode(error, "ESRCH")) return "graceful"
        throw new Error(`Failed to send SIGKILL to PID ${pid}: ${flattenError(error)}`)
    }
    return "forced"
}

export async function runAutocodeProcessKill(rawArgs: AutocodeProcessKillArgs, deps: AutocodeProcessKillDependencies = defaultSandboxDependencies): Promise<string> {
    const serverPort = normalizePort(rawArgs.server_port)
    if (serverPort === undefined) {
        return createRetryResponse("kill server process", `Invalid server_port: ${String(rawArgs.server_port)}`, "Provide server_port as an integer from 1 to 65535.")
    }

    if (!await commandExists("lsof", deps)) {
        return createAbortResponse("kill server process", "Missing required command: lsof.", "Install lsof, then retry autocode_process_kill.")
    }

    let result: SandboxCommandResult
    try {
        result = await deps.spawn("lsof", [`-tiTCP:${serverPort}`, "-sTCP:LISTEN"])
    }
    catch (error) {
        return createAbortResponse(`find server listener on port ${serverPort}`, error)
    }

    if (result.exitCode !== 0 && result.exitCode !== 1) {
        return createAbortResponse(`find server listener on port ${serverPort}`, result.stderr.trim() || `lsof exited with code ${result.exitCode}.`)
    }

    const pids = parseListenerPids(result.stdout)
    if (pids.length === 0) {
        return createRetryResponse(
            `kill server process on port ${serverPort}`,
            `No TCP listener found on port ${serverPort}.`,
            "Check server_port and start the server if needed, then retry autocode_process_kill."
        )
    }

    const processes: { pid: number, termination: "graceful" | "forced" }[] = []
    const failures: string[] = []
    for (const pid of pids) {
        try {
            processes.push({ pid, termination: await stopProcess(pid, deps) })
        }
        catch (error) {
            failures.push(flattenError(error))
        }
    }

    if (failures.length > 0) return createAbortResponse(`kill server process on port ${serverPort}`, failures.join("; "))
    return JSON.stringify({ ok: true, action: "kill", server_port: serverPort, processes })
}

export function createAutocodeProcessKillTool(deps: AutocodeProcessKillDependencies = defaultSandboxDependencies): ReturnType<typeof tool> {
    return tool({
        description: "Kill local server process and free TCP port.",
        args: {
            port: tool.schema.number().int().min(1).max(65535).describe("TCP port to free."),
        },
        async execute(args, _context: ToolContext): Promise<string> {
            return runAutocodeProcessKill({ server_port: args.port }, deps)
        },
    })
}
