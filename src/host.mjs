// Native-messaging host. Firefox starts this process for the extension (and only for it: the host manifest
// lists the extension id), talks to it over stdin/stdout, and stops it when the extension goes away.
// It also serves the relay: a Unix socket in a 0700 folder that MCP servers and the CLI connect to.

import http from "node:http";
import fs from "node:fs";
import { SOCKET, DATA_DIR, STATE_DIR, LOG_FILE, VERSION, ensurePrivateDir } from "./paths.mjs";
import { readSecret, listSecrets, totp } from "./secrets.mjs";

const MAX_TO_EXTENSION = 1024 * 1024 - 64;

export function runHost() {
  ensurePrivateDir(DATA_DIR);
  ensurePrivateDir(STATE_DIR);
  const log = (...args) => {
    try {
      fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.pid}] ${args.join(" ")}\n`);
    } catch {}
  };
  log("host starting", VERSION);

  const pending = new Map();
  let nextId = 1;
  let extension = null; // { extension, firefox }
  let relayError = null;
  let server = null;

  // ---- native messaging framing ----
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const len = buffer.readUInt32LE(0);
      if (buffer.length < 4 + len) break;
      const raw = buffer.subarray(4, 4 + len).toString("utf8");
      buffer = buffer.subarray(4 + len);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      onExtensionMessage(msg);
    }
  });
  process.stdin.on("end", () => {
    log("extension disconnected; exiting");
    shutdown();
  });

  function send(msg) {
    const json = Buffer.from(JSON.stringify(msg), "utf8");
    if (json.length > MAX_TO_EXTENSION) throw new Error(`Request too large for Firefox native messaging (${json.length} bytes)`);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0);
    process.stdout.write(Buffer.concat([header, json]));
  }

  function onExtensionMessage(msg) {
    if (msg.type === "hello") {
      extension = { extension: msg.extension, firefox: msg.firefox };
      log("hello from extension", msg.extension, "firefox", msg.firefox);
      send({ type: "hello-ack", version: VERSION, socket: SOCKET, pid: process.pid, relayError });
      return;
    }
    if (msg.type === "response") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }

  function callExtension(method, params, timeoutMs) {
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { message: `Firefox didn't answer ${method} within ${timeoutMs}ms`, code: "timeout" } });
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      try {
        send({ type: "request", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ error: { message: err.message, code: "too_large" } });
      }
    });
  }

  async function handleRpc({ method, params = {}, timeoutMs = 90_000 }) {
    if (method === "host.info") return { result: { version: VERSION, pid: process.pid, socket: SOCKET, ...extension } };
    if (method === "secrets.list") return { result: listSecrets() };
    if (method === "secret.type") {
      const secret = readSecret(params.name);
      if (!secret) return { error: { message: `No secret named "${params.name}". The user adds them with \`browse-firefox secrets add\`.`, code: "no_secret" } };
      const value = secret.kind === "totp" ? totp(secret.value) : secret.value;
      const reply = await callExtension("dom", { session: params.session, tabId: params.tabId, frameId: params.frameId, op: "typeSecret", args: { target: params.target, value, origins: secret.origins } }, timeoutMs);
      if (reply.result) reply.result = { ...reply.result, name: params.name, kind: secret.kind };
      return reply;
    }
    return callExtension(method, params, timeoutMs);
  }

  // ---- relay socket ----
  function listen() {
    const srv = http.createServer((req, res) => {
      const reply = (status, body) => {
        const json = JSON.stringify(body);
        res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
        res.end(json);
      };
      if (req.method === "GET" && req.url === "/health") return reply(200, { ok: !!extension, pid: process.pid, version: VERSION, ...extension });
      if (req.method !== "POST" || req.url !== "/rpc") return reply(404, { error: { message: "not found" } });
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return reply(400, { error: { message: "bad json" } });
        }
        try {
          const out = await handleRpc(body);
          reply(200, out.error ? { error: out.error } : { result: out.result ?? null });
        } catch (err) {
          reply(200, { error: { message: String(err?.message || err), code: "host_error" } });
        }
      });
    });
    srv.requestTimeout = 0;
    srv.headersTimeout = 30_000;
    srv.on("error", async (err) => {
      if (err.code !== "EADDRINUSE") {
        log("relay error", err.message);
        return;
      }
      // Is another Firefox profile already serving? Then stand by; otherwise the socket is stale.
      const alive = await new Promise((resolve) => {
        const r = http.get({ socketPath: SOCKET, path: "/health", timeout: 1500 }, (res) => {
          res.resume();
          resolve(true);
        });
        r.on("error", () => resolve(false));
        r.on("timeout", () => {
          r.destroy();
          resolve(false);
        });
      });
      if (alive) {
        setRelayError("Another Firefox profile is serving agents right now; this one is standing by and takes over when it closes.");
        setTimeout(listen, 5000);
      } else {
        try {
          fs.unlinkSync(SOCKET);
        } catch {}
        setTimeout(listen, 50);
      }
    });
    srv.listen(SOCKET, () => {
      try {
        fs.chmodSync(SOCKET, 0o600);
      } catch {}
      server = srv;
      log("relay listening on", SOCKET);
      setRelayError(null);
    });
  }

  function setRelayError(message) {
    if (relayError === message) return;
    relayError = message;
    try {
      send({ type: "relay-state", relayError, socket: SOCKET });
    } catch {}
  }

  function shutdown() {
    for (const p of pending.values()) clearTimeout(p.timer);
    if (server) {
      server.close();
      try {
        fs.unlinkSync(SOCKET);
      } catch {}
    }
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("uncaughtException", (err) => log("uncaught", err.stack || err.message));
  listen();
}
