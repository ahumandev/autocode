import { tool } from "@opencode-ai/plugin"
import type { z } from "zod"
import { createLocalConfigAdapter } from "./config/adapter"
import { configEditFlow } from "./config/core"
import type { JsonValue } from "./config/types"

const configPathSchema = tool.schema.string()
const jsonValueSchema: z.ZodType<JsonValue> = tool.schema.json()

export function createAutocodeConfigEditTool() {
  return tool({
    description: "Create, replace, or rename key-values in local config files (.json/.jsonc/.yaml/.yml/.toml/.ini/.properties/.conf/.env).",
    args: {
      file_path: tool.schema.string().describe("Exact path to file."),
      current_key: configPathSchema.optional().describe("Existing dotted key path with bracket array indexing (e.g. 'server.port', 'ports[0]', 'grid[1][2]') to operate on. If omitted, a new_key required to CREATE."),
      new_key: configPathSchema.optional().describe("Target dotted key path with bracket array indexing to RENAME from current_key or CREATE if current_key is omitted."),
      content: jsonValueSchema.optional().describe("New/Replacement value. Accepts string, number, boolean, null, array, or object. String are saved as literal string. Non-string scalars and arrays/objects are stored as-is. Potentially replace entire subtree of nodes if file_path referred non-leaf node."),
      new_index: tool.schema.number().int().optional().describe("Position when inserting into arrays: 0=first, -1=last/append, N=nth. Ignored for object keys."),
    },
    execute: (args, context) => {
      const filePath = typeof args.file_path === "string" ? args.file_path : ""
      return configEditFlow(createLocalConfigAdapter(context), { ...args, file_path: filePath })
    },
  })
}
