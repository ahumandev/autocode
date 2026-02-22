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
import { buildPrompt } from "./prompts/build"
import { orchestratePrompt } from "./prompts/orchestrate"
import { executePrompt } from "@/agents/prompts/execute";

type AgentMap = Record<string, {
    color?: string
    description?: string
    mode?: "subagent" | "primary" | "all"
    prompt?: string
    permission?: Record<string, unknown>
    [key: string]: unknown
}>

/**
 * blue = planning/researching agents
 * red = modifiers
 * green = test agents
 */
export const agents: AgentMap = {

    plan: {
        color: "#4040FF",
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

    build: {
        color: "#FF4040",
        description: "Build autocode tasks from approved plans with ordered directories and prompt files",
        hidden: false,
        mode: "primary",
        permission: {
            "*": "deny",
            "autocode_build*": "allow",
            question: "allow"
        },
        prompt: buildPrompt,
    },

    /**
     * Orchestrate: drives plan task execution in the correct sequential/concurrent order.
     * Spawned by the build agent after plan creation.
     * Only allowed to call autocode_orchestrate_* tools — no direct filesystem access.
     */
    "build/orchestrate": {
        color: "#FF8040",
        description: "Orchestrate plan task execution — runs tasks in order, concurrently where possible",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "deny",
            "autocode_orchestrate*": "allow",
        },
        prompt: orchestratePrompt,
    },

    "build/execute": {
        color: "#FFFF40",
        description: "Execute a task",
        hidden: true,
        mode: "subagent",
        permission: {
            "*": "allow",
            "autocode*": "deny",
            "general": "deny",
            "plan": "deny",
            "todo*": "deny",
            "autocode_execute*": "allow",
            "document/*": "deny"
        },
        prompt: executePrompt,
    },

    verify: {
        color: "#40FF40",
        description: "Verify the build solution",
        hidden: true
    },

    /**
     * Interfering Opencode agents
     */
    general: {
        disable: true
    },

}
