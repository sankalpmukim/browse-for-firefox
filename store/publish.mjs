// Publish a version to addons.mozilla.org (listed) with Mozilla's own web-ext.
// Needs AMO_JWT_ISSUER and AMO_JWT_SECRET (https://addons.mozilla.org/developers/addon/api/key/).
// Usage:
//   node store/publish.mjs [--dry-run]              build metadata, then sign a new version
//   node store/publish.mjs --sync-listing [--dry-run]  update listing copy, icon and screenshots

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
  slug: "agent-browse",
  summary: { "en-US": "Let your AI agents (Claude Code, opencode, Codex, any MCP client) use your real Firefox: tabs, logins, forms, screenshots, network capture, and hand-offs to you." },
  description: { "en-US": read("store/listing.md") },
  categories: { firefox: ["web-development", "tabs"] },
  homepage: { "en-US": "https://github.com/sankalpmukim/browse-for-firefox" },
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

const dryRun = process.argv.includes("--dry-run");
if (process.argv.includes("--sync-listing")) {
  if (dryRun) {
    listingPlan(); // validates files and captions, prints what would happen
    process.exit(0);
  }
  const key = process.env.AMO_JWT_ISSUER;
  const secret = process.env.AMO_JWT_SECRET;
  if (!key || !secret) throw new Error("Set AMO_JWT_ISSUER and AMO_JWT_SECRET");
  await syncListing(key, secret);
  process.exit(0);
}
if (dryRun) process.exit(0);

const key = process.env.AMO_JWT_ISSUER;
const secret = process.env.AMO_JWT_SECRET;
if (!key || !secret) throw new Error("Set AMO_JWT_ISSUER and AMO_JWT_SECRET");

const r = spawnSync(
  "npx",
  ["--yes", "web-ext@8", "sign", "--channel", "listed", "--source-dir", path.join(ROOT, "extension"), "--artifacts-dir", path.join(ROOT, "dist"), "--amo-metadata", out, "--approval-timeout", "0"],
  { stdio: "inherit", env: { ...process.env, WEB_EXT_API_KEY: key, WEB_EXT_API_SECRET: secret } },
);
process.exit(r.status ?? 1);

