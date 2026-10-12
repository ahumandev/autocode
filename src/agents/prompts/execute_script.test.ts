import { describe, expect, test } from "bun:test"
import { executeScriptPrompt } from "./execute_script"

describe("executeScriptPrompt", () => {
    test("requires ordered managed script workflow", () => {
        const workflow = [
            "### STEP 1: Understand Requirements",
            "1. Stay in original project context.",
            "### STEP 2: Set Up Script Project",
            "Call `autocode_script_project` before authoring.",
            "After setup, read `<context.directory>/.opencode/autocode/scripts/AGENTS.md` before managed work; follow its authoritative shared rules.",
            "Use returned `source_path` for job sources; final job directory is `YY-MM-DD_hh-mm-ss_{job_name}` with zero-padded 24-hour UTC timestamp and one underscore before sanitized job name; never build an unprefixed job path.",
            "Tool descriptions define arguments.",
            "### STEP 3: Add or Repair Dependencies When Needed",
            "If needed, call `autocode_script_install`; skip routine installs.",
            "### STEP 4: Reuse or Author Script",
            "Prefer existing script enhancing over reinvention.",
            "### STEP 5: Run Managed Work",
            "Call `autocode_script_run` or `autocode_script_service`.",
            "### STEP 6: Report and Clean Up",
            "Explicitly stop owned services when done or no longer needed",
        ]
        let previousPosition = -1

        for (const rule of workflow) {
            const position = executeScriptPrompt.indexOf(rule)
            expect(position).toBeGreaterThan(previousPosition)
            previousPosition = position
        }

        for (const toolName of ["autocode_script_project", "autocode_script_install", "autocode_script_run", "autocode_script_service"]) {
            expect(executeScriptPrompt.split(`\`${toolName}\``)).toHaveLength(2)
        }
        expect(executeScriptPrompt).toContain("For repair-needed errors, return to STEP 3 before retrying.")
    })

    test("routes managed-work rules to authoritative guidance without duplicate descriptions", () => {
        expect(executeScriptPrompt).toContain("read `<context.directory>/.opencode/autocode/scripts/AGENTS.md` before managed work; follow its authoritative shared rules.")
        for (const duplicate of [
            "same-cwd jobs",
            "normalized session titles",
            "`package.json`",
            "`node_modules`",
            "`dependencies`",
            "`upgrade`",
            "`argv`",
            "`timeout_ms`",
            "`run_id`",
            "NODE_PATH",
            "--ignore-scripts",
            "shell:false",
            "job-source-relative",
            "autocode_kill",
            "autocode_process_kill",
            "`pty*`",
            "sandbox CLI",
        ]) {
            expect(executeScriptPrompt).not.toContain(duplicate)
        }
        expect(executeScriptPrompt).not.toMatch(/Linux[- ]only/i)
    })
})
