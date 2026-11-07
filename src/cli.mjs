#!/usr/bin/env node
// browse-firefox: MCP server, native-messaging host, and CLI for the browse for Firefox extension.

import fs from "node:fs";
import { VERSION } from "./paths.mjs";

const [, , command, ...rest] = process.argv;

function parseFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) flags[k] = v;
      else if (args[i + 1] && !args[i + 1].startsWith("--")) flags[k] = args[++i];
      else flags[k] = true;
    } else flags._.push(a);
  }
  return flags;
}

const HELP = `browse-firefox ${VERSION} — let AI agents use your real Firefox

  install [--agents opencode,claude,codex,cursor] [--no-agents]
                       Register the native host with Firefox, add the MCP server to your agents, build the .xpi
  uninstall            Undo install (keeps secrets)
  doctor               Check the setup
  status               Firefox/extension status and agent tabs
  mcp                  Run the MCP server on stdio (what agents start)
  exec <code>|--file f Run a Playwright-style script (same as the execute tool) [--session name]
  snapshot [url]       Print a page snapshot (navigates first when a url is given)
  screenshot <out.png> [url]
  tabs                 List agent and lent tabs
  settings get | set key=value ...
  secrets list | add <name> --origin https://site [--origin ...] [--totp] | remove <name>
  build                Zip the extension into dist/*.xpi (unsigned)
  sign                 Sign it on addons.mozilla.org as unlisted (needs AMO_JWT_ISSUER/AMO_JWT_SECRET)
  host                 Native-messaging host (Firefox starts this)
`;

async function readHidden(prompt) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  return new Promise((resolve) => {
    process.stdin.on("data", function onData(buf) {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stderr.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    });
  });
}

async function cliSession(flags) {
  const { Session } = await import("./browser.mjs");
  return new Session(flags.session || process.env.BROWSE_FIREFOX_SESSION || "cli");
}

async function main() {
  const flags = parseFlags(rest);
  switch (command) {
    case "host":
      return (await import("./host.mjs")).runHost();
    case "mcp":
      return (await import("./mcp.mjs")).runMcp();
    case "install":
      return console.log(await (await import("./install.mjs")).install(flags));
    case "uninstall":
      return console.log(await (await import("./install.mjs")).uninstall(flags));
    case "doctor":
      return console.log(await (await import("./install.mjs")).doctor());
    case "build":
      return console.log((await import("./install.mjs")).build());
    case "sign":
      return console.log(`Signed: ${(await import("./install.mjs")).sign()}`);
    case "status": {
      const { rpc, health } = await import("./client.mjs");
      const h = await health();
      if (!h?.ok) return console.log(JSON.stringify({ connected: false, hint: "Open Firefox with the extension installed; run browse-firefox doctor." }, null, 2));
      return console.log(JSON.stringify({ connected: true, relay: h, ...(await rpc("status", { session: flags.session })) }, null, 2));
    }
    case "tabs": {
      const { rpc } = await import("./client.mjs");
      return console.log(JSON.stringify(await rpc("tabs.list", { all: true }), null, 2));
    }
    case "settings": {
      const { rpc } = await import("./client.mjs");
      if (flags._[0] === "set") {
        const values = Object.fromEntries(flags._.slice(1).map((kv) => kv.split("=")));
        return console.log(JSON.stringify(await rpc("settings.set", { values }), null, 2));
      }
      return console.log(JSON.stringify(await rpc("settings.get"), null, 2));
    }
    case "exec": {
      const code = flags.file ? fs.readFileSync(flags.file, "utf8") : flags._.join(" ");
      if (!code) throw new Error("exec needs code or --file");
      const session = await cliSession(flags);
      const { createRunner } = await import("./execute.mjs");
      const { value, logs } = await createRunner(session)(code, { timeoutMs: Number(flags.timeout || 120_000) });
      for (const l of logs) console.error(l);
      if (Buffer.isBuffer(value)) {
        const out = flags.out || "execute-result.png";
        fs.writeFileSync(out, value);
        return console.log(`Wrote ${out}`);
      }
      return console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    }
    case "snapshot": {
      const session = await cliSession(flags);
      const tabId = await session.resolveTab(null);
      if (flags._[0]) await session.call("tab.navigate", { tabId, action: "goto", url: flags._[0] });
      return console.log((await session.snapshot(tabId, 0)).text);
    }
    case "screenshot": {
      const out = flags._[0] || "screenshot.png";
      const session = await cliSession(flags);
      const tabId = await session.resolveTab(null);
      if (flags._[1]) await session.call("tab.navigate", { tabId, action: "goto", url: flags._[1] });
      const r = await session.call("screenshot", { tabId, fullPage: !!flags.full, labels: !!flags.labels });
      fs.writeFileSync(out, Buffer.from(r.dataUrl.split(",")[1], "base64"));
      return console.log(`Wrote ${out}`);
    }
    case "secrets": {
      const s = await import("./secrets.mjs");
      const sub = flags._[0];
      if (sub === "list" || !sub) return console.log(JSON.stringify(s.listSecrets(), null, 2));
      if (sub === "remove") return console.log(s.removeSecret(flags._[1]) ? `Removed ${flags._[1]}` : `No secret ${flags._[1]}`);
      if (sub === "add") {
        const name = flags._[1];
        const origins = [].concat(flags.origin || []).flatMap((o) => String(o).split(","));
        const raw = rest.filter((a, i) => rest[i - 1] === "--origin");
        const allOrigins = [...new Set([...origins, ...raw])];
        const value = await readHidden(flags.totp ? "TOTP seed (base32 or otpauth:// URL): " : "Secret value: ");
        const r = s.addSecret(name, { origins: allOrigins, kind: flags.totp ? "totp" : flags.kind || "password", value });
        return console.log(`Stored ${r.kind} "${r.name}" for ${r.origins.join(", ")}`);
      }
      throw new Error(`Unknown secrets command ${sub}`);
    }
    case "version":
    case "--version":
    case "-v":
      return console.log(VERSION);
    default:
      return console.log(HELP);
  }
}

main().catch((err) => {
  console.error(`${err.code ? `[${err.code}] ` : ""}${err.message}`);
  process.exit(1);
});
