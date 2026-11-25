import { DIRECTORY_EFFECTS, issueText, MODEL_TIERS, PROVIDER_POLICIES, SYNC_METHODS } from "./transport.js"
import type {
    AutoChamberTransport, DirectoryEffect, DirectoryEntry, ModelTier, ScalarSettingChange, ScopeView,
    SettingWrite, SettingsSnapshot, TierField, TierMap, TierViews, ValueView,
} from "./transport.js"

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag)
    if (text !== undefined) node.textContent = text
    if (className !== undefined) node.className = className
    return node
}

function button(text: string, action: () => void, disabled: boolean = false): HTMLButtonElement {
    const node = element("button", text)
    node.type = "button"
    node.disabled = disabled
    node.addEventListener("click", action)
    return node
}

function labeled<T extends HTMLElement>(text: string, control: T): HTMLLabelElement {
    const label = element("label", text, "field")
    label.append(control)
    return label
}

function selectOptions(values: readonly string[], raw?: string): HTMLSelectElement {
    const select = element("select")
    const placeholder = element("option", "Choose a value")
    placeholder.value = ""
    select.append(placeholder)
    for (const value of values) {
        const option = element("option", value)
        option.value = value
        select.append(option)
    }
    if (raw !== undefined && raw !== "" && !values.includes(raw)) {
        const option = element("option", `${raw} (unavailable)`)
        option.value = raw
        option.disabled = true
        select.append(option)
    }
    select.value = raw ?? ""
    return select
}

function valueText(value: string | number | boolean | undefined): string {
    return value === undefined ? "unset" : JSON.stringify(value)
}

function valueDetails<T extends string | number | boolean>(parent: HTMLElement, view?: ValueView<T>): void {
    parent.append(element("p", `Raw in selected scope: ${valueText(view?.raw)}; Effective: ${valueText(view?.effective)}`))
    parent.append(element("p", `State: ${view?.state ?? "unset"}; Source: ${view?.source ?? "not supplied"}`, "metadata"))
    if (view?.overridden !== undefined && view.overridden.length > 0) {
        parent.append(element("p", `Overridden sources: ${view.overridden.join(", ")}`, "metadata"))
    }
    if (view?.cause !== undefined) parent.append(element("p", `Cause: ${view.cause}`, "metadata"))
    if (view?.legacyStatus !== undefined) parent.append(element("p", `Legacy status: ${view.legacyStatus}`, "metadata"))
}

function roles(scope: ScopeView): readonly ScopeView["role"][] {
    return scope.roles ?? [scope.role]
}

function defaultScope(snapshot: SettingsSnapshot): string | undefined {
    const active = snapshot.scopes.find((scope): boolean => scope.id === snapshot.activeScopeId)
    if (active !== undefined) return active.id
    for (const role of ["active", "worktree", "global"] as const) {
        const scope = snapshot.scopes.find((item): boolean => roles(item).includes(role))
        if (scope !== undefined) return scope.id
    }
    return undefined
}

