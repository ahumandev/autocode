import { tool } from "@opencode-ai/plugin"
import { createLocalConfigAdapter } from "./config/adapter"
import { configRemoveFlow } from "./config/core"

const configPathSchema = tool.schema.string()

export function createAutocodeConfigRemoveTool() {
  return tool({
    description: "Remove key with subtree and values from config file (.json/.jsonc/.yaml/.yml/.toml/.ini/.properties/.conf/.env).",
    args: {
      file_path: tool.schema.string().describe("Exact path to file."),
      key_path: configPathSchema.describe("Dotted key path with bracket array indexing (e.g. 'server.port', 'ports[0]', 'grid[1][2]') of the key to remove."),
    },
    execute: (args, context) => configRemoveFlow(createLocalConfigAdapter(context), args as Record<string, unknown>),
  })
}
