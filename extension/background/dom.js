// Talking to pages. The page agent (content/agent.js) is injected only into tabs agents use, on demand,
// never into the pages you browse. It runs in Firefox's isolated content-script world (Xray vision),
// so nothing it does is visible to the page's own scripts.

import { settings } from "./settings.js";
import { isRecording } from "./recording.js";

const TRANSIENT = /Could not establish connection|Receiving end does not exist|Message manager disconnected|No matching message handler|can't access dead object|Actor .* destroyed|Promised response from onMessage listener went out of scope/i;

export function friendlyError(err, tabUrl) {
  const message = String(err?.message || err);
  if (/Missing host permission|Missing permission|cannot be scripted|about:|moz-extension|view-source/i.test(message) || /^(about|moz-extension|chrome|view-source|resource):/.test(tabUrl || "")) {
    const e = new Error(`Firefox doesn't let extensions script this page (${tabUrl || "privileged page"}). Navigate to a normal http(s) page first.`);
    e.code = "restricted_page";
    return e;
  }
  return err instanceof Error ? err : new Error(message);
}

export async function ensureInjected(tabId, frameId = 0) {
  try {
    const pong = await browser.tabs.sendMessage(tabId, { type: "ping" }, { frameId });
    if (pong === "pong") return;
  } catch {}
  await browser.tabs.executeScript(tabId, { file: "/content/agent.js", frameId, runAt: "document_end" });
}

