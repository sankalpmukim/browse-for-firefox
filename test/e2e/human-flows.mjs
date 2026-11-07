// Human-in-the-loop flows that need real clicks: lending a tab with the toolbar button, adopting it,
// Continue on the hand-off card, Continue via the toolbar, taking a tab back.
// Runs against an isolated, *visible* test Firefox and clicks through macOS accessibility with agent-desktop.
// Usage: node test/e2e/human-flows.mjs   (macOS, agent-desktop with Accessibility permission)
import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { isolatedEnv, startSite, startFirefox, mcpClient, sleep } from "./harness.mjs";

const ad = (...args) =>
  new Promise((resolve, reject) =>
    execFile("agent-desktop", args, { encoding: "utf8" }, (err, out) => {
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(err || new Error(out));
      }
    }),
  );
const step = (msg) => console.log(`\n▶ ${msg}`);

const { env } = isolatedEnv();
const site = await startSite();
const ff = await startFirefox(env, { headless: false, startUrl: `${site.origin}/login.html` });
let failed = false;
try {
  await sleep(1500);
  const pids = new Set(ff.pids());
  const windows = (await ad("list-windows", "--app", "Firefox")).data.filter((w) => pids.has(w.pid));
  assert.ok(windows.length, "test Firefox window found");
  const WIN = windows[0].id;
  const find = async (role, name) => (await ad("find", "--window-id", WIN, "--role", role, ...(name ? ["--name", name] : []))).data.matches.filter((m) => m.ref_id);
  const toolbarButton = async () => {
    const m = (await find("button")).filter((x) => /^browse ·/.test(x.name || ""));
    assert.equal(m.length, 1, "browse toolbar button present");
    return m[0];
  };
  const tabState = async () => JSON.parse((await A.call("status")).text);
  const A = await mcpClient(env, "human");
  // The extension's first-run settings page opens in front; act as the user switching to their login tab.
  const loginTab = (await find("radiobutton", "Login"))[0];
  await ad("click", loginTab.ref_id);
  await sleep(500);

  step("the user's tab is not available to agents until lent");
  assert.match((await A.call("tabs", { action: "adopt" }, { allowError: true })).text, /No tab has been lent/);

  step("lend it with a real toolbar click → badge ON, adoptable");
  await ad("click", (await toolbarButton()).ref_id);
  await sleep(400);
  let lent = (await tabState()).lentTabs[0];
  console.log("lent:", lent?.url, "badge", lent?.badge, "|", lent?.toolbarTitle);
  assert.equal(lent.badge, "ON");
  assert.match(lent.toolbarTitle, /Agents can use this tab/);
  const adopted = await A.call("tabs", { action: "adopt", targetUrl: "login.html" });
  assert.match(adopted.text, /"kind": "lent"/);
  await A.call("fill", { target: "Username", value: "lent-tab-works" });
  assert.equal(JSON.parse((await A.call("evaluate", { expression: "document.getElementById('u').value" })).text), "lent-tab-works");
  console.log("agent filled the user's tab");
  await A.call("navigate", { url: `${site.origin}/login.html?again=1` });
  lent = (await tabState()).lentTabs[0];
  assert.equal(lent.badge, "ON", "badge survives the agent navigating the lent tab");
  assert.match(lent.toolbarTitle, /Agents can use this tab/);

  step("hand-off: a real click on the card's Continue resumes the agent");
  const waiting = A.call("handoff", { message: "Please confirm you're here", timeoutMs: 60000 });
  await sleep(1500);
  lent = (await tabState()).lentTabs[0];
  console.log("during hand-off: badge", lent.badge, "|", lent.toolbarTitle);
  assert.equal(lent.badge, "WAIT");
  assert.match(lent.toolbarTitle, /waiting for you/);
  const cont = await find("button", "Continue");
  assert.ok(cont.length >= 1, "card's Continue button is in the page");
  await ad("click", cont[0].ref_id);
  const handed = JSON.parse((await waiting).text);
  console.log("result:", handed.outcome);
  assert.equal(handed.continued, true);
  assert.equal((await find("button", "Continue")).length, 0, "card removed");

  step("hand-off continued with the toolbar button instead");
  const waiting2 = A.call("handoff", { message: "Toolbar this time", timeoutMs: 60000 });
  await sleep(1500);
  await ad("click", (await toolbarButton()).ref_id);
  const handed2 = JSON.parse((await waiting2).text);
  console.log("result:", handed2.outcome);
  assert.equal(handed2.continued, true);
  assert.equal((await tabState()).lentTabs[0]?.badge, "ON", "still lent after continuing");

  step("a page can't fake Continue with a synthetic click");
  const waiting3 = A.call("handoff", { message: "Fake test", timeoutMs: 4000 });
  await sleep(1000);
  await A.call("evaluate", { expression: "() => { document.querySelectorAll('*').forEach(e => { try { e.click() } catch {} }); return 1 }", world: "page" });
  const handed3 = JSON.parse((await waiting3).text);
  console.log("result:", handed3.outcome);
  assert.equal(handed3.outcome, "timeout");

  step("closing a lent tab hands it back instead of closing it");
  const closed = JSON.parse((await A.call("tabs", { action: "close" })).text);
  assert.ok(closed.released);
  assert.equal((await tabState()).lentTabs.length, 0);
  assert.equal((await tabState()).lentTabs.length, 0, "no longer lent");

  step("lend again, take it back with the toolbar → the agent loses access");
  await ad("click", (await toolbarButton()).ref_id);
  await sleep(300);
  await A.call("tabs", { action: "adopt" });
  await ad("click", (await toolbarButton()).ref_id);
  await sleep(300);
  const denied = await A.call("snapshot", {}, { allowError: true });
  assert.ok(denied.isError);
  console.log("after take-back:", denied.text.slice(0, 90));

  step("the agent opens its own tab: background, inside the collapsed Agents group");
  await A.call("tabs", { action: "new", url: `${site.origin}/page2.html` });
  const agentTab = (await tabState()).tabs.find((t) => t.kind === "agent");
  assert.ok(agentTab?.groupId, "agent tab grouped");
  console.log("agent tab", agentTab.tabId, "in group", agentTab.groupId);
  // Collapsed group: the agent's tab isn't even in the tab strip.
  assert.ok(!(await find("radiobutton")).some((m) => /^Page Two/.test(m.name || "")), "agent tab hidden in the collapsed group");

  step("hand-off on a background agent tab expands its group; the user switches to it and clicks Continue");
  const waiting4 = A.call("handoff", { tabId: agentTab.tabId, message: "Log in please", timeoutMs: 60000 });
  await sleep(1500);
  const pageTwo = (await find("radiobutton")).find((m) => /^Page Two/.test(m.name || ""));
  assert.ok(pageTwo, "group expanded so the user can see the waiting tab");
  await ad("click", pageTwo.ref_id);
  await sleep(600);
  await ad("click", (await find("button", "Continue"))[0].ref_id);
  assert.equal(JSON.parse((await waiting4).text).continued, true);
  console.log("hand-off on a background agent tab: continued");

  step("taking over an agent's own tab with the toolbar removes it from the session");
  await sleep(400);
  assert.match((await tabState()).tabs.find((t) => t.tabId === agentTab.tabId).toolbarTitle, /Agent tab\. Click to take it over/);
  await ad("click", (await toolbarButton()).ref_id);
  await sleep(400);
  assert.equal((await tabState()).tabs.filter((t) => t.kind === "agent").length, 0, "agent lost the tab");
  const taken = await A.call("snapshot", { tabId: agentTab.tabId }, { allowError: true });
  assert.match(taken.text, /isn't available to agents/);
  console.log("user took over the agent tab; agent access revoked");
  await A.close();
  console.log("\nALL HUMAN FLOWS PASSED");
} catch (err) {
  failed = true;
  console.error("\nFAILED:", err.message);
} finally {
  ff.stop();
  site.close();
  process.exit(failed ? 1 : 0);
}
