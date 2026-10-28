import { expect, spyOn, test } from "bun:test"
import type { ChildProcess, SpawnOptions } from "node:child_process"
import { EventEmitter } from "node:events"
import type { FSWatcher, WatchEventType } from "node:fs"
import { join } from "node:path"
import {
    type BuildDependencies,
    build,
    createBundleArgs,
    createCredentialsBundleArgs,
    createDeclarationArgs,
    repositoryRoot,
    resolveTypeScriptCli,
    runCli,
    watch,
} from "./build"

type FakeChild = Omit<ChildProcess, "exitCode" | "signalCode"> & {
    close: (exitCode: number | null, signal?: NodeJS.Signals) => void
    closeOnKill: boolean
    exitCode: number | null
    fail: (error: Error) => void
    readonly killCount: number
    signalCode: NodeJS.Signals | null
}

type FakeWatcher = FSWatcher & {
    change: (event: WatchEventType, filename: string | Buffer | null) => void
    readonly closeCount: number
    fail: (error: Error) => void
}

type PendingCopy = {
    promise: Promise<void>
    resolve: () => void
    reject: (error: Error) => void
}

type CopyCall = PendingCopy & {
    source: string
    target: string
    contents: string
}

type SpawnCall = {
    command: string
    args: string[]
    options: SpawnOptions
    child: FakeChild
}

type TestEnvironment = {
    dependencies: BuildDependencies
    events: string[]
    helper: { automatic: boolean; source: string; target: string | undefined }
    copyCalls: CopyCall[]
    watchCalls: Array<{ path: string; watcher: FakeWatcher }>
    spawnCalls: SpawnCall[]
    signals: NodeJS.Signals[]
    signalHandlers: Map<NodeJS.Signals, () => void>
    unregisteredSignals: NodeJS.Signals[]
}

type RunningBuild = {
    promise: Promise<void>
    settled: boolean
}

const copySkillsScript = join(repositoryRoot, "scripts", "copy-skill-sources.ts")
const helperFilename = "windows-credentials.ps1"
const helperDirectory = join(repositoryRoot, "src", "credentials")
const helperSource = join(helperDirectory, helperFilename)
const helperTarget = join(repositoryRoot, "dist", helperFilename)
const commandNames = ["plugin", "credentials CLI", "declarations", "skills"]
const watcherNames = ["plugin", "credentials CLI", "declarations"]

function createChild(closeWhenKilled: boolean = true): FakeChild {
    const child = new EventEmitter() as unknown as FakeChild
    let killCount = 0
    child.exitCode = null
    child.signalCode = null
    child.closeOnKill = closeWhenKilled
    Object.defineProperty(child, "killCount", { get: (): number => killCount })
    child.close = (exitCode: number | null, signal?: NodeJS.Signals): void => {
        child.exitCode = exitCode
        child.signalCode = signal ?? null
        child.emit("close", exitCode, child.signalCode)
    }
    child.fail = (error: Error): void => {
        child.emit("error", error)
    }
    child.kill = (): boolean => {
        killCount += 1
        if (child.closeOnKill) child.close(0)
        return true
    }
    return child
}

function createPendingCopy(): PendingCopy {
    let resolveCopy: () => void = (): void => undefined
    let rejectCopy: (error: Error) => void = (): void => undefined
    const promise = new Promise<void>((resolve, reject): void => {
        resolveCopy = resolve
        rejectCopy = reject
    })
    return { promise, resolve: resolveCopy, reject: rejectCopy }
}

