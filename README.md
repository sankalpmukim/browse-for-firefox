# browse for Firefox

**Let your AI agents use your real Firefox**: your tabs, your logins, your extensions, in background tabs grouped
out of your way.

**[Install "Agent Browse" from addons.mozilla.org](https://addons.mozilla.org/firefox/addon/agent-browse/)** ·
the extension is one half of the pair — the small local relay in this repo is the other ([Quick start](#quick-start)).
Listed on AMO as **Agent Browse** (Mozilla's naming policy doesn't allow "Firefox" in add-on names); everything
else about the project keeps the browse-firefox name.

browse for Firefox is an MCP server plus a Firefox extension. It works with [opencode](https://opencode.ai), Claude
Code, Codex, Cursor and any other MCP client. Agents can:

- open and read pages, then click, type and fill forms
- take screenshots and record video
- capture network traffic
- hand a tab back to you when only a human can continue (a login, a 2FA prompt, a CAPTCHA, a payment)

> **Heavily inspired by [opencode's browse](https://github.com/anomalyco/browse)**, but built for Firefox.
> Upstream browse is Chromium-only by design: it drives the browser through `chrome.debugger` and the Chrome DevTools
> Protocol. Firefox has neither, so this is an independent, Firefox-native rebuild of the same idea. It keeps the same
> workflow, the same tool names where possible and the same safety model. It is not affiliated with Anomaly or Mozilla.
> **If you use a Chromium browser, use upstream browse.**

---

## Contents

- [Quick start](#quick-start)
- [What agents can do](#what-agents-can-do)
- [Using it day to day](#using-it-day-to-day)
- [Tools](#tools)
- [Scripting with `execute`](#scripting-with-execute)
- [Settings](#settings)
- [How it works](#how-it-works)
- [Security](#security)
- [Compared with upstream browse (Chromium)](#compared-with-upstream-browse-chromium)
- [Limitations on Firefox](#limitations-on-firefox)
- [CLI](#cli)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Project layout](#project-layout)
- [Releasing](#releasing)
- [Roadmap](#roadmap)
- [License and credits](#license-and-credits)

---

## Quick start

**Requirements:** Firefox 140 or newer, macOS or Linux, and Node.js 20 or newer. There are no npm dependencies.

### 1. Install the relay and register your agents

```sh
git clone https://github.com/sankalpmukim/browse-for-firefox
cd browse-for-firefox
node src/cli.mjs install
```

`install` does four things:

| Step | Where |
| --- | --- |
| Registers the native-messaging host, so Firefox can start the relay for this extension only | macOS: `~/Library/Application Support/Mozilla/NativeMessagingHosts/browse_firefox.json`; Linux: `~/.mozilla/native-messaging-hosts/` |
| Adds a `browse-firefox` MCP server to the agents it detects, after backing up each config to `*.bak-browse-firefox` | OpenCode, Claude Code, Codex, Cursor |
| Links the CLI | `~/.local/bin/browse-firefox` |
| Builds the extension package | `dist/browse-firefox-<version>.xpi` |

To control which agents get it, pass `--agents opencode,claude,codex,cursor` (or `--no-agents`). For any other MCP
client, add this entry:

```json
{ "mcpServers": { "browse-firefox": { "command": "~/.local/share/browse-firefox/bin/browse-firefox", "args": ["mcp"] } } }
```

### 2. Add the extension to Firefox

Install **[Agent Browse from addons.mozilla.org](https://addons.mozilla.org/firefox/addon/agent-browse/)**.
The extension's settings page opens on first run and shows **Connected to the local relay** once step 1 is done.

To run the extension straight from your checkout instead (for development), open
`about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and choose `extension/manifest.json`.
Firefox removes temporary add-ons when it restarts.

### 3. Check, then try it

```sh
browse-firefox doctor
```

Start a new agent session, so it loads the new MCP server, and ask it something like:

- *"Open news.ycombinator.com in Firefox and tell me the top three stories."*
- *"Go to my GitHub notifications and summarise what needs my review."* If you're signed out, the agent hands the
  tab to you to sign in.
- *"Fill in the contact form on example.org with my details, but don't submit it. Show me a screenshot first."*
- *"Record a video of the checkout flow on staging and capture the network traffic to a HAR."*

---

## What agents can do

- **Read pages** as a compact accessibility snapshot. The snapshot lists landmarks, headings, text, link targets and
  controls, each control with a ref such as `[ref=e12]`. Snapshots reach into iframes (by frame), open shadow roots and
  closed shadow roots.
- **Act** with click, fill, type, press, select, check, hover and scroll. Targets are refs, CSS selectors, `text=…`,
  `role=button[name="Save"]`, or plain visible text such as `Sign in`. Actions wait for the element to appear and
  check that nothing covers it. Each action reports what changed on the page since the last snapshot.
- **Script multi-step flows** with a Playwright-style API (`page.getByRole(...).click()`, `waitForURL`, locators,
  `screenshot()`). See [`execute`](#scripting-with-execute).
- **See** through screenshots of the viewport, the full page, one element, or with ref labels drawn on every
  control. All of these work while the tab is in the background.
- **Record** a tab to WebM, and **capture network traffic** to a redacted HAR that can include response bodies.
- **Read console output** and uncaught errors (opt-in).
- **Hand off to you** for logins, 2FA, passkeys, CAPTCHAs and payments, then continue once you click **Continue**.
- **Use your stored secrets** (passwords, API keys, TOTP codes) without ever seeing them. The secret is typed only
  into a field on the origins you allowed.
- **Stay in bounds** with per-session domain allowlists that Firefox enforces itself.

---

## Using it day to day

- **Agent tabs stay out of your way.** They open in the background of the window you last used, inside a collapsed
  **🤖 Agents** tab group. The group expands while you look at one of its tabs. Popups an agent opens join the group
  and never steal focus. Agent tabs that sit unused for 10 minutes close themselves, unless a hand-off, recording or
  network capture is using them.
- **Lend an agent one of your tabs.** Click the browse toolbar button on that tab; the badge shows **ON**. Then tell
  the agent to use it, and the agent adopts it with `tabs {action: "adopt"}`. Click the button again to take the tab
  back. Agents can't close a tab you lent them: closing it just hands it back.
- **Badges:**

  | Badge | Meaning |
  | --- | --- |
  | **ON** | Lent to agents |
  | **RUN** | An agent is working in this tab |
  | **WAIT** | An agent needs you |
  | **REC** | This tab is being recorded |

- **Hand-offs.** When an agent needs you:
  - Its tab group expands and a system notification appears. Clicking the notification takes you to the tab.
  - A small card in the page shows the agent's message and the site's origin.
  - Do the human part, then click **Continue** on the card or on the toolbar button.
  - Only a real click counts, so the page can't fake it. The agent then verifies the result itself.
- **Taking over an agent's tab.** Click the toolbar button on it. The tab becomes yours and leaves the agent group.

---

## Tools

| Tool | What it does |
| --- | --- |
| `navigate` | Go to a URL, or `back`, `forward` or `reload`. Opens a background agent tab on first use and reports bot challenges it detects. |
| `snapshot` | Accessibility snapshot with refs. Options: `find` (regex plus context), `diff` (changes only), `interactiveOnly`, `root`, `frameId`, `maxChars`. |
| `click` | Click (`button`, `doubleClick`, `modifiers`, `force`). Links that open new tabs open as background agent tabs. |
| `fill` | Set an input, textarea or contenteditable. `fields: [...]` fills a whole form; `submit: true` presses Enter. |
| `type` | Type key by key, for sites that watch keystrokes. |
| `press` | Keys and combinations: `Enter`, `Tab`, `Escape`, `ArrowDown`, `ControlOrMeta+a`, … |
| `select_option`, `check`, `hover`, `scroll` | What they say. |
| `wait_for` | Wait for text, an element state, a URL, a load state, or a fixed time. |
| `screenshot` | Viewport, `fullPage`, an element (`target`), or `labels: true` to draw clickable ref labels. Can save to `path`. |
| `evaluate` | Run JS in the page. Uses the isolated world by default; `world: "page"` runs in the page's own world. |
| `execute` | A Playwright-style script for multi-step flows. |
| `handoff` | Hand the tab to the user and wait for Continue. |
| `network` | `start`, `status`, `stop` or `cancel` a HAR capture. `bodies: true` also stores response bodies. |
| `recording` | `start`, `status`, `stop` or `cancel` a WebM recording of a tab. |
| `console` | `start`, `read` or `stop` console and error capture. |
| `secrets` | `list` the user's stored secrets (names and origins only), or `type` one into a field. |
| `session_allowlist` | Restrict where this session's tabs may navigate. |
| `tabs` | `list`, `new`, `select`, `close`, `adopt` (a lent tab), `cleanup`. |
| `settings`, `status` | Read or change settings; check the connection and see which tabs agents can use. |

The MCP server also sends agents a short usage guide when they connect: inspect, act, then verify; hand off instead of
solving CAPTCHAs; never retry-loop a blocked site.

---

## Scripting with `execute`

```js
await page.goto("https://github.com/notifications")
if (page.url().includes("/login")) {
  await handoff("Sign in to GitHub, then click Continue", { timeoutMs: 600_000 })
  await page.waitForURL(/notifications/)
}
const items = page.getByRole("link").filter({ hasText: /pull request/i })
return { count: await items.count(), first: await items.first().innerText() }
```

These globals are available:

| Global | What it gives you |
| --- | --- |
| `page` | Navigation: `goto`, `url()`, `title`, `reload`, `goBack`, `goForward`, `waitForURL`, `waitForLoadState`, `waitForSelector`, `waitForFunction`, `waitForEvent("popup")` |
| | Locators: `locator`, `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder`, `getByTestId`, `getByAltText`, `getByTitle` |
| | Actions: `click`, `fill`, `type`, `press`, `selectOption`, `check`, `hover` |
| | Other: `evaluate`, `content`, `screenshot`, `frames()`, `keyboard`, `mouse` |
| Locators | Chaining: `.first()`, `.last()`, `.nth()`, `.filter({hasText, has, visible})`, `.locator()` |
| | Actions: `.click()`, `.fill()`, `.pressSequentially()`, `.press()`, `.check()`, `.selectOption()`, `.scrollIntoViewIfNeeded()` |
| | Reads and waits: `.textContent()`, `.innerText()`, `.inputValue()`, `.getAttribute()`, `.count()`, `.all()`, `.isVisible()`, `.waitFor()`, `.boundingBox()`, `.evaluate()`, `.screenshot()` |
| `context` | `pages()`, `newPage()` |
| Helpers | `snapshot({find, diff})`, `ref("e12")`, `handoff(message, {start, timeoutMs})`, `secrets.type(locator, name)`, `sleep(ms)` |
| `state` | An object that persists between `execute` calls |

How scripts behave:

- **Results.** A single expression returns itself; otherwise use `return`. A returned screenshot `Buffer` is shown to
  the agent as an image, and `console.log` output comes back with the result.
- **Waiting.** Actions wait up to 10 seconds for the element to exist and be visible, enabled and uncovered.
- **Strict locators.** Like Playwright, a locator must match one element. A single visible match among hidden
  duplicates is accepted.
- **Sandbox.** The code runs in a separate `node:vm` realm with no `process`, `require`, `import`, `fs`, Node `fetch`
  or `eval`. This is a convenience, not a security boundary: treat agent code as code running as you.

---

## Settings

Open the extension's options page, or ask an agent to change them with the `settings` tool. Changes apply
immediately.

| Setting | Options |
| --- | --- |
| Where agents open their tabs | In your window, in the background (default) · in a separate window of their own |
| Grouping | One "Agents" group per window (default) · one group per agent session · no grouping |
| Close idle agent tabs after | 10 min (default) · 30 · 60 · never |
| Agent cursor | Off (default) · show where agents click (pages can detect it) |
| Human-like input | On (default): paced typing and scrolling · off: full speed |
| Hand-off notifications | On (default) · card in the page only |

Environment variables (set them where your agent starts):

| Variable | Effect |
| --- | --- |
| `BROWSE_FIREFOX_SESSION` | Name this MCP process's session (default: a random `agent-xxxx`) |
| `BROWSE_FIREFOX_NO_LAUNCH=1` | Don't start Firefox automatically when it isn't running |
| `BROWSE_FIREFOX_OUTPUT_DIR` | Where HARs and recordings are written (default: `$TMPDIR/browse-firefox`) |
| `BROWSE_FIREFOX_CHALLENGE_WAIT_MS` | How long to wait for a bot check that clears itself (default 15000) |
| `BROWSE_FIREFOX_EXECUTE_SLICE_MS` | Longest synchronous run allowed inside `execute` (default 2000) |

---

## How it works

```
 your agent ──stdio──▶ browse-firefox mcp ──HTTP over a Unix socket──▶ relay (native host) ──native messaging──▶ extension
 (opencode, Claude      one per agent session;      ~/.local/share/              started by Firefox,          background page
  Code, Codex…)         runs `execute` scripts      browse-firefox/relay.sock    only for this extension         │
                                                                                                                  ▼
                                                                                            page agent (content script),
                                                                                            only in tabs agents use
```

- **The extension** (`extension/`, Manifest V2 with a persistent background page) does the browser-side work:
  - keeps track of which tabs agents may use, in tags that survive a Firefox restart
  - manages tab groups, badges, hand-offs, allowlists, network capture and recordings
  - injects the page agent into a tab only when an agent uses that tab. Pages you browse yourself get nothing.
- **The page agent** (`extension/content/agent.js`) builds snapshots, resolves locators and performs input. It runs in
  Firefox's isolated content-script world, so the page's own scripts can't see it.
- **The relay** (`src/host.mjs`) is Firefox's native-messaging host:
  - Firefox starts it when the extension loads and stops it when Firefox quits.
  - It serves a private Unix socket for agents.
  - If a second Firefox profile also runs the extension, that profile's relay stands by and takes over when the first
    one closes.
- **The MCP server** (`src/mcp.mjs`) is dependency-free JSON-RPC over stdio. It starts Firefox in the background if it
  isn't running.

---

## Security

browse drives the browser you are signed in to. It assumes that whatever an agent reads (a web page, an email) might
try to steer it.

- **No network listener.** Agents reach the relay only through a Unix socket in a `0700` folder, so nothing listens on
  a port. Firefox starts the relay only for this extension's ID. Any program running as you could use the socket,
  which is the same trust level upstream's relay token gives.
- **Your tabs stay yours.**
  - Each agent session can use only the tabs it opened, plus tabs you lent.
  - Agents can't bring tabs to the front or switch your tabs.
  - The toolbar button always takes a tab back.
- **Domain allowlists** (`session_allowlist`). Firefox cancels top-level navigations, redirects, form posts and popups
  that leave the list, using blocking `webRequest`. Private and loopback hosts need an entry naming that exact host.
  Subresources such as images, scripts and fetches are not blocked.
- **Site secrets.**
  - You add them yourself: `browse-firefox secrets add github --origin https://github.com [--totp]`, which reads the
    value from a hidden prompt.
  - They're stored in a `0600` file.
  - The value is typed only after the page agent, running in the field's own frame, confirms that frame's origin
    matches the secret's origins.
  - The value is never returned to the agent or written to logs.
  - Set an allowlist before using secrets; the agent is warned if there isn't one.
- **Redacted HARs.** These are replaced with `[redacted]`:
  - headers: `Authorization`, `Cookie`, `Set-Cookie` and API-key headers
  - token-like query parameters
  - password and token fields in form posts and JSON bodies
- **Bot challenges.** After each navigation, browse checks for Cloudflare, Turnstile, reCAPTCHA, hCaptcha, DataDome,
  PerimeterX and access-denied pages:
  - Checks that clear themselves get up to 15 seconds.
  - Interactive challenges go to you as a hand-off.
  - Outright blocks stop the agent.
  - browse never solves a challenge itself.

---

## Compared with upstream browse (Chromium)

Upstream browse is excellent on Chromium browsers (Chrome, Edge, Brave, Arc, Vivaldi, Opera, Helium). Its strengths:

- **Real Playwright** (via Patchright, which hides automation tells) running against your real profile.
- **Trusted OS-level input** with human-like mouse paths. This is much harder for bot detection to spot.
- **Focus emulation**, so background tabs behave as if visible.
- **One-command install** of a signed, auto-updating binary. It configures 30+ agents and pairs the extension with an
  ECDH key exchange plus HMAC verification on every connection. The relay can also run on another machine.
- **MP4/WebM recordings, a flight recorder** that keeps the last minute, session journals, WebMCP and multi-browser
  routing.

This Firefox version compares as follows:

| | Upstream (Chromium) | browse for Firefox |
| --- | --- | --- |
| Driver | Real Playwright over CDP (`chrome.debugger`) | Playwright-style API on a built-in page agent (Firefox has no debugger API for extensions) |
| Input events | Trusted (`isTrusted: true`) | Synthetic (`isTrusted: false`); typing goes through Firefox's editor, so frameworks see real input events |
| Snapshots | ARIA snapshot with refs | Same idea, and it also reads **closed** shadow roots |
| Screenshots | CDP | `tabs.captureTab`, including **background** tabs |
| Network capture | Redacted HAR | Redacted HAR **with response bodies**, which Chromium MV3 extensions can't read |
| Allowlists | Enforced by the relay | Enforced inside Firefox with blocking `webRequest` |
| Recording | MP4/WebM, plus a flight recorder | WebM with no ffmpeg needed; no flight recorder |
| Transport | WebSocket on port 19988, plus pairing | Native messaging and a private socket: **no port, no pairing** |
| Hand-offs, lending tabs, tab groups, secrets, challenge detection | ✓ | ✓ |
| Install | Store extension and an auto-updating binary | Local checkout today; AMO listing planned |

---

## Limitations on Firefox

- **Synthetic input.** Pages can tell that events didn't come from a real user, and strict anti-bot sites may notice.
  On sites that watch keystrokes, use `type` rather than `fill`.
- **Popups.** `target=_blank` links and `window.open` from click handlers both open as background agent tabs (tested).
  A page that opens popups outside a click, or a stricter popup-blocker setting, can still be blocked.
- **Background tabs really are in the background.** Pages see `document.hidden === true`, and Firefox throttles their
  timers. browse's own pacing isn't affected, but a page that waits on `requestAnimationFrame` may stall until you look
  at the tab.
- **Privileged pages** such as `about:`, `addons.mozilla.org` and reader view can't be scripted by any extension.
- **Page CSP.** A strict Content Security Policy can block `evaluate` with `world: "page"`, and limits console capture
  to uncaught errors. The default isolated world still has full DOM access, and it can read page globals through
  `window.wrappedJSObject`.

---

## CLI

```
browse-firefox install [--agents opencode,claude,codex,cursor] [--no-agents]
browse-firefox uninstall                  # removes the host and agent entries; keeps your secrets
browse-firefox doctor                     # checks every piece of the setup
browse-firefox status | tabs
browse-firefox reload                     # reload the extension from disk after updating; restarts the relay
browse-firefox exec 'await page.goto("https://example.com"); return await page.title()'
browse-firefox exec --file flow.js --session work
browse-firefox snapshot https://example.com
browse-firefox screenshot out.png https://example.com [--full] [--labels]
browse-firefox settings get | set grouping=session idleMinutes=30
browse-firefox secrets list | add <name> --origin https://site [--origin …] [--totp] | remove <name>
browse-firefox build                      # unsigned dist/*.xpi
browse-firefox sign                       # unlisted AMO signing (needs AMO_JWT_ISSUER and AMO_JWT_SECRET)
```

---

## Troubleshooting

Run `browse-firefox doctor` first; it checks every piece. Relay logs are in `~/.local/state/browse-firefox/host.log`.

| Symptom | Fix |
| --- | --- |
| "Firefox isn't connected" | Make sure Firefox is running and the extension is enabled in `about:addons`. A temporary add-on is gone after a restart, so load it again from `about:debugging`. |
| Settings page says "Not connected", with a native-application error | Run `node src/cli.mjs install` again, then click **Reconnect** on the settings page. |
| Settings page says "Connected, but standing by" | Another Firefox profile is serving agents. Close it, or use that profile. |
| Everything broke after Node.js was upgraded or moved | Run `node src/cli.mjs install` again. It records the path to `node`. |
| The agent can't see the browse tools | Start a new agent session, or restart the agent, so it loads the new MCP server. |
| "Ref e12 is stale" | The page changed. Take a new snapshot. |
| "Firefox doesn't let extensions script this page" | The tab is a privileged page (`about:`, AMO, reader view). Navigate to a normal site first. |
| A click "would land on another element" | A modal or cookie banner is covering the target. Close it first, or pass `force: true`. |
| Doctor reports a relay version mismatch | Run `browse-firefox reload`, or restart Firefox. |

**Updating:** run `git pull`, then `browse-firefox reload`, which makes the extension reload itself from disk (or
install the newly signed `.xpi`). Then start a new agent session.

---

## Development

```sh
npm test            # unit tests: snapshot diffing, TOTP (RFC 6238 vectors), allowlist matching, MCP handshake
npm run e2e         # 40 end-to-end tests: the official MCP SDK client against a throwaway headless Firefox
npm run e2e:human   # real clicks (macOS + agent-desktop): lend a tab, Continue a hand-off, take tabs back
npm run lint        # web-ext lint
npm run dev         # launch Firefox with the extension loaded temporarily (a separate profile)
```

What the suites cover:

- **`npm run e2e`** (`test/e2e/sdk.test.mjs`) connects with `@modelcontextprotocol/sdk`'s `Client` over stdio, so
  every response is checked against the MCP schema. It drives every tool against fixture pages, including:
  - the closed shadow DOM, iframes, an SPA with `pushState`, a modal overlay, late-appearing elements and a
    3,000-row page
  - popups, redirects and allowlists, with credentials in headers, cookies and URLs
  - the `execute` sandbox, two sessions running side by side, and settings
  - an extension reload, after which tab ownership must survive
- **`npm run e2e:human`** (`test/e2e/human-flows.mjs`) opens a *visible* test Firefox and clicks through macOS
  accessibility (`agent-desktop`). It covers:
  - lending a tab with the toolbar button
  - Continue on the hand-off card, and Continue via the toolbar
  - a page trying to fake Continue
  - a hand-off on a background agent tab, which must expand the group
  - taking tabs back
- Both suites run in an isolated profile with their own relay socket, data folder and secrets (via
  `XDG_DATA_HOME`), so they never touch your Firefox, even while it's connected. They need the native host
  registered first (`node src/cli.mjs install --no-agents`).
- After you change files in `extension/`, run `browse-firefox reload`.
- Changes in `src/` take effect for new MCP sessions. The relay restarts when the extension reloads.

## Project layout

```
extension/
  manifest.json            MV2 manifest (gecko id, permissions)
  background/
    main.js                native-messaging connection, method dispatcher, toolbar button
    tabs.js                tab registry, badges, tab groups, popups, idle cleanup
    dom.js                 page-agent injection, navigation, evaluate, screenshots
    policy.js              per-session allowlists (blocking webRequest)
    network.js             HAR capture (filterResponseData for bodies), redaction
    recording.js           captureTab → canvas → MediaRecorder (WebM)
    handoff.js             hand-off card, notifications, Continue
    settings.js            settings storage and validation
  content/agent.js         page agent: snapshot, locators, input, card, labels, console capture
  options/                 settings page
src/
  cli.mjs                  CLI entry point (mcp, host, install, doctor, exec, …)
  mcp.mjs                  MCP server and tool definitions
  browser.mjs              Session / Page / Locator (Playwright-style), snapshot diffing
  execute.mjs              node:vm runner for `execute`
  host.mjs                 native-messaging host and relay socket
  client.mjs               socket client; starts Firefox when needed
  install.mjs              install, uninstall, doctor, build, sign
  secrets.mjs              site secrets and TOTP
  paths.mjs                file locations
test/
  unit.test.mjs            unit tests
  e2e/sdk.test.mjs         end-to-end suite on the official MCP SDK client
  e2e/human-flows.mjs      real-click flows (toolbar, hand-off card) via agent-desktop
  e2e/harness.mjs          fixture server, isolated Firefox launcher, SDK client helper
  e2e/site/                fixture pages
```

## Releasing

Publishing a version to addons.mozilla.org is automated. Per release:

1. Bump `version` in `extension/manifest.json` and `package.json` (they must match), and add
   `store/release-notes/<version>.md`.
2. Push a tag `v<version>` and publish a GitHub release. The
   [submit workflow](.github/workflows/submit.yml) checks the tag against the version, builds the AMO metadata
   from `store/`, and signs through `web-ext` with the `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` repo secrets.

AMO rejects a version it already has, so every release needs a bump. To submit without a release (e.g. listing
copy changes), run the workflow manually from the Actions tab; it publishes whatever `main` carries.

Listing copy, the icon and screenshots live in `store/` (`listing.md`, `icon-512.png`, `screenshots/` with
`captions.json`) and are pushed to AMO with `node store/publish.mjs --sync-listing` (needs the same AMO keys).
AMO throttles edit endpoints aggressively — the sync is change-checked and resumable, so if it is throttled,
wait out the window it reports and run it again.

## Roadmap

- An npm package, so `npx browse-firefox install` works without a git checkout.
- A flight recorder: keep the last minute of video, and save it when something breaks.
- Windows support (the native host is registered through the registry).

## License and credits

MIT; see [LICENSE](LICENSE).

The concept, workflow, tool design and safety model come from **[opencode's browse](https://github.com/anomalyco/browse)**
by Anomaly (MIT). This project brings that experience to Firefox users with an independent implementation. Thanks to
the browse team for the design this follows.
