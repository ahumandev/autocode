// GitHub skill URL parser. Classifies URLs into repo, subtree, blob, or raw strategies (or invalid).

export type ParsedGitHubSkillUrl =
    | { strategy: "repo"; owner: string; project: string }
    | { strategy: "subtree"; owner: string; project: string; branch: string; subDirs: string }
    | { strategy: "blob"; owner: string; project: string; branch: string; subDirs: string; skillFile: string }
    | { strategy: "raw"; owner: string; project: string; branch: string; subDirs: string; skillFile: string }
    | { strategy: "invalid"; url: string; reason: string }

const RAW_RE =
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/refs\/heads\/([^/]+)\/(.+)\/SKILL\.md$/
const BLOB_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)\/SKILL\.md$/
const SUBTREE_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+?)\/?$/
const REPO_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/

/**
 * Classifies a URL into one of repo, subtree, blob, raw, or invalid.
 * Match order: raw (raw.githubusercontent.com) → blob → subtree → repo. Repo is checked last
 * because it is the most permissive shape and would otherwise swallow tree/blob URLs.
 * Never throws; bad input returns an `invalid` result.
 */
export function parseGitHubSkillUrl(url: string): ParsedGitHubSkillUrl {
    if (url.trim() === "") {
        return { strategy: "invalid", url, reason: "empty url" }
    }

    const rawMatch = RAW_RE.exec(url)
    if (rawMatch) {
        return {
            strategy: "raw",
            owner: rawMatch[1] ?? "",
            project: rawMatch[2] ?? "",
            branch: rawMatch[3] ?? "",
            subDirs: rawMatch[4] ?? "",
            skillFile: "SKILL.md",
        }
    }

    const blobMatch = BLOB_RE.exec(url)
    if (blobMatch) {
        return {
            strategy: "blob",
            owner: blobMatch[1] ?? "",
            project: blobMatch[2] ?? "",
            branch: blobMatch[3] ?? "",
            subDirs: blobMatch[4] ?? "",
            skillFile: "SKILL.md",
        }
    }

    const subtreeMatch = SUBTREE_RE.exec(url)
    if (subtreeMatch) {
        return {
            strategy: "subtree",
            owner: subtreeMatch[1] ?? "",
            project: subtreeMatch[2] ?? "",
            branch: subtreeMatch[3] ?? "",
            subDirs: subtreeMatch[4] ?? "",
        }
    }

    const repoMatch = REPO_RE.exec(url)
    if (repoMatch) {
        return {
            strategy: "repo",
            owner: repoMatch[1] ?? "",
            project: repoMatch[2] ?? "",
        }
    }

    // Distinguish unsupported hosts (e.g. https://example.com/foo) from a generic shape mismatch.
    try {
        const parsed = new URL(url)
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            if (parsed.host !== "github.com" && parsed.host !== "raw.githubusercontent.com") {
                return { strategy: "invalid", url, reason: "unsupported host" }
            }
        }
    } catch {
        // Not a parseable URL: fall through to the generic invalid reason.
    }

    return { strategy: "invalid", url, reason: "URL did not match any known GitHub skill URL pattern" }
}

/** Returns the HTTPS clone URL for any valid strategy, or `null` when the parsed input is invalid. */
export function cloneUrlFor(parsed: ParsedGitHubSkillUrl): string | null {
    if (parsed.strategy === "invalid") {
        return null
    }
    return `https://github.com/${parsed.owner}/${parsed.project}.git`
}