function createEnvironment(onSpawn: (call: SpawnCall) => ChildProcess = (call): ChildProcess => closeSoon(call.child)): TestEnvironment {
    const events: string[] = []
    const helper: TestEnvironment["helper"] = { automatic: true, source: "initial helper", target: undefined }
    const copyCalls: CopyCall[] = []
    const watchCalls: TestEnvironment["watchCalls"] = []
    const spawnCalls: SpawnCall[] = []
    const signals: NodeJS.Signals[] = []
    const signalHandlers = new Map<NodeJS.Signals, () => void>()
    const unregisteredSignals: NodeJS.Signals[] = []
    const dependencies: BuildDependencies = {
        execPath: "/test/bun",
        rm: (async (): Promise<void> => {
            events.push("rm")
        }) as BuildDependencies["rm"],
        copyFile: ((source: string, target: string): Promise<void> => {
            const pending = createPendingCopy()
            const call = { ...pending, source, target, contents: helper.source }
            copyCalls.push(call)
            events.push("copy:helper")
            if (helper.automatic) pending.resolve()
            return pending.promise.then((): void => {
                helper.target = call.contents
            })
        }) as BuildDependencies["copyFile"],
        watch: ((path: string, listener: (event: WatchEventType, filename: string | Buffer | null) => void): FSWatcher => {
            const watcher = new EventEmitter() as unknown as FakeWatcher
            let closeCount = 0
            Object.defineProperty(watcher, "closeCount", { get: (): number => closeCount })
            watcher.on("change", listener)
            watcher.change = (event: WatchEventType, filename: string | Buffer | null): void => {
                watcher.emit("change", event, filename)
            }
            watcher.fail = (error: Error): void => {
                watcher.emit("error", error)
            }
            watcher.close = (): void => {
                closeCount += 1
                events.push("close:helper")
            }
            watchCalls.push({ path, watcher })
            events.push("watch:helper")
            return watcher
        }) as BuildDependencies["watch"],
        spawn: ((command: string, args: readonly string[], options?: SpawnOptions): ChildProcess => {
            const child = createChild()
            const call = { command, args: [...args], options: options ?? {}, child }
            spawnCalls.push(call)
            events.push(`spawn:${args[0]}`)
            return onSpawn(call)
        }) as BuildDependencies["spawn"],
        registerSignalHandler: (signal: NodeJS.Signals, handler: () => void): (() => void) => {
            signals.push(signal)
            signalHandlers.set(signal, handler)
            return (): void => {
                unregisteredSignals.push(signal)
                signalHandlers.delete(signal)
            }
        },
    }
    return { dependencies, events, helper, copyCalls, watchCalls, spawnCalls, signals, signalHandlers, unregisteredSignals }
}

function createWatchEnvironment(): TestEnvironment {
    return createEnvironment((call): ChildProcess => {
        if (call.args[0] === copySkillsScript) return closeSoon(call.child)
        return call.child
    })
}

function closeSoon(child: FakeChild): FakeChild {
    queueMicrotask((): void => child.close(0))
    return child
}

async function flushMicrotasks(): Promise<void> {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
}

async function flushUntil(condition: () => boolean): Promise<void> {
    for (let turn = 0; turn < 100 && !condition(); turn += 1) await Promise.resolve()
    expect(condition()).toBe(true)
}

async function waitForSpawnCalls(environment: TestEnvironment, count: number): Promise<void> {
    await flushUntil((): boolean => environment.spawnCalls.length >= count)
    expect(environment.spawnCalls).toHaveLength(count)
}

function observeResult(promise: Promise<void>): RunningBuild {
    const result = { promise, settled: false }
    void promise.then(
        (): void => { result.settled = true },
        (): void => { result.settled = true },
    )
    return result
}

async function finishRun(environment: TestEnvironment, result: RunningBuild): Promise<void> {
    environment.signalHandlers.get("SIGTERM")?.()
    for (const call of environment.spawnCalls) {
        if (call.child.exitCode === null && call.child.signalCode === null) call.child.close(0)
    }
    for (const call of environment.copyCalls) call.resolve()
    await flushUntil((): boolean => result.settled)
    await result.promise.catch((): void => undefined)
}

function expectCleanup(environment: TestEnvironment): void {
    expect(environment.signals).toEqual(["SIGINT", "SIGTERM"])
    expect(environment.unregisteredSignals).toEqual(["SIGINT", "SIGTERM"])
    expect(environment.signalHandlers.size).toBe(0)
    for (const call of environment.watchCalls) expect(call.watcher.closeCount).toBe(1)
}

