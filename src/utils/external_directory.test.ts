import { describe, expect, test } from "bun:test"
import { matchExternalDirectoryAction } from "./external_directory"

describe("matchExternalDirectoryAction", () => {
    test("matches Linux exact paths and children without crossing component boundaries", (): void => {
        const rules = { "/external": "allow" } as const

        expect(matchExternalDirectoryAction(rules, "/external")).toBe("allow")
        expect(matchExternalDirectoryAction(rules, "/external/config.json")).toBe("allow")
        expect(matchExternalDirectoryAction(rules, "/external2/config.json")).toBeUndefined()
    })

    test("keeps Linux paths case-sensitive", (): void => {
        const rules = { "/External": "allow" } as const

        expect(matchExternalDirectoryAction(rules, "/external/config.json")).toBeUndefined()
    })

    test("keeps explicit wildcard matching behavior", (): void => {
        const rules = { "/external/*.md": "allow" } as const

        expect(matchExternalDirectoryAction(rules, "/external/readme.md")).toBe("allow")
        expect(matchExternalDirectoryAction(rules, "/external/readme.txt")).toBeUndefined()
    })

    test("prefers longest original pattern and first equal-length rule", (): void => {
        expect(matchExternalDirectoryAction({ "/external": "ask", "/external/docs": "allow" }, "/external/docs/file.md")).toBe("allow")
        expect(matchExternalDirectoryAction({ "/external/a*": "ask", "/external/*b": "deny" }, "/external/ab")).toBe("ask")
    })

    test("matches Windows drive paths across separators and case", (): void => {
        const rules = { "C:\\External": "allow" } as const

        expect(matchExternalDirectoryAction(rules, "c:/external/config.json")).toBe("allow")
    })

    test("matches Windows UNC paths and Unicode case variants", (): void => {
        const rules = { "\\\\Server\\Share\\DÖCS": "allow" } as const

        expect(matchExternalDirectoryAction(rules, "//server/share/döcs/readme.md")).toBe("allow")
    })

    test("keeps Windows path matches within component boundaries", (): void => {
        const rules = { "C:\\external": "allow" } as const

        expect(matchExternalDirectoryAction(rules, "C:/external2/config.json")).toBeUndefined()
    })

    test("matches Windows wildcards after separator normalization and case folding", (): void => {
        const rules = { "C:\\External\\*.MD": "allow" } as const

        expect(matchExternalDirectoryAction(rules, "c:/external/readme.md")).toBe("allow")
    })

    test("returns create, edit, and remove authorization actions", (): void => {
        expect(matchExternalDirectoryAction({ "/create": "allow" }, "/create/file.md")).toBe("allow")
        expect(matchExternalDirectoryAction({ "/edit": "ask" }, "/edit/file.md")).toBe("ask")
        expect(matchExternalDirectoryAction({ "/remove": "deny" }, "/remove/file.md")).toBe("deny")
    })
})
