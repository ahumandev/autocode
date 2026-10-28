import { normalizeEnvKey, type NormalizeEnvKeyOptions } from "../utils/envkey"
import type { CredentialKind, CredentialProfile, CredentialProviderName, CredentialResolver, ResolvedCredentialProfile } from "./types"

export type CredentialIdOptions = Pick<NormalizeEnvKeyOptions, "errorMessage" | "label">

export function normalizeCredentialId(kind: CredentialKind, id: string, options: CredentialIdOptions = {}): string {
    if ((kind !== "ssh" && kind !== "db" && kind !== "rest") || typeof id !== "string") {
        throw new Error("Invalid credential kind or ID.")
    }

    return normalizeEnvKey(id, { ...options, allowHyphen: kind === "ssh" })
}

export function resolveCredentialProfile<K extends CredentialKind>(
    kind: K,
    normalizedId: string,
    resolver: CredentialResolver,
): Promise<ResolvedCredentialProfile<K>> {
    return resolver.resolve(kind, normalizedId)
}

export interface ListedCredentialProfile {
    readonly kind: CredentialKind
    readonly id: string
    readonly profile: CredentialProfile<CredentialKind>
}

export interface CredentialProfileListing {
    readonly profiles: readonly ListedCredentialProfile[]
    readonly unavailableProviders: readonly CredentialProviderName[]
    readonly truncated: boolean
}

// Repeated lookups reopen provider-backed stores; keep listing bounded and deterministic.
const MAX_LISTED_CREDENTIAL_CANDIDATES = 128

export async function listCredentialProfiles(resolver: CredentialResolver): Promise<CredentialProfileListing> {
    const enumerate = resolver.enumerate
    if (enumerate === undefined) {
        throw new Error("Credential resolver does not support profile enumeration.")
    }

    const profiles: ListedCredentialProfile[] = []
    const unavailableProviders = new Set<CredentialProviderName>()
    let candidateCount = 0
    let truncated = false
    for (const kind of ["db", "rest", "ssh"] as const) {
        const enumeration = await enumerate.call(resolver, kind)
        for (const provider of enumeration.unavailableProviders) {
            unavailableProviders.add(provider)
        }
        for (const id of enumeration.ids) {
            if (candidateCount >= MAX_LISTED_CREDENTIAL_CANDIDATES) {
                truncated = true
                break
            }
            candidateCount++
            try {
                if (normalizeCredentialId(kind, id) !== id) continue
                const resolved = await resolveCredentialProfile(kind, id, resolver)
                profiles.push({ kind, id, profile: resolved.profile })
            } catch {
                // Unresolvable or invalid candidates are not listed.
            }
        }
        if (truncated) break
    }

    return {
        profiles,
        unavailableProviders: [...unavailableProviders].sort(),
        truncated,
    }
}
