import { issueText, PROFILE_FIELDS } from "./transport.js"
import type {
    AutoChamberTransport, ProfileFieldOperation, ProfileKind, ProfileSummary, ProfileWrite, ProfilesSnapshot, ResolvedProvider, UiIssue,
} from "./transport.js"

type FieldName = (typeof PROFILE_FIELDS)[ProfileKind][number]
type FieldControls = { action: HTMLSelectElement; input: HTMLInputElement }

const KINDS: readonly ProfileKind[] = ["rest", "ssh", "db"]
const KIND_LABELS: Record<ProfileKind, string> = { rest: "REST", ssh: "SSH", db: "DB" }
const FIELD_LABELS: Record<FieldName, string> = {
    authorization: "Authorization", username: "Username", password: "Password", host: "Host",
    port: "Port", keyfile: "Keyfile", agent: "Agent", keypass: "Key passphrase", connection: "Connection",
}
const PRIVATE_FIELDS: readonly FieldName[] = ["authorization", "host", "password", "keypass", "connection"]

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag)
    if (text !== undefined) node.textContent = text
    if (className !== undefined) node.className = className
    return node
}

function button(text: string, action: () => void): HTMLButtonElement {
    const node = element("button", text)
    node.type = "button"
    node.addEventListener("click", action)
    return node
}

function addIssues(parent: HTMLElement, issues: readonly UiIssue[]): void {
    for (const issue of issues) parent.append(element("p", issueText(issue), "notice"))
}

function providerText(value: string | undefined, policy: boolean): string {
    if (value === "plaintext" || value === "windows-credential-manager" || value === "linux-secret-service"
        || (policy && value === "auto")) return value
    return "Unknown"
}

function knownProvider(value: string | undefined): value is ResolvedProvider {
    return value === "plaintext" || value === "windows-credential-manager" || value === "linux-secret-service"
}

function availableProviders(snapshot: ProfilesSnapshot): readonly ResolvedProvider[] {
    if (snapshot.providers !== undefined) {
        return snapshot.providers
            .filter((entry): boolean => entry.writable === true && knownProvider(entry.provider))
            .map((entry): ResolvedProvider => entry.provider)
    }
    if ((snapshot.plaintextDisposition !== "required" && snapshot.plaintextDisposition !== "not-required")
        || !knownProvider(snapshot.resolvedProvider)) return []
    return [snapshot.resolvedProvider]
}

function rowProvider(snapshot: ProfilesSnapshot, row: ProfileSummary): ResolvedProvider | undefined {
    if (row.provider !== undefined) return knownProvider(row.provider) ? row.provider : undefined
    if (snapshot.providers === undefined && knownProvider(snapshot.resolvedProvider)) return snapshot.resolvedProvider
    return undefined
}

function rowRevision(snapshot: ProfilesSnapshot, row: ProfileSummary): string | undefined {
    if (snapshot.providers !== undefined || row.provider !== undefined) return row.revision || undefined
    return row.revision ?? snapshot.revision
}

function presence(row: ProfileSummary | undefined, field: FieldName): boolean {
    if (row === undefined) return false
    const fields: Readonly<Partial<Record<FieldName, boolean>>> = row.fields
    return fields[field] === true
}

function validPresence(kind: ProfileKind, present: Readonly<Partial<Record<FieldName, boolean>>>): boolean {
    if (kind === "rest") return present.authorization === true || (present.username === true && present.password === true)
    if (kind === "ssh") return present.host === true
    return present.connection === true
}

