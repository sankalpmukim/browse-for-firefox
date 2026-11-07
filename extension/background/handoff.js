// Hand-offs: when only a person can continue (login, 2FA, CAPTCHA, payment), the agent waits here until
// you click Continue on the card in the page or on the toolbar button. Only a real (trusted) click counts.

import { registry, pin, expandGroupOf } from "./tabs.js";
import { settings } from "./settings.js";
import { isRecording } from "./recording.js";
import { sendToContent } from "./dom.js";

const pending = new Map(); // tabId -> { id, message, resolve, timer, startedAt }
let nextId = 1;

export function pendingHandoff(tabId) {
  return pending.get(tabId) || null;
}

async function showCard(tabId, h) {
  if (isRecording(tabId)) return; // recordings show only the page
  await sendToContent(tabId, 0, "handoff.show", { id: h.id, message: h.message }).catch(() => {});
}

export async function startHandoff({ tabId, message, timeoutMs = 600_000 }) {
  if (pending.has(tabId)) finishHandoff(tabId, "replaced");
  const id = `h${nextId++}`;
  const startedAt = Date.now();
  const tab = await browser.tabs.get(tabId);
  let origin = "";
  try {
    origin = new URL(tab.url).origin;
  } catch {}
  return new Promise((resolve) => {
    const h = { id, message, origin, resolve, startedAt, timer: setTimeout(() => finishHandoff(tabId, "timeout"), timeoutMs) };
    pending.set(tabId, h);
    pin(tabId, "handoff", true);
    expandGroupOf(tabId).catch(() => {});
    showCard(tabId, h);
    if (settings.handoffNotifications || isRecording(tabId)) {
      browser.notifications
        .create(`browse-handoff-${tabId}`, {
          type: "basic",
          iconUrl: browser.runtime.getURL("icons/icon.svg"),
          title: "An agent needs you",
          message: `${message}\n${origin} — click to open the tab, then press Continue.`,
        })
        .catch(() => {});
    }
  });
}

export function finishHandoff(tabId, outcome) {
  const h = pending.get(tabId);
  if (!h) return false;
  clearTimeout(h.timer);
  pending.delete(tabId);
  pin(tabId, "handoff", false);
  browser.notifications.clear(`browse-handoff-${tabId}`).catch(() => {});
  sendToContent(tabId, 0, "handoff.hide", {}, { inject: false }).catch(() => {});
  h.resolve({ outcome, continued: outcome === "continued", waitedMs: Date.now() - h.startedAt, origin: h.origin });
  return true;
}

// The card re-appears after the page navigates (a login flow usually does).
browser.webNavigation.onCompleted.addListener(({ tabId, frameId }) => {
  if (frameId !== 0) return;
  const h = pending.get(tabId);
  if (h) showCard(tabId, h);
});

browser.tabs.onRemoved.addListener((tabId) => finishHandoff(tabId, "tab_closed"));

browser.notifications.onClicked.addListener(async (notificationId) => {
  const m = notificationId.match(/^browse-handoff-(\d+)$/);
  if (!m) return;
  const tabId = Number(m[1]);
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  await browser.tabs.update(tabId, { active: true });
  await browser.windows.update(tab.windowId, { focused: true });
});

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "handoff-continue" || !sender.tab) return;
  const h = pending.get(sender.tab.id);
  if (h && h.id === msg.id && registry.has(sender.tab.id)) finishHandoff(sender.tab.id, "continued");
});
