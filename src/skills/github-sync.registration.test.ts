import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const repositoryRoot = join(import.meta.dir, "..", "..")

test("registers exact GitHub skill sync command and cache path", async () => {
    const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> }
    const githubCachePath = ".cache/autocode/skill-repos/github"

    expect(packageJson.scripts?.["skill:sync"]).toBe("bun scripts/sync-github-skills.ts")
    expect(githubCachePath).toStartWith(".cache/autocode/")
})
