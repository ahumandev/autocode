export const MODEL_TIERS = ["cheap", "fast", "operator", "context", "balanced", "smart", "spy"] as const
export const SYNC_METHODS = ["auto", "overlayfs", "reflink", "copy"] as const
export const PROVIDER_POLICIES = ["auto", "windows-credential-manager", "linux-secret-service", "plaintext"] as const
export const DIRECTORY_EFFECTS = ["ask", "allow", "deny"] as const
export const PROFILE_FIELDS = {
    rest: ["authorization", "username", "password"],
    ssh: ["host", "username", "port", "keyfile", "agent", "password", "keypass"],
    db: ["connection", "username", "password"],
} as const

export type ModelTier = (typeof MODEL_TIERS)[number]
export type SyncMethod = (typeof SYNC_METHODS)[number]
export type ProviderPolicy = (typeof PROVIDER_POLICIES)[number]
export type ResolvedProvider = Exclude<ProviderPolicy, "auto">
export type DirectoryEffect = (typeof DIRECTORY_EFFECTS)[number]
export type ProfileKind = keyof typeof PROFILE_FIELDS
export type ProfileField<K extends ProfileKind> = (typeof PROFILE_FIELDS)[K][number]

export type UiIssueCode =
    | "conflict" | "read-only" | "writer-unavailable" | "provider-unavailable"
    | "provider-locked" | "provider-denied" | "shadowed" | "unavailable"
    | "invalid" | "unsafe-location" | "missing" | "incomplete" | "too-large"
    | "unsupported" | "failed"

export interface UiIssue {
    readonly code: UiIssueCode
}

export type UiResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly issue: UiIssue }

export function issueText(issue: UiIssue): string {
    switch (issue.code) {
        case "conflict": return "Changes conflict with a newer revision."
        case "read-only": return "This item is read-only."
        case "writer-unavailable": return "Writing is unavailable."
        case "provider-unavailable": return "Credential provider is unavailable."
        case "provider-locked": return "Credential provider is locked."
        case "provider-denied": return "Access to the credential provider was denied."
        case "shadowed": return "This item is shadowed."
        case "unavailable": return "This item is unavailable."
        case "invalid": return "The supplied value is invalid."
        case "unsafe-location": return "This location is unsafe."
        case "missing": return "This item is missing."
        case "incomplete": return "This item is incomplete."
        case "too-large": return "This item is too large."
        case "unsupported": return "This operation is unsupported."
        case "failed": return "The operation failed."
        default: return "The operation failed."
    }
}

export type ValueState = "unset" | "local" | "inherited" | "overridden" | "mixed"

export interface ValueView<T> {
    readonly raw?: T
    readonly effective?: T
    readonly source?: string
    readonly state: ValueState
    readonly overridden?: readonly string[]
    readonly cause?: string
    readonly legacyStatus?: "used" | "overridden" | "ignored" | "unresolved"
}

export type TierField = "model" | "variant"
export type TierView = Readonly<Partial<Record<TierField, ValueView<string>>>>
export type TierViews = Readonly<Partial<Record<ModelTier, TierView>>>

export interface ProviderTiersView {
    readonly provider: string
    readonly tiers: TierViews
}

export interface DirectoryEntry {
    // Identity refers to the raw row, not its position in either list.
    readonly id: string
    readonly resource: string
    readonly effect: DirectoryEffect
    readonly source?: string
    readonly state?: ValueState
}

export interface ScopeSettings {
    readonly tierSelector?: ValueView<string>
    readonly directTiers?: TierViews
    readonly providerTiers?: readonly ProviderTiersView[]
    readonly legacyTiers?: TierViews
    readonly resolvedTiers?: TierViews
    readonly syncMethod?: ValueView<SyncMethod>
    readonly distroCachePath?: ValueView<string>
    readonly distroExpire?: ValueView<string | number>
    readonly skillsFreeze?: ValueView<boolean>
    readonly memoryDirectory?: ValueView<string>
    readonly credentialsProvider?: ValueView<ProviderPolicy>
    readonly externalDirectories?: ValueView<readonly DirectoryEntry[]>
}

