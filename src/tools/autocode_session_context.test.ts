import { describe, expect, mock, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk"
import { createAbortResponse } from "../utils/tools"
import { createAutocodeSessionContextTool } from "./autocode_session_context"
import { createToolContext } from "./test_context"

type JsonObject = Record<string, unknown>
type SessionRequest = { path: { id: string }, query: { directory: string | undefined } }

function parseToolResult(result: string): JsonObject {
    return JSON.parse(result) as JsonObject
}

function createContext(): ReturnType<typeof createToolContext> {
    return createToolContext({
        sessionID: "sess-123",
        messageID: "msg-current",
        agent: "temp_output",
        directory: "/repo",
        worktree: "/repo-wt",
    })
}

describe("autocode_session_context tool", () => {
    test("declares an empty schema", () => {
        const tool = createAutocodeSessionContextTool({} as OpencodeClient)

        expect(tool.args).toEqual({})
    })

    test("returns sanitized session context, usage totals, and no raw content", async () => {
        const sessionGet = mock(async (_request: SessionRequest) => ({
            data: {
                id: "sess-123",
                projectID: "proj-1",
                directory: "/repo",
                parentID: "parent-1",
                title: "Session title",
                version: "7",
                time: { created: 10, updated: 20 },
                summary: {
                    additions: 3,
                    deletions: 4,
                    files: 5,
                    diff: "SECRET_DIFF_DO_NOT_LEAK",
                    content: "USER_SECRET_DO_NOT_LEAK",
                },
                system: "SYSTEM_SECRET_DO_NOT_LEAK",
                tools: [{ content: "TOOL_SECRET_DO_NOT_LEAK" }],
                share: { url: "https://secret.example/share" },
                revert: { diff: "SECRET_DIFF_DO_NOT_LEAK" },
            },
        }))
        const sessionMessages = mock(async (_request: SessionRequest) => ({
            data: [
                {
                    info: {
                        id: "msg-user",
                        role: "user",
                        time: { created: 30 },
                        agent: "pair",
                        model: { providerID: "provider-u", modelID: "model-u", extra: "ignored" },
                        content: "USER_SECRET_DO_NOT_LEAK",
                        text: "USER_SECRET_DO_NOT_LEAK",
                        system: "SYSTEM_SECRET_DO_NOT_LEAK",
                        tools: [{ data: "TOOL_SECRET_DO_NOT_LEAK" }],
                        share: { url: "https://secret.example/share" },
                        revert: { diff: "SECRET_DIFF_DO_NOT_LEAK" },
                    },
                    parts: [
                        { id: "part-user", type: "text", text: "NON_STEP_SECRET_DO_NOT_LEAK", data: "NON_STEP_SECRET_DO_NOT_LEAK" },
                    ],
                },
                {
                    info: {
                        id: "msg-assistant",
                        role: "assistant",
                        time: { created: 40 },
                        parentID: "msg-user",
                        providerID: "provider-a",
                        modelID: "model-a",
                        mode: "build",
                        cost: 1.23,
                        tokens: { input: 101, output: 202, reasoning: 303, cache: { read: 404, write: 505 } },
                        finish: { reason: "stop" },
                        content: "ASSISTANT_SECRET_DO_NOT_LEAK",
                        text: "ASSISTANT_SECRET_DO_NOT_LEAK",
                        system: "SYSTEM_SECRET_DO_NOT_LEAK",
                        tools: [{ data: "TOOL_SECRET_DO_NOT_LEAK" }],
                        share: { url: "https://secret.example/share" },
                        revert: { diff: "SECRET_DIFF_DO_NOT_LEAK" },
                    },
                    parts: [
                        {
                            id: "step-1",
                            type: "step-finish",
                            messageID: "msg-assistant",
                            cost: 4.56,
                            tokens: { input: 11, output: 22, reasoning: 33, cache: { read: 44, write: 55 } },
                            reason: "complete",
                            finish: { reason: "stop" },
                            text: "ASSISTANT_SECRET_DO_NOT_LEAK",
                            tool: "TOOL_SECRET_DO_NOT_LEAK",
                            data: "NON_STEP_SECRET_DO_NOT_LEAK",
                        },
                        { id: "part-raw", type: "tool", text: "NON_STEP_SECRET_DO_NOT_LEAK", data: "NON_STEP_SECRET_DO_NOT_LEAK" },
                    ],
                },
            ],
        }))
        const client = {
            session: {
                get: sessionGet,
                messages: sessionMessages,
            },
        } as unknown as OpencodeClient

        const result = await createAutocodeSessionContextTool(client).execute({}, createContext())
        const payload = parseToolResult(result as string)

        expect(sessionGet.mock.calls).toEqual([[{ path: { id: "sess-123" }, query: { directory: "/repo" } }]])
        expect(sessionMessages.mock.calls).toEqual([[{ path: { id: "sess-123" }, query: { directory: "/repo" } }]])
        expect(payload.tool_context).toEqual({
            session_id: "sess-123",
            message_id: "msg-current",
            agent: "temp_output",
            directory: "/repo",
            worktree: "/repo-wt",
        })
        expect(payload.session).toEqual({
            id: "sess-123",
            project_id: "proj-1",
            directory: "/repo",
            parent_id: "parent-1",
            title: "Session title",
            version: "7",
            time: { created: 10, updated: 20 },
            summary: { additions: 3, deletions: 4, files: 5 },
        })
        expect(Object.keys(payload.session as JsonObject).sort()).toEqual(["directory", "id", "parent_id", "project_id", "summary", "time", "title", "version"])
        expect((payload.session as JsonObject).system).toBeUndefined()
        expect((payload.session as JsonObject).tools).toBeUndefined()
        expect((payload.session as JsonObject).share).toBeUndefined()
        expect((payload.session as JsonObject).revert).toBeUndefined()
        expect(payload.messages).toEqual([
            {
                id: "msg-user",
                role: "user",
                time: { created: 30 },
                agent: "pair",
                model: { provider_id: "provider-u", model_id: "model-u" },
            },
            {
                id: "msg-assistant",
                role: "assistant",
                time: { created: 40 },
                parent_id: "msg-user",
                provider_id: "provider-a",
                model_id: "model-a",
                mode: "build",
                cost: 1.23,
                tokens: { input: 101, output: 202, reasoning: 303, cache: { read: 404, write: 505 } },
                finish: { reason: "stop" },
            },
        ])
        expect(Object.keys((payload.messages as JsonObject[])[0] ?? {}).sort()).toEqual(["agent", "id", "model", "role", "time"])
        expect(Object.keys((payload.messages as JsonObject[])[1] ?? {}).sort()).toEqual(["cost", "finish", "id", "mode", "model_id", "parent_id", "provider_id", "role", "time", "tokens"])
        expect(payload.step_finish_parts).toEqual([
            {
                message_id: "msg-assistant",
                part_id: "step-1",
                cost: 4.56,
                tokens: { input: 11, output: 22, reasoning: 33, cache: { read: 44, write: 55 } },
                reason: "complete",
                finish: { reason: "stop" },
            },
        ])
        expect(Object.keys((payload.step_finish_parts as JsonObject[])[0] ?? {}).sort()).toEqual(["cost", "finish", "message_id", "part_id", "reason", "tokens"])
        expect(payload.totals).toEqual({
            message_cost: 1.23,
            message_tokens: { input: 101, output: 202, reasoning: 303, cache: { read: 404, write: 505 } },
            step_finish_cost: 4.56,
            step_finish_tokens: { input: 11, output: 22, reasoning: 33, cache: { read: 44, write: 55 } },
            message_count: 2,
            user_message_count: 1,
            assistant_message_count: 1,
            step_finish_part_count: 1,
        })

        const serializedPayload = JSON.stringify(payload)
        for (const forbidden of [
            "USER_SECRET_DO_NOT_LEAK",
            "ASSISTANT_SECRET_DO_NOT_LEAK",
            "SYSTEM_SECRET_DO_NOT_LEAK",
            "TOOL_SECRET_DO_NOT_LEAK",
            "https://secret.example/share",
            "SECRET_DIFF_DO_NOT_LEAK",
            "NON_STEP_SECRET_DO_NOT_LEAK",
            "\"system\"",
            "\"tools\"",
            "\"share\"",
            "\"revert\"",
            "\"diff\"",
            "\"content\"",
            "\"text\"",
        ]) {
            expect(serializedPayload).not.toContain(forbidden)
        }
    })

    test("returns abort error response when client is unavailable", async () => {
        const result = await createAutocodeSessionContextTool(undefined).execute({}, createContext())

        expect(result).toBe(createAbortResponse("autocode_session_context", "Unable to inspect current session: client is unavailable"))
        expect(parseToolResult(result as string)).toEqual(expect.objectContaining({
            failedAction: "autocode_session_context",
            error: "Unable to inspect current session: client is unavailable",
            instruction: expect.stringContaining("Immediately ABORT your flow"),
        }))
    })
})
