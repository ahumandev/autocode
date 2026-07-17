import { describe, expect, test } from "bun:test"
import { cloneUrlFor, parseGitHubSkillUrl } from "./github"

describe("parseGitHubSkillUrl", () => {
    describe("repo form", () => {
        test("classifies owner/project as repo strategy", () => {
            expect(parseGitHubSkillUrl("https://github.com/angular/skills")).toEqual({
                strategy: "repo",
                owner: "angular",
                project: "skills",
            })
        })

        test("tolerates trailing slash on repo form", () => {
            expect(parseGitHubSkillUrl("https://github.com/angular/skills/")).toEqual({
                strategy: "repo",
                owner: "angular",
                project: "skills",
            })
        })
    })

    describe("subtree form", () => {
        test("classifies tree/branch/subdir as subtree strategy", () => {
            expect(parseGitHubSkillUrl("https://github.com/github/awesome-copilot/tree/main/skills/javascript-typescript-jest")).toEqual({
                strategy: "subtree",
                owner: "github",
                project: "awesome-copilot",
                branch: "main",
                subDirs: "skills/javascript-typescript-jest",
            })
        })

        test("tolerates trailing slash on subtree form", () => {
            expect(parseGitHubSkillUrl("https://github.com/github/awesome-copilot/tree/main/skills/javascript-typescript-jest/")).toEqual({
                strategy: "subtree",
                owner: "github",
                project: "awesome-copilot",
                branch: "main",
                subDirs: "skills/javascript-typescript-jest",
            })
        })
    })

    describe("blob form", () => {
        test("classifies blob/branch/subdir/SKILL.md as blob strategy", () => {
            expect(parseGitHubSkillUrl("https://github.com/github/awesome-copilot/blob/main/skills/java-junit/SKILL.md")).toEqual({
                strategy: "blob",
                owner: "github",
                project: "awesome-copilot",
                branch: "main",
                subDirs: "skills/java-junit",
                skillFile: "SKILL.md",
            })
        })
    })

    describe("raw form", () => {
        test("classifies raw.githubusercontent.com refs/heads URL as raw strategy", () => {
            expect(parseGitHubSkillUrl("https://raw.githubusercontent.com/foo/bar/refs/heads/dev/skills/x/SKILL.md")).toEqual({
                strategy: "raw",
                owner: "foo",
                project: "bar",
                branch: "dev",
                subDirs: "skills/x",
                skillFile: "SKILL.md",
            })
        })
    })

    describe("invalid form", () => {
        test("rejects empty string with empty url reason", () => {
            expect(parseGitHubSkillUrl("")).toEqual({
                strategy: "invalid",
                url: "",
                reason: "empty url",
            })
        })

        test("rejects unsupported host", () => {
            expect(parseGitHubSkillUrl("https://example.com/x")).toEqual({
                strategy: "invalid",
                url: "https://example.com/x",
                reason: "unsupported host",
            })
        })

        test("rejects unparseable string", () => {
            const result = parseGitHubSkillUrl("not-a-url")
            expect(result.strategy).toBe("invalid")
            if (result.strategy === "invalid") {
                expect(result.url).toBe("not-a-url")
            }
        })
    })
})

describe("cloneUrlFor", () => {
    test("returns HTTPS clone URL for repo strategy", () => {
        const parsed = parseGitHubSkillUrl("https://github.com/angular/skills")
        expect(cloneUrlFor(parsed)).toBe("https://github.com/angular/skills.git")
    })

    test("returns HTTPS clone URL for subtree strategy", () => {
        const parsed = parseGitHubSkillUrl("https://github.com/github/awesome-copilot/tree/main/skills/javascript-typescript-jest")
        expect(cloneUrlFor(parsed)).toBe("https://github.com/github/awesome-copilot.git")
    })

    test("returns HTTPS clone URL for blob strategy", () => {
        const parsed = parseGitHubSkillUrl("https://github.com/github/awesome-copilot/blob/main/skills/java-junit/SKILL.md")
        expect(cloneUrlFor(parsed)).toBe("https://github.com/github/awesome-copilot.git")
    })

    test("returns HTTPS clone URL for raw strategy", () => {
        const parsed = parseGitHubSkillUrl("https://raw.githubusercontent.com/foo/bar/refs/heads/dev/skills/x/SKILL.md")
        expect(cloneUrlFor(parsed)).toBe("https://github.com/foo/bar.git")
    })

    test("returns null for invalid strategy", () => {
        const parsed = parseGitHubSkillUrl("not-a-url")
        expect(cloneUrlFor(parsed)).toBeNull()
    })

    test("returns null when parsed input is empty", () => {
        const parsed = parseGitHubSkillUrl("")
        expect(cloneUrlFor(parsed)).toBeNull()
    })
})
