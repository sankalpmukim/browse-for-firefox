// browse for Firefox — background page.
//
// Agents (MCP servers / the CLI) talk to a small local relay over a private Unix socket. The relay is a
// native-messaging host that Firefox itself starts for this extension, so there is no open port and no
// pairing step: Firefox only launches the host listed in the manifest it trusts, for this extension id.

import { loadSettings, settings, updateSettings, describeSettings } from "./settings.js";
import * as tabs from "./tabs.js";
import { loadPolicies, setAllowlist, getAllowlist, isAllowed, blockedLog } from "./policy.js";
import { navigate, waitForLoadState, sendToContent, evaluate, screenshot, listFrames, ensureInjected } from "./dom.js";
import { startHandoff, finishHandoff, pendingHandoff } from "./handoff.js";
import { startCapture, stopCapture, captureStatus, stopCapturesForSession } from "./network.js";
import { startRecording, stopRecording, recordingStatus } from "./recording.js";

const VERSION = browser.runtime.getManifest().version;
const FIREFOX = navigator.userAgent.match(/Firefox\/([\d.]+)/)?.[1] || "?";
const host = { connected: false, error: null, since: null, relay: null, lastRequestAt: null };
let port = null;
let backoff = 1000;
let reconnectTimer = null;

// ---------- console capture (opt-in; capturing lets a page notice it) ----------

const consoleBuffers = new Map(); // tabId -> entries
const consoleTabs = new Set();

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "console" && sender.tab && consoleTabs.has(sender.tab.id)) {
    const buf = consoleBuffers.get(sender.tab.id) || [];
    buf.push(...msg.entries);
    if (buf.length > 1000) buf.splice(0, buf.length - 1000);
    consoleBuffers.set(sender.tab.id, buf);
    return;
  }
  if (msg?.type === "browse-sleep") return new Promise((r) => setTimeout(() => r(true), Math.min(Number(msg.ms) || 0, 10_000)));
  if (msg?.type === "open-popup" && sender.tab) return openPopupFromPage(sender.tab, msg.url);
  if (msg?.type === "options.status") return optionsStatus();
  if (msg?.type === "options.reconnect") {
    connect(true);
    return Promise.resolve(true);
  }
  if (msg?.type === "options.settings") return updateSettings(msg.values);
  if (msg?.type === "options.release") return tabs.untagTab(msg.tabId).then(() => true);
});

browser.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId === 0 && consoleTabs.has(tabId)) {
    browser.tabs.executeScript(tabId, { file: "/content/agent.js", runAt: "document_start" })
      .then(() => sendToContent(tabId, 0, "console.start", {}, { inject: false }))
      .catch(() => {});
  }
});

async function openPopupFromPage(sourceTab, url) {
  const opener = tabs.registry.get(sourceTab.id);
  if (!opener) return;
  if (opener.session && !isAllowed(opener.session, url)) return { blocked: true };
  const tab = await browser.tabs.create({ url, active: false, openerTabId: sourceTab.id, windowId: sourceTab.windowId });
  await tabs.tagTab(tab.id, { session: opener.session, kind: "agent", openerTabId: sourceTab.id });
  await tabs.placeInGroup(tab.id, opener.session).catch(() => {});
  return { tabId: tab.id };
}

// A popup to a site outside the session's allowlist is closed.
browser.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  const opener = tabs.registry.get(d.sourceTabId);
  if (opener?.session && getAllowlist(opener.session) && !isAllowed(opener.session, d.url)) browser.tabs.remove(d.tabId).catch(() => {});
});

// ---------- toolbar button ----------

browser.browserAction.onClicked.addListener(async (tab) => {
  if (pendingHandoff(tab.id)) {
    finishHandoff(tab.id, "continued");
    return;
  }
  const entry = tabs.registry.get(tab.id);
  if (!entry) {
    await tabs.tagTab(tab.id, { session: null, kind: "lent" });
    return;
  }
  // Take the tab back: lent tabs return to you; agent tabs become yours and leave the agent group.
  await tabs.untagTab(tab.id);
  if (entry.kind === "agent" && tab.groupId != null && tab.groupId !== -1 && browser.tabs.ungroup) await browser.tabs.ungroup([tab.id]).catch(() => {});
  if (entry.kind === "lent") sendToContent(tab.id, 0, "handoff.hide", {}, { inject: false }).catch(() => {});
});

// ---------- methods the relay can call ----------

async function withTab(params, fn) {
  const tabId = Number(params.tabId);
  tabs.requireTab(tabId, params.session);
  await tabs.busy(tabId, +1);
  try {
    return await fn(tabId);
  } finally {
    await tabs.busy(tabId, -1);
  }
}

function checkAllowed(session, url) {
  if (url && session && !isAllowed(session, url)) {
    const e = new Error(`browse blocked navigation to ${url}: not in this session's allowlist (${getAllowlist(session).join(", ")}). Ask the user before widening it.`);
    e.code = "domain_not_allowed";
    throw e;
  }
}

