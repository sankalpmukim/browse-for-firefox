const $ = (s) => document.querySelector(s);
let savedTimer;

async function refresh() {
  let s;
  try {
    s = await browser.runtime.sendMessage({ type: "options.status" });
  } catch (err) {
    $("#status-title").textContent = "Extension background isn't responding";
    $("#status-detail").textContent = String(err);
    return;
  }
  const { host } = s;
  const dot = $("#dot");
  const relayError = host.relay?.relayError;
  if (host.connected && !relayError) {
    dot.className = "dot ok";
    $("#status-title").textContent = "Connected to the local relay";
    $("#status-detail").textContent = `Agents reach this browser through ${host.relay?.socket || "the relay socket"} · host ${host.relay?.version || ""}`;
    $("#setup").hidden = true;
  } else if (host.connected && relayError) {
    dot.className = "dot warn";
    $("#status-title").textContent = "Connected, but standing by";
    $("#status-detail").textContent = relayError;
    $("#setup").hidden = true;
  } else {
    dot.className = "dot bad";
    $("#status-title").textContent = "Not connected";
    $("#status-detail").textContent = host.error || "";
    $("#setup").hidden = !/No such native application|not found|does not exist/i.test(host.error || "") && !!host.error;
    if (!host.error || /No such native application/i.test(host.error)) $("#setup").hidden = false;
  }
  const form = $("#settings");
  for (const [k, v] of Object.entries(s.settings)) {
    const el = form.elements[k];
    if (el && document.activeElement !== el) el.value = String(v);
  }
  const list = $("#tabs");
  list.replaceChildren();
  if (!s.tabs.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No agent or lent tabs right now.";
    list.append(li);
  }
  for (const t of s.tabs) {
    const li = document.createElement("li");
    const k = document.createElement("span");
    k.className = "k";
    k.textContent = t.kind === "lent" ? "lent" : "agent";
    const title = document.createElement("span");
    title.className = "t";
    title.textContent = `${t.title || t.url} ${t.session ? `· ${t.session}` : ""}`;
    title.title = t.url;
    li.append(k, title);
    if (t.kind === "lent") {
      const b = document.createElement("button");
      b.textContent = "Take back";
      b.onclick = async () => {
        await browser.runtime.sendMessage({ type: "options.release", tabId: t.tabId });
        refresh();
      };
      li.append(b);
    }
    list.append(li);
  }
  $("#versions").textContent = `Extension ${s.extension} · Firefox ${s.firefox} · tab groups ${s.tabGroups ? "supported" : "not available"}`;
}

$("#reconnect").onclick = async () => {
  $("#status-title").textContent = "Reconnecting…";
  await browser.runtime.sendMessage({ type: "options.reconnect" });
  setTimeout(refresh, 800);
};

$("#settings").addEventListener("change", async (e) => {
  const el = e.target;
  let value = el.value;
  if (el.name === "idleMinutes") value = Number(value);
  if (["cursor", "humanInput", "handoffNotifications"].includes(el.name)) value = value === "true";
  await browser.runtime.sendMessage({ type: "options.settings", values: { [el.name]: value } });
  $("#saved").textContent = "Saved. Applies right away.";
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($("#saved").textContent = ""), 2500);
});

refresh();
setInterval(refresh, 3000);
