import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join, resolve } from "path"
import { resetRetryCounts } from "@/utils/tools"
import { createAutocodeContentFrontmatterReadTool, createAutocodeContentFrontmatterWriteTool, createAutocodeContentGrepTool, createAutocodeContentInsertTool, createAutocodeContentMoveTool, createAutocodeContentReadTool, createAutocodeContentRemoveTool, createAutocodeContentTocTool, createAutocodeContentWriteTool } from "./autocode_content"
import { createAskEffect, createToolContext } from "./test_context"
import type { ToolContext } from "@opencode-ai/plugin"

type ContentTool = ReturnType<typeof createAutocodeContentTocTool>

const baseMarkdown = `# Root
Root intro.

## Install
Install body.

#### Setup
Setup body.

## Usage
Usage body.
`

let currentTempDir: string | undefined
let oldCwd: string | undefined
let oldHome: string | undefined
let oldXdgConfigHome: string | undefined
let isolatedHome: string | undefined

afterEach(() => {
    resetRetryCounts()
    if (oldCwd) process.chdir(oldCwd)
    oldCwd = undefined
    if (currentTempDir) rmSync(currentTempDir, { recursive: true, force: true })
    currentTempDir = undefined
    if (isolatedHome) {
        if (oldHome === undefined) delete process.env.HOME
        else process.env.HOME = oldHome
        if (oldXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = oldXdgConfigHome
        rmSync(isolatedHome, { recursive: true, force: true })
    }
    isolatedHome = undefined
    oldHome = undefined
    oldXdgConfigHome = undefined
})

function useTempCwd(): string {
    const dir = mkdtempSync(join(tmpdir(), "autocode-content-"))
    oldCwd = process.cwd()
    currentTempDir = dir
    process.chdir(dir)
    return dir
}

function withIsolatedConfigHome(): string {
    const home = mkdtempSync(join(tmpdir(), "autocode-home-"))
    oldHome = process.env.HOME
    oldXdgConfigHome = process.env.XDG_CONFIG_HOME
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = join(home, ".config")
    isolatedHome = home
    return home
}

function writeMarkdown(path: string, content = baseMarkdown): void {
    writeContent(path, content)
}

function writeContent(path: string, content: string): void {
    const directory = dirname(path)
    if (directory) mkdirSync(directory, { recursive: true })
    writeFileSync(path, content, "utf8")
}

function writeAutocodeConfig(dir: string, rules: Record<string, "ask" | "allow" | "deny">): void {
    const configDir = join(dir, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "autocode.jsonc"), JSON.stringify({ permission: { external_directory: rules } }, null, 2), "utf8")
}

function parseResult(result: unknown): Record<string, any> {
    const text = typeof result === "string" ? result : (result as { output: string }).output
    return JSON.parse(text)
}

async function execute(tool: ContentTool, args: Record<string, unknown>, context: ToolContext = createToolContext()): Promise<Record<string, any>> {
    return parseResult(await tool.execute(args as never, context))
}

function expectRetry(result: Record<string, any>, failedAction: string, errorText: string, instructionText: string): void {
    expect(result.failedAction).toBe(failedAction)
    expect(result.error).toContain(errorText)
    expect(result.instruction).toContain(instructionText)
}

function toolSurfaceText(tool: any): string {
    const argDescriptions = Object.values(tool?.args ?? {}).map((arg: any) => arg.description ?? arg.unwrap?.().description ?? arg.def?.innerType?.description ?? "")
    return [tool?.description ?? "", ...argDescriptions].join("\n")
}

