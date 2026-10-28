import { normalizeCredentialId as normalizeCredentialKey } from "./lookup"
import {
    CREDENTIAL_PROVIDER_NAMES,
    CredentialError,
    PLAINTEXT_CREDENTIAL_WARNING,
    isCredentialProviderPolicy,
    type CredentialKind,
    type CredentialProviderName,
    type CredentialProviderPolicy,
    type CredentialReadResult,
    type CredentialEnumerationResult,
    type CredentialResolver,
    type CredentialResolverOptions,
    type ResolvedCredentialProfile,
} from "./types"
import { validateCredentialProfile } from "./validation"

const [WINDOWS_PROVIDER, LINUX_PROVIDER, PLAINTEXT_PROVIDER] = CREDENTIAL_PROVIDER_NAMES
const AUTO_PROVIDER_POLICY = "auto"

function normalizeCredentialId(kind: CredentialKind, id: string): string {
    if ((kind !== "ssh" && kind !== "db" && kind !== "rest") || typeof id !== "string") {
        throw new CredentialError("invalid")
    }

    try {
        return normalizeCredentialKey(kind, id)
    } catch {
        throw new CredentialError("invalid")
    }
}

function getProviderOrder(policy: CredentialProviderPolicy, platform: NodeJS.Platform): readonly CredentialProviderName[] {
    if (policy === AUTO_PROVIDER_POLICY) {
        if (platform === "win32") {
            return [WINDOWS_PROVIDER, PLAINTEXT_PROVIDER]
        }
        if (platform === "linux") {
            return [LINUX_PROVIDER, PLAINTEXT_PROVIDER]
        }
        return [PLAINTEXT_PROVIDER]
    }

    if ((policy === WINDOWS_PROVIDER && platform !== "win32")
        || (policy === LINUX_PROVIDER && platform !== "linux")) {
        throw new CredentialError("unsupported")
    }
    return [policy]
}

function readOwnDataValue(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
        throw new CredentialError("failed")
    }
    return descriptor.value
}

function sanitizeProviderError(error: unknown): CredentialError {
    try {
        if (error instanceof CredentialError) {
            const code = readOwnDataValue(error, "code")
            switch (code) {
                case "locked":
                case "denied":
                case "invalid":
                case "unsafe_location":
                case "too_large":
                case "failed":
                case "missing":
                case "incomplete":
                case "unavailable":
                case "unsupported":
                    return new CredentialError(code)
            }
        }
    } catch {
        // Untrusted errors can fail reflection as well.
    }
    return new CredentialError("failed")
}

function validateReadResult(result: unknown): CredentialReadResult {
    try {
        if (typeof result === "object" && result !== null && !Array.isArray(result)) {
            const status = readOwnDataValue(result, "status")
            switch (status) {
                case "found":
                    return { status, profile: readOwnDataValue(result, "profile") }
                case "missing":
                case "incomplete":
                case "unavailable":
                    return { status }
            }
        }
    } catch {
        // Malformed results cannot authorize fallback through accessor or proxy failures.
    }
    throw new CredentialError("failed")
}

async function readProvider(
    providers: CredentialResolverOptions["providers"],
    providerName: CredentialProviderName,
    kind: CredentialKind,
    normalizedId: string,
): Promise<CredentialReadResult> {
    let result: unknown
    try {
        const provider = Object.hasOwn(providers, providerName) ? providers[providerName] : undefined
        if (provider === undefined) {
            return { status: "unavailable" }
        }
        result = await provider.read(kind, normalizedId)
    } catch (error: unknown) {
        throw sanitizeProviderError(error)
    }
    return validateReadResult(result)
}

export function createCredentialResolver(options: CredentialResolverOptions): CredentialResolver {
    const {
        providers,
        provider: policy = AUTO_PROVIDER_POLICY,
        platform = process.platform,
        onSource,
        warn = console.warn,
    } = options

    return {
        async resolve<K extends CredentialKind>(kind: K, id: string): Promise<ResolvedCredentialProfile<K>> {
            if (!isCredentialProviderPolicy(policy)) {
                throw new CredentialError("invalid")
            }
            const normalizedId = normalizeCredentialId(kind, id)
            const providerOrder = getProviderOrder(policy, platform)
            let sawIncomplete = false
            let sawMissing = false

            for (const provider of providerOrder) {
                const result = await readProvider(providers, provider, kind, normalizedId)
                const validation = result.status === "found"
                    ? validateCredentialProfile(kind, result.profile)
                    : result

                if (validation.status === "found") {
                    try {
                        onSource?.(Object.freeze({ kind, provider }))
                    } catch {
                        // Source callbacks must not affect selected credentials.
                    }
                    if (provider === PLAINTEXT_PROVIDER) {
                        try {
                            warn(PLAINTEXT_CREDENTIAL_WARNING)
                        } catch {
                            // Logging failures must not escape or trigger fallback.
                        }
                    }
                    return { kind, provider, profile: validation.profile }
                }

                if (policy !== AUTO_PROVIDER_POLICY) {
                    throw new CredentialError(validation.status)
                }
                sawIncomplete ||= validation.status === "incomplete"
                sawMissing ||= validation.status === "missing"
            }

            throw new CredentialError(sawIncomplete ? "incomplete" : sawMissing ? "missing" : "unavailable")
        },
        async enumerate(kind: CredentialKind): Promise<CredentialEnumerationResult> {
            if (kind !== "ssh" && kind !== "db" && kind !== "rest") {
                throw new CredentialError("invalid")
            }
            if (!isCredentialProviderPolicy(policy)) {
                throw new CredentialError("invalid")
            }

            const ids = new Set<string>()
            const unavailableProviders: CredentialProviderName[] = []
            for (const providerName of getProviderOrder(policy, platform)) {
                const provider = Object.hasOwn(providers, providerName) ? providers[providerName] : undefined
                if (provider?.enumerate === undefined) {
                    unavailableProviders.push(providerName)
                    continue
                }
                try {
                    const candidateIds = await provider.enumerate(kind)
                    if (!Array.isArray(candidateIds)) {
                        throw new CredentialError("failed")
                    }
                    for (const id of candidateIds) {
                        if (typeof id !== "string" || normalizeCredentialId(kind, id) !== id) {
                            throw new CredentialError("failed")
                        }
                        ids.add(id)
                    }
                } catch {
                    unavailableProviders.push(providerName)
                }
            }

            return {
                ids: [...ids].sort(),
                unavailableProviders,
            }
        },
    }
}
