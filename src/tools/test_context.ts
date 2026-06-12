import { Effect } from "effect"
import type { ToolContext } from "@opencode-ai/plugin"

export function createNoopAsk(): ToolContext["ask"] {
    return () => Effect.void
}

export function createAskEffect(run: (request: unknown) => void | Promise<void>): ToolContext["ask"] {
    return (request) => Effect.tryPromise({
        try: async () => {
            await run(request)
        },
        catch: (error) => error,
    }) as ReturnType<ToolContext["ask"]>
}

export function createToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
        sessionID: "session-1",
        messageID: "message-1",
        agent: "pair",
        directory: "/workspace",
        worktree: "/workspace",
        abort: new AbortController().signal,
        metadata() {
        },
        ask: createNoopAsk(),
        ...overrides,
    }
}
