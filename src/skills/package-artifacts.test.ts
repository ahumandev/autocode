import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
    createSkillBundleManifest,
    loadSkillBundleManifest,
    verifySkillBundleManifest,
    writeSkillBundleManifest,
} from "../../scripts/skill-bundle"

const repositoryRoot = join(import.meta.dir, "..", "..")
const temporaryRoots: string[] = []

type CommandResult = {
    exitCode: number
    output: string
}

type PackageMetadata = {
    main?: string
    types?: string
    private?: boolean
    publishConfig?: { access?: string }
    files?: string[]
}

type PackageMetadataCase = [
    name: string,
    update: (metadata: PackageMetadata) => void,
    expectedOutput: string,
]

const packageMetadataCases: PackageMetadataCase[] = [
    ["missing main", (metadata): void => { delete metadata.main }, "Expected main to be ./dist/plugin.js, got undefined"],
    ["inconsistent main", (metadata): void => { metadata.main = "./dist/index.js" }, "Expected main to be ./dist/plugin.js, got ./dist/index.js"],
    ["missing types", (metadata): void => { delete metadata.types }, "Expected types to be ./dist/plugin.d.ts, got undefined"],
    ["inconsistent types", (metadata): void => { metadata.types = "./dist/index.d.ts" }, "Expected types to be ./dist/plugin.d.ts, got ./dist/index.d.ts"],
    ["missing private", (metadata): void => { delete metadata.private }, "Expected package to be publishable with private set to false"],
    ["inconsistent private", (metadata): void => { metadata.private = true }, "Expected package to be publishable with private set to false"],
    ["missing publishConfig.access", (metadata): void => { delete metadata.publishConfig }, "Expected publishConfig.access to be public"],
    ["inconsistent publishConfig.access", (metadata): void => { metadata.publishConfig = { access: "restricted" } }, "Expected publishConfig.access to be public"],
    ["missing files", (metadata): void => { delete metadata.files }, "Expected package files to include dist"],
    ["inconsistent files", (metadata): void => { metadata.files = ["src"] }, "Expected package files to include dist"],
]

function sha256(content: string): string {
    return createHash("sha256").update(content).digest("hex")
}

async function createTemporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(repositoryRoot, ".autocode-package-artifacts-"))
    temporaryRoots.push(root)
    return root
}

async function runScript(root: string, script: string): Promise<CommandResult> {
    const child = Bun.spawn({
        cmd: [process.execPath, join(root, "scripts", script)],
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ])
    return { exitCode, output: `${stdout}${stderr}` }
}

async function writeFixtureFile(root: string, relativePath: string, content: string): Promise<void> {
    const path = join(root, relativePath)
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(path, content)
}

async function createScriptFixture(): Promise<string> {
    const root = await createTemporaryRoot()
    await cp(join(repositoryRoot, "scripts"), join(root, "scripts"), { recursive: true })
    await mkdir(join(root, "src", "skills"), { recursive: true })
    await mkdir(join(root, "src", "utils"), { recursive: true })
    await cp(join(repositoryRoot, "src", "skills", "github.ts"), join(root, "src", "skills", "github.ts"))
    await cp(join(repositoryRoot, "src", "utils", "github.ts"), join(root, "src", "utils", "github.ts"))
    await writeFixtureFile(root, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }))
    return root
}

async function createArtifactFixture(): Promise<string> {
    const root = await createScriptFixture()
    const skillContent = "# Fixture skill\n"
    const legalContent = "Fixture license\n"
    await writeFixtureFile(root, "package.json", JSON.stringify({
        main: "./dist/plugin.js",
        types: "./dist/plugin.d.ts",
        private: false,
        publishConfig: { access: "public" },
        files: ["dist"],
    }))
    await writeFixtureFile(root, "src/skills/github.jsonc", JSON.stringify({
        skills: [{
            sourceUrl: "https://github.com/acme/widgets",
            resolvedCommit: "a".repeat(40),
            relativeInstallPath: "github/acme/widgets/example",
            category: "code",
            sha256: sha256(skillContent),
            legalFiles: [{ relativePath: "LICENSE", sha256: sha256(legalContent) }],
        }],
    }))
    await writeFixtureFile(root, "src/skills/github/acme/widgets/example/SKILL.md", skillContent)
    await writeFixtureFile(root, "src/skills/github/acme/widgets/LICENSE", legalContent)
    await writeFixtureFile(root, "src/skills/builtin/references/support.md", "Built-in support asset\n")
    await writeFixtureFile(root, "src/skills/builtin/ignored.test.ts", "export {}\n")
    await writeFixtureFile(root, "dist/plugin.js", "export {}\n")
    await writeFixtureFile(root, "dist/plugin.d.ts", "export {}\n")
    const copied = await runScript(root, "copy-skill-sources.ts")
    expect(copied.exitCode).toBe(0)
    return root
}

afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })))
})

describe("package skill artifacts", () => {
    test("copies built-in support assets into a valid bundle", async () => {
        const root = await createArtifactFixture()

        expect(await Bun.file(join(root, "dist", "skills", "builtin", "references", "support.md")).text()).toBe("Built-in support asset\n")
        expect(await Bun.file(join(root, "dist", "skills", "builtin", "ignored.test.ts")).exists()).toBe(false)
        await expect(verifySkillBundleManifest(join(root, "dist", "skills"))).resolves.toEqual(await createSkillBundleManifest(join(root, "dist", "skills")))
    })

    test("accepts GitHub provenance and required legal layout in package artifacts", async () => {
        const root = await createArtifactFixture()
        const verified = await runScript(root, "verify-package-artifacts.ts")

        expect(verified.exitCode).toBe(0)
    })

    test.each(packageMetadataCases)("rejects %s package metadata", async (_name, update, expectedOutput) => {
        const root = await createArtifactFixture()
        const packageJsonPath = join(root, "package.json")
        const metadata = JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageMetadata
        update(metadata)
        await writeFixtureFile(root, "package.json", JSON.stringify(metadata))

        const verified = await runScript(root, "verify-package-artifacts.ts")

        expect(verified.exitCode).not.toBe(0)
        expect(verified.output).toContain(expectedOutput)
    })

    test("rejects a missing GitHub skill tree", async () => {
        const root = await createArtifactFixture()
        await writeFixtureFile(root, "dist/skills/github.jsonc", JSON.stringify({ skills: [] }))
        await rm(join(root, "dist", "skills", "github"), { recursive: true, force: true })
        await writeSkillBundleManifest(join(root, "dist", "skills"))

        const verified = await runScript(root, "verify-package-artifacts.ts")

        expect(verified.exitCode).not.toBe(0)
        expect(verified.output).toContain("Missing GitHub skill tree")
    })

    test("rejects missing legal notices and changed bundle files", async () => {
        const missingLegalRoot = await createArtifactFixture()
        await unlink(join(missingLegalRoot, "dist", "skills", "github", "acme", "widgets", "LICENSE"))
        await writeSkillBundleManifest(join(missingLegalRoot, "dist", "skills"))
        const missingLegal = await runScript(missingLegalRoot, "verify-package-artifacts.ts")

        expect(missingLegal.exitCode).not.toBe(0)
        expect(missingLegal.output).toContain("cannot read legal file")

        const changedFileRoot = await createArtifactFixture()
        await writeFixtureFile(changedFileRoot, "dist/skills/builtin/references/support.md", "Changed asset\n")
        const changedFile = await runScript(changedFileRoot, "verify-package-artifacts.ts")

        expect(changedFile.exitCode).not.toBe(0)
        expect(changedFile.output).toContain("file inventory or SHA-256 digest does not match bundle")
    })

    test("rejects malformed and inconsistent bundle manifests", async () => {
        const malformedRoot = await createArtifactFixture()
        await writeFixtureFile(malformedRoot, "dist/skills/.bundle-manifest.json", "not JSON\n")

        await expect(loadSkillBundleManifest(join(malformedRoot, "dist", "skills", ".bundle-manifest.json"))).rejects.toThrow("malformed JSON")

        const inconsistentRoot = await createArtifactFixture()
        const manifestPath = join(inconsistentRoot, "dist", "skills", ".bundle-manifest.json")
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { directories: string[], files: unknown[] }
        manifest.files.pop()
        await writeFixtureFile(inconsistentRoot, "dist/skills/.bundle-manifest.json", `${JSON.stringify(manifest)}\n`)
        const verified = await runScript(inconsistentRoot, "verify-package-artifacts.ts")

        expect(verified.exitCode).not.toBe(0)
        expect(verified.output).toContain("file inventory or SHA-256 digest does not match bundle")
    })
})
