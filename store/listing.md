Your AI coding agent, inside the Firefox you actually use.

browse for Firefox connects local AI agents (opencode, Claude Code, Codex, Cursor — anything that speaks MCP) to your real browser: your tabs, your logins, your extensions. No throwaway automation profile — the agent works where you already are.

**What agents can do**
• open pages in a collapsed "Agents" tab group, out of your way
• read pages as compact accessibility snapshots
• click, type and fill forms
• take screenshots and record video — background tabs included
• capture network traffic to a HAR, response bodies included, credentials redacted

**You stay in control**
• Lend any tab to an agent from the toolbar button (badge ON). Click again to take it back.
• When only a human can continue — a login, 2FA, a CAPTCHA, a payment — the agent hands the tab back with a card and a notification, and resumes after you click Continue.
• Domain allowlists: Firefox itself blocks navigation to sites you didn't allow.
• Site secrets: agents type stored passwords and TOTP codes into the right site without ever seeing them.
• Your own browsing is never touched — the page helper only loads in tabs an agent opened or that you lent.

**Privacy**
Nothing leaves your computer. The extension talks only to a small local relay over Firefox native messaging: no network port, no analytics, no telemetry. Open source, MIT.

**Requires the free companion relay** from https://github.com/sankalpmukim/browse-for-firefox — one command: node src/cli.mjs install. Without it the extension stays idle and shows setup instructions.

An independent, Firefox-native implementation inspired by opencode's "browse" for Chromium (https://github.com/anomalyco/browse). Not affiliated with Anomaly or Mozilla.
