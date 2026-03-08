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

import { browserPrompt } from "./prompts/browser"
import { buildPrompt } from "./prompts/build"
import { executePrompt } from "./prompts/execute";
import { orchestratePrompt } from "./prompts/orchestrate"
import { planPrompt } from "./prompts/plan"

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

    report: {
        color: "#FFFFFF",
        description: "Read-only query agent generate reports for the user",
        mode: "primary",
        permission: {
            "*": "deny",
            doom_loop: "ask",
            grep: "allow",
            plan_enter: "allow",
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
        }
    },

    plan: {
        color: "#40FFFF",
        description: "Interactive Planning - Interview user, research problem, and create implementation plans",
        mode: "primary",
        permission: {
            "*": "deny",
            "autocode_analyze*": "allow",
            doom_loop: "ask",
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
                report: "deny",
                test: "deny",
                troubleshoot: "deny",
            },
            "todo*": "allow",
            webfetch: "allow",
        },
        prompt: planPrompt,
    },

    explore: {
        color: "#40A0FF",
        hidde: true,
        mode: "subagent",
    },

    websearch: {
        color: "#4060FF",
        hidde: true,
        mode: "subagent",
    },

    build: {
        color: "#4040FF",
        description: "Build autocode tasks from approved plans with ordered directories and prompt files",
        hidden: false, // "false" required by Plannotator
        mode: "primary",
        permission: {
            "*": "deny",
            "autocode_build*": "allow",
            doom_loop: "ask",
            plan_enter: "allow",
            question: "allow"
        },
        prompt: buildPrompt,
    },

    /**
     * Orchestrate: drives plan task execution in the correct sequential/concurrent order.
     * Spawned by the build agent after plan creation.
     * Only allowed to call autocode_orchestrate_* tools — no direct filesystem access.
     */
    "orchestrate": {
        color: "#FF40A0",
        description: "Orchestrate plan task execution — runs tasks in order, concurrently where possible",
        hidden: true,
        mode: "primary",
        permission: {
            "*": "deny",
            "autocode_orchestrate*": "allow",
            doom_loop: "ask",
        },
        prompt: orchestratePrompt,
    },

    "execute": {
        color: "#FF4040",
        description: "Execute a task",
        hidden: false,
        mode: "primary",
        permission: {
            "*": "allow",
            "autocode*": "deny",
            doom_loop: "ask",
            general: "deny",
            plan: "deny",
            task: {
                "*": "allow",
                "build": "deny",
                "document/*": "deny",
                "general": "deny",
                "plan": "deny",
                "report": "deny",
            }
        },
        prompt: executePrompt,
    },

    os: {
        color: "#FF6040",
        hidden: true,
        mode: "subagent",
    },

    code: {
        color: "#FF6040",
        hidden: true,
        mode: "subagent",
    },

    excel: {
        color: "#FF6040",
        hidden: true,
        mode: "subagent",
    },

    git: {
        color: "#FF6040",
        hidden: true,
        mode: "subagent",
    },

    troubleshoot: {
        color: "#FFA040",
        hidden: true,
        mode: "subagent",
    },

    document: {
        color: "#FFFF40",
        hidden: true,
        mode: "subagent",
    },

    md: {
        color: "#A0FF40",
        hidden: true,
        mode: "subagent",
    },

    test: {
        color: "#00FF00",
        description: "Test the system.",
        mode: "all"
    },

    browser: {
        color: "#40FFA0",
        description: "Use this agent for frontend development & testing - Debug, test and verify YOUR RUNNING APPLICATION: inspect DOM elements, read console logs, analyze network requests, click UI elements, test performance and automate frontend testing. NOT for online research nor internet searches.",
        hidden: true,
        mode: "subagent",
        permission: {
            '*': "deny",
            "chrome*": "allow",
            "doom_loop": "ask",
            "todo*": "allow"
        },
        prompt: browserPrompt
    },

    /**
     * Interfering Opencode agents
     */
    general: {
        disable: true
    },

}
