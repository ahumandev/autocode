import { describe, expect, test } from "bun:test"
import { posix } from "node:path"
import { DEFAULT_MEMORY_DIRECTORY, resolveMemoryDirectory, resolveMemoryIndexPath } from "./memory_directory"

describe("memory directory resolution", () => {
    test("uses the default for omitted, undefined, and blank directories", () => {
        expect(DEFAULT_MEMORY_DIRECTORY).toBe(".opencode/autocode/memory")
        expect(resolveMemoryDirectory("/project")).toBe("/project/.opencode/autocode/memory")
        for (const directory of [undefined, "", " \t\n"]) {
            expect(resolveMemoryDirectory("/project", directory)).toBe("/project/.opencode/autocode/memory")
        }
    })

    test("normalizes POSIX absolute and project-relative directories", () => {
        expect(resolveMemoryDirectory("/project/app", "/shared/./notes/../memory")).toBe("/shared/memory")
        expect(resolveMemoryDirectory("/project/app", "../notes/./private/../memory")).toBe("/project/notes/memory")
        expect(resolveMemoryDirectory("relative/project", "../memory")).toBe(posix.resolve("relative/project", "../memory"))
    })

    test("resolves Windows drive paths independently of the host", () => {
        expect(resolveMemoryDirectory("C:\\work\\project", "D:\\shared\\notes\\..\\memory")).toBe("D:\\shared\\memory")
        expect(resolveMemoryDirectory("C:\\work\\project", "..\\notes\\.\\memory")).toBe("C:\\work\\notes\\memory")
        expect(resolveMemoryDirectory("relative/project", "C:/shared/./memory")).toBe("C:\\shared\\memory")
    })

    test("resolves Windows UNC paths independently of the host", () => {
        expect(resolveMemoryDirectory("/project", "\\\\server\\share\\notes\\..\\memory")).toBe("\\\\server\\share\\memory")
        expect(resolveMemoryDirectory("\\\\server\\share\\project", "..\\notes\\memory")).toBe("\\\\server\\share\\notes\\memory")
    })

    test("keeps nonblank configured directory whitespace", () => {
        expect(resolveMemoryDirectory("/project", " notes ")).toBe("/project/ notes ")
    })

    test("appends exact INDEX.md using the selected path flavor", () => {
        expect(resolveMemoryIndexPath("/project")).toBe("/project/.opencode/autocode/memory/INDEX.md")
        expect(resolveMemoryIndexPath("/project", "../memory")).toBe("/memory/INDEX.md")
        expect(resolveMemoryIndexPath("C:\\work\\project", "..\\memory")).toBe("C:\\work\\memory\\INDEX.md")
        expect(resolveMemoryIndexPath("/project", "\\\\server\\share\\memory")).toBe("\\\\server\\share\\memory\\INDEX.md")
    })
})
