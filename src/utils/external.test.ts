import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { SkillLogger } from "./logger"
import type { InstalledSkill } from "./symlink"
import type { ParsedGitHubSkillUrl } from "./github"

type BootstrapFn = typeof import("./external").bootstrapExternalSkills

let bootstrapExternalSkills: BootstrapFn
let cloneRepoMock: ReturnType<typeof mock>
let installSymlinksMock: ReturnType<typeof mock>

const stubLogger: SkillLogger = { log: () => {} }

beforeAll(async () => {
    cloneRepoMock = mock(() => "/tmp/fake-clone-target")
    installSymlinksMock = mock(() => [] as InstalledSkill[])

    // Set up module mocks before dynamic import so the mocked modules are
    // resolved when ./external first pulls them in.
    mock.module("./clone", () => ({
        cloneRepo: cloneRepoMock,
    }))

    mock.module("./symlink", () => ({
        installSymlinks: installSymlinksMock,
    }))

    const mod = await import("./external")
    bootstrapExternalSkills = mod.bootstrapExternalSkills
})

beforeEach(() => {
    cloneRepoMock.mockReset()
    installSymlinksMock.mockReset()
    cloneRepoMock.mockImplementation(() => "/tmp/fake-clone-target")
    installSymlinksMock.mockImplementation(() => [] as InstalledSkill[])
})

describe("bootstrapExternalSkills", () => {
    test("returns empty array when skills config is undefined", async () => {
        const result = await bootstrapExternalSkills(undefined, stubLogger)
        expect(result).toEqual([])
    })

    test("returns empty array when skills config is empty object", async () => {
        const result = await bootstrapExternalSkills({}, stubLogger)
        expect(result).toEqual([])
    })

    test("registers bash skills under the bash category", async () => {
        installSymlinksMock.mockImplementationOnce(() => [
            { category: "", skillName: "my-skill", owner: "o", project: "p" },
        ])

        const result = await bootstrapExternalSkills({
            bash: ["https://github.com/o/p/blob/main/skills/my-skill/SKILL.md"],
        }, stubLogger)

        expect(result).toEqual([
            { category: "bash", skillName: "my-skill", owner: "o", project: "p" },
        ])
    })

    test("skips invalid URLs without throwing", async () => {
        const result = await bootstrapExternalSkills({
            bash: ["not-a-url"],
        }, stubLogger)

        expect(result).toEqual([])
        expect(cloneRepoMock).not.toHaveBeenCalled()
        expect(installSymlinksMock).not.toHaveBeenCalled()
    })

    test("per-URL clone failures do not stop other URLs from being processed", async () => {
        let callCount = 0
        cloneRepoMock.mockImplementation(() => {
            callCount += 1
            if (callCount === 1) {
                throw new Error("clone failed")
            }
            return "/tmp/fake-clone-target"
        })
        installSymlinksMock.mockImplementation(() => {
            if (callCount === 2) {
                return [{ category: "", skillName: "skill-2", owner: "o", project: "p" }]
            }
            return []
        })

        const result = await bootstrapExternalSkills({
            bash: [
                "https://github.com/o/p/blob/main/skills/skill-1/SKILL.md",
                "https://github.com/o/p/blob/main/skills/skill-2/SKILL.md",
            ],
        }, stubLogger)

        expect(result).toHaveLength(1)
        expect(result[0]?.skillName).toBe("skill-2")
        expect(result[0]?.category).toBe("bash")
    })
})
