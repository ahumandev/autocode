import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configEditFlow } from "./config/core";
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

describe("config edit", () => {
  let dir: string;
  let base: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cfg-edit-"));
    base = await tmpFile(dir, "base.json", BASE);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("REPLACE", async () => {
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: base,
      current_key: "server.host",
      content: "0.0.0.0",
    });
    const out = JSON.parse(res);
    expect(out.action).toBe("replace");
    const parsed = await readJson(base);
    expect(parsed.server.host).toBe("0.0.0.0");
  });

  it("RENAME no-match preserve value", async () => {
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: base,
      current_key: "debug",
      new_key: "verbose",
    });
    const out = JSON.parse(res);
    expect(out.action).toBe("rename");
    const parsed = await readJson(base);
    expect(parsed.verbose).toBe(true);
    expect(parsed.debug).toBeUndefined();
  });

  it("error: new_key already exists (rename)", async () => {
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: base,
      current_key: "debug",
      new_key: "server",
    });
    const out = JSON.parse(res);
    expect(out.error).toContain("already exists");
  });

  it("error: current_key not found", async () => {
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: base,
      current_key: "missing",
    });
    const out = JSON.parse(res);
    expect(out.error).toContain("not found");
  });

  it("error: must specify", async () => {
    const res = await configEditFlow(createLocalConfigAdapter(), { file_path: base });
    const out = JSON.parse(res);
    expect(out.error).toContain("must specify");
  });

  it("error: new_key already exists (create)", async () => {
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: base,
      new_key: "debug",
    });
    const out = JSON.parse(res);
    expect(out.error).toContain("already exists");
  });

  it("CREATE", async () => {
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: base,
      new_key: "server.timeout",
      content: "30",
    });
    const out = JSON.parse(res);
    expect(out.action).toBe("create");
    const parsed = await readJson(base);
    expect(parsed.server.timeout).toBe("30");
  });

  it("auto-vivify intermediate keys", async () => {
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: base,
      new_key: ["a", "b", "c"],
      content: "x",
    });
    const out = JSON.parse(res);
    expect(out.action).toBe("create");
    const parsed = await readJson(base);
    expect(parsed.a.b.c).toBe("x");
  });

  it("array append on out-of-range index", async () => {
    const arr = await tmpFile(dir, "arr.json", JSON.stringify({ arr: [1, 2] }));
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: arr,
      new_key: ["arr", 99],
      content: "3",
    });
    JSON.parse(res);
    const parsed = await readJson(arr);
    expect(parsed.arr).toEqual([1, 2, "3"]);
  });

  it("new_index 0 inserts first", async () => {
    const arr = await tmpFile(dir, "arr.json", JSON.stringify({ arr: [1, 2] }));
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: arr,
      new_key: ["arr", 2],
      content: "9",
      new_index: 0,
    });
    JSON.parse(res);
    const parsed = await readJson(arr);
    expect(parsed.arr).toEqual(["9", 1, 2]);
  });

  it("new_index N inserts at N", async () => {
    const arr = await tmpFile(dir, "arr.json", JSON.stringify({ arr: [1, 2] }));
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: arr,
      new_key: ["arr", 2],
      content: "9",
      new_index: 2,
    });
    JSON.parse(res);
    const parsed = await readJson(arr);
    expect(parsed.arr).toEqual([1, 2, "9"]);
  });

  it("new_index -1 appends", async () => {
    const arr = await tmpFile(dir, "arr.json", JSON.stringify({ arr: [1, 2] }));
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: arr,
      new_key: ["arr", 2],
      content: "9",
      new_index: -1,
    });
    JSON.parse(res);
    const parsed = await readJson(arr);
    expect(parsed.arr).toEqual([1, 2, "9"]);
  });

  it("new_index omitted appends", async () => {
    const arr = await tmpFile(dir, "arr.json", JSON.stringify({ arr: [1, 2] }));
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: arr,
      new_key: ["arr", 2],
      content: "9",
    });
    JSON.parse(res);
    const parsed = await readJson(arr);
    expect(parsed.arr).toEqual([1, 2, "9"]);
  });

  it("cross-parent move", async () => {
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: base,
      current_key: ["server", "host"],
      new_key: ["settings", "host"],
    });
    const out = JSON.parse(res);
    expect(out.action).toBe("rename");
    const parsed = await readJson(base);
    expect(parsed.server.host).toBeUndefined();
    expect(parsed.settings.host).toBe("localhost");
  });

  it("rename in-place preserves position", async () => {
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: base,
      current_key: ["server", "host"],
      new_key: ["server", "hostname"],
    });
    JSON.parse(res);
    const parsed = await readJson(base);
    expect(Object.keys(parsed.server)[0]).toBe("hostname");
    expect(parsed.server.hostname).toBe("localhost");
    expect(parsed.server.host).toBeUndefined();
  });

  it("content type union: boolean true", async () => {
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: base,
      new_key: "enabled",
      content: true,
    });
    const out = JSON.parse(res);
    expect(out.action).toBe("create");
    const parsed = await readJson(base);
    expect(parsed.enabled).toBe(true);
    expect(typeof parsed.enabled).toBe("boolean");
  });

  it("content type union: boolean false", async () => {
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: base,
      new_key: "disabled",
      content: false,
    });
    const out = JSON.parse(res);
    expect(out.action).toBe("create");
    const parsed = await readJson(base);
    expect(parsed.disabled).toBe(false);
    expect(typeof parsed.disabled).toBe("boolean");
  });

  it("content type union: number 42", async () => {
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: base,
      new_key: "port",
      content: 42,
    });
    const out = JSON.parse(res);
    expect(out.action).toBe("create");
    const parsed = await readJson(base);
    expect(parsed.port).toBe(42);
    expect(typeof parsed.port).toBe("number");
  });

  it("content type union: number 3.14", async () => {
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: base,
      new_key: "ratio",
      content: 3.14,
    });
    const out = JSON.parse(res);
    expect(out.action).toBe("create");
    const parsed = await readJson(base);
    expect(parsed.ratio).toBe(3.14);
    expect(typeof parsed.ratio).toBe("number");
  });

  it("content type union: null", async () => {
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: base,
      new_key: "blank",
      content: null,
    });
    const out = JSON.parse(res);
    expect(out.action).toBe("create");
    const parsed = await readJson(base);
    expect(parsed.blank).toBeNull();
  });

  it("content type union: array", async () => {
    const value = [1, "two", false];
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: base,
      new_key: "tags",
      content: value,
    });
    const out = JSON.parse(res);
    expect(out.action).toBe("create");
    const parsed = await readJson(base);
    expect(parsed.tags).toEqual(value);
    expect(Array.isArray(parsed.tags)).toBe(true);
  });

  it("content type union: object", async () => {
    const value = { nested: { deep: true } };
    const res = await configEditFlow(createLocalConfigAdapter(), {
      file_path: base,
      new_key: "meta",
      content: value,
    });
    const out = JSON.parse(res);
    expect(out.action).toBe("create");
    const parsed = await readJson(base);
    expect(parsed.meta).toEqual(value);
    expect(typeof parsed.meta).toBe("object");
    expect(Array.isArray(parsed.meta)).toBe(false);
  });
});
