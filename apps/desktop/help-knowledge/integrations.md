---
id: integrations
title: What Cindy integrates with
summary: Supported external services — chat apps (Slack, Telegram, X, Feishu / Lark, WeChat, WeCom, DingTalk, Discord), Google (Gmail / Drive / Calendar / Sheets plugins), Jira / Confluence (XD Atlassian, some organizations), GitHub, GitLab, custom MCP servers — and what's not supported.
---
At a glance, Cindy integrates with the services below.

**Chat apps (Settings > IM bots):**

The IM bots page has two sections:

- **Official** — Cindy's own bots. You don't create a bot or enter credentials; just turn on the channel's switch and follow the linking steps. This section isn't available in local mode.
  - **Slack** — bind one or more Slack workspaces and send tasks to Cindy from Slack. Each workspace can also turn on **Slack Communications on This Device** where supported (see the Connections topic).
  - **Telegram** — link your Telegram account to the official Cindy bot with **Link Telegram**. No bot token is required.
  - **X** — link your X (Twitter) account and send tasks by mentioning the Cindy bot on X (shown when the server offers it).
  - Official channels share this computer's project list and sessions, while each channel keeps its own account and project / model preferences.
- **Personal** — bots you create and manage yourself, each with its own credentials and settings:
  - **Personal WeChat** — scan to connect and use Cindy from a private chat.
  - **WeCom Intelligent Bot** — Bot ID + Secret. Also hosts **WeCom group notifications** (a group-bot webhook for automation completion alerts).
  - **Feishu / Lark Bot** — App ID + App Secret. See the Feishu bot topic.
  - **DingTalk Bot** — Client ID + Client Secret (Stream mode), for DMs and group chats.
  - **Discord Bot** — your own bot token + your Discord user ID, for Discord DMs.
  - **Telegram Bot** — your own BotFather token + your Telegram user ID, for DMs and group chats.
- Each channel has a **New Conversation Configuration** that picks the Agent and model for new conversations from that channel.
- Teammates can also have their own bots on their **Messaging platforms** page. A bot can be connected in only one place.

**Accounts and tools (Plugins):**

- **Google** — four separate built-in plugins: **Gmail**, **Google Drive**, **Google Calendar**, and **Google Sheets**, each authorized separately. Some organization accounts get a single combined **Filo Google** plugin instead.
- **GitHub / GitLab** — the built-in **GitHub** and **GitLab** plugins.
- **Jira / Confluence** — the **XD Atlassian** enterprise plugin, only for organizations that provide it.
- Other built-in plugins include **Art**, **Web Search**, **Mermaid**, and **Notion** (see the Plugins topic).
- Connect accounts on each plugin's detail page. That connection is what gives the plugin's tools access to your account (see the Connections topic).

**Models:**

- The agents can use pay-per-token models through **Cindy AI** (the official service) or through your own providers and API keys, all under **Settings > Providers** (see the Providers topic).

**Custom MCP servers:**

- Add any remote MCP server (http / sse) under **Settings > Tools > External tools > Add MCP server**. Use this for services without a built-in integration.

**Not supported:**

- There is no built-in Microsoft Teams integration. For chat, use one of the IM bots above.
- There's no first-party Linear integration. Add a Linear MCP server yourself under **Settings > Tools > External tools** if you need it.

**Notes:**

- The agents mostly reach these services through their tools (plugins / MCPs), not through the desktop app directly.
