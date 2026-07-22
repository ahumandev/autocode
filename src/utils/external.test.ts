import { describe, expect, test } from "bun:test"
import { bootstrapExternalSkills, type ExternalSkillDependencies } from "./external"
import type { SkillLogger } from "./logger"
import type { InstalledSkill } from "./symlink"

const stubLogger: SkillLogger = { log: () => {} }

function createDependencies(installed: InstalledSkill[] = []): ExternalSkillDependencies {
    return {
        cloneRepo: async () => "/tmp/fake-clone-target",
        findExistingCloneTarget: () => undefined,
        installSymlinks: async () => installed,
    }
}

describe("bootstrapExternalSkills", () => {
    test("returns empty array when skills config is undefined", async () => {
        const result = await bootstrapExternalSkills(undefined, stubLogger, createDependencies())
        expect(result).toEqual([])
    })

    test("returns empty array when skills config is empty object", async () => {
        const result = await bootstrapExternalSkills({}, stubLogger, createDependencies())
        expect(result).toEqual([])
    })

    test("registers bash skills under the bash category", async () => {
        const dependencies = createDependencies([
            { category: "", skillName: "my-skill", owner: "o", project: "p" },
        ])

        const result = await bootstrapExternalSkills({
            bash: ["https://github.com/o/p/blob/main/skills/my-skill/SKILL.md"],
        }, stubLogger, dependencies)

        expect(result).toEqual([
            { category: "bash", skillName: "my-skill", owner: "o", project: "p" },
        ])
    })

    test("skips invalid URLs without throwing", async () => {
        let cloneCalls = 0
        let installCalls = 0
        const dependencies: ExternalSkillDependencies = {
            cloneRepo: async () => {
                cloneCalls += 1
                return "/tmp/fake-clone-target"
            },
            findExistingCloneTarget: () => undefined,
            installSymlinks: async () => {
                installCalls += 1
                return []
            },
        }

        const result = await bootstrapExternalSkills({
            bash: ["not-a-url"],
        }, stubLogger, dependencies)

        expect(result).toEqual([])
        expect(cloneCalls).toBe(0)
        expect(installCalls).toBe(0)
    })

    test("uses existing skill directories without cloning", async () => {
        let cloneCalls = 0
        let installedTarget: string | undefined
        const dependencies: ExternalSkillDependencies = {
            cloneRepo: async () => {
                cloneCalls += 1
                return "/tmp/fake-clone-target"
            },
            findExistingCloneTarget: () => "/tmp/existing-skill",
            installSymlinks: async (_parsed, cloneTarget) => {
                installedTarget = cloneTarget
                return [{ category: "", skillName: "my-skill", owner: "o", project: "p" }]
            },
        }

        const result = await bootstrapExternalSkills({
            bash: ["https://github.com/o/p/blob/main/skills/my-skill/SKILL.md"],
        }, stubLogger, dependencies)

        expect(cloneCalls).toBe(0)
        expect(installedTarget).toBe("/tmp/existing-skill")
        expect(result).toHaveLength(1)
    })

    test("per-URL clone failures do not stop other URLs from being processed", async () => {
        let cloneCalls = 0
        const dependencies: ExternalSkillDependencies = {
            cloneRepo: async () => {
                cloneCalls += 1
                if (cloneCalls === 1) {
                    throw new Error("clone failed")
                }
                return "/tmp/fake-clone-target"
            },
            findExistingCloneTarget: () => undefined,
            installSymlinks: async () => [{ category: "", skillName: "skill-2", owner: "o", project: "p" }],
        }

        const result = await bootstrapExternalSkills({
            bash: [
                "https://github.com/o/p/blob/main/skills/skill-1/SKILL.md",
                "https://github.com/o/p/blob/main/skills/skill-2/SKILL.md",
            ],
        }, stubLogger, dependencies)

        expect(cloneCalls).toBe(2)
        expect(result).toHaveLength(1)
        expect(result[0]?.skillName).toBe("skill-2")
        expect(result[0]?.category).toBe("bash")
    })
})