export interface ScopeView {
    readonly id: string
    readonly role: "global" | "worktree" | "intermediate" | "active"
    readonly roles?: readonly ScopeView["role"][]
    readonly source: string
    readonly scopeRoot?: string
    readonly scopeState?: "missing" | "valid" | "invalid" | "unreadable"
    readonly permissionCount?: number
    readonly writable: boolean
    readonly revision?: string
    readonly issue?: UiIssue
    readonly settings: ScopeSettings
}

export interface SettingsSnapshot {
    readonly scopes: readonly ScopeView[]
    readonly activeScopeId?: string
    readonly directory?: string
    readonly worktree?: string
    readonly customRoot?: string
    readonly notice?: string
}

export interface ScalarSettingValues {
    readonly tierSelector: string
    readonly syncMethod: SyncMethod
    readonly distroCachePath: string
    readonly distroExpire: string | number
    readonly skillsFreeze: boolean
    readonly memoryDirectory: string
    readonly credentialsProvider: ProviderPolicy
}

export type ScalarSettingChange = {
    [K in keyof ScalarSettingValues]:
        | { readonly kind: "scalar"; readonly key: K; readonly op: "set"; readonly value: ScalarSettingValues[K] }
        | { readonly kind: "scalar"; readonly key: K; readonly op: "remove" }
}[keyof ScalarSettingValues]

export type TierMap =
    | { readonly kind: "direct" }
    | { readonly kind: "provider"; readonly provider: string }
    | { readonly kind: "legacy" }

export type TierSettingChange = {
    readonly kind: "tier"
    readonly map: TierMap
    readonly tier: ModelTier
    readonly field: TierField
} & (
    | { readonly op: "set"; readonly value: string }
    | { readonly op: "remove" }
)

export type DirectorySettingChange =
    | { readonly kind: "externalDirectory"; readonly op: "append"; readonly resource: string; readonly effect: DirectoryEffect }
    | { readonly kind: "externalDirectory"; readonly op: "update"; readonly id: string; readonly resource: string; readonly effect: DirectoryEffect }
    | { readonly kind: "externalDirectory"; readonly op: "remove"; readonly id: string }
    | { readonly kind: "externalDirectory"; readonly op: "move"; readonly id: string; readonly direction: "up" | "down" }

export interface SettingWrite {
    readonly scopeId: string
    readonly revision?: string
    readonly change: ScalarSettingChange | TierSettingChange | DirectorySettingChange
}

export type ProfileSummary = {
    [K in ProfileKind]: {
        readonly kind: K
        // The trusted host supplies the normalized ID.
        readonly id: string
        readonly writable: boolean
        readonly issues: readonly UiIssue[]
        readonly fields: Readonly<Record<ProfileField<K>, boolean>>
        readonly provider?: ResolvedProvider
        readonly revision?: string
    }
}[ProfileKind]

export interface ProfilesSnapshot {
    readonly profiles: readonly ProfileSummary[]
    readonly writable: boolean
    readonly issues: readonly UiIssue[]
    readonly resolvedProvider?: ResolvedProvider
    readonly policy?: ProviderPolicy
    readonly providers?: readonly {
        readonly provider: ResolvedProvider
        readonly writable: boolean
        readonly issues: readonly UiIssue[]
    }[]
    readonly plaintextDisposition: "required" | "not-required" | "unknown"
    readonly revision?: string
}

export type ProfileFieldOperation =
    | { readonly op: "keep" }
    | { readonly op: "set"; readonly value: string }
    | { readonly op: "clear" }

export type ProfileWrite = {
    [K in ProfileKind]: {
        readonly kind: K
        readonly id: string
        readonly mode: "create" | "update"
        readonly revision?: string
        readonly provider: ResolvedProvider
        readonly confirmed: true
        readonly plaintextConsent: boolean
        readonly fields: Readonly<Partial<Record<ProfileField<K>, ProfileFieldOperation>>>
    }
}[ProfileKind]

export interface AutoChamberTransport {
    readSettings(): Promise<UiResult<SettingsSnapshot>>
    writeSetting(request: SettingWrite): Promise<UiResult<void>>
    readProfiles(): Promise<UiResult<ProfilesSnapshot>>
    writeProfile(request: ProfileWrite): Promise<UiResult<void>>
}