// ---- listing sync: description, icon and screenshots over the AMO v5 API ----

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function makeAmo(key, secret) {
  return async function amoFetch(method, apiPath, { json, form } = {}) {
    for (let attempt = 1; ; attempt++) {
      const now = Math.floor(Date.now() / 1000);
      const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const payload = b64url(JSON.stringify({ iss: key, iat: now, exp: now + 60 }));
      const sig = b64url(crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest());
      const headers = { Authorization: `JWT ${header}.${payload}.${sig}`, "User-Agent": "browse-for-firefox-publish/0.1" };
      let body;
      if (json) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(json);
      } else if (form) {
        body = form; // pre-built FormData
      }
      const res = await fetch(`https://addons.mozilla.org/api/v5${apiPath}`, { method, headers, body });
      if (res.status === 429 && attempt < 8) {
        const retryAfter = Number(res.headers.get("retry-after")) || 60;
        console.log(`  throttled by AMO, waiting ${retryAfter + 1}s…`);
        await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`AMO ${method} ${apiPath} -> ${res.status}: ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    }
  };
}

function screenshotFiles() {
  const shotsDir = path.join(ROOT, "store", "screenshots");
  const captions = JSON.parse(fs.readFileSync(path.join(shotsDir, "captions.json"), "utf8"));
  const onDisk = new Set(fs.readdirSync(shotsDir).filter((f) => /\.(png|jpg)$/i.test(f)));
  const images = Object.keys(captions).filter((f) => onDisk.has(f)); // captions.json sets the order
  return { shotsDir, captions, images };
}

function listingPlan() {
  const { shotsDir, captions, images } = screenshotFiles();
  for (const f of images) {
    if (!captions[f]) throw new Error(`No caption for ${f} in store/screenshots/captions.json`);
    console.log(`would upload ${f}: ${captions[f]}`);
  }
  const icon = path.join(ROOT, "store", "icon-512.png");
  if (!fs.existsSync(icon)) throw new Error("store/icon-512.png missing");
  console.log("would upload listing icon store/icon-512.png");
  console.log(`would PATCH description (${metadata.description["en-US"].length} chars), summary, homepage`);
}

async function syncListing(key, secret) {
  const amo = makeAmo(key, secret);
  const slug = metadata.slug;
  const { shotsDir, captions, images } = screenshotFiles();
  listingPlan();

  // Change-checked copy sync: PATCH only what differs. AMO normalizes markdown, so the
  // marker hash is the reliable "already synced" signal; text compare only catches drift
  // someone else made in the dev hub.
  const before = await amo("GET", `/addons/addon/${slug}/`);
  const descHash = crypto.createHash("sha256").update(metadata.description["en-US"]).digest("hex");
  const descMarker = path.join(ROOT, "dist", ".listing-desc-hash");
  const descSynced = fs.existsSync(descMarker) && fs.readFileSync(descMarker, "utf8").trim() === descHash;
  const copyPatch = {};
  if (!descSynced) copyPatch.description = metadata.description;
  for (const [field, value] of [["summary", metadata.summary], ["homepage", metadata.homepage]]) {
    const currentEn = typeof before[field]?.["en-US"] === "string" ? before[field]["en-US"].trim() : null;
    if (currentEn !== value["en-US"].trim()) copyPatch[field] = value;
  }
  if (Object.keys(copyPatch).length) {
    await amo("PATCH", `/addons/addon/${slug}/`, { json: copyPatch });
    fs.mkdirSync(path.dirname(descMarker), { recursive: true });
    fs.writeFileSync(descMarker, descHash);
    console.log(`Listing copy updated: ${Object.keys(copyPatch).join(", ")}`);
  } else {
    console.log("Listing copy already up to date");
  }

  const iconPath = path.join(shotsDir, "..", "icon-512.png");
  const iconHash = crypto.createHash("sha256").update(fs.readFileSync(iconPath)).digest("hex");
  const marker = path.join(ROOT, "dist", ".listing-icon-hash");
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === iconHash) {
    console.log("Listing icon unchanged since last upload");
  } else {
    const fd = new FormData();
    fd.set("icon", new Blob([fs.readFileSync(iconPath)], { type: "image/png" }), "icon-512.png");
    await amo("PATCH", `/addons/addon/${slug}/`, { form: fd });
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, iconHash);
    console.log("Listing icon uploaded");
  }
  await new Promise((r) => setTimeout(r, 30000));

  // Match previews to files: caption text first, then uncaptioned by upload order (id).
  const existing = before.previews || [];
  const match = new Array(images.length).fill(null);
  const unmatched = [];
  for (const preview of existing) {
    const cap = preview.caption?.["en-US"];
    const idx = cap ? images.findIndex((f) => captions[f] === cap) : -1;
    if (idx >= 0) match[idx] = preview;
    else unmatched.push(preview);
  }
  unmatched.sort((a, b) => a.id - b.id);
  const filesLeft = images.map((f, i) => (match[i] ? null : f)).filter(Boolean);
  for (const preview of unmatched) {
    const file = filesLeft.shift();
    if (!file) break;
    match[images.indexOf(file)] = preview;
  }

  for (let i = 0; i < images.length; i++) {
    const file = images[i];
    const wantPos = i + 1;
    if (!match[i]) {
      const form = new FormData();
      form.set("image", new Blob([fs.readFileSync(path.join(shotsDir, file))], { type: "image/png" }), file);
      const created = await amo("POST", `/addons/addon/${slug}/previews/`, { form });
      match[i] = created;
      console.log(`Screenshot ${wantPos}: ${file} uploaded`);
    } else if (match[i].caption?.["en-US"] === captions[file] && match[i].position === wantPos) {
      continue; // already correct
    }
    await amo("PATCH", `/addons/addon/${slug}/previews/${match[i].id}/`, {
      json: { caption: { "en-US": captions[file] }, position: wantPos },
    });
    console.log(`Screenshot ${wantPos}: ${file} captioned (id ${match[i].id})`);
    await new Promise((r) => setTimeout(r, 30000));
  }
}
