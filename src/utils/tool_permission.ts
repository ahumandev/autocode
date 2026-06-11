import { Cause, Effect, Exit } from "effect"

function isPromiseLike(value: unknown): value is PromiseLike<void> {
    return typeof value === "object" && value !== null && typeof (value as PromiseLike<void>).then === "function"
}

export async function authorizeToolAsk(authorization: unknown): Promise<void> {
    if (Effect.isEffect(authorization)) {
        const exit = await Effect.runPromiseExit(authorization as Effect.Effect<void>)
        if (Exit.isSuccess(exit)) {
            return
        }

        const reason = exit.cause.reasons[0]
        if (reason && Cause.isFailReason(reason)) {
            throw reason.error
        }

        if (reason && Cause.isDieReason(reason)) {
            throw reason.defect
        }

        throw exit.cause
    }

    if (isPromiseLike(authorization)) {
        await authorization
        return
    }

    throw new Error("Tool context ask() returned a non-promise result")
}
