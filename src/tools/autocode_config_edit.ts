import { tool } from "@opencode-ai/plugin"
import { createLocalConfigAdapter } from "./config/adapter"
import { configEditFlow } from "./config/core"

const configPathSchema = tool.schema.string()

export function createAutocodeConfigEditTool() {
  return tool({
    description: "Create, replace, or rename key-values in local config files (.json/.jsonc/.yaml/.yml/.toml/.ini/.properties/.conf/.env).",
    args: {
      file_path: tool.schema.string().describe("Exact path to file."),
      current_key: configPathSchema.optional().describe("Existing dotted key path with bracket array indexing (e.g. 'server.port', 'ports[0]', 'grid[1][2]') to operate on. If omitted, a new_key required to CREATE."),
      new_key: configPathSchema.optional().describe("Target dotted key path with bracket array indexing to RENAME from current_key or CREATE if current_key is omitted."),
      content: tool.schema.union([
        tool.schema.string(),
        tool.schema.number(),
        tool.schema.boolean(),
        tool.schema.null(),
        tool.schema.array(tool.schema.unknown()),
        tool.schema.object({}).loose()
      ]).optional().describe("New/Replacement value. Accepts string, number, boolean, null, array, or object. String are saved as literal string. Non-string scalars and arrays/objects are stored as-is. Potentially replace entire subtree of nodes if file_path referred non-leaf node."),
      new_index: tool.schema.number().int().optional().describe("Position when inserting into arrays: 0=first, -1=last/append, N=nth. Ignored for object keys."),
    },
    execute: (args, context) => configEditFlow(createLocalConfigAdapter(context), args as Record<string, unknown>),
  })
}
