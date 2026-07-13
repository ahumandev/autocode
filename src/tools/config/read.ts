import { tool } from "@opencode-ai/plugin"
import { readFile } from "fs/promises"
import { configRead, formatPath, getParser, parseKeyPath, resolvePath } from "./shared/core"
import { configModeFromExtension } from "./shared/adapter"
import { createRetryResponse } from "@/utils/tools"
import { expandGlob } from "@/utils/glob"

export function createAutocodeConfigReadTool() {
  return tool({
    description: "Read local config/data files (.json/.jsonc/.yaml/.yml/.toml/.ini/.properties/.conf/.env) by glob pattern. Outlines config/data file or drills into specific key_path.",
    args: {
      glob: tool.schema.string().describe("Glob pattern for config files, e.g. 'configs/**/*.json' or 'package.json'."),
      key_path: tool.schema.string().optional().describe("Optional dotted path with bracket array indexing (e.g. 'server.port', 'ports[0]', 'grid[1][2]') to drill into a specific key. Default = root."),
      key_depth: tool.schema.number().int().min(0).optional().default(100).describe("Maximum traversal depth from key_path."),
      subkey_pattern: tool.schema.string().optional().describe("Regex; include nodes whose key path has any segment matching it. Default = all."),
      value_pattern: tool.schema.string().optional().describe("Regex; include leaf nodes whose value matches it. Default = all."),
      max_keys: tool.schema.number().int().min(0).optional().default(40).describe("Cap on total output nodes across all matching files."),
      max_value_chars: tool.schema.number().int().min(0).optional().default(40).describe("Truncate string values exceeding max chars by appending '...'"),
    },
    execute: async (args) => {
      const failedAction = "Read configuration file"

      if (typeof args.glob !== "string" || args.glob.length === 0) {
        return createRetryResponse(failedAction, new Error("glob required"), "Provide a glob pattern.")
      }

      let subkeyPattern: RegExp | undefined
      let valuePattern: RegExp | undefined
      try {
        subkeyPattern = args.subkey_pattern ? new RegExp(args.subkey_pattern) : undefined
        valuePattern = args.value_pattern ? new RegExp(args.value_pattern) : undefined
      } catch (error) {
        return createRetryResponse(failedAction, error, "Fix the regex pattern.")
      }

      const matches = await expandGlob(String(args.glob))
      if (matches.length === 0) {
        return createRetryResponse(failedAction, new Error("no files matched glob: " + args.glob), "Check the glob pattern and path.")
      }

      const file_paths: Record<string, { key_paths: Record<string, string | null>; nodes_shown: number; nodes_total: number }> = {}

      for (const { key, absolute } of matches) {
        const mode = configModeFromExtension(absolute)
        if (!mode || mode === "markdown") continue

        let raw: string
        try {
          raw = await readFile(absolute, "utf8")
        } catch {
          continue
        }

        const parser = getParser(mode)
        let value: unknown
        try {
          value = parser.parse(raw)
        } catch {
          continue
        }

        if (args.key_path) {
          const keyPath = parseKeyPath(args.key_path)
          if (keyPath === null) continue
          const resolved = resolvePath(value, keyPath)
          if (!resolved.found) continue
          value = resolved.value
        }

        const result = configRead(value, {
          keyDepth: args.key_depth ?? 100,
          subkeyPattern,
          valuePattern,
          maxKeys: args.max_keys ?? 40,
          maxValueChars: args.max_value_chars ?? 40,
        })

        const key_paths: Record<string, string | null> = {}
        for (const node of result.nodes) {
          key_paths[formatPath(node.path)] = node.value
        }

        file_paths[key] = {
          key_paths,
          nodes_shown: result.nodesShown,
          nodes_total: result.nodesTotal,
        }
      }

      if (Object.keys(file_paths).length === 0) {
        return createRetryResponse(failedAction, new Error("no readable config files for glob: " + args.glob), "Check the glob pattern and file formats.")
      }

      return JSON.stringify({ file_paths })
    },
  })
}
