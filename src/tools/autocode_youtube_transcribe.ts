import { tool } from "@opencode-ai/plugin"
import Innertube from "youtubei.js"
import { fetchTranscript, type TranscriptResponse } from "youtube-transcript"
import { createAbortResponse, createRetryResponse } from "@/utils/tools"

type CaptionSource = "manual" | "auto"

type CaptionTrack = {
    base_url: string
    name: { toString: () => string }
    vss_id: string
    language_code: string
    kind?: "asr" | "frc"
}

type CaptionAudioTrack = {
    default_caption_track_index?: number
    has_default_track: boolean
    caption_track_indices: number[]
}

type CaptionTracklist = {
    caption_tracks?: CaptionTrack[]
    audio_tracks?: CaptionAudioTrack[]
    default_audio_track_index?: number
}

type SelectedCaptionTrack = {
    baseUrl: string
    languageCode: string
    languageName: string
    source: CaptionSource
    isOriginal: boolean
    index: number
}

type TranscriptCue = {
    offsetMilliseconds: number
    text: string
    index: number
}

type PackageTranscriptCue = Pick<TranscriptResponse, "duration" | "offset" | "text"> & { index: number }

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "mobile.youtube.com"])
const YOUTUBE_NOCOOKIE_HOSTS = new Set(["youtube-nocookie.com", "www.youtube-nocookie.com", "m.youtube-nocookie.com", "mobile.youtube-nocookie.com"])
const SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"])
const YOUTUBE_CAPTION_HOSTS = new Set(["www.youtube.com", "www.youtube-nocookie.com"])

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value : null
}

function decodeCaptionCodePoint(match: string, value: string, radix: number): string {
    const codePoint = Number.parseInt(value, radix)
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : match
}

function decodeHexCaptionEntity(match: string, value: string): string {
    return decodeCaptionCodePoint(match, value, 16)
}

function decodeDecimalCaptionEntity(match: string, value: string): string {
    return decodeCaptionCodePoint(match, value, 10)
}

function normalizeCaptionText(text: string): string {
    return text
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, decodeHexCaptionEntity)
        .replace(/&#(\d+);/g, decodeDecimalCaptionEntity)
        .replace(/\s+/g, " ")
        .trim()
}

function validVideoId(value: string | null): value is string {
    return value !== null && VIDEO_ID_PATTERN.test(value)
}

function pathVideoId(pathname: string, expectedPrefix: string): string | null {
    const parts = pathname.split("/").filter(Boolean)
    if (parts.length !== 2 || parts[0] !== expectedPrefix) {
        return null
    }
    return parts[1] ?? null
}

function parseVideoUrl(input: string): { videoId: string } | { error: string } {
    let url: URL
    try {
        url = new URL(input)
    }
    catch {
        return { error: "Invalid YouTube URL." }
    }

    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.port) {
        return { error: "Provide a credential-free http or https YouTube video URL." }
    }

    const host = url.hostname.toLowerCase()
    let videoId: string | null = null
    if (YOUTUBE_HOSTS.has(host)) {
        if (url.pathname === "/watch") {
            const videoIds = url.searchParams.getAll("v")
            videoId = videoIds.length === 1 ? videoIds[0] ?? null : null
        }
        else {
            videoId = pathVideoId(url.pathname, "shorts") ?? pathVideoId(url.pathname, "embed")
        }
    }
    else if (YOUTUBE_NOCOOKIE_HOSTS.has(host)) {
        videoId = pathVideoId(url.pathname, "embed")
    }
    else if (SHORT_HOSTS.has(host)) {
        const parts = url.pathname.split("/").filter(Boolean)
        videoId = parts.length === 1 ? parts[0] ?? null : null
    }
    else {
        return { error: "URL host is not an accepted YouTube video host." }
    }

    if (!validVideoId(videoId)) {
        return { error: "URL must identify one YouTube video with an 11-character video ID." }
    }

    return { videoId }
}

function normalizeLanguageCode(languageCode: string): string {
    return languageCode.trim().toLowerCase().replace(/_/g, "-")
}

function primaryLanguageSubtag(languageCode: string): string {
    return normalizeLanguageCode(languageCode).split("-")[0] ?? ""
}

function compareStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}

function isAutoCaption(track: CaptionTrack, languageName: string): boolean {
    return track.kind === "asr" || /^a\./i.test(track.vss_id) || /\b(?:asr|auto(?:[- ]?generated)?)\b/i.test(languageName)
}

function trackAt<T>(tracks: T[], index: number | undefined): T | undefined {
    return index !== undefined && Number.isInteger(index) && index >= 0 && index < tracks.length ? tracks[index] : undefined
}

function originalLanguageCode(captions: CaptionTracklist, tracks: CaptionTrack[]): string | null {
    const audioTracks = captions.audio_tracks ?? []
    const defaultAudioTrack = trackAt(audioTracks, captions.default_audio_track_index)
        ?? audioTracks.find((audioTrack) => audioTrack.has_default_track)
    if (!defaultAudioTrack) {
        return null
    }

    const captionIndex = defaultAudioTrack.default_caption_track_index ?? defaultAudioTrack.caption_track_indices[0]
    const track = trackAt(tracks, captionIndex)
    return track ? normalizeLanguageCode(track.language_code) : null
}

function selectCaptionTrack(captions: CaptionTracklist): SelectedCaptionTrack | null {
    const tracks = captions.caption_tracks ?? []
    const originalLanguage = originalLanguageCode(captions, tracks)
    const candidates = tracks
        .map((track, index) => {
            const languageCode = normalizeLanguageCode(track.language_code)
            const languageName = nonEmptyString(track.name.toString()) ?? languageCode
            return {
                baseUrl: track.base_url,
                languageCode,
                languageName,
                source: isAutoCaption(track, languageName) ? "auto" : "manual",
                isOriginal: originalLanguage !== null && languageCode === originalLanguage,
                index,
            } satisfies SelectedCaptionTrack
        })
        .filter((track) => track.baseUrl.length > 0 && track.languageCode.length > 0)

    candidates.sort((left, right) => {
        const leftLanguageRank = originalLanguage === null ? 2 : left.languageCode === originalLanguage ? 0 : primaryLanguageSubtag(left.languageCode) === primaryLanguageSubtag(originalLanguage) ? 1 : 2
        const rightLanguageRank = originalLanguage === null ? 2 : right.languageCode === originalLanguage ? 0 : primaryLanguageSubtag(right.languageCode) === primaryLanguageSubtag(originalLanguage) ? 1 : 2
        if (leftLanguageRank !== rightLanguageRank) return leftLanguageRank - rightLanguageRank
        if (left.languageCode === right.languageCode && left.source !== right.source) return left.source === "manual" ? -1 : 1
        const codeOrder = compareStrings(left.languageCode, right.languageCode)
        if (codeOrder !== 0) return codeOrder
        const nameOrder = compareStrings(left.languageName, right.languageName)
        if (nameOrder !== 0) return nameOrder
        const baseUrlOrder = compareStrings(left.baseUrl, right.baseUrl)
        if (baseUrlOrder !== 0) return baseUrlOrder
        return left.index - right.index
    })

    return candidates[0] ?? null
}

function safeOffsetMilliseconds(value: unknown): number {
    const offset = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
    return Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0
}

