// install / uninstall / doctor / build / sign.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, CLI, DATA_DIR, STATE_DIR, HOST_NAME, HOST_WRAPPER, EXTENSION_ID, EXTENSION_DIR, SOCKET, VERSION, LOG_FILE, nativeManifestDir, ensurePrivateDir } from "./paths.mjs";
import { health } from "./client.mjs";

const home = os.homedir();
const BIN_WRAPPER = path.join(DATA_DIR, "bin", "browse-firefox");
const LOCAL_BIN = path.join(process.env.XDG_BIN_HOME || path.join(home, ".local/bin"), "browse-firefox");
const MCP_NAME = "browse-firefox";
const DIST = path.join(ROOT, "dist");

function nodeLauncher(entryArgs) {
  // Firefox and GUI agents start us with a minimal PATH, so record this node and fall back to common locations.
  return `#!/bin/sh
NODE=${JSON.stringify(process.execPath)}
if [ ! -x "$NODE" ]; then
  PATH="$PATH:$HOME/.local/share/vite-plus/bin:$HOME/.volta/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
  NODE="$(command -v node)"
fi
exec "$NODE" ${JSON.stringify(CLI)} ${entryArgs}
`;
}

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

export function nativeManifestPath() {
  const dir = nativeManifestDir();
  return dir ? path.join(dir, `${HOST_NAME}.json`) : null;
}

// ---------- agent configs ----------

