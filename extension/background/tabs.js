// Which tabs agents may use, how they are tagged, grouped and cleaned up.
//
// A tab is usable by agents only when it is in `registry`:
//   kind "agent": a tab an agent session opened (or a popup one of its tabs opened)
//   kind "lent":  a tab you handed over with the toolbar button (session is set once an agent adopts it)
// Tags are stored with sessions.setTabValue, so they survive a Firefox restart with session restore.

import { settings, onSettingsChange } from "./settings.js";

const TAG = "browseFx";
export const registry = new Map(); // tabId -> { session, kind, lastUsed, busy, openerTabId, createdAt }
export const pins = new Map(); // tabId -> Set of reasons that keep it open ("handoff", "recording", "network")
const groups = new Map(); // key -> groupId
let agentWindowId = null;

const hasGroups = () => typeof browser.tabs.group === "function" && !!browser.tabGroups;

export async function restoreRegistry() {
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    try {
      const value = await browser.sessions.getTabValue(tab.id, TAG);
      if (value && value.kind) {
        registry.set(tab.id, { ...value, lastUsed: Date.now(), busy: 0, createdAt: Date.now() });
      }
    } catch {}
  }
  for (const tabId of registry.keys()) badge(tabId);
}

export async function tagTab(tabId, info) {
  const entry = { session: info.session ?? null, kind: info.kind, openerTabId: info.openerTabId ?? null, lastUsed: Date.now(), busy: 0, createdAt: Date.now() };
  registry.set(tabId, entry);
  await browser.sessions.setTabValue(tabId, TAG, { session: entry.session, kind: entry.kind }).catch(() => {});
  badge(tabId);
  return entry;
}

export async function untagTab(tabId) {
  registry.delete(tabId);
  pins.delete(tabId);
  await browser.sessions.removeTabValue(tabId, TAG).catch(() => {});
  badge(tabId);
}

export function touch(tabId) {
  const entry = registry.get(tabId);
  if (entry) entry.lastUsed = Date.now();
}

export function pin(tabId, reason, on) {
  let set = pins.get(tabId);
  if (!set) pins.set(tabId, (set = new Set()));
  if (on) set.add(reason);
  else set.delete(reason);
  badge(tabId);
}

export function isPinned(tabId, reason) {
  const set = pins.get(tabId);
  return reason ? !!set?.has(reason) : !!set?.size;
}

/** Look up a tab an agent session may use, or throw with a helpful message. */
export function requireTab(tabId, session) {
  const entry = registry.get(tabId);
  if (!entry) {
    const err = new Error(`Tab ${tabId} isn't available to agents. Use a tab you opened, or ask the user to click the browse toolbar button on it.`);
    err.code = "tab_not_available";
    throw err;
  }
  if (entry.kind === "agent" && session && entry.session && entry.session !== session) {
    const err = new Error(`Tab ${tabId} belongs to another agent session (${entry.session}).`);
    err.code = "tab_other_session";
    throw err;
  }
  if (entry.kind === "lent" && session && entry.session && entry.session !== session) {
    const err = new Error(`Tab ${tabId} was adopted by another agent session (${entry.session}).`);
    err.code = "tab_other_session";
    throw err;
  }
  return entry;
}

// ---------- badges ----------

export function badge(tabId) {
  const entry = registry.get(tabId);
  let text = "";
  let color = "#6d28d9";
  if (entry) {
    if (isPinned(tabId, "handoff")) [text, color] = ["WAIT", "#ea580c"];
    else if (isPinned(tabId, "recording")) [text, color] = ["REC", "#dc2626"];
    else if (entry.busy > 0) [text, color] = ["RUN", "#2563eb"];
    else if (entry.kind === "lent") [text, color] = ["ON", "#16a34a"];
  }
  browser.browserAction.setBadgeText({ tabId, text }).catch(() => {});
  browser.browserAction.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  const title = !entry
    ? "browse · Click to let agents use this tab"
    : isPinned(tabId, "handoff")
      ? "browse · An agent is waiting for you. Click to continue"
      : entry.kind === "lent"
        ? "browse · Agents can use this tab. Click to take it back"
        : "browse · Agent tab. Click to take it over";
  browser.browserAction.setTitle({ tabId, title }).catch(() => {});
}

