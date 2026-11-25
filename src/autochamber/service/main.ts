import * as process from "node:process";
import { resolveOpenCodePaths } from "../../utils/paths.js";
import { isSafeAbsolutePath, loadAutoChamberServiceBootstrap } from "./context.js";
import { createAutoChamberServiceServer } from "./server.js";

export function parseServicePort(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9][0-9]{0,4}$/.test(value)) return undefined;
  const port = Number(value);
  if (port > 65535 || String(port) !== value) return undefined;
  return port;
}

function failStartup(): void {
  process.exit(1);
}

async function start(): Promise<void> {
  try {
    const port = parseServicePort(process.env["OPENCHAMBER_SERVICE_PORT"]);
    const token = process.env["OPENCHAMBER_SERVICE_TOKEN"];
    if (port === undefined || token === undefined || token.length !== 48 || !/^[0-9a-f]{48}$/i.test(token)) {
      failStartup();
      return;
    }
    const bootstrap = await loadAutoChamberServiceBootstrap(process.env["OPENCHAMBER_SERVICE_DATA_DIR"]);
    delete process.env["OPENCODE_CONFIG_DIR"];
    if (bootstrap.openCodeConfigDir !== undefined) process.env["OPENCODE_CONFIG_DIR"] = bootstrap.openCodeConfigDir;
    const home = process.env[process.platform === "win32" ? "USERPROFILE" : "HOME"];
    const xdg = process.env["XDG_CONFIG_HOME"];
    if ((home !== undefined && home !== "" && !isSafeAbsolutePath(home))
      || (bootstrap.openCodeConfigDir === undefined && xdg !== undefined && xdg !== "" && !isSafeAbsolutePath(xdg))
      || !isSafeAbsolutePath(resolveOpenCodePaths().globalConfigRoot)) {
      failStartup();
      return;
    }
    const { createAutoChamberServiceHandlers } = await import("./handlers.js");
    const handlers = createAutoChamberServiceHandlers(bootstrap);
    const server = createAutoChamberServiceServer({ token, handlers });
    server.once("error", failStartup);
    server.listen(port, "127.0.0.1");
  } catch {
    failStartup();
  }
}

void start();