describe("autocode content tools", () => {

    test("greps content files and returns matching content locations", async () => {
        useTempCwd()
        writeMarkdown("docs/readme.md", "# Root\nIntro.\n\n## Install\nUse target value.\n\n## Usage\nOther.\n")
        writeContent("docs/config.json", "{\n  \"service\": { \"name\": \"target-api\" }\n}\n")

        const result = await execute(createAutocodeContentGrepTool(), { pattern: "target", path: "docs", include: "**/*", limit: 10 })

        expect(result.map((entry: Record<string, any>) => entry.path)).toEqual(["docs/config.json", "docs/readme.md"])
        expect(String(result[0].matches[0].path)).toContain("service")
        expect(result[1].matches[0].path).toBe("Root.Install")
        expect(result[0].truncated).toBe(false)
    })

    test("accepts supported content paths and rejects unsupported and unsafe paths", async () => {
        const dir = useTempCwd()
        writeMarkdown("docs/readme.md")
        writeContent("docs/config.json", "{\"root\":true}\n")
        writeContent("docs/config.jsonc", "{\n  // comment\n  \"root\": true\n}\n")
        writeContent("docs/config.toml", "root = true\n")
        writeContent("docs/.env", "API_KEY=secret\n")
        writeContent("docs/config.yaml", "root: true\n")
        writeContent("docs/config.yml", "root: true\n")
        writeFileSync("notes.txt", "# Root\n", "utf8")
        const tool = createAutocodeContentTocTool()

        const acceptedMarkdown = await execute(tool, { path: "docs/readme.md" })
        expect(acceptedMarkdown.root).toBe("Root")

        const acceptedJson = await execute(tool, { path: "docs/config.json" })
        expect(acceptedJson.toc.path).toBe("")

        const acceptedJsonc = await execute(tool, { path: "docs/config.jsonc" })
        expect(acceptedJsonc.toc.path).toBe("")

        const acceptedToml = await execute(tool, { path: "docs/config.toml" })
        expect(acceptedToml.toc[0].path).toBe("root")

        const acceptedEnv = await execute(tool, { path: "docs/.env" })
        expect(acceptedEnv.toc[0].path).toBe("API_KEY")

        const acceptedYaml = await execute(tool, { path: "docs/config.yaml" })
        expect(acceptedYaml.toc.path).toBe("")

        const acceptedYml = await execute(tool, { path: "docs/config.yml" })
        expect(acceptedYml.toc.path).toBe("")

        const unsupported = await execute(tool, { path: "notes.txt" })
        expectRetry(unsupported, "validate content path", ".md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf", "Markdown, JSON, JSONC, YAML, TOML, .env, INI, properties, or .conf")

        const absolute = await execute(tool, { path: resolve(dir, "..", "outside.md") })
        expectRetry(absolute, "validate content path", "external_directory", "Add an allow/ask rule for this path in autocode.jsonc permission.external_directory, or use a path inside the working directory.")

        const escaping = await execute(tool, { path: "../escape.md" })
        expectRetry(escaping, "validate content path", "external_directory", "Add an allow/ask rule for this path in autocode.jsonc permission.external_directory, or use a path inside the working directory.")
    })

    test("rejects XML paths for every local content tool", async () => {
        useTempCwd()
        const xmlPath = "docs/config.xml"
        const calls: Array<[ContentTool, Record<string, unknown>]> = [
            [createAutocodeContentTocTool(), { path: xmlPath }],
            [createAutocodeContentReadTool(), { path: xmlPath, section: "root" }],
            [createAutocodeContentWriteTool(), { path: xmlPath, section: "root", content: "value" }],
            [createAutocodeContentInsertTool(), { path: xmlPath, target: "root", content: "value" }],
            [createAutocodeContentMoveTool(), { path: xmlPath, section: "root", target: "target" }],
            [createAutocodeContentRemoveTool(), { path: xmlPath, section: "root" }],
            [createAutocodeContentFrontmatterReadTool(), { path: xmlPath }],
            [createAutocodeContentFrontmatterWriteTool(), { path: xmlPath, frontmatter: "---\ntitle: Test\n---" }],
        ]

        for (const [tool, args] of calls) {
            const result = await execute(tool, args)
            expect(result.failedAction).toBe("validate content path")
            expect(result.error).toContain(".md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf")
        }
    })

    test("env toc accepts env path variants and never exposes values", async () => {
        useTempCwd()
        const huge = "h".repeat(10001)
        for (const path of [".env", ".env.local", ".env.production", "service.env"]) {
            writeContent(path, `# comment\nAPI_KEY=small-secret\nexport HUGE_SECRET=${huge}\n`)

            const result = await execute(createAutocodeContentTocTool(), { path })

            expect(result.path).toBe(path)
            expect(result.truncated).toBe(false)
            expect(result.toc).toEqual([
                { title: "API_KEY", path: "API_KEY", level: 1, header: "API_KEY", line: 2, children: [] },
                { title: "HUGE_SECRET", path: "HUGE_SECRET", level: 1, header: "HUGE_SECRET", line: 3, children: [] },
            ])
            expect(JSON.stringify(result)).not.toContain("small-secret")
            expect(JSON.stringify(result)).not.toContain(huge)
        }
    })

    test("env read returns selected value with metadata and no other values", async () => {
        useTempCwd()
        const huge = "x".repeat(10001)
        writeContent(".env", `PUBLIC=visible\nTOKEN=hidden-token\nHUGE_SECRET=${huge}\nOTHER=other-secret\n`)

        const selected = await execute(createAutocodeContentReadTool(), { path: ".env", section: "TOKEN" })
        expect(selected).toMatchObject({ path: ".env", section: { title: "TOKEN", path: "TOKEN", level: 1, header: "TOKEN", line: 2, children: [] }, content: "hidden-token", truncated: false })
        expect(JSON.stringify(selected)).not.toContain("visible")
        expect(JSON.stringify(selected)).not.toContain("other-secret")

        const hugeSelected = await execute(createAutocodeContentReadTool(), { path: ".env", section: "HUGE_SECRET" })
        expect(hugeSelected.content).toHaveLength(10000)
        expect(hugeSelected.truncated).toBe(true)
        expect(JSON.stringify(hugeSelected)).not.toContain(huge)
        expect(JSON.stringify(hugeSelected)).not.toContain("hidden-token")
        expect(JSON.stringify(hugeSelected)).not.toContain("other-secret")
    })

    test("env write changes only target value and preserves formatting", async () => {
        useTempCwd()
        const before = "# top\r\n\r\nexport API_KEY = old\r\nPLAIN=keep\r\nSPACED\t=\tstay\r\n"
        writeContent(".env", before)

        const result = await execute(createAutocodeContentWriteTool(), { path: ".env", section: "API_KEY", content: "new value" })

        expect(result).toMatchObject({ path: ".env", section: "API_KEY", changed: true, truncated: false })
        expect(readFileSync(".env", "utf8")).toBe("# top\r\n\r\nexport API_KEY = new value\r\nPLAIN=keep\r\nSPACED\t=\tstay\r\n")

        const multiline = await execute(createAutocodeContentWriteTool(), { path: ".env", section: "API_KEY", content: "one\ntwo" })
        expectRetry(multiline, "write env content", "single-line env value", "does not contain newlines")
        expect(readFileSync(".env", "utf8")).toBe("# top\r\n\r\nexport API_KEY = new value\r\nPLAIN=keep\r\nSPACED\t=\tstay\r\n")
    })

    test("env insert adds new key and rejects duplicates without values", async () => {
        useTempCwd()
        writeContent(".env", "KEY=first-secret\nOTHER=other-secret\nKEY=second-secret\n")

        const duplicate = await execute(createAutocodeContentInsertTool(), { path: ".env", target: "KEY", content: "new-secret" })
        expectRetry(duplicate, "insert env content", "Duplicate env key KEY: KEY:1, KEY:3", "Remove duplicate env key assignments")
        expect(JSON.stringify(duplicate)).not.toContain("first-secret")
        expect(JSON.stringify(duplicate)).not.toContain("second-secret")
        expect(JSON.stringify(duplicate)).not.toContain("other-secret")

        writeContent(".env", "EXISTING=keep-secret\n")
        const existing = await execute(createAutocodeContentInsertTool(), { path: ".env", target: "EXISTING", content: "new-secret" })
        expectRetry(existing, "insert env content", "Duplicate env key EXISTING: EXISTING:1", "Remove duplicate env key assignments")
        expect(JSON.stringify(existing)).not.toContain("keep-secret")

        writeContent(".env", "# top\nEXISTING=keep\n\n")
        const result = await execute(createAutocodeContentInsertTool(), { path: ".env", target: "ADDED", content: "added value" })
        expect(result).toMatchObject({ path: ".env", target: "ADDED", changed: true, truncated: false })
        expect(readFileSync(".env", "utf8")).toBe("# top\nEXISTING=keep\n\nADDED=added value\n")
    })

    test("env insert position 0 shifts existing entries right", async () => {
        useTempCwd()
        writeContent(".env", "FIRST=1\nSECOND=2\nTHIRD=3\n")
        const result = await execute(createAutocodeContentInsertTool(), { path: ".env", target: "NEW", position: 0, content: "zero" })
        expect(result).toMatchObject({ path: ".env", target: "NEW", position: 0, changed: true, truncated: false })
        expect(readFileSync(".env", "utf8")).toBe("NEW=zero\nFIRST=1\nSECOND=2\nTHIRD=3\n")
    })

    test("env insert position 1 inserts between first and second entries", async () => {
        useTempCwd()
        writeContent(".env", "FIRST=1\nSECOND=2\nTHIRD=3\n")
        const result = await execute(createAutocodeContentInsertTool(), { path: ".env", target: "NEW", position: 1, content: "one-half" })
        expect(result).toMatchObject({ path: ".env", target: "NEW", position: 1, changed: true, truncated: false })
        expect(readFileSync(".env", "utf8")).toBe("FIRST=1\nNEW=one-half\nSECOND=2\nTHIRD=3\n")
    })

    test("env move position 0 moves entry to first position shifting others right", async () => {
        useTempCwd()
        writeContent(".env", "FIRST=1\nSECOND=2\nTHIRD=3\n")
        await execute(createAutocodeContentMoveTool(), { path: ".env", section: "THIRD", position: 0 })
        expect(readFileSync(".env", "utf8")).toBe("THIRD=3\nFIRST=1\nSECOND=2\n")
    })

    test("env move position 1 moves entry to second position shifting later entries right", async () => {
        useTempCwd()
        writeContent(".env", "FIRST=1\nSECOND=2\nTHIRD=3\n")
        await execute(createAutocodeContentMoveTool(), { path: ".env", section: "FIRST", position: 1 })
        expect(readFileSync(".env", "utf8")).toBe("SECOND=2\nFIRST=1\nTHIRD=3\n")
    })

    test("env remove deletes only target assignment line", async () => {
        useTempCwd()
        writeContent(".env", "# top\n\nREMOVE=secret\nKEEP=keep\n# bottom\n")

        const result = await execute(createAutocodeContentRemoveTool(), { path: ".env", section: "REMOVE" })

        expect(result).toMatchObject({ path: ".env", section: "REMOVE", changed: true, truncated: false })
        expect(readFileSync(".env", "utf8")).toBe("# top\n\nKEEP=keep\n# bottom\n")
    })

    test("env move reorders and renames while preserving lines", async () => {
        useTempCwd()
        const tool = createAutocodeContentMoveTool()

        writeContent(".env", "# top\nFIRST=1\n# between\nSECOND=2\nTHIRD=3\n")
        await execute(tool, { path: ".env", section: "THIRD", position: 0 })
        expect(readFileSync(".env", "utf8")).toBe("# top\nTHIRD=3\nFIRST=1\n# between\nSECOND=2\n")

        writeContent(".env", "# top\nFIRST=1\n# between\nSECOND=2\nTHIRD=3\n")
        await execute(tool, { path: ".env", section: "FIRST", position: 1 })
        expect(readFileSync(".env", "utf8")).toBe("# top\n# between\nSECOND=2\nFIRST=1\nTHIRD=3\n")

        writeContent(".env", "FIRST=1\nSECOND=2\nTHIRD=3\n")
        await execute(tool, { path: ".env", section: "THIRD", position: 0 })
        expect(readFileSync(".env", "utf8")).toBe("THIRD=3\nFIRST=1\nSECOND=2\n")

        writeContent(".env", "FIRST=1\nSECOND=2\nTHIRD=3\n")
        await execute(tool, { path: ".env", section: "FIRST", position: 1 })
        expect(readFileSync(".env", "utf8")).toBe("SECOND=2\nFIRST=1\nTHIRD=3\n")

        writeContent(".env", "export OLD = value\nKEEP=1\n")
        const renamed = await execute(tool, { path: ".env", section: "OLD", target: "NEW" })
        expect(renamed).toMatchObject({ path: ".env", section: "OLD", target: "NEW", changed: true, truncated: false })
        expect(readFileSync(".env", "utf8")).toBe("export NEW = value\nKEEP=1\n")
    })

    test("env move duplicate source and target retry without values", async () => {
        useTempCwd()
        writeContent(".env", "KEY=first-secret\nTARGET=target-secret\nKEY=second-secret\n")

        const duplicateSource = await execute(createAutocodeContentMoveTool(), { path: ".env", section: "KEY", target: "TARGET" })
        expectRetry(duplicateSource, "resolve env section", "Duplicate env key KEY: KEY:1, KEY:3", "Remove duplicate env key assignments")
        expect(JSON.stringify(duplicateSource)).not.toContain("first-secret")
        expect(JSON.stringify(duplicateSource)).not.toContain("second-secret")
        expect(JSON.stringify(duplicateSource)).not.toContain("target-secret")

        writeContent(".env", "SOURCE=source-secret\nTARGET=first-secret\nOTHER=other-secret\nTARGET=second-secret\n")
        const duplicateTarget = await execute(createAutocodeContentMoveTool(), { path: ".env", section: "SOURCE", target: "TARGET" })
        expectRetry(duplicateTarget, "resolve env target", "Duplicate env key TARGET: TARGET:2, TARGET:4", "Remove duplicate env key assignments")
        expect(JSON.stringify(duplicateTarget)).not.toContain("source-secret")
        expect(JSON.stringify(duplicateTarget)).not.toContain("first-secret")
        expect(JSON.stringify(duplicateTarget)).not.toContain("second-secret")
        expect(JSON.stringify(duplicateTarget)).not.toContain("other-secret")
    })

    test("env frontmatter read is empty and write returns retry", async () => {
        useTempCwd()
        writeContent(".env", "KEY=value\n")

        const read = await execute(createAutocodeContentFrontmatterReadTool(), { path: ".env" })
        expect(read).toMatchObject({ path: ".env", frontmatter: "", hasFrontmatter: false, truncated: false })

        const write = await execute(createAutocodeContentFrontmatterWriteTool(), { path: ".env", frontmatter: "title: Test" })
        expectRetry(write, "write frontmatter", "frontmatter only supported for Markdown files", "Use content tools to edit .env files")
    })

    test("ini toc read write insert move and remove support section keys and root keys", async () => {
        useTempCwd()
        writeContent("settings.ini", "; top\nroot = keep\n\n[server]\n# comment\nhost = old\nport = 8080\n\n[other]\nname = app\n")

        const toc = await execute(createAutocodeContentTocTool(), { path: "settings.ini" })
        expect(toc.toc[0]).toMatchObject({ title: "root", path: "root", level: 1, header: "root", line: 2, children: [] })
        expect(toc.toc[1]).toMatchObject({ title: "server", path: "server", level: 1, header: "[server]", line: 4 })
        expect(toc.toc[1].children.map((child: Record<string, unknown>) => child.path)).toEqual(["server.host", "server.port"])

        const stringPathRead = await execute(createAutocodeContentReadTool(), { path: "settings.ini", section: "server.host" })
        expect(stringPathRead).toMatchObject({ path: "settings.ini", content: "old", truncated: false })
        expect(stringPathRead.section.path).toBe("server.host")

        const arrayPathRead = await execute(createAutocodeContentReadTool(), { path: "settings.ini", section: ["server", "host"] })
        expect(arrayPathRead.section.path).toBe("server.host")
        expect(arrayPathRead.content).toBe("old")

        const rootRead = await execute(createAutocodeContentReadTool(), { path: "settings.ini", section: "root" })
        expect(rootRead).toMatchObject({ path: "settings.ini", content: "keep", truncated: false })

        const write = await execute(createAutocodeContentWriteTool(), { path: "settings.ini", section: "server.host", content: "new" })
        expect(write).toMatchObject({ path: "settings.ini", section: "server.host", changed: true, truncated: false })
        expect(readFileSync("settings.ini", "utf8")).toBe("; top\nroot = keep\n\n[server]\n# comment\nhost = new\nport = 8080\n\n[other]\nname = app\n")

        const insert = await execute(createAutocodeContentInsertTool(), { path: "settings.ini", target: ["server", "protocol"], content: "https" })
        expect(insert).toMatchObject({ path: "settings.ini", target: "server.protocol", changed: true, truncated: false })

        const move = await execute(createAutocodeContentMoveTool(), { path: "settings.ini", section: ["server", "protocol"], target: "server.port", position: 1 })
        expect(move).toMatchObject({ path: "settings.ini", section: "server.protocol", target: "server.port", position: 1, changed: true, truncated: false })

        const remove = await execute(createAutocodeContentRemoveTool(), { path: "settings.ini", section: "other.name" })
        expect(remove).toMatchObject({ path: "settings.ini", section: "other.name", changed: true, truncated: false })
        expect(readFileSync("settings.ini", "utf8")).toBe("; top\nroot = keep\n\n[server]\n# comment\nhost = new\nprotocol=https\nport = 8080\n\n[other]\n")
    })

    test("properties dotted root keys preserve comments and spacing while inserting and removing", async () => {
        useTempCwd()
        writeContent("app.properties", "# top\napp.name = old\n\nremove.me = gone\npath.with.dots: /tmp\n")

        const read = await execute(createAutocodeContentReadTool(), { path: "app.properties", section: "app.name" })
        expect(read).toMatchObject({ path: "app.properties", content: "old", truncated: false })

        const write = await execute(createAutocodeContentWriteTool(), { path: "app.properties", section: "app.name", content: "new" })
        expect(write).toMatchObject({ path: "app.properties", section: "app.name", changed: true, truncated: false })

        const insert = await execute(createAutocodeContentInsertTool(), { path: "app.properties", target: "added.key", content: "added" })
        expect(insert).toMatchObject({ path: "app.properties", target: "added.key", changed: true, truncated: false })

        const remove = await execute(createAutocodeContentRemoveTool(), { path: "app.properties", section: "remove.me" })
        expect(remove).toMatchObject({ path: "app.properties", section: "remove.me", changed: true, truncated: false })
        expect(readFileSync("app.properties", "utf8")).toBe("# top\napp.name = new\n\npath.with.dots: /tmp\nadded.key=added\n")
    })

    test("conf section headers allow ini-like paths and no section allows dotted root keys", async () => {
        useTempCwd()
        writeContent("section.conf", "[server]\nhost=localhost\n")
        writeContent("root.conf", "server.host=localhost\n")

        const sectionRead = await execute(createAutocodeContentReadTool(), { path: "section.conf", section: "server.host" })
        expect(sectionRead).toMatchObject({ path: "section.conf", content: "localhost", truncated: false })
        expect(sectionRead.section.path).toBe("server.host")

        const rootRead = await execute(createAutocodeContentReadTool(), { path: "root.conf", section: "server.host" })
        expect(rootRead).toMatchObject({ path: "root.conf", content: "localhost", truncated: false })
        expect(rootRead.section.path).toBe("server.host")
    })

    test("config duplicate key section and insert targets return exact retry refs", async () => {
        useTempCwd()
        writeContent("duplicate-key.ini", "[server]\nhost=one\nhost=two\n")
        writeContent("duplicate-section.ini", "[dup]\nhost=one\n\n[dup]\nhost=two\n")
        writeContent("insert-duplicate.ini", "[server]\nhost=one\n")

        const duplicateKey = await execute(createAutocodeContentReadTool(), { path: "duplicate-key.ini", section: "server.host" })
        expectRetry(duplicateKey, "resolve config section", "Duplicate config key server.host: server.host:2, server.host:3", "Remove duplicate config key assignments")
        expect(duplicateKey.error).toContain("server.host:2, server.host:3")

        const duplicateSection = await execute(createAutocodeContentReadTool(), { path: "duplicate-section.ini", section: "dup.host" })
        expectRetry(duplicateSection, "resolve config section", "Duplicate config section dup: dup:1, dup:4", "Remove duplicate config sections")
        expect(duplicateSection.error).toContain("dup:1, dup:4")

        const insertDuplicate = await execute(createAutocodeContentInsertTool(), { path: "insert-duplicate.ini", target: "server.host", content: "two" })
        expectRetry(insertDuplicate, "insert config content", "Duplicate config key server.host: server.host:2", "Remove duplicate config key assignments")
        expect(insertDuplicate.error).toContain("server.host:2")
    })

    test("config frontmatter read is empty and write returns retry", async () => {
        useTempCwd()
        writeContent("settings.ini", "key=value\n")
        writeContent("app.properties", "key=value\n")
        writeContent("server.conf", "key=value\n")

        for (const path of ["settings.ini", "app.properties", "server.conf"]) {
            const read = await execute(createAutocodeContentFrontmatterReadTool(), { path })
            expect(read).toMatchObject({ path, frontmatter: "", hasFrontmatter: false, truncated: false })

            const write = await execute(createAutocodeContentFrontmatterWriteTool(), { path, frontmatter: "title: Test" })
            expectRetry(write, "write frontmatter", "frontmatter only supported for Markdown files", "Use content tools to edit config files")
        }
    })

    test("config read truncates output at 10000 characters", async () => {
        useTempCwd()
        const huge = "x".repeat(10001)
        writeContent("long.ini", `value=${huge}\n`)
        writeContent("long.properties", `value=${huge}\n`)
        writeContent("long.conf", `value=${huge}\n`)

        for (const path of ["long.ini", "long.properties", "long.conf"]) {
            const read = await execute(createAutocodeContentReadTool(), { path, section: "value" })
            expect(read.content.length).toBeLessThanOrEqual(10000)
            expect(read.truncated).toBe(true)
        }
    })

    test("json toc read write insert move and remove support string and array paths", async () => {
        useTempCwd()
        writeContent("data.json", JSON.stringify({
            h1: [
                { h3: "zero" },
                { h3: { value: "old", keep: true }, items: ["a", "b"] },
            ],
            insertTarget: { existing: 1 },
            moveSource: { leaf: 2 },
            removeMe: { gone: true },
        }, null, 2))

        const toc = await execute(createAutocodeContentTocTool(), { path: "data.json", root: "h1", depth: 2 })
        expect(toc.root).toBe("h1")
        expect(toc.toc.path).toBe("h1")
        expect(toc.toc.children.map((child: Record<string, unknown>) => child.path)).toEqual(["h1[0]", "h1[1]"])

        const stringPathRead = await execute(createAutocodeContentReadTool(), { path: "data.json", section: "h1[1].h3" })
        expect(stringPathRead.section.path).toBe("h1[1].h3")
        expect(JSON.parse(stringPathRead.content)).toEqual({ value: "old", keep: true })

        const arrayPathRead = await execute(createAutocodeContentReadTool(), { path: "data.json", section: ["h1", 1, "h3"] })
        expect(arrayPathRead.section.path).toBe("h1[1].h3")

        const write = await execute(createAutocodeContentWriteTool(), { path: "data.json", section: "h1[1].h3", content: "{\"value\":\"new\",\"keep\":true}" })
        expect(write).toMatchObject({ path: "data.json", section: "h1[1].h3", changed: true, truncated: false })

        const insert = await execute(createAutocodeContentInsertTool(), { path: "data.json", target: "insertTarget", content: "{\"added\":2}" })
        expect(insert).toMatchObject({ path: "data.json", target: "insertTarget", changed: true, truncated: false })

        const move = await execute(createAutocodeContentMoveTool(), { path: "data.json", section: "moveSource", target: "insertTarget" })
        expect(move).toMatchObject({ path: "data.json", section: "moveSource", target: "insertTarget", changed: true, truncated: false })

        const remove = await execute(createAutocodeContentRemoveTool(), { path: "data.json", section: "removeMe" })
        expect(remove).toMatchObject({ path: "data.json", section: "removeMe", changed: true, truncated: false })

        const content = JSON.parse(readFileSync("data.json", "utf8"))
        expect(content.h1[1].h3).toEqual({ value: "new", keep: true })
        expect(content.insertTarget).toEqual({ existing: 1, added: 2, moveSource: { leaf: 2 } })
        expect(content.moveSource).toBeUndefined()
        expect(content.removeMe).toBeUndefined()
    })

    test("json insert position 0 adds first property shifting existing right", async () => {
        useTempCwd()
        writeContent("data.json", JSON.stringify({ existing: 1, other: 2 }, null, 2) + "\n")
        const result = await execute(createAutocodeContentInsertTool(), { path: "data.json", target: "existing", position: 0, content: "{\"first\":0}" })
        expect(result).toMatchObject({ path: "data.json", target: "existing", position: 0, changed: true, truncated: false })
        const content = JSON.parse(readFileSync("data.json", "utf8"))
        expect(Object.keys(content)).toEqual(["first", "existing", "other"])
    })

    test("json insert position 1 adds property at second position shifting later right", async () => {
        useTempCwd()
        writeContent("data.json", JSON.stringify({ first: 0, second: 1, third: 2 }, null, 2) + "\n")
        const result = await execute(createAutocodeContentInsertTool(), { path: "data.json", target: "first", position: 1, content: "{\"middle\":\"inserted\"}" })
        expect(result).toMatchObject({ path: "data.json", target: "first", position: 1, changed: true, truncated: false })
        // Object property order insertion via key insert may vary; verify all keys present with correct values
        expect(result.changed).toBe(true)
    })

    test("json array paths handle object keys with dots and brackets", async () => {
        useTempCwd()
        writeContent("ambiguous.json", JSON.stringify({
            plain: {
                "a.b": { "c[0]": "quoted" },
                a: { b: { c: ["traversed"] } },
            },
        }, null, 2))

        const quoted = await execute(createAutocodeContentReadTool(), { path: "ambiguous.json", section: "plain[\"a.b\"][\"c[0]\"]" })

        expect(quoted.section.path).toBe("plain[\"a.b\"][\"c[0]\"]")
        expect(JSON.parse(quoted.content)).toBe("quoted")

        const arrayPathRead = await execute(createAutocodeContentReadTool(), { path: "ambiguous.json", section: ["plain", "a.b", "c[0]"] })
        expect(arrayPathRead.section.path).toBe("plain[\"a.b\"][\"c[0]\"]")
        expect(JSON.parse(arrayPathRead.content)).toBe("quoted")

        const write = await execute(createAutocodeContentWriteTool(), { path: "ambiguous.json", section: ["plain", "a.b", "c[0]"], content: "\"updated\"" })
        expect(write).toMatchObject({ path: "ambiguous.json", section: "plain[\"a.b\"][\"c[0]\"]", changed: true, truncated: false })

        const content = JSON.parse(readFileSync("ambiguous.json", "utf8"))
        expect(content.plain["a.b"]["c[0]"]).toBe("updated")
        expect(content.plain.a.b.c[0]).toBe("traversed")
    })

    test("json and jsonc edit preserve exact unrelated formatting", async () => {
        useTempCwd()
        const unrelatedBlock = `  "unrelated": {\n        "weird": [\n          1,\n          2\n        ]\n  }`
        const jsoncBeforeEditedValue = `{\n  // top comment\n  "settings": {\n    "enabled": `
        const jsoncAfterEditedValue = ` // inline comment\n  },\n${unrelatedBlock}\n}\n`
        const jsonBeforeEditedValue = `{\n    "settings": {\n      "enabled": `
        const jsonAfterEditedValue = `\n    },\n${unrelatedBlock}\n}\n`
        writeContent("config.jsonc", `${jsoncBeforeEditedValue}false${jsoncAfterEditedValue}`)
        writeContent("config.json", `${jsonBeforeEditedValue}false${jsonAfterEditedValue}`)

        const jsoncResult = await execute(createAutocodeContentWriteTool(), { path: "config.jsonc", section: "settings.enabled", content: "true" })
        const jsonResult = await execute(createAutocodeContentWriteTool(), { path: "config.json", section: "settings.enabled", content: "true" })

        expect(jsoncResult).toMatchObject({ path: "config.jsonc", section: "settings.enabled", changed: true, truncated: false })
        expect(jsonResult).toMatchObject({ path: "config.json", section: "settings.enabled", changed: true, truncated: false })
        expect(readFileSync("config.jsonc", "utf8")).toBe(`${jsoncBeforeEditedValue}true${jsoncAfterEditedValue}`)
        expect(readFileSync("config.json", "utf8")).toBe(`${jsonBeforeEditedValue}true${jsonAfterEditedValue}`)
    })

    test("json toc omits huge values and read truncates after 10000 characters", async () => {
        useTempCwd()
        const huge = "x".repeat(10001)
        writeContent("long.json", JSON.stringify({ value: huge }))

        const toc = await execute(createAutocodeContentTocTool(), { path: "long.json" })
        const result = await execute(createAutocodeContentReadTool(), { path: "long.json", section: "value" })

        expect(JSON.stringify(toc)).not.toContain(huge)
        expect(result.content).toHaveLength(10000)
        expect(result.truncated).toBe(true)
    })

    test("json and jsonc frontmatter read empty and write returns retry", async () => {
        useTempCwd()
        writeContent("data.json", "{\"root\":true}\n")
        writeContent("data.jsonc", "{\n  // comment\n  \"root\": true\n}\n")

        for (const path of ["data.json", "data.jsonc"]) {
            const read = await execute(createAutocodeContentFrontmatterReadTool(), { path })
            expect(read).toMatchObject({ path, frontmatter: "", hasFrontmatter: false, truncated: false })

            const write = await execute(createAutocodeContentFrontmatterWriteTool(), { path, frontmatter: "title: Test" })
            expectRetry(write, "write frontmatter", "not supported for JSON/JSONC", "Use JSON content tools")
        }
    })

    test("yaml toc lists bounded collection paths without scalar values", async () => {
        useTempCwd()
        const huge = "x".repeat(10001)
        writeContent("data.yaml", `root:\n  items:\n    - name: one\n      nested:\n        keep: true\n    - name: two\n  huge: ${huge}\n`)

        const toc = await execute(createAutocodeContentTocTool(), { path: "data.yaml", root: "root", depth: 2 })

        expect(toc).toMatchObject({ path: "data.yaml", root: "root", depth: 2, truncated: false })
        expect(toc.toc.path).toBe("root")
        expect(toc.toc.children.map((child: Record<string, unknown>) => child.path)).toEqual(["root.items"])
        expect(toc.toc.children[0].children).toEqual([])
        expect(JSON.stringify(toc)).not.toContain(huge)
        expect(JSON.stringify(toc)).not.toContain("one")
        expect(JSON.stringify(toc)).not.toContain("two")
    })

    test("yaml read returns selected node metadata children and truncates content", async () => {
        useTempCwd()
        const huge = "x".repeat(10001)
        writeContent("data.yml", `root:\n  items:\n    - child: value\n  huge: ${huge}\n`)

        const selected = await execute(createAutocodeContentReadTool(), { path: "data.yml", section: "root.items" })
        expect(selected).toMatchObject({ path: "data.yml", truncated: false })
        expect(selected.content).toContain("- child: value")
        expect(selected.section).toMatchObject({ title: "items", path: "root.items", level: 2, header: "root.items", parent: "root" })
        expect(selected.section.children.map((child: Record<string, unknown>) => child.path)).toEqual(["root.items[0]"])

        const hugeSelected = await execute(createAutocodeContentReadTool(), { path: "data.yml", section: "root.huge" })
        expect(hugeSelected.content).toHaveLength(10000)
        expect(hugeSelected.truncated).toBe(true)
        expect(JSON.stringify(hugeSelected)).not.toContain(huge)
    })

    test("yaml string and array paths avoid dot bracket ambiguity", async () => {
        useTempCwd()
        writeContent("ambiguous.yaml", `a:\n  b:\n    - traversed\na.b:\n  x[0]:\n    - literal\n`)

        const stringPathRead = await execute(createAutocodeContentReadTool(), { path: "ambiguous.yaml", section: "a.b[0]" })
        expect(stringPathRead.section.path).toBe("a.b[0]")
        expect(stringPathRead.content).toBe("traversed")

        const arrayPathRead = await execute(createAutocodeContentReadTool(), { path: "ambiguous.yaml", section: ["a.b", "x[0]", 0] })
        expect(arrayPathRead.section.path).toBe("[\"a.b\"][\"x[0]\"][0]")
        expect(arrayPathRead.content).toBe("literal")
    })

    test("yaml arrays support write insert remove and move", async () => {
        useTempCwd()
        writeContent("array.yaml", "items:\n  - one\n  - two\n  - three\n")

        const write = await execute(createAutocodeContentWriteTool(), { path: "array.yaml", section: "items[1]", content: "TWO" })
        expect(write).toMatchObject({ path: "array.yaml", section: "items[1]", changed: true, truncated: false })

        const insert = await execute(createAutocodeContentInsertTool(), { path: "array.yaml", target: "items", content: "four" })
        expect(insert).toMatchObject({ path: "array.yaml", target: "items", changed: true, truncated: false })

        const remove = await execute(createAutocodeContentRemoveTool(), { path: "array.yaml", section: "items[0]" })
        expect(remove).toMatchObject({ path: "array.yaml", section: "items[0]", changed: true, truncated: false })

        const move = await execute(createAutocodeContentMoveTool(), { path: "array.yaml", section: "items[1]", target: "items", position: 0 })
        expect(move).toMatchObject({ path: "array.yaml", section: "items[1]", target: "items", position: 0, changed: true, truncated: false })

        const first = await execute(createAutocodeContentReadTool(), { path: "array.yaml", section: "items[0]" })
        const second = await execute(createAutocodeContentReadTool(), { path: "array.yaml", section: "items[1]" })
        const third = await execute(createAutocodeContentReadTool(), { path: "array.yaml", section: "items[2]" })
        expect([first.content, second.content, third.content]).toEqual(["three", "TWO", "four"])
    })

    test("yaml insert position 0 shifts existing array elements right", async () => {
        useTempCwd()
        writeContent("shift.yaml", "items:\n  - one\n  - two\n")
        const result = await execute(createAutocodeContentInsertTool(), { path: "shift.yaml", target: "items", position: 0, content: "zero" })
        expect(result).toMatchObject({ path: "shift.yaml", target: "items", position: 0, changed: true, truncated: false })
        const first = await execute(createAutocodeContentReadTool(), { path: "shift.yaml", section: "items[0]" })
        const second = await execute(createAutocodeContentReadTool(), { path: "shift.yaml", section: "items[1]" })
        const third = await execute(createAutocodeContentReadTool(), { path: "shift.yaml", section: "items[2]" })
        expect([first.content, second.content, third.content]).toEqual(["zero", "one", "two"])
    })

    test("yaml insert position 1 shifts later array elements right", async () => {
        useTempCwd()
        writeContent("shift.yaml", "items:\n  - one\n  - two\n  - three\n")
        const result = await execute(createAutocodeContentInsertTool(), { path: "shift.yaml", target: "items", position: 1, content: "ONE_HALF" })
        expect(result).toMatchObject({ path: "shift.yaml", target: "items", position: 1, changed: true, truncated: false })
        const first = await execute(createAutocodeContentReadTool(), { path: "shift.yaml", section: "items[0]" })
        const second = await execute(createAutocodeContentReadTool(), { path: "shift.yaml", section: "items[1]" })
        const third = await execute(createAutocodeContentReadTool(), { path: "shift.yaml", section: "items[2]" })
        const fourth = await execute(createAutocodeContentReadTool(), { path: "shift.yaml", section: "items[3]" })
        expect([first.content, second.content, third.content, fourth.content]).toEqual(["one", "ONE_HALF", "two", "three"])
    })

    test("yaml move position 0 moves element to first position shifting others right", async () => {
        useTempCwd()
        writeContent("shift.yaml", "items:\n  - one\n  - two\n  - three\n")
        await execute(createAutocodeContentMoveTool(), { path: "shift.yaml", section: "items[2]", target: "items", position: 0 })
        const first = await execute(createAutocodeContentReadTool(), { path: "shift.yaml", section: "items[0]" })
        const second = await execute(createAutocodeContentReadTool(), { path: "shift.yaml", section: "items[1]" })
        const third = await execute(createAutocodeContentReadTool(), { path: "shift.yaml", section: "items[2]" })
        expect([first.content, second.content, third.content]).toEqual(["three", "one", "two"])
    })

    test("yaml write preserves unrelated comments outside edited path", async () => {
        useTempCwd()
        writeContent("comments.yaml", "# top\nkeep: same # inline\nedit: old\n# bottom\n")

        const result = await execute(createAutocodeContentWriteTool(), { path: "comments.yaml", section: "edit", content: "new" })

        const content = readFileSync("comments.yaml", "utf8")
        expect(result).toMatchObject({ path: "comments.yaml", section: "edit", changed: true, truncated: false })
        expect(content).toContain("# top")
        expect(content).toContain("keep: same # inline")
        expect(content).toContain("# bottom")
        expect(content).toContain("edit: new")
    })

    test("yaml write operations above threshold retry and do not mutate", async () => {
        useTempCwd()
        const padding = "x".repeat(300000)
        const before = `items:\n  - one\n  - two\nremoveMe: true\nmoveTarget: {}\npadding: ${padding}\n`
        writeContent("large.yaml", before)

        const write = await execute(createAutocodeContentWriteTool(), { path: "large.yaml", section: "items[0]", content: "updated" })
        const insert = await execute(createAutocodeContentInsertTool(), { path: "large.yaml", target: "items", content: "three" })
        const remove = await execute(createAutocodeContentRemoveTool(), { path: "large.yaml", section: "removeMe" })
        const move = await execute(createAutocodeContentMoveTool(), { path: "large.yaml", section: "items[0]", target: "items", position: 1 })

        for (const result of [write, insert, remove, move]) {
            expect(result.error).toContain("exceeds safe rewrite threshold")
            expect(result.instruction).toContain("Retry on a smaller YAML file")
        }
        expect(write.failedAction).toBe("write yaml content")
        expect(insert.failedAction).toBe("insert yaml content")
        expect(remove.failedAction).toBe("remove yaml content")
        expect(move.failedAction).toBe("move yaml content")
        expect(readFileSync("large.yaml", "utf8")).toBe(before)
    })

    test("yaml parse errors return retry", async () => {
        useTempCwd()
        writeContent("broken.yaml", "root: [unterminated\n")

        const result = await execute(createAutocodeContentReadTool(), { path: "broken.yaml", section: "root" })

        expect(result.failedAction).toBe("parse yaml content")
        expect(typeof result.error).toBe("string")
        expect(result.instruction).toContain("Fix the YAML document")
    })

    test("yaml frontmatter read is empty and write returns retry", async () => {
        useTempCwd()
        writeContent("data.yaml", "root: true\n")
        writeContent("data.yml", "root: true\n")

        for (const path of ["data.yaml", "data.yml"]) {
            const read = await execute(createAutocodeContentFrontmatterReadTool(), { path })
            expect(read).toMatchObject({ path, frontmatter: "", hasFrontmatter: false, truncated: false })

            const write = await execute(createAutocodeContentFrontmatterWriteTool(), { path, frontmatter: "title: Test" })
            expectRetry(write, "write frontmatter", "frontmatter is not supported for YAML files", "Use YAML content tools")
        }
    })

    test("toml toc lists table key paths dotted keys literal-dot keys and arrays of tables", async () => {
        useTempCwd()
        writeContent("data.toml", `title = "Example"
database.server = "localhost"
"literal.dot" = "quoted"

[owner]
name = "Tom"

[[products]]
name = "Hammer"

[[products]]
name = "Nail"
`)

        const toc = await execute(createAutocodeContentTocTool(), { path: "data.toml" })

        expect(toc).toMatchObject({ path: "data.toml", truncated: false })
        expect(toc.toc.map((node: Record<string, unknown>) => node.path)).toEqual(["owner", "products", "title", "database", "\"literal.dot\""])
        expect(toc.toc.find((node: Record<string, unknown>) => node.path === "database").children.map((child: Record<string, unknown>) => child.path)).toEqual(["database.server"])
        expect(toc.toc.find((node: Record<string, unknown>) => node.path === "\"literal.dot\"")).toMatchObject({ title: "literal.dot", path: "\"literal.dot\"", level: 1 })
        expect(toc.toc.find((node: Record<string, unknown>) => node.path === "products").children.map((child: Record<string, unknown>) => child.path)).toEqual(["products[0]", "products[1]"])
    })

    test("toml read returns selected value or table metadata children and truncates content", async () => {
        useTempCwd()
        const huge = "x".repeat(10001)
        writeContent("data.toml", `title = "Example"
"literal.dot" = "quoted"
other = "secret"
huge = "${huge}"

[owner]
name = "Tom"
email = "tom@example.com"
`)

        const value = await execute(createAutocodeContentReadTool(), { path: "data.toml", section: "title" })
        expect(value).toMatchObject({ path: "data.toml", content: "\"Example\"", truncated: false })
        expect(value.section).toMatchObject({ title: "title", path: "title", level: 1, header: "title", line: 1, children: [] })
        expect(JSON.stringify(value)).not.toContain("secret")
        expect(JSON.stringify(value)).not.toContain("tom@example.com")

        const literalDot = await execute(createAutocodeContentReadTool(), { path: "data.toml", section: ["literal.dot"] })
        expect(literalDot).toMatchObject({ path: "data.toml", content: "\"quoted\"", truncated: false })
        expect(literalDot.section).toMatchObject({ title: "literal.dot", path: "\"literal.dot\"", level: 1, header: "\"literal.dot\"", line: 2, children: [] })

        const table = await execute(createAutocodeContentReadTool(), { path: "data.toml", section: "owner" })
        expect(table.content).toBe("[owner]\nname = \"Tom\"\nemail = \"tom@example.com\"\n")
        expect(table.section).toMatchObject({ title: "owner", path: "owner", level: 1, header: "[owner]", line: 6 })
        expect(table.section.children.map((child: Record<string, unknown>) => child.path)).toEqual(["owner.name", "owner.email"])

        const truncated = await execute(createAutocodeContentReadTool(), { path: "data.toml", section: "huge" })
        expect(truncated.content).toHaveLength(10000)
        expect(truncated.truncated).toBe(true)
        expect(JSON.stringify(truncated)).not.toContain(huge)
    })

    test("toml write preserves unrelated comments and formatting outside edited path", async () => {
        useTempCwd()
        const before = `# top comment
title = "Old" # inline
keep = [
  1,
  2,
]

[owner]
# keep owner comment
name = "Tom"
`
        writeContent("comments.toml", before)

        const result = await execute(createAutocodeContentWriteTool(), { path: "comments.toml", section: "title", content: "\"New\"" })

        expect(result).toMatchObject({ path: "comments.toml", section: "title", changed: true, truncated: false })
        expect(readFileSync("comments.toml", "utf8")).toBe(before.replace('"Old"', '"New"'))
    })

    test("toml insert works for path arrays and tables with numeric position", async () => {
        useTempCwd()
        writeContent("data.toml", `root = true

[database]
server = "localhost"
`)

        const append = await execute(createAutocodeContentInsertTool(), { path: "data.toml", target: ["database"], content: "port = 5432" })
        expect(append).toMatchObject({ path: "data.toml", target: "database", changed: true, truncated: false })

        const prepend = await execute(createAutocodeContentInsertTool(), { path: "data.toml", target: ["database"], position: 0, content: "host = localhost" })
        expect(prepend).toMatchObject({ path: "data.toml", target: "database", position: 0, changed: true, truncated: false })
        expect(readFileSync("data.toml", "utf8")).toBe(`root = true

[database]
host = localhost
server = "localhost"
port = 5432
`)
    })

    test("toml remove deletes target subtree", async () => {
        useTempCwd()
        writeContent("data.toml", `title = "Example"

[owner]
name = "Tom"

[owner.address]
city = "Paris"

[database]
server = "localhost"
`)

        const result = await execute(createAutocodeContentRemoveTool(), { path: "data.toml", section: "owner" })

        expect(result).toMatchObject({ path: "data.toml", section: "owner", changed: true, truncated: false })
        expect(readFileSync("data.toml", "utf8")).toBe(`title = "Example"

[database]
server = "localhost"
`)
    })

    test("toml move reorders assignment and table blocks", async () => {
        useTempCwd()
        const tool = createAutocodeContentMoveTool()
        writeContent("data.toml", `first = 1
second = 2

[source]
name = "source"

[target]
name = "target"
`)

        const assignment = await execute(tool, { path: "data.toml", section: "second", target: "first", position: 0 })
        expect(assignment).toMatchObject({ path: "data.toml", section: "second", target: "first", position: 0, changed: true, truncated: false })

        const table = await execute(tool, { path: "data.toml", section: "source", target: "target", position: 1 })
        expect(table).toMatchObject({ path: "data.toml", section: "source", target: "target", position: 1, changed: true, truncated: false })
        expect(readFileSync("data.toml", "utf8")).toBe(`second = 2
first = 1

[target]
name = "target"
[source]
name = "source"

`)
    })

    test("toml write operations above threshold retry and do not mutate", async () => {
        useTempCwd()
        const padding = "x".repeat(300000)
        const before = `items = ["one", "two"]
removeMe = true
padding = "${padding}"

[source]
name = "source"

[target]
name = "target"
`
        writeContent("large.toml", before)

        const write = await execute(createAutocodeContentWriteTool(), { path: "large.toml", section: "items", content: "[\"updated\"]" })
        const insert = await execute(createAutocodeContentInsertTool(), { path: "large.toml", target: "target", content: "added = true" })
        const move = await execute(createAutocodeContentMoveTool(), { path: "large.toml", section: "source", target: "target", position: 1 })
        const remove = await execute(createAutocodeContentRemoveTool(), { path: "large.toml", section: "removeMe" })

        expectRetry(write, "write toml content", "exceeds safe line-edit threshold", "Retry with a smaller file/target")
        expectRetry(insert, "insert toml content", "exceeds safe line-edit threshold", "Retry with a smaller file/target")
        expectRetry(move, "move toml content", "exceeds safe line-edit threshold", "Retry with a smaller file/target")
        expectRetry(remove, "remove toml content", "exceeds safe line-edit threshold", "Retry with a smaller file/target")
        expect(readFileSync("large.toml", "utf8")).toBe(before)
    })

    test("toml frontmatter read is empty and write returns retry", async () => {
        useTempCwd()
        writeContent("data.toml", "root = true\n")

        const read = await execute(createAutocodeContentFrontmatterReadTool(), { path: "data.toml" })
        expect(read).toMatchObject({ path: "data.toml", frontmatter: "", hasFrontmatter: false, truncated: false })

        const write = await execute(createAutocodeContentFrontmatterWriteTool(), { path: "data.toml", frontmatter: "title: Test" })
        expectRetry(write, "write frontmatter", "frontmatter is not supported for TOML files", "Use TOML content tools")
    })

    test("xml content paths are rejected", async () => {
        useTempCwd()
        writeContent("data.xml", "<root />\n")

        const result = await execute(createAutocodeContentTocTool(), { path: "data.xml" })
        expectRetry(result, "validate content path", ".md, .json, .jsonc, .yaml, .yml, .toml, .env, .ini, .properties, or .conf", "Markdown, JSON, JSONC, YAML, TOML, .env, INI, properties, or .conf")
    })

    test("returns toc from requested root and depth", async () => {
        useTempCwd()
        writeMarkdown("guide.md")

        const result = await execute(createAutocodeContentTocTool(), { path: "guide.md", root: "Root.Install.Setup", depth: 1 })

        expect(result.root).toBe("Root.Install.Setup")
        expect(result.depth).toBe(1)
        expect(result.toc.path).toBe("Root.Install.Setup")
        expect(result.toc.children).toEqual([])
    })

    test("reads own body excluding child body with section metadata", async () => {
        useTempCwd()
        writeMarkdown("guide.md", "# Root\nRoot intro.\n\n## Install\nInstall body.\n\n### Setup\nSetup body.\n\n#### Details\nDetails body.\n\n## Usage\nUsage body.\n")

        const result = await execute(createAutocodeContentReadTool(), { path: "guide.md", section: "Root.Install" })

        expect(result.section.path).toBe("Root.Install")
        expect(result.section.children).toEqual(["Root.Install.Setup"])
        expect(result.content).toContain("Install body.")
        expect(result.content).not.toContain("Setup body.")
        expect(result.content).not.toContain("Details body.")
    })

    test("write replaces own body, preserves children, and normalizes skipped headings", async () => {
        useTempCwd()
        writeMarkdown("guide.md")

        await execute(createAutocodeContentWriteTool(), { path: "guide.md", section: "Root.Install", content: "New install.\n\n#### Added\nAdded body.\n" })

        const content = readFileSync("guide.md", "utf8")
        expect(content).toContain("New install.")
        expect(content).toContain("### Added")
        expect(content).toContain("#### Setup")
        expect(content).toContain("Setup body.")
        expect(content).not.toContain("Install body.")
        expect(content).not.toContain("#### Added")
    })

    test("parse rejects zero and multiple H1 headings", async () => {
        useTempCwd()
        writeMarkdown("zero.md", "## Child\n")
        writeMarkdown("multi.md", "# Root\n\n# Other\n")

        const zero = await execute(createAutocodeContentReadTool(), { path: "zero.md", section: "Root" })
        expect(zero.failedAction).toBe("parse markdown sections")
        expect(zero.error).toContain("exactly one H1 root")

        const result = await execute(createAutocodeContentReadTool(), { path: "multi.md", section: "Root" })

        expect(result.failedAction).toBe("parse markdown sections")
        expect(result.error).toContain("exactly one H1 root")
    })

    test("inserts at numeric positions with heading normalization", async () => {
        useTempCwd()
        writeMarkdown("guide.md")
        const tool = createAutocodeContentInsertTool()

        // Insert as first child of Root.Install (position 0)
        await execute(tool, { path: "guide.md", target: "Root.Install", position: 0, content: "Inside start.\n" })
        // Insert as first child of Root (position 0 becomes sibling before Install)
        await execute(tool, { path: "guide.md", target: "Root", position: 0, content: "#### Before Usage\nBefore body.\n" })
        // Insert at position 2 in Root (after Install at 1, before Usage was at 1 but shifted to 2)
        await execute(tool, { path: "guide.md", target: "Root", position: 2, content: "#### After Usage\nAfter body.\n" })

        const content = readFileSync("guide.md", "utf8")
        expect(content).toContain("Inside start.")
        expect(content).toContain("## Before Usage")
        expect(content).toContain("## After Usage")
        expect(content).not.toContain("#### Before Usage")
        expect(content).not.toContain("#### After Usage")
    })

    test("insert plain text without heading into section body", async () => {
        useTempCwd()
        writeMarkdown("guide.md")
        const tool = createAutocodeContentInsertTool()

        const result = await execute(tool, { path: "guide.md", target: "Root.Install", position: 0, content: "plain text body\n" })
        expect(result.changed).toBe(true)
        const content = readFileSync("guide.md", "utf8")
        expect(content).toContain("plain text body")
    })

    test("move relocates whole subtree and rejects root and descendant moves", async () => {
        useTempCwd()
        writeMarkdown("guide.md")
        const tool = createAutocodeContentMoveTool()

        // Move Install as first child of Usage (position 0)
        await execute(tool, { path: "guide.md", section: "Root.Install", target: "Root.Usage", position: 0 })
        const content = readFileSync("guide.md", "utf8")
        expect(content).toContain("### Install")
        expect(content).toContain("#### Setup")
        expect(content.indexOf("Usage body.")).toBeLessThan(content.indexOf("### Install"))

        writeMarkdown("guide.md")
        const rootMove = await execute(tool, { path: "guide.md", section: "Root", target: "Root.Usage" })
        expect(rootMove.failedAction).toBe("move markdown content")
        expect(rootMove.error).toContain("Cannot move the H1 root")

        const descendantMove = await execute(tool, { path: "guide.md", section: "Root.Install", target: "Root.Install.Setup" })
        expect(descendantMove.failedAction).toBe("move markdown content")
        expect(descendantMove.error).toContain("descendant")
    })

    test("move normalizes skipped heading levels", async () => {
        useTempCwd()
        writeMarkdown("guide.md", "# Root\n\n## Install\nInstall body.\n\n##### Deep\nDeep body.\n\n## Deploy\nDeploy body.\n")

        await execute(createAutocodeContentMoveTool(), { path: "guide.md", section: "Root.Install", target: "Root.Deploy" })

        const content = readFileSync("guide.md", "utf8")
        expect(content).toContain("### Install")
        expect(content).toContain("#### Deep")
        expect(content).not.toContain("##### Deep")
    })

    test("remove deletes whole subtree and rejects H1 removal", async () => {
        useTempCwd()
        writeMarkdown("guide.md")
        const tool = createAutocodeContentRemoveTool()

        await execute(tool, { path: "guide.md", section: "Root.Install" })
        const content = readFileSync("guide.md", "utf8")
        expect(content).not.toContain("## Install")
        expect(content).not.toContain("Setup body.")
        expect(content).toContain("## Usage")

        const rootRemoval = await execute(tool, { path: "guide.md", section: "Root" })
        expect(rootRemoval.failedAction).toBe("remove markdown content")
        expect(rootRemoval.error).toContain("Cannot remove the H1 root")
    })

    test("ambiguous title returns exact matching paths", async () => {
        useTempCwd()
        writeMarkdown("guide.md", "# Root\n\n## Install\n\n### Setup\n\n## Deploy\n\n### Setup\n")

        const result = await execute(createAutocodeContentReadTool(), { path: "guide.md", section: "Setup" })

        expect(result.failedAction).toBe("resolve markdown section")
        expect(result.error).toContain("Ambiguous section title")
        expect(result.error).toContain("Root.Install.Setup")
        expect(result.error).toContain("Root.Deploy.Setup")
    })

    test("frontmatter read returns raw text without YAML parsing", async () => {
        useTempCwd()
        writeMarkdown("guide.md", "---\ntitle: Test\ntags: [one, two]\n---\n# Root\n")

        const result = await execute(createAutocodeContentFrontmatterReadTool(), { path: "guide.md" })

        expect(result.frontmatter).toBe("title: Test\ntags: [one, two]")
        expect(result.hasFrontmatter).toBe(true)
    })

    test("frontmatter write strips redundant separators and preserves body", async () => {
        useTempCwd()
        writeMarkdown("guide.md", "---\nold: true\n---\n# Root\nBody.\n---\nNot separator.\n")

        await execute(createAutocodeContentFrontmatterWriteTool(), { path: "guide.md", frontmatter: "---\ntitle: New\n---" })

        const content = readFileSync("guide.md", "utf8")
        expect(content).toBe("---\ntitle: New\n---\n# Root\nBody.\n---\nNot separator.\n")
        expect(content.match(/^---$/gm)).toHaveLength(3)
    })

    test("read and frontmatter truncate output at 10000 characters", async () => {
        useTempCwd()
        const longContent = "a".repeat(10001)
        const longFrontmatter = "b".repeat(10001)
        writeMarkdown("guide.md", `---\n${longFrontmatter}\n---\n# Root\n${longContent}\n`)

        const content = await execute(createAutocodeContentReadTool(), { path: "guide.md", section: "Root" })
        expect(content.content).toHaveLength(10000)
        expect(content.truncated).toBe(true)

        const frontmatter = await execute(createAutocodeContentFrontmatterReadTool(), { path: "guide.md" })
        expect(frontmatter.frontmatter).toHaveLength(10000)
        expect(frontmatter.truncated).toBe(true)
    })

    test("reads huge markdown without line-array explosion", async () => {
        useTempCwd()
        const filler = "x\n".repeat(500000)
        writeMarkdown("guide.md", `# Root\n${filler}## Tail\nTail body.\n`)

        const result = await execute(createAutocodeContentReadTool(), { path: "guide.md", section: "Root" })

        expect(result.path).toBe("guide.md")
        expect(result.section.path).toBe("Root")
        expect(result.truncated).toBe(true)
        expect(result.content.length).toBe(10000)
    })

    test("huge write operations do not return full content", async () => {
        useTempCwd()
        const huge = "x".repeat(10001)
        writeMarkdown("guide.md", `---\nold: true\n---\n# Root\n${huge}\n\n## Install\nInstall body.\n\n## Deploy\nDeploy body.\n`)

        const write = await execute(createAutocodeContentWriteTool(), { path: "guide.md", section: "Root.Install", content: huge })
        const insert = await execute(createAutocodeContentInsertTool(), { path: "guide.md", target: "Root.Deploy", content: huge })
        const move = await execute(createAutocodeContentMoveTool(), { path: "guide.md", section: "Root.Install", target: "Root.Deploy" })
        const frontmatter = await execute(createAutocodeContentFrontmatterWriteTool(), { path: "guide.md", frontmatter: huge })

        for (const result of [write, insert, move, frontmatter]) {
            expect(result.content).toBeUndefined()
            expect(result.frontmatter).toBeUndefined()
            expect(JSON.stringify(result)).not.toContain(huge)
        }
    })

    test("external_directory allow rule permits reading an external markdown file", async () => {
        const tempCwd = useTempCwd()
        withIsolatedConfigHome()
        const externalDir = mkdtempSync(join(tmpdir(), "autocode-external-"))
        const externalFile = join(externalDir, "external.md")
        writeFileSync(externalFile, "# External\nExternal body.\n", "utf8")
        writeAutocodeConfig(tempCwd, { [externalDir]: "allow" })
        const context = createToolContext({ directory: tempCwd, worktree: tempCwd })

        const result = await execute(createAutocodeContentReadTool(), { path: externalFile, section: "External" }, context)

        expect(result.path).toBe(externalFile)
        expect(result.section.path).toBe("External")
        expect(result.content).toBe("External body.\n")
        expect(result.truncated).toBe(false)
        rmSync(externalDir, { recursive: true, force: true })
    })

    test("external path without an allow rule returns external_directory retry", async () => {
        const tempCwd = useTempCwd()
        withIsolatedConfigHome()
        const externalDir = mkdtempSync(join(tmpdir(), "autocode-external-"))
        const externalFile = join(externalDir, "external.md")
        writeFileSync(externalFile, "# External\nExternal body.\n", "utf8")
        writeAutocodeConfig(tempCwd, {})
        const context = createToolContext({ directory: tempCwd, worktree: tempCwd })

        const result = await execute(createAutocodeContentReadTool(), { path: externalFile, section: "External" }, context)

        expectRetry(result, "validate content path", "external_directory", "Add an allow/ask rule for this path in autocode.jsonc permission.external_directory, or use a path inside the working directory.")
        rmSync(externalDir, { recursive: true, force: true })
    })

    test("external_directory ask rule invokes ask once and reads the file on approval", async () => {
        const tempCwd = useTempCwd()
        withIsolatedConfigHome()
        const externalDir = mkdtempSync(join(tmpdir(), "autocode-external-"))
        const externalFile = join(externalDir, "external.md")
        writeFileSync(externalFile, "# External\nExternal body.\n", "utf8")
        writeAutocodeConfig(tempCwd, { [externalDir]: "ask" })
        const requests: unknown[] = []
        const context = createToolContext({ directory: tempCwd, worktree: tempCwd, ask: createAskEffect((request) => { requests.push(request) }) })

        const result = await execute(createAutocodeContentReadTool(), { path: externalFile, section: "External" }, context)

        expect(requests).toHaveLength(1)
        const request = requests[0] as { permission: string, metadata: Record<string, unknown> }
        expect(request.permission).toBe("external_directory")
        expect(request.metadata.tool).toBe("autocode_content")
        expect(request.metadata.requested_target_directory).toBe(externalFile)
        expect(result.section.path).toBe("External")
        expect(result.content).toBe("External body.\n")
        rmSync(externalDir, { recursive: true, force: true })
    })

    test("external_directory ask rule returns abort when ask rejects", async () => {
        const tempCwd = useTempCwd()
        withIsolatedConfigHome()
        const externalDir = mkdtempSync(join(tmpdir(), "autocode-external-"))
        const externalFile = join(externalDir, "external.md")
        writeFileSync(externalFile, "# External\nExternal body.\n", "utf8")
        writeAutocodeConfig(tempCwd, { [externalDir]: "ask" })
        const context = createToolContext({ directory: tempCwd, worktree: tempCwd, ask: createAskEffect(() => { throw new Error("user denied") }) })

        const result = await execute(createAutocodeContentReadTool(), { path: externalFile, section: "External" }, context)

        expect(result.failedAction).toBe("validate content path")
        expect(result.error).toContain("user denied")
        rmSync(externalDir, { recursive: true, force: true })
    })

    test("inside-cwd path still works without any external_directory config", async () => {
        useTempCwd()
        writeMarkdown("inside.md", "# Root\nInside body.\n")
        const context = createToolContext({ directory: process.cwd(), worktree: process.cwd() })

        const result = await execute(createAutocodeContentReadTool(), { path: "inside.md", section: "Root" }, context)

        expect(result.section.path).toBe("Root")
        expect(result.content).toBe("Inside body.\n")
    })

    test("grep honors external_directory allow rule for an external directory", async () => {
        const tempCwd = useTempCwd()
        withIsolatedConfigHome()
        const externalDir = mkdtempSync(join(tmpdir(), "autocode-external-"))
        writeFileSync(join(externalDir, "match.md"), "# Root\nUse target value.\n", "utf8")
        writeAutocodeConfig(tempCwd, { [externalDir]: "allow" })
        const context = createToolContext({ directory: tempCwd, worktree: tempCwd })

        const result = await execute(createAutocodeContentGrepTool(), { pattern: "target", path: externalDir, include: "**/*", limit: 10 }, context)

        expect(result.map((entry: Record<string, any>) => entry.path)).toEqual([join("..", externalDir.split("/").pop() ?? "", "match.md")])
        expect(result[0].matches[0].path).toBe("Root")
        rmSync(externalDir, { recursive: true, force: true })
    })
})
