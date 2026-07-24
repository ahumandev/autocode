import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseGitHubSkillUrl } from "../utils/github"
import { loadGitHubSkillInventory, type GitHubSkillInventoryEntry } from "./github"

const snapshotContent = "valid snapshot\n"
const snapshotDigest = createHash("sha256").update(snapshotContent).digest("hex")
const tempRoots: string[] = []

function inventoryEntry(overrides: Partial<GitHubSkillInventoryEntry> = {}): GitHubSkillInventoryEntry {
    return {
        sourceUrl: "https://github.com/angular/skills",
        resolvedCommit: "a23a517dea2ce90c97a4a85d684ae13eb4ff91a2",
        relativeInstallPath: "github/angular/skills/example",
        category: "code",
        sha256: snapshotDigest,
        ...overrides,
    }
}

async function createFixture(entries: GitHubSkillInventoryEntry[], snapshot = snapshotContent, writeSnapshot = true): Promise<{ inventoryPath: string, skillsRoot: string }> {
    const root = await mkdtemp(join(tmpdir(), "autocode-github-skills-"))
    const skillsRoot = join(root, "skills")
    const inventoryPath = join(root, "github.jsonc")
    tempRoots.push(root)

    if (writeSnapshot) {
        const snapshotPath = join(skillsRoot, "github", "angular", "skills", "example", "SKILL.md")
        await mkdir(join(snapshotPath, ".."), { recursive: true })
        await writeFile(snapshotPath, snapshot)
    }
    await writeFile(inventoryPath, `// isolated fixture\n${JSON.stringify({ skills: entries })}\n`)

    return { inventoryPath, skillsRoot }
}

afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })))
})

describe("loadGitHubSkillInventory", () => {
    test("loads committed inventory with expected categories, paths, provenance, and snapshots", async () => {
        const inventory = await loadGitHubSkillInventory(join(import.meta.dir, "github.jsonc"), import.meta.dir)

        expect(inventory.skills).toHaveLength(13)
        expect(new Set(inventory.skills.map((entry) => entry.sourceUrl)).size).toBe(12)
        expect(Object.fromEntries(["bash", "code", "design", "test"].map((category) => [
            category,
            inventory.skills.filter((entry) => entry.category === category).length,
        ]))).toEqual({ bash: 2, code: 7, design: 1, test: 3 })

        for (const entry of inventory.skills) {
            const segments = entry.relativeInstallPath.split("/")
            const parsed = parseGitHubSkillUrl(entry.sourceUrl)

            expect(segments).toHaveLength(4)
            expect(segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")).toBe(true)
            expect(entry.relativeInstallPath).not.toContain("\\")
            expect(segments[0]).toBe("github")
            expect(existsSync(join(import.meta.dir, entry.relativeInstallPath, "SKILL.md"))).toBe(true)
            expect(parsed.strategy).not.toBe("invalid")
            if (parsed.strategy !== "invalid") {
                expect(segments[1]).toBe(parsed.owner)
                expect(segments[2]).toBe(parsed.project)
            }
        }

        expect(parseGitHubSkillUrl("https://github.com/angular/skills")).toEqual({
            strategy: "repo",
            owner: "angular",
            project: "skills",
        })
        expect(parseGitHubSkillUrl("https://github.com/github/awesome-copilot/blob/main/skills/drawio/SKILL.md")).toMatchObject({
            strategy: "blob",
            owner: "github",
            project: "awesome-copilot",
            branch: "main",
            subDirs: "skills/drawio",
            skillFile: "SKILL.md",
        })
    })

    test("rejects invalid GitHub source URLs", async () => {
        const fixture = await createFixture([inventoryEntry({ sourceUrl: "https://example.com/skills" })])

        await expect(loadGitHubSkillInventory(fixture.inventoryPath, fixture.skillsRoot)).rejects.toThrow("invalid sourceUrl: unsupported host")
    })

    test("rejects invalid categories", async () => {
        const fixture = await createFixture([inventoryEntry({ category: "docs" as never })])

        await expect(loadGitHubSkillInventory(fixture.inventoryPath, fixture.skillsRoot)).rejects.toThrow('invalid category "docs"')
    })

    test("rejects category used as install path project segment", async () => {
        const fixture = await createFixture([inventoryEntry({ relativeInstallPath: "github/angular/code/example" })])

        await expect(loadGitHubSkillInventory(fixture.inventoryPath, fixture.skillsRoot)).rejects.toThrow("relativeInstallPath must be github/<owner>/<project>/<skill> and match sourceUrl")
    })

    test("rejects traversal and mismatched source provenance layouts", async () => {
        const traversal = await createFixture([inventoryEntry({ relativeInstallPath: "github/angular/skills/.." })])
        const mismatch = await createFixture([inventoryEntry({ relativeInstallPath: "github/other/skills/example" })])

        await expect(loadGitHubSkillInventory(traversal.inventoryPath, traversal.skillsRoot)).rejects.toThrow("relativeInstallPath must be github/<owner>/<project>/<skill> and match sourceUrl")
        await expect(loadGitHubSkillInventory(mismatch.inventoryPath, mismatch.skillsRoot)).rejects.toThrow("relativeInstallPath must be github/<owner>/<project>/<skill> and match sourceUrl")
    })

    test("rejects malformed commit and digest values", async () => {
        const commit = await createFixture([inventoryEntry({ resolvedCommit: "not-a-commit" })])
        const digest = await createFixture([inventoryEntry({ sha256: "A".repeat(64) })])

        await expect(loadGitHubSkillInventory(commit.inventoryPath, commit.skillsRoot)).rejects.toThrow("resolvedCommit must be a 40-character Git commit SHA")
        await expect(loadGitHubSkillInventory(digest.inventoryPath, digest.skillsRoot)).rejects.toThrow("sha256 must be a 64-character lowercase hexadecimal SHA-256 digest")
    })

    test("rejects duplicate install paths", async () => {
        const fixture = await createFixture([inventoryEntry(), inventoryEntry()])

        await expect(loadGitHubSkillInventory(fixture.inventoryPath, fixture.skillsRoot)).rejects.toThrow('duplicate relativeInstallPath "github/angular/skills/example"')
    })

    test("rejects absent snapshots and snapshot digest mismatches", async () => {
        const absent = await createFixture([inventoryEntry()], snapshotContent, false)
        const mismatch = await createFixture([inventoryEntry()], "changed snapshot\n")

        await expect(loadGitHubSkillInventory(absent.inventoryPath, absent.skillsRoot)).rejects.toThrow("cannot read snapshot")
        await expect(loadGitHubSkillInventory(mismatch.inventoryPath, mismatch.skillsRoot)).rejects.toThrow("snapshot SHA-256 mismatch")
    })
})
