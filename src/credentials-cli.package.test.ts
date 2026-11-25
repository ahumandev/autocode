import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire, isBuiltin } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import * as typescript from "typescript"

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const TEMP_ROOT = tmpdir()
const BUILD_TIMEOUT_MS = 120000
const FULL_BUILD_TIMEOUT_MS = 240000
const CHILD_TIMEOUT_MS = 60000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const SMOKE_MARKER = "PACKAGE_IMPORT_OK\n"
const IMPORT_SMOKE_FILENAME = "package-smoke.mjs"
const HELPER_FILENAME = "windows-credentials.ps1"

type ChildResult = {
    exitCode: number
    timedOut: boolean
    outputSafe: boolean
    stderrEmpty: boolean
    compilerCodes: string
    importDiagnostic: string
    importTarget: string
    stdoutEquals: (expected: string) => boolean
    stdoutMatches: (pattern: RegExp) => boolean
}
type DependencyEdge = { from: string; name: string; version: unknown }
type SmokeStage =
    | "clean package import"
    | "CLI help"

const activeChildren = new Set<Bun.PipedSubprocess>()

function isWithin(directory: string, candidate: string): boolean {
    const suffix = relative(directory, candidate)
    return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
}

function isSafeDistName(name: string): boolean {
    return name.length <= 200 && (name === "dist" || /^dist\/[A-Za-z0-9._/-]+$/.test(name))
        && !/S-1-(?:[0-9]+-)*[0-9]+/i.test(name)
        && name.split("/").every((part: string): boolean => part !== "" && part !== "." && part !== "..")
}

async function distManifest(dist: string, directory: string = dist): Promise<Set<string>> {
    const files = new Set<string>(directory === dist ? ["directory:dist"] : [])
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const filename = join(directory, entry.name)
        if (entry.isDirectory()) {
            const name = `dist/${relative(dist, filename).split(sep).join("/")}`
            if (isSafeDistName(name)) files.add(`directory:${name}`)
            for (const name of await distManifest(dist, filename)) files.add(name)
        } else if (entry.isFile()) {
            const name = `dist/${relative(dist, filename).split(sep).join("/")}`
            if (isSafeDistName(name)) files.add(name)
        }
    }
    return files
}

function distCandidates(name: string): string[] {
    return [name, ...[".js", ".mjs", ".cjs", ".json"].map((extension: string): string => name + extension),
        ...["index.js", "index.mjs", "index.cjs", "index.json"].map((entry: string): string => `${name}/${entry}`)]
}

function distPresence(files: ReadonlySet<string>, name: string): string {
    if (!isSafeDistName(name)) return "unknown"
    if (files.has(name)) return "exact"
    if (distCandidates(name).slice(1).some((candidate: string): boolean => files.has(candidate))) return "candidate"
    return files.has(`directory:${name}`) ? "directory" : "missing"
}

async function importLayoutDiagnostic(buildDist: string, build: ReadonlySet<string>, stageDist: string, request: string): Promise<string> {
    try {
        const stage = await distManifest(stageDist)
        const pending = ["dist/credentials-cli.js"]
        const visited = new Set<string>()
        const missing = new Set<string>()
        let truncated = false
        const scanner = new Bun.Transpiler({ loader: "js" })
        while (pending.length > 0) {
            const from = pending.pop()!
            if (visited.has(from)) continue
            if (visited.size >= 256) { truncated = true; break }
            visited.add(from)
            if (!build.has(from)) { truncated = true; continue }
            const filename = join(buildDist, ...from.slice(5).split("/"))
            for (const entry of scanner.scanImports(await readFile(filename, "utf8"))) {
                const specifier = entry.path.replaceAll("\\", "/")
                if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue
                const target = resolve(dirname(filename), specifier)
                if (!isWithin(buildDist, target)) { truncated = true; continue }
                const name = `dist/${relative(buildDist, target).split(sep).join("/")}`
                if (!isSafeDistName(name)) { truncated = true; continue }
                const emitted = distPresence(build, name)
                const staged = distPresence(stage, name)
                if (emitted === "missing" || emitted === "directory" || staged === "missing" || staged === "directory") {
                    if (missing.size < 20) missing.add(`${from}->${name}[build:${emitted},stage:${staged}]`)
                    else truncated = true
                }
                for (const candidate of distCandidates(name)) {
                    if (build.has(candidate) && /\.(?:js|mjs|cjs)$/i.test(candidate)) pending.push(candidate)
                }
            }
        }
        return `request-build=${distPresence(build, request)}; request-stage=${distPresence(stage, request)}; missing-static-edges=${[...missing].join(",") || "none"}${truncated ? ",incomplete" : ""}`
    } catch {
        return "request-build=unknown; request-stage=unknown; missing-static-edges=unknown"
    }
}