const AGENTS = {
  opencode: {
    label: "OpenCode",
    file: () => ["opencode.json", "opencode.jsonc"].map((f) => path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode", f)).find((f) => fs.existsSync(f)) || path.join(home, ".config/opencode/opencode.json"),
    detect: () => fs.existsSync(path.join(home, ".config/opencode")) || fs.existsSync(path.join(home, ".opencode")),
    add(file) {
      return editJson(file, (cfg) => {
        cfg.mcp ??= {};
        cfg.mcp.servers ??= {};
        cfg.mcp.servers[MCP_NAME] = { type: "local", command: [BIN_WRAPPER, "mcp"], enabled: true };
      });
    },
    remove(file) {
      return editJson(file, (cfg) => {
        if (cfg.mcp?.servers?.[MCP_NAME]) delete cfg.mcp.servers[MCP_NAME];
        else return false;
      });
    },
  },
  claude: {
    label: "Claude Code",
    file: () => path.join(home, ".claude.json"),
    detect: () => fs.existsSync(path.join(home, ".claude.json")) || commandExists("claude"),
    add(file) {
      if (commandExists("claude")) {
        spawnSync("claude", ["mcp", "remove", "--scope", "user", MCP_NAME], { stdio: "ignore" });
        const r = spawnSync("claude", ["mcp", "add", "--scope", "user", MCP_NAME, "--", BIN_WRAPPER, "mcp"], { encoding: "utf8" });
        if (r.status === 0) return "added (claude mcp add --scope user)";
      }
      return editJson(file, (cfg) => {
        cfg.mcpServers ??= {};
        cfg.mcpServers[MCP_NAME] = { type: "stdio", command: BIN_WRAPPER, args: ["mcp"] };
      });
    },
    remove(file) {
      if (commandExists("claude")) {
        const r = spawnSync("claude", ["mcp", "remove", "--scope", "user", MCP_NAME], { encoding: "utf8" });
        if (r.status === 0) return "removed";
      }
      return editJson(file, (cfg) => {
        if (cfg.mcpServers?.[MCP_NAME]) delete cfg.mcpServers[MCP_NAME];
        else return false;
      });
    },
  },
  cursor: {
    label: "Cursor",
    file: () => path.join(home, ".cursor/mcp.json"),
    detect: () => fs.existsSync(path.join(home, ".cursor")),
    add(file) {
      return editJson(file, (cfg) => {
        cfg.mcpServers ??= {};
        cfg.mcpServers[MCP_NAME] = { command: BIN_WRAPPER, args: ["mcp"] };
      });
    },
    remove(file) {
      return editJson(file, (cfg) => {
        if (cfg.mcpServers?.[MCP_NAME]) delete cfg.mcpServers[MCP_NAME];
        else return false;
      });
    },
  },
  codex: {
    label: "Codex",
    file: () => path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "config.toml"),
    detect: () => fs.existsSync(path.join(home, ".codex")),
    add(file) {
      const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      const block = `[mcp_servers.${MCP_NAME}]\ncommand = ${JSON.stringify(BIN_WRAPPER)}\nargs = ["mcp"]\nstartup_timeout_sec = 30\n`;
      const without = removeTomlBlock(before);
      backup(file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${without.replace(/\s*$/, "")}\n\n${block}`);
      return before.includes(`[mcp_servers.${MCP_NAME}]`) ? "updated" : "added";
    },
    remove(file) {
      if (!fs.existsSync(file)) return "not configured";
      const before = fs.readFileSync(file, "utf8");
      if (!before.includes(`[mcp_servers.${MCP_NAME}]`)) return "not configured";
      backup(file);
      fs.writeFileSync(file, removeTomlBlock(before));
      return "removed";
    },
  },
};

function removeTomlBlock(text) {
  const lines = text.split("\n");
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) skipping = line.trim() === `[mcp_servers.${MCP_NAME}]` || line.trim().startsWith(`[mcp_servers.${MCP_NAME}.`);
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

function commandExists(cmd) {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
}

function backup(file) {
  if (!fs.existsSync(file)) return;
  const dest = `${file}.bak-browse-firefox`;
  if (!fs.existsSync(dest)) fs.copyFileSync(file, dest);
}

function editJson(file, mutate) {
  let cfg = {};
  if (fs.existsSync(file)) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return `skipped: ${file} isn't plain JSON (has comments?). Add the entry by hand: { "command": ${JSON.stringify(BIN_WRAPPER)}, "args": ["mcp"] }`;
    }
  }
  const result = mutate(cfg);
  if (result === false) return "not configured";
  backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return "configured";
}

function chooseAgents(flags) {
  if (flags["no-agents"]) return [];
  if (flags.agents) return String(flags.agents).split(",").map((s) => s.trim()).filter(Boolean);
  return Object.entries(AGENTS).filter(([, a]) => a.detect()).map(([name]) => name);
}

// ---------- commands ----------

export async function install(flags = {}) {
  const lines = [];
  const manifestPath = nativeManifestPath();
  if (!manifestPath) throw new Error("Native messaging registration is only automated on macOS and Linux. On Windows, register the host in the registry (HKCU\\Software\\Mozilla\\NativeMessagingHosts\\browse_firefox).");
  ensurePrivateDir(DATA_DIR);
  ensurePrivateDir(STATE_DIR);

  writeExecutable(HOST_WRAPPER, nodeLauncher(`host "$@"`));
  writeExecutable(BIN_WRAPPER, nodeLauncher(`"$@"`));
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ name: HOST_NAME, description: "browse for Firefox relay", path: HOST_WRAPPER, type: "stdio", allowed_extensions: [EXTENSION_ID] }, null, 2)}\n`,
  );
  lines.push(`✓ Native-messaging host registered: ${manifestPath}`);

  try {
    fs.mkdirSync(path.dirname(LOCAL_BIN), { recursive: true });
    try {
      fs.unlinkSync(LOCAL_BIN);
    } catch {}
    fs.symlinkSync(BIN_WRAPPER, LOCAL_BIN);
    lines.push(`✓ CLI: ${LOCAL_BIN}`);
  } catch (err) {
    lines.push(`! Couldn't link ${LOCAL_BIN}: ${err.message}`);
  }

  for (const name of chooseAgents(flags)) {
    const agent = AGENTS[name];
    if (!agent) {
      lines.push(`! Unknown agent "${name}" (supported: ${Object.keys(AGENTS).join(", ")})`);
      continue;
    }
    try {
      const file = agent.file();
      lines.push(`✓ ${agent.label}: ${agent.add(file)} — ${file}`);
    } catch (err) {
      lines.push(`! ${agent.label}: ${err.message}`);
    }
  }
  lines.push(`  Any other MCP client: { "command": ${JSON.stringify(BIN_WRAPPER)}, "args": ["mcp"] }`);

  const xpi = build();
  lines.push(`✓ Extension package: ${xpi}`);
  const h = await health();
  lines.push(h?.ok ? `✓ Firefox is connected (extension ${h.extension}, Firefox ${h.firefox})` : "• Firefox isn't connected yet: install the extension (see README → Install the extension), or click Reconnect on its settings page.");
  return lines.join("\n");
}

