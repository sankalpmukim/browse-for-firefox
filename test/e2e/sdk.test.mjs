// End-to-end: the official MCP SDK client against browse-firefox, driving an isolated headless Firefox.
// Run: node --test --test-concurrency=1 test/e2e/sdk.test.mjs   (or npm run e2e)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isolatedEnv, startSite, startFirefox, mcpClient, cli, cliInput, sleep } from "./harness.mjs";

let site, firefox, A, B, env;

const pngSize = (img) => {
  const b = Buffer.from(img.data, "base64");
  assert.equal(b.subarray(1, 4).toString(), "PNG", "image is a PNG");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};
const evaluate = async (expression, extra = {}) => JSON.parse((await A.call("evaluate", { expression, ...extra })).text);

before(async () => {
  ({ env } = isolatedEnv());
  site = await startSite();
  firefox = await startFirefox(env);
  A = await mcpClient(env, "alpha");
  B = await mcpClient(env, "beta");
});

after(async () => {
  await A?.close();
  await B?.close();
  firefox?.stop();
  site?.close();
});

// ---------- protocol ----------

test("MCP handshake and tool listing pass SDK schema validation", async () => {
  const info = A.client.getServerVersion();
  assert.equal(info.name, "browse-firefox");
  assert.match(A.client.getInstructions(), /inspect, act, verify/);
  assert.ok(A.client.getServerCapabilities().tools);
  const { tools } = await A.client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const n of ["navigate", "snapshot", "click", "fill", "type", "press", "select_option", "check", "hover", "scroll", "wait_for", "screenshot", "evaluate", "execute", "handoff", "network", "recording", "console", "secrets", "session_allowlist", "tabs", "settings", "status"]) {
    assert.ok(names.includes(n), `tool ${n} listed`);
  }
  for (const t of tools) {
    assert.equal(t.inputSchema.type, "object", `${t.name} schema`);
    assert.ok(t.description.length > 20, `${t.name} described`);
  }
  await assert.rejects(A.client.callTool({ name: "does_not_exist", arguments: {} }), /Unknown tool/);
});

test("status reports a connected Firefox with tab groups", async () => {
  const { json } = await A.call("status");
  assert.equal(json.connected, true);
  assert.equal(json.session, "alpha");
  assert.match(json.firefox, /^\d+/);
  assert.equal(json.tabGroups, true);
  assert.equal(json.tabGroupError, undefined);
});

// ---------- navigation and reading ----------

test("navigate opens a background agent tab inside the Agents group", async () => {
  const { json } = await A.call("navigate", { url: `${site.origin}/index.html` });
  assert.equal(json.title, "Fixture Shop");
  assert.equal(json.url, `${site.origin}/index.html`);
  const tabs = (await A.call("tabs", { action: "list" })).json.tabs;
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].kind, "agent");
  assert.equal(tabs[0].session, "alpha");
  assert.equal(tabs[0].active, false, "agent tab stays in the background");
  assert.ok(tabs[0].groupId, "agent tab is grouped");
});

