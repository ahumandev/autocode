import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { getBundledSkillsRoot, getGeneratedSkillsRoot, managedSkills } from "./index"

setDefaultTimeout(30_000)

const expectedManagedDirectories = [
    "assist-troubleshoot",
    "author-agent",
    "author-article",
    "author-command",
    "author-fallacies",
    "author-readme",
    "author-rules",
    "code-angular",
    "code-java",
    "code-rest",
    "code-typescript",
    "execute-sandbox",
    "primary-manual",
    "skill-write",
    "test-jest",
    "test-junit",
    "test-mockito",
    "test-vitest",
]
const sourceSkillPathExpectations = [
    {
        directory: "author-agent",
        pluralPaths: [".opencode/agents/{name}.md", "~/.config/opencode/agents/{name}.md"],
        singularPaths: [".opencode/agent/{name}.md", "~/.config/opencode/agent/{name}.md"],
    },
    {
        directory: "author-command",
        pluralPaths: [".opencode/commands/{name}.md", "~/.config/opencode/commands/{name}.md"],
        singularPaths: [".opencode/command/{name}.md", "~/.config/opencode/command/{name}.md"],
    },
]

function sourceSkillsRoot(): string {
    return path.join(import.meta.dir, "..", "skills")
}

describe("managed skills", () => {
    test("covers expected source skill directories and intentional exclusions", () => {
        const managedDirectories = managedSkills.map((skill) => skill.directory).sort()

        expect(managedDirectories).toEqual(expectedManagedDirectories)
        expect(managedDirectories).toContain("skill-write")
    })

    test("loads name, description, and content for every managed skill", () => {
        for (const skill of managedSkills) {
            expect(skill.name).toBe(skill.directory)
            expect(skill.description.length).toBeGreaterThan(0)
            expect(skill.content.length).toBeGreaterThan(0)
            expect(skill.content.startsWith("---")).toBe(false)
        }
    })

    test("bundled root exposes the static source and parsed content", () => {
        expect(getBundledSkillsRoot()).toBe(sourceSkillsRoot())
        for (const skill of managedSkills) {
            const source = readFileSync(path.join(getBundledSkillsRoot(), skill.directory, "SKILL.md"), "utf8").replace(/^\uFEFF/, "").replaceAll("\r\n", "\n")
            expect(source).toContain(`name: ${skill.name}`)
            expect(source).toContain(`description: ${skill.description}`)
            expect(source.trimEnd().endsWith(skill.content)).toBe(true)
        }
    })

    test("generated root is resolved under the supplied home", () => {
        const home = path.join(tmpdir(), "autocode-skills-fixture-home")
        expect(getGeneratedSkillsRoot({ home })).toBe(path.join(home, ".agents", "skills", "autocode"))
    })

    test("source skill docs use plural OpenCode paths", () => {
        for (const expectation of sourceSkillPathExpectations) {
            const content = readFileSync(path.join(sourceSkillsRoot(), expectation.directory, "SKILL.md"), "utf8")

            for (const pluralPath of expectation.pluralPaths) {
                expect(content).toContain(pluralPath)
            }

            for (const singularPath of expectation.singularPaths) {
                expect(content).not.toContain(singularPath)
            }
        }
    })

    test("gitignore ignores active and archived memories with anchored rules", () => {
        const gitignoreLines = readFileSync(path.join(import.meta.dir, "..", "..", ".gitignore"), "utf8").split(/\r?\n/)

        expect(gitignoreLines).toContain("/.opencode/autocode/memories/")
    })
})
