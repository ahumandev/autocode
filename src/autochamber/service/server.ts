import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const MAX_SERVICE_JSON_BYTES = 64 * 1024;

type JsonObject = Record<string, unknown>;
type HandlerResult = JsonObject | AutoChamberServiceResponse | Promise<JsonObject | AutoChamberServiceResponse>;
type ReadHandler = () => HandlerResult;
type SettingsReadHandler = (directory?: string) => HandlerResult;
type WriteHandler = (body: JsonObject) => HandlerResult;

export class AutoChamberServiceResponse {
  constructor(readonly status: number, readonly body: JsonObject) {}
}

export interface AutoChamberServiceHandlers {
  getSettings?: SettingsReadHandler;
  patchSettings?: WriteHandler;
  listProfiles?: ReadHandler;
  createProfile?: WriteHandler;
  patchProfile?: WriteHandler;
}

export interface AutoChamberServiceServerOptions {
  token: string;
  handlers?: AutoChamberServiceHandlers;
}

type Route =
  | { method: string; status: number; read: SettingsReadHandler }
  | { method: string; status: number; write: WriteHandler };

type BodyResult =
  | { body: JsonObject }
  | { status: 400 | 413 }
  | { aborted: true };

function headerValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1]);
    }
  }
  return values;
}

function authenticated(request: IncomingMessage, token: Buffer): boolean {
  const values = headerValues(request, "authorization");
  if (values.length !== 1) return false;
  const match = /^Bearer[ \t]+([0-9a-f]{48})$/i.exec(values[0]);
  if (!match) return false;
  const candidate = Buffer.from(match[1], "ascii");
  return candidate.length === token.length && timingSafeEqual(candidate, token);
}

function respondError(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  headers: Record<string, string> = {},
): void {
  request.pause();
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Connection": "close",
    ...headers,
  });
  response.end();
}

function respondJson(response: ServerResponse, status: number, value: JsonObject): void {
  const json = JSON.stringify(value);
  if (typeof json !== "string") throw new Error("Invalid JSON response");
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(json);
}

function respondHandler(response: ServerResponse, status: number, result: JsonObject | AutoChamberServiceResponse): void {
  if (result instanceof AutoChamberServiceResponse) {
    respondJson(response, result.status, result.body);
  } else {
    respondJson(response, status, result);
  }
}

function acceptsJson(request: IncomingMessage): boolean {
  const types = headerValues(request, "content-type");
  const encodings = headerValues(request, "content-encoding");
  return types.length === 1
    && /^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?[ \t]*$/i.test(types[0])
    && (encodings.length === 0 || (encodings.length === 1 && /^identity$/i.test(encodings[0].trim())));
}

function readJson(request: IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve): void => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    function finish(result: BodyResult): void {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    request.on("data", (chunk: Buffer): void => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_SERVICE_JSON_BYTES) {
        request.pause();
        finish({ status: 413 });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", (): void => {
      if (settled) return;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
        const value: unknown = JSON.parse(text);
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          finish({ status: 400 });
          return;
        }
        finish({ body: value as JsonObject });
      } catch {
        finish({ status: 400 });
      }
    });
    request.on("aborted", (): void => finish({ aborted: true }));
    request.on("error", (): void => finish({ status: 400 }));
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: Buffer,
  routes: Record<string, Route[]>,
  expect: boolean,
): Promise<void> {
  if (!authenticated(request, token)) {
    respondError(request, response, 401, { "WWW-Authenticate": "Bearer" });
    return;
  }

  const url = request.url;
  if (url?.includes("#")) {
    respondError(request, response, 400);
    return;
  }
  const queryIndex = url?.indexOf("?") ?? -1;
  const path = queryIndex < 0 ? url : url?.slice(0, queryIndex);
  if (queryIndex >= 0 && (path !== "/settings" || request.method !== "GET")) {
    respondError(request, response, 404);
    return;
  }
  const pathRoutes = path === undefined ? undefined : routes[path];
  if (!pathRoutes || pathRoutes.length === 0) {
    respondError(request, response, 404);
    return;
  }
  const route = pathRoutes.find((item): boolean => item.method === request.method);
  if (!route) {
    respondError(request, response, 405, { "Allow": pathRoutes.map((item): string => item.method).join(", ") });
    return;
  }
  if (expect) {
    respondError(request, response, 417);
    return;
  }

  if ("read" in route) {
    const lengths = headerValues(request, "content-length");
    if (lengths.some((length): boolean => !/^0+$/.test(length.trim()))
      || headerValues(request, "transfer-encoding").length > 0) {
      respondError(request, response, 400);
      return;
    }
    let directory: string | undefined;
    if (queryIndex >= 0 && url !== undefined) {
      const query = url.slice(queryIndex + 1);
      if (!query.startsWith("directory=") || query.includes("&")) {
        respondError(request, response, 400);
        return;
      }
      try {
        directory = decodeURIComponent(query.slice("directory=".length).replace(/\+/g, " "));
      } catch {
        respondError(request, response, 400);
        return;
      }
      if (directory === "") {
        respondError(request, response, 400);
        return;
      }
    }
    respondHandler(response, route.status, await route.read(directory));
    return;
  }

  if (!acceptsJson(request)) {
    respondError(request, response, 415);
    return;
  }
  const length = request.headers["content-length"];
  if (length !== undefined && BigInt(length) > BigInt(MAX_SERVICE_JSON_BYTES)) {
    respondError(request, response, 413);
    return;
  }
  const result = await readJson(request);
  if ("aborted" in result) return;
  if ("status" in result) {
    respondError(request, response, result.status);
    return;
  }
  respondHandler(response, route.status, await route.write(result.body));
}

export function createAutoChamberServiceServer(options: AutoChamberServiceServerOptions): Server {
  if (typeof options.token !== "string" || options.token.length !== 48 || !/^[0-9a-f]{48}$/i.test(options.token)) {
    throw new Error("Invalid service token");
  }
  const token = Buffer.from(options.token, "ascii");
  const handlers = options.handlers;
  const routes: Record<string, Route[]> = Object.create(null);
  routes["/health"] = [{ method: "GET", status: 200, read: (): JsonObject => ({ ok: true }) }];
  routes["/settings"] = [];
  routes["/profiles"] = [];
  if (handlers?.getSettings) routes["/settings"].push({ method: "GET", status: 200, read: handlers.getSettings });
  if (handlers?.patchSettings) routes["/settings"].push({ method: "PATCH", status: 200, write: handlers.patchSettings });
  if (handlers?.listProfiles) routes["/profiles"].push({ method: "GET", status: 200, read: handlers.listProfiles });
  if (handlers?.createProfile) routes["/profiles"].push({ method: "POST", status: 201, write: handlers.createProfile });
  if (handlers?.patchProfile) routes["/profiles"].push({ method: "PATCH", status: 200, write: handlers.patchProfile });

  const server = createServer({
    maxHeaderSize: 16 * 1024,
    headersTimeout: 15_000,
    requestTimeout: 30_000,
    connectionsCheckingInterval: 1_000,
  });
  function dispatch(request: IncomingMessage, response: ServerResponse, expect: boolean): void {
    request.on("error", (): void => {});
    void handleRequest(request, response, token, routes, expect).catch((): void => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      respondError(request, response, 500);
    });
  }
  server.on("request", (request, response): void => dispatch(request, response, false));
  server.on("checkContinue", (request, response): void => dispatch(request, response, true));
  server.on("checkExpectation", (request, response): void => dispatch(request, response, true));
  server.on("clientError", (_error, socket): void => {
    socket.destroy();
  });
  return server;
}
