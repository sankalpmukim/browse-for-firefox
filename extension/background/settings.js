// User settings, kept in storage.local and editable from the options page or by agents (`settings` tool).

export const DEFAULTS = Object.freeze({
  // Where agent tabs open: "current" (background tabs in your last-used window) or "separate" (their own window).
  windowMode: "current",
  // "shared": one "Agents" group per window. "session": one group per agent session. "none": no grouping.
  grouping: "shared",
  // Close agent tabs nobody touched for this many minutes. 0 = never.
  idleMinutes: 10,
  // Show a ghost cursor where agents click (pages can detect it while shown).
  cursor: false,
  // Human-like pacing for typing and scrolling. Off = full speed.
  humanInput: true,
  // System notification when an agent hands a tab to you.
  handoffNotifications: true,
});

const ALLOWED = {
  windowMode: ["current", "separate"],
  grouping: ["shared", "session", "none"],
  idleMinutes: [0, 10, 30, 60],
  cursor: [true, false],
  humanInput: [true, false],
  handoffNotifications: [true, false],
};

export const settings = { ...DEFAULTS };
const listeners = new Set();

export async function loadSettings() {
  const { settings: stored } = await browser.storage.local.get("settings");
  Object.assign(settings, DEFAULTS, sanitize(stored || {}));
  return settings;
}

function sanitize(values) {
  const out = {};
  for (const [key, raw] of Object.entries(values || {})) {
    if (!(key in ALLOWED)) continue;
    let value = raw;
    if (key === "idleMinutes") value = Number(raw);
    if (typeof DEFAULTS[key] === "boolean" && typeof raw === "string") value = raw === "true" || raw === "on" || raw === "1";
    if (ALLOWED[key].includes(value)) out[key] = value;
  }
  return out;
}

export async function updateSettings(values) {
  const clean = sanitize(values);
  const rejected = Object.keys(values || {}).filter((k) => !(k in clean));
  Object.assign(settings, clean);
  await browser.storage.local.set({ settings: { ...settings } });
  for (const fn of listeners) fn(settings);
  return { settings: { ...settings }, rejected, allowed: ALLOWED };
}

export function onSettingsChange(fn) {
  listeners.add(fn);
}

export function describeSettings() {
  return { settings: { ...settings }, allowed: ALLOWED };
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  Object.assign(settings, DEFAULTS, sanitize(changes.settings.newValue || {}));
  for (const fn of listeners) fn(settings);
});