test("snapshot lists structure, refs, closed shadow DOM and frames", async () => {
  const { text } = await A.call("snapshot");
  assert.match(text, /^Page: Fixture Shop/);
  assert.match(text, /heading "Welcome to the fixture" \[level=1\] \[ref=e\d+\]/);
  assert.match(text, /navigation "Main"/);
  assert.match(text, /link "Page two" \[ref=e\d+\] -> \/page2\.html/);
  assert.match(text, /textbox "Email" \[ref=e\d+\]/);
  assert.match(text, /textbox "Password" \[password\]/);
  assert.match(text, /combobox \[value="Small"\]/);
  assert.match(text, /checkbox "I agree"/);
  assert.match(text, /button "Shadow action" \[ref=e\d+\]/, "closed shadow root content is visible");
  assert.match(text, /generic "Fake button" \[clickable\]/);
  assert.match(text, /listitem: "Apple"/);
  assert.match(text, /Frames \(pass frameId[\s\S]*frame\.html/);
  const found = await A.call("snapshot", { find: "Cherry", context: 1 });
  assert.match(found.text, /Buy cherry/);
  assert.doesNotMatch(found.text, /Welcome to the fixture/);
});

test("interactiveOnly snapshot lists only controls", async () => {
  const { text } = await A.call("snapshot", { interactiveOnly: true });
  assert.doesNotMatch(text, /paragraph|listitem/);
  assert.match(text, /button "Sign in"/);
});

// ---------- acting ----------

test("click by visible text reports the page change", async () => {
  await A.call("snapshot");
  const { text } = await A.call("click", { target: "Fake button" });
  assert.match(text, /\+ .*text: "clicked fake false"/, "diff shows the effect");
});

test("click reaches a button in a closed shadow root", async () => {
  const { text } = await A.call("click", { target: 'role=button[name="Shadow action"]' });
  assert.match(text, /shadow clicked/);
});

test("fill drives framework-style input listeners", async () => {
  const { text } = await A.call("fill", { target: "#react", value: "hello react" });
  assert.match(text, /react saw: hello react/);
  assert.doesNotMatch(text, /synthetic":true/);
});

test("type and press edit key by key", async () => {
  await A.call("fill", { target: "#react", value: "" });
  await A.call("type", { target: "#react", text: "abc" });
  const { text } = await A.call("press", { key: "Backspace" });
  assert.match(text, /react saw: ab"/);
});

test("select_option and check (visually hidden checkbox via its label)", async () => {
  await A.call("select_option", { target: "#size", values: ["Large"] });
  await A.call("check", { target: "#cb" });
  const state = await evaluate("({ size: document.querySelector('#size').value, agreed: document.querySelector('#cb').checked })");
  assert.deepEqual(state, { size: "l", agreed: true });
  const again = await A.call("check", { target: "#cb" });
  assert.match(again.text, /"changed":false/);
});

test("strict mode refuses ambiguous targets and explains", async () => {
  const r = await A.call("click", { target: "button" }, { allowError: true });
  assert.ok(r.isError);
  assert.match(r.text, /\[strict\] Strict mode/);
  assert.match(r.text, /ref=e\d+/);
});

test("a single visible match among hidden duplicates is accepted", async () => {
  const r = await A.call("click", { target: "Save" });
  assert.match(r.text, /id=\\"dup\\"/);
});

test("missing elements fail after the timeout", async () => {
  const t0 = Date.now();
  const r = await A.call("click", { target: "#nope", timeoutMs: 800 }, { allowError: true });
  assert.ok(r.isError);
  assert.match(r.text, /not_found/);
  assert.ok(Date.now() - t0 < 5000);
});

test("clicks blocked by an overlay are reported, then work once it's gone", async () => {
  await A.call("navigate", { url: `${site.origin}/modal.html` });
  const blocked = await A.call("click", { target: "#under", timeoutMs: 800 }, { allowError: true });
  assert.ok(blocked.isError);
  assert.match(blocked.text, /intercepted/);
  await A.call("click", { target: "Accept" });
  await A.call("click", { target: "#under" });
  assert.equal(await evaluate("document.getElementById('res').textContent"), "under clicked");
});

test("actions wait for late elements", async () => {
  await A.call("navigate", { url: `${site.origin}/delayed.html` });
  await A.call("click", { target: "Late button", timeoutMs: 8000 });
  await A.call("wait_for", { text: "Late clicked", timeoutMs: 5000 });
});

test("form submit with Enter navigates and reports it", async () => {
  await A.call("navigate", { url: `${site.origin}/index.html` });
  await A.call("snapshot");
  const r = await A.call("fill", { fields: [{ target: "Email", value: "x@y.z" }, { target: "#notes", value: "hi" }], submit: true });
  assert.match(r.text, /Now at: .*page2\.html\?email=x%40y\.z/);
  assert.match(r.text, /Navigated away/);
});

test("back, forward and reload", async () => {
  assert.match((await A.call("navigate", { action: "back" })).json.url, /index\.html$/);
  assert.match((await A.call("navigate", { action: "forward" })).json.url, /page2\.html/);
  assert.match((await A.call("navigate", { action: "reload" })).json.url, /page2\.html/);
});

test("single-page-app routing (pushState) is followed", async () => {
  await A.call("navigate", { url: `${site.origin}/spa.html` });
  const r = await A.call("click", { target: "Settings" });
  assert.match(r.text, /Now at: SPA settings — .*\/spa\/settings/);
  await A.call("select_option", { target: "Theme", values: ["Dark"] });
  assert.equal(await evaluate("document.getElementById('theme').value"), "Dark");
  assert.match((await A.call("navigate", { action: "back" })).json.url, /\/spa\.html$/);
});

test("scroll and wait_for", async () => {
  await A.call("navigate", { url: `${site.origin}/index.html` });
  const down = (await A.call("scroll", { to: "bottom" })).json;
  assert.equal(down.atBottom, true);
  const up = (await A.call("scroll", { target: "h1" })).json;
  assert.ok(up.scrollY < down.scrollY);
  await A.call("wait_for", { urlIncludes: "index.html", timeoutMs: 2000 });
  const late = await A.call("wait_for", { text: "never appears", timeoutMs: 600 }, { allowError: true });
  assert.ok(late.isError);
});

test("hover fires mouse events", async () => {
  await evaluate("(() => { window.__h = 0; document.querySelector('#dup').addEventListener('mouseover', () => window.__h++); return true })()");
  await A.call("hover", { target: "#dup" });
  assert.equal(await evaluate("window.__h"), 1);
});

// ---------- screenshots and evaluation ----------

test("screenshots: viewport, full page, element, labels", async () => {
  const vp = pngSize((await A.call("screenshot")).images[0]);
  assert.ok(vp.width > 500 && vp.height > 300);
  const full = pngSize((await A.call("screenshot", { fullPage: true })).images[0]);
  assert.ok(full.height > vp.height * 1.5, `full page (${full.height}) taller than viewport (${vp.height})`);
  const el = pngSize((await A.call("screenshot", { target: "form" })).images[0]);
  assert.ok(el.width < vp.width && el.height < 200);
  const labelled = await A.call("screenshot", { labels: true });
  assert.equal(labelled.images.length, 1);
  assert.match(labelled.text, /e\d+ button "Sign in"/);
  assert.equal(await evaluate("document.querySelectorAll('body > div:not([class]):not([id])').length"), 0, "label overlay removed");
});

test("evaluate: isolated world, page world, element functions, errors", async () => {
  assert.equal(await evaluate("document.title"), "Fixture Shop");
  assert.equal(await evaluate("const n = document.querySelectorAll('li').length; return n * 2"), 6);
  assert.equal(await evaluate("() => typeof customElements.get('my-widget')", { world: "page" }), "function");
  assert.equal(await evaluate("(el, suffix) => el.id + suffix", { target: "#email", arg: "!" }), "email!");
  const bad = await A.call("evaluate", { expression: "nope.nope" }, { allowError: true });
  assert.ok(bad.isError);
  assert.match(bad.text, /nope is not defined/);
});

// ---------- execute ----------

test("execute runs Playwright-style flows and keeps state", async () => {
  const r = await A.call("execute", {
    code: `await page.goto("${site.origin}/index.html");
      await page.getByLabel("Email").fill("exec@example.com");
      await page.locator("li").filter({ hasText: "Cherry" }).getByRole("button").click();
      state.items = await page.locator("li").allInnerTexts();
      console.log("count", state.items.length);
      return { title: await page.title(), email: await page.locator("#email").inputValue(), visible: await page.getByText(/fake/i).isVisible() }`,
  });
  assert.deepEqual(r.json, { title: "Fixture Shop", email: "exec@example.com", visible: true });
  assert.match(r.text, /console:\ncount 3/);
  assert.equal((await A.call("execute", { code: "state.items.length" })).json, 3);
});

test("execute: snapshot helper, regex locators, frames and screenshots", async () => {
  const snap = await A.call("execute", { code: "await snapshot({ find: /Shadow/ })" });
  assert.match(snap.text, /button "Shadow action"/);
  const frame = await A.call("execute", {
    code: `const f = (await page.frames()).find(x => x.frameUrl.includes("frame.html"));
      await f.getByRole("button", { name: "Frame button" }).click();
      return await f.locator("button").innerText()`,
  });
  assert.equal(frame.json ?? frame.text.split("\n")[0], "frame clicked");
  const shot = await A.call("execute", { code: "await page.screenshot()" });
  assert.equal(shot.images.length, 1);
});

test("execute sandbox, syntax errors and timeouts", async () => {
  const noProcess = await A.call("execute", { code: "process.exit(1)" }, { allowError: true });
  assert.ok(noProcess.isError);
  const noRequire = await A.call("execute", { code: "require('fs')" }, { allowError: true });
  assert.ok(noRequire.isError);
  const noEval = await A.call("execute", { code: "eval('1+1')" }, { allowError: true });
  assert.ok(noEval.isError, "eval disabled in the realm");
  const syntax = await A.call("execute", { code: "return {" }, { allowError: true });
  assert.match(syntax.text, /syntax_error/);
  const hang = await A.call("execute", { code: "await new Promise(() => {})", timeoutMs: 1000 }, { allowError: true });
  assert.match(hang.text, /timed out/);
  const spin = await A.call("execute", { code: "while (true) {}" }, { allowError: true });
  assert.ok(spin.isError, "sync infinite loop is stopped");
  assert.equal((await A.call("execute", { code: "1 + 1" })).json, 2, "server still healthy");
});

// ---------- tabs, popups, sessions ----------

test("target=_blank links open as background agent tabs of the same session", async () => {
  await A.call("navigate", { url: `${site.origin}/popup.html` });
  const r = await A.call("click", { target: "Open via link" });
  assert.match(r.text, /Opened tab \d+ in the background/);
  const tabs = (await A.call("tabs", { action: "list" })).json.tabs;
  const popup = tabs.find((t) => t.openerTabId != null);
  assert.ok(popup, "popup tagged with its opener");
  assert.equal(popup.session, "alpha");
  assert.equal(popup.active, false);
  await A.call("tabs", { action: "close", tabId: popup.tabId });
});

test("script-opened popups (window.open on click) join the session in the background", async () => {
  const before = (await A.call("tabs", { action: "list" })).json.tabs.length;
  await A.call("click", { target: "Open via script" });
  await sleep(800);
  const tabs = (await A.call("tabs", { action: "list" })).json.tabs;
  assert.equal(tabs.length, before + 1, "popup opened");
  const popup = tabs.find((t) => t.openerTabId != null);
  assert.ok(popup, "script popup joined the session");
  assert.equal(popup.active, false, "popup didn't steal focus");
  await A.call("tabs", { action: "close", tabId: popup.tabId });
});

test("sessions are isolated from each other", async () => {
  const mine = (await A.call("tabs", { action: "list" })).json.tabs;
  await B.call("navigate", { url: `${site.origin}/page2.html` });
  const theirs = (await B.call("tabs", { action: "list" })).json.tabs;
  assert.equal(theirs.length, 1);
  assert.ok(!theirs.some((t) => mine.some((m) => m.tabId === t.tabId)));
  const steal = await B.call("snapshot", { tabId: mine[0].tabId }, { allowError: true });
  assert.ok(steal.isError);
  assert.match(steal.text, /another agent session/);
});

test("tabs: new, select, close, adopt without a lent tab, cleanup", async () => {
  const t = (await A.call("tabs", { action: "new", url: `${site.origin}/page2.html` })).json;
  assert.equal(t.title.startsWith("Page Two"), true);
  await A.call("tabs", { action: "select", tabId: t.tabId });
  assert.equal((await A.call("tabs", { action: "list" })).json.currentTabId, t.tabId);
  assert.deepEqual((await A.call("tabs", { action: "close" })).json, { closed: t.tabId });
  const adopt = await A.call("tabs", { action: "adopt" }, { allowError: true });
  assert.match(adopt.text, /No tab has been lent/);
  const cleaned = (await B.call("tabs", { action: "cleanup", olderThanMinutes: 0 })).json;
  assert.equal(cleaned.closed.length, 1);
  assert.equal((await B.call("tabs", { action: "list" })).json.tabs.length, 0);
  assert.ok((await A.call("tabs", { action: "list" })).json.tabs.length >= 1, "other session untouched");
});

// ---------- network ----------

test("network capture: HAR with bodies, credentials redacted", async () => {
  await A.call("navigate", { url: `${site.origin}/index.html` });
  await A.call("network", { action: "start", bodies: true });
  await A.call("navigate", { url: `${site.origin}/auth.html` });
  await A.call("wait_for", { text: "user=alice", timeoutMs: 5000 });
  const status = (await A.call("network", { action: "status" })).json;
  assert.ok(status.requests >= 2);
  const stop = (await A.call("network", { action: "stop" })).json;
  const raw = fs.readFileSync(stop.har, "utf8");
  for (const secret of ["SECRETBEARER", "COOKIESECRET", "SECRET123"]) assert.ok(!raw.includes(secret), `${secret} redacted`);
  const har = JSON.parse(raw);
  const api = har.log.entries.find((e) => e.request.url.includes("/api/me"));
  assert.ok(api, "API request captured");
  assert.match(api.request.url, /access_token=%5Bredacted%5D&page=2/);
  assert.equal(api.request.headers.find((h) => /^authorization$/i.test(h.name)).value, "[redacted]");
  assert.equal(api.response.status, 200);
  assert.equal(JSON.parse(api.response.content.text).user, "alice", "response body captured");
  const doc = har.log.entries.find((e) => e.request.url.endsWith("/auth.html"));
  assert.match(doc.response.content.text, /Auth fetch/);
});

// ---------- allowlists ----------

test("allowlist blocks direct navigation, link redirects and stays scoped to the session", async () => {
  await A.call("session_allowlist", { allowedOrigins: [`127.0.0.1:${site.port}`] });
  const direct = await A.call("navigate", { url: "https://example.org/" }, { allowError: true });
  assert.match(direct.text, /domain_not_allowed/);
  await A.call("navigate", { url: `${site.origin}/popup.html` });
  await A.call("click", { target: "Leave via redirect" });
  await sleep(800);
  const list = (await A.call("tabs", { action: "list" })).json;
  const current = list.tabs.find((t) => t.tabId === list.currentTabId);
  assert.ok(!current.url.includes("example.org"), `redirect to another site was cancelled (at ${current.url})`);
  const status = (await A.call("status")).json;
  assert.ok(status.recentlyBlocked.some((b) => b.url.startsWith("https://example.org")), "block was recorded");
  await A.call("click", { target: "Stay on site" });
  await A.call("wait_for", { text: "Second page", timeoutMs: 5000 });
  const other = await B.call("navigate", { url: "https://example.org/", timeoutMs: 15000 }, { allowError: true });
  assert.ok(!/domain_not_allowed/.test(other.text), "other session is not restricted");
  await A.call("session_allowlist", { allowedOrigins: [] });
  await B.call("tabs", { action: "cleanup", olderThanMinutes: 0 });
});

// ---------- secrets ----------

test("secrets are typed without being revealed, and only on their origin", async () => {
  await cliInput(env, "hunter2-secret", "secrets", "add", "e2e", "--origin", site.origin);
  const listed = (await A.call("secrets", { action: "list" })).text;
  assert.match(listed, /"name": "e2e"/);
  assert.ok(!listed.includes("hunter2"));
  await A.call("navigate", { url: `${site.origin}/login.html` });
  const r = await A.call("secrets", { action: "type", name: "e2e", target: "#p" });
  assert.ok(!r.text.includes("hunter2"), "value never returned");
  assert.match(r.text, /"typed": true/);
  assert.match(r.text, /no allowlist/, "warns without an allowlist");
  assert.equal(await evaluate("document.getElementById('len').textContent"), "len=14");
  // The same page served from another origin, inside a frame: refused.
  await A.call("navigate", { url: `${site.origin}/xframe.html` });
  await A.call("wait_for", { timeMs: 500 });
  const snap = (await A.call("snapshot")).text;
  const frameId = Number(snap.match(/frameId=(\d+) http:\/\/localhost/)[1]);
  const cross = await A.call("secrets", { action: "type", name: "e2e", target: "#p", frameId }, { allowError: true });
  assert.ok(cross.isError);
  assert.match(cross.text, /domain_not_allowed/);
  const missing = await A.call("secrets", { action: "type", name: "nope", target: "#p" }, { allowError: true });
  assert.match(missing.text, /No secret named/);
  await cli(env, "secrets", "remove", "e2e");
});

// ---------- console, recording, handoff ----------

test("console capture: logs, warnings and uncaught errors", async () => {
  await A.call("navigate", { url: `${site.origin}/index.html` });
  const start = (await A.call("console", { action: "start" })).json;
  assert.equal(start.mode, "console+errors");
  await A.call("evaluate", { expression: "() => { console.log('hello', {x: 1}); console.warn('careful'); setTimeout(() => { throw new Error('async boom') }, 0); return 1 }", world: "page" });
  await sleep(1500);
  const { entries } = (await A.call("console", { action: "read", clear: true })).json;
  assert.ok(entries.some((e) => e.level === "log" && e.text === 'hello {"x":1}'));
  assert.ok(entries.some((e) => e.level === "warn" && e.text === "careful"));
  assert.ok(entries.some((e) => e.level === "pageerror" && /async boom/.test(e.text)));
  await A.call("console", { action: "stop" });
  assert.equal(await evaluate("() => { console.log('after'); return 'ok' }", { world: "page" }), "ok");
});

test("recording produces a WebM video", async () => {
  await A.call("recording", { action: "start", fps: 6 });
  await A.call("execute", { code: `await page.goto("${site.origin}/modal.html"); await sleep(700); await page.getByText("Accept").click(); await sleep(700)` });
  const r = (await A.call("recording", { action: "stop" })).json;
  const bytes = fs.readFileSync(r.file);
  assert.equal(bytes.subarray(0, 4).toString("hex"), "1a45dfa3", "EBML/WebM header");
  assert.ok(bytes.length > 5000 && r.frames >= 5, `frames=${r.frames} bytes=${bytes.length}`);
});

test("handoff waits and times out cleanly; the card is drawn in the page", async () => {
  const shot = await A.call("execute", {
    code: `let img; const r = await handoff("Please sign in", { timeoutMs: 2000, start: async () => { await sleep(500); img = await page.screenshot(); } }).catch(e => e.message); return { r, img }`,
  });
  assert.match(shot.text, /timeout/);
  assert.equal(shot.images.length, 1);
  const r = (await A.call("handoff", { message: "x", timeoutMs: 800 })).json;
  assert.equal(r.continued, false);
  assert.equal(r.outcome, "timeout");
});

// ---------- settings ----------

test("settings validate input; per-session grouping and separate window mode work", async () => {
  const bad = (await A.call("settings", { action: "set", values: { grouping: "weird", idleMinutes: 7 } })).json;
  assert.deepEqual(bad.rejected.sort(), ["grouping", "idleMinutes"]);
  await A.call("settings", { action: "set", values: { grouping: "session" } });
  const a = (await A.call("tabs", { action: "new", url: `${site.origin}/page2.html` })).json;
  const b = (await B.call("tabs", { action: "new", url: `${site.origin}/page2.html` })).json;
  assert.ok(a.groupId && b.groupId && a.groupId !== b.groupId, "one group per session");
  await A.call("settings", { action: "set", values: { grouping: "shared", windowMode: "separate" } });
  const sep = (await A.call("tabs", { action: "new", url: `${site.origin}/page2.html` })).json;
  assert.notEqual(sep.windowId, a.windowId, "separate window");
  await A.call("settings", { action: "set", values: { windowMode: "current" } });
  await A.call("tabs", { action: "cleanup", olderThanMinutes: 0 });
  await B.call("tabs", { action: "cleanup", olderThanMinutes: 0 });
});

// ---------- scale ----------

test("large pages snapshot quickly and truncate with guidance", async () => {
  await A.call("navigate", { url: `${site.origin}/big.html` });
  const t0 = Date.now();
  const { text } = await A.call("snapshot");
  const ms = Date.now() - t0;
  assert.ok(ms < 4000, `snapshot took ${ms}ms`);
  assert.match(text, /snapshot truncated/);
  const found = await A.call("snapshot", { find: "Item 2999" });
  assert.match(found.text, /link "Item 2999"/);
  await A.call("click", { target: 'role=button[name="Add 2999"]' });
});

// ---------- CLI ----------

test("CLI status, tabs and exec share the relay", async () => {
  const status = JSON.parse(await cli(env, "status"));
  assert.equal(status.connected, true);
  assert.ok(Array.isArray(JSON.parse(await cli(env, "tabs"))));
  assert.equal((await cli(env, "exec", "--session", "cli-e2e", `await page.goto("${site.origin}/page2.html"); return await page.title()`)).trim(), "Page Two (true)");
  await cli(env, "exec", "--session", "cli-e2e", "await page.close()");
});

test("reload restarts the extension and relay; agents reconnect and keep their tabs", async () => {
  await A.call("navigate", { url: `${site.origin}/index.html`, newTab: true });
  const before = (await A.call("tabs", { action: "list" })).json.tabs.map((t) => t.tabId).sort();
  assert.ok(before.length >= 1);
  const out = await cli(env, "reload");
  assert.match(out, /Reloaded: extension/);
  const { json } = await A.call("status");
  assert.equal(json.connected, true);
  const after = (await A.call("tabs", { action: "list" })).json.tabs.map((t) => t.tabId).sort();
  assert.deepEqual(after, before, "tab ownership restored from session storage");
  await A.call("snapshot");
  const nav = (await A.call("navigate", { url: `${site.origin}/page2.html`, newTab: true })).json;
  assert.equal(nav.title.startsWith("Page Two"), true);
});

test("bot challenges are detected and routed: interactive → handoff, block → stop", async () => {
  const challenge = (await A.call("navigate", { url: `${site.origin}/challenge.html` })).json;
  assert.equal(challenge.challenge?.recommendation, "handoff");
  assert.match(challenge.next, /handoff/);
  const blocked = (await A.call("navigate", { url: `${site.origin}/blocked.html` })).json;
  assert.equal(blocked.challenge?.recommendation, "stop");
  assert.match(blocked.next, /Stop/);
  const normal = (await A.call("navigate", { url: `${site.origin}/page2.html` })).json;
  assert.equal(normal.challenge, undefined, "no false positive");
});