export async function busy(tabId, delta) {
  const entry = registry.get(tabId);
  if (!entry) return;
  entry.busy = Math.max(0, entry.busy + delta);
  entry.lastUsed = Date.now();
  badge(tabId);
}

// ---------- where agent tabs open ----------

async function userWindow() {
  try {
    const win = await browser.windows.getLastFocused({ windowTypes: ["normal"] });
    if (win && !win.incognito && win.id !== agentWindowId) return win.id;
  } catch {}
  const all = await browser.windows.getAll({ windowTypes: ["normal"] });
  return all.find((w) => !w.incognito && w.id !== agentWindowId)?.id ?? all[0]?.id;
}

async function ensureAgentWindow(url) {
  if (agentWindowId != null) {
    try {
      await browser.windows.get(agentWindowId);
      return { windowId: agentWindowId, created: null };
    } catch {
      agentWindowId = null;
    }
  }
  const focusedBefore = await browser.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  const win = await browser.windows.create({ url, focused: false, width: 1280, height: 900 });
  agentWindowId = win.id;
  // Firefox may still focus a new window; give focus back to the user.
  if (focusedBefore?.id && focusedBefore.focused) browser.windows.update(focusedBefore.id, { focused: true }).catch(() => {});
  return { windowId: win.id, created: win.tabs?.[0] };
}

export async function openAgentTab(session, url = "about:blank") {
  let tab;
  if (settings.windowMode === "separate") {
    const { windowId, created } = await ensureAgentWindow(url);
    tab = created || (await browser.tabs.create({ windowId, url, active: false }));
  } else {
    const windowId = await userWindow();
    tab = await browser.tabs.create({ windowId, url, active: false });
  }
  await tagTab(tab.id, { session, kind: "agent" });
  await placeInGroup(tab.id, session).catch(() => {});
  return tab;
}

// ---------- tab groups (Firefox 139+) ----------

function groupKey(windowId, session) {
  return settings.grouping === "session" ? `${windowId}:${session}` : `${windowId}`;
}

async function liveGroup(groupId) {
  if (groupId == null) return null;
  try {
    return await browser.tabGroups.get(groupId);
  } catch {
    return null;
  }
}

export const groupDiagnostics = { lastError: null };

export async function placeInGroup(tabId, session) {
  try {
    await placeInGroupUnsafe(tabId, session);
    groupDiagnostics.lastError = null;
  } catch (err) {
    groupDiagnostics.lastError = String(err?.message || err);
    throw err;
  }
}

async function placeInGroupUnsafe(tabId, session) {
  if (!hasGroups() || settings.grouping === "none") return;
  const tab = await browser.tabs.get(tabId);
  if (tab.pinned) return;
  const key = groupKey(tab.windowId, session);
  const existing = await liveGroup(groups.get(key));
  let groupId;
  if (existing && existing.windowId === tab.windowId) {
    groupId = await browser.tabs.group({ tabIds: [tabId], groupId: existing.id });
  } else {
    groupId = await browser.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
    groups.set(key, groupId);
    await browser.tabGroups.update(groupId, { color: "purple", collapsed: !tab.active }).catch(() => {});
    if (settings.windowMode !== "separate") await browser.tabGroups.move(groupId, { index: 0 }).catch(() => {});
  }
  await refreshGroupTitles();
}

export async function refreshGroupTitles() {
  if (!hasGroups()) return;
  for (const [key, groupId] of groups) {
    const group = await liveGroup(groupId);
    if (!group) {
      groups.delete(key);
      continue;
    }
    const tabs = await browser.tabs.query({ groupId });
    const session = key.includes(":") ? key.split(":").slice(1).join(":") : null;
    const label = session ? `🤖 ${session.slice(0, 18)}` : "🤖 Agents";
    await browser.tabGroups.update(groupId, { title: `${label} · ${tabs.length}` }).catch(() => {});
  }
}

export async function expandGroupOf(tabId) {
  if (!hasGroups()) return;
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (tab && tab.groupId != null && tab.groupId !== -1) await browser.tabGroups.update(tab.groupId, { collapsed: false }).catch(() => {});
}

