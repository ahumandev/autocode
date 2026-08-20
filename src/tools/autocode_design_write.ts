import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { mkdir, writeFile } from "node:fs/promises"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"
import { createJobWorkspace, getCurrentSessionTitle, type JobWorkspaceFileSystem } from "@/utils/jobs"

export const designSections = ["problems", "impact", "expectations", "requirements", "constraints", "proposal"] as const

export type DesignSection = typeof designSections[number]

type DesignWriteArgs = {
    problems?: string
    impact?: string
    expectations?: string
    requirements?: string
    constraints?: string
    proposal?: string
}

type FileSystem = JobWorkspaceFileSystem

const designSectionContentDescriptions: Record<DesignSection, string> = {
    problems: "Define observed wrong/missing project behavior or missing info. Include exact key names, values, paths, codes, and user provided examples.",
    impact: "Define why problem matters. Describe affected user, system, or workflow impact.",
    expectations: "Define expected outcome from user perspective. Include target behavior or research goal.",
    requirements:
`* Derive missing EXPECTATIONS from opposites of PROBLEMS taking IMPACT into account.
* Define each REQUIREMENT as H3 sub-section:
    - Every REQUIREMENT must contain 1+ clearly defined CRITERIA (how to measure if requirement was meet)
    - Each CRITERIA in bullet list in REQUIREMENT sub-section body
    - Include input/output examples or technical key details like (names, keys, values, paths, codes, etc.)
    - Include all relevant examples, configs, quotes, acceptance details, and original user-request content inside the matching subsection body.
`,
    constraints: "Define confirmed limits, restrictions, and non-goals that shape proposal. No assumptions, only facts.",
    proposal:
`Propose simplest approach to meet REQUIREMENTS within CONSTRAINTS:
    - Provide sequence of GOALS (planned project changes) according to PROPOSAL
    - Each GOAL must briefly describe overview of STEP to reach GOAL
    - Describe as high-level conceptual design
    - Include already discovered implementation details and workarounds to assumed risks
    - NEVER repeat any info already provided in other design sections/parameters
`,
}

const defaultFileSystem: FileSystem = {
    mkdir,
    writeFile,
}

function normalizeDesignValue(content: string | undefined): string {
    return content?.trim().replace(/^#{1,2}\s+(?:problem|problems|observation|observations|impact|impacts|expectation|expectations|requirements|constraints|solution|proposed solution|proposal|proposals)\s*\n+/i, "").trim() ?? ""
}

export function composeDesignMarkdown(sections: Record<DesignSection, string>): string {
    return `
## Problems

${sections.problems.trim()}

---

## Impact

${sections.impact.trim()}

---

## Expectations

${sections.expectations.trim()}

---

## Requirements

${sections.requirements.trim()}

---

## Constraints

${sections.constraints.trim()}

---

## Proposal

${sections.proposal.trim()}
`
}

function isFileSystem(candidate: OpencodeClient | FileSystem | undefined): candidate is FileSystem {
    return typeof (candidate as { mkdir?: unknown } | undefined)?.mkdir === "function"
        && typeof (candidate as { writeFile?: unknown } | undefined)?.writeFile === "function"
}

function normalizeDesignWriteToolArgs(clientOrFileSystem?: OpencodeClient | FileSystem, maybeFileSystem?: FileSystem): { client?: OpencodeClient, fileSystem: FileSystem } {
    if (maybeFileSystem) {
        return { client: clientOrFileSystem as OpencodeClient | undefined, fileSystem: maybeFileSystem }
    }

    if (isFileSystem(clientOrFileSystem)) {
        return { fileSystem: clientOrFileSystem }
    }

    return { client: clientOrFileSystem as OpencodeClient | undefined, fileSystem: defaultFileSystem }
}

export function createAutocodeDesignWriteTool(clientOrFileSystem?: OpencodeClient | FileSystem, maybeFileSystem?: FileSystem): ReturnType<typeof tool> {
    const { client, fileSystem } = normalizeDesignWriteToolArgs(clientOrFileSystem, maybeFileSystem)
    return tool({
        description: "Create design.md for a new job workspace.",
        args: {
            problems: tool.schema.string().optional().describe(designSectionContentDescriptions.problems),
            impact: tool.schema.string().optional().describe(designSectionContentDescriptions.impact),
            expectations: tool.schema.string().optional().describe(designSectionContentDescriptions.expectations),
            requirements: tool.schema.string().optional().describe(designSectionContentDescriptions.requirements),
            constraints: tool.schema.string().optional().describe(designSectionContentDescriptions.constraints),
            proposal: tool.schema.string().optional().describe(designSectionContentDescriptions.proposal),
        },
        async execute(args: DesignWriteArgs, context): Promise<string> {
            const hasAnyContent = Object.values(args).some((value) => value !== undefined)
            if (!hasAnyContent) {
                return createRetryResponse(
                    "save design",
                    "Missing required design content",
                    "Provide at least one of: problems, impact, expectations, requirements, constraints, proposal."
                )
            }

            try {
                const sessionTitle = await getCurrentSessionTitle(client, context)
                if (!sessionTitle.title) {
                    throw new Error(sessionTitle.warning ?? "Unable to resolve the current session title.")
                }

                const workspace = await createJobWorkspace(fileSystem, context, sessionTitle.title, composeDesignMarkdown({
                    problems: normalizeDesignValue(args.problems),
                    impact: normalizeDesignValue(args.impact),
                    expectations: normalizeDesignValue(args.expectations),
                    requirements: normalizeDesignValue(args.requirements),
                    constraints: normalizeDesignValue(args.constraints),
                    proposal: normalizeDesignValue(args.proposal),
                }))

                return JSON.stringify({
                    job_name: workspace.jobName,
                    job_path: workspace.designPath,
                })
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                if (message.startsWith("Unable to derive a valid job_name from the current session title:")) {
                    return createRetryResponse("save design", message, "Rename the current session to include letters or numbers, then save the design again.")
                }

                return createAbortResponse("save design", error)
            }
        },
    })
}
