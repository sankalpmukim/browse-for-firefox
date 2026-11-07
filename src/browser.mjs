// A Playwright-flavoured driver over the extension: Session -> Page -> Locator.
// Used by the MCP tools and by `execute`, so agents that know Playwright feel at home.

import fs from "node:fs";
import { rpc, BrowseError } from "./client.mjs";

const RETRYABLE = new Set(["not_found", "not_visible", "disabled", "intercepted", "transient"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Values created inside the execute realm fail `instanceof` against this realm's classes.
export const isRegExp = (v) => Object.prototype.toString.call(v) === "[object RegExp]";

function matchSpec(v, exact) {
  if (isRegExp(v)) return { regex: v.source, flags: v.flags.replace("g", "") };
  return { text: String(v), exact: !!exact };
}

export function snapshotDiff(before, after, maxLines = 60) {
  if (!before) return null;
  // The viewport line changes with every scroll; it isn't a page change.
  const a = before.split("\n").filter((l) => !l.startsWith("Viewport: "));
  const b = after.split("\n").filter((l) => !l.startsWith("Viewport: "));
  // Trim common prefix/suffix, LCS on the middle (bounded).
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);
  const out = [];
  if (midA.length * midB.length <= 4_000_000) {
    const n = midA.length;
    const m = midB.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        i++;
        j++;
      } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) out.push(`+ ${midB[j++]}`);
      else out.push(`- ${midA[i++]}`);
    }
  } else {
    const setA = new Set(midA);
    const setB = new Set(midB);
    for (const l of midA) if (!setB.has(l)) out.push(`- ${l}`);
    for (const l of midB) if (!setA.has(l)) out.push(`+ ${l}`);
  }
  if (!out.length) return "No changes.";
  return out.length > maxLines ? `${out.slice(0, maxLines).join("\n")}\n… ${out.length - maxLines} more changed lines (take a full snapshot)` : out.join("\n");
}

const CHALLENGE_PROBE = `(() => {
  const t = document.title || "";
  const text = (document.body && document.body.innerText || "").slice(0, 3000);
  const frames = [...document.querySelectorAll("iframe")].map(f => f.src || "");
  const has = (re) => frames.some(s => re.test(s)) || !!document.querySelector('[class*="' + re.source + '"]');
  let kind = null, recommendation = null;
  if (/just a moment|checking your browser|un instant/i.test(t) || document.querySelector("#challenge-running,#cf-challenge-running")) { kind = "cloudflare"; recommendation = "wait"; }
  if (frames.some(s => /challenges\\.cloudflare\\.com/.test(s)) || document.querySelector(".cf-turnstile")) { kind = "cloudflare-turnstile"; recommendation = "handoff"; }
  if (frames.some(s => /recaptcha|hcaptcha\\.com|arkoselabs|funcaptcha/.test(s)) || document.querySelector(".g-recaptcha,.h-captcha")) { kind = kind || "captcha"; recommendation = "handoff"; }
  if (frames.some(s => /captcha-delivery\\.com/.test(s))) { kind = "datadome"; recommendation = "handoff"; }
  if (document.querySelector("#px-captcha")) { kind = "perimeterx"; recommendation = "handoff"; }
  if (/attention required|access denied|request blocked|you have been blocked|forbidden/i.test(t) || /you have been blocked|access to this page has been denied|request unsuccessful\\. incapsula/i.test(text)) { kind = kind || "block"; recommendation = recommendation || "stop"; }
  if (/are you a robot|verify you are (a )?human|press (&|and) hold/i.test(text) && !kind) { kind = "bot-check"; recommendation = "handoff"; }
  return kind ? { kind, recommendation, title: t, url: location.href } : null;
})()`;

export class Session {
  constructor(name) {
    this.name = name;
    this.currentTabId = null;
    this.snapshots = new Map(); // tabId:frameId -> last snapshot text
    this.allowlist = null;
  }

  call(method, params = {}, opts) {
    return rpc(method, { session: this.name, ...params }, opts);
  }

  async tabs() {
    return this.call("tabs.list");
  }

  async resolveTab(tabId, { create = true } = {}) {
    if (tabId != null) {
      this.currentTabId = Number(tabId);
      return this.currentTabId;
    }
    if (this.currentTabId != null) {
      try {
        await this.call("tab.info", { tabId: this.currentTabId });
        return this.currentTabId;
      } catch {
        this.currentTabId = null;
      }
    }
    const mine = (await this.tabs()).filter((t) => t.session === this.name);
    if (mine.length) {
      this.currentTabId = mine.sort((a, b) => a.idleSeconds - b.idleSeconds)[0].tabId;
      return this.currentTabId;
    }
    if (!create) throw new BrowseError("This session has no tab yet. Navigate somewhere first.", "no_tab");
    const tab = await this.call("tabs.new", { url: "about:blank" });
    this.currentTabId = tab.tabId;
    return tab.tabId;
  }

