import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import type { Dirent } from "node:fs"
import path from "node:path"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"
import { activeJobLifecycleDirectories, completedJobLifecycleDirectory, deriveJobNameFromTitle, findExistingJobFile, getCurrentSessionTitle, getJobFilePath, getRelativeJobFilePath, resolveAgentsStorageRoot, updateCurrentSessionTitleToJobName, type ActiveJobLifecycleDirectory, type JobStatus } from "@/utils/jobs"

export const planSections = ["problems", "impact", "expectations", "requirements", "risks", "constraints", "proposal"] as const

export type PlanSection = typeof planSections[number]

type PlanSections = Record<PlanSection, string>

type SummaryMap = Record<string, string>

const planSectionContentDescriptions: Record<PlanSection, string> = {
    problems: "Define observed wrong/missing project behavior or missing info. Include exact key names, values, paths, codes, and user provided examples.",
    impact: "Define why problem matters. Describe affected user, system, or workflow impact.",
    expectations: "Define expected outcome from user perspective. Include target behavior or research goal.",
    requirements: `
Define 1 requirement per H3 subsection.
Define each requirement section as follows:
    - Every requirement must contain 1 or more clearly defined criteria (how to measure if requirement was meet)
    - Put each requirement's criteria in bullet point list in requirement sub-section body
    - Requirements may include input/output examples or technical key details like (names, keys, values, paths, codes, etc.)
    - Include all relevant examples, configs, quotes, acceptance details, and original user-request content inside the matching subsection body.
`,
    risks: "Define 1 assumed risk per H3 subsection",
    constraints: "Define 1 factual constraint per H3 subsection",
    proposal: `
Propose simplest approach to meet REQUIREMENTS within CONSTRAINTS:
    - Provide sequence of GOALS (planned project changes) according to PROPOSAL
    - Each GOAL must briefly describe overview of STEP to reach GOAL
    - Describe as high-level conceptual design instead of implementation details
    - Exception to rule is if user explicitly required a specific implementation then quote user's request exactly as quoted text
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
        risks: "",
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

## Risks

${sections.risks.trim()}

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

    return content.trim().replace(/^#{1,2}\s+(?:problem|problems|observation|observations|impact|impacts|expectation|expectations|requirements|constraints|risks|solution|proposed solution|proposal|proposals)\s*\n+/i, "").trim()
}

function getPlanSaveSections(args: PlanSaveArgs, existing: PlanSections | undefined): PlanSections {
    const nextSections = existing ? { ...existing } : emptyPlanSections()
    const providedSections: Array<[PlanSection, string | undefined]> = [
        ["problems", normalizePlanValue(args.problem ?? args.problems)],
        ["impact", normalizePlanValue(args.impact)],
        ["expectations", normalizePlanValue(args.expectation)],
        ["requirements", normalizePlanValue(args.requirements)],
        ["risks", normalizePlanValue(args.risks)],
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
        case "risk":
        case "risks":
        case "practical risks":
            return "risks"
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

function cleanSummaryTitle(value: string) {
    return value.trim().replace(/^#+\s*/, "").replace(/\s+#+\s*$/, "").replace(/^(?:REQ|CON|R)\d+[:.)-]?\s*/i, "").trim()
}

function extractPlanSummaryMap(content: string, prefix: "REQ" | "CON" | "R"): SummaryMap {
    const summaries: SummaryMap = {}
    const fallback: string[] = []
    const lines = content.split(/\r?\n/)
    let inFence = false

    for (const rawLine of lines) {
        const trimmed = rawLine.trim()
        if (/^(```|~~~)/.test(trimmed)) {
            inFence = !inFence
            continue
        }

        if (inFence) {
            continue
        }

        const heading = trimmed.match(/^###\s+(.+)$/)
        if (heading) {
            summaries[`${prefix}${Object.keys(summaries).length + 1}`] = cleanSummaryTitle(heading[1])
            continue
        }

        const fallbackLine = trimmed.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "").replace(new RegExp(`^${prefix}\\d+:\\s*`), "").trim().replace(/^['"]|['"]$/g, "")
        if (fallbackLine) {
            fallback.push(fallbackLine)
        }
    }

    if (Object.keys(summaries).length > 0) {
        return summaries
    }

    return Object.fromEntries(fallback.map((summary, index) => [`${prefix}${index + 1}`, summary]))
}

export function createPlanSummaryMaps(sections: Record<PlanSection, string>) {
    return {
        requirement_summaries: extractPlanSummaryMap(sections.requirements, "REQ"),
        constraint_summaries: extractPlanSummaryMap(sections.constraints, "CON"),
        risk_summaries: extractPlanSummaryMap(sections.risks, "R"),
    }
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
    risks?: string
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

export function createAutocodePlanSaveTool(clientOrFileSystem?: OpencodeClient | FileSystem, maybeFileSystem?: FileSystem) {
    const { client, fileSystem } = normalizePlanToolArgs(clientOrFileSystem, maybeFileSystem)
    return tool({
        description: "Create or update plan.md for a planned job.",
        args: {
            problems: tool.schema.string().optional().describe(planSectionContentDescriptions.problems),
            impact: tool.schema.string().optional().describe(planSectionContentDescriptions.impact),
            expectations: tool.schema.string().optional().describe(planSectionContentDescriptions.expectations),
            requirements: tool.schema.string().optional().describe(planSectionContentDescriptions.requirements),
            risks: tool.schema.string().optional().describe(planSectionContentDescriptions.risks),
            constraints: tool.schema.string().optional().describe(planSectionContentDescriptions.constraints),
            proposal: tool.schema.string().optional().describe(planSectionContentDescriptions.proposal),
        },
        async execute(args, context) {
            const hasAnyContent = [args.problems, args.impact, args.expectations, args.requirements, args.risks, args.constraints, args.proposal]
                .some((value) => value !== undefined)
            if (!hasAnyContent) {
                return createRetryResponse(
                    "save plan",
                    "Missing required plan content",
                    "Provide at least one of: problems, impact, expectations, requirements, risks, constraints, proposal."
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
