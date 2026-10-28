import { tool } from "@opencode-ai/plugin"
import { createRuntimeCredentialResolver } from "../credentials/runtime"
import type { CredentialResolver } from "../credentials/types"
import { createCredentialListingErrorResponse, formatCredentialListing } from "../credentials/listing"

export function createAutocodeCredentialsListTool(
    credentialResolver: CredentialResolver = createRuntimeCredentialResolver(),
): ReturnType<typeof tool> {
    return tool({
        description: "List credentials available for autocode_db_*, autocode_rest_*, and autocode_ssh_* tools.",
        args: {},
        async execute(): Promise<string> {
            try {
                return await formatCredentialListing(credentialResolver)
            } catch {
                return createCredentialListingErrorResponse()
            }
        },
    })
}
