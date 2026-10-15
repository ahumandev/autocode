import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { shouldUseShell } from "./release-version"

const commitMessage = "chore: release v0.18.3"
const tagMessage = "@ahumandev/autocode v0.18.3"
const releaseScriptPath = resolve(import.meta.dir, "release-version.ts")
const subprocessTimeout = 5_000

test("importing the release script does not validate CLI arguments", (): void => {
    const importMarker = "release-script-imported"
    const result = spawnSync(
        process.execPath,
        ["-e", `process.argv = [process.execPath, ${JSON.stringify(releaseScriptPath)}]; await import(${JSON.stringify(releaseScriptPath)}); console.log(${JSON.stringify(importMarker)})`],
        { encoding: "utf8", timeout: subprocessTimeout },
    )

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe(importMarker)
    expect(result.stderr).toBe("")
})

test.each([undefined, "invalid"])("direct execution rejects version %s with usage", (versionArg: string | undefined): void => {
    const args = versionArg === undefined ? [] : [versionArg]
    const result = spawnSync(
        process.execPath,
        [releaseScriptPath, ...args],
        { encoding: "utf8", timeout: subprocessTimeout },
    )

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr.trim()).toBe("Usage: bun run release:version -- <patch|minor|major|x.y.z>")
    expect(result.stdout).toBe("")
})

test("git is spawned directly on Windows", () => {
    expect(shouldUseShell("git", "win32")).toBe(false)
})

test("non-git commands keep the Windows shell for npm.cmd compatibility", () => {
    expect(shouldUseShell("npm", "win32")).toBe(true)
})

test.each(["linux", "darwin"] as const)("no shell is used on %s", (platform) => {
    expect(shouldUseShell("git", platform)).toBe(false)
    expect(shouldUseShell("npm", platform)).toBe(false)
})

test("spaced commit and tag messages stay single arguments when git shell option is used", () => {
    const result = spawnSync(
        process.execPath,
        ["-e", "console.log(JSON.stringify(process.argv.slice(-6)))", "commit", "-m", commitMessage, "tag", "-m", tagMessage],
        { encoding: "utf8", shell: shouldUseShell("git", "win32") },
    )

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(["commit", "-m", commitMessage, "tag", "-m", tagMessage])
})
