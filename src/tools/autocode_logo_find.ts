import { tool } from "@opencode-ai/plugin"
import { access } from "node:fs/promises"
import path from "node:path"

type FileSystem = {
    access: (filePath: string) => Promise<void>
}

const defaultFileSystem: FileSystem = {
    access,
}

const logoBasePaths = [
    "assets/logo",
    "images/logo",
    "docs/logo",
    "docs/images/logo",
    "assets/favicon",
    "static/favicon",
    "public/favicon",
] as const

const logoExtensions = ["svg", "webp", "png", "jpg"] as const

function candidatePaths(): string[] {
    return logoBasePaths.flatMap((basePath) => logoExtensions.map((extension) => `${basePath}.${extension}`))
}

function logoNotFoundResult(searched: string[]) {
    return JSON.stringify({
        found: false,
        path: null,
        message: "No logo or favicon found.",
        searched,
    })
}

export function createAutocodeLogoFindTool(fileSystem: FileSystem = defaultFileSystem) {
    return tool({
        description: "Find project logo path.",
        args: {},
        async execute(_, context) {
            const searched = candidatePaths()

            try {
                for (const relativePath of searched) {
                    try {
                        await fileSystem.access(path.join(context.worktree, relativePath))
                        return JSON.stringify({
                            found: true,
                            path: relativePath,
                        })
                    }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                            throw error
                        }
                    }
                }

                return logoNotFoundResult(searched)
            }
            catch {
                return logoNotFoundResult(searched)
            }
        },
    })
}
