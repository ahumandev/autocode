import { tool } from "@opencode-ai/plugin"
import type { SshToolDeps } from "../../autocode_ssh"
import { createRemoteConfigExecute } from "./adapter"
import { configEditFlow } from "../shared/core"

const configPathSchema = tool.schema.string()

export function createAutocodeSshConfigEditTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: "Create, replace, or rename key-values in remote config files (.json/.jsonc/.yaml/.yml/.toml/.ini/.properties/.conf/.env) over SSH/SFTP.",
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            path: tool.schema.string().describe("Absolute path on remote file system to config file."),
            current_key: configPathSchema.optional().describe("Existing dotted key path with bracket array indexing (e.g. 'server.port', 'ports[0]', 'grid[1][2]') to operate on. If omitted, a new_key must be given (CREATE)."),
            new_key: configPathSchema.optional().describe("Target key path with bracket array indexing (e.g. 'server.port', 'ports[0]', 'grid[1][2]') for RENAME or CREATE. Must not already exist."),
            content: tool.schema.union([
                tool.schema.string(),
                tool.schema.number(),
                tool.schema.boolean(),
                tool.schema.null(),
                tool.schema.array(tool.schema.unknown()),
                tool.schema.object({}).loose()
            ]).optional().describe("New value. Accepts string, number, boolean, null, array, or object. Strings are JSON.parsed when possible, else stored as a literal string. Non-string scalars and arrays/objects are stored as-is. Required for REPLACE and CREATE."),
            new_index: tool.schema.number().int().optional().describe("Position when inserting into arrays: 0=first, -1=last/append, N=nth. Ignored for object keys."),
        },
        execute: createRemoteConfigExecute(deps, "write SSH config file", configEditFlow),
    })
}
