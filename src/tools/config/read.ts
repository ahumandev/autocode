import { tool } from "@opencode-ai/plugin"
import { readFile } from "fs/promises"
import { configRead, formatPath, getParser, parseKeyPath, resolvePath } from "./shared/core"
import { configModeFromExtension } from "./shared/adapter"
import { createRetryResponse } from "@/utils/tools"
import { expandGlob } from "@/utils/glob"

export function createAutocodeConfigReadTool() {
  return tool({
    description: "Grep find values in local config/data files (.json/.jsonc/.yaml/.yml/.toml/.ini/.properties/.conf/.env) or read config/data files by glob pattern.",
    args: {
      file_path_glob: tool.schema.string().describe("Glob pattern for config files, e.g. 'configs/**/*.json' or 'package.json'."),
      key_path: tool.schema.string().optional().describe("Optional dotted path with bracket array indexing (e.g. 'server.port', 'ports[0]', 'grid[1][2]') to drill into a specific key. Default = root."),
      key_depth: tool.schema.number().int().min(0).optional().default(100).describe("Maximum traversal depth from key_path. Default = 100."),
      subkey_regex: tool.schema.string().optional().describe("Regex; find nodes with matching key paths. Default = all."),
      value_regex: tool.schema.string().optional().describe("Regex; find leaf nodes with matching values. Default = all."),
      max_keys: tool.schema.number().int().min(0).optional().default(40).describe("Cap on total output nodes across all matching files. Default = 40."),
      max_value_chars: tool.schema.number().int().min(0).optional().default(40).describe("Truncate string values exceeding max_value_chars by appending '...'. Default = 40."),
    },
    execute: async (args, context) => {
      const failedAction = "Read configuration file"

      if (typeof args.file_path_glob !== "string" || args.file_path_glob.length === 0) {
        return createRetryResponse(failedAction, new Error("glob required"), "Provide a glob pattern.")
      }

      let subkeyPattern: RegExp | undefined
      let valuePattern: RegExp | undefined
      try {
        subkeyPattern = args.subkey_regex ? new RegExp(args.subkey_regex) : undefined
        valuePattern = args.value_regex ? new RegExp(args.value_regex) : undefined
      } catch (error) {
        return createRetryResponse(failedAction, error, "Fix the regex pattern.")
      }

      const cwd = context.directory ?? process.cwd()
      const matches = await expandGlob(String(args.file_path_glob), cwd)
      if (matches.length === 0) {
        return createRetryResponse(failedAction, new Error("no files matched glob: " + args.file_path_glob), "Check the glob pattern and path.")
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
        return createRetryResponse(failedAction, new Error("no readable config files for glob: " + args.file_path_glob), "Check the glob pattern and file formats.")
      }

      return JSON.stringify({ file_paths })
    },
  })
}
