// `execute`: run a Playwright-style script against the session's page.
// The code runs in a separate node:vm realm without process/require/import/fs. Like upstream browse,
// this is not a security boundary: treat agent code as code running as you.

import vm from "node:vm";
import { Page, Locator } from "./browser.mjs";
import { BrowseError } from "./client.mjs";

function isExpression(code) {
  try {
    new vm.Script(`(async () => (${code}\n))`);
    return !/^\s*(const|let|var|if|for|while|return|throw|try)\b/.test(code);
  } catch {
    return false;
  }
}

export function createRunner(session) {
  const state = {};
  let page = null;

  function currentPage() {
    if (!page || (session.currentTabId != null && page.tabId != null && page.tabId !== session.currentTabId)) page = new Page(session, session.currentTabId);
    return page;
  }

  return async function run(code, { timeoutMs = 120_000 } = {}) {
    const logs = [];
    const fmt = (args) => args.map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" ");
    const consoleShim = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((level) => [level, (...args) => logs.push(`${level === "log" ? "" : `[${level}] `}${fmt(args)}`)]));
    const p = currentPage();
    const context = {
      pages: async () => (await session.tabs()).filter((t) => t.session === session.name).map((t) => new Page(session, t.tabId)),
      newPage: async () => {
        const t = await session.call("tabs.new", { url: "about:blank" });
        return new Page(session, t.tabId);
      },
      waitForEvent: (event, o) => p.waitForEvent(event === "page" ? "popup" : event, o),
    };
    const helpers = {
      page: p,
      context,
      state,
      snapshot: async (o = {}) => {
        const tabId = await p._tab();
        const snap = await session.snapshot(tabId, p.frameId, { maxChars: o.maxChars, interactiveOnly: o.interactiveOnly, root: o.root?.steps || o.root });
        const key = `${tabId}:${p.frameId}`;
        const before = session.snapshots.get(key);
        session.snapshots.set(key, snap.text);
        if (o.diff || o.delta) return (await import("./browser.mjs")).snapshotDiff(before, snap.text) ?? snap.text;
        if (o.find) {
          const re = Object.prototype.toString.call(o.find) === "[object RegExp]" ? new RegExp(o.find.source, o.find.flags) : new RegExp(String(o.find).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
          const lines = snap.text.split("\n");
          const ctx = o.context ?? 1;
          const keep = new Set();
          lines.forEach((l, i) => {
            if (re.test(l)) for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) keep.add(j);
          });
          return [...keep].sort((a, b) => a - b).map((i) => lines[i]).join("\n") || `No lines match ${re}`;
        }
        return snap.text;
      },
      ref: (id) => p.ref(id),
      handoff: async (message, o = {}) => {
        const tabId = await p._tab();
        const waiting = session.call("handoff", { tabId, message, timeoutMs: o.timeoutMs ?? 600_000 }, { timeoutMs: (o.timeoutMs ?? 600_000) + 10_000 });
        if (o.start) await o.start();
        const r = await waiting;
        if (!r.continued) throw new BrowseError(`Hand-off ended without the user continuing (${r.outcome})`, "handoff_" + r.outcome);
        return r;
      },
      secrets: {
        type: async (locator, name) => {
          const tabId = await p._tab();
          const target = locator instanceof Locator ? locator.steps : locator;
          return session.call("secret.type", { tabId, frameId: p.frameId, target, name });
        },
        list: () => session.call("secrets.list"),
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    const sandbox = vm.createContext({
      ...helpers,
      console: consoleShim,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      Buffer,
      structuredClone,
      atob,
      btoa,
      crypto: { randomUUID: () => crypto.randomUUID() },
      fetch: undefined,
      process: undefined,
      require: undefined,
    }, { codeGeneration: { strings: false, wasm: false } });
    const wrapped = isExpression(code) ? `"use strict"; (async () => (${code}\n))()` : `"use strict"; (async () => {\n${code}\n})()`;
    let script;
    try {
      script = new vm.Script(wrapped, { filename: "execute.js", importModuleDynamically: undefined });
    } catch (err) {
      throw new BrowseError(`Syntax error: ${err.message}`, "syntax_error");
    }
    let timer;
    const timeout = new Promise((_, reject) => (timer = setTimeout(() => reject(new BrowseError(`execute timed out after ${timeoutMs}ms`, "timeout")), timeoutMs)));
    try {
      const value = await Promise.race([script.runInContext(sandbox, { timeout: Number(process.env.BROWSE_FIREFOX_EXECUTE_SLICE_MS || 2000) }), timeout]);
      return { value, logs, url: p.url() };
    } catch (err) {
      err.logs = logs;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}