const methods = {
  async status({ session }) {
    return {
      extension: VERSION,
      firefox: FIREFOX,
      settingsPage: browser.runtime.getURL("options/options.html"),
      tabGroups: typeof browser.tabs.group === "function",
      tabGroupError: tabs.groupDiagnostics.lastError || undefined,
      settings: { ...settings },
      tabs: await tabs.listTabs(session),
      lentTabs: (await tabs.listTabs()).filter((t) => t.kind === "lent"),
      allowlist: session ? getAllowlist(session) : undefined,
      recentlyBlocked: blockedLog.slice(-5),
    };
  },
  async "tabs.list"({ session, all }) {
    return all ? tabs.listTabs() : tabs.listTabs(session);
  },
  async "tabs.new"({ session, url, waitUntil, timeoutMs }) {
    checkAllowed(session, url);
    const tab = await tabs.openAgentTab(session, "about:blank");
    // Let the initial about:blank settle, or a navigation right after can abort it (and vice versa).
    await waitForLoadState(tab.id, { timeoutMs: 3000 }).catch(() => {});
    if (!url || url === "about:blank") return tabs.describeTab(tab.id);
    const nav = await navigate(tab.id, "goto", { url, waitUntil, timeoutMs });
    return { ...(await tabs.describeTab(tab.id)), navigation: nav.event, loadTimedOut: nav.timedOut || undefined };
  },
  async "tabs.close"(params) {
    const tabId = Number(params.tabId);
    const entry = tabs.requireTab(tabId, params.session);
    if (entry.kind === "lent") {
      await tabs.untagTab(tabId);
      return { released: tabId, note: "This tab belongs to the user, so it was handed back instead of closed." };
    }
    await browser.tabs.remove(tabId);
    return { closed: tabId };
  },
  async "tabs.adopt"({ session, tabId, targetUrl }) {
    const lent = (await tabs.listTabs()).filter((t) => t.kind === "lent" && (!t.session || t.session === session));
    let pick = tabId != null ? lent.find((t) => t.tabId === Number(tabId)) : targetUrl ? lent.find((t) => (t.url || "").includes(targetUrl)) : lent[0];
    if (!pick) {
      const e = new Error(lent.length ? `No lent tab matches. Lent tabs: ${lent.map((t) => `${t.tabId} ${t.url}`).join("; ")}` : "No tab has been lent. Ask the user to click the browse toolbar button on the tab they want you to use (the badge shows ON).");
      e.code = "no_lent_tab";
      throw e;
    }
    const entry = tabs.registry.get(pick.tabId);
    entry.session = session;
    await browser.sessions.setTabValue(pick.tabId, "browseFx", { session, kind: "lent" }).catch(() => {});
    return tabs.describeTab(pick.tabId);
  },
  async "tabs.cleanup"({ session, olderThanMinutes }) {
    return { closed: await tabs.cleanupIdle({ session, olderThanMinutes: olderThanMinutes ?? 10 }) };
  },
  async "session.end"({ session }) {
    stopCapturesForSession(session);
    const closed = [];
    const released = [];
    for (const [tabId, entry] of [...tabs.registry]) {
      if (entry.session !== session) continue;
      if (entry.kind === "agent") {
        await browser.tabs.remove(tabId).catch(() => {});
        closed.push(tabId);
      } else {
        entry.session = null;
        released.push(tabId);
      }
    }
    await setAllowlist(session, null);
    return { closed, released };
  },
  async "session.allowlist"({ session, allowedOrigins }) {
    return { allowlist: await setAllowlist(session, allowedOrigins) };
  },
  "tab.info": (p) => withTab(p, (tabId) => tabs.describeTab(tabId)),
  "tab.navigate": (p) =>
    withTab(p, async (tabId) => {
      if (p.action === "goto") checkAllowed(p.session, p.url);
      return navigate(tabId, p.action || "goto", p);
    }),
  "tab.waitForLoad": (p) => withTab(p, (tabId) => waitForLoadState(tabId, p)),
  "tab.frames": (p) => withTab(p, (tabId) => listFrames(tabId)),
  dom: (p) => withTab(p, (tabId) => sendToContent(tabId, p.frameId ?? 0, p.op, p.args || {})),
  evaluate: (p) => withTab(p, (tabId) => evaluate(tabId, p.frameId ?? 0, p)),
  screenshot: (p) =>
    withTab(p, async (tabId) => {
      if (!p.labels) return screenshot(tabId, p);
      const labels = await sendToContent(tabId, 0, "labels.show", {});
      try {
        return { ...(await screenshot(tabId, p)), labels };
      } finally {
        await sendToContent(tabId, 0, "labels.hide", {}).catch(() => {});
      }
    }),
  handoff: (p) => withTab(p, (tabId) => startHandoff({ tabId, message: p.message, timeoutMs: p.timeoutMs })),
  "handoff.cancel": (p) => withTab(p, async (tabId) => ({ cancelled: finishHandoff(tabId, "cancelled") })),
  async "network.start"(p) {
    for (const id of p.tabIds || []) tabs.requireTab(Number(id), p.session);
    return startCapture({ session: p.session, tabIds: (p.tabIds || []).map(Number), bodies: p.bodies, urlFilter: p.urlFilter });
  },
  async "network.status"(p) {
    return captureStatus(p.captureId);
  },
  async "network.stop"(p) {
    return stopCapture(p.captureId, { cancel: !!p.cancel });
  },
  "recording.start": (p) => withTab(p, (tabId) => startRecording({ tabId, fps: p.fps, maxSeconds: p.maxSeconds, scale: p.scale })),
  "recording.status": (p) => withTab(p, async (tabId) => recordingStatus(tabId)),
  "recording.stop": (p) => withTab(p, (tabId) => stopRecording(tabId, { cancel: !!p.cancel })),
  "console.start": (p) =>
    withTab(p, async (tabId) => {
      consoleTabs.add(tabId);
      consoleBuffers.set(tabId, consoleBuffers.get(tabId) || []);
      const r = await sendToContent(tabId, 0, "console.start", {});
      return { ...r, tabId, note: r?.note || "Pages can detect console capture; turn it off when done." };
    }),
  "console.read": (p) =>
    withTab(p, async (tabId) => {
      const entries = consoleBuffers.get(tabId) || [];
      const out = entries.slice(-(p.limit || 200));
      if (p.clear) consoleBuffers.set(tabId, []);
      return { capturing: consoleTabs.has(tabId), entries: out };
    }),
  "console.stop": (p) =>
    withTab(p, async (tabId) => {
      consoleTabs.delete(tabId);
      await sendToContent(tabId, 0, "console.stop", {}, { inject: false }).catch(() => {});
      return { capturing: false };
    }),
  async "extension.reload"() {
    // Re-reads the extension from disk (temporary/dev installs) and restarts the relay. Reply first.
    setTimeout(() => browser.runtime.reload(), 100);
    return { reloading: true, version: VERSION };
  },
  async "settings.get"() {
    return describeSettings();
  },
  async "settings.set"({ values }) {
    return updateSettings(values);
  },
};

