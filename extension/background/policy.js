// Per-session domain allowlists. Firefox still has *blocking* webRequest, so the extension itself refuses
// top-level navigations that leave the list (links, redirects, form posts, script navigations, popups).

import { registry } from "./tabs.js";

const policies = new Map(); // session -> patterns[]

export async function loadPolicies() {
  const { policies: stored } = await browser.storage.local.get("policies");
  for (const [session, patterns] of Object.entries(stored || {})) policies.set(session, patterns);
}

async function save() {
  await browser.storage.local.set({ policies: Object.fromEntries(policies) });
}

export async function setAllowlist(session, patterns) {
  if (!patterns || !patterns.length) policies.delete(session);
  else policies.set(session, patterns.map((p) => String(p).trim()).filter(Boolean));
  await save();
  return policies.get(session) || null;
}

export function getAllowlist(session) {
  return policies.get(session) || null;
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$|\[?f[cd]|0\.0\.0\.0)/i;

export function matchesPattern(urlString, pattern) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  let scheme = null;
  let rest = pattern.toLowerCase();
  const m = rest.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/);
  if (m) [, scheme, rest] = m;
  rest = rest.replace(/\/.*$/, "");
  let hostPattern = rest;
  let port = null;
  const pm = rest.match(/^(.*):(\d+)$/);
  if (pm) [, hostPattern, port] = pm;
  if (scheme && url.protocol !== `${scheme}:`) return false;
  if (!scheme && !["http:", "https:"].includes(url.protocol)) return false;
  if (port && url.port !== port) return false;
  const host = url.hostname.toLowerCase();
  if (hostPattern.startsWith("*.")) {
    const base = hostPattern.slice(2);
    // Private/loopback hosts need an entry naming that exact host.
    if (PRIVATE_HOST.test(host)) return false;
    return host === base || host.endsWith(`.${base}`);
  }
  return host === hostPattern;
}

export function isAllowed(session, url) {
  const list = policies.get(session);
  if (!list) return true;
  if (url === "about:blank" || url.startsWith("about:blank#")) return true;
  return list.some((p) => matchesPattern(url, p));
}

export const blockedLog = [];

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return {};
    const entry = registry.get(details.tabId);
    if (!entry?.session) return {};
    if (isAllowed(entry.session, details.url)) return {};
    blockedLog.push({ at: Date.now(), tabId: details.tabId, session: entry.session, url: details.url, type: details.type });
    if (blockedLog.length > 50) blockedLog.shift();
    return { cancel: true };
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["blocking"],
);
