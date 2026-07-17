// Structured logger for external GitHub skill bootstrap. Writes to ~/.config/opencode/autocode/skills.log and silently no-ops on permission errors.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const LOG_PATH = path.join(process.env.HOME ?? os.homedir() ?? "~", ".config/opencode/autocode/skills.log")

export type SkillLogger = {
    log(message: string): void
}

export function createSkillLogger(): SkillLogger {
    let enabled = true

    try {
        mkdirSync(path.dirname(LOG_PATH), { recursive: true })
        writeFileSync(LOG_PATH, "", { flag: "w" })
    } catch {
        enabled = false
    }

    return {
        log(message: string): void {
            if (!enabled) {
                return
            }

            const line = `[${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}] ${message}\n`

            try {
                appendFileSync(LOG_PATH, line)
            } catch {
                enabled = false
            }
        },
    }
}