// Keep agent groups collapsed unless you are looking at one of their tabs.
browser.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (!hasGroups()) return;
  const active = await browser.tabs.get(tabId).catch(() => null);
  for (const groupId of new Set(groups.values())) {
    const group = await liveGroup(groupId);
    if (!group || group.windowId !== windowId) continue;
    const hasHandoff = (await browser.tabs.query({ groupId })).some((t) => isPinned(t.id, "handoff"));
    const shouldCollapse = !(active && active.groupId === groupId) && !hasHandoff;
    if (group.collapsed !== shouldCollapse) await browser.tabGroups.update(groupId, { collapsed: shouldCollapse }).catch(() => {});
  }
});

// Firefox resets per-tab badge and title when a tab navigates; put ours back.
browser.tabs.onUpdated.addListener((tabId, changed) => {
  if (registry.has(tabId) && (changed.url || changed.status)) badge(tabId);
});

browser.tabs.onRemoved.addListener((tabId, info) => {
  registry.delete(tabId);
  pins.delete(tabId);
  if (info.windowId === agentWindowId && info.isWindowClosing) agentWindowId = null;
  refreshGroupTitles().catch(() => {});
});

// ---------- popups join their opener's session ----------

browser.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
  const opener = registry.get(details.sourceTabId);
  if (!opener || !opener.session) return;
  await tagTab(details.tabId, { session: opener.session, kind: "agent", openerTabId: details.sourceTabId });
  // A popup must not steal your focus: if it became the active tab, give you your tab back.
  const popup = await browser.tabs.get(details.tabId).catch(() => null);
  if (popup?.active) {
    const [previous] = (await browser.tabs.query({ windowId: popup.windowId }))
      .filter((t) => t.id !== popup.id && !registry.has(t.id))
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    if (previous) await browser.tabs.update(previous.id, { active: true }).catch(() => {});
  }
  await placeInGroup(details.tabId, opener.session).catch(() => {});
});

// ---------- idle cleanup ----------

export async function cleanupIdle({ olderThanMinutes, session } = {}) {
  // The setting's 0 means "never"; an explicit olderThanMinutes: 0 (agent's tabs_cleanup) means "all idle tabs".
  const minutes = olderThanMinutes ?? settings.idleMinutes;
  if (olderThanMinutes == null && !minutes) return [];
  const cutoff = Date.now() - minutes * 60_000;
  const closed = [];
  for (const [tabId, entry] of registry) {
    if (entry.kind !== "agent" || entry.busy > 0 || isPinned(tabId)) continue;
    if (session && entry.session !== session) continue;
    if (entry.lastUsed > cutoff) continue;
    await browser.tabs.remove(tabId).catch(() => {});
    closed.push(tabId);
  }
  return closed;
}

browser.alarms.create("browse-cleanup", { periodInMinutes: 1 });
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "browse-cleanup") cleanupIdle().catch(() => {});
});

onSettingsChange(() => refreshGroupTitles().catch(() => {}));

export async function describeTab(tabId) {
  const tab = await browser.tabs.get(tabId);
  const entry = registry.get(tabId) || {};
  return {
    tabId,
    url: tab.url,
    title: tab.title,
    status: tab.status,
    active: tab.active,
    windowId: tab.windowId,
    groupId: tab.groupId != null && tab.groupId !== -1 ? tab.groupId : undefined,
    kind: entry.kind ?? null,
    session: entry.session ?? null,
    openerTabId: entry.openerTabId ?? null,
    idleSeconds: entry.lastUsed ? Math.round((Date.now() - entry.lastUsed) / 1000) : null,
    pinnedBy: [...(pins.get(tabId) || [])],
    badge: (await browser.browserAction.getBadgeText({ tabId }).catch(() => "")) || undefined,
    toolbarTitle: await browser.browserAction.getTitle({ tabId }).catch(() => undefined),
  };
}

export async function listTabs(session) {
  const out = [];
  for (const [tabId, entry] of registry) {
    if (session && entry.kind === "agent" && entry.session !== session) continue;
    if (session && entry.kind === "lent" && entry.session && entry.session !== session) continue;
    const info = await describeTab(tabId).catch(() => null);
    if (info) out.push(info);
  }
  return out;
}
