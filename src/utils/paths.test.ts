import { describe, expect, test } from "bun:test"
import { posix, win32 } from "node:path"
import { resolveOpenCodePaths } from "./paths"

describe("resolveOpenCodePaths", () => {
    test("uses Linux home config default", () => {
        const paths = resolveOpenCodePaths({ platform: "linux", home: "/home/ada", env: {} })

        expect(paths.globalConfigRoot).toBe(posix.join("/home/ada", ".config", "opencode"))
        expect(paths.globalPluginPath("autocode.js")).toBe(posix.join("/home/ada", ".config", "opencode", "plugins", "autocode.js"))
    })

    test("uses injected Windows home when HOME is absent", () => {
        const paths = resolveOpenCodePaths({ platform: "win32", home: "C:\\Users\\Ada Lovelace", env: {} })

        expect(paths.globalConfigRoot).toBe(win32.join("C:\\Users\\Ada Lovelace", ".config", "opencode"))
        expect(paths.globalPluginPath("autocode.js")).toBe(win32.join("C:\\Users\\Ada Lovelace", ".config", "opencode", "plugins", "autocode.js"))
    })

    test("prefers OPENCODE_CONFIG_DIR over XDG_CONFIG_HOME", () => {
        const paths = resolveOpenCodePaths({
            platform: "linux",
            home: "/home/ada",
            env: { OPENCODE_CONFIG_DIR: "/override/opencode", XDG_CONFIG_HOME: "/xdg" },
        })

        expect(paths.globalConfigRoot).toBe(posix.join("/override", "opencode"))
        expect(paths.globalOpenCodeJsoncPath).toBe(posix.join("/override", "opencode", "opencode.jsonc"))
    })

    test("uses XDG_CONFIG_HOME when no config override exists", () => {
        const paths = resolveOpenCodePaths({ platform: "linux", home: "/home/ada", env: { XDG_CONFIG_HOME: "/xdg config" } })

        expect(paths.globalConfigRoot).toBe(posix.join("/xdg config", "opencode"))
    })

    test("keeps separators native to injected platform", () => {
        const paths = resolveOpenCodePaths({
            platform: "win32",
            home: "C:\\Users\\Ada Lovelace",
            env: { OPENCODE_CONFIG_DIR: "D:\\OpenCode Config" },
        })

        expect(paths.globalAgentsRoot).toBe(win32.join("D:\\OpenCode Config", "agents"))
        expect(paths.globalOpenCodeJsonPath).toBe(win32.join("D:\\OpenCode Config", "opencode.json"))
    })

    test("keeps generated skills under home agents root despite XDG config", () => {
        const paths = resolveOpenCodePaths({
            platform: "linux",
            home: "/home/Ada Lovelace",
            env: { XDG_CONFIG_HOME: "/xdg config" },
        })

        expect(paths.skillsRoot).toBe(posix.join("/home/Ada Lovelace", ".agents", "skills"))
        expect(paths.generatedSkillsRoot).toBe(posix.join("/home/Ada Lovelace", ".agents", "skills", "autocode"))
    })
})
