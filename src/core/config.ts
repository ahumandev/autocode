// src/core/config.ts
import { readFile } from "fs/promises"
import path from "path"
import type { AutocodeConfig } from "./types"

/** Default configuration values */
const DEFAULTS: Omit<AutocodeConfig, "rootDir"> = {
  retryCount: 3,
  autoInstallDependencies: true,
  parallelSessionsLimit: 4,
}

/**
 * Load autocode configuration.
 * 
 * Reads from opencode.json's "autocode" section if available,
 * otherwise uses defaults.
 * 
 * @param projectRoot - The project root directory (where opencode.json lives)
 * @returns Resolved AutocodeConfig
 */
export async function loadConfig(projectRoot: string): Promise<AutocodeConfig> {
  const rootDir = path.join(projectRoot, ".autocode")

  try {
    const configPath = path.join(projectRoot, "opencode.json")
    const raw = await readFile(configPath, "utf-8")
    
    // Strip comments for JSONC support (simple approach)
    const stripped = raw
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
    
    const parsed = JSON.parse(stripped)
    const autocodeSection = parsed.autocode || {}

    return {
      retryCount: autocodeSection.retry_count ?? DEFAULTS.retryCount,
      autoInstallDependencies:
        autocodeSection.auto_install_dependencies ??
        DEFAULTS.autoInstallDependencies,
      parallelSessionsLimit:
        autocodeSection.parallel_sessions_limit ??
        DEFAULTS.parallelSessionsLimit,
      rootDir,
    }
  } catch {
    // Config file not found or invalid — use defaults
    return {
      ...DEFAULTS,
      rootDir,
    }
  }
}

/**
 * Create a config object from explicit values.
 * Useful for tools that receive the worktree from OpenCode context.
 */
export function createConfig(
  worktree: string,
  overrides?: Partial<Omit<AutocodeConfig, "rootDir">>,
): AutocodeConfig {
  return {
    retryCount: overrides?.retryCount ?? DEFAULTS.retryCount,
    autoInstallDependencies:
      overrides?.autoInstallDependencies ?? DEFAULTS.autoInstallDependencies,
    parallelSessionsLimit:
      overrides?.parallelSessionsLimit ?? DEFAULTS.parallelSessionsLimit,
    rootDir: path.join(worktree, ".autocode"),
  }
}
