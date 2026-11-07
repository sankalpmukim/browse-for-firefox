// browse for Firefox — page agent.
// Injected on demand, only into tabs agents use. Runs in Firefox's isolated content-script world: the page
// can't see these functions or variables. It can pierce *closed* shadow roots (openOrClosedShadowRoot),
// which page scripts and Chromium's DOM APIs can't.

(() => {
  if (window.__browseFx) return;

  const refs = new Map(); // "e12" -> WeakRef(element)
  const elementRefs = new WeakMap(); // element -> "e12"
  let refCounter = 0;
  let lastHover = null;

  // ---------- small helpers ----------

  // Firefox clamps timers in background tabs to >= 1s, and agent tabs live in the background, so pacing
  // waits are timed by the (unthrottled) background page instead.
  const sleep = (ms) => (document.hidden && ms > 0 ? browser.runtime.sendMessage({ type: "browse-sleep", ms }) : new Promise((r) => setTimeout(r, ms)));
  const normalize = (s) => String(s ?? "").replace(/[\s ​]+/g, " ").trim();
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const jitter = (lo, hi) => lo + Math.random() * (hi - lo);

  function fail(message, code, data) {
    const e = new Error(message);
    e.code = code;
    e.data = data;
    throw e;
  }

  const shadowOf = (el) => el.openOrClosedShadowRoot || el.shadowRoot || null;

  /** Every element under `root`, including inside open and closed shadow roots. */
  function* deepElements(root) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      const children = node.children ? [...node.children] : [];
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      if (node.nodeType === 1) {
        if (node !== root) yield node;
        const sr = shadowOf(node);
        if (sr) stack.push(sr);
      }
    }
  }

  function composedParent(node) {
    if (node.assignedSlot) return node.assignedSlot;
    if (node.parentNode && node.parentNode.nodeType === 11 && node.parentNode.host) return node.parentNode.host;
    return node.parentElement || node.parentNode?.host || null;
  }

  function containsComposed(ancestor, node) {
    for (let n = node; n; n = composedParent(n)) if (n === ancestor) return true;
    return false;
  }

  function deepActiveElement() {
    let a = document.activeElement;
    while (a && shadowOf(a)?.activeElement) a = shadowOf(a).activeElement;
    return a && a !== document.body ? a : document.body;
  }

  function deepElementFromPoint(x, y) {
    let e = document.elementFromPoint(x, y);
    while (e && shadowOf(e)) {
      const inner = shadowOf(e).elementFromPoint(x, y);
      if (!inner || inner === e) break;
      e = inner;
    }
    return e;
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return String(el);
    let s = `<${el.localName}`;
    if (el.id) s += ` id="${el.id}"`;
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 3).join(" ") : "";
    if (cls) s += ` class="${cls}"`;
    for (const a of ["name", "type", "role", "aria-label", "href", "placeholder", "data-testid"]) {
      const v = el.getAttribute(a);
      if (v) s += ` ${a}="${clip(v, 60)}"`;
    }
    s += ">";
    const text = clip(normalize(el.innerText ?? el.textContent), 60);
    return text ? `${s} "${text}"` : s;
  }

  function serialize(value, depth = 0, seen = new WeakSet()) {
    if (value === undefined || value === null) return null;
    const t = typeof value;
    if (t === "string" || t === "number" || t === "boolean") return value;
    if (t === "bigint") return `${value}n`;
    if (t === "function") return "[function]";
    if (t === "symbol") return String(value);
    if (depth > 6) return "[…]";
    try {
      if (value.nodeType === 1) return describe(value);
      if (value.nodeType === 3) return value.textContent;
      if (value.nodeType === 9) return `[document ${value.URL}]`;
    } catch {}
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (value instanceof Error || (value && typeof value.message === "string" && typeof value.stack === "string")) return { name: value.name, message: value.message };
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Map) return [...value].map(([k, v]) => [serialize(k, depth + 1, seen), serialize(v, depth + 1, seen)]);
    if (value instanceof Set) return [...value].map((v) => serialize(v, depth + 1, seen));
    if (Array.isArray(value) || value instanceof NodeList || value instanceof HTMLCollection) return [...value].slice(0, 500).map((v) => serialize(v, depth + 1, seen));
    const out = {};
    let n = 0;
    for (const k of Object.keys(value)) {
      if (n++ > 200) break;
      try {
        out[k] = serialize(value[k], depth + 1, seen);
      } catch {
        out[k] = "[unreadable]";
      }
    }
    return out;
  }

  function makeMatcher(spec) {
    if (spec == null) return () => true;
    if (typeof spec === "object" && spec.regex != null) {
      const re = new RegExp(spec.regex, spec.flags || "");
      return (t) => re.test(normalize(t));
    }
    const exact = typeof spec === "object" ? !!spec.exact : false;
    const want = normalize(typeof spec === "object" ? spec.text : spec);
    if (exact) return (t) => normalize(t) === want;
    const lower = want.toLowerCase();
    return (t) => normalize(t).toLowerCase().includes(lower);
  }

  // ---------- visibility, roles and names ----------

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === "function") {
      if (!el.checkVisibility({ checkVisibilityCSS: true })) {
        // display:contents has no box, but its children can be visible.
        if (getComputedStyle(el).display !== "contents") return false;
        return [...el.children].some(isVisible);
      }
    }
    const rects = el.getClientRects();
    if (!rects.length) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  const INPUT_ROLES = { button: "button", submit: "button", reset: "button", image: "button", checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", file: "button", color: "button" };

  function implicitRole(el) {
    const tag = el.localName;
    switch (tag) {
      case "a":
      case "area":
        return el.hasAttribute("href") ? "link" : null;
      case "button":
        return "button";
      case "input": {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (type === "hidden") return null;
        if (INPUT_ROLES[type]) return INPUT_ROLES[type];
        if (type === "search") return el.hasAttribute("list") ? "combobox" : "searchbox";
        return el.hasAttribute("list") ? "combobox" : "textbox";
      }
      case "select":
        return el.multiple || el.size > 1 ? "listbox" : "combobox";
      case "textarea":
        return "textbox";
      case "option":
        return "option";
      case "img":
        return el.getAttribute("alt") === "" && !el.hasAttribute("title") ? null : "img";
      case "svg":
        return el.getAttribute("aria-label") || el.querySelector?.(":scope > title") ? "img" : null;
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return "heading";
      case "nav":
        return "navigation";
      case "main":
        return "main";
      case "aside":
        return "complementary";
      case "header":
        return el.closest("article,aside,main,nav,section") ? null : "banner";
      case "footer":
        return el.closest("article,aside,main,nav,section") ? null : "contentinfo";
      case "form":
        return "form";
      case "search":
        return "search";
      case "section":
        return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : null;
      case "article":
        return "article";
      case "ul":
      case "ol":
      case "menu":
        return "list";
      case "li":
        return "listitem";
      case "table":
        return "table";
      case "tr":
        return "row";
      case "th":
        return el.getAttribute("scope") === "row" ? "rowheader" : "columnheader";
      case "td":
        return "cell";
      case "thead":
      case "tbody":
      case "tfoot":
        return "rowgroup";
      case "dialog":
        return "dialog";
      case "details":
      case "fieldset":
        return "group";
      case "summary":
        return "button";
      case "p":
        return "paragraph";
      case "blockquote":
        return "blockquote";
      case "figure":
        return "figure";
      case "hr":
        return "separator";
      case "progress":
        return "progressbar";
      case "meter":
        return "meter";
      case "output":
        return "status";
      case "iframe":
      case "frame":
        return "iframe";
      case "dt":
        return "term";
      case "dd":
        return "definition";
    }
    if (el.isContentEditable && el.hasAttribute("contenteditable")) return "textbox";
    return null;
  }

  function roleOf(el) {
    const explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
    if (explicit === "none" || explicit === "presentation") return null;
    return explicit || implicitRole(el);
  }

  const NAME_FROM_CONTENT = new Set(["button", "link", "heading", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "cell", "columnheader", "rowheader", "treeitem", "checkbox", "radio", "switch", "tooltip", "term"]);

  function textOf(el, exclude) {
    let t = exclude ? composedText(el, exclude) : (el.innerText ?? el.textContent ?? "");
    // innerText doesn't include shadow DOM; walk the composed tree when it comes back empty.
    if (!normalize(t) && (shadowOf(el) || el.firstElementChild)) t = composedText(el, exclude);
    t = normalize(t);
    if (!t) {
      const labelled = el.querySelector?.("img[alt],[aria-label],svg title");
      if (labelled) t = normalize(labelled.getAttribute?.("alt") || labelled.getAttribute?.("aria-label") || labelled.textContent);
    }
    return t;
  }

  function composedText(el, exclude, depth = 0) {
    if (depth > 30) return "";
    let out = "";
    const kids = shadowOf(el) ? shadowOf(el).childNodes : el.localName === "slot" ? (el.assignedNodes({ flatten: true }).length ? el.assignedNodes({ flatten: true }) : el.childNodes) : el.childNodes;
    for (const n of kids) {
      if (n === exclude) continue;
      if (n.nodeType === 3) out += n.textContent;
      else if (n.nodeType === 1 && !["script", "style", "template"].includes(n.localName)) {
        if (n.localName === "img") out += n.getAttribute("alt") || "";
        else out += " " + composedText(n, exclude, depth + 1) + " ";
      }
    }
    return out;
  }

  function nameOf(el, role = roleOf(el)) {
    const tag = el.localName;
    let n = "";
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const root = el.getRootNode();
      n = labelledBy
        .split(/\s+/)
        .map((id) => {
          const t = root.getElementById?.(id) || document.getElementById(id);
          return t ? textOf(t) : "";
        })
        .join(" ");
    }
    if (!n) n = el.getAttribute("aria-label") || "";
    if (!n && ["input", "select", "textarea", "meter", "progress", "output"].includes(tag)) {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) n = el.value || { submit: "Submit", reset: "Reset" }[type] || "";
      if (!n && type === "image") n = el.getAttribute("alt") || "Submit";
      if (!n && el.labels?.length) n = [...el.labels].map((l) => textOf(l, el)).join(" ");
      if (!n) n = el.getAttribute("placeholder") || "";
    }
    if (!n && (tag === "img" || tag === "area")) n = el.getAttribute("alt") || "";
    if (!n && tag === "svg") n = el.querySelector(":scope > title")?.textContent || "";
    if (!n && tag === "fieldset") n = el.querySelector(":scope > legend")?.textContent || "";
    if (!n && tag === "table") n = el.querySelector(":scope > caption")?.textContent || "";
    if (!n && tag === "figure") n = el.querySelector(":scope > figcaption")?.textContent || "";
    if (!n && (tag === "iframe" || tag === "frame")) n = el.getAttribute("title") || el.getAttribute("name") || "";
    if (!n && NAME_FROM_CONTENT.has(role)) n = textOf(el);
    if (!n) n = el.getAttribute("title") || "";
    return clip(normalize(n), 150);
  }

  function isDisabled(el) {
    if (el.disabled) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    const fs = el.closest("fieldset[disabled]");
    if (fs && !fs.querySelector(":scope > legend")?.contains(el)) return true;
    return false;
  }

  function checkedState(el) {
    if (el.localName === "input" && (el.type === "checkbox" || el.type === "radio")) return el.indeterminate ? "mixed" : el.checked;
    const a = el.getAttribute("aria-checked");
    if (a === "mixed") return "mixed";
    if (a != null) return a === "true";
    return null;
  }

  // ---------- refs ----------

  function refFor(el) {
    let id = elementRefs.get(el);
    if (id && refs.get(id)?.deref() === el) return id;
    id = `e${++refCounter}`;
    elementRefs.set(el, id);
    refs.set(id, new WeakRef(el));
    return id;
  }

  function fromRef(id) {
    const el = refs.get(id)?.deref();
    if (!el || !el.isConnected) fail(`Ref ${id} is stale (the page changed or navigated). Take a new snapshot.`, "stale_ref");
    return el;
  }

  // ---------- snapshot ----------

  const LEAF_ROLES = new Set(["link", "button", "textbox", "searchbox", "checkbox", "radio", "combobox", "slider", "spinbutton", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "img", "heading", "progressbar", "meter", "separator", "iframe"]);
  const REF_ROLES = new Set([...LEAF_ROLES].filter((r) => !["separator", "progressbar", "meter"].includes(r)));
  const TRANSPARENT_ROLES = new Set(["rowgroup", "generic", "none", "presentation"]);
  const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "title", "base"]);
  const INTERESTING =
    "a[href],button,input:not([type=hidden]),select,textarea,[role],h1,h2,h3,h4,h5,h6,ul,ol,table,img[alt]:not([alt='']),iframe,frame,[contenteditable],nav,main,header,footer,aside,form,dialog,details,summary,[tabindex],[onclick],p,li,section[aria-label],svg[aria-label],dl";

  function isClickableGeneric(el, style) {
    if (el.hasAttribute("onclick")) return true;
    const ti = el.getAttribute("tabindex");
    if (ti != null && Number(ti) >= 0) return true;
    if (style.cursor === "pointer") {
      const parent = composedParent(el);
      if (!parent || parent.nodeType !== 1) return true;
      try {
        return getComputedStyle(parent).cursor !== "pointer";
      } catch {
        return true;
      }
    }
    return false;
  }

  function linkTarget(el) {
    const href = el.getAttribute("href");
    if (!href || href.startsWith("javascript:")) return "";
    try {
      const u = new URL(href, location.href);
      if (u.origin === location.origin) return clip(u.pathname + u.search + u.hash, 80);
      return clip(u.href, 100);
    } catch {
      return clip(href, 80);
    }
  }

  function snapshot({ maxChars = 24000, maxNodes = 20000, interactiveOnly = false, root: rootSteps } = {}) {
    const lines = [];
    const shadowAncestors = new WeakSet();
    // Mark elements that have shadow roots somewhere beneath them, so text collapsing doesn't hide their controls.
    for (const el of deepElements(document.documentElement)) {
      if (shadowOf(el)) for (let n = el; n && n.nodeType === 1 && !shadowAncestors.has(n); n = composedParent(n)) shadowAncestors.add(n);
    }
    let visited = 0;
    let truncated = false;
    const active = deepActiveElement();

    const push = (depth, line) => {
      if (truncated) return;
      lines.push(`${"  ".repeat(depth)}- ${line}`);
    };

    const hasInteresting = (el) => shadowAncestors.has(el) || !!el.querySelector(INTERESTING);

    function attrs(el, role) {
      const out = [];
      if (role === "heading") out.push(`level=${el.localName.match(/^h(\d)$/)?.[1] || el.getAttribute("aria-level") || 2}`);
      const c = checkedState(el);
      if (c === true) out.push("checked");
      else if (c === "mixed") out.push("checked=mixed");
      if (isDisabled(el)) out.push("disabled");
      const exp = el.getAttribute("aria-expanded");
      if (exp != null) out.push(exp === "true" ? "expanded" : "collapsed");
      if (el.getAttribute("aria-selected") === "true" || (el.localName === "option" && el.selected)) out.push("selected");
      const pressed = el.getAttribute("aria-pressed");
      if (pressed === "true") out.push("pressed");
      if (el.required || el.getAttribute("aria-required") === "true") out.push("required");
      if (el.localName === "input" && el.type === "password") out.push("password");
      if (el.localName === "select" && !el.multiple) {
        const opt = el.selectedOptions?.[0];
        if (opt) out.push(`value="${clip(normalize(opt.label || opt.textContent), 50)}"`);
      } else if ((role === "textbox" || role === "searchbox" || role === "combobox") && (el.value || (el.isContentEditable && normalize(el.textContent)))) {
        out.push("filled");
      }
      if (role === "slider" || role === "spinbutton") out.push(`value=${el.value ?? el.getAttribute("aria-valuenow") ?? ""}`);
      if (el === active) out.push("focused");
      if (el.getAttribute("aria-invalid") === "true") out.push("invalid");
      return out.length ? ` [${out.join("] [")}]` : "";
    }

    function emitText(depth, text) {
      const t = normalize(text);
      if (!t || interactiveOnly) return;
      const last = lines[lines.length - 1];
      const line = `text: ${JSON.stringify(clip(t, 300))}`;
      if (last && last.endsWith(line)) return;
      push(depth, line);
    }

    function walkChildren(el, depth) {
      const sr = shadowOf(el);
      let kids;
      if (sr) kids = sr.childNodes;
      else if (el.localName === "slot") {
        const assigned = el.assignedNodes({ flatten: true });
        kids = assigned.length ? assigned : el.childNodes;
      } else kids = el.childNodes;
      for (const n of kids) {
        if (truncated) return;
        if (n.nodeType === 3) emitText(depth, n.textContent);
        else if (n.nodeType === 1) walk(n, depth);
      }
    }

    function walk(el, depth) {
      if (truncated) return;
      if (++visited > maxNodes) {
        truncated = true;
        return;
      }
      if (SKIP_TAGS.has(el.localName)) return;
      if (el.getAttribute("aria-hidden") === "true") return;
      let style;
      try {
        style = getComputedStyle(el);
      } catch {
        return;
      }
      if (style.display === "none") return;
      if (style.display !== "contents" && !el.getClientRects().length && el.localName !== "slot") {
        // No box: skip, unless it is a shadow host/slot that renders children elsewhere.
        if (!shadowOf(el)) return;
      }
      const hiddenSelf = style.visibility === "hidden" || style.visibility === "collapse";
      const role = hiddenSelf ? null : roleOf(el);

      if (role && LEAF_ROLES.has(role)) {
        if (role === "option" && el.closest("select:not([multiple])")) return;
        const name = nameOf(el, role);
        if (role === "img" && !name) return;
        let line = `${role}${name ? ` ${JSON.stringify(name)}` : ""}${attrs(el, role)}`;
        if (REF_ROLES.has(role)) line += ` [ref=${refFor(el)}]`;
        if (role === "link") {
          const target = linkTarget(el);
          if (target) line += ` -> ${target}`;
        }
        if (role === "iframe") line += ` src=${clip(el.src || "", 100)} (snapshot it with frameId from the frames list)`;
        if (!interactiveOnly || REF_ROLES.has(role)) push(depth, line);
        if (role === "combobox" && el.localName !== "select" && el.getAttribute("aria-expanded") === "true") {
          // An open custom combobox: its listbox is often elsewhere; no descent needed here.
        }
        return;
      }

      if (role && !TRANSPARENT_ROLES.has(role)) {
        const name = ["listitem", "paragraph", "cell", "row", "blockquote", "term", "definition"].includes(role) ? el.getAttribute("aria-label") || "" : nameOf(el, role);
        const label = `${role}${name ? ` ${JSON.stringify(clip(name, 100))}` : ""}${attrs(el, role)}`;
        if (!hasInteresting(el)) {
          const text = normalize(el.innerText ?? el.textContent);
          if (interactiveOnly) return;
          push(depth, text && text !== name ? `${label}: ${JSON.stringify(clip(text, 300))}` : label);
          return;
        }
        if (!interactiveOnly) push(depth, label);
        walkChildren(el, interactiveOnly ? depth : depth + 1);
        return;
      }

      // Generic element: transparent, but clickable divs get a ref and leaf text is collapsed into one line.
      if (!hiddenSelf && isClickableGeneric(el, style) && !hasInteresting(el)) {
        const text = clip(normalize(el.innerText ?? el.textContent), 120);
        if (text || el.getAttribute("aria-label")) {
          push(depth, `generic ${JSON.stringify(el.getAttribute("aria-label") || text)} [clickable] [ref=${refFor(el)}]`);
          return;
        }
      }
      if (!hasInteresting(el)) {
        if (!hiddenSelf) emitText(depth, el.innerText ?? el.textContent);
        return;
      }
      walkChildren(el, depth);
    }

    let start = document.body || document.documentElement;
    if (rootSteps) start = resolveOne(rootSteps).element;
    walk(start, 0);

    const docEl = document.documentElement;
    const scrollHeight = Math.max(docEl.scrollHeight, document.body?.scrollHeight || 0);
    const header = [
      `Page: ${document.title || "(untitled)"}`,
      `URL: ${location.href}`,
      `Viewport: ${innerWidth}x${innerHeight}, scrolled ${Math.round(scrollY)} of ${scrollHeight}px${scrollHeight > innerHeight ? ` (${Math.round(((scrollY + innerHeight) / scrollHeight) * 100)}% seen)` : ""}`,
    ];
    const dialogs = [...document.querySelectorAll("dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]")].filter(isVisible);
    if (dialogs.length) header.push(`Open dialog: ${dialogs.map((d) => JSON.stringify(nameOf(d) || "unnamed")).join(", ")}`);
    let body = lines.join("\n");
    if (body.length > maxChars) {
      body = body.slice(0, maxChars);
      body = body.slice(0, body.lastIndexOf("\n"));
      truncated = true;
    }
    if (truncated) body += `\n… snapshot truncated. Narrow it with find, root, interactiveOnly, or scroll and snapshot again.`;
    return { text: `${header.join("\n")}\n\n${body}`, url: location.href, title: document.title, truncated };
  }

  // ---------- locators ----------

  function unquote(v) {
    const m = v.match(/^(["'])(.*)\1([is]?)$/s);
    if (m) return { text: m[2], exact: m[3] !== "i" };
    const r = v.match(/^\/(.*)\/([gimsuy]*)$/s);
    if (r) return { regex: r[1], flags: r[2] };
    return { text: v, exact: false };
  }

  /** "Save", "Sign in", "Buy cherry": words that aren't HTML tags are meant as visible text, not CSS. */
  function looksLikeText(part) {
    if (!/^[\p{L}\p{N}][\p{L}\p{N}\s'’!?,&-]*$/u.test(part)) return false;
    const words = part.trim().split(/\s+/);
    return words.some((w) => w.includes("-") || !/^[a-z][a-z0-9]*$/.test(w) || document.createElement(w) instanceof HTMLUnknownElement);
  }

  /** Parse a Playwright-flavoured selector string into locator steps. */
  function parseSelector(selector) {
    const steps = [];
    for (let part of String(selector).split(/\s+>>\s+/)) {
      part = part.trim();
      if (/^e\d+$/.test(part)) steps.push({ kind: "ref", value: part });
      else if (part.startsWith("ref=")) steps.push({ kind: "ref", value: part.slice(4) });
      else if (part.startsWith("text=")) steps.push({ kind: "text", match: unquote(part.slice(5)) });
      else if (part.startsWith("xpath=")) steps.push({ kind: "xpath", value: part.slice(6) });
      else if (part.startsWith("//") || part.startsWith("(//")) steps.push({ kind: "xpath", value: part });
      else if (part.startsWith("css=")) steps.push({ kind: "css", value: part.slice(4) });
      else if (part.startsWith("id=")) steps.push({ kind: "css", value: `[id="${part.slice(3)}"]` });
      else if (part.startsWith("data-testid=")) steps.push({ kind: "testid", match: unquote(part.slice(12)) });
      else if (part.startsWith("role=")) {
        const m = part.match(/^role=([a-z]+)(.*)$/i);
        const step = { kind: "role", role: m[1] };
        const name = m[2].match(/\[name=(.+?)\]/);
        if (name) step.name = unquote(name[1]);
        steps.push(step);
      } else if (/^nth=-?\d+$/.test(part)) steps.push({ kind: "nth", index: Number(part.slice(4)) });
      else if (looksLikeText(part)) steps.push({ kind: "text", match: { text: part, exact: false } });
      else {
        // CSS, with Playwright's :has-text(), :text(), :text-is() and :visible extensions.
        let css = part;
        const filters = [];
        css = css.replace(/:has-text\((["'])(.*?)\1\)/g, (_, q, t) => (filters.push({ kind: "filter", hasText: { text: t, exact: false } }), ""));
        css = css.replace(/:text-is\((["'])(.*?)\1\)/g, (_, q, t) => (filters.push({ kind: "text", match: { text: t, exact: true }, self: true }), ""));
        css = css.replace(/:text\((["'])(.*?)\1\)/g, (_, q, t) => (filters.push({ kind: "text", match: { text: t, exact: false }, self: true }), ""));
        css = css.replace(/:visible/g, () => (filters.push({ kind: "filter", visible: true }), ""));
        steps.push({ kind: "css", value: css.trim() || "*" });
        steps.push(...filters);
      }
    }
    return steps;
  }

  function cssDeep(root, css) {
    const out = [];
    const scopes = [root];
    for (const el of deepElements(root)) if (shadowOf(el)) scopes.push(shadowOf(el));
    for (const scope of scopes) {
      try {
        for (const el of scope.querySelectorAll(css)) out.push(el);
      } catch (err) {
        fail(`Invalid CSS selector "${css}": ${err.message}`, "bad_selector");
      }
    }
    return out;
  }

  function fullText(el) {
    if (el.localName === "input" && ["button", "submit", "reset"].includes(el.type)) return el.value;
    return shadowOf(el) ? composedText(el) : el.textContent;
  }

  function byText(roots, matcher, { self = false } = {}) {
    const out = [];
    for (const root of roots) {
      const candidates = self ? [root] : deepElements(root);
      for (const el of candidates) {
        if (SKIP_TAGS.has(el.localName)) continue;
        if (!matcher(fullText(el))) continue;
        // Keep the innermost element whose text matches.
        let childMatches = false;
        for (const child of shadowOf(el) ? shadowOf(el).children : el.children) {
          if (!SKIP_TAGS.has(child.localName) && matcher(fullText(child))) {
            childMatches = true;
            break;
          }
        }
        if (!childMatches || self) out.push(el);
      }
    }
    return out;
  }

  function labelTexts(el) {
    const texts = [];
    if (el.labels) for (const l of el.labels) texts.push(textOf(l, el));
    const aria = el.getAttribute("aria-label");
    if (aria) texts.push(aria);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) texts.push(nameOf(el));
    return texts;
  }

  function applyStep(set, step, isFirst) {
    const roots = isFirst ? [document.documentElement] : set;
    const all = () => {
      const out = [];
      for (const r of roots) {
        if (isFirst) out.push(r);
        for (const el of deepElements(r)) out.push(el);
      }
      return out;
    };
    switch (step.kind) {
      case "css":
        return roots.flatMap((r) => cssDeep(r, step.value));
      case "xpath": {
        const out = [];
        for (const r of roots) {
          const res = document.evaluate(step.value, r, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let i = 0; i < res.snapshotLength; i++) if (res.snapshotItem(i).nodeType === 1) out.push(res.snapshotItem(i));
        }
        return out;
      }
      case "ref":
        return [fromRef(step.value)];
      case "text":
        return step.self ? set.filter((el) => makeMatcher(step.match)(fullText(el))) : byText(roots, makeMatcher(step.match));
      case "role": {
        const nameMatch = step.name != null ? makeMatcher(step.name) : null;
        return all().filter((el) => {
          if (roleOf(el) !== step.role) return false;
          if (!step.includeHidden && !isVisible(el) && !(el.localName === "input" && el.labels?.length && [...el.labels].some(isVisible))) return false;
          if (nameMatch && !nameMatch(nameOf(el, step.role))) return false;
          if (step.checked != null && checkedState(el) !== step.checked) return false;
          if (step.disabled != null && isDisabled(el) !== step.disabled) return false;
          if (step.expanded != null && (el.getAttribute("aria-expanded") === "true") !== step.expanded) return false;
          if (step.selected != null && (el.getAttribute("aria-selected") === "true" || !!el.selected) !== step.selected) return false;
          if (step.pressed != null && (el.getAttribute("aria-pressed") === "true") !== step.pressed) return false;
          if (step.level != null && Number(el.localName.match(/^h(\d)$/)?.[1] || el.getAttribute("aria-level")) !== step.level) return false;
          return true;
        });
      }
      case "label": {
        const m = makeMatcher(step.match);
        return all().filter((el) => ["input", "select", "textarea"].includes(el.localName) || el.isContentEditable || el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby")).filter((el) => labelTexts(el).some(m));
      }
      case "placeholder": {
        const m = makeMatcher(step.match);
        return all().filter((el) => el.hasAttribute("placeholder") && m(el.getAttribute("placeholder")));
      }
      case "alt": {
        const m = makeMatcher(step.match);
        return all().filter((el) => el.hasAttribute("alt") && m(el.getAttribute("alt")));
      }
      case "title": {
        const m = makeMatcher(step.match);
        return all().filter((el) => el.hasAttribute("title") && m(el.getAttribute("title")));
      }
      case "testid": {
        const m = makeMatcher({ ...step.match, exact: true });
        return all().filter((el) => el.hasAttribute("data-testid") && m(el.getAttribute("data-testid")));
      }
      case "nth": {
        const i = step.index < 0 ? set.length + step.index : step.index;
        return set[i] ? [set[i]] : [];
      }
      case "filter": {
        let out = set;
        if (step.hasText != null) {
          const m = makeMatcher(step.hasText);
          out = out.filter((el) => m(fullText(el)));
        }
        if (step.hasNotText != null) {
          const m = makeMatcher(step.hasNotText);
          out = out.filter((el) => !m(fullText(el)));
        }
        if (step.has) out = out.filter((el) => resolveSteps(toSteps(step.has), [el]).length > 0);
        if (step.hasNot) out = out.filter((el) => resolveSteps(toSteps(step.hasNot), [el]).length === 0);
        if (step.visible != null) out = out.filter((el) => isVisible(el) === step.visible);
        return out;
      }
      default:
        fail(`Unknown locator step ${step.kind}`, "bad_selector");
    }
  }

  function resolveSteps(steps, scope) {
    let set = scope || [];
    steps.forEach((step, i) => {
      set = applyStep(set, step, i === 0 && !scope);
      set = [...new Set(set)];
    });
    return set;
  }

  function toSteps(locator) {
    if (!locator) fail("No target given", "bad_selector");
    if (typeof locator === "string") return parseSelector(locator);
    if (Array.isArray(locator)) return locator.flatMap((s) => (typeof s === "string" ? parseSelector(s) : [s]));
    if (locator.steps) return toSteps(locator.steps);
    return [locator];
  }

  function resolveAll(locator) {
    return resolveSteps(toSteps(locator));
  }

  /** Exactly one element, Playwright-style strictness — but a single visible match among hidden duplicates wins. */
  function resolveOne(locator, { allowHidden = false } = {}) {
    const steps = toSteps(locator);
    const found = resolveSteps(steps);
    if (!found.length) fail(`No element matches ${JSON.stringify(locator)}`, "not_found");
    if (found.length === 1) return { element: found[0], steps };
    const visible = found.filter(isVisible);
    if (visible.length === 1 && !allowHidden) return { element: visible[0], steps };
    fail(`Strict mode: ${JSON.stringify(locator)} matches ${found.length} elements (${visible.length} visible). Narrow it, e.g. with a ref from snapshot, .first(), .nth(i) or a more specific name:\n${found
      .slice(0, 6)
      .map((el, i) => `  ${i + 1}. ${describe(el)}${isVisible(el) ? "" : " (hidden)"} [ref=${refFor(el)}]`)
      .join("\n")}`, "strict");
  }

  // ---------- input ----------

  let cursorHost = null;
  let cursorEl = null;

  function ensureCursor() {
    if (cursorHost?.isConnected) return;
    cursorHost = document.createElement("div");
    const sr = cursorHost.attachShadow({ mode: "closed" });
    sr.innerHTML = `<style>:host{all:initial}div{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transition:transform .28s cubic-bezier(.3,.7,.4,1);filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}</style><div><svg viewBox="0 0 24 24" width="22" height="22"><path d="M3 2l7 19 2.5-8L21 10z" fill="#7c3aed" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg></div>`;
    cursorEl = sr.querySelector("div");
    (document.body || document.documentElement).appendChild(cursorHost);
  }

  async function moveCursor(x, y, args) {
    if (!args.cursor) {
      cursorHost?.remove();
      return;
    }
    ensureCursor();
    cursorEl.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
    await sleep(args.humanInput ? 300 : 30);
  }

  function modifierState(mods = []) {
    const m = mods.map((x) => x.toLowerCase());
    const meta = m.includes("meta") || (m.includes("controlormeta") && navigator.platform.startsWith("Mac"));
    const ctrl = m.includes("control") || m.includes("ctrl") || (m.includes("controlormeta") && !navigator.platform.startsWith("Mac"));
    return { ctrlKey: ctrl, metaKey: meta, shiftKey: m.includes("shift"), altKey: m.includes("alt") };
  }

  function mouseInit(x, y, extra = {}) {
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x + (window.mozInnerScreenX || 0),
      screenY: y + (window.mozInnerScreenY || 0),
      ...extra,
    };
  }

  function firePointer(el, type, x, y, extra) {
    const init = mouseInit(x, y, { pointerId: 1, pointerType: "mouse", isPrimary: true, ...extra });
    return el.dispatchEvent(new PointerEvent(type, init));
  }

  function fireMouse(el, type, x, y, extra) {
    return el.dispatchEvent(new MouseEvent(type, mouseInit(x, y, extra)));
  }

  function scrollIntoViewIfNeeded(el) {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  }

  function clickPoint(el, position) {
    const rects = [...el.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    const r = rects.find((rr) => rr.top >= 0 && rr.bottom <= innerHeight) || rects[0] || el.getBoundingClientRect();
    if (position) return { x: r.left + position.x, y: r.top + position.y };
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function focusableAncestor(el) {
    for (let n = el; n && n.nodeType === 1; n = composedParent(n)) {
      if (n.matches?.("a[href],button,input,select,textarea,summary,[tabindex],[contenteditable]") && !n.disabled) return n;
    }
    return null;
  }

  /** Make sure `el` is the element that would receive a real click at its centre. */
  function actionable(el, { force, position } = {}) {
    if (!el.isConnected) fail("Element was removed from the page", "not_found");
    let target = el;
    if (!isVisible(el)) {
      // Visually hidden checkbox/radio styled through its <label>: click the label instead.
      const label = el.labels && [...el.labels].find(isVisible);
      if (label) target = label;
      else if (!force) fail(`Element is not visible: ${describe(el)}`, "not_visible");
    }
    if (!force && isDisabled(el)) fail(`Element is disabled: ${describe(el)}`, "disabled");
    scrollIntoViewIfNeeded(target);
    const { x, y } = clickPoint(target, position);
    if (!force) {
      const hit = deepElementFromPoint(x, y);
      const ok = hit && (containsComposed(target, hit) || containsComposed(hit, target) || (el.labels && [...el.labels].some((l) => containsComposed(l, hit))));
      if (!ok) fail(`Click would land on another element: ${describe(hit)} covers ${describe(el)}. Close the overlay first, or pass force: true.`, "intercepted", { hit: describe(hit) });
    }
    return { target, x, y };
  }

  async function click(el, args = {}) {
    const { target, x, y } = actionable(el, args);
    const mods = modifierState(args.modifiers);
    const button = { left: 0, middle: 1, right: 2 }[args.button || "left"];
    const buttons = [1, 4, 2][button];
    const count = args.clickCount || 1;
    await moveCursor(x, y, args);
    hoverEvents(target, x, y, mods);
    if (args.humanInput) await sleep(jitter(40, 110));

    // Links that open a new tab: popup blockers stop synthetic clicks, so the extension opens them as agent popups.
    const anchor = (() => {
      for (let n = target; n && n.nodeType === 1; n = composedParent(n)) if (n.localName === "a" && n.hasAttribute("href")) return n;
      return null;
    })();
    const opensNewTab = anchor && button === 0 && (anchor.target === "_blank" || mods.metaKey || mods.ctrlKey);
    let popup = null;
    const onClick = (ev) => {
      if (!opensNewTab || ev.defaultPrevented) return;
      ev.preventDefault();
      popup = anchor.href;
    };
    if (opensNewTab) window.addEventListener("click", onClick, false);
    try {
      for (let i = 1; i <= count; i++) {
        firePointer(target, "pointerdown", x, y, { ...mods, button, buttons, detail: i });
        fireMouse(target, "mousedown", x, y, { ...mods, button, buttons, detail: i });
        if (i === 1) {
          const f = focusableAncestor(target);
          if (f && deepActiveElement() !== f) f.focus({ preventScroll: true });
        }
        if (args.humanInput) await sleep(jitter(30, 90));
        firePointer(target, "pointerup", x, y, { ...mods, button, buttons: 0, detail: i });
        fireMouse(target, "mouseup", x, y, { ...mods, button, buttons: 0, detail: i });
        if (button === 2) fireMouse(target, "contextmenu", x, y, { ...mods, button, buttons: 0, detail: i });
        else if (button === 1) fireMouse(target, "auxclick", x, y, { ...mods, button, buttons: 0, detail: i });
        else fireMouse(target, "click", x, y, { ...mods, button, buttons: 0, detail: i });
        if (i === 2) fireMouse(target, "dblclick", x, y, { ...mods, button, buttons: 0, detail: 2 });
      }
    } finally {
      if (opensNewTab) window.removeEventListener("click", onClick, false);
    }
    if (popup) {
      const r = await browser.runtime.sendMessage({ type: "open-popup", url: popup });
      return { clicked: describe(el), popup: r || { url: popup } };
    }
    return { clicked: describe(el) };
  }

  function hoverEvents(el, x, y, mods = {}) {
    if (lastHover && lastHover !== el && lastHover.isConnected) {
      firePointer(lastHover, "pointerout", x, y, mods);
      fireMouse(lastHover, "mouseout", x, y, mods);
      lastHover.dispatchEvent(new MouseEvent("mouseleave", { ...mouseInit(x, y, mods), bubbles: false }));
    }
    firePointer(el, "pointerover", x, y, mods);
    el.dispatchEvent(new PointerEvent("pointerenter", { ...mouseInit(x, y, mods), bubbles: false, pointerType: "mouse" }));
    fireMouse(el, "mouseover", x, y, mods);
    el.dispatchEvent(new MouseEvent("mouseenter", { ...mouseInit(x, y, mods), bubbles: false }));
    firePointer(el, "pointermove", x, y, mods);
    fireMouse(el, "mousemove", x, y, mods);
    lastHover = el;
  }

  async function hover(el, args) {
    const { target, x, y } = actionable(el, args);
    await moveCursor(x, y, args);
    hoverEvents(target, x, y, modifierState(args.modifiers));
    return { hovered: describe(el) };
  }

  function editableKind(el) {
    if (el.localName === "textarea") return "text";
    if (el.localName === "input") {
      const t = (el.type || "text").toLowerCase();
      if (["checkbox", "radio", "button", "submit", "reset", "image", "file", "hidden"].includes(t)) return null;
      if (["date", "time", "datetime-local", "month", "week", "color", "range"].includes(t)) return "value";
      return "text";
    }
    if (el.isContentEditable) return "rich";
    return null;
  }

  function editableTarget(el) {
    if (editableKind(el)) return el;
    // A wrapper around one input (custom components, labels): use the input inside.
    const inner = el.querySelector?.("input:not([type=hidden]),textarea,[contenteditable]");
    if (inner && editableKind(inner)) return inner;
    if (el.localName === "label" && el.control && editableKind(el.control)) return el.control;
    return null;
  }

  function fireInput(el, data, inputType = "insertText") {
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType, data }));
  }

  function selectContents(el) {
    if (el.select && editableKind(el) === "text") {
      el.select();
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function insertText(el, text) {
    const before = el.value ?? el.textContent;
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, text);
    } catch {}
    const after = el.value ?? el.textContent;
    if (!ok || before === after) {
      // Fallback: set the value directly. Pages can tell this from typing (isTrusted: false).
      if (el.value !== undefined && el.localName !== "div") {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        el.value = el.value.slice(0, start) + text + el.value.slice(end);
        try {
          el.setSelectionRange(start + text.length, start + text.length);
        } catch {}
      } else {
        el.textContent = (el.textContent || "") + text;
      }
      fireInput(el, text);
      return false;
    }
    return true;
  }

  async function fill(el, args) {
    const target = editableTarget(el);
    if (!target) {
      if (el.localName === "select") fail("This is a <select>; use select_option (selectOption) instead.", "not_editable");
      fail(`Element is not editable: ${describe(el)}`, "not_editable");
    }
    if (target.readOnly || isDisabled(target)) fail(`Element is read-only or disabled: ${describe(target)}`, "not_editable");
    const value = String(args.value ?? "");
    if (isVisible(target)) {
      scrollIntoViewIfNeeded(target);
      const { x, y } = clickPoint(target);
      await moveCursor(x, y, args);
    }
    target.focus({ preventScroll: true });
    const kind = editableKind(target);
    let synthetic = false;
    if (kind === "value") {
      target.value = value;
      fireInput(target, value);
      synthetic = true;
    } else {
      selectContents(target);
      if (value === "") {
        try {
          document.execCommand("delete", false);
        } catch {}
        if ((target.value ?? target.textContent) !== "") {
          if (target.value !== undefined) target.value = "";
          else target.textContent = "";
          fireInput(target, null, "deleteContentBackward");
          synthetic = true;
        }
      } else if (!insertText(target, value)) synthetic = true;
    }
    target.dispatchEvent(new Event("change", { bubbles: true }));
    const now = target.value ?? normalize(target.textContent);
    return { filled: describe(target), value: target.type === "password" ? "[hidden]" : clip(String(now), 200), synthetic: synthetic || undefined };
  }

  const KEYS = {
    Enter: { code: "Enter", keyCode: 13 },
    Tab: { code: "Tab", keyCode: 9 },
    Escape: { code: "Escape", keyCode: 27 },
    Backspace: { code: "Backspace", keyCode: 8 },
    Delete: { code: "Delete", keyCode: 46 },
    ArrowUp: { code: "ArrowUp", keyCode: 38 },
    ArrowDown: { code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { code: "ArrowRight", keyCode: 39 },
    PageUp: { code: "PageUp", keyCode: 33 },
    PageDown: { code: "PageDown", keyCode: 34 },
    Home: { code: "Home", keyCode: 36 },
    End: { code: "End", keyCode: 35 },
    " ": { code: "Space", keyCode: 32 },
    Space: { code: "Space", keyCode: 32, key: " " },
  };

  function keyInfo(key) {
    if (KEYS[key]) return { key: KEYS[key].key || key, ...KEYS[key] };
    if (/^F\d{1,2}$/.test(key)) return { key, code: key, keyCode: 111 + Number(key.slice(1)) };
    if (key.length === 1) {
      const upper = key.toUpperCase();
      const code = /[a-z]/i.test(key) ? `Key${upper}` : /\d/.test(key) ? `Digit${key}` : "";
      return { key, code, keyCode: upper.charCodeAt(0) };
    }
    return { key, code: key, keyCode: 0 };
  }

  function tabbables() {
    return [...document.querySelectorAll("a[href],button,input:not([type=hidden]),select,textarea,[tabindex],[contenteditable],summary")].filter(
      (el) => !el.disabled && Number(el.getAttribute("tabindex") ?? 0) >= 0 && isVisible(el),
    );
  }

  function keyEvent(target, type, info, mods) {
    return target.dispatchEvent(
      new KeyboardEvent(type, { key: info.key, code: info.code, keyCode: info.keyCode, which: info.keyCode, charCode: type === "keypress" ? info.key.charCodeAt(0) : 0, bubbles: true, cancelable: true, composed: true, view: window, ...mods }),
    );
  }

  async function press(args) {
    let combo = String(args.key);
    let keyName;
    let modNames = [];
    if (combo === "+" || combo.endsWith("++")) {
      keyName = "+";
      modNames = combo.slice(0, -2).split("+").filter(Boolean);
    } else {
      const parts = combo.split("+");
      keyName = parts.pop();
      modNames = parts;
    }
    const mods = modifierState(modNames);
    const info = keyInfo(keyName);
    const target = deepActiveElement();
    const editable = editableTarget(target) === target ? target : null;
    const printable = info.key.length === 1 && !mods.ctrlKey && !mods.metaKey;
    const notPrevented = keyEvent(target, "keydown", info, mods);
    if (printable || info.key === "Enter") keyEvent(target, "keypress", info, mods);
    let effect = null;
    if (notPrevented) effect = await defaultKeyAction(target, editable, info, mods, printable);
    keyEvent(target, "keyup", info, mods);
    return { pressed: combo, target: describe(target), effect };
  }

  async function defaultKeyAction(target, editable, info, mods, printable) {
    const k = info.key;
    if (printable && editable) {
      insertText(editable, k);
      return "typed";
    }
    if ((mods.metaKey || mods.ctrlKey) && k.toLowerCase() === "a") {
      if (editable) selectContents(editable);
      else document.execCommand("selectAll");
      return "select-all";
    }
    if (k === "Enter") {
      if (editable && (editable.localName === "textarea" || editable.isContentEditable)) {
        document.execCommand(mods.shiftKey ? "insertLineBreak" : "insertParagraph");
        return "newline";
      }
      if (target.form && target.localName === "input") {
        const submitter = target.form.querySelector("button:not([type]),button[type=submit],input[type=submit],input[type=image]");
        if (submitter && !submitter.disabled) {
          await click(submitter, { force: true });
          return "submitted (via button)";
        }
        target.form.requestSubmit();
        return "submitted";
      }
      if (target.matches?.("a[href],button,summary,[role=button],[role=link]")) {
        await click(target, { force: true });
        return "activated";
      }
      return null;
    }
    if (k === " " && target.matches?.("button,summary,input[type=checkbox],input[type=radio],[role=button],[role=checkbox],[role=switch]")) {
      await click(target, { force: true });
      return "activated";
    }
    if (k === "Tab") {
      const list = tabbables();
      const i = list.indexOf(target);
      const next = list[(i + (mods.shiftKey ? -1 : 1) + list.length) % list.length];
      next?.focus();
      return next ? `focused ${describe(next)}` : null;
    }
    if (k === "Backspace" && editable) {
      document.execCommand("delete");
      return "deleted";
    }
    if (k === "Delete" && editable) {
      document.execCommand("forwardDelete");
      return "deleted";
    }
    if (target.localName === "select" && (k === "ArrowDown" || k === "ArrowUp")) {
      target.selectedIndex = Math.max(0, Math.min(target.options.length - 1, target.selectedIndex + (k === "ArrowDown" ? 1 : -1)));
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return "selected";
    }
    if (!editable) {
      const amounts = { ArrowDown: 60, ArrowUp: -60, PageDown: innerHeight * 0.85, PageUp: -innerHeight * 0.85, " ": innerHeight * 0.85 };
      if (k in amounts) {
        scrollBy({ top: amounts[k], behavior: "instant" });
        return "scrolled";
      }
      if (k === "Home" || k === "End") {
        scrollTo({ top: k === "Home" ? 0 : document.documentElement.scrollHeight, behavior: "instant" });
        return "scrolled";
      }
    }
    return null;
  }

  async function typeText(el, args) {
    const text = String(args.text ?? "");
    let target = deepActiveElement();
    if (el) {
      target = editableTarget(el);
      if (!target) fail(`Element is not editable: ${describe(el)}`, "not_editable");
      if (isVisible(target)) {
        scrollIntoViewIfNeeded(target);
        const { x, y } = clickPoint(target);
        await moveCursor(x, y, args);
      }
      target.focus({ preventScroll: true });
      if (target.setSelectionRange && editableKind(target) === "text") {
        try {
          target.setSelectionRange(target.value.length, target.value.length);
        } catch {}
      }
    }
    let synthetic = false;
    const delay = args.delay ?? (args.humanInput ? null : 0);
    for (const ch of text) {
      const info = ch === "\n" ? keyInfo("Enter") : keyInfo(ch);
      keyEvent(target, "keydown", info, {});
      keyEvent(target, "keypress", info, {});
      if (ch === "\n") await defaultKeyAction(target, editableTarget(target), info, {}, false);
      else if (!insertText(target, ch)) synthetic = true;
      keyEvent(target, "keyup", info, {});
      const wait = delay ?? jitter(35, 120);
      if (wait) await sleep(wait);
    }
    return { typed: text.length, into: describe(target), synthetic: synthetic || undefined };
  }

  function selectOption(el, args) {
    const select = el.localName === "select" ? el : el.querySelector?.("select");
    if (!select) fail(`Not a <select>: ${describe(el)}. For a custom dropdown, click it and then click the option.`, "not_select");
    if (isDisabled(select)) fail(`Select is disabled: ${describe(select)}`, "disabled");
    const wanted = [].concat(args.values ?? args.value ?? []);
    const options = [...select.options];
    const picks = new Set();
    for (const w of wanted) {
      const spec = typeof w === "object" ? w : { valueOrLabel: String(w) };
      const opt = options.find((o) =>
        spec.index != null ? o.index === spec.index : spec.value != null ? o.value === spec.value : spec.label != null ? normalize(o.label) === normalize(spec.label) : o.value === spec.valueOrLabel || normalize(o.label || o.textContent) === normalize(spec.valueOrLabel),
      );
      if (!opt) fail(`No option ${JSON.stringify(w)} in ${describe(select)}. Options: ${options.slice(0, 30).map((o) => JSON.stringify(normalize(o.label || o.textContent))).join(", ")}`, "no_option");
      picks.add(opt);
    }
    if (!select.multiple && picks.size > 1) fail("This select allows only one option", "no_option");
    for (const o of options) o.selected = picks.has(o);
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { selected: [...picks].map((o) => o.value) };
  }

  async function setChecked(el, args) {
    const want = args.checked !== false;
    const current = checkedState(el);
    if (current === null) fail(`Not a checkbox, radio or switch: ${describe(el)}`, "not_checkable");
    if (current === want) return { checked: want, changed: false };
    await click(el, args);
    const after = checkedState(el);
    if (after !== want) fail(`Clicking didn't change the checked state of ${describe(el)}`, "not_checkable");
    return { checked: want, changed: true };
  }

  async function scroll(el, args) {
    // Smooth scrolling needs the refresh driver, which doesn't tick in background tabs.
    const smooth = args.humanInput && !document.hidden ? "smooth" : "instant";
    if (el && args.dy == null && args.dx == null) {
      el.scrollIntoView({ block: "center", behavior: smooth });
    } else {
      const scroller = el || document.scrollingElement || document.documentElement;
      let dy = args.dy ?? 0;
      if (args.direction === "down") dy = args.amount ?? innerHeight * 0.85;
      if (args.direction === "up") dy = -(args.amount ?? innerHeight * 0.85);
      if (args.to === "top") scroller.scrollTo({ top: 0, behavior: smooth });
      else if (args.to === "bottom") scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth });
      else scroller.scrollBy({ top: dy, left: args.dx ?? 0, behavior: smooth });
    }
    if (smooth === "smooth") await sleep(450);
    const docEl = document.scrollingElement || document.documentElement;
    return { scrollY: Math.round(scrollY), scrollHeight: docEl.scrollHeight, viewportHeight: innerHeight, atBottom: scrollY + innerHeight >= docEl.scrollHeight - 2 };
  }

  function query(locator, what, args = {}) {
    if (what === "count") return resolveAll(locator).length;
    if (what === "visible") {
      const all = resolveAll(locator);
      return all.some(isVisible);
    }
    if (what === "allTexts") return resolveAll(locator).map((el) => normalize(fullText(el)));
    if (what === "allInnerTexts") return resolveAll(locator).map((el) => normalize(el.innerText ?? el.textContent));
    if (what === "describeAll") return resolveAll(locator).slice(0, 50).map((el) => ({ ref: refFor(el), role: roleOf(el), name: nameOf(el), visible: isVisible(el), description: describe(el) }));
    const { element: el } = resolveOne(locator);
    switch (what) {
      case "text":
        return fullText(el);
      case "innerText":
        return el.innerText ?? el.textContent;
      case "inputValue":
        if (el.value === undefined) fail(`Not an input: ${describe(el)}`, "not_editable");
        return el.type === "password" && !args.allowPassword ? "[hidden: password field]" : el.value;
      case "attribute":
        return el.getAttribute(args.name);
      case "enabled":
        return !isDisabled(el);
      case "checked":
        return checkedState(el) === true;
      case "editable":
        return !!editableTarget(el) && !el.readOnly && !isDisabled(el);
      case "html":
        return el.innerHTML;
      case "outerHtml":
        return el.outerHTML;
      case "box": {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, pageX: r.x + scrollX, pageY: r.y + scrollY };
      }
      case "describe":
        return { ref: refFor(el), role: roleOf(el), name: nameOf(el), visible: isVisible(el), description: describe(el) };
      case "ref":
        return refFor(el);
      default:
        fail(`Unknown query ${what}`, "bad_query");
    }
  }

  // ---------- handoff card ----------

  let cardHost = null;

  function showHandoff({ id, message }) {
    hideHandoff();
    cardHost = document.createElement("div");
    const sr = cardHost.attachShadow({ mode: "closed" });
    sr.innerHTML = `<style>
      :host{all:initial}
      .card{position:fixed;right:20px;bottom:20px;z-index:2147483647;max-width:360px;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;
        background:#1c1b22;color:#fbfbfe;border-radius:14px;padding:16px 16px 14px;box-shadow:0 12px 32px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.08);}
      .eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#ffb44d;font-weight:600;margin-bottom:6px}
      .msg{white-space:pre-wrap;margin:0 0 6px}
      .origin{font-size:12px;color:#b4b3ba;margin-bottom:12px;word-break:break-all}
      button{all:unset;cursor:pointer;background:linear-gradient(135deg,#ff9500,#e0218a);color:#fff;font-weight:600;padding:8px 14px;border-radius:9px}
      button:focus-visible{outline:2px solid #fff;outline-offset:2px}
      .hint{font-size:12px;color:#8f8f9d;margin-left:10px}
    </style>
    <div class="card" role="dialog" aria-label="browse: an agent is waiting for you">
      <div class="eyebrow">Your turn</div>
      <p class="msg"></p>
      <div class="origin"></div>
      <button type="button">Continue</button><span class="hint">or click the browse toolbar button</span>
    </div>`;
    sr.querySelector(".msg").textContent = message || "An agent needs you to finish a step on this page.";
    sr.querySelector(".origin").textContent = location.origin;
    sr.querySelector("button").addEventListener("click", (e) => {
      if (!e.isTrusted) return; // a page can't fake the human step
      browser.runtime.sendMessage({ type: "handoff-continue", id });
      hideHandoff();
    });
    (document.body || document.documentElement).appendChild(cardHost);
    return { shown: true };
  }

  function hideHandoff() {
    cardHost?.remove();
    cardHost = null;
    return { hidden: true };
  }

  // ---------- labels overlay (screenshot with refs) ----------

  let labelHost = null;

  function showLabels() {
    hideLabels();
    const items = [];
    for (const el of deepElements(document.body || document.documentElement)) {
      const role = roleOf(el);
      let clickable = REF_ROLES.has(role) && role !== "img" && role !== "heading" && role !== "iframe";
      if (!clickable && !role) {
        try {
          clickable = isClickableGeneric(el, getComputedStyle(el)) && !el.querySelector(INTERESTING);
        } catch {}
      }
      if (!clickable || !isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth || r.width < 2 || r.height < 2) continue;
      items.push({ el, r, role: role || "generic" });
      if (items.length >= 300) break;
    }
    labelHost = document.createElement("div");
    const sr = labelHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `:host{all:initial}.l{position:fixed;font:600 11px/1 ui-monospace,Menlo,monospace;color:#fff;background:#d946ef;padding:2px 3px;border-radius:3px;z-index:2147483647;pointer-events:none;box-shadow:0 0 0 1px #fff}.b{position:fixed;outline:2px solid rgba(217,70,239,.8);z-index:2147483646;pointer-events:none;border-radius:2px}`;
    sr.appendChild(style);
    const out = [];
    for (const { el, r, role } of items) {
      const ref = refFor(el);
      const box = document.createElement("div");
      box.className = "b";
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      const label = document.createElement("div");
      label.className = "l";
      label.textContent = ref;
      Object.assign(label.style, { left: `${Math.max(0, r.left - 2)}px`, top: `${Math.max(0, r.top - 14)}px` });
      sr.append(box, label);
      out.push({ ref, role, name: nameOf(el, role) || clip(normalize(el.innerText ?? el.textContent), 60) });
    }
    (document.body || document.documentElement).appendChild(labelHost);
    return out;
  }

  function hideLabels() {
    labelHost?.remove();
    labelHost = null;
    return true;
  }

  // ---------- console capture (opt-in) ----------

  let consoleRestore = null;
  let consoleMode = null;
  let consoleQueue = [];
  let consoleTimer = null;

  function queueConsole(level, text) {
    consoleQueue.push({ level, text: clip(text, 4000), at: Date.now(), url: location.href });
    if (consoleTimer) return;
    // A microtask, not setTimeout: background tabs clamp timers to 1s.
    consoleTimer = true;
    queueMicrotask(() => {
      const entries = consoleQueue;
      consoleQueue = [];
      consoleTimer = null;
      browser.runtime.sendMessage({ type: "console", entries }).catch(() => {});
    });
  }

  function formatPageValue(pageWin, v) {
    try {
      if (v && typeof v === "object") {
        if (typeof v.stack === "string" && typeof v.message === "string") return `${v.name || "Error"}: ${v.message}\n${v.stack}`;
        return pageWin.JSON.stringify(v) ?? String(v);
      }
      return String(v);
    } catch {
      try {
        return String(v);
      } catch {
        return "[unprintable]";
      }
    }
  }

  function consoleStart() {
    if (consoleRestore) return { capturing: true, mode: consoleMode };
    const pageWin = window.wrappedJSObject;
    const key = `bfx-${Math.random().toString(36).slice(2)}`;
    const onEntry = (e) => {
      try {
        const d = JSON.parse(String(e.detail));
        queueConsole(d.level, d.text);
      } catch {}
    };
    document.addEventListener(key, onEntry);
    // The hook has to live in the page's own realm (Firefox won't let extension code call the page's console),
    // so it goes in through a one-shot <script>. It forwards entries over a private event and still logs to devtools.
    const before = pageWin.console.log;
    const hook = `(() => {
      const K = ${JSON.stringify(key)}, c = console, orig = {};
      const fmt = (v) => { try { if (v instanceof Error) return v.name + ": " + v.message + "\\n" + v.stack; if (v && typeof v === "object") return JSON.stringify(v); return String(v); } catch { return String(v); } };
      for (const l of ["log", "info", "warn", "error", "debug"]) {
        const o = (orig[l] = c[l]);
        c[l] = new Proxy(o, { apply(t, self, args) { try { document.dispatchEvent(new CustomEvent(K, { detail: JSON.stringify({ level: l, text: args.map(fmt).join(" ") }) })); } catch {} return Reflect.apply(t, self, args); } });
      }
      document.addEventListener(K + "-stop", () => { for (const l in orig) c[l] = orig[l]; }, { once: true });
    })()`;
    try {
      const script = document.createElement("script");
      script.textContent = hook;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    } catch {}
    consoleMode = pageWin.console.log !== before ? "console+errors" : "errors-only";
    const onError = (e) => queueConsole("pageerror", `${e.message} (${e.filename}:${e.lineno}:${e.colno})`);
    const onRejection = (e) => queueConsole("pageerror", `Unhandled rejection: ${formatPageValue(pageWin, e.reason)}`);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    consoleRestore = () => {
      document.dispatchEvent(new CustomEvent(`${key}-stop`));
      document.removeEventListener(key, onEntry);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
    return { capturing: true, mode: consoleMode, note: consoleMode === "errors-only" ? "The page's Content-Security-Policy blocked the console hook; only uncaught errors are captured." : undefined };
  }

  function consoleStop() {
    consoleRestore?.();
    consoleRestore = null;
    return { capturing: false };
  }


  // ---------- page-world evaluation ----------

  function evalPage(expression) {
    const pageWin = window.wrappedJSObject;
    const src = `(async () => { try { const v = await (${expression}\n); return JSON.stringify({ ok: true, v: v === undefined ? null : v }); } catch (e) { return JSON.stringify({ ok: false, e: String(e && e.stack || e) }); } })()`;
    let promise;
    try {
      promise = pageWin.eval(src);
    } catch (err) {
      fail(`The page blocked running code in its own world (${err.message}). Its Content-Security-Policy probably forbids eval; use the default isolated world instead (window.wrappedJSObject reaches page globals).`, "page_world_blocked");
    }
    return new Promise((resolve, reject) => {
      promise.then(
        exportFunction((s) => {
          try {
            const r = JSON.parse(s);
            if (r.ok) resolve(r.v);
            else reject(Object.assign(new Error(r.e), { code: "evaluate_error" }));
          } catch (err) {
            reject(err);
          }
        }, pageWin),
        exportFunction((e) => reject(new Error(String(e))), pageWin),
      );
    });
  }

  // ---------- secrets ----------

  function originAllowed(origins) {
    return (origins || []).some((o) => {
      if (o === location.origin) return true;
      if (o.startsWith("*.")) return location.hostname === o.slice(2) || location.hostname.endsWith(`.${o.slice(2)}`);
      try {
        return new URL(o).origin === location.origin;
      } catch {
        return location.hostname === o;
      }
    });
  }

  async function typeSecret(el, args) {
    if (!originAllowed(args.origins)) fail(`domain_not_allowed: this field is on ${location.origin}, but the secret is only for ${args.origins.join(", ")}.`, "domain_not_allowed");
    const target = editableTarget(el);
    if (!target) fail(`Element is not editable: ${describe(el)}`, "not_editable");
    await fill(target, { ...args, value: "" });
    await typeText(target, { ...args, text: args.value, delay: args.humanInput ? undefined : 0 });
    return { typed: true, into: describe(target).replace(/ "[^"]*"$/, ""), origin: location.origin };
  }

  // ---------- dispatcher ----------

  async function run(op, args = {}) {
    switch (op) {
      case "snapshot":
        return snapshot(args);
      case "pageMetrics": {
        const d = document.documentElement;
        return { scrollWidth: Math.max(d.scrollWidth, document.body?.scrollWidth || 0), scrollHeight: Math.max(d.scrollHeight, document.body?.scrollHeight || 0), innerWidth, innerHeight, scrollX, scrollY, devicePixelRatio, title: document.title, url: location.href, readyState: document.readyState };
      }
      case "click":
        return click(resolveOne(args.target).element, args);
      case "hover":
        return hover(resolveOne(args.target).element, args);
      case "fill":
        return fill(resolveOne(args.target).element, args);
      case "type":
        return typeText(args.target ? resolveOne(args.target).element : null, args);
      case "press":
        if (args.target) {
          const { element } = resolveOne(args.target);
          const f = editableTarget(element) || focusableAncestor(element) || element;
          f.focus({ preventScroll: true });
        }
        return press(args);
      case "selectOption":
        return selectOption(resolveOne(args.target).element, args);
      case "setChecked":
        return setChecked(resolveOne(args.target).element, args);
      case "focus": {
        const { element } = resolveOne(args.target);
        (editableTarget(element) || element).focus();
        return { focused: describe(element) };
      }
      case "blur":
        deepActiveElement()?.blur?.();
        return true;
      case "scroll":
        return scroll(args.target ? resolveOne(args.target).element : null, args);
      case "mouseClick": {
        const el = deepElementFromPoint(args.x, args.y);
        if (!el) fail(`Nothing at ${args.x},${args.y}`, "not_found");
        return click(el, { ...args, force: true, position: null });
      }
      case "query":
        return query(args.target, args.what, args);
      case "dispatchEvent": {
        const { element } = resolveOne(args.target);
        element.dispatchEvent(new Event(args.type, { bubbles: true, composed: true, cancelable: true }));
        return true;
      }
      case "typeSecret":
        return typeSecret(resolveOne(args.target).element, args);
      case "handoff.show":
        return showHandoff(args);
      case "handoff.hide":
        return hideHandoff();
      case "labels.show":
        return showLabels();
      case "labels.hide":
        return hideLabels();
      case "console.start":
        return consoleStart();
      case "console.stop":
        return consoleStop();
      case "evalPage":
        return serialize(await evalPage(args.expression));
      default:
        fail(`Unknown page operation ${op}`, "unknown_op");
    }
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "ping") return Promise.resolve("pong");
    if (msg?.type !== "op") return;
    return run(msg.op, msg.args).then(
      (result) => ({ ok: true, result: serialize(result) }),
      (err) => ({ ok: false, error: String(err?.message || err), code: err?.code || null, data: err?.data || null }),
    );
  });

  window.__browseFx = { run, resolveAll, resolveOne: (l) => resolveOne(l).element, serialize, snapshot, parseSelector };
})();
