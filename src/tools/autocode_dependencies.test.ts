import { describe, expect, mock, test } from "bun:test"
import { createAutocodeDependenciesTool } from "./autocode_dependencies"
import { createToolContext } from "./test_context"
import { inspectAutocodeDependencies, isAtLeastMinimumOpencodeVersion, parseTolerantSemver, type DependencyDebugEvent } from "@/utils/autocode_dependencies"
import type { SandboxDependencies } from "@/utils/sandbox"

type DependencyToolResult = Record<string, unknown> & {
    bwrap: Record<string, unknown>
    dependencies?: Record<string, DependencyEntry>
    next_actions: string[]
    opencode: Record<string, unknown>
    optional_dependencies?: Record<string, DependencyEntry>
    optional_ok?: boolean
    required_ok?: boolean
    status?: string
}

type DependencyEntry = Record<string, unknown> & {
    guidance?: string
    notes?: string
    status?: string
}

type CommandMap = Record<string, boolean | { path?: string, version?: string }>

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
    commandMap?: CommandMap
    commandErrorMap?: Record<string, Error>
    fileMap?: Record<string, string>
    readdirMap?: Record<string, string[]>
}): SandboxDependencies {
    const spawn = mock(async (command: string, args: readonly string[]) => {
        if (command === "opencode" && args[0] === "--version") {
            return { exitCode: options?.opencodeExit ?? 0, stdout: options?.opencodeStdout ?? "opencode 1.17.9", stderr: options?.opencodeStderr ?? "" }
        }
        if (command === "bwrap") {
            return { exitCode: options?.bwrapExit ?? 0, stdout: "", stderr: options?.bwrapExit === 0 ? "" : "probe failed" }
        }
        if (command === "sh" && args[0] === "-c") {
            const match = /^command -v (.+)$/.exec(args[1] ?? "")
            if (match) {
                const commandEntry = options?.commandMap?.[match[1]]
                if (!commandEntry) return { exitCode: 127, stdout: "", stderr: "not found" }

                const path = typeof commandEntry === "object" ? commandEntry.path : undefined
                return { exitCode: 0, stdout: `${path ?? `/usr/bin/${match[1]}`}\n`, stderr: "" }
            }
        }
        if (args[0] === "--version") {
            const commandEntry = options?.commandMap?.[command]
            if (!commandEntry) return { exitCode: 127, stdout: "", stderr: "not found" }

            const version = typeof commandEntry === "object" ? commandEntry.version : undefined
            return { exitCode: 0, stdout: `${version ?? `${command} 1.0.0`}\n`, stderr: "" }
        }
        return { exitCode: 127, stdout: "", stderr: "not found" }
    })

    return {
        fileSystem: {
            async readFile(filePath: string) {
                if (filePath === "/etc/os-release") return options?.osRelease ?? "ID=ubuntu\nID_LIKE=debian\n"
                if (options?.fileMap?.[filePath] !== undefined) return options.fileMap[filePath]
                const error = new Error("missing") as NodeJS.ErrnoException
                error.code = "ENOENT"
                throw error
            },
            async readdir(dirPath: string) { return options?.readdirMap?.[dirPath] ?? [] },
            async mkdir() {},
            async writeFile() {},
            async stat() {
                const error = new Error("missing") as NodeJS.ErrnoException
                error.code = "ENOENT"
                throw error
            },
        },
        spawn,
        async commandExists(command: string) {
            const commandError = options?.commandErrorMap?.[command]
            if (commandError) throw commandError
            return command === "bwrap" && (options?.bwrapExists ?? true)
                || command !== "bwrap" && Boolean(options?.commandMap?.[command])
        },
        process: { platform: options?.platform ?? "linux", arch: "x64", env: options?.env ?? {} },
    } as unknown as SandboxDependencies
}

