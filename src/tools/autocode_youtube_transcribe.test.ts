import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createAbortResponse, resetRetryCounts } from "@/utils/tools"

type StringSchema = { safeParse(input: unknown): { success: boolean } }
type BooleanSchema = { safeParse(input: unknown): { success: boolean, data?: boolean } }
type YoutubeTool = { args: { url: StringSchema, timestamps: BooleanSchema }, execute(args: { url: string, timestamps?: boolean }): Promise<string> }
type CaptionTrack = { base_url: string, name: { toString(): string }, vss_id: string, language_code: string, kind?: "asr" | "frc" }
type YoutubeInfo = {
    basic_info: {
        title?: unknown
        author?: unknown
        channel?: { name?: unknown, id?: unknown }
        channel_id?: unknown
        duration?: number
        view_count?: number
    }
    captions?: {
        caption_tracks?: CaptionTrack[]
        audio_tracks?: Array<{ default_caption_track_index?: number, has_default_track: boolean, caption_track_indices: number[] }>
        default_audio_track_index?: number
    }
    page: Array<{ microformat?: unknown }>
}

const VIDEO_ID = "dQw4w9WgXcQ"
let currentInfo: YoutubeInfo
let currentTranscript: unknown
const getBasicInfo = mock(async (_videoId: string): Promise<YoutubeInfo> => currentInfo)
const innertubeCreate = mock(async () => ({ getBasicInfo }))
const fetchTranscript = mock(async (_videoId: string, _config: unknown): Promise<unknown> => currentTranscript)
const originalFetch = globalThis.fetch
const captionFetch = mock(async (..._args: Parameters<typeof fetch>): Promise<Response> => {
    throw new Error("Unexpected direct caption request")
})

mock.module("youtubei.js", () => ({ default: { create: innertubeCreate } }))
mock.module("youtube-transcript", () => ({ fetchTranscript }))

const { createAutocodeYoutubeTranscribeTool } = await import("./autocode_youtube_transcribe")

function createInfo(overrides: Partial<YoutubeInfo> = {}): YoutubeInfo {
    return {
        basic_info: {
            title: "Video title",
            author: "Channel author",
            channel: { name: "Channel name", id: "channel-id" },
            channel_id: "fallback-channel-id",
            duration: 123.5,
            view_count: 456,
        },
        captions: {},
        page: [{ microformat: { publish_date: "2026-08-23" } }],
        ...overrides,
    }
}

function createCaptionTrack(options: { baseUrl: string, languageCode: string, languageName: string, vssId?: string, kind?: "asr" | "frc" }): CaptionTrack {
    return {
        base_url: options.baseUrl,
        name: { toString: (): string => options.languageName },
        vss_id: options.vssId ?? `.${options.languageCode}`,
        language_code: options.languageCode,
        kind: options.kind,
    }
}

function transcriptCue(offset: unknown, duration: unknown, text: string): unknown {
    return { offset, duration, text }
}

function setTracks(tracks: CaptionTrack[], originalIndex?: number): void {
    currentInfo.captions = {
        caption_tracks: tracks,
        ...(originalIndex === undefined ? {} : { audio_tracks: [{ has_default_track: true, caption_track_indices: [originalIndex] }] }),
    }
}

function createTool(): YoutubeTool {
    return createAutocodeYoutubeTranscribeTool() as unknown as YoutubeTool
}

function parseResult(result: string): Record<string, unknown> {
    return JSON.parse(result) as Record<string, unknown>
}

function retry(error: string): Record<string, unknown> {
    return { failedAction: "autocode_youtube_transcribe", error, instruction: "Retry the same YouTube video URL later." }
}

async function execute(url = `https://youtu.be/${VIDEO_ID}`, timestamps?: boolean): Promise<Record<string, unknown>> {
    return parseResult(await createTool().execute({ url, ...(timestamps === undefined ? {} : { timestamps }) }))
}

