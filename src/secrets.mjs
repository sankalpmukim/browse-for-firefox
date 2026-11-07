// Site secrets: passwords, API keys and TOTP seeds an agent can type without ever seeing them.
// Stored in a 0600 file in a 0700 folder; the value is only sent to the page agent of a frame whose
// origin matches the secret's origins, and is never returned to the agent.

import fs from "node:fs";
import crypto from "node:crypto";
import { SECRETS_FILE, DATA_DIR, ensurePrivateDir } from "./paths.mjs";

function load() {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(all) {
  ensurePrivateDir(DATA_DIR);
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.chmodSync(SECRETS_FILE, 0o600);
}

export function normalizeOrigin(o) {
  const s = String(o).trim();
  if (s.startsWith("*.")) return s.toLowerCase();
  try {
    return new URL(s.includes("://") ? s : `https://${s}`).origin;
  } catch {
    throw new Error(`Invalid origin ${o}`);
  }
}

export function addSecret(name, { origins, kind = "password", value }) {
  if (!/^[\w.-]{1,64}$/.test(name)) throw new Error("Secret names use letters, digits, dot, dash and underscore");
  if (!origins?.length) throw new Error("A secret needs at least one --origin");
  if (!value) throw new Error("Empty secret");
  if (kind === "totp") totp(value); // validate
  const all = load();
  all[name] = { origins: origins.map(normalizeOrigin), kind, value, createdAt: new Date().toISOString() };
  save(all);
  return { name, origins: all[name].origins, kind };
}

export function removeSecret(name) {
  const all = load();
  const existed = name in all;
  delete all[name];
  save(all);
  return existed;
}

export function listSecrets() {
  return Object.entries(load()).map(([name, s]) => ({ name, origins: s.origins, kind: s.kind, createdAt: s.createdAt }));
}

export function readSecret(name) {
  return load()[name] || null;
}

function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/[\s=-]/g, "").toUpperCase();
  let bits = "";
  for (const c of clean) {
    const v = alphabet.indexOf(c);
    if (v < 0) throw new Error("TOTP seed must be base32");
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(seed, { step = 30, digits = 6, now = Date.now() } = {}) {
  let key = seed;
  if (seed.startsWith("otpauth://")) key = new URL(seed).searchParams.get("secret") || "";
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / step)));
  const hmac = crypto.createHmac("sha1", base32Decode(key)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}
