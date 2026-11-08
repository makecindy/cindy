---
id: tools
title: Tools and automation settings
summary: Settings > Tools turns built-in agent tools (Collab Mode, SSH commands, Document Toolkit, Slack, Feishu Bot, Personal WeChat, Browser) on or off per project and adds custom MCP servers; Settings > Automation controls browser, computer, and Android automation.
---
Two Settings tabs decide which tools the agents get: **Tools** (built-in tools and your own MCP servers) and **Automation** (letting agents operate a browser, this computer, or an Android phone). Tool changes only apply to **new or restarted** sessions — a running session keeps the tools it started with.

**Settings > Tools > Built-in Tools:**

- Each row is a tool the agents can call, with an on/off switch:
  - **Collab Mode** — lets a session start a team of worker agents (see the collaboration topic). Turning it off only affects new sessions and doesn't stop workers that are already running.
  - **SSH commands** — run commands on remote computers through the SSH hosts you've configured (see the remote topic).
  - **Document Toolkit** — create and read back PDF, Word, Excel, and PowerPoint files.
  - **Slack** — search, read, and send messages with your connected Slack account.
  - **Feishu Bot** — send files and notifications to Feishu users through your bound bot.
  - **Personal WeChat** — send messages to known WeChat contacts.
  - **Browser** — browse and act on web pages. It's listed here only when the scope is **New session defaults**; per-project control is under **Settings > Automation**.
- Core tools (memory, scheduling, and the helper that tells agents what's available) are always on and aren't listed.
- **Scope picker** (top right): **New session defaults** applies to sessions without a project override; choosing a recent project changes the setting for that project only. Project settings take priority. When you open Settings from a project session, that project is selected first.
- A small label on each row shows where the current value comes from: **project**, **user default**, or **product default** (hover for details). After you change a row, it shows **Custom**; **Restore default** clears your change.

**Settings > Tools > External tools (custom MCP):**

- Click **Add MCP server** to configure a remote service (HTTP or SSE, URL, optional Bearer token and headers), or choose **stdio** for a local program. The local JSON contains `command`, `args` (a string array), and `env` (a string-to-string object). Enter credentials only in the form, never in chat.
- These shared configurations work with Claude Code, Codex and Pi through Cindy's host connection, including SSE and custom HTTP headers. Local programs run on the Desktop where you save the configuration, under your account and from your home folder, even when an agent accesses the tools through a remote bridge. Saving authorizes this execution; it does not test the connection or install missing runtimes.
- New or restarted agent sessions load the saved configuration. Running sessions keep their tool snapshot. Teammates can add the saved server using their capability tools and load it on the next turn in the same chat.
- Native engine configuration files remain separate: writing a Pi, Claude Code or Codex configuration does not register a shared Cindy connection. Existing native entries, credentials and project scopes are not imported, overwritten or copied to another computer. Check for an existing native connection before adding the same service here to avoid loading it twice.
- An absent live tool is not proof that the program is uninstalled. Check whether it is configured in Cindy or only in one engine, whether this session has loaded it, and whether startup succeeded. A device-offline result is different from MCP startup failure. Verify the live tool list and a successful call before reporting the tool as connected.
- Edit or delete saved configurations from this list. Local commands are not copied by the new-computer migration assistant; configure them explicitly on the destination computer.

**Settings > Automation:**

- **Browser automation** (on by default) — gives agents a dedicated browser, separate from your everyday one.
  - **Automation browser target**: **Standalone external browser** (the default — a separate Chrome window with its own "Cindy" profile, so it never touches your normal tabs, bookmarks, or sign-ins) or **Sidebar embedded browser** (the agent works in browser tabs in the right sidebar). The two keep separate sign-ins. If the embedded browser loses its connection, use **Reconnect Browser** / **Recover Browser**.
  - With the external browser, click **Open agent browser** to sign in to sites once; the agent keeps that session afterward. If no browser is found, **Download Chrome**.
  - **Use my browser logins** (external browser only) — lets the agent open sites with your signed-in Chrome, Edge, or Brave accounts. Cindy asks you to confirm first; on macOS it also needs **Full Disk Access**. Turning it off deletes the copied logins.
  - This switch applies to the project of the session you came from (or to new-session defaults if there isn't one).
- **Computer automation** (off by default) — lets agents see windows, read the UI, click, and type in local apps. It's powered by the open-source **CUA Driver**, which Cindy installs the first time you turn it on.
  - On macOS it needs **Accessibility** and **Screen Recording** for CuaDriver; Cindy walks you through granting them (**Grant**, **Recheck**). macOS may still ask for extra confirmation for a specific app or action later — approve those only when you've just started a computer-use task.
  - Windows needs no extra permission; keep the target app visible on the active desktop. On Linux, the desktop session must allow window inspection and input automation.
  - **Check for updates** / **Update** keeps the driver current (you may need to re-grant permissions after an update).
- **Android automation** (off by default) — lets agents inspect and operate a connected Android phone over ADB. Cindy prepares ADB for you. To connect: use a data-capable USB cable, enable **Developer options** and **USB debugging** on the phone, keep it unlocked, allow the debugging prompt, then click **Recheck**. Pick a default **Device** (or **Auto**) and, if needed, a custom ADB path.
- Computer and Android automation apply to the whole computer (not per project) and only to sessions started afterward.

**Notes:**

- Plugins add more tools on their own pages under **Settings > Plugins** (see the plugins topic).
- If a tool you expect is missing in a session, check its switch here (and the project scope), then start a new session.
