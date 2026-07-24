import { describe, expect, mock, test } from "bun:test"
import type { Dirent } from "node:fs"
import path from "node:path"
import type { SandboxDependencies } from "@/utils/sandbox"
import { createAutocodeKillTool, runAutocodeKill } from "./autocode_kill"

type AutocodeKillResult = {
    ok: boolean
    mode?: string
    action?: string
    failedAction?: string
    error?: string
    instruction?: string
    name?: string
    pid?: number
    owner?: string
    port?: number
    candidates?: AutocodeKillCandidate[]
}

type AutocodeKillCandidate = {
    config_file: string
    config_match: string
    port: number
    process_name: string
    process_owner: string
}

type FakeEntry = {
    type: "dir" | "file"
    content?: string
}

type TestAutocodeKillDependencies = SandboxDependencies & {
    signalProcess: (pid: number, signal: NodeJS.Signals) => void
}

type CreateDepsOptions = {
    ssLines?: string[]
    processInfo?: Record<string, string>
    platform?: NodeJS.Platform
    commandExists?: boolean | ((command: string) => boolean | Promise<boolean>)
    signalProcess?: (pid: number, signal: NodeJS.Signals) => void
}

const defaultSsLines = [
    "State Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
    "LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:((\"node\",pid=3000,fd=22))",
    "LISTEN 0 511 127.0.0.1:4321 0.0.0.0:* users:((\"bun\",pid=4321,fd=22))",
    "LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:((\"vite\",pid=5173,fd=22))",
    "LISTEN 0 511 127.0.0.1:8080 0.0.0.0:* users:((\"java\",pid=8080,fd=22))",
    "LISTEN 0 511 127.0.0.1:9000 0.0.0.0:* users:((\"node\",pid=9000,fd=22))",
    "LISTEN 0 511 127.0.0.1:9999 0.0.0.0:* users:((\"node\",pid=9999,fd=22))",
    "LISTEN 0 511 127.0.0.1:10001 0.0.0.0:* users:((\"node\",pid=10001,fd=22))",
    "LISTEN 0 511 127.0.0.1:11111 0.0.0.0:* users:((\"node\",pid=11111,fd=22))",
    "LISTEN 0 511 127.0.0.1:65535 0.0.0.0:* users:((\"node\",pid=65535,fd=22))",
]

function parseResult(result: string): AutocodeKillResult {
    return JSON.parse(result) as AutocodeKillResult
}

function fakeDirent(name: string, type: "dir" | "file"): Dirent {
    return { name, isDirectory: () => type === "dir", isFile: () => type === "file" } as Dirent
}

function createDeps(projectRoot: string, entries: Record<string, FakeEntry>, options: CreateDepsOptions = {}): TestAutocodeKillDependencies {
    const fileSystem = {
        readFile: mock(async (filePath: string) => entries[path.relative(projectRoot, filePath)]?.content ?? ""),
        readdir: mock(async (dirPath: string) => {
            const directory = path.relative(projectRoot, dirPath)
            const prefix = directory ? `${directory}/` : ""
            const children = new Map<string, "dir" | "file">()

            for (const [entryPath, entry] of Object.entries(entries)) {
                if (!entryPath.startsWith(prefix)) continue
                const childPath = entryPath.slice(prefix.length)
                if (!childPath || childPath.includes("/")) continue
                children.set(childPath, entry.type)
            }

            return [...children.entries()].map(([name, type]) => fakeDirent(name, type))
        }),
        async mkdir() {},
        async stat() { return {} },
        async writeFile() {},
    }
    const spawn = mock(async (command: string, args: readonly string[]) => {
        if (command === "ss" && args.join(" ") === "-ltnp") {
            return {
                exitCode: 0,
                stdout: (options.ssLines ?? defaultSsLines).join("\n"),
                stderr: "",
            }
        }

        if (command === "ps" && args[0] === "-o") {
            const pid = args.at(-1) ?? ""
            return { exitCode: 0, stdout: options.processInfo?.[pid] ?? "alice node\n", stderr: "" }
        }

        return { exitCode: 127, stdout: "", stderr: "not found" }
    })

    return {
        fileSystem,
        spawn,
        commandExists: mock(async (command: string) => {
            if (typeof options.commandExists === "function") return options.commandExists(command)
            return options.commandExists ?? true
        }),
        signalProcess: mock(options.signalProcess ?? ((_pid: number, _signal: NodeJS.Signals): void => {})),
        process: { platform: options.platform ?? "linux", arch: "x64", env: {} },
    } as unknown as TestAutocodeKillDependencies
}

