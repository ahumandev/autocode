import { mkdtemp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Dirent } from "node:fs"
import {
    saveLocalMemory,
    selectLocalMemories,
    type LocalMemoryFileSystem,
    type LocalMemoryTimingCollector,
} from "../src/utils/local_memory"

const fileCounts = [10, 100, 1_000] as const
const promptLengths = [1_000, 10_000, 100_000] as const
const warmupRepetitions = 1
const measuredRepetitions = 5

const fileSystem: LocalMemoryFileSystem = {
    async mkdir(directoryPath: string, options?: { recursive?: boolean }): Promise<string | undefined> {
        return await mkdir(directoryPath, options)
    },
    async readFile(filePath: string, encoding: "utf8"): Promise<string> {
        return await readFile(filePath, encoding)
    },
    async readdir(directoryPath: string, options?: { withFileTypes?: boolean }): Promise<string[] | Dirent[]> {
        return options?.withFileTypes ? await readdir(directoryPath, { withFileTypes: true }) : await readdir(directoryPath)
    },
    async rename(oldPath: string, newPath: string): Promise<void> {
        await rename(oldPath, newPath)
    },
    async rm(filePath: string, options?: { recursive?: boolean, force?: boolean }): Promise<void> {
        await rm(filePath, options)
    },
    async writeFile(filePath: string, content: string): Promise<void> {
        await writeFile(filePath, content)
    },
}

function createPrompt(fileCount: number, length: number): string {
    const terms: string[] = []
    while (terms.join(" ").length < length) {
        terms.push(`topic-${String(terms.length % fileCount).padStart(4, "0")}`)
    }
    return terms.join(" ").slice(0, length)
}

function createTimingCollector(): LocalMemoryTimingCollector {
    return {
        directory_listing: 0,
        body_read: 0,
        parsing_normalization: 0,
        selection_matching: 0,
        body_render_sizing: 0,
    }
}

async function createFixture(root: string, fileCount: number): Promise<void> {
    const fixtureContext = { directory: root, worktree: root }
    for (let index = 0; index < fileCount; index += 1) {
        await saveLocalMemory(fileSystem, fixtureContext, {
            id: `topic-${String(index).padStart(4, "0")}`,
            aliases: [`alias-${index}`],
            context: `benchmark context ${index}`,
            memory: `Local memory benchmark body ${index}.`,
        }, {
            now: (): Date => new Date("2026-01-01T00:00:00.000Z"),
            temporary_suffix: (): string => `fixture-${index}`,
        })
    }
}

type BenchmarkSample = LocalMemoryTimingCollector & { total_recall: number }

async function measureRecall(context: { directory: string, worktree: string }, prompt: string): Promise<BenchmarkSample> {
    const timing = createTimingCollector()
    const started = performance.now()
    await selectLocalMemories(fileSystem, context, { prompt, loaded_ids: [], timing })
    return { ...timing, total_recall: performance.now() - started }
}

function median(values: readonly number[]): number {
    const sorted = [...values].sort((left: number, right: number): number => left - right)
    return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function formatMilliseconds(milliseconds: number): string {
    return `${milliseconds.toFixed(3)}ms`
}

async function benchmarkFixture(root: string, fileCount: number, promptLength: number): Promise<void> {
    const fixtureContext = { directory: root, worktree: root }
    const prompt = createPrompt(fileCount, promptLength)
    for (let index = 0; index < warmupRepetitions; index += 1) await measureRecall(fixtureContext, prompt)
    const samples: BenchmarkSample[] = []
    for (let index = 0; index < measuredRepetitions; index += 1) samples.push(await measureRecall(fixtureContext, prompt))

    console.log([
        `files=${fileCount}`,
        `prompt=${promptLength}`,
        `directory listing=${formatMilliseconds(median(samples.map((sample: BenchmarkSample): number => sample.directory_listing)))}`,
        `body read=${formatMilliseconds(median(samples.map((sample: BenchmarkSample): number => sample.body_read)))}`,
        `parsing/normalization=${formatMilliseconds(median(samples.map((sample: BenchmarkSample): number => sample.parsing_normalization)))}`,
        `selection/matching=${formatMilliseconds(median(samples.map((sample: BenchmarkSample): number => sample.selection_matching)))}`,
        `body render/sizing=${formatMilliseconds(median(samples.map((sample: BenchmarkSample): number => sample.body_render_sizing)))}`,
        `total recall=${formatMilliseconds(median(samples.map((sample: BenchmarkSample): number => sample.total_recall)))}`,
    ].join(" | "))
}

console.log(`local-memory benchmark: warmup=${warmupRepetitions}, repetitions=${measuredRepetitions}, fresh scan per measured recall, no cache`)
for (const fileCount of fileCounts) {
    const root = await mkdtemp(join(tmpdir(), "autocode-local-memory-"))
    try {
        await createFixture(root, fileCount)
        for (const promptLength of promptLengths) await benchmarkFixture(root, fileCount, promptLength)
    }
    finally {
        await rm(root, { recursive: true, force: true })
    }
}
