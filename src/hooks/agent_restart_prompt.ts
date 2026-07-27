import { jobExecuteAssistCommandTemplate } from "@/commands/job-execute_assist"
import { jobExecuteAutoCommandTemplate } from "@/commands/job-execute_auto"
import type { PrimaryAutocodeAgent } from "@/utils/agent_swap"

export type AgentRestartPromptInput = {
    currentAgent: PrimaryAutocodeAgent
    targetAgent: PrimaryAutocodeAgent
}

const SAME_AGENT_RESTART_PROMPT = "Continue from compacted context."
const RESEARCH_RESTART_PROMPT = "Find answer to user's question or discover possibilities to improve project regarding discovered problem."
const DESIGN_RESTART_PROMPT = "Design solution to solve discovered problem."

const restartPromptByTarget: Record<PrimaryAutocodeAgent, string> = {
    assist: jobExecuteAssistCommandTemplate,
    auto: jobExecuteAutoCommandTemplate,
    design: DESIGN_RESTART_PROMPT,
    research: RESEARCH_RESTART_PROMPT,
}

export function createAgentRestartPrompt(input: AgentRestartPromptInput): string {
    if (input.currentAgent === input.targetAgent) {
        return SAME_AGENT_RESTART_PROMPT
    }

    return restartPromptByTarget[input.targetAgent]
}
