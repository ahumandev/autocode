import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { enumerateAutocodeConfigCandidates, loadAutocodeConfig, loadAutocodeConfigDetails } from "../config"
import type { PermissionRule } from "../utils/permissions"
import { readSettings, settingsRevision, settingsScopeId, updateSettings, type SettingsPatch } from "./settings"

describe("shared config loader filesystem integration", () => {
    let root: string
    let global: string
    let worktree: string
    let intermediate: string
    let active: string
    let previousConfig: string | undefined
    let previousXdg: string | undefined
    let previousHome: string | undefined
    let previousUserProfile: string | undefined

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "autocode-settings-"))
        global = join(root, "global")
        worktree = join(root, "worktree")
        intermediate = join(worktree, "packages")
        active = join(intermediate, "app")
        previousConfig = process.env.OPENCODE_CONFIG_DIR
        previousXdg = process.env.XDG_CONFIG_HOME
        previousHome = process.env.HOME
        previousUserProfile = process.env.USERPROFILE
        process.env.OPENCODE_CONFIG_DIR = global
        process.env.XDG_CONFIG_HOME = join(root, "xdg")
        process.env.HOME = root
        process.env.USERPROFILE = root
        mkdirSync(active, { recursive: true })
    })

    function restoreEnvironment(): void {
        if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR
        else process.env.OPENCODE_CONFIG_DIR = previousConfig
        if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = previousXdg
        if (previousHome === undefined) delete process.env.HOME
        else process.env.HOME = previousHome
        if (previousUserProfile === undefined) delete process.env.USERPROFILE
        else process.env.USERPROFILE = previousUserProfile
    }

    afterEach(() => {
        restoreEnvironment()
        rmSync(root, { recursive: true, force: true })
    })

    function write(path: string, raw: string): void {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, raw)
    }

    function writeDocument(path: string, document: unknown): void {
        write(path, JSON.stringify(document))
    }

    function local(directory: string): string {
        return join(directory, ".opencode", "autocode.jsonc")
    }

    function snapshot(directory: string): string[] {
        return readdirSync(directory, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name))
            .flatMap((entry): string[] => {
                const path = join(directory, entry.name)
                return entry.isDirectory() ? [`directory:${path}`, ...snapshot(path)] : [`file:${path}:${readFileSync(path).toString("base64")}`]
            })
    }

    async function details(): Promise<Awaited<ReturnType<typeof loadAutocodeConfigDetails>>> {
        const before = snapshot(root)
        const result = await loadAutocodeConfigDetails({ worktree, directory: active })
        expect(snapshot(root)).toEqual(before)
        return result
    }

    async function ordinary(): Promise<Awaited<ReturnType<typeof loadAutocodeConfig>>> {
        const before = snapshot(root)
        const result = await loadAutocodeConfig(worktree, active)
        expect(snapshot(root)).toEqual(before)
        return result
    }

    test.serial("reports missing candidates and synthetic defaults without creating files", async () => {
        const result = await details()
        const candidates = enumerateAutocodeConfigCandidates({ worktree, directory: active })
        expect(candidates).toEqual([
            { path: join(global, "autocode.jsonc"), scopeRoot: global, roles: ["global"], kind: "autocode" },
            { path: local(worktree), scopeRoot: worktree, roles: ["worktree"], kind: "autocode" },
            { path: local(intermediate), scopeRoot: intermediate, roles: ["intermediate"], kind: "autocode" },
            { path: local(active), scopeRoot: active, roles: ["active"], kind: "autocode" },
        ])
        expect(result.candidates).toEqual(candidates.map((candidate) => ({ ...candidate, state: "missing" })))
        expect(result.failure).toBeUndefined()
        expect(result.config?.skills).toEqual({ freeze: false })
        expect(result.config?.memory.directory).toBe(".opencode/autocode/memory")
        expect(result.config?.credentials).toEqual({ provider: "auto" })
        expect(result.config?.tiers).toEqual({})
        expect(result.trace).toEqual([])
        expect(result.tierSources).toEqual([])
    })

    test.serial("applies JSONC priority and global then all local OpenCode then AutoCode precedence", async () => {
        const globalJsonc = join(global, "opencode.jsonc")
        const globalJson = join(global, "opencode.json")
        const globalAuto = join(global, "autocode.jsonc")
        const worktreeOpen = join(worktree, "opencode.jsonc")
        const intermediateOpen = join(intermediate, "opencode.json")
        const activeOpen = join(active, "opencode.jsonc")
        const raw = '{\n  // preserved comment\n  "autocode": { "skills": {}, "memory": { "directory": "global-auto" }, },\n}\n'
        writeDocument(globalJson, { autocode: { memory: { directory: "global-json" } } })
        writeDocument(globalJsonc, { autocode: { memory: { directory: "global-jsonc" } } })
        write(globalAuto, raw)
        writeDocument(worktreeOpen, { autocode: { memory: { directory: "worktree-open" } } })
        writeDocument(join(worktree, "opencode.json"), { autocode: { memory: { directory: "ignored-json" } } })
        writeDocument(intermediateOpen, { autocode: { memory: { directory: "intermediate-open" } } })
        writeDocument(activeOpen, { autocode: { memory: { directory: "active-open" } } })
        expect((await details()).config?.memory.directory).toBe("active-open")
        writeDocument(local(worktree), { autocode: { memory: { directory: "worktree-auto" } } })
        expect((await details()).config?.memory.directory).toBe("worktree-auto")
        writeDocument(local(intermediate), { autocode: { memory: { directory: "intermediate-auto" } } })
        writeDocument(local(active), { autocode: { memory: { directory: "active-auto" } } })

        const result = await details()
        expect(result.config?.memory.directory).toBe("active-auto")
        expect(result.candidates[0]).toEqual({
            path: globalAuto, scopeRoot: global, roles: ["global"], kind: "autocode", state: "valid",
            raw, bytes: Buffer.from(raw), document: { autocode: { skills: {}, memory: { directory: "global-auto" } } },
        })
        expect(result.candidates.map((candidate) => candidate.state)).toEqual(["valid", "valid", "valid", "valid"])
        expect(result.trace.filter((event) => event.target.join(".") === "memory.directory").map((event) => event.origin?.file)).toEqual([
            globalJsonc, globalAuto, worktreeOpen, intermediateOpen, activeOpen, local(worktree), local(intermediate), local(active),
        ])
        expect(result.trace).toContainEqual({
            target: ["memory", "directory"], action: "set",
            origin: { file: local(active), path: ["autocode", "memory", "directory"] },
        })
        expect(result.config).toEqual(await ordinary())
        rmSync(globalJsonc)
        const fallback = await details()
        expect(fallback.trace[0]?.origin?.file).toBe(globalJson)
    })

    test.serial("tracks direct, provider, and legacy tier precedence and origins", async () => {
        const globalOpen = join(global, "opencode.jsonc")
        const globalAuto = join(global, "autocode.jsonc")
        const worktreeOpen = join(worktree, "opencode.json")
        const activeOpen = join(active, "opencode.jsonc")
        writeDocument(globalOpen, { autocode: { tiers: { acme: { cheap: { model: "provider", variant: "original" } } } } })
        writeDocument(globalAuto, { autocode: { skills: {}, tiers: { cheap: { model: "direct", variant: "direct-variant" }, acme: { cheap: { variant: "provider-variant" } } } } })
        let result = await details()
        expect(result.config?.tiers.cheap).toEqual({ model: "direct", variant: "direct-variant" })
        expect(result.tierResolution?.selectedProvider).toBeUndefined()
        expect(result.tierResolution?.providerTiers.acme?.cheap).toEqual({ model: "provider", variant: "provider-variant" })

        writeDocument(worktreeOpen, { autocode: { tier: "acme" } })
        writeDocument(activeOpen, { autocode: { tiers: { acme: { cheap: { model: "updated-provider" } } } } })
        result = await details()
        expect(result.config?.tiers.cheap).toEqual({ model: "updated-provider", variant: "provider-variant" })
        expect(result.tierResolution?.selectedProviderOrigin).toEqual({ file: worktreeOpen, path: ["autocode", "tier"] })
        expect(result.trace).toContainEqual({
            target: ["tiers", "cheap", "variant"], action: "replace",
            origin: { file: globalAuto, path: ["autocode", "tiers", "acme", "cheap", "variant"] },
            cause: { file: activeOpen, path: ["autocode", "tiers", "acme"] },
        })

        writeDocument(local(worktree), { autocode: { model: { cheap: "legacy" } } })
        result = await details()
        expect(result.config?.tiers.cheap).toEqual({ model: "legacy", variant: undefined })
        expect(result.trace).toContainEqual({
            target: ["tiers", "cheap", "variant"], action: "clear",
            cause: { file: local(worktree), path: ["autocode", "model", "cheap"] },
        })
        writeDocument(local(intermediate), { autocode: { tiers: { cheap: { variant: "direct-final" } }, model: { cheap: "ignored" } } })
        result = await details()
        expect(result.config?.tiers.cheap).toEqual({ model: "legacy", variant: "direct-final" })
        expect(result.trace).toContainEqual({
            target: ["tiers", "cheap", "model"], action: "ignored",
            origin: { file: local(intermediate), path: ["autocode", "model", "cheap"] },
        })
        expect(result.tierSources).toContainEqual({
            file: local(intermediate), tiers: { cheap: { variant: "direct-final" } }, model: { cheap: "ignored" },
        })
        writeDocument(local(active), { autocode: { tier: "acme" } })
        result = await details()
        expect(result.config?.tiers.cheap).toEqual({ model: "updated-provider", variant: "provider-variant" })
        expect(result.config).toEqual(await ordinary())
    })

    test.serial("merges sandbox and ordered external directory permissions with provenance", async () => {
        const globalAuto = join(global, "autocode.jsonc")
        const globalRules = [
            { action: "external_directory", resource: "shared/*", effect: "deny" },
            { action: "external_directory", resource: "global/*", effect: "allow" },
        ] satisfies PermissionRule[]
        const localRules = [
            { action: "external_directory", resource: "shared/*", effect: "ask" },
            { action: "read", resource: "ignored/*", effect: "allow" },
            { action: "external_directory", resource: "local/*", effect: "allow" },
            { action: "external_directory", resource: "shared/*", effect: "allow" },
        ] satisfies PermissionRule[]
        writeDocument(globalAuto, { autocode: { skills: {}, sandbox: { sync_method: "copy", distro: { cache_path: "cache", expire: 30 } } }, permissions: globalRules })
        writeDocument(local(intermediate), { autocode: { sandbox: { sync_method: "overlayfs", distro: { expire: "2d" } } }, permissions: localRules })
        writeDocument(local(active), { autocode: { sandbox: { sync_method: "invalid" } } })
        const result = await details()
        expect(result.config?.sandbox).toEqual({ sync_method: "overlayfs", distro_cache_path: "cache", distro_expire: "2d" })
        expect(result.config?.externalDirectoryPermissions).toEqual([...globalRules, localRules[0], localRules[2], localRules[3]])
        expect(Object.entries(result.config?.externalDirectories ?? {})).toEqual([
            ["global/*", "allow"], ["local/*", "allow"], ["shared/*", "allow"],
        ])
        expect(result.trace).toContainEqual({
            target: ["externalDirectories", "shared/*"], action: "replace",
            origin: { file: local(intermediate), path: ["permissions", 3, "effect"] },
            permission: { resource: "shared/*", effect: "allow" },
        })
        expect(result.trace).toContainEqual({
            target: ["sandbox", "distro_expire"], action: "set",
            origin: { file: local(intermediate), path: ["autocode", "sandbox", "distro", "expire"] },
        })
        expect(result.config).toEqual(await ordinary())
    })

    test.serial("reports malformed JSONC and preserves raw candidate bytes", async () => {
        const globalAuto = join(global, "autocode.jsonc")
        const broken = local(intermediate)
        const raw = '{ "autocode": { // missing value\n "tier": } }'
        writeDocument(globalAuto, { autocode: { skills: {} } })
        write(broken, raw)
        writeDocument(local(active), { autocode: { memory: { directory: "later" } } })
        const result = await details()
        expect(result.failure).toEqual({ kind: "invalid", file: broken })
        expect(result.config).toBeUndefined()
        expect(result.tierResolution).toBeUndefined()
        expect(result.candidates[2]).toEqual({
            path: broken, scopeRoot: intermediate, roles: ["intermediate"], kind: "autocode",
            state: "invalid", raw, bytes: Buffer.from(raw),
        })
        expect(result.candidates[3]?.state).toBe("valid")
        const before = snapshot(root)
        await expect(loadAutocodeConfig(worktree, active)).rejects.toThrow(`autocode: malformed JSONC in ${broken}:`)
        expect(snapshot(root)).toEqual(before)
    })

    test.serial("reports default skill seeding without changing an existing global document", async () => {
        const globalAuto = join(global, "autocode.jsonc")
        const raw = '{ "autocode": { "sandbox": { "sync_method": "copy" } } }\n'
        write(globalAuto, raw)
        const result = await details()
        expect(result.config?.skills).toEqual({ freeze: false })
        expect(result.trace).toContainEqual({
            target: ["skills", "freeze"], action: "set",
            cause: { file: globalAuto, path: ["autocode", "skills"] },
        })
        expect(readFileSync(globalAuto, "utf8")).toBe(raw)
    })

    test.serial("prefers OPENCODE_CONFIG_DIR over an isolated XDG config root", async () => {
        const globalAuto = join(global, "autocode.jsonc")
        const xdgAuto = join(root, "xdg", "opencode", "autocode.jsonc")
        writeDocument(globalAuto, { autocode: { skills: {}, tier: "acme", tiers: { acme: { cheap: { model: "global-provider" } } } } })
        writeDocument(xdgAuto, { autocode: { skills: {}, tiers: { cheap: { model: "xdg" } } } })
        const result = await details()
        expect(result.config?.tiers.cheap).toEqual({ model: "global-provider" })
        expect(result.tierResolution?.selectedProviderOrigin).toEqual({ file: globalAuto, path: ["autocode", "tier"] })
        expect(result.candidates[0]?.path).toBe(globalAuto)
        expect(result.config).toEqual(await ordinary())
    })

    test.serial("deduplicates worktree and active candidate roles", () => {
        expect(enumerateAutocodeConfigCandidates({ worktree, directory: worktree })).toEqual([
            { path: join(global, "autocode.jsonc"), scopeRoot: global, roles: ["global"], kind: "autocode" },
            { path: local(worktree), scopeRoot: worktree, roles: ["worktree", "active"], kind: "autocode" },
        ])
    })

    test.serial("projects settings scopes, effective values, and permission origins without writes", async () => {
        const globalOpen = join(global, "opencode.jsonc")
        const globalAuto = join(global, "autocode.jsonc")
        const activeAuto = local(active)
        writeDocument(globalOpen, { autocode: { memory: { directory: "open" } } })
        write(globalAuto, '{ // retained\n "autocode": { "skills": {}, "memory": { "directory": "global" } }, "permissions": [{ "action": "external_directory", "resource": "shared/*", "effect": "deny" }] }\n')
        writeDocument(local(worktree), { autocode: { model: { cheap: "legacy" }, variant: { cheap: "legacy-variant" } } })
        writeDocument(activeAuto, {
            autocode: { tiers: { cheap: { model: "active" } }, memory: { directory: "active" } },
            permissions: [{ action: "read", resource: "*", effect: "allow" }, { action: "external_directory", resource: "shared/*", effect: "allow" }],
        })
        const before = snapshot(root)
        const result = await readSettings({ worktree, directory: active })
        expect(snapshot(root)).toEqual(before)
        expect(result.issue).toBeUndefined()
        expect(result.scopes.map((scope) => scope.state)).toEqual(["valid", "valid", "missing", "valid"])
        expect(result.scopes[0]?.id).toBe(settingsScopeId(globalAuto))
        expect(result.scopes[0]?.revision).toBe(settingsRevision(globalAuto, readFileSync(globalAuto)))
        expect(result.scopes[2]?.revision).toBe(settingsRevision(local(intermediate), null))
        expect(result.scopes[1]?.values ?? []).toContainEqual({ path: ["autocode", "model", "cheap"], value: "legacy", legacy: "overridden" })
        expect(result.scopes[1]?.values ?? []).toContainEqual({ path: ["autocode", "variant", "cheap"], value: "legacy-variant", legacy: "used" })
        expect(result.scopes[3]?.permissionCount).toBe(2)
        expect(result.scopes[3]?.externalDirectory).toEqual([{ index: 1, resource: "shared/*", effect: "allow" }])
        expect(result.effective?.values ?? []).toContainEqual({
            path: ["autocode", "memory", "directory"], value: "active",
            source: { file: activeAuto, path: ["autocode", "memory", "directory"], scopeId: settingsScopeId(activeAuto) },
            overridden: [
                { file: globalOpen, path: ["autocode", "memory", "directory"], scopeId: null },
                { file: globalAuto, path: ["autocode", "memory", "directory"], scopeId: settingsScopeId(globalAuto) },
            ],
        })
        expect(result.effective?.externalDirectory).toEqual([
            { resource: "shared/*", effect: "deny", source: { file: globalAuto, path: ["permissions", 0], scopeId: settingsScopeId(globalAuto) }, overridden: [] },
            {
                resource: "shared/*", effect: "allow",
                source: { file: activeAuto, path: ["permissions", 1], scopeId: settingsScopeId(activeAuto) },
                overridden: [{ file: globalAuto, path: ["permissions", 0], scopeId: settingsScopeId(globalAuto) }],
            },
        ])
    })

    test.serial("tracks byte-level revision drift and reports invalid settings", async () => {
        const globalAuto = join(global, "autocode.jsonc")
        const raw = '{ "autocode": { "skills": {} } }\n'
        write(globalAuto, raw)
        const first = await readSettings({ worktree, directory: active })
        const initialRevision = first.scopes[0]?.revision
        const missingRevision = first.scopes[3]?.revision
        write(globalAuto, `// comment-only change\n${raw}`)
        const second = await readSettings({ worktree, directory: active })
        expect(second.scopes[0]?.id).toBe(first.scopes[0]?.id)
        expect(second.scopes[0]?.revision).not.toBe(initialRevision)
        expect(second.scopes[3]?.revision).toBe(missingRevision)
        write(local(active), "{ invalid JSONC")
        const before = snapshot(root)
        const invalid = await readSettings({ worktree, directory: active })
        expect(snapshot(root)).toEqual(before)
        expect(invalid.issue).toEqual({ code: "invalid_config", file: local(active) })
        expect(invalid.effective).toBeNull()
        expect(invalid.scopes[3]?.state).toBe("invalid")
        expect(invalid.scopes[3]?.revision).not.toBe(missingRevision)
    })

    test.serial("global-only settings ignore synthetic cwd configuration", async () => {
        const globalAuto = join(global, "autocode.jsonc")
        const cwd = join(root, "cwd")
        writeDocument(globalAuto, { autocode: { skills: {}, memory: { directory: "global-only" } } })
        write(join(cwd, "opencode.jsonc"), "{ invalid cwd OpenCode config")
        write(local(cwd), "{ invalid cwd AutoCode config")
        const before = snapshot(root)
        const previousCwd = process.cwd()
        try {
            process.chdir(cwd)
            const candidates = enumerateAutocodeConfigCandidates({})
            const result = await readSettings({})
            expect(candidates).toEqual([{ path: globalAuto, scopeRoot: global, roles: ["global"], kind: "autocode" }])
            expect(result.issue).toBeUndefined()
            expect(result.scopes.map((scope) => scope.file)).toEqual([globalAuto])
            expect(result.effective?.values ?? []).toContainEqual({
                path: ["autocode", "memory", "directory"], value: "global-only",
                source: { file: globalAuto, path: ["autocode", "memory", "directory"], scopeId: settingsScopeId(globalAuto) },
                overridden: [],
            })
            expect(snapshot(root)).toEqual(before)
        } finally {
            try {
                process.chdir(previousCwd)
            } finally {
                restoreEnvironment()
            }
        }
    })

    test.serial("rejects invalid and stale updates without changing files", async () => {
        const file = join(global, "autocode.jsonc")
        const raw = '{ "autocode": { "skills": {}, "memory": { "directory": "before" } }, "permissions": [{ "action": "read", "resource": "*", "effect": "allow" }] }\n'
        const context = { worktree, directory: active }
        write(file, raw)
        const scopeId = settingsScopeId(file)
        const revision = settingsRevision(file, readFileSync(file))
        const before = snapshot(root)
        for (const patches of [
            [{ op: "set", path: ["autocode", "memory", "directory"], value: "" }],
            [{ op: "set", path: ["autocode", "__proto__", "model"], value: "bad" }],
            [{ op: "update-rule", index: 0, effect: "allow" }],
        ] satisfies SettingsPatch[][]) {
            await expect(updateSettings(context, { scopeId, revision, patches })).rejects.toMatchObject({ code: "invalid_request" })
            expect(snapshot(root)).toEqual(before)
        }
        await expect(updateSettings(context, { scopeId: "invalid", revision, patches: [] })).rejects.toMatchObject({ code: "invalid_request" })
        expect(snapshot(root)).toEqual(before)

        write(file, `// external edit\n${raw}`)
        const changed = snapshot(root)
        await expect(updateSettings(context, {
            scopeId, revision, patches: [{ op: "set", path: ["autocode", "memory", "directory"], value: "after" }],
        })).rejects.toMatchObject({ code: "conflict" })
        expect(snapshot(root)).toEqual(changed)
    })

    test.serial("rejects edits to invalid configuration without changing files", async () => {
        const file = join(global, "autocode.jsonc")
        write(file, "{ invalid JSONC")
        const before = snapshot(root)
        await expect(updateSettings({ worktree, directory: active }, {
            scopeId: settingsScopeId(file),
            revision: settingsRevision(file, readFileSync(file)),
            patches: [{ op: "set", path: ["autocode", "skills", "freeze"], value: true }],
        })).rejects.toMatchObject({ code: "invalid_config" })
        expect(snapshot(root)).toEqual(before)
    })

    test.serial("preserves unrelated permission rules and comments during atomic edits", async () => {
        const file = join(global, "autocode.jsonc")
        const raw = '{\n  // keep this comment\n  "autocode": { "skills": {}, "memory": { "directory": "before" } },\n  "permissions": [\n    { "action": "read", "resource": "*", "effect": "allow" },\n    { "action": "external_directory", "resource": "shared/*", "effect": "deny", "extra": true }\n  ]\n}\n'
        const context = { worktree, directory: active }
        write(file, raw)
        const result = await updateSettings(context, {
            scopeId: settingsScopeId(file),
            revision: settingsRevision(file, readFileSync(file)),
            patches: [
                { op: "set", path: ["autocode", "memory", "directory"], value: "after" },
                { op: "update-rule", index: 1, effect: "ask" },
            ],
        })
        const expected = raw.replace('"directory": "before"', '"directory": "after"').replace('"effect": "deny"', '"effect": "ask"')
        expect(readFileSync(file, "utf8")).toBe(expected)
        expect(result.scopes[0]?.permissionCount).toBe(2)
        expect(result.scopes[0]?.externalDirectory).toEqual([{ index: 1, resource: "shared/*", effect: "ask" }])
        expect(readdirSync(global).sort()).toEqual(["autocode.jsonc"])
    })

    test.serial("preserves existing file mode during atomic replacement on POSIX", async () => {
        if (process.platform === "win32") return
        const file = join(global, "autocode.jsonc")
        write(file, '{ "autocode": { "skills": {}, "memory": { "directory": "before" } } }\n')
        chmodSync(file, 0o640)
        await updateSettings({ worktree, directory: active }, {
            scopeId: settingsScopeId(file),
            revision: settingsRevision(file, readFileSync(file)),
            patches: [{ op: "set", path: ["autocode", "memory", "directory"], value: "after" }],
        })
        expect(statSync(file).mode & 0o777).toBe(0o640)
        expect(readdirSync(global).sort()).toEqual(["autocode.jsonc"])
    })
})