function formatTimestamp(offsetMilliseconds: number): string {
    const hours = Math.floor(offsetMilliseconds / 3_600_000)
    const minutes = Math.floor(offsetMilliseconds / 60_000) % 60
    const seconds = Math.floor(offsetMilliseconds / 1_000) % 60
    const milliseconds = offsetMilliseconds % 1_000
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`
}

function finiteNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null
}

function packageTranscriptError(error: unknown): string {
    const cause = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown request error"
    const safeCause = cause
        .replace(/https?:\/\/\S+/gi, "[request URL]")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200)
    return `YouTube caption request failed: ${safeCause || "Unknown request error"}`
}

function captionFallbackError(error: unknown): string {
    const cause = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown fallback error"
    const safeCause = cause
        .replace(/https?:\/\/\S+/gi, "[caption URL]")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200)
    return `Direct selected-caption fallback failed: ${safeCause || "Unknown fallback error"}`
}

function packageTranscriptCues(value: unknown): PackageTranscriptCue[] | null {
    if (!Array.isArray(value)) {
        return null
    }

    return value.flatMap((cue, index): PackageTranscriptCue[] => {
        if (!isRecord(cue)) {
            return []
        }

        const text = nonEmptyString(cue.text)
        const offset = finiteNumber(cue.offset)
        if (!text || offset === null) {
            return []
        }

        return [{
            text: normalizeCaptionText(text),
            offset,
            duration: finiteNumber(cue.duration) ?? 0,
            index,
        }]
    })
}

function packageCueScale(cues: PackageTranscriptCue[], durationSeconds: number | null): number {
    const maximumCueValue = Math.max(...cues.map((cue) => Math.max(cue.offset, cue.offset + cue.duration)))
    if (durationSeconds !== null && durationSeconds > 0) {
        return maximumCueValue > durationSeconds * 2 ? 1 : 1_000
    }

    if (cues.some((cue) => !Number.isInteger(cue.offset) || !Number.isInteger(cue.duration))) {
        return 1_000
    }

    // Without duration, five-digit values are deterministically treated as milliseconds.
    return maximumCueValue >= 10_000 ? 1 : 1_000
}

function formatTranscript(value: unknown, durationSeconds: number | null): string | null {
    const packageCues = packageTranscriptCues(value)
    if (packageCues === null || packageCues.length === 0) {
        return null
    }

    const scale = packageCueScale(packageCues, durationSeconds)
    return formatTranscriptCues(packageCues.map((cue) => ({
        offsetMilliseconds: safeOffsetMilliseconds(cue.offset * scale),
        text: cue.text,
        index: cue.index,
    })))
}

function formatTranscriptCues(cues: TranscriptCue[]): string | null {
    if (cues.length === 0) {
        return null
    }

    cues.sort((left, right) => left.offsetMilliseconds - right.offsetMilliseconds || left.index - right.index)
    return cues.map((cue) => `[${formatTimestamp(cue.offsetMilliseconds)}] ${cue.text}`).join("\n")
}

function captionUrl(baseUrl: string): URL | null {
    let url: URL
    try {
        url = new URL(baseUrl)
    }
    catch {
        return null
    }

    if (url.protocol !== "https:" || url.username || url.password || url.port || !YOUTUBE_CAPTION_HOSTS.has(url.hostname.toLowerCase()) || url.pathname !== "/api/timedtext") {
        return null
    }

    url.searchParams.set("fmt", "json3")
    return url
}

function json3TranscriptCues(value: unknown): TranscriptCue[] | null {
    if (!isRecord(value) || !Array.isArray(value.events)) {
        return null
    }

    return value.events.flatMap((event, index): TranscriptCue[] => {
        if (!isRecord(event) || !Array.isArray(event.segs)) {
            return []
        }

        const offset = finiteNumber(typeof event.tStartMs === "string" ? Number(event.tStartMs) : event.tStartMs)
        if (offset === null) {
            return []
        }

        const text = event.segs
            .flatMap((segment): string[] => isRecord(segment) && typeof segment.utf8 === "string" ? [segment.utf8] : [])
            .join("")
        const normalizedText = normalizeCaptionText(text)
        return normalizedText ? [{ offsetMilliseconds: safeOffsetMilliseconds(offset), text: normalizedText, index }] : []
    })
}

async function fetchSelectedCaptionTranscript(baseUrl: string): Promise<TranscriptCue[]> {
    const url = captionUrl(baseUrl)
    if (!url) {
        throw new Error("Selected caption URL is not an allowed HTTPS YouTube caption URL.")
    }

    let response: Response
    try {
        response = await globalThis.fetch(url, { headers: { Accept: "application/json" }, redirect: "error" })
    }
    catch (error) {
        throw new Error(`Caption request failed: ${error instanceof Error ? error.message : "Unknown request error"}`)
    }

    if (!response.ok) {
        throw new Error(`Caption request returned HTTP ${response.status}.`)
    }

    let payload: unknown
    try {
        payload = await response.json()
    }
    catch {
        throw new Error("Caption response contained malformed JSON.")
    }

    const cues = json3TranscriptCues(payload)
    if (cues === null) {
        throw new Error("Caption response contained malformed JSON3 payload.")
    }
    return cues
}

function nullableFiniteNumber(value: number | undefined): number | null {
    return value !== undefined && Number.isFinite(value) ? value : null
}

function publishDateFromMicroformat(value: unknown): string | null {
    return isRecord(value) ? nonEmptyString(value.publish_date) : null
}

function videoMetadata(info: Awaited<ReturnType<Innertube["getBasicInfo"]>>, videoId: string): Record<string, unknown> {
    const basicInfo = info.basic_info
    return {
        id: videoId,
        canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
        title: nonEmptyString(basicInfo.title),
        channelName: nonEmptyString(basicInfo.channel?.name) ?? nonEmptyString(basicInfo.author),
        channelId: nonEmptyString(basicInfo.channel?.id) ?? nonEmptyString(basicInfo.channel_id),
        durationSeconds: nullableFiniteNumber(basicInfo.duration),
        viewCount: nullableFiniteNumber(basicInfo.view_count),
        publishDate: publishDateFromMicroformat(info.page[0]?.microformat),
    }
}

async function executeYoutubeTranscribe(url: string): Promise<string> {
    const parsedUrl = parseVideoUrl(url)
    if ("error" in parsedUrl) {
        return createRetryResponse("autocode_youtube_transcribe", parsedUrl.error, "Provide a supported YouTube video URL with one 11-character video ID.")
    }

    try {
        const innertube = await Innertube.create()
        const info = await innertube.getBasicInfo(parsedUrl.videoId)
        const video = videoMetadata(info, parsedUrl.videoId)
        const selectedTrack = selectCaptionTrack(info.captions ?? {})
        if (!selectedTrack) {
            return JSON.stringify({
                video,
                captionsAvailable: false,
                selectedCaption: null,
                transcript: null,
                message: "No caption tracks are available for this video.",
            })
        }

        let formattedTranscript: string | null = null
        let primaryError: unknown = undefined
        try {
            const transcript = await fetchTranscript(`https://www.youtube.com/watch?v=${parsedUrl.videoId}`, {
                lang: selectedTrack.languageCode,
                fetch: globalThis.fetch,
            })
            if (!Array.isArray(transcript)) {
                return createRetryResponse("autocode_youtube_transcribe", "YouTube returned malformed caption JSON.", "Retry the same YouTube video URL later.")
            }
            formattedTranscript = formatTranscript(transcript, nullableFiniteNumber(info.basic_info.duration))
        }
        catch (error) {
            primaryError = error
        }

        if (!formattedTranscript) {
            try {
                formattedTranscript = formatTranscriptCues(await fetchSelectedCaptionTranscript(selectedTrack.baseUrl))
            }
            catch (fallbackError) {
                const fallbackMessage = captionFallbackError(fallbackError)
                const errorMessage = primaryError === undefined ? fallbackMessage : `${packageTranscriptError(primaryError)} ${fallbackMessage}`
                return createRetryResponse("autocode_youtube_transcribe", errorMessage, "Retry the same YouTube video URL later.")
            }
        }

        if (!formattedTranscript) {
            return JSON.stringify({
                video,
                captionsAvailable: false,
                selectedCaption: null,
                transcript: null,
                message: "Caption track contains no transcript cues.",
            })
        }

        return JSON.stringify({
            video,
            captionsAvailable: true,
            selectedCaption: {
                languageCode: selectedTrack.languageCode,
                languageName: selectedTrack.languageName,
                source: selectedTrack.source,
                isOriginal: selectedTrack.isOriginal,
            },
            transcript: formattedTranscript,
            message: "Transcript retrieved from YouTube captions.",
        })
    }
    catch (error) {
        return createAbortResponse("autocode_youtube_transcribe", error)
    }
}

export function createAutocodeYoutubeTranscribeTool(): ReturnType<typeof tool> {
    return tool({
        description: "Retrieve a YouTube video's captions as a timestamped transcript.",
        args: {
            url: tool.schema.string().describe("YouTube video URL."),
        },
        async execute(args): Promise<string> {
            return executeYoutubeTranscribe(args.url)
        },
    })
}
