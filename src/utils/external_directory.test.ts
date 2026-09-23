import { describe, expect, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin"
import { authorizeExternalContentPath, effectiveExternalDirectoryAction, matchExternalDirectoryAction } from "./external_directory"

describe("matchExternalDirectoryAction", () => {
    test("matches literal Linux paths only as whole values", (): void => {
        const rules = { "/external": "allow" } as const

        expect(matchExternalDirectoryAction(rules, "/external")).toBe("allow")
        expect(matchExternalDirectoryAction(rules, "/external/config.json")).toBe("ask")
        expect(matchExternalDirectoryAction(rules, "/external2/config.json")).toBe("ask")
    })

    test("keeps Linux paths case-sensitive", (): void => {
        const rules = { "/External": "allow" } as const

        expect(matchExternalDirectoryAction(rules, "/external/config.json")).toBe("ask")
    })

    test("keeps explicit wildcard matching behavior", (): void => {
        const rules = { "/external/*.md": "allow" } as const

        expect(matchExternalDirectoryAction(rules, "/external/readme.md")).toBe("allow")
        expect(matchExternalDirectoryAction(rules, "/external/readme.txt")).toBe("ask")
    })

    test("defaults unmatched paths to ask and matches V2 question-mark globs", (): void => {
        expect(matchExternalDirectoryAction({}, "/outside/file.md")).toBe("ask")
        expect(matchExternalDirectoryAction({ "/external/file?.md": "allow" }, "/external/file1.md")).toBe("allow")
    })

    test("uses the last matching rule even when an earlier pattern is longer", (): void => {
        expect(matchExternalDirectoryAction({ "/external/docs/*": "allow", "/external/*": "ask" }, "/external/docs/file.md")).toBe("ask")
        expect(matchExternalDirectoryAction({ "/external/a*": "ask", "/external/*b": "deny" }, "/external/ab")).toBe("deny")
        expect(matchExternalDirectoryAction({ "/external/*": "allow", "*": "deny" }, "/external/file.md")).toBe("deny")
        expect(matchExternalDirectoryAction([
            { action: "external_directory", resource: "/external/*", effect: "allow" },
            { action: "external_directory", resource: "*", effect: "deny" },
        ], "/external/file.md")).toBe("deny")
    })

    test("matches Windows drive paths across separators and case", (): void => {
        const rules = { "C:\\External": "allow" } as const

        expect(matchExternalDirectoryAction(rules, "c:/external")).toBe("allow")
        expect(matchExternalDirectoryAction(rules, "c:/external/config.json")).toBe("ask")
    })

    test("matches Windows UNC paths and Unicode case variants", (): void => {
        const rules = { "\\\\Server\\Share\\DÖCS": "allow" } as const

        expect(matchExternalDirectoryAction(rules, "//server/share/döcs")).toBe("allow")
        expect(matchExternalDirectoryAction(rules, "//server/share/döcs/readme.md")).toBe("ask")
    })

    test("keeps Windows path matches within component boundaries", (): void => {
        const rules = { "C:\\external": "allow" } as const

        expect(matchExternalDirectoryAction(rules, "C:/external2/config.json")).toBe("ask")
    })

    test("matches Windows wildcards after separator normalization and case folding", (): void => {
        const rules = { "C:\\External\\*.MD": "allow" } as const

        expect(matchExternalDirectoryAction(rules, "c:/external/readme.md")).toBe("allow")
    })

    test("returns create, edit, and remove authorization actions", (): void => {
        expect(matchExternalDirectoryAction({ "/create/*": "allow" }, "/create/file.md")).toBe("allow")
        expect(matchExternalDirectoryAction({ "/edit/*": "ask" }, "/edit/file.md")).toBe("ask")
        expect(matchExternalDirectoryAction({ "/remove/*": "deny" }, "/remove/file.md")).toBe("deny")
    })
})

describe("effectiveExternalDirectoryAction", () => {
    test("active agent denial blocks global allowance", () => {
        const globalRules = [{ action: "external_directory", resource: "/shared/*", effect: "allow" as const }]
        const agentRules = [
            { action: "external_directory", resource: "*", effect: "ask" as const },
            { action: "external_directory", resource: "/shared/*", effect: "deny" as const },
        ]

        expect(effectiveExternalDirectoryAction(globalRules, agentRules, "/shared/file.md")).toBe("deny")
    })

    test("final global wildcard denial blocks agent allowance", () => {
        const globalRules = [
            { action: "external_directory", resource: "/shared/*", effect: "allow" as const },
            { action: "external_directory", resource: "*", effect: "deny" as const },
        ]
        const agentRules = [{ action: "external_directory", resource: "/shared/*", effect: "allow" as const }]

        expect(effectiveExternalDirectoryAction(globalRules, agentRules, "/shared/file.md")).toBe("deny")
    })
})

test("fails closed when active agent permissions are unavailable", async () => {
    const context = { directory: "/worktree", worktree: "/worktree" } as ToolContext
    const result = await authorizeExternalContentPath(context, "/shared/file.md", "read")

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response).toContain("Effective agent external_directory permissions are unavailable")
})
