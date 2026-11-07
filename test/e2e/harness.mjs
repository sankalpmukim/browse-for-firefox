// Test harness: fixture web server, an isolated headless Firefox with the extension loaded temporarily, and
// MCP clients built on the official @modelcontextprotocol/sdk.
//
// Isolation: XDG_DATA_HOME/XDG_STATE_HOME point at a temp folder for both the test Firefox (whose native host
// inherits the environment) and the MCP servers, so the relay socket, secrets and logs never touch the user's
// real setup, even while their own Firefox has the extension connected.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SITE = path.join(ROOT, "test/e2e/site");
const FIREFOX = process.env.FIREFOX || "/Applications/Firefox.app/Contents/MacOS/firefox";

// Keep a fresh test profile free of first-run prompts (they cover the toolbar and have their own "Continue").
const FIRST_RUN_PREFS = [
  "browser.shell.checkDefaultBrowser=false",
  "browser.preonboarding.enabled=false",
  "datareporting.policy.dataSubmissionPolicyBypassNotification=true",
  "termsofuse.bypassNotification=true",
  "browser.aboutwelcome.enabled=false",
  "trailhead.firstrun.didSeeAboutWelcome=true",
  "browser.startup.homepage_override.mstone=ignore",
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isolatedEnv() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bfx-"));
  return {
    base,
    env: { ...process.env, XDG_DATA_HOME: path.join(base, "d"), XDG_STATE_HOME: path.join(base, "s"), BROWSE_FIREFOX_NO_LAUNCH: "1", BROWSE_FIREFOX_OUTPUT_DIR: path.join(base, "out") },
  };
}

// ---------- fixture server ----------

export function startSite() {
  const log = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    log.push({ method: req.method, path: url.pathname, auth: req.headers.authorization, host: req.headers.host });
    if (url.pathname === "/redirect") {
      res.writeHead(302, { location: url.searchParams.get("to") });
      return res.end();
    }
    if (url.pathname === "/api/me") {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "sid=COOKIESECRET; Path=/; HttpOnly" });
      return res.end(JSON.stringify({ user: req.headers.authorization === "Bearer SECRETBEARER" ? "alice" : "anonymous" }));
    }
    if (url.pathname.startsWith("/spa/")) return serve(res, "spa.html");
    if (url.pathname === "/big.html") {
      const rows = Array.from({ length: 3000 }, (_, i) => `<li><a href="/item/${i}">Item ${i}</a> <button>Add ${i}</button></li>`).join("");
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<!doctype html><title>Big</title><h1>Big list</h1><ul>${rows}</ul><p id="end">The end</p>`);
    }
    if (url.pathname === "/post" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><title>Posted</title><pre id="body">${body.replace(/</g, "&lt;")}</pre>`);
      });
      return;
    }
    serve(res, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
  });
  function serve(res, file) {
    const p = path.join(SITE, path.normalize(file));
    if (!p.startsWith(SITE) || !fs.existsSync(p)) {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("<!doctype html><title>Not found</title><h1>404</h1>");
    }
    res.writeHead(200, { "content-type": p.endsWith(".json") ? "application/json" : "text/html; charset=utf-8" });
    res.end(fs.readFileSync(p));
  }
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ port, origin: `http://127.0.0.1:${port}`, otherOrigin: `http://localhost:${port}`, log, close: () => server.close() });
    });
  });
}

// ---------- Firefox ----------

function firefoxPids() {
  try {
    return execFileSync("pgrep", ["-f", "firefox -start-debugger-server"], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

export async function startFirefox(env, { headless = true, startUrl = "about:blank" } = {}) {
  // Launching a fresh profile occasionally stalls; one retry makes the suite reliable.
  try {
    return await launchFirefox(env, 60, headless, startUrl);
  } catch {
    return launchFirefox(env, 90, headless, startUrl);
  }
}

async function launchFirefox(env, waitSeconds, headless, startUrl) {
  const before = new Set(firefoxPids());
  const proc = spawn("npx", ["--yes", "web-ext@8", "run", "--source-dir", path.join(ROOT, "extension"), `--firefox=${FIREFOX}`, "--no-reload", "--no-input", ...(headless ? ["--arg=-headless"] : []), "--start-url", startUrl, ...FIRST_RUN_PREFS.map((p) => `--pref=${p}`)], {
    env,
    detached: true,
    stdio: ["ignore", fs.openSync(path.join(env.XDG_STATE_HOME, "..", "web-ext.log"), "a"), fs.openSync(path.join(env.XDG_STATE_HOME, "..", "web-ext.log"), "a")],
  });
  const stop = () => {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {}
    // web-ext doesn't always take its Firefox down with it.
    for (const pid of firefoxPids()) {
      if (!before.has(pid)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
    }
  };
  process.on("exit", stop);
  const socket = path.join(env.XDG_DATA_HOME, "browse-firefox", "relay.sock");
  for (let i = 0; i < waitSeconds; i++) {
    if (fs.existsSync(socket) && (await health(socket))) return { stop, socket, pids: () => firefoxPids().filter((p) => !before.has(p)) };
    await sleep(1000);
  }
  stop();
  const logFile = path.join(env.XDG_STATE_HOME, "..", "web-ext.log");
  throw new Error(`Test Firefox didn't connect within ${waitSeconds}s; see ${logFile}. ` + "Is the native host registered? Run `node src/cli.mjs install --no-agents`.");
}

function health(socket) {
  return new Promise((resolve) => {
    const req = http.get({ socketPath: socket, path: "/health", timeout: 2000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(JSON.parse(body).ok));
    });
    req.on("error", () => resolve(false));
  });
}

// ---------- MCP client (official SDK) ----------

export async function mcpClient(env, session) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, "src/cli.mjs"), "mcp"],
    env: { ...env, BROWSE_FIREFOX_SESSION: session },
    stderr: "inherit",
  });
  const client = new Client({ name: "browse-firefox-e2e", version: "1.0.0" });
  await client.connect(transport);
  async function call(name, args = {}, { allowError = false } = {}) {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    const images = result.content.filter((c) => c.type === "image");
    if (result.isError && !allowError) throw new Error(`${name} failed: ${text}`);
    let json = null;
    try {
      json = JSON.parse(result.content.find((c) => c.type === "text")?.text ?? "");
    } catch {}
    return { text, images, json, isError: !!result.isError, raw: result };
  }
  return { client, call, close: () => client.close() };
}

// Async on purpose: the fixture server runs in this process, and a blocking child would stall it.
export function cli(env, ...args) {
  return cliInput(env, "", ...args);
}

export function cliInput(env, input, ...args) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [path.join(ROOT, "src/cli.mjs"), ...args], { env, encoding: "utf8" }, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stderr })) : resolve(stdout),
    );
    child.stdin.end(input);
  });
}
