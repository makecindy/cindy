---
id: connections
title: Connecting external accounts
summary: External accounts (the Gmail / Google Drive / Google Calendar / Google Sheets plugins, GitHub, GitLab, and Jira / Confluence via XD Atlassian for organizations that provide it) are connected on each plugin's detail page under Plugins; Slack, Telegram, X and personal chat bots are set up under Settings > IM bots; ChatGPT / Claude / Grok subscriptions and Cindy AI live in Settings > Providers.
---
There is no separate "Third-Party Platforms" settings page any more — each integration lives on its own plugin detail page under **Plugins**, and the plugin's tools use the account you connect there. Chat apps are set up under **Settings > IM bots**, and model accounts under **Settings > Providers**.

**Where to connect what:**

- **Slack** — **Settings > IM bots**, **Official** section (requires a Cindy account). Turn on the Slack card to authorize; use **Add Slack workspace** to bind more workspaces. Each workspace has **Slack Communications on This Device** when the server supports it: multiple authorized devices can search, read, and post as the Slack user, while only one device receives Bot chats and tasks. Turning off local communications does not revoke the account or affect other devices. Enabling communications on a previously displaced device may open Slack authorization, but never takes over the Bot.
- **Telegram (official bot)** — **Settings > IM bots**, **Official** section: turn on Telegram and choose **Link Telegram**. Open the one-time link, start the official Cindy bot, and confirm if prompted. The same card lets you cancel, retry, open the bot, add it to a group, or unlink; no personal bot token is required.
- **X (Twitter)** — **Settings > IM bots**, **Official** section: authorize your X account, then mention the Cindy bot in a post to send a task to this device. Replies are posted publicly, so use it only for public questions.
- **Your own chat bots** — **Settings > IM bots**, **Personal** section: **Personal WeChat**, **WeCom Intelligent Bot**, **Feishu / Lark Bot** (App ID / App Secret; see the Feishu bot topic), **DingTalk Bot**, **Discord Bot**, and **Telegram Bot** (your own bot token). You manage these credentials yourself.
- **Google** — the separate **Gmail**, **Google Drive**, **Google Calendar**, and **Google Sheets** plugins (**Plugins > Gmail**, and so on). Each one is authorized separately on its own detail page. Some organization accounts get a single combined **Filo Google** plugin instead.
- **Jira / Confluence** — the **XD Atlassian** enterprise plugin (**Plugins > XD Atlassian**), only for organizations that provide it. Earlier Jira / Confluence connections carry over automatically.
- **GitHub** — the **GitHub** plugin (**Plugins > GitHub**; earlier token connections carry over automatically). This connection is optional for `/issue`: feedback uses Cindy's official bot by default, and a working GitHub connection only adds the option to submit as yourself.
- **GitLab** — the **GitLab** plugin (**Plugins > GitLab**; earlier token connections carry over automatically).
- **ChatGPT (Codex), Claude, and Grok subscriptions** — **Settings > Providers**: **OpenAI** (use your local Codex account or sign in to a separate ChatGPT account), **Anthropic** (**Sign in with Claude Code**), and **xAI** (SuperGrok). This is separate from the Codex / Claude Code programs the app ships with.
- **Cindy AI** — **Settings > Providers**, provisioned automatically after you sign in to Cindy. The **Web Search** plugin uses this account by default and needs no key; optional Brave / Tavily / DeepSeek search keys are configured on that plugin's detail page.
- **Feishu / Lark** is bot-only (see above); it is not a sign-in method for Cindy itself.

**Managing connections:**

- Each plugin detail page shows the connected account(s) and their status, and lets you reconnect or disconnect. If a plugin later needs new permissions, it asks you to reconnect.
- Disconnect removes the local token only; you may also want to revoke access on the provider's side.
- A connection error usually means the token expired or was revoked on the provider's side; reconnect to refresh.
