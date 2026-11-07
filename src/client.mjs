// Client for the relay's private Unix socket. Used by the MCP server and the CLI.

import http from "node:http";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { SOCKET } from "./paths.mjs";

export class BrowseError extends Error {
  constructor(message, code, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function request(path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      { socketPath: SOCKET, path, method: payload ? "POST" : "GET", headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new BrowseError(`Timed out after ${timeoutMs}ms waiting for Firefox`, "timeout")));
    req.on("error", (err) => {
      if (err instanceof BrowseError) return reject(err);
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
        return reject(new BrowseError("Firefox isn't connected. Open Firefox with the browse for Firefox extension installed (run `browse-firefox doctor` to check the setup).", "not_connected"));
      }
      reject(err);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export async function health() {
  try {
    return await request("/health", null, 3000);
  } catch {
    return null;
  }
}

let launchedAt = 0;

/** If Firefox isn't running, start it in the background (macOS/Linux) and wait for the extension to connect. */
export async function ensureConnected({ launch = true, waitMs = 25_000 } = {}) {
  let h = await health();
  if (h?.ok) return h;
  if (!launch || process.env.BROWSE_FIREFOX_NO_LAUNCH === "1") throw new BrowseError("Firefox isn't connected.", "not_connected");
  if (Date.now() - launchedAt > 60_000) {
    launchedAt = Date.now();
    if (process.platform === "darwin") spawn("open", ["-g", "-a", "Firefox"], { stdio: "ignore", detached: true }).unref();
    else if (process.platform === "linux") spawn("firefox", [], { stdio: "ignore", detached: true }).unref();
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    h = await health();
    if (h?.ok) return h;
  }
  throw new BrowseError(
    fs.existsSync(SOCKET)
      ? "The browse relay socket exists but Firefox didn't answer. Is the extension enabled? Open about:addons."
      : "Firefox didn't connect. Make sure the browse for Firefox extension is installed and enabled, then run `browse-firefox doctor`.",
    "not_connected",
  );
}

export async function rpc(method, params = {}, { timeoutMs = 90_000, launch = true } = {}) {
  let reply;
  try {
    reply = await request("/rpc", { method, params, timeoutMs }, timeoutMs + 5_000);
  } catch (err) {
    if (err.code !== "not_connected" || !launch) throw err;
    await ensureConnected();
    reply = await request("/rpc", { method, params, timeoutMs }, timeoutMs + 5_000);
  }
  if (reply.error) throw new BrowseError(reply.error.message, reply.error.code, reply.error.data);
  return reply.result;
}