  page(tabId) {
    return new Page(this, tabId ?? null);
  }

  async snapshot(tabId, frameId = 0, options = {}) {
    let snap;
    for (let attempt = 0; ; attempt++) {
      try {
        snap = await this.call("dom", { tabId, frameId, op: "snapshot", args: options });
        break;
      } catch (err) {
        // A page that is still loading can't be read yet: wait for it rather than failing.
        if (err.code !== "transient" || attempt >= 20) throw err;
        await this.call("tab.waitForLoad", { tabId, state: "domcontentloaded", timeoutMs: 10_000 }).catch(() => sleep(500));
      }
    }
    let text = snap.text;
    if (frameId === 0) {
      const frames = await this.call("tab.frames", { tabId }).catch(() => []);
      const sub = frames.filter((f) => f.frameId !== 0 && /^https?:/.test(f.url));
      if (sub.length) text += `\n\nFrames (pass frameId to snapshot/act inside one):\n${sub.slice(0, 15).map((f) => `- frameId=${f.frameId} ${f.url.slice(0, 120)}`).join("\n")}`;
    }
    return { ...snap, text };
  }

  async challenge(tabId) {
    try {
      let found = await this.call("evaluate", { tabId, expression: CHALLENGE_PROBE });
      if (found?.recommendation === "wait") {
        const deadline = Date.now() + Number(process.env.BROWSE_FIREFOX_CHALLENGE_WAIT_MS ?? 15000);
        while (found?.recommendation === "wait" && Date.now() < deadline) {
          await sleep(1000);
          found = await this.call("evaluate", { tabId, expression: CHALLENGE_PROBE }).catch(() => found);
        }
        if (!found) return { kind: "cloudflare", cleared: true };
      }
      return found;
    } catch {
      return null;
    }
  }
}

export class Page {
  constructor(session, tabId) {
    this.session = session;
    this.tabId = tabId;
    this.frameId = 0;
    this._url = "about:blank";
    this.keyboard = {
      press: (key) => this._act("press", { key }),
      type: (text, o = {}) => this._act("type", { text, delay: o.delay }),
      insertText: (text) => this._act("type", { text, delay: 0 }),
    };
    this.mouse = {
      click: (x, y, o = {}) => this._act("mouseClick", { x, y, ...o }),
      wheel: (dx, dy) => this._act("scroll", { dx, dy }),
    };
  }

  async _tab() {
    if (this.tabId == null) this.tabId = await this.session.resolveTab(null);
    return this.tabId;
  }

  async _call(method, params, opts) {
    const tabId = await this._tab();
    return this.session.call(method, { tabId, ...params }, opts);
  }

