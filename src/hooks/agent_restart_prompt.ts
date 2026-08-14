import type { PrimaryAutocodeAgent } from "@/utils/agent_swap"

export type AgentRestartPromptInput = {
    currentAgent: PrimaryAutocodeAgent
    targetAgent: PrimaryAutocodeAgent
    jobPlan?: {
        jobName: string
        plan: string
    }
}

const RESTART_SAME_AGENT_PROMPT = "Continue"
const RESTART_DESIGN_PROMPT = "Design solution to improve project."
export const RESTART_ASSIST_PROMPT = "Continue with most urgent unblocked GOAL as next ASSIGNMENT."
export const RESTART_AUTO_PROMPT = "Autonomously meet all user REQUIREMENTS."
export const RESTART_ADVISE_PROMPT = "Research possibilities regarding recent discussion and continue manual practice guidance without project implementation."

const restartPromptByTarget: Record<PrimaryAutocodeAgent, string> = {
    assist: RESTART_ASSIST_PROMPT,
    advise: RESTART_ADVISE_PROMPT,
    auto: RESTART_AUTO_PROMPT,
    design: RESTART_DESIGN_PROMPT,
}

export function createAgentRestartPrompt(input: AgentRestartPromptInput): string {
    if (input.targetAgent === "assist" || input.targetAgent === "auto") {
        if (input.jobPlan) {
            return `Selected job: ${input.jobPlan.jobName}\n\nplan.md:\n${input.jobPlan.plan}`
        }

        return input.targetAgent === "assist" ? RESTART_ASSIST_PROMPT : RESTART_AUTO_PROMPT
    }

    if (input.currentAgent === input.targetAgent) {
        return RESTART_SAME_AGENT_PROMPT
    }

    return restartPromptByTarget[input.targetAgent]
}