export function mountProfiles(root: HTMLElement, transport?: AutoChamberTransport): () => void {
    let snapshot: ProfilesSnapshot | undefined
    let pending = false
    let disposed = false
    let generation = 0
    let scrubEditor: (() => void) | undefined
    const panel = element("section", undefined, "panel stack")
    const heading = element("h2", "Profiles")
    const status = element("p", "", "status")
    const actions = element("div", undefined, "actions")
    const content = element("div", undefined, "stack")
    const editor = element("div")
    status.setAttribute("role", "status")
    status.setAttribute("aria-live", "polite")
    panel.append(heading, status, actions, content, editor)
    root.replaceChildren(panel)

    function closeEditor(): void {
        scrubEditor?.()
        scrubEditor = undefined
        editor.replaceChildren()
    }

    function setStatus(text: string): void {
        status.textContent = text
    }

    function render(): void {
        actions.replaceChildren()
        content.replaceChildren()
        const refresh = button("Refresh", (): void => { void load() })
        refresh.disabled = pending || transport === undefined
        actions.append(refresh)
        if (transport === undefined) {
            content.append(element("p", "Profiles are disconnected.", "notice"))
            return
        }
        if (snapshot === undefined) return
        const current = snapshot
        content.append(element("p", `Policy: ${providerText(current.policy, true)}; resolved provider: ${providerText(current.resolvedProvider, false)}`, "metadata"))
        addIssues(content, current.issues)
        if (current.writable !== true) content.append(element("p", issueText({ code: "writer-unavailable" }), "notice"))
        if (current.providers !== undefined) {
            const providers = element("section", undefined, "stack")
            providers.append(element("h3", "Credential providers"))
            for (const entry of current.providers) {
                providers.append(element("p", `${providerText(entry.provider, false)}: ${entry.writable === true ? "Available for writing" : "Writing unavailable"}`, "metadata"))
                addIssues(providers, entry.issues)
            }
            content.append(providers)
        }
        const available = availableProviders(current)
        if (available.length === 0) content.append(element("p", "No known credential destination is available for writing.", "notice"))
        for (const kind of KINDS) {
            const section = element("section", undefined, "stack")
            section.append(element("h3", `${KIND_LABELS[kind]} profiles`))
            const create = button(`Create ${KIND_LABELS[kind]} profile`, (): void => openEditor(kind))
            create.disabled = pending || current.writable !== true || available.length === 0
            section.append(create)
            const list = element("ul", undefined, "profile-list")
            const rows = current.profiles.filter((row: ProfileSummary): boolean => row.kind === kind)
            if (rows.length === 0) section.append(element("p", "No profiles."))
            for (const row of rows) {
                const item = element("li", undefined, "stack")
                const provider = rowProvider(current, row)
                item.append(element("h4", `${row.id} — ${providerText(provider, false)}`))
                const fields = element("div", undefined, "metadata")
                for (const field of PROFILE_FIELDS[kind]) {
                    fields.append(element("span", `${FIELD_LABELS[field]}: ${presence(row, field) ? "Set" : "Not set"}`))
                }
                item.append(fields)
                addIssues(item, row.issues)
                if (row.writable !== true) item.append(element("p", issueText({ code: "read-only" }), "notice"))
                if (rowRevision(current, row) === undefined && (current.providers !== undefined || row.provider !== undefined)) {
                    item.append(element("p", "Profile revision is unavailable; refresh before updating.", "notice"))
                }
                const update = button(`Update ${KIND_LABELS[kind]} profile ${row.id} — ${providerText(provider, false)}`, (): void => openEditor(kind, row))
                update.disabled = pending || current.writable !== true || row.writable !== true || provider === undefined
                    || !available.includes(provider)
                    || (rowRevision(current, row) === undefined && (current.providers !== undefined || row.provider !== undefined))
                item.append(update)
                list.append(item)
            }
            section.append(list)
            content.append(section)
        }
    }

    async function load(): Promise<void> {
        if (disposed || pending || transport === undefined) return
        closeEditor()
        snapshot = undefined
        pending = true
        const token = ++generation
        setStatus("Refreshing profiles.")
        render()
        try {
            const result = await transport.readProfiles()
            if (disposed || token !== generation) return
            if (result.ok) {
                snapshot = result.value
                setStatus("Profiles refreshed.")
            } else {
                setStatus(issueText(result.issue))
            }
        } catch {
            if (!disposed && token === generation) setStatus(issueText({ code: "failed" }))
        } finally {
            if (!disposed && token === generation) {
                pending = false
                render()
            }
        }
    }

    function openEditor(kind: ProfileKind, row?: ProfileSummary): void {
        if (disposed || pending || snapshot === undefined || snapshot.writable !== true || (row !== undefined && row.writable !== true)) return
        closeEditor()
        const current = snapshot
        const available = availableProviders(current)
        const fixedProvider = row === undefined ? undefined : rowProvider(current, row)
        if (available.length === 0 || (row !== undefined && (fixedProvider === undefined || !available.includes(fixedProvider)
            || (rowRevision(current, row) === undefined && (current.providers !== undefined || row.provider !== undefined))))) return
        const form = element("form", undefined, "stack")
        form.noValidate = true
        form.method = "post"
        const fieldset = element("fieldset", undefined, "stack")
        fieldset.append(element("legend", `${row === undefined ? "Create" : "Update"} ${KIND_LABELS[kind]} profile`))
        const idInput = element("input")
        if (row === undefined) {
            const label = element("label", "Profile ID", "field")
            idInput.type = "text"
            idInput.autocomplete = "off"
            label.append(idInput)
            fieldset.append(label)
        } else {
            fieldset.append(element("p", `Profile ID: ${row.id}`))
        }
        const providerSelect = element("select")
        if (row === undefined) {
            const providerLabel = element("label", "Credential provider", "field")
            const placeholder = element("option", "Choose a provider")
            placeholder.value = ""
            providerSelect.append(placeholder)
            for (const provider of available) {
                const option = element("option", provider)
                option.value = provider
                providerSelect.append(option)
            }
            providerLabel.append(providerSelect)
            fieldset.append(providerLabel)
        } else {
            fieldset.append(element("p", `Credential provider: ${providerText(fixedProvider, false)}`))
        }
        if (kind === "rest") fieldset.append(element("p", "Authorization takes precedence over username and password.", "notice"))
        const controls: Partial<Record<FieldName, FieldControls>> = {}
        const grid = element("div", undefined, "field-grid")
        for (const field of PROFILE_FIELDS[kind]) {
            const group = element("fieldset", undefined, "field")
            group.append(element("legend", FIELD_LABELS[field]))
            const actionLabel = element("label", "Action", "field")
            const action = element("select")
            for (const [value, label] of row === undefined
                ? [["omit", "Omit"], ["set", "Set"]]
                : [["keep", "Keep"], ["set", "Set"], ["clear", "Clear"]]) {
                const option = element("option", label)
                option.value = value
                action.append(option)
            }
            actionLabel.append(action)
            const inputLabel = element("label", `New ${FIELD_LABELS[field]}`, "field")
            const input = element("input")
            input.type = PRIVATE_FIELDS.includes(field) ? "password" : "text"
            input.autocomplete = "new-password"
            input.disabled = true
            inputLabel.append(input)
            action.addEventListener("change", (): void => {
                if (action.value !== "set") input.value = ""
                input.disabled = action.value !== "set"
            })
            group.append(actionLabel, inputLabel)
            grid.append(group)
            controls[field] = { action, input }
        }
        fieldset.append(grid)
        const confirmationLabel = element("label", undefined, "field")
        const confirmation = element("input")
        confirmation.type = "checkbox"
        confirmationLabel.append(confirmation, document.createTextNode("Confirm this profile write."))
        fieldset.append(confirmationLabel)
        const consent = element("input")
        consent.type = "checkbox"
        const consentLabel = element("label", undefined, "notice")
        consentLabel.append(consent, document.createTextNode(" I consent to storing these credentials unencrypted on disk."))
        function updateConsent(): void {
            const target = row === undefined ? providerSelect.value : fixedProvider
            const required = target === "plaintext"
                || (current.providers === undefined && current.plaintextDisposition === "required")
            consentLabel.hidden = !required
            consent.checked = false
        }
        providerSelect.addEventListener("change", updateConsent)
        updateConsent()
        fieldset.append(consentLabel)
        const formActions = element("div", undefined, "actions")
        const submit = element("button", row === undefined ? "Create" : "Update")
        submit.type = "button"
        formActions.append(submit, button("Cancel", closeEditor))
        fieldset.append(formActions)
        form.append(fieldset)
        editor.append(form)
        scrubEditor = (): void => {
            idInput.value = ""
            for (const field of PROFILE_FIELDS[kind]) {
                const control = controls[field]
                if (control !== undefined) control.input.value = ""
            }
            confirmation.checked = false
            consent.checked = false
        }
        form.addEventListener("input", (event: Event): void => {
            if (event.target !== confirmation) confirmation.checked = false
        })
        form.addEventListener("change", (event: Event): void => {
            if (event.target !== confirmation) confirmation.checked = false
        })
        function submitProfile(event: Event): void {
            event.preventDefault()
            const id = row === undefined ? idInput.value.trim() : row.id
            const target = row === undefined ? providerSelect.value : fixedProvider
            const needsConsent = target === "plaintext"
                || (current.providers === undefined && current.plaintextDisposition === "required")
            const confirmed = confirmation.checked
            const consented = needsConsent && consent.checked
            const fields: Partial<Record<FieldName, ProfileFieldOperation>> = {}
            const present: Partial<Record<FieldName, boolean>> = {}
            let changed = false
            let invalidValue = false
            for (const field of PROFILE_FIELDS[kind]) {
                const control = controls[field]
                if (control === undefined) continue
                const operation = control.action.value
                present[field] = presence(row, field)
                if (operation === "set") {
                    const value = control.input.value
                    fields[field] = { op: "set", value }
                    present[field] = true
                    changed = true
                    if ((field === "host" || field === "connection") && value.trim() === "") invalidValue = true
                    if (field === "port" && (!/^[0-9]+$/.test(value.trim())
                        || Number(value.trim()) < 1 || Number(value.trim()) > 65535)) invalidValue = true
                } else if (operation === "clear") {
                    fields[field] = { op: "clear" }
                    present[field] = false
                    changed = true
                } else if (row !== undefined) {
                    fields[field] = { op: "keep" }
                }
            }
            scrubEditor?.()
            if (pending || disposed || snapshot !== current) return
            const idPattern = kind === "ssh" ? /^[A-Za-z0-9_-]+$/ : /^[A-Za-z0-9_]+$/
            if (!knownProvider(target) || !available.includes(target) || !idPattern.test(id)
                || !changed || invalidValue || !validPresence(kind, present)) {
                setStatus("Check profile ID, field changes, and required fields; entered values were cleared.")
                return
            }
            if (!confirmed || (needsConsent && !consented)) {
                setStatus("Confirmation and any required plaintext consent are required; entered values were cleared.")
                return
            }
            const request: ProfileWrite = {
                kind, id, mode: row === undefined ? "create" : "update",
                revision: row === undefined ? current.revision : rowRevision(current, row),
                provider: target, confirmed: true, plaintextConsent: consented, fields,
            }
            closeEditor()
            void write(request)
        }
        submit.addEventListener("click", submitProfile)
        form.addEventListener("submit", submitProfile)
        form.addEventListener("keydown", (event: KeyboardEvent): void => {
            if (event.key !== "Enter" || event.isComposing || !(event.target instanceof HTMLInputElement)
                || (event.target.type !== "text" && event.target.type !== "password")) return
            submitProfile(event)
        })
    }

    async function write(request: ProfileWrite): Promise<void> {
        if (disposed || pending || transport === undefined) return
        pending = true
        const token = ++generation
        setStatus("Writing profile.")
        render()
        try {
            const result = await transport.writeProfile(request)
            if (disposed || token !== generation) return
            snapshot = undefined
            if (result.ok) {
                pending = false
                await load()
                return
            }
            setStatus(`${issueText(result.issue)} Refresh before writing again.`)
        } catch {
            if (!disposed && token === generation) {
                snapshot = undefined
                setStatus(`${issueText({ code: "failed" })} Refresh before writing again.`)
            }
        } finally {
            if (!disposed && token === generation) {
                pending = false
                render()
            }
        }
    }

    function dispose(): void {
        if (disposed) return
        disposed = true
        generation++
        closeEditor()
        window.removeEventListener("pagehide", dispose)
        root.replaceChildren()
    }

    window.addEventListener("pagehide", dispose)
    render()
    if (transport !== undefined) void load()
    return dispose
}
