/**
 * Agent definitions for the Autocode plugin.
 *
 * Agents are registered programmatically via the `config` hook so they are
 * self-contained in the npm package — no Markdown files need to be copied or
 * referenced from the filesystem by the end user.
 *
 * The `.opencode/agent/` files in this repo are the LOCAL DEV equivalent —
 * opencode loads them from disk when running from the project root.
 * When deployed as a npm package, only this file is used.
 *
 * Prompts are stored in separate files under `./prompts/` for maintainability.
 */

import { planPrompt } from "./prompts/plan"
import { toets2Prompt } from "./prompts/toets2"

type AgentMap = Record<string, {
    color?: string
    description?: string
    mode?: "subagent" | "primary" | "all"
    prompt?: string
    permission?: Record<string, unknown>
    [key: string]: unknown
}>

export const agents: AgentMap = {
    toets2: {
        color: "#DF20DF",
        description: "Toets",
        mode: "primary",
        permission: {
            "*": "deny",
            "spawn_session": "allow",
        },
        prompt: toets2Prompt,
    },
    plan: {
        color: "#DF20DF",
        description: "Interactive Planning - Interview user, research problem, and create implementation plans",
        mode: "primary",
        permission: {
            "*": "deny",
            "autocode_analyze*": "allow",
            doom_loop: "allow",
            grep: "allow",
            plan_exit: "allow",
            question: "allow",
            read: "allow",
            submit_plan: "allow",
            task: {
                "*": "allow",
                analyze: "deny",
                build: "deny",
                code: "deny",
                "document*": "deny",
                human: "deny",
                md: "deny",
                test: "deny",
                troubleshoot: "deny",
            },
            "todo*": "allow",
            webfetch: "allow",
        },
        prompt: planPrompt,
    },
}