  async _act(op, args, { timeout = 10_000, frameId } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        const result = await this._call("dom", { frameId: frameId ?? this.frameId, op, args });
        if (["click", "press", "fill", "selectOption", "setChecked", "type", "mouseClick", "submit"].includes(op)) await this._settle();
        return result;
      } catch (err) {
        if (RETRYABLE.has(err.code) && Date.now() < deadline) {
          await sleep(err.code === "transient" ? 300 : 150);
          continue;
        }
        if (RETRYABLE.has(err.code)) err.message = `${err.message} (after waiting ${timeout}ms)`;
        throw err;
      }
    }
  }

  /** After an action: if it started a navigation, wait for the new page to be usable. */
  async _settle() {
    await sleep(120);
    const info = await this._call("tab.info").catch(() => null);
    if (info) this._url = info.url;
    if (info?.status === "loading") {
      const after = await this._call("tab.waitForLoad", { state: "domcontentloaded", timeoutMs: 15_000 }).catch(() => null);
      if (after?.url) this._url = after.url;
    }
  }

  async _refresh() {
    const info = await this._call("tab.info");
    this._url = info.url;
    return info;
  }

  url() {
    return this._url;
  }
  async title() {
    return (await this._refresh()).title;
  }
  async goto(url, { waitUntil = "load", timeout = 30_000 } = {}) {
    const r = await this._call("tab.navigate", { action: "goto", url, waitUntil, timeoutMs: timeout }, { timeoutMs: timeout + 5000 });
    this._url = r.url;
    return r;
  }
  async reload(o = {}) {
    const r = await this._call("tab.navigate", { action: "reload", waitUntil: o.waitUntil, timeoutMs: o.timeout });
    this._url = r.url;
    return r;
  }
  async goBack(o = {}) {
    const r = await this._call("tab.navigate", { action: "back", waitUntil: o.waitUntil, timeoutMs: o.timeout ?? 15_000 });
    this._url = r.url;
    return r;
  }
  async goForward(o = {}) {
    const r = await this._call("tab.navigate", { action: "forward", waitUntil: o.waitUntil, timeoutMs: o.timeout ?? 15_000 });
    this._url = r.url;
    return r;
  }
  async waitForLoadState(state = "load", { timeout = 30_000 } = {}) {
    const r = await this._call("tab.waitForLoad", { state, timeoutMs: timeout }, { timeoutMs: timeout + 5000 });
    this._url = r.url;
    return r;
  }
  async waitForURL(pattern, { timeout = 30_000 } = {}) {
    const test = typeof pattern === "function" ? (u) => pattern(new URL(u)) : isRegExp(pattern) ? (u) => pattern.test(u) : (u) => u === pattern || globMatch(pattern, u);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const info = await this._refresh().catch(() => null);
      if (info && test(info.url) && info.status === "complete") return;
      await sleep(200);
    }
    throw new BrowseError(`waitForURL timed out after ${timeout}ms; still at ${this._url}`, "timeout");
  }
  async waitForTimeout(ms) {
    await sleep(ms);
  }
  async waitForSelector(selector, o = {}) {
    return this.locator(selector).waitFor({ state: o.state || "visible", timeout: o.timeout });
  }
  async waitForFunction(fn, arg, { timeout = 30_000, polling = 200 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const v = await this.evaluate(fn, arg).catch(() => null);
      if (v) return v;
      await sleep(polling);
    }
    throw new BrowseError(`waitForFunction timed out after ${timeout}ms`, "timeout");
  }
  async waitForEvent(event, { timeout = 30_000 } = {}) {
    if (event !== "popup") throw new BrowseError(`waitForEvent("${event}") isn't supported in Firefox; only "popup".`, "unsupported");
    const tabId = await this._tab();
    const before = new Set((await this.session.tabs()).map((t) => t.tabId));
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const popup = (await this.session.tabs()).find((t) => !before.has(t.tabId) && t.openerTabId === tabId);
      if (popup) return new Page(this.session, popup.tabId);
      await sleep(200);
    }
    throw new BrowseError(`No popup opened within ${timeout}ms`, "timeout");
  }
  async evaluate(fn, arg, world) {
    const expression = typeof fn === "function" ? `(${fn.toString()})(${JSON.stringify(arg ?? null)})` : String(fn);
    return this._call("evaluate", { expression, frameId: this.frameId, world: world === false || world === "page" ? "page" : "isolated" });
  }
  async content() {
    return this.evaluate("document.documentElement.outerHTML");
  }
  async screenshot({ path, fullPage = false, type = "png", quality, scale = 1, clip } = {}) {
    const r = await this._call("screenshot", { fullPage, format: type === "jpeg" ? "jpeg" : "png", quality, scale, rect: clip });
    const buf = Buffer.from(r.dataUrl.split(",")[1], "base64");
    buf.__browseImage = type === "jpeg" ? "image/jpeg" : "image/png";
    if (path) fs.writeFileSync(path, buf);
    return buf;
  }
  async close() {
    const tabId = await this._tab();
    return this.session.call("tabs.close", { tabId });
  }
  async bringToFront() {
    throw new BrowseError("bringToFront is refused: agents don't switch the user's tabs. Use handoff() when the user needs to act.", "refused");
  }
  /** Frames in this tab (iframes included), each usable like a page: (await page.frames())[1].getByRole(...).click() */
  async frames() {
    const list = await this._call("tab.frames");
    return list.map((f) => Object.assign(this.frame(f.frameId), { frameUrl: f.url }));
  }
  frame(frameId) {
    const p = new Page(this.session, this.tabId);
    p.frameId = frameId;
    return p;
  }

  // Locator factories
  locator(selector, options) {
    return new Locator(this, [selector]).withOptions(options);
  }
  getByRole(role, o = {}) {
    const step = { kind: "role", role };
    if (o.name != null) step.name = matchSpec(o.name, o.exact);
    for (const k of ["checked", "disabled", "expanded", "selected", "pressed", "level", "includeHidden"]) if (o[k] != null) step[k] = o[k];
    return new Locator(this, [step]);
  }
  getByText(text, o = {}) {
    return new Locator(this, [{ kind: "text", match: matchSpec(text, o.exact) }]);
  }
  getByLabel(text, o = {}) {
    return new Locator(this, [{ kind: "label", match: matchSpec(text, o.exact) }]);
  }
  getByPlaceholder(text, o = {}) {
    return new Locator(this, [{ kind: "placeholder", match: matchSpec(text, o.exact) }]);
  }
  getByAltText(text, o = {}) {
    return new Locator(this, [{ kind: "alt", match: matchSpec(text, o.exact) }]);
  }
  getByTitle(text, o = {}) {
    return new Locator(this, [{ kind: "title", match: matchSpec(text, o.exact) }]);
  }
  getByTestId(id) {
    return new Locator(this, [{ kind: "testid", match: matchSpec(id, true) }]);
  }
  ref(id) {
    return new Locator(this, [{ kind: "ref", value: id }]);
  }

  // Shortcuts (selector first, like Playwright)
  click(sel, o) {
    return this.locator(sel).click(o);
  }
  dblclick(sel, o) {
    return this.locator(sel).dblclick(o);
  }
  fill(sel, v, o) {
    return this.locator(sel).fill(v, o);
  }
  type(sel, t, o) {
    return this.locator(sel).pressSequentially(t, o);
  }
  press(sel, k, o) {
    return this.locator(sel).press(k, o);
  }
  hover(sel, o) {
    return this.locator(sel).hover(o);
  }
  check(sel, o) {
    return this.locator(sel).check(o);
  }
  uncheck(sel, o) {
    return this.locator(sel).uncheck(o);
  }
  selectOption(sel, v, o) {
    return this.locator(sel).selectOption(v, o);
  }
  focus(sel) {
    return this.locator(sel).focus();
  }
  textContent(sel) {
    return this.locator(sel).textContent();
  }
  innerText(sel) {
    return this.locator(sel).innerText();
  }
  inputValue(sel) {
    return this.locator(sel).inputValue();
  }
  getAttribute(sel, name) {
    return this.locator(sel).getAttribute(name);
  }
  isVisible(sel) {
    return this.locator(sel).isVisible();
  }
  $$eval() {
    throw new BrowseError("Use page.evaluate(() => [...document.querySelectorAll(sel)].map(...)) instead of $$eval.", "unsupported");
  }
}

