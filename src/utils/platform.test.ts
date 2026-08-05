import { describe, expect, test } from "bun:test"
import { buildExecuteOsPrompt } from "../agents/prompts/execute_os"
import { buildQueryOsPrompt } from "../agents/prompts/query_os"
import { createPlatformCapabilities } from "./platform"

describe("platform capabilities", () => {
    test("marks only win32 as Windows", () => {
        expect(createPlatformCapabilities("win32").isWindows).toBe(true)
        expect(createPlatformCapabilities("linux").isWindows).toBe(false)
        expect(createPlatformCapabilities("darwin").isWindows).toBe(false)
        expect(createPlatformCapabilities("linux").commandEnvironment).toBe("linux")
        expect(createPlatformCapabilities("darwin").commandEnvironment).toBe("linux")
    })

    test("detects PowerShell only on Windows", () => {
        expect(createPlatformCapabilities("win32", { PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules" }).windowsShell).toBe("powershell")
        expect(createPlatformCapabilities("win32", {}).windowsShell).toBe("cmd")
        expect(createPlatformCapabilities("linux", { PSModulePath: "present" }).windowsShell).toBeUndefined()
        expect(createPlatformCapabilities("win32", { PSModulePath: "present" }).commandEnvironment).toBe("powershell")
        expect(createPlatformCapabilities("win32", {}).commandEnvironment).toBe("cmd")
    })

    test("detects PowerShell from non-empty markers and executable shell paths", () => {
        expect(createPlatformCapabilities("win32", { PSModulePath: "   " }).windowsShell).toBe("cmd")
        expect(createPlatformCapabilities("win32", { SHELL: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" }).windowsShell).toBe("powershell")
        expect(createPlatformCapabilities("win32", { SHELL: "/usr/bin/powershell" }).windowsShell).toBe("powershell")
        expect(createPlatformCapabilities("win32", { SHELL: "C:\\Windows\\System32\\cmd.exe" }).windowsShell).toBe("cmd")
    })
})

describe("OS prompts", () => {
    test("buildExecuteOsPrompt uses Windows CMD guidance without positive Bash guidance", () => {
        const prompt = buildExecuteOsPrompt(createPlatformCapabilities("win32", {}))

        expect(prompt).toMatch(/running on windows/i)
        expect(prompt).toMatch(/cmd commands/i)
        expect(prompt).toContain("`where <command>`")
        expect(prompt).toContain("`%PATH%`")
        expect(prompt).toMatch(/never use bash/i)
        expect(prompt).not.toMatch(/always use the `bash` tool/i)
    })

    test("buildExecuteOsPrompt uses PowerShell diagnostics on Windows PowerShell", () => {
        const prompt = buildExecuteOsPrompt(createPlatformCapabilities("win32", { PSModulePath: "present" }))

        expect(prompt).toMatch(/windows powershell/i)
        expect(prompt).toContain("`Get-Command <command> -ErrorAction SilentlyContinue`")
        expect(prompt).toContain("`$env:Path -split ';'`")
        expect(prompt).toContain("`powershell -NoProfile -Command \"<command>\"`")
        expect(prompt).not.toContain("`cmd.exe`")
        expect(prompt).not.toContain("`which`")
    })

    test("buildExecuteOsPrompt keeps Bash guidance outside Windows", () => {
        const prompt = buildExecuteOsPrompt(createPlatformCapabilities("linux"))

        expect(prompt).toMatch(/always use the `bash` tool/i)
        expect(prompt).not.toMatch(/running on windows/i)
        expect(prompt).not.toMatch(/cmd commands/i)
    })

    test("buildQueryOsPrompt uses Windows CMD guidance without positive Bash guidance", () => {
        const prompt = buildQueryOsPrompt(createPlatformCapabilities("win32", {}))

        expect(prompt).toMatch(/running on windows/i)
        expect(prompt).toMatch(/cmd commands/i)
        expect(prompt).toMatch(/never use bash/i)
        expect(prompt).not.toMatch(/prefer other tools over `bash` tool/i)
    })

    test("buildQueryOsPrompt uses PowerShell-only guidance on Windows PowerShell", () => {
        const prompt = buildQueryOsPrompt(createPlatformCapabilities("win32", { PSModulePath: "present" }))

        expect(prompt).toMatch(/windows powershell/i)
        expect(prompt).toContain("`Get-Help <command>`")
        expect(prompt).toContain("`Get-Content <path>`")
        expect(prompt).toContain("`Get-Process`")
        expect(prompt).not.toMatch(/cmd commands/i)
        expect(prompt).not.toContain("`type file`")
        expect(prompt).not.toMatch(/prefer other tools over `bash` tool/i)
    })

    test("buildQueryOsPrompt keeps Bash guidance outside Windows", () => {
        const prompt = buildQueryOsPrompt(createPlatformCapabilities("linux"))

        expect(prompt).toMatch(/prefer other tools over `bash` tool/i)
        expect(prompt).not.toMatch(/running on windows/i)
        expect(prompt).not.toMatch(/cmd commands/i)
    })
})
