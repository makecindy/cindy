---
id: feishu-bot
title: Setting up the FeiShu (Lark) bot
summary: Configure the FeiShu bot (App ID / App Secret) in Settings > IM bots to get DM notifications and bot interaction.
tab: im-bot
---
Cindy can send DMs and take commands through a FeiShu (Lark) bot. (This is unrelated to signing into Cindy — you sign in with your Cindy account; FeiShu is no longer a login method.)

**Setting up the bot:**

- Open Settings > IM bots, then the FeiShu Bot section.
- Paste the bot's **App ID** and **App Secret**, then click **Bind**.
- The status badge updates: **needs-config** → **connecting** → **connected** (or **conflict** / **error**).

**Binding the bot to you:**

- After the badge shows **connected**, the page instructs you to DM the bot a code (or click an action) to complete the binding. Until you bind, the bot won't know which FeiShu user to DM.

**Notifications:**

- Toggle **message notifications** on the same page to get bot DMs when sessions finish, or when the bot has updates for you.
- The desktop-OS-level "session finished" notification is a separate toggle in **Settings > General > Notifications**.

**Group chats:**

- In a group, @ the bot to ask a question. The bot opens a new thread (话题) for the reply — the main stream stays clean and each thread is its own session, like Slack threads.
- The bot pages back through recent chat history (newest first, until the messages stop being relevant to your question) and answers with that history as context — including images and files shared in the chat. For a fresh thread opened from the main stream, the context still comes from the main stream history.
- @-ing the bot inside an existing thread uses that thread's own history as context.
- Thread sessions are titled `[飞书·{group name}·{topic summary}] {id suffix}` in the sidebar.

**Permissions for group features:**

Group chat context needs an extra app permission that is not part of the default setup:

1. Open the **FeiShu (Lark) Open Platform** → Developer Console → your app → **Permissions & Scopes** (权限管理).
2. Search for and enable **both** of the following (searching by the scope id works regardless of the console language):
   - **"Read all messages in associated group chat" (获取群组中所有消息, `im:message.group_msg`)** — pulls the chat history via API.
   - **"Read user and bot messages in group chats" (获取群组中用户和机器人消息, `im:message.group_msg.include_bot:read`)** — needed for group message events, so the history covers messages from other bots too.
   These are sensitive permissions: on FeiShu they are only available to self-built apps (自建应用), not store apps.
3. Create and publish a new app **version** (self-built apps need admin approval).

Without it the bot still answers when @-ed, but with no chat context, and it DMs the owner a one-line heads-up pointing here. Optionally, enabling **"Obtain basic group information" (获取群基本信息, `im:chat:readonly`)** lets session titles show the real group name instead of an id suffix.

**Notes:**

- The "conflict" badge state means another Cindy instance is already bound to the same bot for this user — typical when running dev + release simultaneously. Disconnect on one side to clear it.
- Settings > IM bots also hosts the Slack and Telegram bindings (the "Cindy" tab) and a bring-your-own Discord bot, alongside this FeiShu bot.
