import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configReadFlow } from "./config/core";
import { createLocalConfigAdapter } from "./config/adapter";
import { createAutocodeConfigReadTool } from "./autocode_config_read";
import { createToolContext } from "./test_context";
import { resetRetryCounts } from "@/utils/tools";

async function tmpFile(dir: string, name: string, content: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, content, "utf8");
  return p;
}

describe("config read", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cfg-read-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const DATA = JSON.stringify({
    num: 3,
    bool: true,
    short: "Alice",
    long: "implementations",
    empty: "",
    nothing: null,
    obj: { a: 1, b: 2 },
    arr: [1, 2, 3],
  });

  it("outline mode (no key_path)", async () => {
    const file = await tmpFile(dir, "data.json", DATA);
    const res = await configReadFlow(createLocalConfigAdapter(), { file_path: file });
    const out = JSON.parse(res);
    expect(out.truncated).toBe(false);
    expect(out.nodes_total).toBe(14);
    expect(out.nodes_shown).toBe(14);
    expect(out.nodes[0].path).toEqual([]);
    expect(out.nodes[0].value).toBe("{8 keys}");
  });

  it("drill-down key_path", async () => {
    const file = await tmpFile(dir, "data.json", DATA);
    const res = await configReadFlow(createLocalConfigAdapter(), { file_path: file, key_path: "obj" });
    const out = JSON.parse(res);
    expect(out.nodes_total).toBe(3);
    expect(out.nodes[0].value).toBe("{2 keys}");
  });

  it("renders number", async () => {
    const file = await tmpFile(dir, "data.json", DATA);
    const res = await configReadFlow(createLocalConfigAdapter(), { file_path: file, key_path: "num" });
    const out = JSON.parse(res);
    expect(out.nodes[0].value).toBe("3");
  });

  it("renders boolean", async () => {
    const file = await tmpFile(dir, "data.json", DATA);
    const res = await configReadFlow(createLocalConfigAdapter(), { file_path: file, key_path: "bool" });
    const out = JSON.parse(res);
    expect(out.nodes[0].value).toBe("true");
  });

  it("renders short string", async () => {
    const file = await tmpFile(dir, "data.json", DATA);
    const res = await configReadFlow(createLocalConfigAdapter(), { file_path: file, key_path: "short" });
    const out = JSON.parse(res);
    expect(out.nodes[0].value).toBe("Alice");
  });

  it("renders long string truncated", async () => {
    const file = await tmpFile(dir, "data.json", DATA);
    const res = await configReadFlow(createLocalConfigAdapter(), {
      file_path: file,
      key_path: "long",
      max_value_chars: 10,
    });
    const out = JSON.parse(res);
    expect(out.nodes[0].value).toBe("implementa...");
  });

  it("renders empty string as quotes", async () => {
    const file = await tmpFile(dir, "data.json", DATA);
    const res = await configReadFlow(createLocalConfigAdapter(), { file_path: file, key_path: "empty" });
    const out = JSON.parse(res);
    expect(out.nodes[0].value).toBe('""');
  });

  it("renders null", async () => {
    const file = await tmpFile(dir, "data.json", DATA);
    const res = await configReadFlow(createLocalConfigAdapter(), { file_path: file, key_path: "nothing" });
    const out = JSON.parse(res);
    expect(out.nodes[0].value).toBeNull();
  });

  it("renders object summary", async () => {
    const file = await tmpFile(dir, "data.json", DATA);
    const res = await configReadFlow(createLocalConfigAdapter(), { file_path: file, key_path: "obj" });
    const out = JSON.parse(res);
    expect(out.nodes[0].value).toBe("{2 keys}");
  });

  it("renders array summary", async () => {
    const file = await tmpFile(dir, "data.json", DATA);
    const res = await configReadFlow(createLocalConfigAdapter(), { file_path: file, key_path: "arr" });
    const out = JSON.parse(res);
    expect(out.nodes[0].value).toBe("[3 items]");
  });

  it("subkey_regex filter", async () => {
    const file = await tmpFile(dir, "data2.json", JSON.stringify({ server: { host: "h", port: 8080 }, client: { name: "x" } }));
    const res = await configReadFlow(createLocalConfigAdapter(), { file_path: file, subkey_regex: "server" });
    const out = JSON.parse(res);
    expect(out.nodes_total).toBe(3);
    expect(out.nodes.every((n: { path: string[] }) => n.path.some((seg) => seg === "server"))).toBe(true);
  });

  it("value_regex filter", async () => {
    const file = await tmpFile(dir, "data3.json", JSON.stringify({ a: "hello", b: "world", c: 42 }));
    const res = await configReadFlow(createLocalConfigAdapter(), { file_path: file, value_regex: "ello" });
    const out = JSON.parse(res);
    expect(out.nodes_total).toBe(2);
  });

  it("max_keys truncation", async () => {
    const file = await tmpFile(dir, "data4.json", JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5 }));
    const res = await configReadFlow(createLocalConfigAdapter(), { file_path: file, max_keys: 2 });
    const out = JSON.parse(res);
    expect(out.truncated).toBe(true);
    expect(out.nodes_shown).toBe(2);
    expect(out.nodes_total).toBe(6);
  });

  it("array expansion edge", async () => {
    const file = await tmpFile(dir, "data5.json", JSON.stringify({ arr: [10, 20, 30, 40, 50] }));
    const res = await configReadFlow(createLocalConfigAdapter(), { file_path: file, max_keys: 3 });
    const out = JSON.parse(res);
    expect(out.nodes_shown).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.nodes_total).toBe(7);
    expect(out.nodes[2].path).toEqual(["arr", 0]);
    expect(out.nodes[2].value).toBe("10");
  });

  it("refuses markdown", async () => {
    const file = await tmpFile(dir, "test.md", "# hello");
    const res = await configReadFlow(createLocalConfigAdapter(), { file_path: file });
    const out = JSON.parse(res);
    expect(out.instruction).toContain("autocode_md");
  });

  it("yaml read", async () => {
    const file = await tmpFile(dir, "data.yaml", "server:\n  host: localhost\n  port: 8080\n");
    const res = await configReadFlow(createLocalConfigAdapter(), { file_path: file });
    const out = JSON.parse(res);
    expect(out.nodes_total).toBe(4);
    const portNode = out.nodes.find((n: { path: string[] }) => n.path.length === 2 && n.path[0] === "server" && n.path[1] === "port");
    expect(portNode).toBeDefined();
    expect(portNode.value).toBe("8080");
  });

  it("env read", async () => {
    const file = await tmpFile(dir, ".env", "PORT=8080\nHOST=localhost\n");
    const res = await configReadFlow(createLocalConfigAdapter(), { file_path: file });
    const out = JSON.parse(res);
    expect(out.nodes_total).toBe(3);
    const portNode = out.nodes.find((n: { path: string[] }) => n.path.length === 1 && n.path[0] === "PORT");
    expect(portNode).toBeDefined();
    expect(portNode.value).toBe("8080");
  });
});

