import { describe, expect, mock, test } from "bun:test"
import { createAutocodeDependenciesTool, isAtLeastMinimumOpencodeVersion, parseTolerantSemver } from "./autocode_dependencies"
import { createToolContext } from "./test_context"
import type { SandboxDependencies } from "@/utils/sandbox"

type DependencyToolResult = Record<string, unknown> & {
    bwrap: Record<string, unknown>
    next_actions: string[]
    opencode: Record<string, unknown>
}

function parseResult(result: string): DependencyToolResult {
    return JSON.parse(result) as DependencyToolResult
}

function createDeps(options?: {
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
    osRelease?: string
    opencodeExit?: number | null
    opencodeStdout?: string
    opencodeStderr?: string
    bwrapExists?: boolean
    bwrapExit?: number | null
}): SandboxDependencies {
    const spawn = mock(async (command: string, args: readonly string[]) => {
        if (command === "opencode" && args[0] === "--version") {
            return { exitCode: options?.opencodeExit ?? 0, stdout: options?.opencodeStdout ?? "opencode 1.14.28", stderr: options?.opencodeStderr ?? "" }
        }
        if (command === "bwrap") {
            return { exitCode: options?.bwrapExit ?? 0, stdout: "", stderr: options?.bwrapExit === 0 ? "" : "probe failed" }
        }
        return { exitCode: 127, stdout: "", stderr: "not found" }
    })

    return {
        fileSystem: {
            async readFile(filePath: string) {
                if (filePath === "/etc/os-release") return options?.osRelease ?? "ID=ubuntu\nID_LIKE=debian\n"
                const error = new Error("missing") as NodeJS.ErrnoException
                error.code = "ENOENT"
                throw error
            },
            async readdir() { return [] },
            async mkdir() {},
            async writeFile() {},
            async stat() { throw new Error("not implemented") },
        },
        spawn,
        async commandExists(command: string) {
            return command === "bwrap" && (options?.bwrapExists ?? true)
        },
        process: { platform: options?.platform ?? "linux", arch: "x64", env: options?.env ?? {} },
    } as unknown as SandboxDependencies
}

describe("autocode_dependencies", () => {
    test("parses tolerant semver and compares minimum OpenCode version", () => {
        expect(parseTolerantSemver("opencode 1.14.28\n")?.patch).toBe(28)
        expect(parseTolerantSemver("v2.0.0-beta")?.major).toBe(2)
        expect(parseTolerantSemver("no version")).toBeUndefined()
        expect(isAtLeastMinimumOpencodeVersion(parseTolerantSemver("1.14.28")!)).toBe(true)
        expect(isAtLeastMinimumOpencodeVersion(parseTolerantSemver("1.14.27")!)).toBe(false)
    })

    test("reports OpenCode upgrade, missing, and unknown version guidance", async () => {
        const lower = parseResult(await createAutocodeDependenciesTool(createDeps({ opencodeStdout: "opencode 1.14.27" })).execute({}, createToolContext()) as string)
        const missing = parseResult(await createAutocodeDependenciesTool(createDeps({ opencodeExit: 127, opencodeStderr: "not found" })).execute({}, createToolContext()) as string)
        const unknown = parseResult(await createAutocodeDependenciesTool(createDeps({ opencodeStdout: "opencode dev" })).execute({}, createToolContext()) as string)

        expect(lower.status).toBe("action_required")
        expect(lower.opencode.status).toBe("upgrade_required")
        expect(missing.opencode.status).toBe("missing")
        expect(unknown.opencode.status).toBe("unknown")
        expect(lower.opencode.guidance).toBe("Run `opencode upgrade`.")
        expect(missing.opencode.guidance).toBe("Run `opencode upgrade`.")
        expect(unknown.opencode.guidance).toBe("Run `opencode upgrade`.")
        expect(lower.next_actions).toContain("Run `opencode upgrade`.")
    })

    test("reports bwrap unsupported on non-linux and Termux", async () => {
        const darwin = parseResult(await createAutocodeDependenciesTool(createDeps({ platform: "darwin" })).execute({}, createToolContext()) as string)
        const termux = parseResult(await createAutocodeDependenciesTool(createDeps({ env: { TERMUX_VERSION: "1" } })).execute({}, createToolContext()) as string)

        expect(darwin.bwrap.status).toBe("unsupported")
        expect(darwin.bwrap.reason).toContain("macOS")
        expect(termux.bwrap.status).toBe("unsupported")
        expect(termux.bwrap.reason).toContain("Termux")
    })

    test("reports bwrap missing and unusable with distro install guidance", async () => {
        const missing = parseResult(await createAutocodeDependenciesTool(createDeps({ bwrapExists: false, osRelease: "ID=ubuntu\n" })).execute({}, createToolContext()) as string)
        const unusable = parseResult(await createAutocodeDependenciesTool(createDeps({ bwrapExit: 1, osRelease: "ID=fedora\n" })).execute({}, createToolContext()) as string)

        expect(missing.bwrap.status).toBe("missing")
        expect(missing.bwrap.install_command).toBe("sudo apt-get install -y bubblewrap")
        expect(missing.next_actions).toContain("sudo apt-get install -y bubblewrap")
        expect(unusable.bwrap.status).toBe("unusable")
        expect(unusable.bwrap.install_command).toBe("sudo dnf install -y bubblewrap")
        expect(unusable.bwrap.guidance).toContain("Fix bwrap usability")
    })

    test("is detect-only and never runs upgrade or package install commands", async () => {
        const deps = createDeps({ opencodeStdout: "opencode 1.14.27", bwrapExists: false })
        const result = parseResult(await createAutocodeDependenciesTool(deps).execute({}, createToolContext()) as string)
        const calls = (deps.spawn as ReturnType<typeof mock>).mock.calls.map(([command]) => command)

        expect(result.detect_only).toBe(true)
        expect(result.status).toBe("action_required")
        expect(calls).toContain("opencode")
        expect(calls).not.toContain("apt")
        expect(calls).not.toContain("dnf")
        expect(calls).not.toContain("apk")
        expect(calls).not.toContain("pacman")
        expect(calls).not.toContain("zypper")
        expect((deps.spawn as ReturnType<typeof mock>).mock.calls).not.toContainEqual(["opencode", ["upgrade"], expect.anything()])
    })

    test("registers as no-arg tool", () => {
        expect(createAutocodeDependenciesTool(createDeps()).args).toEqual({})
    })
})
