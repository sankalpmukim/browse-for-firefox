// Network capture to HAR, using Firefox's webRequest. Unlike Chromium MV3, Firefox can read response
// bodies from an extension (webRequest.filterResponseData), so `bodies: true` captures them too.
// Credentials are redacted before anything leaves the browser.

import { registry, pin } from "./tabs.js";

const captures = new Map(); // captureId -> capture
let nextId = 1;

const SECRET_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|api-key)$/i;
const SECRET_PARAMS = /(token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|auth|session|sig|signature|code)$/i;
const TEXTUAL = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded|graphql|ld\+json)|image\/svg)/i;
const MAX_BODY = 512 * 1024;
const MAX_TOTAL_BODY = 24 * 1024 * 1024;

function redactUrl(url) {
  try {
    const u = new URL(url);
    let changed = false;
    for (const key of [...u.searchParams.keys()]) {
      if (SECRET_PARAMS.test(key)) {
        u.searchParams.set(key, "[redacted]");
        changed = true;
      }
    }
    if (u.password) {
      u.password = "redacted";
      changed = true;
    }
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}

const redactHeaders = (headers = []) =>
  headers.map((h) => ({ name: h.name, value: SECRET_HEADERS.test(h.name) ? "[redacted]" : (h.value ?? "") }));

// A capture follows the tabs it was started on (plus popups they open), or every tab of a session.
function inScope(capture, tabId) {
  if (tabId < 0) return false;
  const entry = registry.get(tabId);
  if (capture.tabIds) return capture.tabIds.has(tabId) || (entry?.openerTabId != null && capture.tabIds.has(entry.openerTabId));
  return !!capture.session && entry?.session === capture.session;
}

function activeCapturesFor(tabId) {
  const out = [];
  for (const c of captures.values()) if (c.state === "running" && inScope(c, tabId)) out.push(c);
  return out;
}

export function startCapture({ session, tabIds, bodies = false, urlFilter }) {
  const id = `net-${nextId++}`;
  const capture = {
    id,
    session,
    tabIds: tabIds?.length ? new Set(tabIds) : null,
    bodies: !!bodies,
    urlFilter: urlFilter ? new RegExp(urlFilter, "i") : null,
    state: "running",
    startedAt: Date.now(),
    entries: new Map(), // requestId -> entry
    order: [],
    bodyBytes: 0,
  };
  captures.set(id, capture);
  for (const tabId of capture.tabIds || []) pin(tabId, "network", true);
  return { captureId: id, bodies: capture.bodies, scope: capture.tabIds ? [...capture.tabIds] : `session ${session}` };
}

function entryFor(capture, details) {
  let entry = capture.entries.get(details.requestId);
  if (!entry) {
    if (capture.urlFilter && !capture.urlFilter.test(details.url)) return null;
    entry = {
      requestId: details.requestId,
      tabId: details.tabId,
      url: details.url,
      method: details.method,
      type: details.type,
      startedAt: details.timeStamp,
      requestHeaders: [],
      responseHeaders: [],
      status: 0,
      statusText: "",
      fromCache: false,
      ip: null,
      requestBody: null,
      responseBody: null,
      error: null,
      endedAt: null,
      size: 0,
    };
    capture.entries.set(details.requestId, entry);
    capture.order.push(details.requestId);
  }
  return entry;
}

function decodeRequestBody(body) {
  if (!body) return null;
  if (body.formData) {
    const params = [];
    for (const [name, values] of Object.entries(body.formData)) {
      for (const v of values) params.push({ name, value: SECRET_PARAMS.test(name) ? "[redacted]" : String(v) });
    }
    return { mimeType: "application/x-www-form-urlencoded", params };
  }
  if (body.raw?.length) {
    try {
      const bytes = body.raw.map((r) => (r.bytes ? new Uint8Array(r.bytes) : new Uint8Array())).reduce((acc, b) => {
        const out = new Uint8Array(acc.length + b.length);
        out.set(acc);
        out.set(b, acc.length);
        return out;
      }, new Uint8Array());
      const text = new TextDecoder().decode(bytes.slice(0, MAX_BODY));
      return { mimeType: "", text: text.replace(/("(?:password|passwd|token|secret|otp|code)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"') };
    } catch {
      return null;
    }
  }
  return null;
}

function attachBodyFilter(capture, entry, requestId) {
  if (capture.bodyBytes > MAX_TOTAL_BODY) return;
  let filter;
  try {
    filter = browser.webRequest.filterResponseData(requestId);
  } catch {
    return;
  }
  const chunks = [];
  let size = 0;
  filter.ondata = (event) => {
    filter.write(event.data);
    if (size < MAX_BODY) chunks.push(event.data);
    size += event.data.byteLength;
  };
  const finish = () => {
    try {
      filter.close();
    } catch {}
    entry._bodyChunks = chunks;
    entry._bodySize = size;
    capture.bodyBytes += Math.min(size, MAX_BODY);
  };
  filter.onstop = finish;
  filter.onerror = () => {
    try {
      filter.disconnect();
    } catch {}
  };
}

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    for (const capture of activeCapturesFor(details.tabId)) {
      const entry = entryFor(capture, details);
      if (!entry) continue;
      entry.requestBody = decodeRequestBody(details.requestBody);
      if (capture.bodies && details.type !== "media" && details.type !== "websocket") attachBodyFilter(capture, entry, details.requestId);
    }
    return {};
  },
  { urls: ["<all_urls>"] },
  ["blocking", "requestBody"],
);

browser.webRequest.onSendHeaders.addListener(
  (details) => {
    for (const capture of activeCapturesFor(details.tabId)) {
      const entry = capture.entries.get(details.requestId);
      if (entry) entry.requestHeaders = redactHeaders(details.requestHeaders);
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"],
);

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    for (const capture of activeCapturesFor(details.tabId)) {
      const entry = capture.entries.get(details.requestId);
      if (!entry) continue;
      entry.status = details.statusCode;
      entry.statusText = (details.statusLine || "").split(" ").slice(2).join(" ");
      entry.responseHeaders = redactHeaders(details.responseHeaders);
      entry.ip = details.ip || null;
      entry.fromCache = !!details.fromCache;
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

function finishEntry(details, error) {
  for (const capture of captures.values()) {
    if (capture.state !== "running") continue;
    const entry = capture.entries.get(details.requestId);
    if (!entry) continue;
    entry.endedAt = details.timeStamp;
    if (details.statusCode) entry.status = details.statusCode;
    if (details.ip) entry.ip = details.ip;
    entry.fromCache = entry.fromCache || !!details.fromCache;
    entry.size = details.responseSize ?? details.transferSize ?? 0;
    if (error) entry.error = error;
  }
}

browser.webRequest.onCompleted.addListener((d) => finishEntry(d), { urls: ["<all_urls>"] }, ["responseHeaders"]);
browser.webRequest.onErrorOccurred.addListener((d) => finishEntry(d, d.error), { urls: ["<all_urls>"] });

function headerValue(headers, name) {
  return headers.find((h) => h.name.toLowerCase() === name)?.value || "";
}

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function buildContent(entry) {
  const mimeType = headerValue(entry.responseHeaders, "content-type") || "";
  const content = { size: entry._bodySize ?? entry.size ?? 0, mimeType };
  if (entry._bodyChunks?.length) {
    const total = entry._bodyChunks.reduce((n, c) => n + c.byteLength, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of entry._bodyChunks) {
      bytes.set(new Uint8Array(c), offset);
      offset += c.byteLength;
    }
    const clipped = bytes.subarray(0, MAX_BODY);
    if (TEXTUAL.test(mimeType)) {
      content.text = new TextDecoder().decode(clipped);
    } else if (/^image\//i.test(mimeType) && clipped.length < 128 * 1024) {
      content.text = toBase64(clipped);
      content.encoding = "base64";
    } else {
      content.comment = "binary body not stored";
    }
    if (entry._bodySize > MAX_BODY) content.comment = `body truncated to ${MAX_BODY} of ${entry._bodySize} bytes`;
  }
  return content;
}

function toHar(capture) {
  const entries = capture.order.map((id) => capture.entries.get(id)).filter(Boolean);
  const version = browser.runtime.getManifest().version;
  return {
    log: {
      version: "1.2",
      creator: { name: "browse for Firefox", version },
      browser: { name: "Firefox", version: navigator.userAgent.match(/Firefox\/([\d.]+)/)?.[1] || "" },
      pages: [],
      entries: entries.map((e) => {
        const url = redactUrl(e.url);
        let queryString = [];
        try {
          queryString = [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
        } catch {}
        const time = e.endedAt ? Math.max(0, e.endedAt - e.startedAt) : -1;
        return {
          startedDateTime: new Date(e.startedAt).toISOString(),
          time,
          _tabId: e.tabId,
          _resourceType: e.type,
          _error: e.error || undefined,
          request: {
            method: e.method,
            url,
            httpVersion: "",
            headers: e.requestHeaders,
            queryString,
            cookies: [],
            headersSize: -1,
            bodySize: -1,
            postData: e.requestBody ? { mimeType: e.requestBody.mimeType || headerValue(e.requestHeaders, "content-type"), ...e.requestBody } : undefined,
          },
          response: {
            status: e.status,
            statusText: e.statusText,
            httpVersion: "",
            headers: e.responseHeaders,
            cookies: [],
            content: buildContent(e),
            redirectURL: headerValue(e.responseHeaders, "location"),
            headersSize: -1,
            bodySize: e.size || -1,
          },
          cache: {},
          timings: { send: 0, wait: time, receive: 0 },
          serverIPAddress: e.ip || undefined,
        };
      }),
    },
  };
}

function summarize(capture) {
  const entries = capture.order.map((id) => capture.entries.get(id)).filter(Boolean);
  const failed = entries.filter((e) => e.error || e.status >= 400);
  const hosts = {};
  for (const e of entries) {
    try {
      const h = new URL(e.url).host;
      hosts[h] = (hosts[h] || 0) + 1;
    } catch {}
  }
  return {
    captureId: capture.id,
    state: capture.state,
    requests: entries.length,
    failed: failed.length,
    durationMs: Date.now() - capture.startedAt,
    topHosts: Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 8),
    recent: entries.slice(-25).map((e) => `${e.method} ${e.error ? "ERR " + e.error : e.status} ${e.type} ${redactUrl(e.url).slice(0, 160)}`),
    failures: failed.slice(0, 15).map((e) => `${e.method} ${e.error || e.status} ${redactUrl(e.url).slice(0, 160)}`),
  };
}

export function captureStatus(captureId) {
  if (captureId) {
    const c = captures.get(captureId);
    if (!c) throw new Error(`No network capture ${captureId}`);
    return summarize(c);
  }
  return [...captures.values()].map(summarize);
}

export async function stopCapture(captureId, { cancel = false } = {}) {
  const capture = captures.get(captureId);
  if (!capture) throw new Error(`No network capture ${captureId}`);
  // Give in-flight body filters a moment to finish.
  await new Promise((r) => setTimeout(r, 300));
  capture.state = cancel ? "cancelled" : "stopped";
  captures.delete(captureId);
  for (const tabId of capture.tabIds || []) pin(tabId, "network", false);
  const summary = summarize(capture);
  if (cancel) return summary;
  return { ...summary, har: toHar(capture) };
}

export function stopCapturesForSession(session) {
  for (const c of captures.values()) if (c.session === session) c.state = "cancelled";
}
