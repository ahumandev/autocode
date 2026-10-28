import { canReadCredentialFile } from "./file-access"
import { listCredentialProfiles, type CredentialProfileListing } from "./lookup"
import { createAbortResponse } from "../utils/tools"
import {
    CredentialError,
    type CredentialKind,
    type CredentialResolver,
    type DbCredentialProfile,
    type RestCredentialProfile,
    type SshCredentialProfile,
} from "./types"

type SecretField = readonly [name: string, value: string]

function maskCredentialValue(value: string): string {
    const suffix = Array.from(value).slice(-2)
    return suffix.length === 2 ? `*${suffix.join("")}` : "*"
}

async function getSecretFields(kind: CredentialKind, profile: unknown): Promise<SecretField[]> {
    if (kind === "db") {
        const dbProfile = profile as DbCredentialProfile
        const fields: SecretField[] = []
        const connection = dbProfile.connection.trim().replace(/^jdbc:/i, "")
        if (connection) fields.push(["CONNECTION", connection])
        const username = dbProfile.username?.trim()
        if (username) fields.push(["USERNAME", username])
        const password = dbProfile.password?.trim()
        if (password) fields.push(["PASSWORD", password])
        return fields
    }

    if (kind === "rest") {
        const restProfile = profile as RestCredentialProfile
        if (restProfile.authorization !== undefined) {
            return [["AUTHORIZATION", restProfile.authorization]]
        }
        if (restProfile.username !== undefined && restProfile.password !== undefined) {
            return [["USERNAME", restProfile.username], ["PASSWORD", restProfile.password]]
        }
        return []
    }

    const sshProfile = profile as SshCredentialProfile
    const fields: SecretField[] = []
    if (sshProfile.username) fields.push(["USERNAME", sshProfile.username])
    if (sshProfile.password) fields.push(["PASSWORD", sshProfile.password])
    if (sshProfile.keyfile && await canReadCredentialFile(sshProfile.keyfile) && sshProfile.keypass?.trim()) {
        fields.push(["KEYPASS", sshProfile.keypass])
    }
    return fields
}

export async function formatCredentialListing(resolver: CredentialResolver): Promise<string> {
    const listing: CredentialProfileListing = await listCredentialProfiles(resolver)
    const lines: string[] = []
    for (const { kind, id, profile } of listing.profiles) {
        const key = `AUTOCODE_${kind.toUpperCase()}_${id}`
        const fields = await getSecretFields(kind, profile)
        if (fields.length === 0) {
            lines.push(key)
        } else {
            lines.push(...fields.map(([field, value]) => `${key}_${field}=${maskCredentialValue(value)}`))
        }
    }
    if (listing.unavailableProviders.length > 0) {
        lines.push(`Provider coverage incomplete: ${listing.unavailableProviders.join(", ")}`)
    }
    if (listing.truncated) {
        lines.push("Credential listing incomplete: safety candidate limit reached.")
    }
    return lines.join("\n") || "No usable credentials found."
}

export function createCredentialListingErrorResponse(): string {
    return createAbortResponse("list credentials", new CredentialError("failed"))
}
