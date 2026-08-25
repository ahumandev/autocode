import { type ChildProcess, spawn as spawnChild } from "node:child_process"
import { rm as removePath } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export type BuildDependencies = {
    execPath: string
    rm: typeof removePath
    spawn: typeof spawnChild
    registerSignalHandler: (signal: NodeJS.Signals, handler: () => void) => () => void
}

type WatchExit = {
    child: ChildProcess
    error?: Error
    exitCode?: number | null
}

type WatchExitController = {
    promise: Promise<WatchExit>
    stop: (error: Error) => void
}

const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = resolve(scriptsDirectory, "..")
const distDirectory = join(repositoryRoot, "dist")
const pluginEntry = join(repositoryRoot, "src", "plugin.ts")
const declarationConfig = join(repositoryRoot, "tsconfig.build.json")
const copySkillSourcesScript = join(repositoryRoot, "scripts", "copy-skill-sources.ts")
// Alias cpu-features to project shim so Bun never loads its Node/NAN addon.
const cpuFeaturesShim = join(repositoryRoot, "scripts", "shims", "cpu-features.js")
const projectRequire = createRequire(join(repositoryRoot, "package.json"))

function registerProcessSignalHandler(signal: NodeJS.Signals, handler: () => void): () => void {
    process.once(signal, handler)
    return (): void => {
        process.off(signal, handler)
    }
}

export const defaultBuildDependencies: BuildDependencies = {
    execPath: process.execPath,
    rm: removePath,
    spawn: spawnChild,
    registerSignalHandler: registerProcessSignalHandler,
}

export function resolveTypeScriptCli(): string {
    return projectRequire.resolve("typescript/bin/tsc")
}

export function createBundleArgs(watch: boolean): string[] {
    // External native SSH modules make ssh2 catch their absence and use JavaScript crypto fallback.
    const args = ["build", pluginEntry, "--outdir", distDirectory, "--target", "bun", `--alias=cpu-features:${cpuFeaturesShim}`, "--external", "ssh2", "--external", "sshcrypto.node"]
    if (watch) args.push("--watch")
    return args
}

export function createDeclarationArgs(watch: boolean): string[] {
    const args = [resolveTypeScriptCli(), "--project", declarationConfig, "--emitDeclarationOnly", "--noEmit", "false"]
    if (watch) args.push("--watch")
    return args
}

function spawnProcess(command: string, args: readonly string[], deps: BuildDependencies): ChildProcess {
    return deps.spawn(command, args, { cwd: repositoryRoot, shell: false, stdio: "inherit" })
}

function waitForCommand(child: ChildProcess): Promise<void> {
    return new Promise((resolveCommand, rejectCommand) => {
        child.once("error", rejectCommand)
        child.once("close", (exitCode: number | null) => {
            if (exitCode === 0) {
                resolveCommand()
                return
            }
            rejectCommand(new Error(`Build command exited with code ${exitCode ?? "unknown"}.`))
        })
    })
}

async function runCommand(command: string, args: readonly string[], deps: BuildDependencies): Promise<void> {
    await waitForCommand(spawnProcess(command, args, deps))
}

async function removeDist(deps: BuildDependencies): Promise<void> {
    await deps.rm(distDirectory, { recursive: true, force: true })
}

async function copySkillSources(deps: BuildDependencies): Promise<void> {
    await runCommand(deps.execPath, [copySkillSourcesScript], deps)
}

export async function build(deps: BuildDependencies = defaultBuildDependencies): Promise<void> {
    await removeDist(deps)
    await runCommand(deps.execPath, createBundleArgs(false), deps)
    await runCommand(deps.execPath, createDeclarationArgs(false), deps)
    await copySkillSources(deps)
}

function hasClosed(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null
}

function waitForClose(child: ChildProcess): Promise<void> {
    if (hasClosed(child)) return Promise.resolve()

    return new Promise((resolveClose) => {
        child.once("close", (): void => resolveClose())
    })
}

async function terminateChildren(children: readonly ChildProcess[], excludedChild?: ChildProcess): Promise<void> {
    const remainingChildren = children.filter((child) => child !== excludedChild)
    for (const child of remainingChildren) {
        if (hasClosed(child)) continue
        try {
            child.kill()
        }
        catch {
            // A child can close between status check and kill.
        }
    }
    await Promise.all(children.map(waitForClose))
}

function createWatchExitController(children: readonly ChildProcess[]): WatchExitController {
    let settle: (exit: WatchExit) => void = (): void => undefined
    const promise = new Promise<WatchExit>((resolveExit) => {
        let settled = false
        settle = (exit: WatchExit): void => {
            if (settled) return
            settled = true
            resolveExit(exit)
        }
        for (const child of children) {
            child.once("error", (error: Error): void => settle({ child, error }))
            child.once("close", (exitCode: number | null): void => settle({ child, exitCode }))
            if (hasClosed(child)) settle({ child, exitCode: child.exitCode })
        }
    })
    return { promise, stop: (error: Error): void => settle({ child: children[0], error }) }
}

export async function watch(deps: BuildDependencies = defaultBuildDependencies): Promise<void> {
    await removeDist(deps)
    await copySkillSources(deps)

    const bundleWatcher = spawnProcess(deps.execPath, createBundleArgs(true), deps)
    let declarationWatcher: ChildProcess
    try {
        declarationWatcher = spawnProcess(deps.execPath, createDeclarationArgs(true), deps)
    }
    catch (error) {
        await terminateChildren([bundleWatcher])
        throw error
    }
    const watchers = [bundleWatcher, declarationWatcher]
    const exits = createWatchExitController(watchers)
    const stopForSignal = (): void => exits.stop(new Error("Build watch stopped by parent signal."))
    const unregisterSignalHandlers = [
        deps.registerSignalHandler("SIGINT", stopForSignal),
        deps.registerSignalHandler("SIGTERM", stopForSignal),
    ]

    try {
        const exit = await exits.promise
        await terminateChildren(watchers, exit.error ? undefined : exit.child)
        if (exit.error) throw exit.error
        if (exit.exitCode !== 0) throw new Error(`Build watcher exited with code ${exit.exitCode ?? "unknown"}.`)
    }
    finally {
        unregisterSignalHandlers.forEach((unregister): void => {
            unregister()
        })
    }
}

export async function runCli(args: readonly string[], deps: BuildDependencies = defaultBuildDependencies): Promise<number> {
    if (args.length !== 1 || (args[0] !== "build" && args[0] !== "watch")) {
        console.error('Invalid build mode. Use "build" or "watch".')
        return 1
    }

    try {
        if (args[0] === "build") await build(deps)
        else await watch(deps)
        return 0
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        return 1
    }
}

function isDirectExecution(): boolean {
    const entry = process.argv[1]
    return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)
}

if (isDirectExecution()) {
    process.exitCode = await runCli(process.argv.slice(2))
}