export function mountSettings(root: HTMLElement, transport?: AutoChamberTransport, onCredentialPolicyWrite?: (pending: boolean) => void): () => void {
    let snapshot: SettingsSnapshot | undefined
    let selectedId: string | undefined
    let providerName = ""
    let pending = false
    let blocked = true
    let disposed = false
    const panel = element("section", undefined, "panel stack")
    const status = element("p", "", "status")
    const actions = element("div", undefined, "actions")
    const content = element("div", undefined, "stack")
    status.setAttribute("role", "status")
    status.setAttribute("aria-live", "polite")
    panel.append(element("h2", "Settings"), status, actions, content)
    root.replaceChildren(panel)

    function currentScope(): ScopeView | undefined {
        return snapshot?.scopes.find((scope): boolean => scope.id === selectedId)
    }

    function canWrite(scope: ScopeView): boolean {
        return !disposed && !pending && !blocked && transport !== undefined && currentScope() === scope
            && scope.writable === true && typeof scope.revision === "string" && scope.revision.length > 0
            && scope.scopeState !== "invalid" && scope.scopeState !== "unreadable"
    }

    async function load(): Promise<void> {
        if (disposed || pending || transport === undefined) return
        pending = true
        blocked = true
        status.textContent = "Loading settings."
        render()
        try {
            const result = await transport.readSettings()
            if (disposed) return
            if (result.ok) {
                snapshot = result.value
                if (!snapshot.scopes.some((scope): boolean => scope.id === selectedId)) selectedId = defaultScope(snapshot)
                blocked = false
                status.textContent = "Settings refreshed."
            } else {
                status.textContent = `${issueText(result.issue)} Retry refresh before writing.`
            }
        } catch {
            if (!disposed) status.textContent = "Settings could not be loaded. Retry refresh before writing."
        } finally {
            if (!disposed) {
                pending = false
                render()
            }
        }
    }

    async function write(scope: ScopeView, change: SettingWrite["change"]): Promise<void> {
        if (!canWrite(scope) || transport === undefined) return
        if (change.kind === "scalar" && change.key === "credentialsProvider" && !roles(scope).includes("global")) return
        const request: SettingWrite = { scopeId: scope.id, revision: scope.revision, change }
        const policy = change.kind === "scalar" && change.key === "credentialsProvider"
        pending = true
        blocked = true
        status.textContent = "Writing setting."
        render()
        try {
            if (policy) onCredentialPolicyWrite?.(true)
            const result = await transport.writeSetting(request)
            if (disposed) return
            if (!result.ok) {
                status.textContent = `${issueText(result.issue)} Refresh before writing again.`
                return
            }
            status.textContent = "Refreshing settings after write."
            const refreshed = await transport.readSettings()
            if (disposed) return
            if (refreshed.ok) {
                snapshot = refreshed.value
                if (!snapshot.scopes.some((item): boolean => item.id === selectedId)) selectedId = defaultScope(snapshot)
                blocked = false
                status.textContent = "Setting saved and refreshed."
            } else {
                status.textContent = `${issueText(refreshed.issue)} Refresh before writing again.`
            }
        } catch {
            if (!disposed) status.textContent = "Settings operation failed. Refresh before writing again."
        } finally {
            if (policy) onCredentialPolicyWrite?.(false)
            if (!disposed) {
                pending = false
                render()
            }
        }
    }

    function scalar<T extends string | number | boolean>(
        parent: HTMLElement, scope: ScopeView, title: string, view: ValueView<T> | undefined,
        control: HTMLElement, read: () => T | undefined, set: (value: T) => ScalarSettingChange,
        remove: ScalarSettingChange, allowed: boolean = true,
    ): void {
        const group = element("fieldset", undefined, "stack")
        group.append(element("legend", title))
        valueDetails(group, view)
        if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) {
            group.append(labeled(`New ${title}`, control))
        } else {
            group.append(control)
        }
        const save = button(`Set ${title}`, (): void => {
            const value = read()
            if (value === undefined) {
                status.textContent = `Enter a valid value for ${title}.`
                return
            }
            void write(scope, set(value))
        }, !canWrite(scope) || !allowed)
        const clear = button(`Remove ${title}`, (): void => { void write(scope, remove) },
            !canWrite(scope) || !allowed || view?.raw === undefined)
        group.append(save, clear)
        parent.append(group)
    }

    function textInput(value?: string): HTMLInputElement {
        const input = element("input")
        input.type = "text"
        input.value = value ?? ""
        return input
    }

    function renderScalars(parent: HTMLElement, scope: ScopeView): void {
        const settings = scope.settings
        const providers = [...new Set([...(settings.providerTiers ?? []).map((entry): string => entry.provider), ...(providerName ? [providerName] : [])])]
        const selector = selectOptions(providers, settings.tierSelector?.raw)
        scalar(parent, scope, "autocode.tier provider", settings.tierSelector, selector,
            (): string | undefined => providers.includes(selector.value) ? selector.value : undefined,
            (value): ScalarSettingChange => ({ kind: "scalar", key: "tierSelector", op: "set", value }),
            { kind: "scalar", key: "tierSelector", op: "remove" })

        const sync = selectOptions(SYNC_METHODS, settings.syncMethod?.raw)
        scalar(parent, scope, "autocode.sandbox.sync_method", settings.syncMethod, sync,
            () => SYNC_METHODS.find((value): boolean => value === sync.value),
            (value): ScalarSettingChange => ({ kind: "scalar", key: "syncMethod", op: "set", value }),
            { kind: "scalar", key: "syncMethod", op: "remove" })

        const cache = textInput(settings.distroCachePath?.raw)
        scalar(parent, scope, "autocode.sandbox.distro.cache_path", settings.distroCachePath, cache, (): string => cache.value,
            (value): ScalarSettingChange => ({ kind: "scalar", key: "distroCachePath", op: "set", value }),
            { kind: "scalar", key: "distroCachePath", op: "remove" })

        const expireControls = element("div", undefined, "stack")
        const expireType = selectOptions(["string", "number"], typeof settings.distroExpire?.raw === "number" ? "number" : "string")
        const expire = textInput(settings.distroExpire?.raw === undefined ? undefined : String(settings.distroExpire.raw))
        expireControls.append(labeled("Expire value type", expireType), labeled("Expire value", expire))
        scalar(parent, scope, "autocode.sandbox.distro.expire", settings.distroExpire, expireControls,
            (): string | number | undefined => {
                if (expireType.value === "string") return expire.value
                if (expireType.value !== "number" || expire.value.trim() === "") return undefined
                const value = Number(expire.value)
                return Number.isFinite(value) ? value : undefined
            },
            (value): ScalarSettingChange => ({ kind: "scalar", key: "distroExpire", op: "set", value }),
            { kind: "scalar", key: "distroExpire", op: "remove" })

        const freeze = selectOptions(["true", "false"], settings.skillsFreeze?.raw === undefined ? undefined : String(settings.skillsFreeze.raw))
        scalar(parent, scope, "autocode.skills.freeze", settings.skillsFreeze, freeze,
            (): boolean | undefined => freeze.value === "true" ? true : freeze.value === "false" ? false : undefined,
            (value): ScalarSettingChange => ({ kind: "scalar", key: "skillsFreeze", op: "set", value }),
            { kind: "scalar", key: "skillsFreeze", op: "remove" })

        const memory = textInput(settings.memoryDirectory?.raw)
        scalar(parent, scope, "autocode.memory.directory", settings.memoryDirectory, memory,
            (): string | undefined => memory.value.trim() ? memory.value : undefined,
            (value): ScalarSettingChange => ({ kind: "scalar", key: "memoryDirectory", op: "set", value }),
            { kind: "scalar", key: "memoryDirectory", op: "remove" })

        parent.append(element("p", "Credential policy is editable only in global scope. Plaintext policy may store credentials unencrypted on disk.", "notice"))
        const policy = selectOptions(PROVIDER_POLICIES, settings.credentialsProvider?.raw)
        scalar(parent, scope, "credentials.provider", settings.credentialsProvider, policy,
            () => PROVIDER_POLICIES.find((value): boolean => value === policy.value),
            (value): ScalarSettingChange => ({ kind: "scalar", key: "credentialsProvider", op: "set", value }),
            { kind: "scalar", key: "credentialsProvider", op: "remove" }, roles(scope).includes("global"))
    }

    function renderTierMap(parent: HTMLElement, scope: ScopeView, title: string, views: TierViews | undefined, map?: TierMap): void {
        const section = element("section", undefined, "stack")
        section.append(element("h4", title))
        for (const tier of MODEL_TIERS) {
            const group = element("fieldset", undefined, "stack")
            group.append(element("legend", tier))
            for (const field of ["model", "variant"] as const) {
                const view = views?.[tier]?.[field]
                const row = element("div", undefined, "stack")
                row.append(element("h5", field))
                valueDetails(row, view)
                if (map !== undefined) {
                    const input = textInput(view?.raw)
                    row.append(labeled(`New ${title} ${tier} ${field}`, input))
                    const change = (op: "set" | "remove"): void => {
                        const base: { kind: "tier"; map: TierMap; tier: ModelTier; field: TierField } = { kind: "tier", map, tier, field }
                        void write(scope, op === "set" ? { ...base, op, value: input.value } : { ...base, op })
                    }
                    row.append(button(`Set ${tier} ${field}`, (): void => change("set"), !canWrite(scope)),
                        button(`Remove ${tier} ${field}`, (): void => change("remove"), !canWrite(scope) || view?.raw === undefined))
                }
                group.append(row)
            }
            section.append(group)
        }
        parent.append(section)
    }

    function renderTiers(parent: HTMLElement, scope: ScopeView): void {
        const section = element("section", undefined, "stack")
        section.append(element("h3", "Model tiers"))
        renderTierMap(section, scope, "Direct tiers", scope.settings.directTiers, { kind: "direct" })
        const names = [...new Set((scope.settings.providerTiers ?? []).map((entry): string => entry.provider))]
        if (providerName && !names.includes(providerName)) names.push(providerName)
        const picker = selectOptions(names, providerName || undefined)
        const name = textInput()
        section.append(labeled("Choose provider map", picker), labeled("Add provider name", name))
        picker.addEventListener("change", (): void => {
            providerName = picker.value
            render()
        })
        section.append(button("Choose or add provider", (): void => {
            const value = name.value.trim()
            if (!value || ["__proto__", "prototype", "constructor"].includes(value)
                || MODEL_TIERS.some((tier): boolean => tier === value) || value.includes("\0")) {
                status.textContent = "Enter a valid provider name."
                return
            }
            providerName = value
            render()
        }, pending))
        if (providerName) {
            const provider = scope.settings.providerTiers?.find((entry): boolean => entry.provider === providerName)
            renderTierMap(section, scope, `Provider ${providerName} tiers`, provider?.tiers, { kind: "provider", provider: providerName })
        }
        section.append(element("p", "Legacy autocode.model and autocode.variant are read-only: the API exposes legacy values but rejects writes.", "notice"))
        renderTierMap(section, scope, "Legacy autocode.model / autocode.variant", scope.settings.legacyTiers)
        renderTierMap(section, scope, "Final resolved tiers", scope.settings.resolvedTiers)
        parent.append(section)
    }

    function renderDirectories(parent: HTMLElement, scope: ScopeView): void {
        const section = element("section", undefined, "stack")
        const view = scope.settings.externalDirectories
        const raw = view?.raw ?? []
        section.append(element("h3", "permissions.external_directory"))
        section.append(element("p", "Last matching rule takes precedence; effective order and provenance are supplied by the backend.", "notice"))
        section.append(element("p", `State: ${view?.state ?? "unset"}; Source: ${view?.source ?? "not supplied"}`, "metadata"))
        if (view?.overridden?.length) section.append(element("p", `Overridden sources: ${view.overridden.join(", ")}`, "metadata"))
        if (view?.cause !== undefined) section.append(element("p", `Cause: ${view.cause}`, "metadata"))
        section.append(element("h4", "Raw ordered rules in selected scope"))
        if (raw.length === 0) section.append(element("p", view?.raw === undefined ? "Raw: unset" : "Raw: empty"))
        const list = element("ol", undefined, "rule-list")
        raw.forEach((entry: DirectoryEntry, index: number): void => {
            const item = element("li", undefined, "stack")
            const resource = textInput(entry.resource)
            const effect = selectOptions(DIRECTORY_EFFECTS, entry.effect)
            item.append(element("p", `Rule ${entry.id}; source: ${entry.source ?? "not supplied"}; state: ${entry.state ?? "not supplied"}`),
                labeled(`Resource for rule ${entry.id}`, resource), labeled(`Effect for rule ${entry.id}`, effect))
            item.append(button(`Update rule ${entry.id}`, (): void => {
                const chosen = DIRECTORY_EFFECTS.find((value): boolean => value === effect.value)
                if (!resource.value.trim() || chosen === undefined) {
                    status.textContent = "Enter a nonblank resource and valid effect."
                    return
                }
                void write(scope, { kind: "externalDirectory", op: "update", id: entry.id, resource: resource.value, effect: chosen })
            }, !canWrite(scope)))
            item.append(button(`Remove rule ${entry.id}`, (): void => {
                void write(scope, { kind: "externalDirectory", op: "remove", id: entry.id })
            }, !canWrite(scope)))
            for (const direction of ["up", "down"] as const) {
                item.append(button(`Move rule ${entry.id} ${direction}`, (): void => {
                    void write(scope, { kind: "externalDirectory", op: "move", id: entry.id, direction })
                }, !canWrite(scope) || (direction === "up" ? index === 0 : index === raw.length - 1)))
            }
            list.append(item)
        })
        section.append(list)
        const resource = textInput()
        const effect = selectOptions(DIRECTORY_EFFECTS)
        section.append(labeled("New rule resource", resource), labeled("New rule effect", effect))
        section.append(button("Add rule", (): void => {
            const chosen: DirectoryEffect | undefined = DIRECTORY_EFFECTS.find((value): boolean => value === effect.value)
            if (!resource.value.trim() || chosen === undefined) {
                status.textContent = "Enter a nonblank resource and valid effect."
                return
            }
            void write(scope, { kind: "externalDirectory", op: "append", resource: resource.value, effect: chosen })
        }, !canWrite(scope)))
        section.append(element("h4", "Effective ordered rules"))
        if (view?.effective === undefined) section.append(element("p", "Effective: unset"))
        else if (view.effective.length === 0) section.append(element("p", "Effective: empty"))
        const effective = element("ol", undefined, "rule-list")
        for (const entry of view?.effective ?? []) {
            effective.append(element("li", `${entry.resource} — ${entry.effect}; source: ${entry.source ?? "not supplied"}; state: ${entry.state ?? "not supplied"}`))
        }
        section.append(effective)
        parent.append(section)
    }

    function render(): void {
        if (disposed) return
        const focus = document.activeElement
        const focusText = focus instanceof HTMLButtonElement && panel.contains(focus) ? focus.textContent : undefined
        actions.replaceChildren()
        content.replaceChildren()
        actions.append(button("Refresh", (): void => { void load() }, pending || transport === undefined))
        if (transport === undefined) {
            status.textContent = "Settings are disconnected."
            content.append(element("p", "Settings are disconnected.", "notice"))
            return
        }
        if (snapshot === undefined) return
        for (const [label, value] of [["Directory", snapshot.directory], ["Worktree", snapshot.worktree], ["Custom root", snapshot.customRoot]] as const) {
            if (value !== undefined) content.append(element("p", `${label}: ${value}`, "metadata"))
        }
        if (snapshot.notice !== undefined) content.append(element("p", snapshot.notice, "notice"))
        if (snapshot.scopes.length === 0) {
            content.append(element("p", "No settings scopes available.", "notice"))
            return
        }
        const scopeSelect = element("select")
        const placeholder = element("option", "Choose a scope")
        placeholder.value = ""
        scopeSelect.append(placeholder)
        for (const scope of snapshot.scopes) {
            const option = element("option", `${roles(scope).join(" + ")} — ${scope.source}`)
            option.value = scope.id
            scopeSelect.append(option)
        }
        scopeSelect.value = selectedId ?? ""
        scopeSelect.disabled = pending
        scopeSelect.addEventListener("change", (): void => {
            selectedId = scopeSelect.value
            providerName = ""
            render()
        })
        content.append(labeled("Settings scope", scopeSelect))
        const scope = currentScope()
        if (scope === undefined) {
            content.append(element("p", "Choose a settings scope."))
            return
        }
        content.append(element("p", `Roles: ${roles(scope).join(", ")}; File: ${scope.source}`, "metadata"))
        if (scope.scopeRoot !== undefined) content.append(element("p", `Scope root: ${scope.scopeRoot}`, "metadata"))
        content.append(element("p", `Scope state: ${scope.scopeState ?? "not supplied"}; Permission count: ${scope.permissionCount ?? "not supplied"}`, "metadata"))
        if (scope.issue !== undefined) content.append(element("p", issueText(scope.issue), "notice"))
        if (!canWrite(scope)) content.append(element("p", pending ? "Settings operation pending." : blocked
            ? "Settings may be stale; refresh before writing." : "Scope is read-only, invalid, unreadable, or missing a revision.", "notice"))
        renderScalars(content, scope)
        renderTiers(content, scope)
        renderDirectories(content, scope)
        if (focusText) {
            const replacement = Array.from(panel.querySelectorAll("button")).find((item): boolean => item.textContent === focusText && !item.disabled)
            replacement?.focus()
        }
    }

    function dispose(): void {
        if (disposed) return
        disposed = true
        window.removeEventListener("pagehide", dispose)
        root.replaceChildren()
    }

    window.addEventListener("pagehide", dispose)
    render()
    if (transport !== undefined) void load()
    return dispose
}
