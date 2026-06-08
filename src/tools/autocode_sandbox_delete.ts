import { tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { cleanupJobSandboxes, defaultSandboxDependencies, deleteSandboxPath, getJobSandboxRoot, getSandboxPaths, normalizeSandboxName, resolveSandboxJob, type SandboxDependencies } from "@/utils/sandbox"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"
import { pathExists } from "@/utils/autocode_sandbox_helpers"

const limitationGuidance = "Sandbox cleanup removes bubblewrap sandbox storage directories; legacy proot metadata is not removed through proot-distro."

export function createAutocodeSandboxDeleteTool(client?: OpencodeClient, deps: SandboxDependencies = defaultSandboxDependencies) {
    return tool({
        description: "Delete one or all sandboxes. MUST run when finish with sandbox and all `execute_sandbox` tasks have completed.",
        args: {
            sandbox_name: tool.schema.string().optional().describe("Sandbox to delete. Omit to delete all sandboxes."),
        },
        async execute(args, context) {
            const rawName = typeof args.sandbox_name === "string" ? args.sandbox_name.trim() : undefined
            const sandboxName = rawName ? normalizeSandboxName(rawName) : undefined
            if (sandboxName && !sandboxName.ok) return createRetryResponse("delete sandbox", sandboxName.reason, "Use lowercase letters, numbers, and underscores only, or omit sandbox_name to delete all.")

            try {
                const job = await resolveSandboxJob(client, context, deps.fileSystem)
                if (!job.ok) return createRetryResponse("delete sandbox", job.reason, "Start or select a planned lifecycle job before deleting sandboxes.")
                if (!sandboxName) {
                    return JSON.stringify(await cleanupJobSandboxes(job.storageRoot, job.jobName, deps))
                }

                const paths = getSandboxPaths(job.storageRoot, job.jobName, sandboxName.value)
                if (!await pathExists(deps, paths.sandboxPath)) {
                    return JSON.stringify({ ok: true, status: "missing", sandbox_name: sandboxName.value, job_name: job.jobName, guidance: limitationGuidance })
                }
                const result = await deleteSandboxPath(paths, deps)
                return JSON.stringify({ ok: result.status !== "warning", status: result.status, sandbox_name: sandboxName.value, job_name: job.jobName, warning: result.warning, job_sandbox_root: getJobSandboxRoot(job.storageRoot, job.jobName), guidance: limitationGuidance })
            }
            catch (error) {
                return createAbortResponse("delete sandbox", error)
            }
        },
    })
}