test("creates exact portable bundle and declaration arguments", (): void => {
    expect(resolveTypeScriptCli()).toBe(join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"))
    expect(createBundleArgs(false)).toEqual([
        "build",
        join(repositoryRoot, "src", "plugin.ts"),
        "--outdir",
        join(repositoryRoot, "dist"),
        "--target",
        "bun",
        `--alias=cpu-features:${join(repositoryRoot, "scripts", "shims", "cpu-features.js")}`,
        "--external",
        "ssh2",
        "--external",
        "sshcrypto.node",
        "--external",
        "dbus-next",
    ])
    expect(createBundleArgs(true)).toEqual([...createBundleArgs(false), "--watch"])
    expect(createCredentialsBundleArgs(false)).toEqual([
        "build",
        join(repositoryRoot, "src", "credentials-cli.ts"),
        "--outdir",
        join(repositoryRoot, "dist"),
        "--target",
        "node",
        "--format",
        "esm",
        "--external",
        "dbus-next",
    ])
    expect(createCredentialsBundleArgs(true)).toEqual([...createCredentialsBundleArgs(false), "--watch"])
    expect(createDeclarationArgs(false)).toEqual([
        resolveTypeScriptCli(),
        "--project",
        join(repositoryRoot, "tsconfig.build.json"),
        "--emitDeclarationOnly",
        "--noEmit",
        "false",
    ])
    expect(createDeclarationArgs(true)).toEqual([...createDeclarationArgs(false), "--watch"])
})

test("build removes dist then awaits plugin, CLI, declarations, skills, and helper sequentially", async (): Promise<void> => {
    const environment = createEnvironment((call): ChildProcess => call.child)
    environment.helper.automatic = false
    const result = observeResult(build(environment.dependencies))

    try {
        for (let count = 1; count <= commandNames.length; count += 1) {
            await waitForSpawnCalls(environment, count)
            await flushMicrotasks()
            expect(environment.spawnCalls).toHaveLength(count)
            expect(environment.copyCalls).toHaveLength(0)
            expect(result.settled).toBe(false)
            environment.spawnCalls[count - 1].child.close(0)
        }
        await flushUntil((): boolean => environment.copyCalls.length === 1)
        expect(environment.copyCalls[0].source).toBe(helperSource)
        expect(environment.copyCalls[0].target).toBe(helperTarget)
        expect(environment.watchCalls).toHaveLength(0)
        expect(result.settled).toBe(false)
        expect(environment.events).toEqual(["rm", "spawn:build", "spawn:build", `spawn:${resolveTypeScriptCli()}`, `spawn:${copySkillsScript}`, "copy:helper"])
        expect(environment.spawnCalls.map((call): [string, string[], SpawnOptions] => [call.command, call.args, call.options])).toEqual([
            ["/test/bun", createBundleArgs(false), { cwd: repositoryRoot, shell: false, stdio: "inherit" }],
            ["/test/bun", createCredentialsBundleArgs(false), { cwd: repositoryRoot, shell: false, stdio: "inherit" }],
            ["/test/bun", createDeclarationArgs(false), { cwd: repositoryRoot, shell: false, stdio: "inherit" }],
            ["/test/bun", [copySkillsScript], { cwd: repositoryRoot, shell: false, stdio: "inherit" }],
        ])
        environment.copyCalls[0].resolve()
        await result.promise
        expect(environment.helper.target).toBe(environment.helper.source)
        expectCleanup(environment)
    } finally {
        await finishRun(environment, result)
    }
})

test.each(commandNames)("build rejects nonzero %s exit before later work", async (name: string): Promise<void> => {
    const failedIndex = commandNames.indexOf(name)
    let spawned = 0
    const environment = createEnvironment((call): ChildProcess => {
        const exitCode = spawned++ === failedIndex ? 3 : 0
        queueMicrotask((): void => call.child.close(exitCode))
        return call.child
    })

    await expect(build(environment.dependencies)).rejects.toThrow("Build command exited with code 3.")
    expect(environment.spawnCalls).toHaveLength(failedIndex + 1)
    expect(environment.copyCalls).toHaveLength(0)
    expectCleanup(environment)
})

test.each(commandNames)("build rejects synchronous %s spawn failure", async (name: string): Promise<void> => {
    const failedIndex = commandNames.indexOf(name)
    const error = new Error(`${name} spawn failed`)
    let spawned = 0
    const environment = createEnvironment((call): ChildProcess => {
        if (spawned++ === failedIndex) throw error
        return closeSoon(call.child)
    })

    await expect(build(environment.dependencies)).rejects.toBe(error)
    expect(environment.spawnCalls).toHaveLength(failedIndex + 1)
    expect(environment.copyCalls).toHaveLength(0)
    expectCleanup(environment)
})

test("build rejects child errors and closes the failed child", async (): Promise<void> => {
    const error = new Error("plugin process failed")
    const environment = createEnvironment((call): ChildProcess => {
        queueMicrotask((): void => call.child.fail(error))
        return call.child
    })

    await expect(build(environment.dependencies)).rejects.toBe(error)
    expect(environment.spawnCalls).toHaveLength(1)
    expect(environment.spawnCalls[0].child.killCount).toBe(1)
    expect(environment.copyCalls).toHaveLength(0)
    expectCleanup(environment)
})

test.each(["EACCES", "ENOENT"])("build rejects initial helper copy failure %s", async (code: string): Promise<void> => {
    const environment = createEnvironment()
    environment.helper.automatic = false
    const error = Object.assign(new Error("initial helper copy failed"), { code })
    const result = observeResult(build(environment.dependencies))

    try {
        await flushUntil((): boolean => environment.copyCalls.length === 1)
        environment.copyCalls[0].reject(error)
        await expect(result.promise).rejects.toBe(error)
        expect(environment.spawnCalls).toHaveLength(4)
        expectCleanup(environment)
    } finally {
        await finishRun(environment, result)
    }
})

test("watch awaits skills and initial helper copy before starting three child watchers", async (): Promise<void> => {
    const environment = createWatchEnvironment()
    environment.helper.automatic = false
    const result = observeResult(watch(environment.dependencies))

    try {
        await flushUntil((): boolean => environment.copyCalls.length === 1)
        expect(environment.spawnCalls).toHaveLength(1)
        expect(environment.spawnCalls[0].args).toEqual([copySkillsScript])
        expect(environment.watchCalls).toHaveLength(1)
        expect(environment.watchCalls[0].path).toBe(helperDirectory)
        expect(environment.copyCalls[0].source).toBe(helperSource)
        expect(environment.copyCalls[0].target).toBe(helperTarget)
        expect(result.settled).toBe(false)
        environment.copyCalls[0].resolve()
        await waitForSpawnCalls(environment, 4)

        expect(environment.events).toEqual(["rm", `spawn:${copySkillsScript}`, "watch:helper", "copy:helper", "spawn:build", "spawn:build", `spawn:${resolveTypeScriptCli()}`])
        expect(environment.spawnCalls.slice(1).map((call): [string, string[], SpawnOptions] => [call.command, call.args, call.options])).toEqual([
            ["/test/bun", createBundleArgs(true), { cwd: repositoryRoot, shell: false, stdio: "inherit" }],
            ["/test/bun", createCredentialsBundleArgs(true), { cwd: repositoryRoot, shell: false, stdio: "inherit" }],
            ["/test/bun", createDeclarationArgs(true), { cwd: repositoryRoot, shell: false, stdio: "inherit" }],
        ])
        environment.spawnCalls[1].child.close(0)
        await result.promise
        expect(environment.spawnCalls.slice(1).map((call): number => call.child.killCount)).toEqual([0, 1, 1])
        expectCleanup(environment)
    } finally {
        await finishRun(environment, result)
    }
})

test("watch filters unrelated filenames and recopies helper changes, renames, buffers, and null filenames", async (): Promise<void> => {
    const environment = createWatchEnvironment()
    const result = observeResult(watch(environment.dependencies))

    try {
        await waitForSpawnCalls(environment, 4)
        const watcher = environment.watchCalls[0].watcher
        watcher.change("change", "other.ps1")
        watcher.change("rename", Buffer.from("other.ps1"))
        await flushMicrotasks()
        expect(environment.copyCalls).toHaveLength(1)

        const updates: Array<[WatchEventType, string | Buffer | null]> = [
            ["change", helperFilename],
            ["rename", helperFilename],
            ["change", Buffer.from(helperFilename)],
            ["rename", null],
        ]
        for (const [event, filename] of updates) {
            const count = environment.copyCalls.length
            watcher.change(event, filename)
            await flushUntil((): boolean => environment.copyCalls.length === count + 1)
        }
        await flushMicrotasks()
        expect(environment.copyCalls.map((call): string[] => [call.source, call.target])).toEqual(Array.from({ length: 5 }, (): string[] => [helperSource, helperTarget]))
        expect(result.settled).toBe(false)
    } finally {
        await finishRun(environment, result)
    }
    expectCleanup(environment)
})

test("watch serializes queued helper updates and preserves the latest asset", async (): Promise<void> => {
    const environment = createWatchEnvironment()
    const result = observeResult(watch(environment.dependencies))

    try {
        await waitForSpawnCalls(environment, 4)
        const watcher = environment.watchCalls[0].watcher
        environment.helper.automatic = false
        environment.helper.source = "first update"
        watcher.change("change", helperFilename)
        await flushUntil((): boolean => environment.copyCalls.length === 2)
        environment.helper.source = "second update"
        watcher.change("rename", helperFilename)
        await flushMicrotasks()
        expect(environment.copyCalls).toHaveLength(2)
        expect(environment.helper.target).toBe("initial helper")

        environment.copyCalls[1].resolve()
        await flushUntil((): boolean => environment.copyCalls.length === 3)
        expect(environment.helper.target).toBe("first update")
        expect(environment.copyCalls[2].contents).toBe("second update")
        environment.helper.source = "latest update"
        watcher.change("change", helperFilename)
        await flushMicrotasks()
        expect(environment.copyCalls).toHaveLength(3)

        environment.copyCalls[2].resolve()
        await flushUntil((): boolean => environment.copyCalls.length === 4)
        expect(environment.helper.target).toBe("second update")
        expect(environment.copyCalls[3].contents).toBe("latest update")
        environment.copyCalls[3].resolve()
        await flushUntil((): boolean => environment.helper.target === "latest update")
        expect(result.settled).toBe(false)
    } finally {
        await finishRun(environment, result)
    }
    expectCleanup(environment)
})

test.each(["EACCES", "ENOENT"])("watch rejects initial helper copy failure %s before child watchers start", async (code: string): Promise<void> => {
    const environment = createWatchEnvironment()
    environment.helper.automatic = false
    const error = Object.assign(new Error("initial helper copy failed"), { code })
    const result = observeResult(watch(environment.dependencies))

    try {
        await flushUntil((): boolean => environment.copyCalls.length === 1)
        environment.copyCalls[0].reject(error)
        await expect(result.promise).rejects.toBe(error)
        expect(environment.spawnCalls).toHaveLength(1)
        expectCleanup(environment)
    } finally {
        await finishRun(environment, result)
    }
})

test("watch rejects skill copy exit before helper watch or child watchers start", async (): Promise<void> => {
    const environment = createEnvironment((call): ChildProcess => {
        queueMicrotask((): void => call.child.close(9))
        return call.child
    })
    const result = observeResult(watch(environment.dependencies))

    try {
        await expect(result.promise).rejects.toThrow("Build command exited with code 9.")
        expect(environment.spawnCalls).toHaveLength(1)
        expect(environment.copyCalls).toHaveLength(0)
        expect(environment.watchCalls).toHaveLength(0)
        expectCleanup(environment)
    } finally {
        await finishRun(environment, result)
    }
})

test.each(["skills", ...watcherNames])("watch cleans up after synchronous %s spawn failure", async (name: string): Promise<void> => {
    const failedIndex = ["skills", ...watcherNames].indexOf(name)
    const error = new Error(`${name} spawn failed`)
    let spawned = 0
    const environment = createEnvironment((call): ChildProcess => {
        if (spawned++ === failedIndex) throw error
        return call.args[0] === copySkillsScript ? closeSoon(call.child) : call.child
    })
    const result = observeResult(watch(environment.dependencies))

    try {
        await expect(result.promise).rejects.toBe(error)
        expect(environment.spawnCalls).toHaveLength(failedIndex + 1)
        for (const call of environment.spawnCalls.slice(1, failedIndex)) expect(call.child.killCount).toBe(1)
        expect(environment.watchCalls).toHaveLength(failedIndex === 0 ? 0 : 1)
        expectCleanup(environment)
    } finally {
        await finishRun(environment, result)
    }
})

test.each(watcherNames)("watch kills both siblings and waits for each close after %s watcher failure", async (name: string): Promise<void> => {
    const environment = createWatchEnvironment()
    const result = observeResult(watch(environment.dependencies))

    try {
        await waitForSpawnCalls(environment, 4)
        const watchers = environment.spawnCalls.slice(1).map((call): FakeChild => call.child)
        const failed = watchers[watcherNames.indexOf(name)]
        const siblings = watchers.filter((child): boolean => child !== failed)
        for (const child of siblings) child.closeOnKill = false
        failed.close(7)
        await flushMicrotasks()

        expect(siblings.map((child): number => child.killCount)).toEqual([1, 1])
        expect(failed.killCount).toBe(0)
        expect(environment.watchCalls[0].watcher.closeCount).toBe(1)
        expect(result.settled).toBe(false)
        expect(environment.unregisteredSignals).toHaveLength(0)
        siblings[0].close(0)
        await flushMicrotasks()
        expect(result.settled).toBe(false)
        siblings[1].close(0)
        await expect(result.promise).rejects.toThrow("Build watcher exited with code 7.")
        expectCleanup(environment)
    } finally {
        await finishRun(environment, result)
    }
})

test("watch rejects child error events and terminates all child watchers", async (): Promise<void> => {
    const environment = createWatchEnvironment()
    const error = new Error("credentials watcher failed")
    const result = observeResult(watch(environment.dependencies))

    try {
        await waitForSpawnCalls(environment, 4)
        environment.spawnCalls[2].child.fail(error)
        await expect(result.promise).rejects.toBe(error)
        expect(environment.spawnCalls.slice(1).map((call): number => call.child.killCount)).toEqual([1, 1, 1])
        expectCleanup(environment)
    } finally {
        await finishRun(environment, result)
    }
})

test("watch rejects helper recopy failures and terminates all child watchers", async (): Promise<void> => {
    const environment = createWatchEnvironment()
    const error = Object.assign(new Error("helper update failed"), { code: "EACCES" })
    const result = observeResult(watch(environment.dependencies))

    try {
        await waitForSpawnCalls(environment, 4)
        environment.helper.automatic = false
        environment.watchCalls[0].watcher.change("change", helperFilename)
        await flushUntil((): boolean => environment.copyCalls.length === 2)
        environment.copyCalls[1].reject(error)
        await expect(result.promise).rejects.toBe(error)
        expect(environment.spawnCalls.slice(1).map((call): number => call.child.killCount)).toEqual([1, 1, 1])
        expectCleanup(environment)
    } finally {
        await finishRun(environment, result)
    }
})

test("watch tolerates transient ENOENT during recopy and copies the replacement helper", async (): Promise<void> => {
    const environment = createWatchEnvironment()
    const result = observeResult(watch(environment.dependencies))

    try {
        await waitForSpawnCalls(environment, 4)
        const watcher = environment.watchCalls[0].watcher
        environment.helper.automatic = false
        watcher.change("rename", helperFilename)
        await flushUntil((): boolean => environment.copyCalls.length === 2)
        environment.copyCalls[1].reject(Object.assign(new Error("helper temporarily missing"), { code: "ENOENT" }))
        await flushMicrotasks()
        expect(result.settled).toBe(false)
        expect(watcher.closeCount).toBe(0)
        expect(environment.spawnCalls.slice(1).map((call): number => call.child.killCount)).toEqual([0, 0, 0])

        environment.helper.source = "replacement helper"
        watcher.change("rename", helperFilename)
        await flushUntil((): boolean => environment.copyCalls.length === 3)
        environment.copyCalls[2].resolve()
        await flushUntil((): boolean => environment.helper.target === "replacement helper")
        expect(result.settled).toBe(false)
    } finally {
        await finishRun(environment, result)
    }
    expectCleanup(environment)
})

test("watch rejects asset watcher errors and terminates child watchers", async (): Promise<void> => {
    const environment = createWatchEnvironment()
    const error = new Error("helper watcher failed")
    const result = observeResult(watch(environment.dependencies))

    try {
        await waitForSpawnCalls(environment, 4)
        environment.watchCalls[0].watcher.fail(error)
        await expect(result.promise).rejects.toBe(error)
        expect(environment.spawnCalls.slice(1).map((call): number => call.child.killCount)).toEqual([1, 1, 1])
        expectCleanup(environment)
    } finally {
        await finishRun(environment, result)
    }
})

test("watch drains initial helper copy after asset watcher error without starting children", async (): Promise<void> => {
    const environment = createWatchEnvironment()
    environment.helper.automatic = false
    const error = new Error("initial helper watcher failed")
    const result = observeResult(watch(environment.dependencies))

    try {
        await flushUntil((): boolean => environment.copyCalls.length === 1)
        environment.watchCalls[0].watcher.fail(error)
        await flushMicrotasks()
        expect(result.settled).toBe(false)
        expect(environment.spawnCalls).toHaveLength(1)
        environment.copyCalls[0].resolve()
        await expect(result.promise).rejects.toBe(error)
        expect(environment.spawnCalls).toHaveLength(1)
        expectCleanup(environment)
    } finally {
        await finishRun(environment, result)
    }
})

test.each(["SIGINT", "SIGTERM"] as const)("watch handles %s by closing watchers, waiting for children, and draining pending copies", async (signal: NodeJS.Signals): Promise<void> => {
    const environment = createWatchEnvironment()
    const result = observeResult(watch(environment.dependencies))

    try {
        await waitForSpawnCalls(environment, 4)
        environment.helper.automatic = false
        const watcher = environment.watchCalls[0].watcher
        watcher.change("change", helperFilename)
        await flushUntil((): boolean => environment.copyCalls.length === 2)
        watcher.change("rename", helperFilename)
        const children = environment.spawnCalls.slice(1).map((call): FakeChild => call.child)
        for (const child of children) child.closeOnKill = false
        expect(environment.signalHandlers.has(signal)).toBe(true)
        environment.signalHandlers.get(signal)?.()
        await flushMicrotasks()

        expect(children.map((child): number => child.killCount)).toEqual([1, 1, 1])
        expect(watcher.closeCount).toBe(1)
        expect(result.settled).toBe(false)
        expect(environment.unregisteredSignals).toHaveLength(0)
        for (const child of children) child.close(null, "SIGTERM")
        await flushMicrotasks()
        expect(result.settled).toBe(false)
        expect(environment.unregisteredSignals).toHaveLength(0)
        environment.copyCalls[1].resolve()
        await expect(result.promise).rejects.toThrow("Build watch stopped by parent signal.")
        expect(environment.copyCalls).toHaveLength(2)
        expectCleanup(environment)
    } finally {
        await finishRun(environment, result)
    }
})

test("runCli rejects every mode except exact build or watch", async () => {
    const error = spyOn(console, "error").mockImplementation((): void => undefined)
    const environment = createEnvironment((call): ChildProcess => closeSoon(call.child))

    try {
        await expect(runCli([], environment.dependencies)).resolves.toBe(1)
        await expect(runCli(["BUILD"], environment.dependencies)).resolves.toBe(1)
        await expect(runCli(["build", "extra"], environment.dependencies)).resolves.toBe(1)
        expect(environment.events).toEqual([])
        expect(error).toHaveBeenCalledTimes(3)
    } finally {
        error.mockRestore()
    }
})