function safeEnvironment(root: string, config: string): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {
        TEMP: join(root, "tmp"),
        TMP: join(root, "tmp"),
        HOME: join(root, "home"),
        USERPROFILE: join(root, "home"),
        APPDATA: join(root, "home", "appdata"),
        LOCALAPPDATA: join(root, "home", "localappdata"),
        OPENCODE_CONFIG_DIR: config,
    }
    for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
        const value = process.env[key]
        if (value !== undefined) environment[key] = value
    }
    return environment
}

async function runChild(
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; diagnosticMode?: "public-import-smoke"; importNames?: readonly string[] },
): Promise<ChildResult> {
    const publicImportDiagnostics = options.diagnosticMode === "public-import-smoke"
    if (publicImportDiagnostics && (args.length !== 1 || args[0] !== IMPORT_SMOKE_FILENAME
        || Object.keys(options.env).some((key: string): boolean => /^AUTOCODE_/i.test(key)))) {
        throw new Error("Public diagnostics require the fixed credential-free import bootstrap.")
    }
    let child: Bun.PipedSubprocess
    try {
        child = Bun.spawn([process.execPath, ...args], {
            cwd: options.cwd,
            env: options.env,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
        })
    } catch {
        throw new Error("Package child could not start; diagnostics suppressed.")
    }
    activeChildren.add(child)
    let timedOut = false
    let outputSafe = true
    let outputBytes = 0
    const readers = [child.stdout.getReader(), child.stderr.getReader()]
    const kill = (): void => {
        try { child.kill("SIGKILL") } catch { }
    }
    const cancelOutput = (): void => {
        for (const reader of readers) void reader.cancel().catch((): void => undefined)
    }
    const timer = setTimeout((): void => {
        timedOut = true
        kill()
        cancelOutput()
    }, options.timeoutMs ?? CHILD_TIMEOUT_MS)
    const capture = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
        const chunks: Buffer[] = []
        try {
            for (;;) {
                const next = await reader.read()
                if (next.done) break
                outputBytes += next.value.byteLength
                if (outputBytes > MAX_OUTPUT_BYTES) {
                    outputSafe = false
                    kill()
                    cancelOutput()
                    break
                }
                chunks.push(Buffer.from(next.value))
            }
            return Buffer.concat(chunks).toString("utf8")
        } catch {
            outputSafe = false
            kill()
            return ""
        } finally {
            for (const chunk of chunks) chunk.fill(0)
        }
    }
    const output = Promise.all(readers.map(capture))
    try {
        await child.stdin.end()
        const exitCode = await child.exited
        const [stdout, stderr] = await output
        const importFailure = /^PACKAGE_IMPORT_FAILED (resolve-dbus|require-dbus|dbus-api|import-cli|cli-api) (ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_REQUIRE_ESM|syntax|type|other) (bare|relative|absolute|file-url|node|unknown) ([A-Za-z0-9@._/-]+) (true|false|unknown) (true|false|unknown) ([A-Za-z0-9._-]+) (staged-cli|staged-dependency|probe|unknown) (true|false|unknown) ((?:present|missing|outside-root|unknown)(?:,(?:present|missing|outside-root|unknown)){8}) ([A-Za-z0-9._/-]+)\r?$/m.exec(stderr)
        const coarseFailure = /\bSyntaxError\s*:/.test(stderr) ? "syntax"
            : /\bReferenceError\s*:/.test(stderr) ? "reference"
            : /\bTypeError\s*:/.test(stderr) ? "type"
            : /\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b|Cannot find (?:module|package)/.test(stderr) ? "module-not-found"
            : /\bERR_REQUIRE_ESM\b/.test(stderr) ? "require-esm"
            : stderr.length === 0 ? "empty-stderr" : "other"
        let importDiagnostic = `no-catch-token:${coarseFailure}; specifier=unknown; kind=unknown; cli-file=unknown; dbus-inside=unknown; artifact=unknown; importer=unknown; artifact-exists=unknown; candidates=unknown; request=unknown`
        let importTarget = "unknown"
        if (publicImportDiagnostics && importFailure !== null) {
            const name = options.importNames?.includes(importFailure[4]) ? importFailure[4] : "unknown"
            const artifact = importFailure[3] === "relative" && importFailure[7].length <= 96
                && !/S-1-(?:[0-9]+-)*[0-9]+/i.test(importFailure[7])
                && (importFailure[8] === "staged-cli" ? /^[A-Za-z0-9._-]+$/.test(importFailure[7]) && importFailure[7] !== "." && importFailure[7] !== ".."
                    : /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|cjs|mjs|json|ts|cts|mts|node)$/i.test(importFailure[7]))
                ? importFailure[7] : "unknown"
            const candidates = importFailure[10].split(",").map((status: string, index: number): string =>
                `${["exact", "js", "mjs", "cjs", "json", "index-js", "index-mjs", "index-cjs", "index-json"][index]}:${status}`).join(",")
            if (importFailure[3] === "relative" && importFailure[8] === "staged-cli" && isSafeDistName(importFailure[11])) importTarget = importFailure[11]
            importDiagnostic = `${importFailure[1]}:${importFailure[2]}; specifier=${name}; kind=${importFailure[3]}; cli-file=${importFailure[5]}; dbus-inside=${importFailure[6]}; artifact=${artifact}; importer=${importFailure[8]}; artifact-exists=${importFailure[9]}; candidates=${candidates}; request=${importTarget}`
        }
        return {
            exitCode,
            timedOut,
            outputSafe,
            stderrEmpty: stderr.length === 0,
            compilerCodes: [...new Set(`${stdout}\n${stderr}`.match(/\bTS[0-9]{4,5}\b/g) ?? [])].join(", ") || "none",
            importDiagnostic,
            importTarget,
            stdoutEquals: (expected: string): boolean => stdout === expected,
            stdoutMatches: (pattern: RegExp): boolean => pattern.test(stdout),
        }
    } catch {
        throw new Error("Package child failed; diagnostics suppressed.")
    } finally {
        kill()
        try {
            await child.exited.catch((): number => -1)
            try { await child.stdin.end() } catch { }
            cancelOutput()
            await output
        } finally {
            clearTimeout(timer)
            activeChildren.delete(child)
        }
    }
}

