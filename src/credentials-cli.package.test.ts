import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { randomBytes, randomUUID } from "node:crypto"
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire, isBuiltin } from "node:module"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { stripVTControlCharacters } from "node:util"
import * as typescript from "typescript"

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const APPROVED_TEMP_ROOT = "C:\\Users\\qxz13vb\\AppData\\Local\\Temp\\opencode"
const BUILD_TIMEOUT_MS = 120000
const CHILD_TIMEOUT_MS = 60000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const STUB_SID = "S-1-5-21-111-222-333-1001"
const SMOKE_MARKER = "PACKAGE_IMPORT_OK\n"
const IMPORT_SMOKE_FILENAME = "package-smoke.mjs"
const SAVED_MARKER = "Credential profile saved.\n"
const HELPER_FILENAME = "windows-credentials.ps1"
const PAYLOAD_FILENAME = "package-write-payload.json"
const METADATA_FILENAME = "package-write-metadata.json"

type ChildResult = {
    exitCode: number
    timedOut: boolean
    outputSafe: boolean
    stderrEmpty: boolean
    compilerCodes: string
    importDiagnostic: string
    stdoutEquals: (expected: string) => boolean
    stdoutMatches: (pattern: RegExp) => boolean
    hides: (values: readonly string[]) => boolean
    identitySid: () => string | undefined
}
type DependencyEdge = { from: string; name: string; version: unknown }
type SmokeStage =
    | "real helper identity"
    | "clean package import"
    | "plaintext stdin set"
    | "plaintext import-env seed"
    | "plaintext import-env"
    | "native stub identity"
    | "native stub import-env"
    | "native stub stdin set"

const activeChildren = new Set<Bun.PipedSubprocess>()

function isWithin(directory: string, candidate: string): boolean {
    const suffix = relative(directory, candidate)
    return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
}

function safeEnvironment(root: string, config: string, selected: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
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
    for (const [key, value] of Object.entries(selected)) {
        if (!/^AUTOCODE_REST_[A-Z0-9_]+_AUTHORIZATION$/.test(key)) {
            throw new Error("Only exact REST authorization test variables may be selected.")
        }
        environment[key] = value
    }
    return environment
}

