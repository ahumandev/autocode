import { describe, expect, test } from "bun:test";
import { request, type IncomingHttpHeaders, type OutgoingHttpHeaders, type Server } from "node:http";
import { createAutoChamberServiceServer, MAX_SERVICE_JSON_BYTES, type AutoChamberServiceServerOptions } from "./server";

const TOKEN = "a".repeat(48);
const WRONG_TOKEN = "b".repeat(48);
const PROFILE_DATA = "synthetic-profile-private-value";
const AUTH = { authorization: `Bearer ${TOKEN}` };

type HttpResult = { status: number | undefined; headers: IncomingHttpHeaders; body: string };

async function withServer(
  handlers: AutoChamberServiceServerOptions["handlers"],
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = createAutoChamberServiceServer({ token: TOKEN, handlers });
  try {
    await new Promise<void>((resolve, reject): void => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", (): void => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    await run(address.port);
  } finally {
    await closeServer(server);
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject): void => {
    const timeout = setTimeout((): void => reject(new Error("Server cleanup timed out")), 2_000);
    server.close((error): void => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
}

async function send(
  port: number,
  path: string,
  method = "GET",
  headers: OutgoingHttpHeaders | string[] = {},
  body?: string | Buffer,
): Promise<HttpResult> {
  return new Promise((resolve, reject): void => {
    const req = request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (response): void => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer): void => { chunks.push(chunk); });
      response.on("error", reject);
      response.on("end", (): void => {
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.setTimeout(2_000, (): void => { req.destroy(new Error("Request timed out")); });
    req.on("error", reject);
    req.end(body);
  });
}

function expectSafe(result: HttpResult, status: number): void {
  expect(result.status).toBe(status);
  expect(result.headers["cache-control"]).toBe("no-store");
  const headers = JSON.stringify(result.headers);
  expect(headers).not.toContain(TOKEN);
  expect(headers).not.toContain(WRONG_TOKEN);
  expect(headers).not.toContain(PROFILE_DATA);
  expect(result.body).not.toContain(TOKEN);
  expect(result.body).not.toContain(WRONG_TOKEN);
  expect(result.body).not.toContain(PROFILE_DATA);
}

describe("AutoChamber service HTTP boundary", () => {
  test("denies missing, wrong, and malformed authorization before routing or handlers", async () => {
    let calls = 0;
    const read = (): Record<string, unknown> => { calls++; return { ok: true }; };
    const write = (): Record<string, unknown> => { calls++; return { ok: true }; };
    await withServer({
      getSettings: read, patchSettings: write, listProfiles: read, createProfile: write, patchProfile: write,
    }, async (port): Promise<void> => {
      for (const authorization of [undefined, `Bearer ${WRONG_TOKEN}`, TOKEN, `Basic ${TOKEN}`]) {
        for (const [path, method] of [
          ["/health", "GET"], ["/settings", "GET"], ["/settings", "PATCH"],
          ["/profiles", "GET"], ["/profiles", "POST"], ["/profiles", "PATCH"],
          ["/unknown", "GET"],
        ]) {
          const headers: OutgoingHttpHeaders = { "content-type": "application/json" };
          if (authorization !== undefined) headers.authorization = authorization;
          const body = method === "GET" ? undefined : JSON.stringify({ value: PROFILE_DATA });
          const result = await send(port, path, method, headers, body);
          expectSafe(result, 401);
          expect(result.headers["www-authenticate"]).toBe("Bearer");
          expect(result.body).toBe("");
        }
      }
      const duplicate = await send(port, "/profiles", "GET", [
        "host", "synthetic.local",
        "authorization", `Bearer ${TOKEN}`, "authorization", `Bearer ${TOKEN}`,
      ]);
      expectSafe(duplicate, 401);
      expect(duplicate.headers["www-authenticate"]).toBe("Bearer");
      expect(duplicate.body).toBe("");
      expect(calls).toBe(0);
    });
  });

  test("dispatches supported methods and delivers JSON objects to write handlers", async () => {
    const calls: Array<{ name: string; body?: Record<string, unknown> }> = [];
    const read = (name: string): (() => Record<string, unknown>) => (): Record<string, unknown> => {
      calls.push({ name });
      return { result: name };
    };
    const write = (name: string): ((body: Record<string, unknown>) => Record<string, unknown>) =>
      (body): Record<string, unknown> => {
        calls.push({ name, body });
        return { result: name };
      };
    await withServer({
      getSettings: read("getSettings"), patchSettings: write("patchSettings"),
      listProfiles: read("listProfiles"), createProfile: write("createProfile"), patchProfile: write("patchProfile"),
    }, async (port): Promise<void> => {
      const health = await send(port, "/health", "GET", AUTH);
      expectSafe(health, 200);
      expect(JSON.parse(health.body)).toEqual({ ok: true });

      const payload = { name: PROFILE_DATA, nested: { enabled: true } };
      for (const [path, method, name, status] of [
        ["/settings", "GET", "getSettings", 200],
        ["/settings", "PATCH", "patchSettings", 200],
        ["/profiles", "GET", "listProfiles", 200],
        ["/profiles", "POST", "createProfile", 201],
        ["/profiles", "PATCH", "patchProfile", 200],
      ] as const) {
        const writing = method !== "GET";
        const result = await send(port, path, method, writing ? { ...AUTH, "content-type": "application/json; charset=utf-8" } : AUTH,
          writing ? JSON.stringify(payload) : undefined);
        expectSafe(result, status);
        expect(result.headers["content-type"]).toContain("application/json");
        expect(JSON.parse(result.body)).toEqual({ result: name });
        expect(calls.at(-1)).toEqual(writing ? { name, body: payload } : { name });
      }
      expect(calls).toHaveLength(5);
    });
  });

  test("rejects invalid content and oversized bodies without invoking handlers", async () => {
    let calls = 0;
    await withServer({ createProfile: (): Record<string, unknown> => { calls++; return { ok: true }; } }, async (port): Promise<void> => {
      const json = { ...AUTH, "content-type": "application/json" };
      const cases: Array<{ headers: OutgoingHttpHeaders; body: string | Buffer; status: number }> = [
        { headers: AUTH, body: JSON.stringify({ value: PROFILE_DATA }), status: 415 },
        { headers: { ...AUTH, "content-type": "text/plain" }, body: PROFILE_DATA, status: 415 },
        { headers: { ...json, "content-encoding": "gzip" }, body: PROFILE_DATA, status: 415 },
        { headers: json, body: `{"value":"${PROFILE_DATA}"`, status: 400 },
        { headers: json, body: JSON.stringify([PROFILE_DATA]), status: 400 },
        { headers: json, body: "null", status: 400 },
        { headers: json, body: Buffer.from([0xff]), status: 400 },
        { headers: json, body: JSON.stringify({ value: PROFILE_DATA + "x".repeat(MAX_SERVICE_JSON_BYTES) }), status: 413 },
        { headers: { ...json, "transfer-encoding": "chunked" }, body: JSON.stringify({ value: "x".repeat(MAX_SERVICE_JSON_BYTES) }), status: 413 },
      ];
      for (const item of cases) {
        const result = await send(port, "/profiles", "POST", item.headers, item.body);
        expectSafe(result, item.status);
        expect(result.body).toBe("");
      }
      const readBody = await send(port, "/health", "GET", { ...AUTH, "content-length": "1" }, "x");
      expectSafe(readBody, 400);
      expect(calls).toBe(0);
      const limitBody = JSON.stringify({ value: "x".repeat(MAX_SERVICE_JSON_BYTES - JSON.stringify({ value: "" }).length) });
      expect(Buffer.byteLength(limitBody)).toBe(MAX_SERVICE_JSON_BYTES);
      const atLimit = await send(port, "/profiles", "POST", json, limitBody);
      expectSafe(atLimit, 201);
      expect(calls).toBe(1);
    });
  });

  test("rejects unknown URLs, direct-scope URLs, unsupported methods, and unregistered routes", async () => {
    await withServer({ listProfiles: (): Record<string, unknown> => ({ ok: true }) }, async (port): Promise<void> => {
      for (const path of ["/unknown", "/profiles?scope=direct", "/profiles/direct", "/settings"]) {
        const result = await send(port, path, "GET", AUTH);
        expectSafe(result, 404);
        expect(result.body).toBe("");
      }
      for (const [path, allow] of [["/health", "GET"], ["/profiles", "GET"]]) {
        const result = await send(port, path, "DELETE", AUTH);
        expectSafe(result, 405);
        expect(result.headers.allow).toBe(allow);
        expect(result.body).toBe("");
      }
    });
  });

  test("sanitizes handler and response serialization failures", async () => {
    const circular: Record<string, unknown> = { value: PROFILE_DATA };
    circular.self = circular;
    await withServer({
      getSettings: (): never => { throw new Error(`${TOKEN} ${PROFILE_DATA}`); },
      listProfiles: (): Record<string, unknown> => circular,
      createProfile: async (): Promise<Record<string, unknown>> => { throw new Error(`${TOKEN} ${PROFILE_DATA}`); },
    }, async (port): Promise<void> => {
      for (const [path, method] of [["/settings", "GET"], ["/profiles", "GET"], ["/profiles", "POST"]]) {
        const result = await send(port, path, method, { ...AUTH, "content-type": "application/json" },
          method === "POST" ? JSON.stringify({ value: PROFILE_DATA }) : undefined);
        expectSafe(result, 500);
        expect(result.body).toBe("");
      }
    });
  });
});