describe("autocode_kill", () => {
    test("exposes expected schema args", () => {
        expect(Object.keys((createAutocodeKillTool() as unknown as { args: Record<string, unknown> }).args)).toEqual(["port", "name"])
    })

    test("returns abort when current platform is unsupported", async () => {
        const projectRoot = "/workspace/project"
        const deps = createDeps(projectRoot, {}, { platform: "darwin" })

        const text = await runAutocodeKill({}, { cwd: projectRoot }, deps)
        const output = parseResult(text)

        expect(output.failedAction).toBe("validate autocode_kill environment")
        expect(text).toContain("Current OS/platform")
        expect(text).toContain("darwin")
        expect(text).toContain("unsupported")
        expect(text).toContain("Linux is required")
        expect(text).toContain("lsof")
        expect(text).toContain("netstat")
        expect(text).toContain("taskkill")
        expect(deps.spawn).not.toHaveBeenCalled()
        expect(deps.fileSystem.readdir).not.toHaveBeenCalled()
        expect(deps.fileSystem.readFile).not.toHaveBeenCalled()
        expect(deps.signalProcess).not.toHaveBeenCalled()
    })

    test("returns abort when required Linux commands are missing", async () => {
        const projectRoot = "/workspace/project"
        const deps = createDeps(projectRoot, {}, { commandExists: false })

        const text = await runAutocodeKill({}, { cwd: projectRoot }, deps)
        const output = parseResult(text)

        expect(output.failedAction).toBe("validate autocode_kill environment")
        expect(text).toContain("Missing required Linux command(s)")
        expect(text).toContain("ss")
        expect(text).toContain("ps")
        expect(text).toContain("ss -ltnp")
        expect(text).toContain("ps -o user= -o comm= -p <pid>")
        expect(text).toContain("kill <pid>")
        expect(deps.spawn).not.toHaveBeenCalled()
        expect(deps.fileSystem.readdir).not.toHaveBeenCalled()
        expect(deps.fileSystem.readFile).not.toHaveBeenCalled()
        expect(deps.signalProcess).not.toHaveBeenCalled()
    })

    test("lists config-backed candidates without killing processes", async () => {
        const projectRoot = "/workspace/project"
        const deps = createDeps(projectRoot, {
            "application.yml": { type: "file", content: "port: 3000\n" },
            "application.yaml": { type: "file", content: "api: http://localhost:9000\n" },
            "config": { type: "dir" },
            "config/app.yaml": { type: "file", content: "port: 11111\n" },
            "config/service.yml": { type: "file", content: "server.port=8080\n" },
            "config/settings.conf": { type: "file", content: "--port 4321\n" },
            "config/package.json": { type: "file", content: "{ \"port\": 3000 }\n" },
            "config/package.jsonc": { type: "file", content: "{ \"url\": \"http://127.0.0.1:5173\" }\n" },
            "config/server.ts": { type: "file", content: "const url = 'http://localhost:8080'\n" },
            "config/.env": { type: "file", content: "PORT=5173\n" },
            "config/ignored.txt": { type: "file", content: "port: 10001\n" },
            "config/not-running.yaml": { type: "file", content: "port: 12345\n" },
            "config/invalid.yaml": { type: "file", content: "port: 0\nPORT=65536\n" },
            ".git": { type: "dir" },
            ".git/config.yaml": { type: "file", content: "port: 9999\n" },
            "node_modules": { type: "dir" },
            "node_modules/module.yaml": { type: "file", content: "port: 9999\n" },
            "dist": { type: "dir" },
            "dist/config.yaml": { type: "file", content: "port: 9999\n" },
            "build": { type: "dir" },
            "build/config.yaml": { type: "file", content: "port: 9999\n" },
            "coverage": { type: "dir" },
            "coverage/config.yaml": { type: "file", content: "port: 9999\n" },
            ".agents": { type: "dir" },
            ".agents/sandboxes": { type: "dir" },
            ".agents/sandboxes/config.yaml": { type: "file", content: "port: 9999\n" },
            "caches": { type: "dir" },
            "caches/config.yaml": { type: "file", content: "port: 9999\n" },
            ".cache": { type: "dir" },
            ".cache/config.yaml": { type: "file", content: "port: 9999\n" },
            "tmp": { type: "dir" },
            "tmp/config.yaml": { type: "file", content: "port: 9999\n" },
            "temp": { type: "dir" },
            "temp/config.yaml": { type: "file", content: "port: 9999\n" },
        })

        const output = parseResult(await runAutocodeKill({}, { cwd: projectRoot }, deps))
        const candidates = [...(output.candidates ?? [])].sort((left, right) => left.port - right.port || left.config_file.localeCompare(right.config_file))

        expect(output.ok).toBe(true)
        expect(output.mode).toBe("list")
        expect(candidates.map((candidate) => candidate.port)).toEqual([3000, 3000, 4321, 5173, 5173, 8080, 8080, 9000, 11111])
        expect(candidates.map((candidate) => candidate.config_file)).toEqual([
            "application.yml",
            "config/package.json",
            "config/settings.conf",
            "config/.env",
            "config/package.jsonc",
            "config/server.ts",
            "config/service.yml",
            "application.yaml",
            "config/app.yaml",
        ])
        expect(candidates.map((candidate) => candidate.config_match)).toEqual([
            "port: 3000",
            "{ \"port\": 3000 }",
            "--port 4321",
            "PORT=5173",
            "{ \"url\": \"http://127.0.0.1:5173\" }",
            "const url = 'http://localhost:8080'",
            "server.port=8080",
            "api: http://localhost:9000",
            "port: 11111",
        ])
        expect(candidates.map((candidate) => candidate.process_name)).toEqual(["node", "node", "bun", "vite", "vite", "java", "java", "node", "node"])
        for (const candidate of candidates) {
            expect(Object.keys(candidate).sort()).toEqual(["config_file", "config_match", "port", "process_name", "process_owner"].sort())
            expect(candidate.process_owner).toBe("alice")
        }
        expect(deps.spawn).toHaveBeenCalledWith("ss", ["-ltnp"])
        expect(deps.spawn).not.toHaveBeenCalledWith("kill", expect.anything())
        expect(deps.signalProcess).not.toHaveBeenCalled()
    })

    test("kills one explicit port listener through injected signalProcess", async () => {
        const projectRoot = "/workspace/project"
        const deps = createDeps(projectRoot, {}, {
            ssLines: [
                "State Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
                "LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:((\"node\",pid=3000,fd=22))",
            ],
            processInfo: { "3000": "alice node\n" },
        })

        const output = parseResult(await runAutocodeKill({ port: 3000, name: "node" }, { cwd: projectRoot }, deps))

        expect(output.ok).toBe(true)
        expect(output.mode).toBe("kill")
        expect(output.action).toBe("kill")
        expect(output.name).toBe("node")
        expect(output.pid).toBe(3000)
        expect(output.owner).toBe("alice")
        expect(output.port).toBe(3000)
        expect(deps.signalProcess).toHaveBeenCalledTimes(1)
        expect(deps.signalProcess).toHaveBeenCalledWith(3000, "SIGTERM")
    })

    test("returns retry when explicit port has no listener", async () => {
        const projectRoot = "/workspace/project"
        const deps = createDeps(projectRoot, {}, {
            ssLines: ["State Recv-Q Send-Q Local Address:Port Peer Address:Port Process"],
        })

        const output = parseResult(await runAutocodeKill({ port: 3000 }, { cwd: projectRoot }, deps))

        expect(output.failedAction).toBe("kill listener on port 3000")
        expect(output.error).toBe("No TCP listener found on port 3000.")
        expect(output.instruction).toContain("retry autocode_kill with the correct port")
        expect(deps.signalProcess).not.toHaveBeenCalled()
    })

    test("returns retry when explicit port listener name differs", async () => {
        const projectRoot = "/workspace/project"
        const deps = createDeps(projectRoot, {}, {
            ssLines: [
                "State Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
                "LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:((\"node\",pid=3000,fd=22))",
            ],
        })

        const output = parseResult(await runAutocodeKill({ port: 3000, name: "vite" }, { cwd: projectRoot }, deps))

        expect(output.failedAction).toBe("kill listener on port 3000")
        expect(output.error).toContain("Expected name: vite")
        expect(output.error).toContain("Actual name: node")
        expect(output.instruction).toContain("retry autocode_kill with the exact listener name")
        expect(deps.signalProcess).not.toHaveBeenCalled()
    })

    test("returns abort when injected signalProcess reports permission failure", async () => {
        const projectRoot = "/workspace/project"
        const permissionError = new Error("permission denied") as Error & { code: string }
        permissionError.code = "EPERM"
        const deps = createDeps(projectRoot, {}, {
            ssLines: [
                "State Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
                "LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:((\"node\",pid=3000,fd=22))",
            ],
            signalProcess: (): void => { throw permissionError },
        })

        const output = parseResult(await runAutocodeKill({ port: 3000 }, { cwd: projectRoot }, deps))

        expect(output.failedAction).toBe("kill listener on port 3000")
        expect(output.error).toContain("Permission denied sending SIGTERM to PID 3000")
        expect(output.instruction).toContain("Immediately ABORT")
        expect(deps.signalProcess).toHaveBeenCalledWith(3000, "SIGTERM")
    })

    test("returns retry when explicit port has ambiguous listeners", async () => {
        const projectRoot = "/workspace/project"
        const deps = createDeps(projectRoot, {}, {
            ssLines: [
                "State Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
                "LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:((\"node\",pid=3000,fd=22))",
                "LISTEN 0 511 [::1]:3000 [::]:* users:((\"bun\",pid=3001,fd=22))",
            ],
        })

        const output = parseResult(await runAutocodeKill({ port: 3000 }, { cwd: projectRoot }, deps))

        expect(output.failedAction).toBe("kill listener on port 3000")
        expect(output.error).toBe("Ambiguous listeners found on port 3000.")
        expect(output.instruction).toContain("only one listener remains")
        expect(deps.signalProcess).not.toHaveBeenCalled()
    })

    test("filters safe list candidates by exact name without killing", async () => {
        const projectRoot = "/workspace/project"
        const deps = createDeps(projectRoot, {
            "app.yaml": { type: "file", content: "port: 3000\n" },
            "vite.yaml": { type: "file", content: "port: 5173\n" },
            "nested": { type: "dir" },
            "nested/node.yaml": { type: "file", content: "port: 9000\n" },
        })

        const output = parseResult(await runAutocodeKill({ name: "node" }, { cwd: projectRoot }, deps))

        expect(output.ok).toBe(true)
        expect(output.mode).toBe("list")
        expect(output.candidates?.map((candidate) => candidate.port).sort((left, right) => left - right)).toEqual([3000, 9000])
        expect(output.candidates?.map((candidate) => candidate.process_name)).toEqual(["node", "node"])
        expect(deps.signalProcess).not.toHaveBeenCalled()
    })
})