async function handleRequest(msg) {
  host.lastRequestAt = Date.now();
  const fn = methods[msg.method];
  if (!fn) return { type: "response", id: msg.id, error: { message: `Unknown method ${msg.method}`, code: "unknown_method" } };
  try {
    const result = await fn(msg.params || {});
    return { type: "response", id: msg.id, result: result === undefined ? null : result };
  } catch (err) {
    return { type: "response", id: msg.id, error: { message: String(err?.message || err), code: err?.code || null, data: err?.data || null } };
  }
}

// ---------- native messaging ----------

function connect(force = false) {
  clearTimeout(reconnectTimer);
  if (port && !force) return;
  if (port) {
    try {
      port.disconnect();
    } catch {}
    port = null;
  }
  try {
    port = browser.runtime.connectNative("browse_firefox");
  } catch (err) {
    host.error = String(err?.message || err);
    scheduleReconnect();
    return;
  }
  const current = port;
  current.onMessage.addListener(async (msg) => {
    if (msg?.type === "hello-ack") {
      host.connected = true;
      host.error = msg.relayError || null;
      host.relay = msg;
      host.since = Date.now();
      backoff = 1000;
      return;
    }
    if (msg?.type === "relay-state") {
      host.relay = { ...(host.relay || {}), ...msg };
      host.error = msg.relayError || null;
      return;
    }
    if (msg?.type === "request") {
      const reply = await handleRequest(msg);
      try {
        current.postMessage(reply);
      } catch {}
    }
  });
  current.onDisconnect.addListener((p) => {
    if (port !== current) return;
    port = null;
    host.connected = false;
    host.error = p?.error?.message || "Native host disconnected";
    scheduleReconnect();
  });
  current.postMessage({ type: "hello", extension: VERSION, firefox: FIREFOX });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(), backoff);
  backoff = Math.min(backoff * 2, 30_000);
}

async function optionsStatus() {
  return {
    extension: VERSION,
    firefox: FIREFOX,
    host: { ...host },
    tabGroups: typeof browser.tabs.group === "function",
    ...describeSettings(),
    tabs: await tabs.listTabs(),
  };
}

(async () => {
  await loadSettings();
  await loadPolicies();
  await tabs.restoreRegistry();
  connect();
  // First run: show the setup page once.
  const { welcomed } = await browser.storage.local.get("welcomed");
  if (!welcomed) {
    await browser.storage.local.set({ welcomed: true });
    browser.runtime.openOptionsPage().catch(() => {});
  }
})();

// Re-export for debugging from about:debugging's console.
globalThis.browseFx = { tabs, methods, host, ensureInjected };