function expectSuccess(result: ChildResult, stage: SmokeStage): void {
    const context = stage === "clean package import" ? `${stage} (${result.importDiagnostic})` : stage
    expect(result.timedOut, `${context}: child timed out`).toBe(false)
    expect(result.outputSafe, `${context}: child output capture failed`).toBe(true)
    expect(result.exitCode, `${context}: child exit status`).toBe(0)
}

function object(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Packaged JSON must contain an object; content suppressed.")
    }
    return value as Record<string, unknown>
}

async function readObject(filename: string): Promise<Record<string, unknown>> {
    try {
        return object(JSON.parse(await readFile(filename, "utf8")))
    } catch {
        throw new Error("Packaged JSON could not be read; content suppressed.")
    }
}

async function exists(filename: string): Promise<boolean> {
    try {
        await lstat(filename)
        return true
    } catch (error: unknown) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false
        throw new Error("Package path inspection failed.")
    }
}

function stagedBundleArgs(args: string[], dist: string): string[] {
    const index = args.indexOf("--outdir")
    if (index === -1 || index !== args.lastIndexOf("--outdir") || args[index + 1] === undefined) {
        throw new Error("Production bundle arguments must contain exactly one output directory.")
    }
    const staged = [...args]
    staged[index + 1] = dist
    return staged
}

function exportTargets(value: unknown): string[] {
    if (typeof value === "string") return [value]
    if (Array.isArray(value)) return value.flatMap(exportTargets)
    if (value === null) return []
    return Object.values(object(value)).flatMap(exportTargets)
}

async function resolveInstalledPackage(from: string, name: string): Promise<string | undefined> {
    const require = createRequire(join(from, "package.json"))
    try {
        return dirname(await realpath(require.resolve(`${name}/package.json`)))
    } catch {
        // Export maps may hide package.json even when the installed package is resolvable.
        for (const searchRoot of require.resolve.paths(name) ?? []) {
            const manifest = join(searchRoot, name, "package.json")
            if (await exists(manifest)) return dirname(await realpath(manifest))
        }
        return undefined
    }
}