describe("autocode_dependencies", () => {
    test("parses tolerant semver and compares minimum OpenCode version", () => {
        expect(parseTolerantSemver("opencode 1.14.28\n")?.patch).toBe(28)
        expect(parseTolerantSemver("v2.0.0-beta")?.major).toBe(2)
        expect(parseTolerantSemver("no version")).toBeUndefined()
        const minimumVersion = parseTolerantSemver("1.17.9")
        const outdatedVersion = parseTolerantSemver("1.17.8")
        if (!minimumVersion || !outdatedVersion) throw new Error("Expected valid semantic versions")
        expect(isAtLeastMinimumOpencodeVersion(minimumVersion)).toBe(true)
        expect(isAtLeastMinimumOpencodeVersion(outdatedVersion)).toBe(false)
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

        expect(createAutocodeDependenciesTool(deps).args).toEqual({})
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

    test("reports missing optional dependencies without blocking required dependencies", async () => {
        const result = parseResult(await createAutocodeDependenciesTool(createDeps()).execute({}, createToolContext()) as string)
        const optionalDependencies = result.optional_dependencies ?? {}

        expect(Object.keys(optionalDependencies)).toEqual(["chrome_devtools_mcp", "context7_mcp", "excel_mcp", "git_cli", "browser"])
        for (const key of ["chrome_devtools_mcp", "context7_mcp", "excel_mcp", "git_cli", "browser"]) {
            expect(result.dependencies?.[key]).toEqual(optionalDependencies[key])
        }
        expect(result.required_ok).toBe(true)
        expect(result.optional_ok).toBe(false)
        expect(result.status).toBe("action_required")
        expect(result.next_actions).toContain("Install or use `chrome-devtools-mcp@latest` for Chrome DevTools MCP.")
        expect(result.next_actions).toContain("Install or use `@upstash/context7-mcp` for Context7 MCP.")
        expect(result.next_actions).toContain("Install or use `excel-mcp-server` for Excel MCP.")
        expect(result.next_actions).toContain("Install system git CLI for built-in Git tools.")
        expect(result.next_actions).toContain("Install Google Chrome / Chrome for Testing for official Chrome DevTools MCP support. Chromium may work but is not guaranteed.")
        expect(JSON.stringify(result)).not.toContain("mcp-server-git")
        expect(JSON.stringify(result)).not.toContain("git_mcp")
        expect(optionalDependencies.chrome_devtools_mcp.package).toBe("chrome-devtools-mcp")
        expect(optionalDependencies.chrome_devtools_mcp.install_command).toBe("npm install -g chrome-devtools-mcp@latest or use `npx chrome-devtools-mcp@latest`")
        expect(optionalDependencies.chrome_devtools_mcp.docs_url).toBe("https://developer.chrome.com/docs/chrome-devtools/mcp")
        expect(optionalDependencies.context7_mcp.package).toBe("@upstash/context7-mcp")
        expect(optionalDependencies.context7_mcp.install_command).toBe("npm install -g @upstash/context7-mcp or use `npx @upstash/context7-mcp`")
        expect(optionalDependencies.context7_mcp.docs_url).toBe("https://github.com/upstash/context7")
        expect(optionalDependencies.excel_mcp.package).toBe("excel-mcp-server")
        expect(optionalDependencies.excel_mcp.install_command).toBe("npm install -g excel-mcp-server or use `npx excel-mcp-server`")
        expect(optionalDependencies.excel_mcp.docs_url).toBe("https://www.npmjs.com/package/excel-mcp-server")
        expect(optionalDependencies.git_cli.package).toBe("git")
        expect(optionalDependencies.git_cli.install_command).toBe("Install git using your system package manager.")
        expect(optionalDependencies.git_cli.guidance).toBe("Install system git CLI for built-in Git tools.")
        expect(optionalDependencies.browser.install_command).toContain("Google Chrome / Chrome for Testing")
        expect(optionalDependencies.browser.install_command).toContain("https://developer.chrome.com/docs/chrome-devtools/mcp")
        expect(optionalDependencies.browser.install_command).not.toContain("chromium")
        expect(optionalDependencies.browser.install_command).not.toContain("apt-get install")
        expect(optionalDependencies.browser.install_command).not.toContain("dnf install")
        expect(optionalDependencies.browser.install_command).not.toContain("apk add")
        expect(optionalDependencies.browser.install_command).not.toContain("pacman -S")
        expect(optionalDependencies.browser.install_command).not.toContain("zypper install")
    })

    test("detects optional MCP from OpenCode config entry under global and local paths", async () => {
        const globalConfig = "/xdg/opencode/opencode.jsonc"
        const worktreeConfig = "/repo/.opencode/opencode.json"
        const result = parseResult(await createAutocodeDependenciesTool(createDeps({
            env: { XDG_CONFIG_HOME: "/xdg" },
            fileMap: {
                [globalConfig]: `{
                    // global config
                    "mcp": {
                        "servers": {
                            "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }
                        }
                    }
                }`,
                [worktreeConfig]: JSON.stringify({
                    mcp: {
                        servers: {
                            "excel-mcp-server": {},
                        },
                    },
                }),
            },
        })).execute({}, createToolContext({ directory: "/repo/app", worktree: "/repo" })) as string)

        expect(result.optional_dependencies?.context7_mcp?.status).toBe("ok")
        expect(result.optional_dependencies?.context7_mcp?.detection_source).toBe("launcher_command")
        expect(result.optional_dependencies?.context7_mcp?.config_path).toBe(globalConfig)
        expect(result.optional_dependencies?.context7_mcp?.configured_command).toBe("npx -y @upstash/context7-mcp")
        expect(result.optional_dependencies?.excel_mcp?.status).toBe("ok")
        expect(result.optional_dependencies?.excel_mcp?.detection_source).toBe("config_entry")
        expect(result.optional_dependencies?.excel_mcp?.config_path).toBe(worktreeConfig)
    })

    test("detects MCP launcher config and system git independently", async () => {
        const ancestorConfig = "/repo/packages/.opencode/opencode.jsonc"
        const result = parseResult(await createAutocodeDependenciesTool(createDeps({
            fileMap: {
                [ancestorConfig]: JSON.stringify({
                    mcp: {
                        servers: {
                            chrome: { command: "node", args: ["/opt/tools/chrome-devtools-mcp/dist/index.js"] },
                        },
                    },
                }),
            },
            commandMap: { git: true },
        })).execute({}, createToolContext({ directory: "/repo/packages/app", worktree: "/repo" })) as string)

        expect(result.optional_dependencies?.git_cli?.status).toBe("ok")
        expect(result.optional_dependencies?.git_cli?.command).toBe("git")
        expect(result.optional_dependencies?.git_cli?.configured_command).toBeUndefined()
        expect(result.optional_dependencies?.chrome_devtools_mcp?.status).toBe("ok")
        expect(result.optional_dependencies?.chrome_devtools_mcp?.configured_command).toBe("node /opt/tools/chrome-devtools-mcp/dist/index.js")
        expect(JSON.stringify(result.optional_dependencies?.git_cli)).not.toContain("mcp-server-git")
    })

    test("detects windows cmd wrappers from config", async () => {
        const result = parseResult(await createAutocodeDependenciesTool(createDeps({
            fileMap: {
                "/xdg/opencode/opencode.json": JSON.stringify({
                    mcp: {
                        servers: {
                            chrome: { command: "cmd.exe", args: ["/c", "npx", "chrome-devtools-mcp@latest"] },
                        },
                    },
                }),
            },
            env: { XDG_CONFIG_HOME: "/xdg" },
        })).execute({}, createToolContext()) as string)

        expect(result.optional_dependencies?.chrome_devtools_mcp?.status).toBe("ok")
        expect(result.optional_dependencies?.chrome_devtools_mcp?.detection_source).toBe("launcher_command")
        expect(result.optional_dependencies?.chrome_devtools_mcp?.configured_command).toBe("npx chrome-devtools-mcp@latest")
    })

    test("detects MCP config entries with command arrays and ignores non-string items", async () => {
        const result = parseResult(await createAutocodeDependenciesTool(createDeps({
            env: { XDG_CONFIG_HOME: "/xdg" },
            fileMap: {
                "/xdg/opencode/opencode.json": JSON.stringify({
                    mcpServers: {
                        chrome: { command: ["node", "/opt/tools/chrome-devtools-mcp.js"] },
                        context7: { command: ["npx", "-y", "@upstash/context7-mcp"] },
                        excel: { command: ["excel-mcp-server"] },
                    },
                }),
            },
        })).execute({}, createToolContext()) as string)

        expect(result.optional_dependencies?.chrome_devtools_mcp?.status).toBe("ok")
        expect(result.optional_dependencies?.chrome_devtools_mcp?.configured_command).toBe("node /opt/tools/chrome-devtools-mcp.js")
        expect(result.optional_dependencies?.context7_mcp?.status).toBe("ok")
        expect(result.optional_dependencies?.context7_mcp?.configured_command).toBe("npx -y @upstash/context7-mcp")
        expect(result.optional_dependencies?.excel_mcp?.status).toBe("ok")
        expect(result.optional_dependencies?.excel_mcp?.configured_command).toBe("excel-mcp-server")
        expect(result.optional_dependencies?.git_cli?.status).toBe("missing")
        expect(result.optional_dependencies?.git_cli?.configured_command).toBeUndefined()
    })

    test("unwraps windows command arrays from config", async () => {
        const result = parseResult(await createAutocodeDependenciesTool(createDeps({
            env: { XDG_CONFIG_HOME: "/xdg" },
            fileMap: {
                "/xdg/opencode/opencode.json": JSON.stringify({
                    mcp: {
                        servers: {
                            chrome: { command: ["cmd.exe", "/c", "npx", "chrome-devtools-mcp@latest"] },
                        },
                    },
                }),
            },
        })).execute({}, createToolContext()) as string)

        expect(result.optional_dependencies?.chrome_devtools_mcp?.status).toBe("ok")
        expect(result.optional_dependencies?.chrome_devtools_mcp?.configured_command).toBe("npx chrome-devtools-mcp@latest")
    })

    test("does not detect MCP from unrelated config objects", async () => {
        const result = parseResult(await createAutocodeDependenciesTool(createDeps({
            env: { XDG_CONFIG_HOME: "/xdg" },
            fileMap: {
                "/xdg/opencode/opencode.json": JSON.stringify({
                    tools: {
                        servers: {
                            context7: { command: "npx", args: ["@upstash/context7-mcp"] },
                        },
                    },
                }),
            },
        })).execute({}, createToolContext()) as string)

        expect(result.optional_dependencies?.context7_mcp?.status).toBe("missing")
        expect(result.optional_dependencies?.context7_mcp?.config_path).toBeUndefined()
        expect(result.optional_dependencies?.context7_mcp?.configured_command).toBeUndefined()
    })

    test("detects MCP from supplemental OpenCode config files and ignores unrelated files", async () => {
        const supplementalConfig = "/xdg/opencode/sample.opencode.jsonc"
        const result = parseResult(await createAutocodeDependenciesTool(createDeps({
            env: { XDG_CONFIG_HOME: "/xdg" },
            readdirMap: {
                "/xdg/opencode": ["notes.json", "nested", "sample.opencode.jsonc", "sample.opencode.yaml"],
            },
            fileMap: {
                [supplementalConfig]: JSON.stringify({
                    mcpServers: {
                        context7: { command: ["npx", "-y", "@upstash/context7-mcp"] },
                        excel: { command: ["excel-mcp-server"] },
                    },
                }),
            },
        })).execute({}, createToolContext()) as string)

        expect(result.optional_dependencies?.context7_mcp?.status).toBe("ok")
        expect(result.optional_dependencies?.context7_mcp?.config_path).toBe(supplementalConfig)
        expect(result.optional_dependencies?.context7_mcp?.configured_command).toBe("npx -y @upstash/context7-mcp")
        expect(result.optional_dependencies?.excel_mcp?.status).toBe("ok")
        expect(result.optional_dependencies?.excel_mcp?.config_path).toBe(supplementalConfig)
        expect(result.optional_dependencies?.excel_mcp?.configured_command).toBe("excel-mcp-server")
        expect(result.optional_dependencies?.git_cli?.status).toBe("missing")
    })

    test("resolves relative OPENCODE_CONFIG from context directory first", async () => {
        const configPath = "/repo/app/config/opencode.jsonc"
        const result = parseResult(await createAutocodeDependenciesTool(createDeps({
            env: { OPENCODE_CONFIG: "config/opencode.jsonc" },
            fileMap: {
                [configPath]: JSON.stringify({
                    mcp: { servers: {} },
                }),
            },
            commandMap: { git: true },
        })).execute({}, createToolContext({ directory: "/repo/app", worktree: "/repo" })) as string)

        expect(result.optional_dependencies?.git_cli?.status).toBe("ok")
        expect(result.optional_dependencies?.git_cli?.config_path).toBeUndefined()
        expect(result.optional_dependencies?.git_cli?.configured_command).toBeUndefined()
    })

    test("isolates optional dependency inspection errors", async () => {
        const result = parseResult(await createAutocodeDependenciesTool(createDeps({
            commandErrorMap: { "chrome-devtools-mcp": new Error("could not inspect chrome-devtools-mcp") },
            commandMap: {
                "context7-mcp": true,
                "excel-mcp-server": true,
                git: true,
                "google-chrome": true,
            },
        })).execute({}, createToolContext()) as string)

        expect(result.optional_dependencies?.chrome_devtools_mcp?.status).toBe("unknown")
        expect(result.optional_dependencies?.chrome_devtools_mcp?.error).toContain("could not inspect chrome-devtools-mcp")
        expect(result.optional_dependencies?.chrome_devtools_mcp?.guidance).toContain("Inspect chrome-devtools MCP manually.")
        expect(result.optional_dependencies?.context7_mcp?.status).toBe("ok")
        expect(result.optional_dependencies?.excel_mcp?.status).toBe("ok")
        expect(result.optional_dependencies?.git_cli?.status).toBe("ok")
        expect(result.optional_dependencies?.browser?.status).toBe("ok")
        expect(result.optional_dependencies?.browser?.guidance).toContain("Chrome DevTools MCP")
    })

    test("browser distinguishes Google Chrome from Chromium", async () => {
        const both = parseResult(await createAutocodeDependenciesTool(createDeps({ commandMap: { "google-chrome": true, chromium: true } })).execute({}, createToolContext()) as string)
        const chromiumOnly = parseResult(await createAutocodeDependenciesTool(createDeps({ commandMap: { chromium: true } })).execute({}, createToolContext()) as string)

        expect(both.optional_dependencies?.browser?.status).toBe("ok")
        expect(both.optional_dependencies?.browser?.command).toBe("google-chrome")
        expect(both.optional_dependencies?.browser?.chromium_command).toBe("chromium")
        expect(both.optional_dependencies?.browser?.guidance).toContain("Google Chrome")
        expect(both.optional_dependencies?.browser?.guidance).toContain("Chrome DevTools MCP")
        expect(chromiumOnly.optional_dependencies?.browser?.status).toBe("unknown")
        expect(chromiumOnly.optional_dependencies?.browser?.command).toBe("chromium")
        expect(chromiumOnly.optional_dependencies?.browser?.guidance).toContain("Install Google Chrome")
        expect(chromiumOnly.optional_dependencies?.browser?.notes).toContain("Chromium found")
    })

    test("registers as no-arg tool", () => {
        expect(createAutocodeDependenciesTool(createDeps()).args).toEqual({})
    })

    test("utility inspection keeps tool result shape", async () => {
        const result = await inspectAutocodeDependencies(createDeps(), { directory: "/repo/app", worktree: "/repo" }) as DependencyToolResult

        expect(result.detect_only).toBe(true)
        expect(result.required_ok).toBe(true)
        expect(result.optional_dependencies?.git_cli?.status).toBe("missing")
        expect(result.dependencies?.opencode).toEqual(result.opencode)
        expect(result.dependencies?.bwrap).toEqual(result.bwrap)
    })

    test("debug mode reports missed config files, supplemental config matches, and final reason", async () => {
        const events: DependencyDebugEvent[] = []
        await inspectAutocodeDependencies(createDeps({
            env: { XDG_CONFIG_HOME: "/xdg" },
            readdirMap: {
                "/xdg/opencode": ["sample.opencode.jsonc"],
            },
            fileMap: {
                "/xdg/opencode/sample.opencode.jsonc": JSON.stringify({
                    mcpServers: [
                        { name: "context7", command: ["npx", "-y", "@upstash/context7-mcp"] },
                    ],
                }),
            },
        }), {}, {
            debug: true,
            debugLog(event: DependencyDebugEvent): void {
                events.push(event)
            },
        })

        expect(events).toContainEqual(expect.objectContaining({
            dependency: "context7_mcp",
            stage: "config_paths",
            config_paths: expect.arrayContaining(["/xdg/opencode/opencode.jsonc", "/xdg/opencode/sample.opencode.jsonc"]),
        }))
        expect(events).toContainEqual(expect.objectContaining({
            dependency: "context7_mcp",
            stage: "config_file",
            config_path: "/xdg/opencode/opencode.jsonc",
            outcome: "missing",
        }))
        expect(events).toContainEqual(expect.objectContaining({
            dependency: "context7_mcp",
            stage: "config_match",
            config_path: "/xdg/opencode/sample.opencode.jsonc",
            section: "mcpServers",
            key: "context7",
            detection_source: "launcher_command",
            configured_command: "npx -y @upstash/context7-mcp",
        }))
        expect(events).toContainEqual(expect.objectContaining({
            dependency: "excel_mcp",
            stage: "final",
            status: "missing",
            reason: "No PATH command or matching OpenCode config found.",
        }))
    })

    test("detects MCP array entries in config", async () => {
        const result = await inspectAutocodeDependencies(createDeps({
            env: { XDG_CONFIG_HOME: "/xdg" },
            fileMap: {
                "/xdg/opencode/opencode.jsonc": JSON.stringify({
                    mcp: {
                        servers: [
                            { name: "excel-mcp-server", command: ["excel-mcp-server"] },
                        ],
                    },
                }),
            },
            commandMap: { git: true },
        })) as DependencyToolResult

        expect(result.optional_dependencies?.excel_mcp?.status).toBe("ok")
        expect(result.optional_dependencies?.excel_mcp?.configured_command).toBe("excel-mcp-server")
        expect(result.optional_dependencies?.git_cli?.status).toBe("ok")
        expect(result.optional_dependencies?.git_cli?.configured_command).toBeUndefined()
    })
})
