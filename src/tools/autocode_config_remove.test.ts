import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configRemoveFlow } from "./config/core";
import { createLocalConfigAdapter } from "./config/adapter";

async function tmpFile(dir: string, name: string, content: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, content, "utf8");
  return p;
}

async function readJson(p: string): Promise<any> {
  const raw = await readFile(p, "utf8");
  return JSON.parse(raw);
}

const BASE = JSON.stringify({ server: { host: "localhost", port: 8080 }, debug: true });
const ARR = JSON.stringify({ arr: [1, 2, 3] });

describe("config remove", () => {
  let dir: string;
  let base: string;
  let arr: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cfg-remove-"));
    base = await tmpFile(dir, "base.json", BASE);
    arr = await tmpFile(dir, "arr.json", ARR);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("leaf removal", async () => {
    const res = await configRemoveFlow(createLocalConfigAdapter(), {
      file_path: base,
      key_path: ["server", "host"],
    });
    const out = JSON.parse(res);
    expect(out.removed).toEqual(["server", "host"]);
    expect(out.parent_now).toEqual({ server: "{1 keys}" });
    const parsed = await readJson(base);
    expect(Object.keys(parsed.server)).toEqual(["port"]);
  });

  it("subtree removal (object)", async () => {
    const res = await configRemoveFlow(createLocalConfigAdapter(), {
      file_path: base,
      key_path: ["server"],
    });
    const out = JSON.parse(res);
    expect(out.removed).toEqual(["server"]);
    expect(out.parent_now).toEqual({ debug: "true" });
    const parsed = await readJson(base);
    expect(parsed).toEqual({ debug: true });
  });

  it("array slice removal", async () => {
    const res = await configRemoveFlow(createLocalConfigAdapter(), {
      file_path: arr,
      key_path: ["arr", 1],
    });
    const out = JSON.parse(res);
    expect(out.removed).toEqual(["arr", 1]);
    expect(out.parent_now).toEqual({ arr: "[2 items]" });
    const parsed = await readJson(arr);
    expect(parsed.arr).toEqual([1, 3]);
  });

  it("root refusal", async () => {
    const res = await configRemoveFlow(createLocalConfigAdapter(), {
      file_path: base,
      key_path: [],
    });
    const out = JSON.parse(res);
    expect(out.error).toContain("cannot remove root");
  });
});
