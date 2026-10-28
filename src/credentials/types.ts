export const CREDENTIAL_PROVIDER_NAMES = [
    "windows-credential-manager",
    "linux-secret-service",
    "plaintext",
] as const

export const CREDENTIAL_PROVIDER_POLICIES = ["auto", ...CREDENTIAL_PROVIDER_NAMES] as const

export type CredentialProviderName = (typeof CREDENTIAL_PROVIDER_NAMES)[number]
export type CredentialProviderPolicy = (typeof CREDENTIAL_PROVIDER_POLICIES)[number]
export type CredentialKind = "ssh" | "db" | "rest"

export interface CredentialPolicy {
    provider: CredentialProviderPolicy
}

export function isCredentialProviderPolicy(value: unknown): value is CredentialProviderPolicy {
    return typeof value === "string"
        && CREDENTIAL_PROVIDER_POLICIES.some((policy: CredentialProviderPolicy): boolean => policy === value)
}

export interface SshCredentialProfile {
    host: string
    username?: string
    port?: string
    keyfile?: string
    agent?: string
    password?: string
    keypass?: string
}

export interface DbCredentialProfile {
    connection: string
    username?: string
    password?: string
}

export type RestCredentialProfile =
    | { authorization: string; username?: string; password?: string }
    | { authorization?: string; username: string; password: string }

export interface CredentialProfileMap {
    ssh: SshCredentialProfile
    db: DbCredentialProfile
    rest: RestCredentialProfile
}

export type CredentialProfile<K extends CredentialKind> = CredentialProfileMap[K]

export interface CredentialProfileInputMap {
    ssh: Partial<SshCredentialProfile>
    db: Partial<DbCredentialProfile>
    rest: Partial<RestCredentialProfile>
}

export type CredentialProfileInput<K extends CredentialKind> = CredentialProfileInputMap[K]

export interface CredentialEnvelope<K extends CredentialKind> {
    version: 1
    kind: K
    fields: CredentialProfileInput<K>
}

// Providers decode storage envelopes; core validates each whole profile once.
export type CredentialReadResult =
    | { status: "found"; profile: unknown }
    | { status: "missing" }
    | { status: "incomplete" }
    | { status: "unavailable" }

export interface CredentialProvider {
    read(kind: CredentialKind, normalizedId: string): Promise<CredentialReadResult>
    enumerate?(kind: CredentialKind): Promise<string[]>
}

export type CredentialProfileValidation<K extends CredentialKind> =
    | { status: "found"; profile: CredentialProfile<K> }
    | { status: "incomplete" }

export interface CredentialSource {
    readonly kind: CredentialKind
    readonly provider: CredentialProviderName
}

export interface ResolvedCredentialProfile<K extends CredentialKind> {
    readonly kind: K
    readonly provider: CredentialProviderName
    profile: CredentialProfile<K>
}

export interface CredentialResolver {
    resolve<K extends CredentialKind>(kind: K, id: string): Promise<ResolvedCredentialProfile<K>>
    enumerate?(kind: CredentialKind): Promise<CredentialEnumerationResult>
}

export interface CredentialEnumerationResult {
    readonly ids: readonly string[]
    readonly unavailableProviders: readonly CredentialProviderName[]
}

export interface CredentialResolverOptions {
    providers: Partial<Record<CredentialProviderName, CredentialProvider>>
    provider?: CredentialProviderPolicy
    platform?: NodeJS.Platform
    onSource?: (source: CredentialSource) => void
    warn?: (message: string) => void
}

export type CredentialErrorCode =
    | "locked"
    | "denied"
    | "invalid"
    | "unsafe_location"
    | "too_large"
    | "failed"
    | "missing"
    | "incomplete"
    | "unavailable"
    | "unsupported"

const CREDENTIAL_ERROR_MESSAGES: Readonly<Record<CredentialErrorCode, string>> = {
    locked: "Credential store is locked.",
    denied: "Credential access denied.",
    invalid: "Invalid credential profile, storage, or ID.",
    unsafe_location: "Plaintext credential storage must use a private global configuration directory outside workspaces and Git repositories. Set OPENCODE_CONFIG_DIR to a private user directory.",
    too_large: "Credential exceeds the supported size limit.",
    failed: "Credential read failed.",
    missing: "Credential profile is missing.",
    incomplete: "Credential profile is incomplete.",
    unavailable: "Credential provider is unavailable.",
    unsupported: "Credential provider is unsupported on this platform; select a compatible credentials.provider in global autocode.jsonc.",
}

export class CredentialError extends Error {
    readonly code: CredentialErrorCode

    constructor(code: CredentialErrorCode) {
        super(CREDENTIAL_ERROR_MESSAGES[code])
        this.name = "CredentialError"
        this.code = code
    }
}

export const MAX_CREDENTIAL_ENVELOPE_BYTES = 65536
export const MAX_CREDENTIAL_FIELD_BYTES = 65536
export const WINDOWS_CREDENTIAL_MAX_BYTES = 2560
export const PLAINTEXT_CREDENTIAL_WARNING = "Plaintext credential provider selected; credentials are stored unencrypted."
