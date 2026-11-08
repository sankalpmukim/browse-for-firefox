// Publish a version to addons.mozilla.org (listed) with Mozilla's own web-ext.
// Needs AMO_JWT_ISSUER and AMO_JWT_SECRET (https://addons.mozilla.org/developers/addon/api/key/).
// Usage: node store/publish.mjs [--dry-run]

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8").trim();
const manifest = JSON.parse(read("extension/manifest.json"));
const pkg = JSON.parse(read("package.json"));
if (manifest.version !== pkg.version) throw new Error(`manifest ${manifest.version} != package.json ${pkg.version}`);

const releaseNotes = (() => {
  const file = path.join(ROOT, "store", "release-notes", `${manifest.version}.md`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : `Version ${manifest.version}.`;
})();

const metadata = {
  name: { "en-US": manifest.name },
  slug: "browse-for-firefox",
  summary: { "en-US": "Let your AI agents (Claude Code, opencode, Codex, any MCP client) use your real Firefox: tabs, logins, forms, screenshots, network capture, and hand-offs to you." },
  description: { "en-US": read("store/listing.md") },
  categories: { firefox: ["web-development", "tabs"] },
  homepage: { "en-US": "https://github.com/sankalpmukim/opencode-browse-firefox" },
  tags: ["user scripts", "privacy"],
  default_locale: "en-US",
  version: {
    license: "MIT",
    approval_notes: read("store/reviewer-notes.md"),
    release_notes: { "en-US": releaseNotes },
    compatibility: ["firefox"],
  },
};
if (metadata.summary["en-US"].length > 250) throw new Error("summary too long");

const out = path.join(ROOT, "dist", "amo-metadata.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(metadata, null, 2));
console.log(`Metadata: ${out}`);
if (process.argv.includes("--dry-run")) process.exit(0);

const key = process.env.AMO_JWT_ISSUER;
const secret = process.env.AMO_JWT_SECRET;
if (!key || !secret) throw new Error("Set AMO_JWT_ISSUER and AMO_JWT_SECRET");
const r = spawnSync(
  "npx",
  ["--yes", "web-ext@8", "sign", "--channel", "listed", "--source-dir", path.join(ROOT, "extension"), "--artifacts-dir", path.join(ROOT, "dist"), "--amo-metadata", out, "--approval-timeout", "0"],
  { stdio: "inherit", env: { ...process.env, WEB_EXT_API_KEY: key, WEB_EXT_API_SECRET: secret } },
);
process.exit(r.status ?? 1);
