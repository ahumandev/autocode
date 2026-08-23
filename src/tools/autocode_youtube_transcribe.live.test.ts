import { describe, expect, test } from "bun:test"
import { createAutocodeYoutubeTranscribeTool } from "./autocode_youtube_transcribe"

type YoutubeTool = {
    execute(args: { url: string }): Promise<string>
}

type LiveTranscriptResult = {
    captionsAvailable: boolean
    selectedCaption: Record<string, unknown>
    transcript: string
}

describe("autocode_youtube_transcribe live", () => {
    if (process.env.AUTOCODE_LIVE_YOUTUBE_TEST === "1") {
        test("retrieves timestamped captions for r7epWYqRqog", async () => {
            const tool = createAutocodeYoutubeTranscribeTool() as unknown as YoutubeTool
            const response = JSON.parse(await tool.execute({
                url: "https://www.youtube.com/watch?v=r7epWYqRqog",
            })) as unknown

            if (typeof response !== "object" || response === null || Array.isArray(response)) {
                throw new Error(JSON.stringify(response))
            }
            if ("failedAction" in response || "error" in response) {
                throw new Error(JSON.stringify(response))
            }

            expect(response).toEqual(expect.objectContaining({
                captionsAvailable: true,
                selectedCaption: expect.any(Object),
                transcript: expect.any(String),
            }))
            const result = response as LiveTranscriptResult

            expect(result.captionsAvailable).toBe(true)
            expect(result.transcript).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\] .+/m)
        }, { timeout: 30_000 })
    }
    else {
        test.skip("retrieves timestamped captions for r7epWYqRqog", () => {})
    }
})