export async function sendToContent(tabId, frameId, op, args = {}, { inject = true, attempts = 3 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      if (inject) await ensureInjected(tabId, frameId ?? 0);
      const reply = await browser.tabs.sendMessage(
        tabId,
        { type: "op", op, args: { ...args, cursor: settings.cursor && !isRecording(tabId), humanInput: settings.humanInput } },
        { frameId: frameId ?? 0 },
      );
      if (!reply) throw new Error("Could not establish connection: no reply");
      if (!reply.ok) {
        const e = new Error(reply.error);
        e.code = reply.code;
        e.data = reply.data;
        throw e;
      }
      return reply.result;
    } catch (err) {
      lastError = err;
      if (err.code || !TRANSIENT.test(String(err.message))) break;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
  const tab = await browser.tabs.get(tabId).catch(() => null);
  // A page that is still loading can't be scripted yet; callers retry transient errors.
  if (tab?.status === "loading" && !lastError?.code) {
    const e = new Error(`The page is still loading (${tab.url})`);
    e.code = "transient";
    throw e;
  }
  const e = friendlyError(lastError, tab?.url);
  if (!e.code && TRANSIENT.test(String(e.message))) e.code = "transient";
  throw e;
}

// ---------- navigation ----------

const NET_ERRORS = {
  2152398861: "connection refused (NS_ERROR_CONNECTION_REFUSED)",
  2152398878: "host not found (NS_ERROR_UNKNOWN_HOST)",
  2152398862: "connection timed out (NS_ERROR_NET_TIMEOUT)",
  2152398864: "offline (NS_ERROR_OFFLINE)",
  2152398868: "connection reset (NS_ERROR_NET_RESET)",
  2153390067: "certificate error",
  2152398850: "aborted (NS_BINDING_ABORTED)",
};

function describeNetError(error) {
  const code = Number(String(error).match(/\d{6,}/)?.[0]);
  return NET_ERRORS[code] || error;
}

export function waitForNavigation(tabId, { waitUntil = "load", timeoutMs = 30_000, ignoreBlank = false } = {}) {
  let cleanup;
  const promise = new Promise((resolve, reject) => {
    const done = (fn, value) => {
      cleanup();
      fn(value);
    };
    // A new tab's initial about:blank can finish loading after we start navigating it; that isn't our load.
    const ours = (d) => d.tabId === tabId && d.frameId === 0 && !(ignoreBlank && d.url === "about:blank");
    const onCommitted = (d) => ours(d) && waitUntil === "commit" && done(resolve, { event: "commit" });
    const onDom = (d) => ours(d) && waitUntil === "domcontentloaded" && done(resolve, { event: "domcontentloaded" });
    const onCompleted = (d) => ours(d) && done(resolve, { event: "load" });
    const onFragment = (d) => d.tabId === tabId && d.frameId === 0 && done(resolve, { event: "same-document" });
    let abortTimer = null;
    const onError = (d) => {
      if (d.tabId !== tabId || d.frameId !== 0) return;
      const aborted = /NS_BINDING_ABORTED|NS_ERROR_ABORT|2152398850/.test(d.error);
      const e = new Error(aborted ? `Navigation to ${d.url} was interrupted (another navigation replaced it, or the request was blocked)` : `Navigation failed: ${describeNetError(d.error)} (${d.url})`);
      e.code = aborted ? "navigation_aborted" : "navigation_failed";
      // An aborted load is usually superseded by another one (redirects, an initial about:blank): give it a moment.
      if (aborted) {
        clearTimeout(abortTimer);
        abortTimer = setTimeout(() => done(reject, e), 4000);
        return;
      }
      done(reject, e);
    };
    const timer = setTimeout(() => done(resolve, { event: "timeout", timedOut: true }), timeoutMs);
    browser.webNavigation.onCommitted.addListener(onCommitted);
    browser.webNavigation.onDOMContentLoaded.addListener(onDom);
    browser.webNavigation.onCompleted.addListener(onCompleted);
    browser.webNavigation.onReferenceFragmentUpdated.addListener(onFragment);
    browser.webNavigation.onHistoryStateUpdated.addListener(onFragment);
    browser.webNavigation.onErrorOccurred.addListener(onError);
    cleanup = () => {
      clearTimeout(timer);
      clearTimeout(abortTimer);
      browser.webNavigation.onCommitted.removeListener(onCommitted);
      browser.webNavigation.onDOMContentLoaded.removeListener(onDom);
      browser.webNavigation.onCompleted.removeListener(onCompleted);
      browser.webNavigation.onReferenceFragmentUpdated.removeListener(onFragment);
      browser.webNavigation.onHistoryStateUpdated.removeListener(onFragment);
      browser.webNavigation.onErrorOccurred.removeListener(onError);
    };
  });
  return { promise, cancel: () => cleanup?.() };
}

export async function navigate(tabId, action, { url, waitUntil, timeoutMs } = {}) {
  // A brand-new tab may still be loading its initial about:blank, which would swallow our navigation.
  const current = await browser.tabs.get(tabId);
  if (action === "goto" && current.status === "loading" && current.url === "about:blank") await waitForLoadState(tabId, { timeoutMs: 3000 }).catch(() => {});
  const wait = waitForNavigation(tabId, { waitUntil, timeoutMs, ignoreBlank: action === "goto" && url !== "about:blank" });
  try {
    if (action === "goto") await browser.tabs.update(tabId, { url });
    else if (action === "reload") await browser.tabs.reload(tabId);
    else if (action === "back") await browser.tabs.goBack(tabId);
    else if (action === "forward") await browser.tabs.goForward(tabId);
    else throw new Error(`Unknown navigation action ${action}`);
  } catch (err) {
    wait.cancel();
    throw err;
  }
  const outcome = await wait.promise;
  const tab = await browser.tabs.get(tabId);
  return { url: tab.url, title: tab.title, status: tab.status, ...outcome };
}

export async function waitForLoadState(tabId, { state = "load", timeoutMs = 30_000 } = {}) {
  const tab = await browser.tabs.get(tabId);
  if (tab.status === "complete") return { url: tab.url, title: tab.title, event: "already" };
  const wait = waitForNavigation(tabId, { waitUntil: state, timeoutMs });
  const again = await browser.tabs.get(tabId);
  if (again.status === "complete") {
    wait.cancel();
    return { url: again.url, title: again.title, event: "already" };
  }
  const outcome = await wait.promise;
  const after = await browser.tabs.get(tabId);
  return { url: after.url, title: after.title, ...outcome };
}

// ---------- script evaluation ----------

export async function evaluate(tabId, frameId, { expression, world = "isolated" }) {
  await ensureInjected(tabId, frameId ?? 0);
  if (world === "page") return sendToContent(tabId, frameId, "evalPage", { expression });
  const code = `(async () => {
    try { const __v = await (${expression}\n); return { ok: true, value: __browseFx.serialize(__v) }; }
    catch (e) { return { ok: false, error: String(e && e.message || e), stack: String(e && e.stack || "") }; }
  })()`;
  let results;
  try {
    results = await browser.tabs.executeScript(tabId, { code, frameId: frameId ?? 0 });
  } catch (err) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    throw friendlyError(err, tab?.url);
  }
  const r = results?.[0];
  if (!r) return undefined;
  if (!r.ok) {
    const e = new Error(r.error);
    e.code = "evaluate_error";
    e.data = { stack: r.stack };
    throw e;
  }
  return r.value;
}

// ---------- screenshots ----------

export async function screenshot(tabId, { fullPage = false, rect, scale = 1, format = "png", quality } = {}) {
  const options = { format, scale };
  if (format === "jpeg") options.quality = quality ?? 80;
  let metrics = null;
  if (fullPage || rect) metrics = await sendToContent(tabId, 0, "pageMetrics", {});
  if (fullPage) {
    options.rect = { x: 0, y: 0, width: metrics.scrollWidth, height: Math.min(metrics.scrollHeight, 16384) };
  } else if (rect) {
    options.rect = { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
  }
  const dataUrl = await browser.tabs.captureTab(tabId, options);
  return { dataUrl, clipped: fullPage && metrics.scrollHeight > 16384 ? `page is ${metrics.scrollHeight}px tall; captured the first 16384px` : undefined };
}

export async function listFrames(tabId) {
  const frames = (await browser.webNavigation.getAllFrames({ tabId })) || [];
  return frames.map((f) => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url }));
}
