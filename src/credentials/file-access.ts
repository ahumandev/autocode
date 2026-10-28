import { constants as fsConstants } from "node:fs"
import { access } from "node:fs/promises"

export async function canReadCredentialFile(filePath: string): Promise<boolean> {
    try {
        await access(filePath, fsConstants.R_OK)
        return true
    } catch {
        return false
    }
}
