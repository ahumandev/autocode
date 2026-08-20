import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { cleanupEmptyJobSandboxRoot, cleanupJobSandboxes, defaultSandboxDependencies, deleteSandboxPath, normalizeSandboxName, resolveSandboxOwner, type SandboxDependencies } from "@/utils/sandbox"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"
import { pathExists } from "@/utils/autocode_sandbox_helpers"

const limitationGuidance = "Sandbox cleanup removes bubblewrap sandbox storage directories; legacy proot metadata is not removed through proot-distro."

export function createAutocodeSandboxDeleteTool(client?: OpencodeClient, deps: SandboxDependencies = defaultSandboxDependencies) {
    return tool({
        description: "Delete one sandbox or all sandboxes in current resolved job only. The owner resolves exact linked session first; otherwise newest job workspace matching current session-title slug. Missing owner errors before deletion. Sandboxes are job-local at `.agents/jobs/YYYY-MM-DD_hh-mm-ss_{title_dir}/sandboxes/{sandbox_name}`. MUST run when finish with sandbox and all `execute_sandbox` tasks have completed.",
        args: {
            sandbox_name: tool.schema.string().optional().describe("Sandbox name inside current resolved job to delete. Same names in other jobs are independent. Omit to delete all sandboxes in current resolved job only."),
        },
        async execute(args, context) {
            const rawName = typeof args.sandbox_name === "string" ? args.sandbox_name.trim() : undefined
            const sandboxName = rawName ? normalizeSandboxName(rawName) : undefined
            if (sandboxName && !sandboxName.ok) return createRetryResponse("delete sandbox", sandboxName.reason, "Use lowercase letters, numbers, and underscores only, or omit sandbox_name to delete all.")

            try {
                if (!sandboxName) {
                    const owner = await resolveSandboxOwner(deps.fileSystem, client, context)
                    if (!owner.ok) return createRetryResponse("delete sandbox", owner.reason, "Start or select a timestamped job workspace before deleting sandboxes.")
                    return JSON.stringify(await cleanupJobSandboxes(owner.owner, deps))
                }

                const owner = await resolveSandboxOwner(deps.fileSystem, client, context, sandboxName.value)
                if (!owner.ok) return createRetryResponse("delete sandbox", owner.reason, "Start or select a timestamped job workspace before deleting sandboxes.")
                const paths = owner.owner
                if (!await pathExists(deps, paths.sandboxPath)) {
                    return JSON.stringify({ ok: true, status: "missing", sandbox_name: sandboxName.value, job_name: paths.jobName, guidance: limitationGuidance })
                }
                const result = await deleteSandboxPath(paths, deps)
                if (result.status !== "missing") await cleanupEmptyJobSandboxRoot(paths, deps)
                return JSON.stringify({ ok: result.status !== "warning", status: result.status, sandbox_name: sandboxName.value, job_name: paths.jobName, warning: result.warning, job_sandbox_root: paths.jobSandboxRoot, guidance: limitationGuidance })
            }
            catch (error) {
                return createAbortResponse("delete sandbox", error)
            }
        },
    })
}
