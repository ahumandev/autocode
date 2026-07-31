import { expect, spyOn, test } from "bun:test"
import type { ChildProcess, SpawnOptions } from "node:child_process"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import {
    type BuildDependencies,
    build,
    createBundleArgs,
    createDeclarationArgs,
    repositoryRoot,
    resolveTypeScriptCli,
    runCli,
    watch,
} from "./build"

type FakeChild = Omit<ChildProcess, "exitCode" | "signalCode"> & {
    close: (exitCode: number | null) => void
    closeOnKill: boolean
    exitCode: number | null
    fail: (error: Error) => void
    readonly killCount: number
    signalCode: NodeJS.Signals | null
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
    spawnCalls: SpawnCall[]
    signals: NodeJS.Signals[]
    unregisteredSignals: NodeJS.Signals[]
}

function createChild(closeWhenKilled: boolean = true): FakeChild {
    const child = new EventEmitter() as unknown as FakeChild
    let killCount = 0
    child.exitCode = null
    child.signalCode = null
    child.closeOnKill = closeWhenKilled
    Object.defineProperty(child, "killCount", { get: (): number => killCount })
    child.close = (exitCode: number | null): void => {
        child.exitCode = exitCode
        child.emit("close", exitCode)
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

function createEnvironment(onSpawn: (call: SpawnCall) => ChildProcess): TestEnvironment {
    const events: string[] = []
    const spawnCalls: SpawnCall[] = []
    const signals: NodeJS.Signals[] = []
    const unregisteredSignals: NodeJS.Signals[] = []
    const dependencies: BuildDependencies = {
        execPath: "/test/bun",
        rm: (async (): Promise<void> => {
            events.push("rm")
        }) as BuildDependencies["rm"],
        spawn: ((command: string, args: readonly string[], options?: SpawnOptions): ChildProcess => {
            const child = createChild()
            const call = { command, args: [...args], options: options ?? {}, child }
            spawnCalls.push(call)
            events.push(`spawn:${args[0]}`)
            return onSpawn(call)
        }) as BuildDependencies["spawn"],
        registerSignalHandler: (signal: NodeJS.Signals): (() => void) => {
            signals.push(signal)
            return (): void => {
                unregisteredSignals.push(signal)
            }
        },
    }
    return { dependencies, events, spawnCalls, signals, unregisteredSignals }
}

function closeSoon(child: FakeChild): FakeChild {
    queueMicrotask((): void => child.close(0))
    return child
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
}

async function waitForSpawnCalls(environment: TestEnvironment, count: number): Promise<void> {
    while (environment.spawnCalls.length < count) await Promise.resolve()
}

test("creates exact portable bundle and declaration arguments", () => {
    expect(resolveTypeScriptCli()).toBe(join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"))
    expect(createBundleArgs(false)).toEqual([
        "build",
        join(repositoryRoot, "src", "plugin.ts"),
        "--outdir",
        join(repositoryRoot, "dist"),
        "--target",
        "bun",
        "--external",
        "cpu-features",
    ])
    expect(createBundleArgs(true)).toEqual([...createBundleArgs(false), "--watch"])
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

test("build removes dist then bundles, emits declarations, and copies skills sequentially", async () => {
    const environment = createEnvironment((call): ChildProcess => closeSoon(call.child))

    await build(environment.dependencies)

    expect(environment.events).toEqual(["rm", "spawn:build", `spawn:${resolveTypeScriptCli()}`, `spawn:${join(repositoryRoot, "scripts", "copy-skill-sources.ts")}`])
    expect(environment.spawnCalls.map((call) => [call.command, call.args, call.options])).toEqual([
        ["/test/bun", createBundleArgs(false), { cwd: repositoryRoot, shell: false, stdio: "inherit" }],
        ["/test/bun", createDeclarationArgs(false), { cwd: repositoryRoot, shell: false, stdio: "inherit" }],
        ["/test/bun", [join(repositoryRoot, "scripts", "copy-skill-sources.ts")], { cwd: repositoryRoot, shell: false, stdio: "inherit" }],
    ])
})

test("build rejects nonzero bundle exit before declarations or copy start", async () => {
    const environment = createEnvironment((call): ChildProcess => {
        if (call.args[0] === "build") queueMicrotask((): void => call.child.close(3))
        return call.child
    })

    await expect(build(environment.dependencies)).rejects.toThrow("Build command exited with code 3.")

    expect(environment.events).toEqual(["rm", "spawn:build"])
})

test("watch copies before starting both watchers concurrently", async () => {
    const environment = createEnvironment((call): ChildProcess => {
        if (call.args[0] === join(repositoryRoot, "scripts", "copy-skill-sources.ts")) return closeSoon(call.child)
        return call.child
    })
    const result = watch(environment.dependencies)

    await waitForSpawnCalls(environment, 3)

    expect(environment.events).toEqual(["rm", `spawn:${join(repositoryRoot, "scripts", "copy-skill-sources.ts")}`, "spawn:build", `spawn:${resolveTypeScriptCli()}`])
    expect(environment.spawnCalls.slice(1).map((call) => [call.command, call.args, call.options])).toEqual([
        ["/test/bun", createBundleArgs(true), { cwd: repositoryRoot, shell: false, stdio: "inherit" }],
        ["/test/bun", createDeclarationArgs(true), { cwd: repositoryRoot, shell: false, stdio: "inherit" }],
    ])

    environment.spawnCalls[1].child.close(0)
    await result
    expect(environment.spawnCalls[2].child.killCount).toBe(1)
})

test("watch kills sibling, waits for close, and unregisters handlers after watcher failure", async () => {
    const environment = createEnvironment((call): ChildProcess => {
        if (call.args[0] === join(repositoryRoot, "scripts", "copy-skill-sources.ts")) return closeSoon(call.child)
        return call.child
    })
    const result = watch(environment.dependencies)

    await waitForSpawnCalls(environment, 3)
    environment.spawnCalls[2].child.closeOnKill = false
    let completed = false
    void result.then(
        (): void => { completed = true },
        (): void => { completed = true },
    )
    environment.spawnCalls[1].child.close(2)

    await flushMicrotasks()
    expect(completed).toBe(false)
    environment.spawnCalls[2].child.close(0)
    await expect(result).rejects.toThrow("Build watcher exited with code 2.")
    expect(environment.spawnCalls[2].child.killCount).toBe(1)
    expect(environment.signals).toEqual(["SIGINT", "SIGTERM"])
    expect(environment.unregisteredSignals).toEqual(["SIGINT", "SIGTERM"])
})

test("watch rejects nonzero watcher exit after sibling closes", async () => {
    const environment = createEnvironment((call): ChildProcess => {
        if (call.args[0] === join(repositoryRoot, "scripts", "copy-skill-sources.ts")) return closeSoon(call.child)
        return call.child
    })
    const result = watch(environment.dependencies)

    await waitForSpawnCalls(environment, 3)
    environment.spawnCalls[1].child.closeOnKill = false
    let completed = false
    void result.then(
        (): void => { completed = true },
        (): void => { completed = true },
    )
    environment.spawnCalls[2].child.close(7)

    await flushMicrotasks()
    expect(completed).toBe(false)
    expect(environment.spawnCalls[1].child.killCount).toBe(1)
    environment.spawnCalls[1].child.close(0)
    await expect(result).rejects.toThrow("Build watcher exited with code 7.")
})

test("watch cleans first watcher when second spawn throws", async () => {
    const environment = createEnvironment((call): ChildProcess => {
        if (call.args[0] === join(repositoryRoot, "scripts", "copy-skill-sources.ts")) return closeSoon(call.child)
        if (call.args[0] === resolveTypeScriptCli()) throw new Error("declaration spawn failed")
        return call.child
    })

    await expect(watch(environment.dependencies)).rejects.toThrow("declaration spawn failed")
    expect(environment.spawnCalls).toHaveLength(3)
    expect(environment.spawnCalls[1].child.killCount).toBe(1)
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