export async function uninstall(flags = {}) {
  const lines = [];
  const manifestPath = nativeManifestPath();
  if (manifestPath && fs.existsSync(manifestPath)) {
    fs.unlinkSync(manifestPath);
    lines.push(`✓ Removed ${manifestPath}`);
  }
  for (const f of [LOCAL_BIN]) {
    try {
      if (fs.lstatSync(f).isSymbolicLink()) {
        fs.unlinkSync(f);
        lines.push(`✓ Removed ${f}`);
      }
    } catch {}
  }
  const names = flags.agents ? String(flags.agents).split(",") : Object.keys(AGENTS);
  for (const name of names) {
    const agent = AGENTS[name];
    if (!agent) continue;
    try {
      lines.push(`✓ ${agent.label}: ${agent.remove(agent.file())}`);
    } catch (err) {
      lines.push(`! ${agent.label}: ${err.message}`);
    }
  }
  lines.push(`Your secrets and logs stay in ${DATA_DIR} and ${STATE_DIR}; delete them by hand if you want. Remove the extension in about:addons.`);
  return lines.join("\n");
}

export async function doctor() {
  const checks = [];
  const ok = (good, label, detail = "") => checks.push(`${good ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok(Number(process.versions.node.split(".")[0]) >= 20, "Node.js", process.versions.node);
  const manifestPath = nativeManifestPath();
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {}
  ok(!!manifest, "Native-messaging manifest", manifestPath || "unsupported OS");
  if (manifest) {
    ok(manifest.allowed_extensions?.includes(EXTENSION_ID), "Manifest allows this extension", EXTENSION_ID);
    let exec = false;
    try {
      fs.accessSync(manifest.path, fs.constants.X_OK);
      exec = true;
    } catch {}
    ok(exec, "Host launcher is executable", manifest.path);
  }
  const h = await health();
  ok(!!h, "Relay socket answers", SOCKET);
  ok(!!h?.ok, "Firefox extension connected", h?.ok ? `extension ${h.extension}, Firefox ${h.firefox}, host pid ${h.pid}` : "open Firefox; check about:addons that browse for Firefox is enabled");
  if (h && h.version !== VERSION) ok(false, "Relay version matches", `relay ${h.version}, CLI ${VERSION}: reload the extension in about:addons (or restart Firefox)`);
  for (const [name, agent] of Object.entries(AGENTS)) {
    const file = agent.file();
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (text.includes(MCP_NAME)) ok(true, `${agent.label} MCP entry`, file);
    else if (agent.detect()) checks.push(`• ${agent.label}: no ${MCP_NAME} entry (browse-firefox install --agents ${name})`);
  }
  checks.push(`  Logs: ${LOG_FILE}`);
  return checks.join("\n");
}

export function build() {
  fs.mkdirSync(DIST, { recursive: true });
  const out = path.join(DIST, `browse-firefox-${VERSION}.xpi`);
  try {
    fs.unlinkSync(out);
  } catch {}
  const r = spawnSync("zip", ["-r", "-X", "-q", out, ".", "-x", "*.DS_Store"], { cwd: EXTENSION_DIR, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`zip failed: ${r.stderr || r.error}`);
  return out;
}

/** Sign for self-distribution (unlisted) on addons.mozilla.org, so release Firefox installs it permanently. */
export function sign() {
  const key = process.env.AMO_JWT_ISSUER || process.env.WEB_EXT_API_KEY;
  const secret = process.env.AMO_JWT_SECRET || process.env.WEB_EXT_API_SECRET;
  if (!key || !secret) throw new Error("Set AMO_JWT_ISSUER and AMO_JWT_SECRET (from https://addons.mozilla.org/developers/addon/api/key/) to sign.");
  fs.mkdirSync(DIST, { recursive: true });
  const r = spawnSync("npx", ["--yes", "web-ext@8", "sign", "--channel", "unlisted", "--source-dir", EXTENSION_DIR, "--artifacts-dir", DIST, "--api-key", key, "--api-secret", secret, "--approval-timeout", "900000"], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("web-ext sign failed");
  const signed = fs.readdirSync(DIST).filter((f) => f.endsWith(".xpi") && !f.startsWith("browse-firefox-")).map((f) => path.join(DIST, f));
  return signed.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}