describe("autocode_youtube_transcribe", () => {
    beforeEach(() => {
        globalThis.fetch = captionFetch as unknown as typeof fetch
        resetRetryCounts()
        currentInfo = createInfo()
        currentTranscript = [transcriptCue(0, 1, "Caption")]
        getBasicInfo.mockClear()
        getBasicInfo.mockImplementation(async (_videoId: string): Promise<YoutubeInfo> => currentInfo)
        innertubeCreate.mockClear()
        fetchTranscript.mockClear()
        captionFetch.mockClear()
        innertubeCreate.mockImplementation(async () => ({ getBasicInfo }))
        fetchTranscript.mockImplementation(async (): Promise<unknown> => currentTranscript)
    })

    afterAll(() => {
        globalThis.fetch = originalFetch
        mock.restore()
    })

    test("01 exposes required url and optional timestamps tool arguments", () => {
        const tool = createTool()
        expect(Object.keys(tool.args)).toEqual(["url", "timestamps"])
        expect(tool.args.url.safeParse(undefined).success).toBe(false)
        expect(tool.args.url.safeParse(1).success).toBe(false)
        expect(tool.args.url.safeParse(`https://www.youtube.com/watch?v=${VIDEO_ID}`).success).toBe(true)
        expect(tool.args.timestamps.safeParse(undefined)).toEqual({ success: true, data: false })
        expect(tool.args.timestamps.safeParse("false").success).toBe(false)
        expect(tool.args.timestamps.safeParse(false).success).toBe(true)
        expect(tool.args.timestamps.safeParse(true).success).toBe(true)
    })

    test("02 accepts every supported YouTube video URL form", async () => {
        const urls = [
            `https://www.youtube.com/watch?v=${VIDEO_ID}`,
            `https://youtu.be/${VIDEO_ID}`,
            `https://www.youtube.com/shorts/${VIDEO_ID}`,
            `https://www.youtube.com/embed/${VIDEO_ID}`,
            `https://www.youtube-nocookie.com/embed/${VIDEO_ID}`,
        ]
        for (const url of urls) expect((await execute(url)).captionsAvailable).toBe(false)
        expect(getBasicInfo.mock.calls.map(([videoId]) => videoId)).toEqual(Array(urls.length).fill(VIDEO_ID))
    })

    test("03 rejects malformed URL before metadata lookup", async () => {
        expect(await execute("not a URL")).toEqual({
            failedAction: "autocode_youtube_transcribe",
            error: "Invalid YouTube URL.",
            instruction: "Provide a supported YouTube video URL with one 11-character video ID.",
        })
        expect(getBasicInfo).not.toHaveBeenCalled()
    })

    test("04 rejects non-YouTube host", async () => {
        expect((await execute(`https://example.com/watch?v=${VIDEO_ID}`)).error).toBe("URL host is not an accepted YouTube video host.")
    })

    test("05 rejects playlist-only URL", async () => {
        expect((await execute("https://www.youtube.com/playlist?list=PL123")).error).toBe("URL must identify one YouTube video with an 11-character video ID.")
    })

    test("06 rejects malformed video ID", async () => {
        expect((await execute("https://youtu.be/short")).error).toBe("URL must identify one YouTube video with an 11-character video ID.")
    })

    test("07 rejects duplicate watch IDs", async () => {
        expect((await execute(`https://www.youtube.com/watch?v=${VIDEO_ID}&v=${VIDEO_ID}`)).error).toBe("URL must identify one YouTube video with an 11-character video ID.")
    })

    test("08 accepts watch URL with unrelated playlist query", async () => {
        expect((await execute(`https://www.youtube.com/watch?v=${VIDEO_ID}&list=PL123`)).captionsAvailable).toBe(false)
        expect(getBasicInfo).toHaveBeenCalledWith(VIDEO_ID)
    })

    test("09 returns normal no-track result with normalized metadata", async () => {
        expect(await execute(`https://www.youtube.com/watch?v=${VIDEO_ID}`)).toEqual({
            video: {
                id: VIDEO_ID,
                canonicalUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
                title: "Video title",
                channelName: "Channel name",
                channelId: "channel-id",
                durationSeconds: 123.5,
                viewCount: 456,
                publishDate: "2026-08-23",
            },
            captionsAvailable: false,
            selectedCaption: null,
            transcript: null,
            message: "No caption tracks are available for this video.",
        })
        expect(fetchTranscript).not.toHaveBeenCalled()
        expect(captionFetch).not.toHaveBeenCalled()
    })

    test("10 falls back from empty channel fields to author metadata", async () => {
        currentInfo.basic_info = { ...currentInfo.basic_info, channel: { name: "", id: "" } }
        expect((await execute()).video).toEqual(expect.objectContaining({ channelName: "Channel author", channelId: "fallback-channel-id" }))
    })

    test("11 normalizes missing metadata fields to null", async () => {
        currentInfo.basic_info = {}
        currentInfo.page = []
        expect((await execute()).video).toEqual(expect.objectContaining({
            title: null,
            channelName: null,
            channelId: null,
            durationSeconds: null,
            viewCount: null,
            publishDate: null,
        }))
    })

    test("12 treats unusable caption tracks as no tracks", async () => {
        setTracks([createCaptionTrack({ baseUrl: "", languageCode: "en", languageName: "English" })])
        expect(await execute()).toMatchObject({ captionsAvailable: false, selectedCaption: null, transcript: null, message: "No caption tracks are available for this video." })
        expect(fetchTranscript).not.toHaveBeenCalled()
    })

    test("13 ranks exact original language first", async () => {
        setTracks([
            createCaptionTrack({ baseUrl: "en-gb", languageCode: "en-GB", languageName: "English UK" }),
            createCaptionTrack({ baseUrl: "en-us", languageCode: "en-US", languageName: "English US", kind: "asr" }),
        ], 1)
        expect((await execute()).selectedCaption).toEqual(expect.objectContaining({ languageCode: "en-us", source: "auto", isOriginal: true }))
    })

    test("14 ranks original primary language fallback second", async () => {
        setTracks([
            createCaptionTrack({ baseUrl: "", languageCode: "en-US", languageName: "Unavailable original" }),
            createCaptionTrack({ baseUrl: "fr", languageCode: "fr", languageName: "French" }),
            createCaptionTrack({ baseUrl: "en-gb", languageCode: "en-GB", languageName: "English UK" }),
        ], 0)
        expect((await execute()).selectedCaption).toEqual(expect.objectContaining({ languageCode: "en-gb" }))
    })

    test("15 ranks deterministic language fallback", async () => {
        setTracks([
            createCaptionTrack({ baseUrl: "z", languageCode: "zu", languageName: "Zulu" }),
            createCaptionTrack({ baseUrl: "a", languageCode: "de", languageName: "German" }),
        ])
        expect((await execute()).selectedCaption).toEqual(expect.objectContaining({ languageCode: "de" }))
    })

    test("16 prefers manual caption over auto caption for same language", async () => {
        setTracks([
            createCaptionTrack({ baseUrl: "auto", languageCode: "en", languageName: "English", kind: "asr" }),
            createCaptionTrack({ baseUrl: "manual", languageCode: "en", languageName: "English" }),
        ])
        expect((await execute()).selectedCaption).toEqual(expect.objectContaining({ source: "manual" }))
    })

    test("17 preserves stable caption ranking ties", async () => {
        setTracks([
            createCaptionTrack({ baseUrl: "z", languageCode: "en", languageName: "English" }),
            createCaptionTrack({ baseUrl: "a", languageCode: "en", languageName: "English" }),
        ])
        expect((await execute()).selectedCaption).toEqual(expect.objectContaining({ languageCode: "en", source: "manual" }))
    })

    test("18 cleans package cue whitespace", async () => {
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        currentTranscript = [transcriptCue(0, 1, " Hello\n world\t")]
        expect((await execute()).transcript).toBe("1. Hello world")
    })

    test("19 sorts explicit false package cues as numbered transcript", async () => {
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        currentTranscript = [transcriptCue(1, 1, "Second"), transcriptCue(0, 1, "First")]
        expect((await execute(undefined, false)).transcript).toBe("1. First Second")
    })

    test("20 formats true timestamps with whole-second zero, fractional, and hour values", async () => {
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        currentTranscript = [transcriptCue(3_661_007, 500, "Hour"), transcriptCue(1_999, 0, "Fractional"), transcriptCue(0, 0, "Zero")]
        expect((await execute(undefined, true)).transcript).toBe("* 0:00:00 Zero\n* 0:00:01 Fractional\n* 1:01:01 Hour")
    })

    test("21 clamps negative package cue timestamps", async () => {
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        currentTranscript = [transcriptCue(-5, 1, "Negative")]
        expect((await execute()).transcript).toBe("1. Negative")
    })

    test("22 uses getBasicInfo for caption metadata", async () => {
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        await execute()
        expect(getBasicInfo).toHaveBeenCalledWith(VIDEO_ID)
    })

    test("23 passes selected language code to transcript package", async () => {
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en-US", languageName: "English (US)" })])
        await execute()
        expect(fetchTranscript.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ lang: "en-us" }))
    })

    test("24 passes native fetch and canonical URL to transcript package", async () => {
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        await execute()
        expect(fetchTranscript).toHaveBeenCalledWith(`https://www.youtube.com/watch?v=${VIDEO_ID}`, { lang: "en", fetch: globalThis.fetch })
    })

    test("25 treats classic fractional offsets as seconds", async () => {
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        currentTranscript = [transcriptCue(1.25, 0.5, "Classic")]
        expect((await execute()).transcript).toBe("1. Classic")
    })

    test("26 treats srv3 millisecond offsets as milliseconds", async () => {
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        currentTranscript = [transcriptCue(1_250, 500, "Srv3")]
        expect((await execute()).transcript).toBe("1. Srv3")
    })

    test("27 infers seconds from fractional cues without video duration", async () => {
        currentInfo.basic_info = { ...currentInfo.basic_info, duration: undefined }
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        currentTranscript = [transcriptCue(1.5, 0, "Fractional")]
        expect((await execute()).transcript).toBe("1. Fractional")
    })

    test("28 uses deterministic magnitude fallback without video duration", async () => {
        currentInfo.basic_info = { ...currentInfo.basic_info, duration: undefined }
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        currentTranscript = [transcriptCue(12_000, 0, "Magnitude")]
        expect((await execute()).transcript).toBe("1. Magnitude")
    })

    test("29 falls back when package returns empty cues", async () => {
        const adapterCalls: string[] = []
        setTracks([createCaptionTrack({ baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}`, languageCode: "en", languageName: "English" })])
        currentTranscript = []
        fetchTranscript.mockImplementation(async (): Promise<unknown> => {
            adapterCalls.push("primary")
            return currentTranscript
        })
        captionFetch.mockImplementation(async (): Promise<Response> => {
            adapterCalls.push("fallback")
            return new Response(JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: "Fallback" }] }] }))
        })
        expect(await execute()).toMatchObject({ captionsAvailable: true, transcript: "1. Fallback" })
        expect(adapterCalls).toEqual(["primary", "fallback"])
        expect(fetchTranscript).toHaveBeenCalledTimes(1)
        expect(captionFetch).toHaveBeenCalledTimes(1)
    })

    test("29a formats true timestamps from JSON3 fallback cues", async () => {
        setTracks([createCaptionTrack({ baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}`, languageCode: "en", languageName: "English" })])
        currentTranscript = []
        captionFetch.mockImplementation(async (): Promise<Response> => new Response(JSON.stringify({
            events: [
                { tStartMs: 3_661_007, segs: [{ utf8: "Hour" }] },
                { tStartMs: 1_999, segs: [{ utf8: "Fractional" }] },
                { tStartMs: 0, segs: [{ utf8: "Fallback" }] },
            ],
        })))
        expect((await execute(undefined, true)).transcript).toBe("* 0:00:00 Fallback Fractional\n* 1:01:01 Hour")
    })

    test("30 falls back when package returns zero valid cues", async () => {
        setTracks([createCaptionTrack({ baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}`, languageCode: "en", languageName: "English" })])
        currentTranscript = [{ offset: "bad", duration: 0, text: "Ignored" }, { offset: 0, duration: 0, text: "" }]
        captionFetch.mockImplementation(async (): Promise<Response> => new Response(JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: "Fallback" }] }] })))
        expect(await execute()).toMatchObject({ captionsAvailable: true, transcript: "1. Fallback" })
        expect(fetchTranscript).toHaveBeenCalledTimes(1)
        expect(captionFetch).toHaveBeenCalledTimes(1)
    })

    test("31 returns normal empty result when both adapters return no valid cues", async () => {
        setTracks([createCaptionTrack({ baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}`, languageCode: "en", languageName: "English" })])
        currentTranscript = []
        captionFetch.mockImplementation(async (): Promise<Response> => new Response(JSON.stringify({ events: [] })))
        expect(await execute()).toMatchObject({ captionsAvailable: false, selectedCaption: null, transcript: null, message: "Caption track contains no transcript cues." })
        expect(fetchTranscript).toHaveBeenCalledTimes(1)
        expect(captionFetch).toHaveBeenCalledTimes(1)
    })

    test("32 returns normalized retry for malformed package root", async () => {
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        currentTranscript = { cues: [] }
        expect(await execute()).toEqual(retry("YouTube returned malformed caption JSON."))
    })

    test("33 falls back to selected JSON3 caption track after package failure", async () => {
        setTracks([createCaptionTrack({ baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}`, languageCode: "en", languageName: "English" })])
        fetchTranscript.mockImplementation(async (): Promise<unknown> => { throw new Error("usage limit reached") })
        captionFetch.mockImplementation(async (): Promise<Response> => new Response(JSON.stringify({
            events: [
                { tStartMs: "1250", segs: [{ utf8: " Hello\n" }, { utf8: "world\t" }] },
                { tStartMs: "0", segs: [{ utf8: "First &amp; foremost" }] },
            ],
        })))
        expect((await execute()).transcript).toBe("1. First & foremost Hello world")
        expect(String(captionFetch.mock.calls[0]?.[0])).toBe(`https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&fmt=json3`)
    })

    test("34 preserves package and HTTP fallback failure context", async () => {
        const failure = new Error("FAILED_PRECONDITION https://youtube.example/signed?token=secret")
        setTracks([createCaptionTrack({ baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}`, languageCode: "en", languageName: "English" })])
        fetchTranscript.mockImplementation(async (): Promise<unknown> => { throw failure })
        captionFetch.mockImplementation(async (): Promise<Response> => new Response(null, { status: 429 }))
        expect(await execute()).toEqual(retry("YouTube caption request failed: FAILED_PRECONDITION [request URL] Direct selected-caption fallback failed: Caption request returned HTTP 429."))
    })

    test("35 preserves package and malformed fallback failure context", async () => {
        setTracks([createCaptionTrack({ baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}`, languageCode: "en", languageName: "English" })])
        fetchTranscript.mockImplementation(async (): Promise<unknown> => { throw new Error("usage limit reached") })
        captionFetch.mockImplementation(async (): Promise<Response> => new Response(JSON.stringify({ events: "bad" })))
        expect(await execute()).toEqual(retry("YouTube caption request failed: usage limit reached Direct selected-caption fallback failed: Caption response contained malformed JSON3 payload."))
    })

    test("36 returns normalized metadata abort response", async () => {
        const lookupError = new Error("metadata lookup failed")
        getBasicInfo.mockImplementation(async () => { throw lookupError })
        expect(await execute()).toEqual(parseResult(createAbortResponse("autocode_youtube_transcribe", lookupError)))
    })

    test("37 merges fragmented cues and uses first timestamp", async () => {
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        currentTranscript = [transcriptCue(2, 1, "Fragmented"), transcriptCue(3, 1, "sentence")]
        expect((await execute(undefined, true)).transcript).toBe("* 0:00:02 Fragmented sentence")
    })

    test("38 keeps terminal punctuation and long gaps as separate items", async () => {
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        currentTranscript = [
            transcriptCue(0, 1, "Complete."),
            transcriptCue(1, 1, "Next"),
            transcriptCue(3.001, 1, "Later"),
        ]
        expect((await execute()).transcript).toBe("1. Complete.\n2. Next\n3. Later")
    })

    test("39 removes only exact overlapping duplicates", async () => {
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        currentTranscript = [transcriptCue(0, 2, "Echo"), transcriptCue(1, 2, "Echo")]
        expect((await execute()).transcript).toBe("1. Echo")
    })

    test("40 preserves one-token overlaps between distinct cues", async () => {
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        currentTranscript = [transcriptCue(0, 1, "Go now"), transcriptCue(1, 1, "now please")]
        expect((await execute()).transcript).toBe("1. Go now now please")
    })

    test("40a removes multi-token overlap from overlapping package cues", async () => {
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        currentTranscript = [transcriptCue(0, 2, "Welcome to the"), transcriptCue(1, 2, "to the show today.")]
        expect((await execute(undefined, true)).transcript).toBe("* 0:00:00 Welcome to the show today.")
    })

    test("40b preserves one-token repetition from overlapping package cues", async () => {
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        currentTranscript = [transcriptCue(0, 2, "This is very"), transcriptCue(1, 2, "very good.")]
        expect((await execute()).transcript).toBe("1. This is very very good.")
    })

    test("41 keeps standalone non-speech cues separate", async () => {
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        currentTranscript = [transcriptCue(0, 1, "First"), transcriptCue(1, 1, "[music]"), transcriptCue(2, 1, "Second")]
        expect((await execute()).transcript).toBe("1. First\n2. [music]\n3. Second")
    })

    test("42 keeps explicit different speaker labels separate", async () => {
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        currentTranscript = [transcriptCue(0, 1, "Alice: Hello"), transcriptCue(1, 1, "Bob: Hi")]
        expect((await execute()).transcript).toBe("1. Alice: Hello\n2. Bob: Hi")
    })

    test("43 merges matching speaker labels without repeating label", async () => {
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        currentTranscript = [transcriptCue(0, 1, "Alice: Hello"), transcriptCue(1, 1, "Alice: there")]
        expect((await execute()).transcript).toBe("1. Alice: Hello there")
    })

    test("44 uses package cue durations for grouping", async () => {
        setTracks([createCaptionTrack({ baseUrl: "track", languageCode: "en", languageName: "English" })])
        currentTranscript = [transcriptCue(0, 2, "Opening"), transcriptCue(2.8, 0, "line")]
        expect((await execute()).transcript).toBe("1. Opening line")
    })

    test("45 reads valid JSON3 durations and falls back for invalid durations", async () => {
        setTracks([createCaptionTrack({ baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}`, languageCode: "en", languageName: "English" })])
        currentTranscript = []
        captionFetch.mockImplementation(async (): Promise<Response> => new Response(JSON.stringify({
            events: [
                { tStartMs: 0, dDurationMs: 2_000, segs: [{ utf8: "Known" }] },
                { tStartMs: 2_800, dDurationMs: 0, segs: [{ utf8: "duration" }] },
                { tStartMs: 6_000, dDurationMs: -1, segs: [{ utf8: "Invalid" }] },
                { tStartMs: 8_800, dDurationMs: 0, segs: [{ utf8: "fallback" }] },
            ],
        })))
        expect((await execute()).transcript).toBe("1. Known duration\n2. Invalid\n3. fallback")
    })
})