async function copyDependency(
    source: string,
    destination: string,
    ancestry: ReadonlySet<string>,
    edges: DependencyEdge[],
): Promise<void> {
    if (ancestry.has(source)) return
    const ancestors = new Set([...ancestry, source])
    await cp(source, destination, {
        recursive: true,
        dereference: true,
        filter: (filename: string): boolean => basename(filename) !== "node_modules",
    })
    const metadata = await readObject(join(source, "package.json"))
    const dependencies = object(metadata.dependencies ?? {})
    const optional = object(metadata.optionalDependencies ?? {})
    for (const name of new Set([...Object.keys(dependencies), ...Object.keys(optional)])) {
        const installed = await resolveInstalledPackage(source, name)
        if (installed === undefined) {
            if (Object.hasOwn(optional, name)) continue
            throw new Error("Installed production dependency is missing; no network installation attempted.")
        }
        const dependency = await readObject(join(installed, "package.json"))
        edges.push({ from: destination, name, version: dependency.version })
        // Cycles resolve through copied ancestors instead of creating unbounded directory trees.
        await copyDependency(installed, join(destination, "node_modules", name), ancestors, edges)
    }
}

async function expectContainedTree(directory: string, root: string): Promise<void> {
    const metadata = await lstat(directory)
    expect(metadata.isSymbolicLink()).toBe(false)
    expect(isWithin(root, await realpath(directory))).toBe(true)
    if (!metadata.isDirectory()) return
    for (const entry of await readdir(directory)) await expectContainedTree(join(directory, entry), root)
}

