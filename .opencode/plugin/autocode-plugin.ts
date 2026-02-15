// .opencode/plugin/autocode-plugin.ts
import type { Plugin } from "@opencode-ai/plugin"
import { readFile } from "fs/promises"
import path from "path"

/**
 * Autocode Plugin for OpenCode.
 * 
 * Provides lifecycle hooks for:
 * - Enhanced error detection and recovery hints on bash failures
 * - Project context injection for solve/test agents
 */
const autocodePlugin: Plugin = async (_input) => {
  return {
    /**
     * After tool execution: detect common errors and attach recovery hints.
     * These hints are available in tool metadata for the autocode orchestrator
     * to use when building retry context.
     */
    "tool.execute.after": async (toolInput, output) => {
      if (toolInput.tool === "bash") {
        const exitCode = (output.metadata as any)?.exitCode
        if (exitCode !== 0 && exitCode !== undefined) {
          const recoveryHints = detectRecoveryHints(output.output)
          if (recoveryHints) {
            output.metadata = {
              ...(output.metadata || {}),
              autocode_recovery_hint: recoveryHints,
            }
          }
        }
      }
    },

    /**
     * Inject project context into solve and test agent system prompts.
     * This helps agents understand the project structure for better
     * autonomous error recovery.
     */
    "experimental.chat.system.transform": async (input, output) => {
      if (input.agent === "solve" || input.agent === "test") {
        const projectContext = await getProjectContext(
          (input as any).directory || process.cwd(),
        )
        if (projectContext) {
          const systemArr = (output as any).system || []
          systemArr.push(`\n## Project Context\n${projectContext}`)
          ;(output as any).system = systemArr
        }
      }
    },
  }
}

/**
 * Detect common error patterns and suggest recovery actions.
 */
function detectRecoveryHints(errorOutput: string): string | null {
  const hints: string[] = []

  // Missing module/package
  if (
    errorOutput.includes("Module not found") ||
    errorOutput.includes("Cannot find module")
  ) {
    const moduleMatch = errorOutput.match(
      /Cannot find module '([^']+)'/,
    )
    if (moduleMatch) {
      hints.push(`Install missing module: bun add ${moduleMatch[1]}`)
    } else {
      hints.push("Install the missing module with the appropriate package manager")
    }
  }

  // File not found
  if (errorOutput.includes("ENOENT")) {
    const pathMatch = errorOutput.match(/ENOENT[^']*'([^']+)'/)
    if (pathMatch) {
      hints.push(`Create missing file or directory: ${pathMatch[1]}`)
    }
  }

  // Syntax error
  if (errorOutput.includes("SyntaxError")) {
    hints.push("Fix syntax error in the affected file — read the error for line number")
  }

  // Type error
  if (
    errorOutput.includes("TypeError") ||
    errorOutput.includes("is not a function")
  ) {
    hints.push("Check type imports and function signatures")
  }

  // Port in use
  if (errorOutput.includes("EADDRINUSE")) {
    const portMatch = errorOutput.match(/EADDRINUSE[^:]*:(\d+)/)
    if (portMatch) {
      hints.push(
        `Port ${portMatch[1]} is in use. Kill the process: lsof -ti:${portMatch[1]} | xargs kill -9`,
      )
    } else {
      hints.push("Port is in use. Kill the existing process or use a different port")
    }
  }

  // Permission denied
  if (
    errorOutput.includes("Permission denied") ||
    errorOutput.includes("EACCES")
  ) {
    hints.push("Fix file permissions — check ownership and chmod settings")
  }

  // TypeScript compilation errors
  if (
    errorOutput.includes("TS2304") ||
    errorOutput.includes("TS2305") ||
    errorOutput.includes("Cannot find name")
  ) {
    hints.push("Add missing import or type declaration")
  }

  // Command not found
  if (errorOutput.includes("command not found")) {
    const cmdMatch = errorOutput.match(/(\S+): command not found/)
    if (cmdMatch) {
      hints.push(`Install missing command: ${cmdMatch[1]}`)
    }
  }

  return hints.length > 0 ? hints.join("\n") : null
}

/**
 * Get basic project context for agent system prompts.
 */
async function getProjectContext(directory: string): Promise<string | null> {
  try {
    const pkgJsonPath = path.join(directory, "package.json")
    const pkgJson = await readFile(pkgJsonPath, "utf-8").catch(() => null)
    if (!pkgJson) return null

    const pkg = JSON.parse(pkgJson)
    const lines: string[] = []

    if (pkg.name) lines.push(`Package: ${pkg.name}`)

    // Detect runtime
    if (pkg.devDependencies?.["@types/bun"] || pkg.dependencies?.bun) {
      lines.push("Runtime: Bun")
    } else if (pkg.engines?.node) {
      lines.push(`Runtime: Node.js ${pkg.engines.node}`)
    }

    // Key dependencies
    const deps = Object.keys(pkg.dependencies || {})
    if (deps.length > 0) {
      lines.push(`Dependencies: ${deps.slice(0, 15).join(", ")}`)
    }

    // Check for TypeScript
    const tsConfigPath = path.join(directory, "tsconfig.json")
    const hasTs = await import("fs/promises")
      .then((fs) => fs.stat(tsConfigPath))
      .catch(() => null)
    if (hasTs) lines.push("Language: TypeScript")

    // Check for common test frameworks
    const devDeps = Object.keys(pkg.devDependencies || {})
    const testFrameworks = devDeps.filter((d) =>
      ["jest", "vitest", "mocha", "ava", "@types/bun"].includes(d),
    )
    if (testFrameworks.length > 0) {
      lines.push(`Test framework: ${testFrameworks.join(", ")}`)
    }

    // Scripts
    if (pkg.scripts) {
      const scriptNames = Object.keys(pkg.scripts).slice(0, 10)
      lines.push(`Scripts: ${scriptNames.join(", ")}`)
    }

    return lines.join("\n")
  } catch {
    return null
  }
}

export default autocodePlugin
