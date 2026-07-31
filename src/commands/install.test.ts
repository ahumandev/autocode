import { describe, expect, test } from "bun:test"
import { createInstallCommand } from "./install"
import { createPlatformCapabilities } from "../utils/platform"

describe("install command", () => {
    test("uses CMD-only Windows dependency remediation guidance", () => {
        const template = createInstallCommand(createPlatformCapabilities("win32")).template

        expect(template).toContain("command in CMD")
        expect(template).toContain("Run commands in CMD")
        expect(template).toContain("reported `install_command`/guidance")
        expect(template).toContain("prefer reported `install_command`/guidance")
        expect(template).toContain("OpenCode (opencode)")
        expect(template).toContain("chrome_devtools_mcp")
        expect(template).toContain("context7_mcp")
        expect(template).toContain("excel_mcp")
        expect(template).toContain("Git CLI (git_cli)")
        expect(template).toContain("browser availability")
        expect(template).toContain("dangerous-operation/manual confirmation rules")
        expect(template).toContain("manual confirmation")
        expect(template).toContain("stop/ask/report, not force")
        expect(template).not.toContain("bwrap")
        expect(template).not.toContain("Bash")
        expect(template).not.toContain("sudo")
        expect(template).not.toContain("apt")
        expect(template).not.toContain("dnf")
        expect(template).not.toContain("yum")
        expect(template).not.toContain("pacman")
        expect(template).not.toContain("apk")
        expect(template).not.toContain("zypper")
    })

    test("keeps Linux bwrap and sudo remediation semantics", () => {
        const template = createInstallCommand(createPlatformCapabilities("linux")).template

        expect(template).toContain("If bwrap install is needed, use the reported install command")
        expect(template).toContain("reported install_command/guidance")
        expect(template).toContain("chrome_devtools_mcp")
        expect(template).toContain("context7_mcp")
        expect(template).toContain("excel_mcp")
        expect(template).toContain("if git_cli is missing")
        expect(template).toContain("system Git CLI")
        expect(template).toContain("continue after failures")
        expect(template).toContain("Follow dangerous-operation/manual confirmation rules: sudo")
        expect(template).toContain("manual confirmation")
        expect(template).toContain("stop/ask/report, not force")
    })
})