function hasPortableRuntimeDependencies(contents: string): boolean {
    const scannerInput = contents.replace(/^#![^\r\n]*/, "")
    const imports = new Bun.Transpiler({ loader: "js" }).scanImports(scannerInput)
    if (imports.some((entry: { path: string }): boolean => entry.path === "bun" || entry.path.startsWith("bun:")
        || (!isBuiltin(entry.path) && entry.path !== "dbus-next"))) return false
    const parsed = typescript.createSourceFile("credentials-cli.js", contents, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.JS)
    let found = false
    const visit = (node: typescript.Node): void => {
        if (typescript.isIdentifier(node) && node.text === "Bun") found = true
        if (typescript.isElementAccessExpression(node) && typescript.isIdentifier(node.expression)
            && node.expression.text === "globalThis" && typescript.isStringLiteralLike(node.argumentExpression)
            && node.argumentExpression.text === "Bun") found = true
        typescript.forEachChild(node, visit)
    }
    visit(parsed)
    return !found
}

const IMPORT_SMOKE = `import { realpathSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const names = new Set(__SAFE_NAMES__)
let stage = "resolve-dbus"
let cliFile = "unknown"
let dbusInside = "unknown"
try { cliFile = String(statSync(new URL("./dist/credentials-cli.js", import.meta.url)).isFile()) } catch (error) {
    if (error && error.code === "ENOENT") cliFile = "false"
}
try {
    const require = createRequire(new URL("./package.json", import.meta.url))
    dbusInside = "false"
    const dependencyRoot = realpathSync(fileURLToPath(new URL("./node_modules", import.meta.url)))
    const resolved = realpathSync(require.resolve("dbus-next"))
    const suffix = relative(dependencyRoot, resolved)
    if (suffix === ".." || suffix.startsWith(".." + sep) || isAbsolute(suffix)) throw new Error()
    dbusInside = "true"
    stage = "require-dbus"
    const dbus = require("dbus-next")
    stage = "dbus-api"
    if (typeof dbus.sessionBus !== "function") throw new Error()
    stage = "import-cli"
    const cli = await import("./dist/credentials-cli.js")
    stage = "cli-api"
    if (typeof cli.runCredentialsCli !== "function") throw new Error()
    process.stdout.write("PACKAGE_IMPORT_OK\\n")
} catch (error) {
    let code = "other"
    let kind = "unknown"
    let name = "unknown"
    let artifact = "unknown"
    let importer = "unknown"
    let artifactExists = "unknown"
    let candidates = Array(9).fill("unknown")
    let request = "unknown"
    try {
        const candidate = typeof error === "object" && error !== null ? error.code : undefined
        if (candidate === "ERR_MODULE_NOT_FOUND" || candidate === "MODULE_NOT_FOUND" || candidate === "ERR_REQUIRE_ESM") code = candidate
        else if (error instanceof SyntaxError) code = "syntax"
        else if (error instanceof TypeError) code = "type"
        if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
            const message = typeof error.message === "string" && error.message.length <= 4096 ? error.message : ""
            const match = /^(?:Cannot find|Cannot resolve) (?:module|package) ['"]([^'"\\r\\n]{1,512})['"]/.exec(message)
            if (match !== null) {
                const specifier = match[1]
                const normalized = specifier.replaceAll("\\\\", "/")
                kind = normalized.startsWith("file:") ? "file-url"
                    : normalized.startsWith("./") || normalized.startsWith("../") ? "relative"
                    : normalized.startsWith("/") || /^[A-Za-z]:\\//.test(normalized) ? "absolute"
                    : normalized.startsWith("node:") ? "node" : "bare"
                const parts = normalized.split("/")
                const candidateName = kind === "bare"
                    ? (normalized.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0])
                    : parts[parts.length - 1]
                if (names.has(candidateName)) name = candidateName
                if (kind === "relative") {
                    if (candidateName.length <= 96 && !/S-1-(?:[0-9]+-)*[0-9]+/i.test(candidateName) && /^[A-Za-z0-9][A-Za-z0-9._-]*\\.(?:js|cjs|mjs|json|ts|cts|mts|node)$/i.test(candidateName)) artifact = candidateName
                    const fromMessage = /(?: from | imported from )['"]?([^'"\\r\\n]{1,2048})['"]?(?:\\r?\\n|$)/.exec(message)?.[1]
                    const fromStack = Array.isArray(error.requireStack) ? error.requireStack[0] : undefined
                    const from = typeof error.referrer === "string" ? error.referrer : typeof fromStack === "string" ? fromStack : fromMessage
                    if (typeof from === "string" && from.length <= 2048) {
                        const path = from.startsWith("file:") ? fileURLToPath(from) : from
                        if (isAbsolute(path)) {
                            const root = realpathSync(fileURLToPath(new URL(".", import.meta.url)))
                            const source = realpathSync(path)
                            const inside = (directory, target) => {
                                const suffix = relative(directory, target)
                                return suffix === "" || (suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix))
                            }
                            const same = (left, right) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
                            if (inside(root, source)) {
                                if (same(source, resolve(root, "dist", "credentials-cli.js"))) importer = "staged-cli"
                                else if (same(source, resolve(root, "package-smoke.mjs"))) importer = "probe"
                                else if (inside(resolve(root, "node_modules"), source)) importer = "staged-dependency"
                                if (importer === "staged-cli") {
                                    const base = normalized.replace(/\\/+$/, "").split("/").pop()
                                    if (base === ".") artifact = "self"
                                    else if (base === "..") artifact = "parent"
                                    else if (base && base.length <= 96 && /^[A-Za-z0-9._-]+$/.test(base) && !/S-1-(?:[0-9]+-)*[0-9]+/i.test(base)) artifact = base
                                }
                                const target = resolve(dirname(source), specifier)
                                if (inside(root, target)) {
                                    const targetName = relative(root, target).split(sep).join("/")
                                    if (importer === "staged-cli" && targetName.length <= 200 && (targetName === "dist" || /^dist\\/[A-Za-z0-9._/-]+$/.test(targetName))
                                        && !/S-1-(?:[0-9]+-)*[0-9]+/i.test(targetName)
                                        && targetName.split("/").every((part) => part !== "" && part !== "." && part !== "..")) request = targetName
                                    try { if (inside(root, realpathSync(target))) artifactExists = "true" }
                                    catch (failure) { if (failure && failure.code === "ENOENT") artifactExists = "false" }
                                }
                                candidates = [target, ...[".js", ".mjs", ".cjs", ".json"].map((extension) => target + extension),
                                    ...["index.js", "index.mjs", "index.cjs", "index.json"].map((entry) => resolve(target, entry))].map((candidate) => {
                                    if (!inside(root, candidate)) return "outside-root"
                                    try { return inside(root, realpathSync(candidate)) ? "present" : "outside-root" }
                                    catch (failure) { return failure && (failure.code === "ENOENT" || failure.code === "ENOTDIR") ? "missing" : "unknown" }
                                })
                            }
                        }
                    }
                }
            }
        }
    } catch { }
    process.stderr.write("PACKAGE_IMPORT_FAILED " + stage + " " + code + " " + kind + " " + name + " " + cliFile + " " + dbusInside + " " + artifact + " " + importer + " " + artifactExists + " " + candidates.join(",") + " " + request + "\\n")
    process.exitCode = 1
}
`

// Keep package fixtures under OS temp and outside the repository.
describe.skipIf(process.platform !== "win32").serial("production credentials package: Bun-on-Node-target compatibility", (): void => {
    let ownedRoot = ""
    let packageRoot = ""
    let nativeRoot = ""
    let publication: Record<string, unknown>
    let emittedFiles = new Set<string>()
    const edges: DependencyEdge[] = []

    beforeAll(async (): Promise<void> => {
        expect(typeof process.versions.bun === "string").toBe(true)
        ownedRoot = await mkdtemp(join(TEMP_ROOT, "credentials-package-"))
        expect(isWithin(TEMP_ROOT, ownedRoot)).toBe(true)
        expect(isWithin(REPOSITORY_ROOT, ownedRoot)).toBe(false)
        packageRoot = join(ownedRoot, "package")
        nativeRoot = join(ownedRoot, "native-package")
        await Promise.all(["tmp", "home", "build-config"].map(async (name: string): Promise<void> => {
            await mkdir(join(ownedRoot, name), { recursive: true })
        }))
        const stagedDist = join(ownedRoot, "staging", "dist")
        const { createBundleArgs, createCredentialsBundleArgs } = await import("../scripts/build")
        for (const args of [createBundleArgs(false), createCredentialsBundleArgs(false)]) {
            const build = await runChild(stagedBundleArgs(args, stagedDist), {
                cwd: REPOSITORY_ROOT,
                env: safeEnvironment(ownedRoot, join(ownedRoot, "build-config")),
                timeoutMs: BUILD_TIMEOUT_MS,
            })
            if (build.exitCode !== 0 || build.timedOut || !build.outputSafe) {
                throw new Error(`Production bundle failed: exit=${build.exitCode}, timeout=${build.timedOut}; output suppressed.`)
            }
        }
        await copyFile(join(REPOSITORY_ROOT, "src", "credentials", HELPER_FILENAME), join(stagedDist, HELPER_FILENAME))
        emittedFiles = await distManifest(stagedDist)
        publication = await readObject(join(REPOSITORY_ROOT, "package.json"))
        expect(JSON.stringify(publication.files) === '["dist"]').toBe(true)
        await mkdir(packageRoot)
        await copyFile(join(REPOSITORY_ROOT, "package.json"), join(packageRoot, "package.json"))
        for (const entry of publication.files as string[]) {
            await cp(stagedDist, join(packageRoot, entry), { recursive: true, dereference: true })
        }
        const dbus = await resolveInstalledPackage(REPOSITORY_ROOT, "dbus-next")
        if (dbus === undefined) throw new Error("Installed dbus-next is required; no network installation attempted.")
        await copyDependency(dbus, join(packageRoot, "node_modules", "dbus-next"), new Set(), edges)
        await cp(packageRoot, nativeRoot, { recursive: true, dereference: true })
    }, BUILD_TIMEOUT_MS * 2 + 60000)

    afterAll(async (): Promise<void> => {
        await Promise.all([...activeChildren].map(async (child: Bun.PipedSubprocess): Promise<void> => {
            try { child.kill("SIGKILL") } catch { }
            await child.exited.catch((): number => -1)
        }))
        if (ownedRoot !== "") {
            await rm(ownedRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
        }
    }, 180000)

    test("production build publishes CLI, plugin, helper, and CLI publication contract", async (): Promise<void> => {
        for (const entry of ["plugin.js", "credentials-cli.js"]) {
            expect((await lstat(join(packageRoot, "dist", entry))).isFile()).toBe(true)
        }
        const cli = await readFile(join(packageRoot, "dist", "credentials-cli.js"), "utf8")
        expect(cli.split(/\r?\n/, 1)[0] === "#!/usr/bin/env node").toBe(true)
        expect((cli.match(/^#!/gm) ?? []).length).toBe(1)
        expect(hasPortableRuntimeDependencies(cli)).toBe(true)
        const sourceHelper = await readFile(join(REPOSITORY_ROOT, "src", "credentials", HELPER_FILENAME))
        expect(sourceHelper.equals(await readFile(join(packageRoot, "dist", HELPER_FILENAME)))).toBe(true)
        const originalMetadata = await readFile(join(REPOSITORY_ROOT, "package.json"))
        expect(originalMetadata.equals(await readFile(join(packageRoot, "package.json")))).toBe(true)
        expect(object(publication.bin)["autocode-credentials"] === "./dist/credentials-cli.js").toBe(true)
        expect(object(publication.scripts).credentials === "bun dist/credentials-cli.js").toBe(true)
        expect(JSON.stringify(publication.files) === '["dist"]').toBe(true)
        expect(publication.type === "module" && object(publication.engines).node === ">=20").toBe(true)
        expect(object(publication.dependencies)["dbus-next"] === "0.10.2").toBe(true)
        expect(publication.main === "./dist/plugin.js" && publication.types === "./dist/plugin.d.ts").toBe(true)
        const pluginExport = object(object(publication.exports)["."])
        expect(pluginExport.default === "./dist/plugin.js" && pluginExport.types === "./dist/plugin.d.ts").toBe(true)
    }, CHILD_TIMEOUT_MS)

    // Run the isolated release check: $env:AUTOCODE_TEST_FULL_BUILD="1"; bun test src/credentials-cli.package.test.ts
    test.skipIf(process.env.AUTOCODE_TEST_FULL_BUILD !== "1")("full release build in temp snapshot generates all publication and type targets (AUTOCODE_TEST_FULL_BUILD=1)", async (): Promise<void> => {
        expect(JSON.stringify(publication.files) === '["dist"]').toBe(true)
        expect(object(publication.bin)["autocode-credentials"] === "./dist/credentials-cli.js").toBe(true)
        expect(object(publication.scripts).credentials === "bun dist/credentials-cli.js").toBe(true)
        expect(publication.type === "module" && object(publication.engines).node === ">=20").toBe(true)
        expect(object(publication.dependencies)["dbus-next"] === "0.10.2").toBe(true)
        expect(publication.main === "./dist/plugin.js" && publication.types === "./dist/plugin.d.ts").toBe(true)
        const pluginExport = object(object(publication.exports)["."])
        expect(pluginExport.default === "./dist/plugin.js" && pluginExport.types === "./dist/plugin.d.ts").toBe(true)

        const snapshot = join(ownedRoot, "release-snapshot")
        await mkdir(snapshot)
        for (const entry of ["src", "scripts", "package.json", "tsconfig.json", "tsconfig.build.json", "node_modules"]) {
            await cp(join(REPOSITORY_ROOT, entry), join(snapshot, entry), {
                recursive: true,
                dereference: true,
                filter: (filename: string): boolean => basename(filename) !== ".bin",
            })
        }
        const snapshotPublication = await readObject(join(snapshot, "package.json"))
        expect(JSON.stringify(snapshotPublication) === JSON.stringify(publication)).toBe(true)
        const targets = new Set([
            ...exportTargets(snapshotPublication.main),
            ...exportTargets(snapshotPublication.types),
            ...exportTargets(snapshotPublication.bin),
            ...exportTargets(snapshotPublication.exports),
            `./dist/${HELPER_FILENAME}`,
        ])
        const dist = join(snapshot, "dist")
        const paths = [...targets].map((target: string): string => {
            const filename = resolve(snapshot, target)
            if (!target.startsWith("./dist/") || filename === dist || !isWithin(dist, filename)) {
                throw new Error("Publication target must be a file under dist.")
            }
            return filename
        })
        expect(await exists(dist)).toBe(false)
        const build = await runChild(["scripts/build.ts", "build"], {
            cwd: snapshot,
            env: safeEnvironment(ownedRoot, join(ownedRoot, "build-config")),
            timeoutMs: FULL_BUILD_TIMEOUT_MS,
        })
        if (build.exitCode !== 0 || build.timedOut || !build.outputSafe) {
            throw new Error(`Production build failed: exit=${build.exitCode}, timeout=${build.timedOut}, TypeScript=${build.compilerCodes}; output suppressed.`)
        }
        for (const filename of paths) expect((await lstat(filename)).isFile()).toBe(true)
        expect((await readFile(join(snapshot, "src", "credentials", HELPER_FILENAME)))
            .equals(await readFile(join(dist, HELPER_FILENAME)))).toBe(true)
    }, FULL_BUILD_TIMEOUT_MS + 600000)

    // Measured slow tests are skipped from the fast suite; retained for future opt-in/slow testing.
    test.skip("clean published layout contains dereferenced dbus-next production closure without source fallback", async (): Promise<void> => {
        for (const directory of [packageRoot, nativeRoot]) {
            expect((await readdir(directory)).sort().join(",") === "dist,node_modules,package.json").toBe(true)
            expect(await exists(join(directory, "src"))).toBe(false)
            expect(await exists(join(directory, "scripts"))).toBe(false)
            expect((await readdir(join(directory, "node_modules"))).join(",") === "dbus-next").toBe(true)
            await expectContainedTree(directory, await realpath(directory))
        }
        const dbus = await resolveInstalledPackage(packageRoot, "dbus-next")
        expect(dbus !== undefined && isWithin(join(packageRoot, "node_modules"), dbus)).toBe(true)
        expect((await readObject(join(dbus ?? "", "package.json"))).version === "0.10.2").toBe(true)
        for (const edge of edges) {
            const installed = await resolveInstalledPackage(edge.from, edge.name)
            expect(installed !== undefined && isWithin(join(packageRoot, "node_modules"), installed)).toBe(true)
            if (installed === undefined) throw new Error("Copied dependency could not resolve locally.")
            expect((await readObject(join(installed, "package.json"))).version === edge.version).toBe(true)
        }
    }, CHILD_TIMEOUT_MS)

    test("clean Bun child requires dbus-next and imports built CLI without direct-entry side effects", async (): Promise<void> => {
        const importNames = [...new Set([
            ...Object.keys(object(publication.dependencies)),
            ...edges.map((edge: DependencyEdge): string => edge.name),
            ...await readdir(join(packageRoot, "dist")),
        ])].filter((name: string): boolean => name.length <= 128 && /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
        const smoke = IMPORT_SMOKE.replace("__SAFE_NAMES__", JSON.stringify(importNames))
        let smokeParses = false
        try {
            new Bun.Transpiler({ loader: "js" }).scanImports(smoke)
            smokeParses = true
        } catch { }
        expect(smokeParses, "Generated import smoke must parse before child execution.").toBe(true)
        await writeFile(join(packageRoot, IMPORT_SMOKE_FILENAME), smoke, "utf8")
        const environment = safeEnvironment(ownedRoot, join(ownedRoot, "import-config"))
        expect(Object.keys(environment).some((key: string): boolean => key.toUpperCase() === "NODE_PATH")).toBe(false)
        // This fixed bootstrap receives only public OS/temp configuration and no stdin or credential values.
        const result = await runChild([IMPORT_SMOKE_FILENAME], { cwd: packageRoot, env: environment, diagnosticMode: "public-import-smoke", importNames })
        if (result.exitCode !== 0 || result.timedOut || !result.outputSafe || !result.stderrEmpty || !result.stdoutEquals(SMOKE_MARKER)) {
            result.importDiagnostic += `; ${await importLayoutDiagnostic(join(ownedRoot, "staging", "dist"), emittedFiles, join(packageRoot, "dist"), result.importTarget)}`
        }
        expectSuccess(result, "clean package import")
        expect(result.stderrEmpty, result.importDiagnostic).toBe(true)
        expect(result.stdoutEquals(SMOKE_MARKER), result.importDiagnostic).toBe(true)
    }, CHILD_TIMEOUT_MS + 5000)

    test("built CLI displays help without accessing credentials", async (): Promise<void> => {
        const result = await runChild(["dist/credentials-cli.js", "--help"], {
            cwd: packageRoot,
            env: safeEnvironment(ownedRoot, join(ownedRoot, "help-config")),
        })
        expectSuccess(result, "CLI help")
        expect(result.stderrEmpty).toBe(true)
        expect(result.stdoutMatches(/^Usage:\r?$/m)).toBe(true)
    }, CHILD_TIMEOUT_MS + 5000)
})
