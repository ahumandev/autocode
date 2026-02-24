export const MAX_RETRIES = 5

const sessions = new Map<string, { tool: string; count: number }>()

export function trackFailure(sessionID: string, toolName: string): { retriesLeft: number; shouldAbort: boolean } {
    const state = sessions.get(sessionID)
    const count = (state?.tool === toolName ? state.count : 0) + 1
    sessions.set(sessionID, { tool: toolName, count })
    const retriesLeft = MAX_RETRIES - count
    return { retriesLeft, shouldAbort: retriesLeft <= 0 }
}

export function getStatus(sessionID: string, toolName: string): { retriesLeft: number; shouldAbort: boolean } {
    const state = sessions.get(sessionID)
    const count = state?.tool === toolName ? state.count : 0
    const retriesLeft = MAX_RETRIES - count
    return { retriesLeft, shouldAbort: retriesLeft <= 0 }
}

export function resetTool(sessionID: string, toolName: string): void {
    const state = sessions.get(sessionID)
    if (state?.tool === toolName) {
        state.count = 0
    }
}

export function resetSession(sessionID: string): void {
    sessions.delete(sessionID)
}