function globMatch(glob, url) {
  if (!/[*?]/.test(glob)) return url.includes(glob);
  const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, ".")}$`);
  return re.test(url);
}

export class Locator {
  constructor(page, steps) {
    this.page = page;
    this.steps = steps;
  }
  withOptions(o) {
    if (!o) return this;
    let l = this;
    if (o.hasText != null) l = l.filter({ hasText: o.hasText });
    if (o.hasNotText != null) l = l.filter({ hasNotText: o.hasNotText });
    if (o.has) l = l.filter({ has: o.has });
    return l;
  }
  _child(step) {
    return new Locator(this.page, [...this.steps, step]);
  }
  toJSON() {
    return this.steps;
  }
  toString() {
    return `locator(${JSON.stringify(this.steps)})`;
  }
  locator(selector, o) {
    return (selector instanceof Locator ? new Locator(this.page, [...this.steps, ...selector.steps]) : this._child(selector)).withOptions(o);
  }
  getByRole(role, o) {
    return new Locator(this.page, [...this.steps, ...this.page.getByRole(role, o).steps]);
  }
  getByText(t, o) {
    return new Locator(this.page, [...this.steps, ...this.page.getByText(t, o).steps]);
  }
  getByLabel(t, o) {
    return new Locator(this.page, [...this.steps, ...this.page.getByLabel(t, o).steps]);
  }
  getByPlaceholder(t, o) {
    return new Locator(this.page, [...this.steps, ...this.page.getByPlaceholder(t, o).steps]);
  }
  getByTestId(t) {
    return new Locator(this.page, [...this.steps, ...this.page.getByTestId(t).steps]);
  }
  first() {
    return this._child({ kind: "nth", index: 0 });
  }
  last() {
    return this._child({ kind: "nth", index: -1 });
  }
  nth(i) {
    return this._child({ kind: "nth", index: i });
  }
  filter(o = {}) {
    const step = { kind: "filter" };
    if (o.hasText != null) step.hasText = matchSpec(o.hasText, false);
    if (o.hasNotText != null) step.hasNotText = matchSpec(o.hasNotText, false);
    if (o.has) step.has = o.has.steps;
    if (o.hasNot) step.hasNot = o.hasNot.steps;
    if (o.visible != null) step.visible = o.visible;
    return this._child(step);
  }
  _act(op, args = {}, o = {}) {
    return this.page._act(op, { target: this.steps, ...args }, { timeout: o.timeout ?? 10_000 });
  }
  _query(what, args = {}) {
    return this.page._call("dom", { frameId: this.page.frameId, op: "query", args: { target: this.steps, what, ...args } });
  }
  async _queryWait(what, args, timeout = 10_000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        return await this._query(what, args);
      } catch (err) {
        if (RETRYABLE.has(err.code) && Date.now() < deadline) {
          await sleep(150);
          continue;
        }
        throw err;
      }
    }
  }
  click(o = {}) {
    return this._act("click", { button: o.button, clickCount: o.clickCount, modifiers: o.modifiers, force: o.force, position: o.position }, o);
  }
  dblclick(o = {}) {
    return this._act("click", { clickCount: 2, button: o.button, modifiers: o.modifiers, force: o.force }, o);
  }
  hover(o = {}) {
    return this._act("hover", { force: o.force, modifiers: o.modifiers }, o);
  }
  fill(value, o = {}) {
    return this._act("fill", { value }, o);
  }
  clear(o = {}) {
    return this._act("fill", { value: "" }, o);
  }
  pressSequentially(text, o = {}) {
    return this._act("type", { text, delay: o.delay }, o);
  }
  type(text, o) {
    return this.pressSequentially(text, o);
  }
  press(key, o = {}) {
    return this._act("press", { key }, o);
  }
  check(o = {}) {
    return this._act("setChecked", { checked: true, force: o.force }, o);
  }
  uncheck(o = {}) {
    return this._act("setChecked", { checked: false, force: o.force }, o);
  }
  setChecked(checked, o = {}) {
    return this._act("setChecked", { checked, force: o.force }, o);
  }
  selectOption(values, o = {}) {
    return this._act("selectOption", { values: [].concat(values) }, o);
  }
  focus(o = {}) {
    return this._act("focus", {}, o);
  }
  blur() {
    return this.page._call("dom", { op: "blur", args: {} });
  }
  scrollIntoViewIfNeeded(o = {}) {
    return this._act("scroll", {}, o);
  }
  dispatchEvent(type) {
    return this._act("dispatchEvent", { type });
  }
  count() {
    return this._query("count");
  }
  async all() {
    const n = await this.count();
    return Array.from({ length: n }, (_, i) => this.nth(i));
  }
  textContent(o = {}) {
    return this._queryWait("text", {}, o.timeout);
  }
  innerText(o = {}) {
    return this._queryWait("innerText", {}, o.timeout);
  }
  inputValue(o = {}) {
    return this._queryWait("inputValue", {}, o.timeout);
  }
  getAttribute(name, o = {}) {
    return this._queryWait("attribute", { name }, o.timeout);
  }
  innerHTML(o = {}) {
    return this._queryWait("html", {}, o.timeout);
  }
  allTextContents() {
    return this._query("allTexts");
  }
  allInnerTexts() {
    return this._query("allInnerTexts");
  }
  isVisible() {
    return this._query("visible");
  }
  async isHidden() {
    return !(await this._query("visible"));
  }
  isEnabled() {
    return this._queryWait("enabled");
  }
  async isDisabled() {
    return !(await this._queryWait("enabled"));
  }
  isChecked() {
    return this._queryWait("checked");
  }
  isEditable() {
    return this._queryWait("editable");
  }
  boundingBox() {
    return this._queryWait("box");
  }
  describe() {
    return this._query("describeAll");
  }
  async waitFor({ state = "visible", timeout = 30_000 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      let ok = false;
      try {
        if (state === "visible") ok = await this._query("visible");
        else if (state === "hidden") ok = !(await this._query("visible"));
        else if (state === "attached") ok = (await this._query("count")) > 0;
        else if (state === "detached") ok = (await this._query("count")) === 0;
      } catch (err) {
        if (err.code === "stale_ref") ok = state === "detached" || state === "hidden";
        else if (!RETRYABLE.has(err.code)) throw err;
      }
      if (ok) return;
      if (Date.now() > deadline) throw new BrowseError(`Timed out after ${timeout}ms waiting for ${this} to be ${state}`, "timeout");
      await sleep(150);
    }
  }
  async evaluate(fn, arg) {
    const src = typeof fn === "function" ? fn.toString() : String(fn);
    return this.page._call("evaluate", { frameId: this.page.frameId, expression: `(${src})(__browseFx.resolveOne(${JSON.stringify(this.steps)}), ${JSON.stringify(arg ?? null)})` });
  }
  async screenshot({ path, scale = 1 } = {}) {
    await this.scrollIntoViewIfNeeded();
    const box = await this.boundingBox();
    return this.page.screenshot({ path, scale, clip: { x: box.pageX, y: box.pageY, width: box.width, height: box.height } });
  }
}
