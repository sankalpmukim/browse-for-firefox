Hello, and thanks for reviewing.

WHAT IT IS
browse for Firefox connects a user's local AI agents (MCP clients such as Claude Code, opencode or Codex) to their own Firefox. It is open source (MIT): https://github.com/sankalpmukim/browse-for-firefox. The extension is plain, unminified JavaScript with no build step and no bundler, so the uploaded files are the source.

COMPANION APP (nativeMessaging)
The extension needs a local native-messaging host, "browse_firefox", from the same repository (src/host.mjs, Node.js). Its manifest's allowed_extensions lists only this add-on's ID. The host relays requests from local MCP clients over a Unix socket in a 0700 folder. There is no network listener and no remote server. Without the host installed, the extension stays idle and its options page shows setup instructions.

HOW TO TEST (macOS or Linux, Node 20+)
  git clone https://github.com/sankalpmukim/browse-for-firefox && cd browse-for-firefox
  node src/cli.mjs install --no-agents     # registers the native host only
  # install this add-on, open its options page: it shows "Connected to the local relay"
  node src/cli.mjs exec 'await page.goto("https://example.com"); return await page.title()'
  node src/cli.mjs snapshot https://example.com
  node src/cli.mjs status

PERMISSIONS
- nativeMessaging: the only channel to the local companion app.
- tabs, tabGroups, sessions: open agent tabs in the background, group them, and remember which tabs agents may use (sessions.setTabValue).
- <all_urls>, webNavigation: agents work on sites the user asks for. The page helper (content/agent.js) is injected with tabs.executeScript only into tabs an agent opened or the user explicitly lent with the toolbar button, never into other pages.
- webRequest, webRequestBlocking: (1) the user's per-session domain allowlist cancels top-level navigations outside it; (2) opt-in network capture to a HAR file with credentials redacted (filterResponseData only while a capture the user's agent started is running).
- notifications: tell the user when an agent hands a tab to them (login/2FA/CAPTCHA).
- storage, alarms: settings, and closing idle agent tabs.

CODE EXECUTION
No code is fetched from the network. The "evaluate"/"execute" features run JavaScript that the user's own local agent sends through the local native host (like a user script). It runs only in agent-controlled tabs, via tabs.executeScript in the isolated content-script world.

DATA
The extension sends nothing off the device. There's no analytics, no telemetry, no remote endpoints. Hence data_collection_permissions: none.
