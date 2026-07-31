import { describe, expect, test } from "bun:test"
import { buildExecuteOsPrompt } from "../agents/prompts/execute_os"
import { buildQueryOsPrompt } from "../agents/prompts/query_os"
import { createPlatformCapabilities } from "./platform"

describe("platform capabilities", () => {
    test("marks only win32 as Windows", () => {
        expect(createPlatformCapabilities("win32").isWindows).toBe(true)
        expect(createPlatformCapabilities("linux").isWindows).toBe(false)
        expect(createPlatformCapabilities("darwin").isWindows).toBe(false)
    })
})

describe("OS prompts", () => {
    test("buildExecuteOsPrompt uses Windows CMD guidance without positive Bash guidance", () => {
        const prompt = buildExecuteOsPrompt(createPlatformCapabilities("win32"))

        expect(prompt).toMatch(/running on windows/i)
        expect(prompt).toMatch(/cmd commands/i)
        expect(prompt).toMatch(/never use bash/i)
        expect(prompt).not.toMatch(/always use the `bash` tool/i)
    })

    test("buildExecuteOsPrompt keeps Bash guidance outside Windows", () => {
        const prompt = buildExecuteOsPrompt(createPlatformCapabilities("linux"))

        expect(prompt).toMatch(/always use the `bash` tool/i)
        expect(prompt).not.toMatch(/running on windows/i)
        expect(prompt).not.toMatch(/cmd commands/i)
    })

    test("buildQueryOsPrompt uses Windows CMD guidance without positive Bash guidance", () => {
        const prompt = buildQueryOsPrompt(createPlatformCapabilities("win32"))

        expect(prompt).toMatch(/running on windows/i)
        expect(prompt).toMatch(/cmd commands/i)
        expect(prompt).toMatch(/never use bash/i)
        expect(prompt).not.toMatch(/prefer other tools over `bash` tool/i)
    })

    test("buildQueryOsPrompt keeps Bash guidance outside Windows", () => {
        const prompt = buildQueryOsPrompt(createPlatformCapabilities("linux"))

        expect(prompt).toMatch(/prefer other tools over `bash` tool/i)
        expect(prompt).not.toMatch(/running on windows/i)
        expect(prompt).not.toMatch(/cmd commands/i)
    })
})
