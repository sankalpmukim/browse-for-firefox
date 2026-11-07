import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotDiff } from "../src/browser.mjs";
import { totp, normalizeOrigin } from "../src/secrets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("snapshotDiff reports added and removed lines, ignoring the viewport line", () => {
  const a = "Page: x\nURL: u\nViewport: 1x1, scrolled 0\n\n- button \"A\" [ref=e1]\n- text: \"old\"";
  const b = "Page: x\nURL: u\nViewport: 1x1, scrolled 50\n\n- button \"A\" [ref=e1]\n- text: \"new\"";
  assert.equal(snapshotDiff(a, b), '+ - text: "new"\n- - text: "old"');
  assert.equal(snapshotDiff(a, a), "No changes.");
  assert.equal(snapshotDiff(null, a), null);
});

test("totp matches RFC 6238 (SHA-1) test vectors", () => {
  // Seed "12345678901234567890" in base32.
  const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totp(seed, { now: 59_000, digits: 8 }), "94287082");
  assert.equal(totp(seed, { now: 1111111109_000, digits: 8 }), "07081804");
  assert.equal(totp(seed, { now: 1234567890_000, digits: 8 }), "89005924");
  assert.equal(totp(`otpauth://totp/x?secret=${seed}`, { now: 59_000 }), "287082");
});

test("normalizeOrigin", () => {
  assert.equal(normalizeOrigin("example.com"), "https://example.com");
  assert.equal(normalizeOrigin("http://localhost:3000/login"), "http://localhost:3000");
  assert.equal(normalizeOrigin("*.Example.com"), "*.example.com");
});

test("allowlist pattern matching", async () => {
  // The background modules register listeners on import; stub the whole browser global.
  const stub = () => new Proxy(function () {}, { get: (_, k) => (k === "then" ? undefined : stub()), apply: () => Promise.resolve({}) });
  globalThis.browser = stub();
  const { matchesPattern } = await import("../extension/background/policy.js");
  assert.ok(matchesPattern("https://example.com/a", "example.com"));
  assert.ok(!matchesPattern("https://evil.com/?example.com", "example.com"));
  assert.ok(!matchesPattern("https://sub.example.com/", "example.com"));
  assert.ok(matchesPattern("https://sub.example.com/", "*.example.com"));
  assert.ok(matchesPattern("https://example.com/", "*.example.com"));
  assert.ok(!matchesPattern("https://example.com.evil.net/", "*.example.com"));
  assert.ok(matchesPattern("http://localhost:3000/x", "http://localhost:3000"));
  assert.ok(!matchesPattern("http://localhost:4000/x", "http://localhost:3000"));
  assert.ok(!matchesPattern("http://example.com/", "https://example.com"));
  assert.ok(!matchesPattern("file:///etc/passwd", "example.com"));
});

test("MCP server answers initialize and lists its tools", async () => {
  const child = spawn(process.execPath, [path.join(root, "src/cli.mjs"), "mcp"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, BROWSE_FIREFOX_NO_LAUNCH: "1" } });
  const rl = readline.createInterface({ input: child.stdout });
  const replies = new Map();
  const waiters = new Map();
  rl.on("line", (l) => {
    const m = JSON.parse(l);
    if (waiters.has(m.id)) waiters.get(m.id)(m);
    else replies.set(m.id, m);
  });
  const call = (id, method, params) =>
    new Promise((resolve) => {
      waiters.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    const init = await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "browse-firefox");
    const list = await call(2, "tools/list", {});
    const names = list.result.tools.map((t) => t.name);
    for (const n of ["navigate", "snapshot", "click", "fill", "execute", "handoff", "network", "recording", "screenshot"]) assert.ok(names.includes(n), n);
    for (const t of list.result.tools) assert.equal(t.inputSchema.type, "object");
    const unknown = await call(3, "tools/call", { name: "nope", arguments: {} });
    assert.ok(unknown.error);
  } finally {
    child.kill();
  }
});
