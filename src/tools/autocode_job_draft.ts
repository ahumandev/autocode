import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import type { Dirent } from "node:fs"
import path from "node:path"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"
import { activeJobLifecycleDirectories, completedJobLifecycleDirectory, deriveJobNameFromTitle, findExistingJobFile, getCurrentSessionTitle, getJobFilePath, getRelativeJobFilePath, resolveAgentsStorageRoot, updateCurrentSessionTitleToJobName, type ActiveJobLifecycleDirectory, type JobStatus } from "@/utils/jobs"

export const planSections = ["problems", "impact", "expectations", "requirements", "constraints", "proposal"] as const

export type PlanSection = typeof planSections[number]

type PlanSections = Record<PlanSection, string>

const planSectionContentDescriptions: Record<PlanSection, string> = {
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
    - NEVER repeat any info already provided in other plan sections/parameters
`,
}

type FileSystem = {
    readFile: (filePath: string, encoding: "utf8") => Promise<string>
    writeFile: (filePath: string, content: string) => Promise<void>
    mkdir?: (dirPath: string, options?: { recursive?: boolean }) => Promise<string | undefined>
    rm?: (path: string, options?: { recursive?: boolean, force?: boolean }) => Promise<void>
    stat?: (path: string) => Promise<{ mtimeMs: number }>
    readdir?: (dirPath: string, options: { withFileTypes: true }) => Promise<Dirent[]>
}

async function readDirectory(dirPath: string, options: { withFileTypes: true }): Promise<Dirent[]> {
    return readdir(dirPath, options)
}

const defaultFileSystem: FileSystem = {
    mkdir,
    readFile,
    rm,
    readdir: readDirectory,
    stat,
    writeFile,
}

type PlanJobDirectory = ActiveJobLifecycleDirectory | typeof completedJobLifecycleDirectory

function isPlanJobDirectory(directory: string): directory is PlanJobDirectory {
    return directory === completedJobLifecycleDirectory
        || (activeJobLifecycleDirectories as readonly string[]).includes(directory)
}

function getPlanPath(worktree: string, job: string, directory: PlanJobDirectory = "drafts") {
    return getJobFilePath(worktree, directory, job, "plan.md")
}

function getRelativePlanPath(job: string, directory: PlanJobDirectory = "drafts") {
    return getRelativeJobFilePath(directory, job, "plan.md")
}

function emptyPlanSections(): Record<PlanSection, string> {
    return {
        problems: "",
        impact: "",
        expectations: "",
        requirements: "",
        constraints: "",
        proposal: "",
    }
}

export function composePlanMarkdown(sections: Record<PlanSection, string>): string {
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

function normalizePlanValue(content: string | undefined): string | undefined {
    if (content === undefined) {
        return undefined
    }

    return content.trim().replace(/^#{1,2}\s+(?:problem|problems|observation|observations|impact|impacts|expectation|expectations|requirements|constraints|solution|proposed solution|proposal|proposals)\s*\n+/i, "").trim()
}

function getPlanSaveSections(args: PlanSaveArgs, existing: PlanSections | undefined): PlanSections {
    const nextSections = existing ? { ...existing } : emptyPlanSections()
    const providedSections: Array<[PlanSection, string | undefined]> = [
        ["problems", normalizePlanValue(args.problem ?? args.problems)],
        ["impact", normalizePlanValue(args.impact)],
        ["expectations", normalizePlanValue(args.expectation)],
        ["requirements", normalizePlanValue(args.requirements)],
        ["constraints", normalizePlanValue(args.constraints)],
        ["proposal", normalizePlanValue(args.proposal)],
    ]

    for (const [section, value] of providedSections) {
        if (value !== undefined) {
            nextSections[section] = value
        }
    }

    return nextSections
}


function parseSectionHeading(line: string): PlanSection | undefined {
    const heading = line.match(/^#{1,2}\s+(.+)\s*$/)
    const title = heading?.[1].trim().toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ")

    switch (title) {
        case "problem":
        case "problems":
        case "practical problem":
        case "practical problems":
        case "symptom":
        case "symptoms":
        case "bug":
        case "bugs":
            return "problems"
        case "impact":
        case "impacts":
            return "impact"
        case "expectation":
        case "expectations":
        case "expected behavior":
        case "expected behaviours":
        case "expected behavior/outcome":
        case "expected outcome":
        case "goals":
            return "expectations"
        case "requirement":
        case "requirements":
        case "functional requirements":
        case "practical requirements":
            return "requirements"
        case "constraint":
        case "constraints":
        case "non functional requirements":
        case "practical constraints":
            return "constraints"
        case "solution":
        case "proposed solution":
        case "practical solution":
        case "proposal":
        case "solutions":
        case "proposals":
            return "proposal"
        default:
            return undefined
    }
}

export function parsePlanMarkdown(content: string): Record<PlanSection, string> {
    const result = emptyPlanSections()
    const lines = content.split(/\r?\n/)
    let current: PlanSection | undefined
    let inFence = false

    for (const line of lines) {
        if (/^(```|~~~)/.test(line.trim())) {
            inFence = !inFence
        }

        if (!inFence) {
            if (/^---\s*$/.test(line.trim())) {
                continue
            }

            const section = parseSectionHeading(line)
            if (section) {
                current = section
                continue
            }
        }

        if (current) {
            result[current] = result[current] ? `${result[current]}\n${line}` : line
        }
    }

    for (const section of planSections) {
        result[section] = result[section].trim()
    }

    return result
}

