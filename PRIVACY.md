# Privacy policy: browse for Firefox

browse for Firefox does not collect, store or send any personal data to the developer or to any third party.

- **No network communication.** The extension talks only to a companion app on your own computer, through Firefox
  native messaging. That companion app listens on a private Unix socket and has no network listener. Neither one
  contacts any remote server. There are no analytics, no telemetry and no crash reporting.
- **What it touches.** It reads and acts on web pages only in tabs that an AI agent you run opened, or that you lent to
  agents with the toolbar button. It never touches other pages.
- **What stays local.** Settings are kept in Firefox's extension storage. Site secrets you choose to add are kept in a
  file on your computer, readable only by your user account. Network captures (HAR files) and recordings are written
  to your computer only when your agent asks for them.
- **Your AI agent.** The local AI agent you connect (for example Claude Code or opencode) receives page content it
  asks for, and may send it to the AI model provider you configured. That is governed by your agent's and provider's
  own policies, not by this extension.

Questions: open an issue at https://github.com/sankalpmukim/opencode-browse-firefox/issues.
