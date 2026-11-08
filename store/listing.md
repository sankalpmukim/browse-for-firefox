Let your AI coding agents use your real Firefox (your tabs, your logins, your extensions) through the Model Context Protocol (MCP). It works with opencode, Claude Code, Codex, Cursor and any other MCP client.

Agents open background tabs inside a collapsed "Agents" tab group, out of your way. They can:
• read pages as compact accessibility snapshots
• click, type and fill forms
• take screenshots
• record a tab to video
• capture network traffic to a redacted HAR

When only you can continue (a login, a 2FA prompt, a CAPTCHA, a payment), the agent hands the tab to you. It carries on after you click Continue.

**Requires a free companion app.** This extension only talks to a small local relay that you install from https://github.com/sankalpmukim/opencode-browse-firefox (one command: node src/cli.mjs install). The relay connects your MCP agents to Firefox through native messaging. Without the companion app, the extension does nothing.

**Highlights**
• Lend any tab to an agent with the toolbar button (badge ON). Click again to take it back.
• Hand-offs show a card in the page and a notification. Only a real click counts as Continue.
• Domain allowlists: Firefox itself blocks agent navigations to sites you didn't allow.
• Site secrets: the agent types stored passwords and TOTP codes into the right site without ever seeing them.
• Network capture includes response bodies. Credentials are redacted.
• Recordings and screenshots work on background tabs.

**Privacy**
• Nothing is sent anywhere by the extension. It talks only to the companion app on your own computer, over Firefox native messaging. There's no network port, and no analytics or telemetry.
• Pages you browse yourself are never touched. The extension only injects its helper into tabs an agent opened or that you lent with the toolbar button.

Inspired by opencode's "browse" for Chromium browsers (https://github.com/anomalyco/browse). This is an independent, open-source (MIT) Firefox implementation, not affiliated with Anomaly or Mozilla.
