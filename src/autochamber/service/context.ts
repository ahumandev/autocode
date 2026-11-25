import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const MAX_BOOTSTRAP_BYTES = 16 * 1024;
const MAX_PROJECTS = 64;

export interface AutoChamberServiceBootstrap {
  openCodeConfigDir?: string;
  projects: { directory: string; worktree: string }[];
}

export interface ResolvedAutoChamberSettingsContext {
  context: { directory: string; worktree: string } | {};
  notice?: { code: "no_active_directory" | "unverified_project"; message: string };
}

export class AutoChamberContextInputError extends Error {
  constructor() {
    super("Invalid settings request.");
  }
}

export function isSafeAbsolutePath(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && value.isWellFormed() && !/[\x00-\x1f\x7f-\x9f]/.test(value)
    && isAbsolute(value)
    && (process.platform !== "win32" || /^[A-Za-z]:[\\/]/.test(value));
}

function pathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function contained(root: string, target: string): boolean {
  const difference = relative(root, target);
  return difference === "" || (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference));
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function canonicalDirectory(value: string): Promise<string> {
  if (!isSafeAbsolutePath(value)) throw new AutoChamberContextInputError();
  try {
    const canonical = await realpath(value);
    if (!isSafeAbsolutePath(canonical) || !(await stat(canonical)).isDirectory()) throw new AutoChamberContextInputError();
    return canonical;
  } catch {
    throw new AutoChamberContextInputError();
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key): boolean => keys.includes(key));
}

async function readBootstrapFile(directory: string): Promise<unknown | undefined> {
  const file = join(directory, "bootstrap.json");
  let before;
  try {
    before = await lstat(file);
  } catch (error: unknown) {
    if (missing(error)) return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BOOTSTRAP_BYTES
    || pathKey(await realpath(file)) !== pathKey(file)) throw new Error("Invalid bootstrap");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_BOOTSTRAP_BYTES
      || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("Invalid bootstrap");
    const buffer = Buffer.alloc(MAX_BOOTSTRAP_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const result = await handle.read(buffer, total, buffer.length - total, total);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    if (total > MAX_BOOTSTRAP_BYTES) throw new Error("Invalid bootstrap");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } finally {
    await handle.close();
  }
}

export async function loadAutoChamberServiceBootstrap(dataDir: string | undefined): Promise<AutoChamberServiceBootstrap> {
  if (dataDir === undefined) throw new Error("Invalid bootstrap");
  const directory = await canonicalDirectory(dataDir);
  const data = await readBootstrapFile(directory);
  if (data === undefined) return { projects: [] };
  if (!object(data) || !exactKeys(data, ["openCodeConfigDir", "projects"])
    || (data.openCodeConfigDir !== undefined && typeof data.openCodeConfigDir !== "string")
    || (data.projects !== undefined && (!Array.isArray(data.projects) || data.projects.length > MAX_PROJECTS))) {
    throw new Error("Invalid bootstrap");
  }
  const openCodeConfigDir = typeof data.openCodeConfigDir === "string"
    ? await canonicalDirectory(data.openCodeConfigDir) : undefined;
  const projects: AutoChamberServiceBootstrap["projects"] = [];
  const keys = new Set<string>();
  const entries: unknown[] = Array.isArray(data.projects) ? data.projects : [];
  for (const entry of entries) {
    if (!object(entry) || !exactKeys(entry, ["directory", "worktree"])
      || typeof entry.directory !== "string" || typeof entry.worktree !== "string") throw new Error("Invalid bootstrap");
    const projectDirectory = await canonicalDirectory(entry.directory);
    const worktree = await canonicalDirectory(entry.worktree);
    const key = pathKey(projectDirectory);
    if (!contained(worktree, projectDirectory) || keys.has(key)) throw new Error("Invalid bootstrap");
    keys.add(key);
    projects.push({ directory: projectDirectory, worktree });
  }
  return { ...(openCodeConfigDir === undefined ? {} : { openCodeConfigDir }), projects };
}

async function lstatOptional(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (missing(error)) return undefined;
    throw error;
  }
}

async function verifiedWorktree(directory: string): Promise<string | undefined> {
  let current = directory;
  while (true) {
    const marker = join(current, ".git");
    const metadata = await lstatOptional(marker);
    if (metadata !== undefined) {
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined;
      const head = await lstatOptional(join(marker, "HEAD"));
      const objects = await lstatOptional(join(marker, "objects"));
      if (!head?.isFile() || head.isSymbolicLink() || !objects?.isDirectory() || objects.isSymbolicLink()) return undefined;
      if (!contained(current, await realpath(marker)) || !contained(marker, await realpath(join(marker, "HEAD")))
        || !contained(marker, await realpath(join(marker, "objects")))) return undefined;
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function validateCandidates(worktree: string, directory: string): Promise<void> {
  let current = worktree;
  const parts = relative(worktree, directory);
  const steps = parts === "" ? [] : parts.split(sep);
  for (let index = 0; index <= steps.length; index += 1) {
    if (index > 0) current = join(current, steps[index - 1]);
    const configDir = join(current, ".opencode");
    const info = await lstatOptional(configDir);
    if (info === undefined) continue;
    if (!info.isDirectory() || info.isSymbolicLink() || !contained(current, await realpath(configDir))) {
      throw new AutoChamberContextInputError();
    }
    for (const name of ["autocode.jsonc", "opencode.jsonc", "opencode.json"]) {
      const file = join(configDir, name);
      const fileInfo = await lstatOptional(file);
      if (fileInfo !== undefined && (!fileInfo.isFile() || fileInfo.isSymbolicLink()
        || !contained(configDir, await realpath(file)))) throw new AutoChamberContextInputError();
    }
  }
}

export async function resolveAutoChamberSettingsContext(
  directory: string | undefined,
  bootstrap: AutoChamberServiceBootstrap,
): Promise<ResolvedAutoChamberSettingsContext> {
  if (directory === undefined) {
    return { context: {}, notice: { code: "no_active_directory", message: "No active directory. Showing global settings." } };
  }
  try {
    const canonical = await canonicalDirectory(directory);
    const mapping = bootstrap.projects.find((project): boolean => pathKey(project.directory) === pathKey(canonical));
    const worktree = mapping?.worktree ?? await verifiedWorktree(canonical);
    if (worktree === undefined) {
      return { context: {}, notice: { code: "unverified_project", message: "Active directory has no verified project root. Showing global settings." } };
    }
    if (await canonicalDirectory(worktree) !== worktree || !contained(worktree, canonical)) throw new AutoChamberContextInputError();
    await validateCandidates(worktree, canonical);
    return { context: { directory: canonical, worktree } };
  } catch {
    throw new AutoChamberContextInputError();
  }
}
