import { describe, expect, mock, spyOn, test } from "bun:test"
import { EventEmitter } from "node:events"
import { createManagedScriptWindows, isWindowsServiceIdentity, ManagedScriptWindowsError, resolveWindowsServiceExecutables, type WindowsServiceIdentity } from "./managed_script_windows"
import type { ManagedScriptRuntimeChild, ManagedScriptRuntimeProcess, ManagedScriptRuntimeSpawnOptions } from "./managed_script_runtime"

const ticks = "638954123456789012"
const identity: WindowsServiceIdentity = { kind: "windows", pid: 91, creation_time_ticks: ticks }
const env = { SystemRoot: "C:\\Windows", PATH: "C:\\untrusted" }
const input = { entry: "C:\\owned\\service.mjs", argv: ["", "two words", "quote\"and'quote", "$(not-code);&", "tail\\"], cwd: "C:\\owned", env, stdout: "out.log", stderr: "err.log" }

function childFor(pid: number = 91): { child: ManagedScriptRuntimeChild, events: EventEmitter, stdout: EventEmitter, stderr: EventEmitter } {
    const events = new EventEmitter()
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const child: ManagedScriptRuntimeChild = {
        pid,
        on: events.on.bind(events) as ManagedScriptRuntimeChild["on"],
        stdout: { on: stdout.on.bind(stdout), destroy: mock((): void => {}) },
        stderr: { on: stderr.on.bind(stderr), destroy: mock((): void => {}) },
        kill: mock((): boolean => { queueMicrotask((): void => { events.emit("exit", null, "SIGKILL"); events.emit("close", null, "SIGKILL") }); return true }),
        unref: mock((): void => {}),
    }
    return { child, events, stdout, stderr }
}

function helperProcess(result: Record<string, unknown> = { status: "running", creation_time_ticks: ticks }): { process: ManagedScriptRuntimeProcess, controls: Record<string, unknown>[], helpers: ReturnType<typeof childFor>[] } {
    const controls: Record<string, unknown>[] = []
    const helpers: ReturnType<typeof childFor>[] = []
    const spawn = mock((_command: string, _args: readonly string[], _options: ManagedScriptRuntimeSpawnOptions): ManagedScriptRuntimeChild => {
        const helper = childFor(201)
        helper.child.stdin = { end: (content: string): void => {
            controls.push(JSON.parse(content) as Record<string, unknown>)
            queueMicrotask((): void => { helper.stdout.emit("data", Buffer.from(JSON.stringify(result))); helper.events.emit("close", 0, null) })
        } }
        helpers.push(helper)
        return helper.child
    })
    return { process: { execPath: "C:\\runtime\\node.exe", env, platform: "win32", spawn, kill: mock((): never => { throw new Error("must not use PID/group signalling") }) }, controls, helpers }
}

