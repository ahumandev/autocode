import { describe, expect, test } from "bun:test"
import { executeScriptPrompt } from "./execute_script"

describe("executeScriptPrompt", () => {
    test("requires ordered managed script workflow", () => {
        const workflow = [
            "### STEP 1: Understand Requirements",
            "1. Stay in original project context.",
            "### STEP 2: Set Up Script Project",
            "Before authoring a script, call `autocode_script_project` with requested npm package names mapped to version ranges.",
            "`autocode_script_project` and `autocode_script_install` manage package setup; use returned paths to set up scripts.",
            "### STEP 3: Install Dependencies",
            "After any `package.json` or dependency manifest edit, call `autocode_script_install` before execution.",
            "### STEP 4: Reuse or Author Script",
            "Prefer existing script enhancing over reinvention.",
            "Built-in file tools author scripts only under `source_path` provided by `autocode_script_project` output.",
            "### STEP 5: Run Managed Work",
            "Use `autocode_script_run` to execute finite scripts only.",
            "Use `autocode_script_service` to manage long-lived processes; use `action=start` only to start them.",
            "### STEP 6: Report and Clean Up",
            "Explicitly stop an owned service when no longer needed.",
        ]
        let previousPosition = -1

        for (const rule of workflow) {
            const position = executeScriptPrompt.indexOf(rule)
            expect(position).toBeGreaterThan(previousPosition)
            previousPosition = position
        }

        expect(executeScriptPrompt).not.toContain("AGENTS.md")
    })

    test("forbids every direct execution bypass", () => {
        for (const rule of [
            "Bash is not required and is not allowed. Never use direct bash, shell, Node, or process spawning.",
            "Never use `pty*`, sandbox CLI or tools, generic process-kill tools, `autocode_kill`, or `autocode_process_kill`.",
            "`task_external` is not default, is denied here, and must never be called or described as sandboxing.",
            "Never set or instruct `NODE_PATH`; use standard Node resolution only.",
        ]) {
            expect(executeScriptPrompt).toContain(rule)
        }
    })
})
