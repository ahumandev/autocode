import { Plugin, PluginInput } from "@opencode-ai/plugin"
import { createSessionTools } from "./tools/session"
import { createAnalyzeTools } from "./tools/analyze"
import { createBuildTools } from "./tools/build"
import { commands } from "./commands"
import { agents } from "./agents"
import { initAutocode } from "./setup"

/**
 * Autocode Plugin for OpenCode.
 *
 * Add to your opencode.jsonc:
 *   { "plugin": ["@autocode-ai/plugin"] }
 *
 * Or during local development via a file:// reference:
 *   { "plugin": ["file:///path/to/autocode/dist/plugin.js"] }
 */
const autocode: Plugin = async (input: PluginInput) => {
    // Ensure .autocode/ directory structure exists in the user's project on startup.
    // Uses input.worktree (the actual project root) rather than process.cwd().
    // This is idempotent — existing directories and files are preserved.
    await initAutocode(input.worktree).catch((err) => {
        console.warn("[autocode] Failed to initialize .autocode/ directory:", err)
    })

    return {
        // Inject commands into the live config object before Command.state initializes.
        // This is equivalent to shipping markdown files in {command,commands}/ —
        // but self-contained in the npm package with no filesystem dependency.
        async config(cfg) {
            cfg.command = { ...commands, ...cfg.command }

            // Merge plugin agents into the config so that:
            // 1. Plugin agents are available even when the user has no agent config
            // 2. User-configured agent properties override plugin defaults (per-key)
            // 3. Plugin agents can override built-in agents (e.g. the built-in "plan")
            //    via opencode's Agent.state() merge loop, which applies cfg.agent entries
            //    on top of built-ins using nullish coalescing for most fields, and
            //    PermissionNext.merge() (last-wins via findLast) for permissions.
            //
            // We use per-agent spreading so a user's partial agent config (e.g. just
            // overriding `model`) doesn't silently discard the plugin's prompt/permissions.
            if (!cfg.agent) cfg.agent = {}
            for (const [name, agentDef] of Object.entries(agents)) {
                cfg.agent[name] = { ...agentDef, ...cfg.agent[name] }
            }
        },

        tool: {
            ...createSessionTools(input.client),
            ...createAnalyzeTools(input.client),
            ...createBuildTools(input.client),
        },
    }
}

export default autocode