describe("autocode_config_read tool (glob + file_paths output)", () => {
  let toolDir: string;
  let toolOldCwd: string;

  beforeEach(async () => {
    toolOldCwd = process.cwd();
    toolDir = await mkdtemp(join(tmpdir(), "cfg-tool-read-"));
    process.chdir(toolDir);
  });

  afterEach(async () => {
    resetRetryCounts();
    process.chdir(toolOldCwd);
    await rm(toolDir, { recursive: true, force: true });
  });

  const execute = async (args: Record<string, unknown>) => {
    const tool = createAutocodeConfigReadTool();
    return JSON.parse((await tool.execute(args as never, createToolContext({ directory: toolDir }))) as string);
  };

  it("glob *.json returns file_paths with key_paths for each json file", async () => {
    await tmpFile(toolDir, "a.json", JSON.stringify({ name: "A", version: "1.0" }));
    await tmpFile(toolDir, "b.json", JSON.stringify({ name: "B" }));
    const out = await execute({ file_path_glob: "*.json" });
    expect(Object.keys(out.file_paths).sort()).toEqual(["a.json", "b.json"]);
    expect(out.file_paths["a.json"].key_paths["name"]).toBe("A");
    expect(out.file_paths["a.json"].key_paths["version"]).toBe("1.0");
    expect(out.file_paths["b.json"].key_paths["name"]).toBe("B");
    expect(typeof out.file_paths["a.json"].nodes_shown).toBe("number");
    expect(typeof out.file_paths["a.json"].nodes_total).toBe("number");
  });

  it("key_path drills into nested key", async () => {
    await tmpFile(toolDir, "data.json", JSON.stringify({ server: { host: "h", port: 80 } }));
    const out = await execute({ file_path_glob: "data.json", key_path: "server" });
    expect(out.file_paths["data.json"].key_paths["host"]).toBe("h");
    expect(out.file_paths["data.json"].key_paths["port"]).toBe("80");
  });

  it("value_regex filters leaves", async () => {
    await tmpFile(toolDir, "vp.json", JSON.stringify({ a: "hello", b: "world", c: 42 }));
    const out = await execute({ file_path_glob: "vp.json", value_regex: "orld|ello" });
    // root (object, non-leaf) is included; a and b match; c (42) is excluded
    expect(out.file_paths["vp.json"].nodes_total).toBe(3);
    expect(out.file_paths["vp.json"].key_paths["a"]).toBe("hello");
    expect(out.file_paths["vp.json"].key_paths["b"]).toBe("world");
    expect(out.file_paths["vp.json"].key_paths["c"]).toBeUndefined();
  });

  it("non-match glob returns retry JSON error", async () => {
    const out = await execute({ file_path_glob: "nope/*.json" });
    expect(out.failedAction).toBe("Read configuration file");
    expect(typeof out.error).toBe("string");
    expect(out.file_paths).toBeUndefined();
  });

  it("unsupported extension (markdown) is skipped and yields retry error", async () => {
    await tmpFile(toolDir, "x.md", "# hi");
    const out = await execute({ file_path_glob: "x.md" });
    expect(out.failedAction).toBe("Read configuration file");
    expect(out.file_paths).toBeUndefined();
  });
});