async function runChild(
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; diagnosticMode?: "public-import-smoke" },
): Promise<ChildResult> {
    const publicImportDiagnostics = options.diagnosticMode === "public-import-smoke"
    if (publicImportDiagnostics && (args.length !== 1 || args[0] !== IMPORT_SMOKE_FILENAME
        || options.input !== undefined || Object.keys(options.env).some((key: string): boolean => /^AUTOCODE_/i.test(key)))) {
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
        if (options.input !== undefined) await child.stdin.write(options.input)
        await child.stdin.end()
        const exitCode = await child.exited
        const [stdout, stderr] = await output
        const importFailure = /^PACKAGE_IMPORT_FAILED (resolve-dbus|require-dbus|dbus-api|import-cli|cli-api) (ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_REQUIRE_ESM|syntax|type|other)\r?$/m.exec(stderr)
        const coarseFailure = /\bSyntaxError\s*:/.test(stderr) ? "syntax"
            : /\bReferenceError\s*:/.test(stderr) ? "reference"
            : /\bTypeError\s*:/.test(stderr) ? "type"
            : /\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b|Cannot find (?:module|package)/.test(stderr) ? "module-not-found"
            : /\bERR_REQUIRE_ESM\b/.test(stderr) ? "require-esm"
            : stderr.length === 0 ? "empty-stderr" : "other"
        const diagnosticWord = ["Unexpected", "Expected", "Unterminated", "Invalid", "Cannot find module", "Cannot find package", "not defined"]
            .find((word: string): boolean => stderr.includes(word)) ?? "none"
        let importDiagnostic = importFailure === null ? `no-catch-token:${coarseFailure}:${diagnosticWord}` : `${importFailure[1]}:${importFailure[2]}`
        if (publicImportDiagnostics) importDiagnostic += `; ${publicImportErrorLine(stderr)}`
        return {
            exitCode,
            timedOut,
            outputSafe,
            stderrEmpty: stderr.length === 0,
            compilerCodes: [...new Set(`${stdout}\n${stderr}`.match(/\bTS[0-9]{4,5}\b/g) ?? [])].join(", ") || "none",
            importDiagnostic,
            stdoutEquals: (expected: string): boolean => stdout === expected,
            stdoutMatches: (pattern: RegExp): boolean => pattern.test(stdout),
            hides: (values: readonly string[]): boolean => values.every((value: string): boolean => !stdout.includes(value) && !stderr.includes(value)),
            identitySid: (): string | undefined => /^SID: (S-1-[0-9-]+)\r?$/m.exec(stdout)?.[1],
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

function publicImportErrorLine(stderr: string): string {
    const line = stripVTControlCharacters(stderr).split(/\r\n|[\r\n\u2028\u2029]/)
        .map((entry: string): string => entry.trim())
        .find((entry: string): boolean => /^(?:[A-Za-z]*Error(?: \[[A-Z0-9_]+\])?:|Invalid\b|Cannot find\b)/i.test(entry))
    if (line === undefined) return "No public loader error line."
    return line
        .replace(/(["'`])(?:file:\/+|[A-Za-z]:[\\/]|[\\/])[^"'`]*\1/gi, "$1<path>$1")
        .replace(/(?:file:\/+|[A-Za-z]:[\\/]|\\\\)[^"'`<>]*/gi, "<path>")
        .replace(/(^|[\s(=:])[\\/][^"'`<>]*/g, "$1<path>")
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .slice(0, 1024)
}

function expectSuccess(result: ChildResult, stage: SmokeStage, secrets: readonly string[] = []): void {
    const context = stage === "clean package import" ? `${stage} (${result.importDiagnostic})` : stage
    expect(result.timedOut, `${context}: child timed out`).toBe(false)
    expect(result.outputSafe, `${context}: child output capture failed`).toBe(true)
    expect(result.hides(secrets), `${context}: child output exposed a profile value`).toBe(true)
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

function writeArgs(command: "set" | "import-env", provider: "plaintext" | "windows-credential-manager", id: string, sid: string): string[] {
    const args = ["dist/credentials-cli.js", command, "--provider", provider, "--kind", "rest", "--key", id]
    if (process.platform === "win32") args.push("--expected-sid", sid)
    if (command === "set") args.push("--stdin")
    return args
}

async function expectPlaintextStore(config: string, expected: Readonly<Record<string, string>>): Promise<void> {
    const store = await readObject(join(config, "credentials", "profiles.json"))
    expect(store.version === 1).toBe(true)
    const kinds = object(store.profiles)
    expect(Object.keys(kinds).join(",") === "rest").toBe(true)
    const profiles = object(kinds.rest)
    expect(Object.keys(profiles).sort().join(",") === Object.keys(expected).sort().join(",")).toBe(true)
    for (const [id, authorization] of Object.entries(expected)) {
        const profile = object(profiles[id])
        expect(Object.keys(profile).join(",") === "authorization" && profile.authorization === authorization).toBe(true)
    }
}

async function expectNativeCapture(directory: string, id: string, authorization: string): Promise<void> {
    const metadata = await readObject(join(directory, "dist", METADATA_FILENAME))
    expect(metadata.version === 1 && metadata.operation === "write").toBe(true)
    expect(metadata.expectedSid === STUB_SID).toBe(true)
    expect(metadata.target === `AutoCode/v1/rest/${id.toUpperCase()}`).toBe(true)
    expect(metadata.credentialEnvironmentAbsent === true).toBe(true)
    const envelope = await readObject(join(directory, "dist", PAYLOAD_FILENAME))
    expect(Object.keys(envelope).sort().join(",") === "fields,kind,version").toBe(true)
    expect(envelope.version === 1 && envelope.kind === "rest").toBe(true)
    const fields = object(envelope.fields)
    expect(Object.keys(fields).join(",") === "authorization" && fields.authorization === authorization).toBe(true)
}

const IMPORT_SMOKE = `import { realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { isAbsolute, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

let stage = "resolve-dbus"
try {
    const require = createRequire(new URL("./package.json", import.meta.url))
    const dependencyRoot = realpathSync(fileURLToPath(new URL("./node_modules", import.meta.url)))
    const resolved = realpathSync(require.resolve("dbus-next"))
    const suffix = relative(dependencyRoot, resolved)
    if (suffix === ".." || suffix.startsWith(".." + sep) || isAbsolute(suffix)) throw new Error()
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
    try {
        const candidate = typeof error === "object" && error !== null ? error.code : undefined
        if (candidate === "ERR_MODULE_NOT_FOUND" || candidate === "MODULE_NOT_FOUND" || candidate === "ERR_REQUIRE_ESM") code = candidate
        else if (error instanceof SyntaxError) code = "syntax"
        else if (error instanceof TypeError) code = "type"
    } catch { }
    process.stderr.write("PACKAGE_IMPORT_FAILED " + stage + " " + code + "\\n")
    process.exitCode = 1
}
`

const NATIVE_STUB = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    foreach ($key in [Environment]::GetEnvironmentVariables().Keys) {
        if ([string]$key -like 'AUTOCODE_*') { throw 'Credential environment rejected.' }
    }
    $request = ConvertFrom-Json -InputObject ([Console]::In.ReadLine())
    if ($null -ne [Console]::In.ReadLine() -or $request.version -ne 1) { throw 'Invalid frame.' }
    if ($request.expectedSid -and $request.expectedSid -ne '${STUB_SID}') { throw 'Invalid SID.' }
    if ($request.operation -eq 'identity') {
        [Console]::Out.WriteLine('{"version":1,"status":"ok","identity":{"sid":"${STUB_SID}","account":"package-smoke"}}')
    } elseif ($request.operation -eq 'write') {
        if ($request.expectedSid -ne '${STUB_SID}') { throw 'Missing SID.' }
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [IO.File]::WriteAllText((Join-Path $PSScriptRoot '${PAYLOAD_FILENAME}'), [string]$request.payload, $utf8)
        $metadata = [ordered]@{ version = $request.version; operation = $request.operation; target = $request.target; expectedSid = $request.expectedSid; credentialEnvironmentAbsent = $true }
        [IO.File]::WriteAllText((Join-Path $PSScriptRoot '${METADATA_FILENAME}'), (ConvertTo-Json -InputObject $metadata -Compress), $utf8)
        [Console]::Out.WriteLine('{"version":1,"status":"ok"}')
    } else { throw 'Unsupported operation.' }
} catch {
    [Console]::Out.WriteLine('{"version":1,"status":"error","code":"failed"}')
    exit 1
}
`

// This fixture deliberately requires the approved Windows temp root, never an OS-temp fallback.
describe.skipIf(process.platform !== "win32").serial("production credentials package: Bun-on-Node-target compatibility", (): void => {
    let ownedRoot = ""
    let packageRoot = ""
    let nativeRoot = ""
    let realSid = ""
    let identity: ChildResult
    let publication: Record<string, unknown>
    const edges: DependencyEdge[] = []

    beforeAll(async (): Promise<void> => {
        expect(typeof process.versions.bun === "string").toBe(true)
        ownedRoot = await mkdtemp(join(APPROVED_TEMP_ROOT, "credentials-package-"))
        expect(isWithin(APPROVED_TEMP_ROOT, ownedRoot)).toBe(true)
        expect(isWithin(REPOSITORY_ROOT, ownedRoot)).toBe(false)
        packageRoot = join(ownedRoot, "package")
        nativeRoot = join(ownedRoot, "native-package")
        await Promise.all(["tmp", "home", "build-config"].map(async (name: string): Promise<void> => {
            await mkdir(join(ownedRoot, name), { recursive: true })
        }))
        const build = await runChild(["scripts/build.ts", "build"], {
            cwd: REPOSITORY_ROOT,
            env: safeEnvironment(ownedRoot, join(ownedRoot, "build-config")),
            timeoutMs: BUILD_TIMEOUT_MS,
        })
        if (build.exitCode !== 0 || build.timedOut || !build.outputSafe) {
            throw new Error(`Production build failed: exit=${build.exitCode}, timeout=${build.timedOut}, TypeScript=${build.compilerCodes}; output suppressed.`)
        }
        publication = await readObject(join(REPOSITORY_ROOT, "package.json"))
        expect(JSON.stringify(publication.files) === '["dist"]').toBe(true)
        await mkdir(packageRoot)
        await copyFile(join(REPOSITORY_ROOT, "package.json"), join(packageRoot, "package.json"))
        for (const entry of publication.files as string[]) {
            await cp(join(REPOSITORY_ROOT, entry), join(packageRoot, entry), { recursive: true, dereference: true })
        }
        const dbus = await resolveInstalledPackage(REPOSITORY_ROOT, "dbus-next")
        if (dbus === undefined) throw new Error("Installed dbus-next is required; no network installation attempted.")
        await copyDependency(dbus, join(packageRoot, "node_modules", "dbus-next"), new Set(), edges)
        await cp(packageRoot, nativeRoot, { recursive: true, dereference: true })
        identity = await runChild(["dist/credentials-cli.js", "identity"], {
            cwd: packageRoot,
            env: safeEnvironment(ownedRoot, join(ownedRoot, "identity-config")),
        })
        expectSuccess(identity, "real helper identity")
        expect(identity.stdoutMatches(/^Account: [^\r\n]+\r?$/m)).toBe(true)
        const sid = identity.identitySid()
        expect(typeof sid === "string").toBe(true)
        realSid = sid ?? ""
    }, BUILD_TIMEOUT_MS + CHILD_TIMEOUT_MS + 60000)

    afterAll(async (): Promise<void> => {
        await Promise.all([...activeChildren].map(async (child: Bun.PipedSubprocess): Promise<void> => {
            try { child.kill("SIGKILL") } catch { }
            await child.exited.catch((): number => -1)
        }))
        if (ownedRoot !== "") {
            await rm(ownedRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
        }
    }, 45000)

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
        let smokeParses = false
        try {
            new Bun.Transpiler({ loader: "js" }).scanImports(IMPORT_SMOKE)
            smokeParses = true
        } catch { }
        expect(smokeParses, "Generated import smoke must parse before child execution.").toBe(true)
        await writeFile(join(packageRoot, IMPORT_SMOKE_FILENAME), IMPORT_SMOKE, "utf8")
        const environment = safeEnvironment(ownedRoot, join(ownedRoot, "import-config"))
        expect(Object.keys(environment).some((key: string): boolean => key.toUpperCase() === "NODE_PATH")).toBe(false)
        // This fixed bootstrap receives only public OS/temp configuration and no stdin or credential values.
        const result = await runChild([IMPORT_SMOKE_FILENAME], { cwd: packageRoot, env: environment, diagnosticMode: "public-import-smoke" })
        expectSuccess(result, "clean package import")
        expect(result.stderrEmpty).toBe(true)
        expect(result.stdoutEquals(SMOKE_MARKER)).toBe(true)
    }, CHILD_TIMEOUT_MS + 5000)

    test("built identity entry uses real copied Windows helper read-only", (): void => {
        expectSuccess(identity, "real helper identity")
        expect(identity.stderrEmpty).toBe(true)
        expect(identity.stdoutMatches(/^SID: S-1-[0-9-]+\r?$/m)).toBe(true)
        expect(identity.stdoutMatches(/^Account: [^\r\n]+\r?$/m)).toBe(true)
    })

    test.skip("built plaintext stdin set roundtrips profiles without exposing values", async (): Promise<void> => {
        const config = join(ownedRoot, "stdin-config")
        const id = `package_set_${randomUUID().replaceAll("-", "")}`
        const authorization = randomBytes(32).toString("base64url")
        const result = await runChild(writeArgs("set", "plaintext", id, realSid), {
            cwd: packageRoot,
            env: safeEnvironment(ownedRoot, config),
            input: JSON.stringify({ authorization }),
        })
        expectSuccess(result, "plaintext stdin set", [authorization])
        expect(result.stdoutEquals(SAVED_MARKER)).toBe(true)
        await expectPlaintextStore(config, { [id.toUpperCase()]: authorization })
    }, CHILD_TIMEOUT_MS + 5000)

    test.skip("built plaintext import-env selects exact normalized profile and preserves prior profiles", async (): Promise<void> => {
        const config = join(ownedRoot, "env-config")
        const id = `package_env_${randomUUID().replaceAll("-", "")}`
        const previousId = `package_prior_${randomUUID().replaceAll("-", "")}`
        const unrelatedId = `PACKAGE_OTHER_${randomUUID().replaceAll("-", "").toUpperCase()}`
        const authorization = randomBytes(32).toString("base64url")
        const previous = randomBytes(32).toString("base64url")
        const unrelated = randomBytes(32).toString("base64url")
        const first = await runChild(writeArgs("set", "plaintext", previousId, realSid), {
            cwd: packageRoot,
            env: safeEnvironment(ownedRoot, config),
            input: JSON.stringify({ authorization: previous }),
        })
        expectSuccess(first, "plaintext import-env seed", [authorization, previous, unrelated])
        const result = await runChild(writeArgs("import-env", "plaintext", id, realSid), {
            cwd: packageRoot,
            env: safeEnvironment(ownedRoot, config, {
                [`AUTOCODE_REST_${id.toUpperCase()}_AUTHORIZATION`]: authorization,
                [`AUTOCODE_REST_${unrelatedId}_AUTHORIZATION`]: unrelated,
            }),
        })
        expectSuccess(result, "plaintext import-env", [authorization, previous, unrelated])
        expect(result.stdoutEquals(SAVED_MARKER)).toBe(true)
        await expectPlaintextStore(config, { [previousId.toUpperCase()]: previous, [id.toUpperCase()]: authorization })
        expect((await readFile(join(config, "credentials", "profiles.json"), "utf8")).includes(unrelated)).toBe(false)
    }, CHILD_TIMEOUT_MS * 2 + 5000)

    test("built native import-env and stdin set frame payloads through temp helper with credential-free environment", async (): Promise<void> => {
        expect(realSid === STUB_SID).toBe(false)
        const helper = join(nativeRoot, "dist", HELPER_FILENAME)
        const original = await readFile(helper)
        try {
            await writeFile(helper, NATIVE_STUB, "utf8")
            const config = join(ownedRoot, "native-config")
            const identityResult = await runChild(["dist/credentials-cli.js", "identity"], {
                cwd: nativeRoot,
                env: safeEnvironment(ownedRoot, config),
            })
            expectSuccess(identityResult, "native stub identity")
            expect(identityResult.identitySid() === STUB_SID).toBe(true)
            expect(identityResult.stdoutMatches(/^Account: package-smoke\r?$/m)).toBe(true)
            for (const command of ["import-env", "set"] as const) {
                const id = `package_native_${randomUUID().replaceAll("-", "")}`
                const authorization = randomBytes(32).toString("base64url")
                const result = await runChild(writeArgs(command, "windows-credential-manager", id, STUB_SID), {
                    cwd: nativeRoot,
                    env: safeEnvironment(ownedRoot, config, command === "import-env" ? {
                        [`AUTOCODE_REST_${id.toUpperCase()}_AUTHORIZATION`]: authorization,
                    } : {}),
                    input: command === "set" ? JSON.stringify({ authorization }) : undefined,
                })
                expectSuccess(result, command === "import-env" ? "native stub import-env" : "native stub stdin set", [authorization])
                expect(result.stdoutEquals(SAVED_MARKER)).toBe(true)
                await expectNativeCapture(nativeRoot, id, authorization)
            }
        } finally {
            await writeFile(helper, original)
        }
        expect(original.equals(await readFile(helper))).toBe(true)
    }, CHILD_TIMEOUT_MS * 3 + 5000)
})
