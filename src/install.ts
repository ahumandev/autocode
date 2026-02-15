#!/usr/bin/env bun
// src/install.ts
// Install autocode into OpenCode's global config directory via symlinks.
// Usage: bun run src/install.ts [--global] [--uninstall]

import { mkdir, symlink, unlink, stat, readdir } from "fs/promises"
import path from "path"
import os from "os"

const AUTOCODE_ROOT = path.dirname(import.meta.dir) // parent of src/
const OPENCODE_CONFIG = path.join(os.homedir(), ".config", "opencode")

const args = process.argv.slice(2)
const isUninstall = args.includes("--uninstall")
const isGlobal = args.includes("--global") || !isUninstall

interface LinkSpec {
  src: string
  dst: string
  description: string
}

async function getLinks(): Promise<LinkSpec[]> {
  const links: LinkSpec[] = []

  // Agent files
  const agentDir = path.join(AUTOCODE_ROOT, ".opencode", "agent")
  const agentFiles = await readdir(agentDir).catch(() => [] as string[])
  for (const file of agentFiles) {
    if (!file.endsWith(".md")) continue
    links.push({
      src: path.join(agentDir, file),
      dst: path.join(OPENCODE_CONFIG, "agent", file),
      description: `agent/${file}`,
    })
  }

  // Command files
  const commandDir = path.join(AUTOCODE_ROOT, ".opencode", "command")
  const commandFiles = await readdir(commandDir).catch(() => [] as string[])
  for (const file of commandFiles) {
    if (!file.endsWith(".md")) continue
    links.push({
      src: path.join(commandDir, file),
      dst: path.join(OPENCODE_CONFIG, "command", file),
      description: `command/${file}`,
    })
  }

  // Tool files
  const toolDir = path.join(AUTOCODE_ROOT, ".opencode", "tool")
  const toolFiles = await readdir(toolDir).catch(() => [] as string[])
  for (const file of toolFiles) {
    if (!file.endsWith(".ts") && !file.endsWith(".js")) continue
    links.push({
      src: path.join(toolDir, file),
      dst: path.join(OPENCODE_CONFIG, "tool", file),
      description: `tool/${file}`,
    })
  }

  // Plugin file
  links.push({
    src: path.join(AUTOCODE_ROOT, ".opencode", "plugin", "autocode-plugin.ts"),
    dst: path.join(OPENCODE_CONFIG, "plugin", "autocode-plugin.ts"),
    description: "plugin/autocode-plugin.ts",
  })

  return links
}

async function install() {
  console.log(`\n🔧 Installing autocode → ${OPENCODE_CONFIG}\n`)

  const links = await getLinks()

  // Create target directories
  const dirs = new Set(links.map((l) => path.dirname(l.dst)))
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true })
  }

  let installed = 0
  let skipped = 0
  let errors = 0

  for (const link of links) {
    try {
      // Check if destination already exists
      const existing = await stat(link.dst).catch(() => null)
      if (existing) {
        // Remove existing symlink or file
        await unlink(link.dst)
      }

      await symlink(link.src, link.dst)
      console.log(`  ✅ ${link.description}`)
      installed++
    } catch (err: any) {
      console.error(`  ❌ ${link.description}: ${err.message}`)
      errors++
    }
  }

  console.log(`\n📊 Results: ${installed} installed, ${skipped} skipped, ${errors} errors\n`)

  console.log("\n✨ Installation complete!")
  console.log("   Run /autocode-init in OpenCode to initialize a project.\n")
}

async function uninstall() {
  console.log(`\n🗑️  Uninstalling autocode from ${OPENCODE_CONFIG}\n`)

  const links = await getLinks()
  let removed = 0
  let errors = 0

  for (const link of links) {
    try {
      const existing = await stat(link.dst).catch(() => null)
      if (!existing) {
        continue
      }
      await unlink(link.dst)
      console.log(`  🗑️  ${link.description}`)
      removed++
    } catch (err: any) {
      console.error(`  ❌ ${link.description}: ${err.message}`)
      errors++
    }
  }

  console.log(`\n📊 Results: ${removed} removed, ${errors} errors\n`)
  console.log("✨ Uninstallation complete!\n")
}

// Main
if (isUninstall) {
  await uninstall()
} else {
  await install()
}
