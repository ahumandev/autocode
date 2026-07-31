import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, win32 } from "node:path"
import { deriveShimFilename, getShimPath, installPluginShim } from "./install"

describe("install plugin shim", () => {
    test("deriveShimFilename uses package basename without npm namespace", () => {
        expect(deriveShimFilename("@ahumandev/autocode")).toBe("autocode.js")
        expect(deriveShimFilename("pluginname")).toBe("pluginname.js")
    })

    test("deriveShimFilename falls back to safe plugin filename", () => {
        expect(deriveShimFilename("@scope/")).toBe("plugin.js")
        expect(deriveShimFilename("///")).toBe("plugin.js")
        expect(deriveShimFilename("name with spaces")).toBe("name-with-spaces.js")
    })

    test("getShimPath uses derived shim filename in plugin path", () => {
        expect(getShimPath("/tmp/home", "@ahumandev/autocode", { platform: "linux", env: {} })).toBe(join("/tmp/home", ".config", "opencode", "plugins", "autocode.js"))
    })

    test("installPluginShim writes shim under OPENCODE_CONFIG_DIR", async () => {
        const root = await mkdtemp(join(tmpdir(), "autocode-shim-"))
        const configRoot = join(root, "OpenCode Config")

        try {
            await writeFile(join(root, "package.json"), JSON.stringify({ name: "@ahumandev/autocode" }))
            const shimPath = await installPluginShim({ rootDir: root, env: { OPENCODE_CONFIG_DIR: configRoot } })

            expect(shimPath).toBe(join(configRoot, "plugins", "autocode.js"))
            expect(await readFile(shimPath, "utf8")).toContain("dist/plugin.js")
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })

    test("installPluginShim uses Windows config root for shim path", async () => {
        const testId = crypto.randomUUID()
        const rootDir = `C:\\autocode-shim-${testId}`
        const homeDir = `C:\\Users\\Ada-${testId}`
        const configRoot = `C:\\Users\\Ada-${testId}\\AppData\\Roaming\\OpenCode`
        const expectedShimPath = win32.join(configRoot, "plugins", "autocode.js")

        try {
            await mkdir(rootDir)
            await writeFile(join(rootDir, "package.json"), JSON.stringify({ name: "@ahumandev/autocode" }))
            const shimPath = await installPluginShim({
                rootDir,
                homeDir,
                platform: "win32",
                env: { OPENCODE_CONFIG_DIR: configRoot },
            })

            expect(shimPath).toBe(expectedShimPath)
            expect(shimPath.startsWith(`${configRoot}\\plugins\\`)).toBeTrue()
            expect(await readFile(shimPath, "utf8")).toContain("export { default } from")
            expect(await readFile(shimPath, "utf8")).toContain("dist/plugin.js")
        } finally {
            await rm(rootDir, { recursive: true, force: true })
            await rm(expectedShimPath, { force: true })
        }
    })
})
