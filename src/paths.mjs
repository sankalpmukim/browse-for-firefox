import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const home = os.homedir();
const xdg = (envName, fallback) => process.env[envName] || path.join(home, fallback);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const EXTENSION_DIR = path.join(ROOT, "extension");
export const CLI = path.join(ROOT, "src", "cli.mjs");
export const EXTENSION_ID = "{908e931a-d7fd-434d-b466-8cd8ef9f1a7d}";
export const HOST_NAME = "browse_firefox";
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

export const DATA_DIR = path.join(xdg("XDG_DATA_HOME", ".local/share"), "browse-firefox");
export const STATE_DIR = path.join(xdg("XDG_STATE_HOME", ".local/state"), "browse-firefox");
export const SOCKET = process.env.BROWSE_FIREFOX_SOCKET || path.join(DATA_DIR, "relay.sock");
export const SECRETS_FILE = path.join(DATA_DIR, "secrets.json");
export const HOST_WRAPPER = path.join(DATA_DIR, "native-host.sh");
export const LOG_FILE = path.join(STATE_DIR, "host.log");
export const OUTPUT_DIR = process.env.BROWSE_FIREFOX_OUTPUT_DIR || path.join(os.tmpdir(), "browse-firefox");

export function nativeManifestDir() {
  if (process.platform === "darwin") return path.join(home, "Library/Application Support/Mozilla/NativeMessagingHosts");
  if (process.platform === "linux") return path.join(home, ".mozilla/native-messaging-hosts");
  return null;
}

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
}

export function outputPath(name) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  return path.join(OUTPUT_DIR, name);
}
