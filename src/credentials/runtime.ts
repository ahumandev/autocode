import { createPlaintextCredentialProvider } from "./plaintext"
import { createCredentialResolver } from "./resolver"
import {
    CredentialError,
    type CredentialKind,
    type CredentialProvider,
    type CredentialProviderName,
    type CredentialReadResult,
    type CredentialResolver,
} from "./types"
import { createWindowsCredentialProvider } from "./windows"

export interface RuntimeCredentialResolverOptions {
    provider?: "auto" | CredentialProviderName
    globalConfigRoot?: string
    warn?: (message: string) => void
}

export function createRuntimeCredentialResolver(options?: RuntimeCredentialResolverOptions): CredentialResolver {
    const providers: Partial<Record<CredentialProviderName, CredentialProvider>> = {
        plaintext: createPlaintextCredentialProvider({ globalConfigRoot: options?.globalConfigRoot }),
    }
    if (process.platform === "win32") {
        providers["windows-credential-manager"] = createWindowsCredentialProvider()
    } else if (process.platform === "linux") {
        let linuxProvider: Promise<CredentialProvider> | undefined
        providers["linux-secret-service"] = {
            async read(kind: CredentialKind, normalizedId: string): Promise<CredentialReadResult> {
                linuxProvider ??= import("./linux.js").then(
                    (module: typeof import("./linux.js")): CredentialProvider => module.createLinuxSecretServiceProvider(),
                )
                return (await linuxProvider).read(kind, normalizedId)
            },
            async enumerate(kind: CredentialKind): Promise<string[]> {
                linuxProvider ??= import("./linux.js").then(
                    (module: typeof import("./linux.js")): CredentialProvider => module.createLinuxSecretServiceProvider(),
                )
                const provider = await linuxProvider
                if (provider.enumerate === undefined) {
                    throw new CredentialError("unsupported")
                }
                return provider.enumerate(kind)
            },
        }
    }
    return createCredentialResolver({
        providers,
        provider: options?.provider,
        platform: process.platform,
        warn: options?.warn,
    })
}
