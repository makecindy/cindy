---
id: integrations
title: What Cindy integrates with
summary: Supported external services — chat apps (Slack, Telegram, X, Feishu / Lark, WeChat, WeCom, DingTalk, Discord), Google (Gmail / Drive / Calendar / Sheets plugins), Jira / Confluence (XD Atlassian, some organizations), GitHub, GitLab, custom MCP servers — and what's not supported.
---
At a glance, Cindy integrates with the services below.

**Chat apps (Settings > IM bots):**

The IM bots page lists one chat app per row: the ones you've connected first, then the rest. Click an app to open its own page; **Back** returns to the list.

- **WeChat** — scan to connect and use Cindy from a private chat.
- **Feishu / Lark** — the Cindy official bot, or your own bot (App ID + App Secret). See the Feishu bot topic.
- **WeCom** — your own intelligent bot (Bot ID + Secret). Also hosts **WeCom group notifications** (a group-bot webhook for automation completion alerts).
- **DingTalk** — your own bot (Client ID + Client Secret, Stream mode), for DMs and group chats.
- **Telegram** — the Cindy official bot (**Link Telegram**, no token needed), or your own BotFather token + your Telegram user ID.
- **Slack** — the Cindy official bot: bind one or more Slack workspaces. Each workspace can also turn on **Slack Communications on This Device** where supported (see the Connections topic).
- **Discord** — the Cindy official bot, or your own bot token + your Discord user ID.
- **X** — link your X (Twitter) account and send tasks by mentioning the Cindy bot on X (shown when the server offers it).
- The Cindy official bots need a Cindy account and aren't available in local mode. Each official bot is bound to you and this computer, so only your own messages reach it.
- On each app's page, **Who replies** picks Cindy or one of your buddies. With Cindy, **Project** chooses where new tasks go (they then follow that project in **Projects and models**), and **Model** picks the Agent and model when no project is chosen. With a buddy, the buddy's own model, permissions and memory apply.
- **Group chats** (on Discord, **Channels**) on each app's page lists the groups the bot is in. Open a group to give it its own project, model and permissions, or tick **Members can ask too** so other members who @mention the bot get answers. Their questions run at Auto review at most, and if you don't speak in the group they pause after 10 questions in a row until you @mention the bot there or click **Resume**. Commands only work for you.
- **Projects and models** at the bottom of the list sets the model and permissions for each project, shared by official bots, personal bots and plugins.
- Buddies can also bring their own separate bots from their **Messaging platforms** page. A bot can be connected in only one place.

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
