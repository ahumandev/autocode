import { type ChildProcess, spawn as spawnChild } from "node:child_process"
import { type FSWatcher, watch as watchPath } from "node:fs"
import { copyFile, rm as removePath } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export type BuildDependencies = {
    execPath: string
    rm: typeof removePath
    copyFile: typeof copyFile
    watch: typeof watchPath
    spawn: typeof spawnChild
    registerSignalHandler: (signal: NodeJS.Signals, handler: () => void) => () => void
}

type WatchExit = {
    error?: Error
    exitCode?: number | null
}

type WatchExitController = {
    promise: Promise<WatchExit>
    stop: (error: Error) => void
    observe: (child: ChildProcess) => void
}

const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = resolve(scriptsDirectory, "..")
const distDirectory = join(repositoryRoot, "dist")
const pluginEntry = join(repositoryRoot, "src", "plugin.ts")
const credentialsEntry = join(repositoryRoot, "src", "credentials-cli.ts")
const credentialsDirectory = join(repositoryRoot, "src", "credentials")
const windowsHelperFilename = "windows-credentials.ps1"
const windowsHelperSource = join(credentialsDirectory, windowsHelperFilename)
const windowsHelperTarget = join(distDirectory, windowsHelperFilename)
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
    copyFile,
    watch: watchPath,
    spawn: spawnChild,
    registerSignalHandler: registerProcessSignalHandler,
}

export function resolveTypeScriptCli(): string {
    return projectRequire.resolve("typescript/bin/tsc")
}

export function createBundleArgs(watch: boolean): string[] {
    // External native SSH modules make ssh2 catch their absence and use JavaScript crypto fallback.
    const args = ["build", pluginEntry, "--outdir", distDirectory, "--target", "bun", `--alias=cpu-features:${cpuFeaturesShim}`, "--external", "ssh2", "--external", "sshcrypto.node", "--external", "dbus-next"]
    if (watch) args.push("--watch")
    return args
}

export function createCredentialsBundleArgs(watch: boolean): string[] {
    const args = ["build", credentialsEntry, "--outdir", distDirectory, "--target", "node", "--format", "esm", "--external", "dbus-next"]
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

export async function build(deps: BuildDependencies = defaultBuildDependencies): Promise<void> {
    await runBuild(false, deps)
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

function createWatchExitController(): WatchExitController {
    let settle: (exit: WatchExit) => void = (): void => undefined
    const promise = new Promise<WatchExit>((resolveExit) => {
        let settled = false
        settle = (exit: WatchExit): void => {
            if (settled) return
            settled = true
            resolveExit(exit)
        }
    })
    const observe = (child: ChildProcess): void => {
        child.once("error", (error: Error): void => settle({ error }))
        child.once("close", (exitCode: number | null): void => settle({ exitCode }))
        if (hasClosed(child)) settle({ exitCode: child.exitCode })
    }
    return { promise, stop: (error: Error): void => settle({ error }), observe }
}

async function runBuild(watchMode: boolean, deps: BuildDependencies): Promise<void> {
    const children: ChildProcess[] = []
    let helperWatcher: FSWatcher | undefined
    let helperCopies = Promise.resolve()
    let exits: WatchExitController | undefined
    let stopError: Error | undefined
    let stopped = false
    const unregisterSignalHandlers: Array<() => void> = []
    const stop = (error: Error): void => {
        if (stopError) return
        stopError = error
        stopped = true
        if (exits) exits.stop(error)
        else void terminateChildren(children)
    }
    const throwIfStopped = (): void => {
        if (stopError) throw stopError
    }
    const queueHelperCopy = (allowMissing: boolean): Promise<void> => {
        helperCopies = helperCopies.then(async (): Promise<void> => {
            if (stopped) return
            try {
                await deps.copyFile(windowsHelperSource, windowsHelperTarget)
            }
            catch (error) {
                // Atomic source replacement can briefly remove the helper before its next rename event.
                if (allowMissing && typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return
                throw error
            }
        })
        return helperCopies
    }
    const stopForSignal = (): void => stop(new Error(watchMode ? "Build watch stopped by parent signal." : "Build stopped by parent signal."))

    try {
        unregisterSignalHandlers.push(deps.registerSignalHandler("SIGINT", stopForSignal))
        unregisterSignalHandlers.push(deps.registerSignalHandler("SIGTERM", stopForSignal))
        // OpenCode's installed shim points at dist/plugin.js, including during rebuilds.
        // Let each build step replace its outputs instead of removing the live entrypoint.
        throwIfStopped()
        const preparationArgs = watchMode
            ? [[copySkillSourcesScript]]
            : [createBundleArgs(false), createCredentialsBundleArgs(false), createDeclarationArgs(false), [copySkillSourcesScript]]
        for (const args of preparationArgs) {
            const child = spawnProcess(deps.execPath, args, deps)
            children.push(child)
            await waitForCommand(child)
            throwIfStopped()
        }

        if (watchMode) {
            // Watching the parent keeps helper updates visible after source file replacement.
            helperWatcher = deps.watch(credentialsDirectory, (_event, filename): void => {
                if (filename !== null && filename.toString() !== windowsHelperFilename) return
                void queueHelperCopy(true).catch((error: unknown): void => {
                    stop(error instanceof Error ? error : new Error(String(error)))
                })
            })
            helperWatcher.on("error", stop)
        }
        await queueHelperCopy(false)
        throwIfStopped()

        if (watchMode) {
            exits = createWatchExitController()
            for (const args of [createBundleArgs(true), createCredentialsBundleArgs(true), createDeclarationArgs(true)]) {
                const child = spawnProcess(deps.execPath, args, deps)
                children.push(child)
                exits.observe(child)
            }
            const exit = await exits.promise
            if (exit.error) throw exit.error
            if (exit.exitCode !== 0) throw new Error(`Build watcher exited with code ${exit.exitCode ?? "unknown"}.`)
        }
    }
    finally {
        stopped = true
        helperWatcher?.close()
        await terminateChildren(children)
        await helperCopies.catch((): void => undefined)
        unregisterSignalHandlers.forEach((unregister): void => {
            unregister()
        })
    }
    throwIfStopped()
}

export async function watch(deps: BuildDependencies = defaultBuildDependencies): Promise<void> {
    await runBuild(true, deps)
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
