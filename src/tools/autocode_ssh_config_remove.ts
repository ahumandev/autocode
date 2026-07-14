import { tool } from "@opencode-ai/plugin"
import type { SshToolDeps } from "./autocode_ssh"
import { createRemoteConfigExecute } from "./config/ssh/adapter"
import { configRemoveFlow } from "./config/core"

const configPathSchema = tool.schema.string()

export function createAutocodeSshConfigRemoveTool(deps: SshToolDeps = {}): ReturnType<typeof tool> {
    return tool({
        description: "Remove a key and its entire subtree from a structured config file over SSH (JSON/JSONC, YAML/YML, TOML, INI/properties/conf, .env). Refuses to remove the root (whole-document) key. Returns the post-removal state of the parent. Refuses markdown. Path is an absolute REMOTE path on the SSH target.",
        args: {
            ssh_key: tool.schema.string().describe("SSH connection key."),
            path: tool.schema.string().describe("Absolute remote path to the config file."),
            key_path: configPathSchema.describe("Dotted key path with bracket array indexing (e.g. 'server.port', 'ports[0]', 'grid[1][2]') of the key to remove. Cannot be the document root."),
        },
        execute: createRemoteConfigExecute(deps, "remove SSH config file key", configRemoveFlow),
    })
}