describe("Windows managed script adapter", (): void => {
    test("keeps .NET UTC ticks as strings without precision loss", (): void => {
        expect(isWindowsServiceIdentity(identity)).toBe(true)
        for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 2_147_483_648, NaN]) {
            expect(isWindowsServiceIdentity({ ...identity, pid: invalid })).toBe(false)
        }
        for (const invalid of [Number(ticks), "", "1e18", "-1", "1.1", "2026-10-07T00:00:00Z", "9".repeat(20)]) {
            expect(isWindowsServiceIdentity({ ...identity, creation_time_ticks: invalid })).toBe(false)
        }
        expect(isWindowsServiceIdentity({ ...identity, kind: "linux" })).toBe(false)
    })

    test("resolves absolute built-in executables without PATH and handles WOW64 redirection", (): void => {
        expect(resolveWindowsServiceExecutables(env)).toEqual({ powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", taskkill: "C:\\Windows\\System32\\taskkill.exe" })
        expect(resolveWindowsServiceExecutables({ systemroot: "D:\\Windows", processor_architew6432: "AMD64" })).toEqual({ powershell: "D:\\Windows\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe", taskkill: "D:\\Windows\\System32\\taskkill.exe" })
        for (const SystemRoot of [undefined, "", "Windows", "\\\\host\\Windows", "C:Windows", "C:\\Windows\\..\\evil", "C:\\bad\"root", "C:\\bad:root", "C:\\bad\0root"]) {
            expect((): void => { resolveWindowsServiceExecutables({ SystemRoot, PATH: "C:\\evil" }) }).toThrow("validated absolute SystemRoot")
        }
    })

    test.each([
        "C:\\Windows.",
        "C:\\Windows ",
        "C:\\Windows.\\",
        "C:\\Windows \\",
        "C:\\Parent.\\Windows",
        "C:\\Parent \\Windows",
        "C:\\Parent\\Nested.\\Windows",
        "C:\\Parent\\Nested \\Windows",
        "C:\\Parent./Windows",
        "C:\\Parent /Windows",
    ])("rejects SystemRoot components ending in dots or spaces: %s", (SystemRoot: string): void => {
        expect((): void => { resolveWindowsServiceExecutables({ SystemRoot }) }).toThrow("validated absolute SystemRoot")
    })

    test.each([undefined, "AMD64"])("preserves canonical nested roots with architecture marker %s", (PROCESSOR_ARCHITEW6432: string | undefined): void => {
        expect(resolveWindowsServiceExecutables({ SystemRoot: "C:\\System Roots\\Windows.11", PROCESSOR_ARCHITEW6432 })).toEqual({
            powershell: `C:\\System Roots\\Windows.11\\${PROCESSOR_ARCHITEW6432 ? "Sysnative" : "System32"}\\WindowsPowerShell\\v1.0\\powershell.exe`,
            taskkill: "C:\\System Roots\\Windows.11\\System32\\taskkill.exe",
        })
    })

    test("uses fixed encoded code and isolated JSON stdin with exactly matching ticks", async (): Promise<void> => {
        const fixture = helperProcess()
        const adapter = createManagedScriptWindows(fixture.process)
        expect(await adapter.inspect(identity)).toBe(true)
        const call = (fixture.process.spawn as ReturnType<typeof mock>).mock.calls[0] as [string, string[], ManagedScriptRuntimeSpawnOptions]
        const code = Buffer.from(call[1][3]!, "base64").toString("utf16le")
        expect(call[0]).toBe(resolveWindowsServiceExecutables(env).powershell)
        expect(call[1].slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"])
        expect(call[2]).toMatchObject({ shell: false, windowsHide: true, detached: false, stdio: "pipe" })
        expect(fixture.controls).toEqual([{ action: "inspect", pid: 91, creation_time_ticks: ticks, taskkill: "C:\\Windows\\System32\\taskkill.exe" }])
        expect(code).toContain("[Console]::In.ReadToEnd() | ConvertFrom-Json")
        expect(code).toContain(".StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture)")
        expect(code).not.toContain(ticks)
        expect(code).not.toContain("Add-Type")
        expect(call[1]).not.toContain("-ExecutionPolicy")
        expect(fixture.process.kill).not.toHaveBeenCalled()
    })

    test("pins root before identity comparison and waits for owned taskkill before disposing root", async (): Promise<void> => {
        const fixture = helperProcess({ status: "stopped", taskkill_started: true })
        const result = await createManagedScriptWindows(fixture.process).stop(identity)
        const call = (fixture.process.spawn as ReturnType<typeof mock>).mock.calls[0] as [string, string[], ManagedScriptRuntimeSpawnOptions]
        const code = Buffer.from(call[1][3]!, "base64").toString("utf16le")
        expect(code.indexOf("$null = $target.Handle")).toBeLessThan(code.indexOf("$ticks -cne $control.creation_time_ticks"))
        expect(code.indexOf("$ticks -cne $control.creation_time_ticks")).toBeLessThan(code.indexOf("$killer.Start()"))
        expect(code).toContain("$info.FileName = $control.taskkill")
        expect(code).toContain(" + ' /T /F'")
        expect(code).toContain("$clock.ElapsedMilliseconds -ge 10000")
        expect(code).toContain("$killer.StandardOutput.ReadAsync($outBuffer, 0, $outBuffer.Length)")
        expect(code).not.toContain("ReadToEndAsync")
        expect(code.indexOf("$killer.WaitForExit(1000)", code.indexOf("finally {"))).toBeLessThan(code.indexOf("$target.Dispose()"))
        expect(code.indexOf("$killer.Dispose()")).toBeLessThan(code.indexOf("$target.Dispose()"))
        expect(result).toEqual({ termination: "forced", tree_cleanup: "best_effort", descendants: "unknown", root_exited: true })
    })

    test.each(["missing", "mismatch", "denied"] as const)("refuses %s roots without claiming tree cleanup", async (status): Promise<void> => {
        const fixture = helperProcess({ status, taskkill_started: false })
        const adapter = createManagedScriptWindows(fixture.process)
        if (status === "missing") expect(await adapter.inspect(identity)).toBe(false)
        else await expect(adapter.inspect(identity)).rejects.toBeInstanceOf(ManagedScriptWindowsError)
        try {
            await adapter.stop(identity)
            throw new Error("must refuse")
        }
        catch (error) {
            expect(error).toBeInstanceOf(ManagedScriptWindowsError)
            expect((error as ManagedScriptWindowsError).windows_cleanup).toMatchObject({ termination: "none", tree_cleanup: "not_attempted", descendants: "unknown" })
        }
        expect(fixture.process.kill).not.toHaveBeenCalled()
    })

    test("reports taskkill timeout as uncertain, not stopped", async (): Promise<void> => {
        const fixture = helperProcess({ status: "timeout", taskkill_started: true })
        await expect(createManagedScriptWindows(fixture.process).stop(identity)).rejects.toThrow("root and descendant exit are unconfirmed")
        expect(fixture.helpers[0]!.child.kill).not.toHaveBeenCalled()
    })

    test("bounds helper output without killing a stop helper that may still own taskkill", async (): Promise<void> => {
        const helper = childFor(201)
        helper.child.stdin = { end: (): void => { queueMicrotask((): void => { helper.stdout.emit("data", Buffer.alloc(4097)) }) }, destroy: mock((): void => {}) }
        const fixture = helperProcess()
        fixture.process.spawn = mock((): ManagedScriptRuntimeChild => helper.child)
        await expect(createManagedScriptWindows(fixture.process).stop(identity)).rejects.toThrow("retaining any root handle until taskkill exits")
        expect(helper.child.kill).not.toHaveBeenCalled()
        expect(helper.child.unref).toHaveBeenCalledTimes(1)
        expect(helper.child.stdout?.destroy).toHaveBeenCalledTimes(1)
        helper.events.emit("close", 0, null)
    })

    test.each(["inspect", "stop"] as const)("%s watchdog is longer than taskkill timeout and preserves stop handle ownership", async (action): Promise<void> => {
        const helper = childFor(201)
        helper.child.stdin = { end: mock((): void => {}), destroy: mock((): void => {}) }
        const fixture = helperProcess()
        fixture.process.spawn = mock((): ManagedScriptRuntimeChild => helper.child)
        const originalSetTimeout = globalThis.setTimeout
        const acceleratedTimeout = ((...args: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> => {
            const [callback, delay, ...rest] = args
            return originalSetTimeout(callback, delay === 30_000 ? 0 : delay, ...rest)
        }) as typeof setTimeout
        const timer = spyOn(globalThis, "setTimeout").mockImplementation(acceleratedTimeout)
        try {
            await expect(createManagedScriptWindows(fixture.process)[action](identity)).rejects.toThrow("exceeded its watchdog")
            expect(timer.mock.calls[0]?.[1]).toBe(30_000)
            if (action === "stop") expect(helper.child.kill).not.toHaveBeenCalled()
            else expect(helper.child.kill).toHaveBeenCalledWith("SIGKILL")
            expect(helper.child.unref).toHaveBeenCalledTimes(1)
        }
        finally { timer.mockRestore(); helper.events.emit("close", 0, null) }
    })

    test("rejects multiple JSON results, malformed identity, and control write failures", async (): Promise<void> => {
        const invalid = helperProcess({ status: "running", creation_time_ticks: Number(ticks) })
        await expect(createManagedScriptWindows(invalid.process).inspect(identity)).rejects.toThrow("no valid single JSON result")
        const changed = helperProcess({ status: "running", creation_time_ticks: "638954123456789013" })
        await expect(createManagedScriptWindows(changed.process).inspect(identity)).rejects.toThrow("no valid single JSON result")
        const helper = childFor(201)
        helper.child.stdin = { end: (): void => { queueMicrotask((): void => { helper.stdout.emit("data", Buffer.from("{}\n{}\n")); helper.events.emit("close", 0, null) }) } }
        invalid.process.spawn = mock((): ManagedScriptRuntimeChild => helper.child)
        await expect(createManagedScriptWindows(invalid.process).inspect(identity)).rejects.toThrow("no valid single JSON result")
        helper.child.stdin.end = (): never => { throw new Error("stdin failed") }
        await expect(createManagedScriptWindows(invalid.process).inspect(identity)).rejects.toThrow("stdin failed")
        expect(helper.child.kill).toHaveBeenCalledWith("SIGKILL")
    })

    test("launches direct argv with append-file handles, awaits spawn, persists identity, closes FDs, and unrefs", async (): Promise<void> => {
        const fixture = helperProcess()
        const service = childFor()
        const helperSpawn = fixture.process.spawn
        const order: string[] = []
        fixture.process.spawn = mock((command: string, args: readonly string[], options: ManagedScriptRuntimeSpawnOptions): ManagedScriptRuntimeChild => {
            if (command !== fixture.process.execPath) return helperSpawn(command, args, options)
            queueMicrotask((): void => { order.push("spawn"); service.events.emit("spawn") })
            return service.child
        })
        const openLog = mock(async (filePath: string, flags: "a") => ({ fd: filePath === input.stdout ? 31 : 32, close: mock(async (): Promise<void> => { order.push(`close:${filePath}`) }) }))
        service.child.unref = mock((): void => { order.push("unref") })
        const persist = mock(async (captured: WindowsServiceIdentity): Promise<void> => { order.push("persist"); expect(captured).toEqual(identity) })
        await createManagedScriptWindows(fixture.process, openLog).launch(input, persist)
        expect(fixture.process.spawn).toHaveBeenNthCalledWith(1, fixture.process.execPath, [input.entry, ...input.argv], { cwd: input.cwd, env, detached: true, windowsHide: true, shell: false, stdio: ["ignore", 31, 32] })
        expect(openLog).toHaveBeenNthCalledWith(1, input.stdout, "a")
        expect(openLog).toHaveBeenNthCalledWith(2, input.stderr, "a")
        expect(order).toEqual(["spawn", "persist", "close:out.log", "close:err.log", "unref"])
        expect(fixture.controls.map((control): unknown => control.action)).toEqual(["capture", "inspect"])
        expect(fixture.controls.every((control): boolean => !("argv" in control) && !("entry" in control))).toBe(true)
        expect(service.child.kill).not.toHaveBeenCalled()
    })

    test("closes first FD when second log open fails without spawning", async (): Promise<void> => {
        const fixture = helperProcess()
        const close = mock(async (): Promise<void> => {})
        const openLog = mock(async (filePath: string) => { if (filePath === input.stderr) throw new Error("log open denied"); return { fd: 31, close } })
        await expect(createManagedScriptWindows(fixture.process, openLog).launch(input, async (): Promise<void> => {})).rejects.toThrow("log open denied")
        expect(close).toHaveBeenCalledTimes(1)
        expect(fixture.process.spawn).not.toHaveBeenCalled()
    })

    test.each(["throw", "error", "pid", "capture", "persist", "close", "exit"] as const)("cleans up launch %s failure and closes both parent FDs", async (failure): Promise<void> => {
        const fixture = helperProcess()
        const service = childFor()
        if (failure === "pid") delete service.child.pid
        const controls: Record<string, unknown>[] = []
        fixture.process.spawn = mock((command: string): ManagedScriptRuntimeChild => {
            if (command === fixture.process.execPath) {
                if (failure === "throw") throw new Error("spawn threw")
                queueMicrotask((): void => { if (failure === "error") service.events.emit("error", new Error("spawn error")); else service.events.emit("spawn") })
                return service.child
            }
            const helper = childFor(201)
            helper.child.stdin = { end: (content: string): void => {
                const control = JSON.parse(content) as Record<string, unknown>
                controls.push(control)
                queueMicrotask((): void => {
                    if (failure === "exit" && control.action === "capture") service.events.emit("exit", 0, null)
                    const result = control.action === "stop" ? { status: "stopped", taskkill_started: true } : failure === "capture" ? { status: "denied" } : { status: "running", creation_time_ticks: ticks }
                    helper.stdout.emit("data", Buffer.from(JSON.stringify(result)))
                    helper.events.emit("close", 0, null)
                })
            } }
            return helper.child
        })
        const handles = [31, 32].map((fd) => ({ fd, close: mock(async (): Promise<void> => { if (failure === "close" && fd === 31) throw new Error("close failed") }) }))
        let opened = 0
        const persist = mock(async (): Promise<void> => { if (failure === "persist") throw new Error("state write failed") })
        await expect(createManagedScriptWindows(fixture.process, async () => handles[opened++]!).launch(input, persist)).rejects.toThrow("Unable to start managed script service")
        expect(handles[0]!.close).toHaveBeenCalledTimes(1)
        expect(handles[1]!.close).toHaveBeenCalledTimes(1)
        if (failure === "persist" || failure === "close") expect(controls.at(-1)?.action).toBe("stop")
        if (failure === "capture" || failure === "error" || failure === "pid") expect(service.child.kill).toHaveBeenCalledWith("SIGKILL")
        if (failure === "exit") expect(service.child.kill).not.toHaveBeenCalled()
        expect(fixture.process.kill).not.toHaveBeenCalled()
    })
})