async function resolveWritablePlan(fileSystem: FileSystem, worktree: string, job: string) {
    const existing = await findExistingJobFile(fileSystem, worktree, job, "plan.md")
    if (existing) {
        if (existing.directory !== "drafts") {
            if (!isPlanJobDirectory(existing.directory)) {
                throw new Error(`Unsupported plan directory: ${existing.directory}`)
            }

            return {
                sections: parsePlanMarkdown(existing.content),
                filePath: getPlanPath(worktree, job, existing.directory),
                relativePath: existing.path,
                status: undefined,
            }
        }

        return {
            sections: parsePlanMarkdown(existing.content),
            filePath: getPlanPath(worktree, job, existing.directory),
            relativePath: existing.path,
            status: "drafts" as JobStatus,
        }
    }

    return {
        sections: emptyPlanSections(),
        filePath: getPlanPath(worktree, job),
        relativePath: getRelativePlanPath(job),
        status: "drafts" as JobStatus,
    }
}

type PlanSaveArgs = {
    problem?: string
    observation?: string
    impact?: string
    expectation?: string
    problems?: string
    requirements?: string
    constraints?: string
    proposal?: string
}

async function createOrResolvePlanTarget(fileSystem: FileSystem, client: OpencodeClient | undefined, context: { worktree: string, sessionID: string, directory: string }): Promise<{
    jobName: string
    filePath: string
    existingSections?: PlanSections
    status?: JobStatus
}> {
    const sessionTitle = await getCurrentSessionTitle(client, context)
    if (!sessionTitle.title) {
        throw new Error(sessionTitle.warning ?? "Unable to resolve the current session title.")
    }

    const jobName = deriveJobNameFromTitle(sessionTitle.title)
    if (!jobName) {
        throw new Error(`Unable to derive a valid job_name from the current session title: ${sessionTitle.title}`)
    }

    const writablePlan = await resolveWritablePlan(fileSystem, resolveAgentsStorageRoot(context), jobName)

    return {
        jobName,
        filePath: writablePlan.filePath,
        existingSections: writablePlan.sections,
        status: writablePlan.status,
    }
}

function normalizePlanToolArgs(clientOrFileSystem?: OpencodeClient | FileSystem, maybeFileSystem?: FileSystem): { client?: OpencodeClient, fileSystem: FileSystem } {
    if (maybeFileSystem) {
        return { client: clientOrFileSystem as OpencodeClient | undefined, fileSystem: maybeFileSystem }
    }

    const candidate = clientOrFileSystem as FileSystem | OpencodeClient | undefined
    if (candidate && "readFile" in candidate && "writeFile" in candidate) {
        return { fileSystem: candidate as FileSystem }
    }

    return { client: candidate as OpencodeClient | undefined, fileSystem: defaultFileSystem }
}

export function createAutocodeJobDraftTool(clientOrFileSystem?: OpencodeClient | FileSystem, maybeFileSystem?: FileSystem) {
    const { client, fileSystem } = normalizePlanToolArgs(clientOrFileSystem, maybeFileSystem)
    return tool({
        description: "Create or update plan.md for a planned job.",
        args: {
            problems: tool.schema.string().optional().describe(planSectionContentDescriptions.problems),
            impact: tool.schema.string().optional().describe(planSectionContentDescriptions.impact),
            expectations: tool.schema.string().optional().describe(planSectionContentDescriptions.expectations),
            requirements: tool.schema.string().optional().describe(planSectionContentDescriptions.requirements),
            constraints: tool.schema.string().optional().describe(planSectionContentDescriptions.constraints),
            proposal: tool.schema.string().optional().describe(planSectionContentDescriptions.proposal),
        },
        async execute(args, context) {
            const hasAnyContent = [args.problems, args.impact, args.expectations, args.requirements, args.constraints, args.proposal]
                .some((value) => value !== undefined)
            if (!hasAnyContent) {
                return createRetryResponse(
                    "save plan",
                    "Missing required plan content",
                    "Provide at least one of: problems, impact, expectations, requirements, constraints, proposal."
                )
            }

            try {
                const planTarget = await createOrResolvePlanTarget(fileSystem, client, context)
                const sections = getPlanSaveSections(args, planTarget.existingSections)

                await fileSystem.mkdir?.(path.dirname(planTarget.filePath), { recursive: true })
                await fileSystem.writeFile(planTarget.filePath, composePlanMarkdown(sections))
                await updateCurrentSessionTitleToJobName(client, context, planTarget.jobName)

                return JSON.stringify({
                    job_name: planTarget.jobName,
                    job_path: planTarget.filePath,
                })
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                if (message.startsWith("Unable to derive a valid job_name from the current session title:")) {
                    return createRetryResponse("save plan", message, "Rename the current session to include letters or numbers, then save the plan again.")
                }
                if (message.startsWith("Planned job lifecycle collision:")) {
                    return createRetryResponse("save plan", message, "Resolve the duplicate active lifecycle directories for this job before saving the plan.")
                }
                if (message.startsWith("Unable to read current session title:")) {
                    return createRetryResponse("save plan", message, "Retry after the current session title is available.")
                }

                return createAbortResponse("save plan", error)
            }
        },
    })
}
