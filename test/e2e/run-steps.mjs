// Drive the browse-firefox MCP server over stdio and print each tool result.
import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";

const CLI = new URL("../../src/cli.mjs", import.meta.url).pathname;
const steps = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const child = spawn(process.execPath, [CLI, "mcp"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, BROWSE_FIREFOX_SESSION: process.argv[3] || "test" } });
const rl = readline.createInterface({ input: child.stdout });
const waiting = new Map();
rl.on("line", (l) => {
  const m = JSON.parse(l);
  waiting.get(m.id)?.(m);
});
let id = 0;
const call = (method, params) =>
  new Promise((res) => {
    const i = ++id;
    waiting.set(i, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  });

const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
console.log("init:", init.result.serverInfo, "tools:", (await call("tools/list", {})).result.tools.length);
for (const [name, args] of steps) {
  const t0 = Date.now();
  const r = await call("tools/call", { name, arguments: args });
  const content = r.result?.content || [];
  console.log(`\n=== ${name} ${JSON.stringify(args).slice(0, 140)} (${Date.now() - t0}ms)${r.result?.isError ? " ERROR" : ""}`);
  for (const c of content) {
    if (c.type === "image") {
      const f = `${process.env.TMPDIR || "/tmp"}/browse-firefox-e2e-shot-${id}.png`;
      fs.writeFileSync(f, Buffer.from(c.data, "base64"));
      console.log(`[image ${c.mimeType} ${c.data.length} b64 chars -> ${f}]`);
    } else console.log(c.text.length > 3000 ? c.text.slice(0, 3000) + "\n…[cut]" : c.text);
  }
  if (r.error) console.log("RPC ERROR", r.error);
}
child.kill();
process.exit(0);
