import { tool, type ToolContext } from "@opencode-ai/plugin"
import { createAbortResponse } from "@/utils/tools"
import { inspectAutocodeDependencies } from "@/utils/autocode_dependencies"
import { defaultSandboxDependencies, type SandboxDependencies } from "@/utils/sandbox"

export function createAutocodeDependenciesTool(deps: SandboxDependencies = defaultSandboxDependencies): ReturnType<typeof tool> {
    return tool({
        description: "Detect Autocode runtime dependencies for initialization. Detect-only: never upgrades OpenCode or installs packages.",
        args: {},
        async execute(_args: Record<string, never>, context: ToolContext): Promise<string> {
            try {
                return JSON.stringify(await inspectAutocodeDependencies(deps, { directory: context?.directory, worktree: context?.worktree }))
            }
            catch (error) {
                return createAbortResponse("detect dependencies", error)
            }
        },
    })
}
