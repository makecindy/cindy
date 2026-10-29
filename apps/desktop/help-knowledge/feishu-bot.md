---
id: feishu-bot
title: Setting up the Feishu / Lark bot
summary: Connect your own Feishu or Lark bot (App ID / App Secret) under Settings > IM bots > Personal to chat with Cindy, get session DMs, and use it in group chats.
tab: im-bot
---
Cindy can take requests and send you DMs through a Feishu or Lark bot that you create yourself. (This is unrelated to signing into Cindy — Feishu is not a sign-in method.)

**Setting up the bot:**

- Open **Settings > IM bots**. In the **Personal** section, expand **Feishu / Lark Bot**.
- Under **Service**, choose **Feishu** or **Lark**.
- Don't have a bot yet? Click **Create on Feishu Open Platform ↗** (or **Lark Open Platform**) to create one, then come back with its credentials.
- Paste the bot's **App ID** and **App Secret**, then click **Bind**.
- The status badge shows **Needs configuration** → **Connecting…** → **Connected**. Other states: **Reconnecting…**, **Used by another device**, **Connection failed**.

**Binding the bot to you:**

- After it connects, send the bot any private message once. The first person to DM the bot becomes its **Owner**; until then the card shows "Waiting for first private-message bind".
- DMs from anyone other than the owner are silently ignored.
- The bound card shows the service, App ID, and owner, with **Reconnect Bot** and **Unbind**. Unbinding disconnects the bot and removes the saved App ID / App Secret / owner from this computer.

**New conversation settings:**

- **New Conversation Configuration** in the same card picks the Agent and model for new Feishu conversations (or **Automatic**, which uses an available recommended model). Existing chats switch on their next message unless their model was changed manually.
- **Permission mode for new group tasks** sets the permission mode for every session created in a group chat (@-ing the bot, `/new`, `/ctr`). It defaults to **Auto-review**. Group messages can come from other members, so choose **Full access** only for groups you trust. Use `/permission` in the group to change an existing one.

**Notifications (shown after the bot is bound):**

- **Online/offline announcement → Message notification** — the bot posts a message when this computer connects or disconnects.
- **Session notifications → Send a Feishu / Lark DM when a session finishes or needs a reply** — DMs you only while the Cindy window is unfocused. You can turn it on only after the owner is bound.
- **System Notifications** (desktop pop-ups) is a separate toggle in **Settings > General > Notifications** — see the language and notifications topic.

**Chat commands:**

- `/new` starts a fresh context, `/model` switches the model, `/permission` changes the permission mode, `/ctr` takes over a desktop session (`/exctr` ends the takeover), and `/help` lists the commands.
- Send `!stop` to stop the current run and clear queued messages. The session is kept, so you can continue it.

**Group chats:**

- In a group, @ the bot to ask a question. The bot opens a new thread (话题) for the reply, so the main chat stays clean and each thread is its own session.
- When @-ed in the main chat, the bot reads back through recent group messages (newest first, up to about 250) and stops once they're no longer relevant to your question. It answers with that history as context, including images and files shared in the chat.
- @-ing the bot inside an existing thread uses that thread's own history as context.
- These sessions appear in the sidebar's Chat group: thread sessions are titled like `[飞书·{group name}·{topic summary}] {id suffix}`, group sessions `[飞书·群] {group name}`, and DMs `[飞书·DM] {summary}`. Lark bots use "Lark" instead of "飞书".

**Permissions for group features:**

Group chat context needs extra app permissions that are not part of the default setup:

1. Open the **Feishu (or Lark) Open Platform** → Developer Console → your app → **Permissions & Scopes** (权限管理).
2. Search for and enable **both** of these (searching by the scope ID works in any console language):
   - **"Read all messages in associated group chat" (获取群组中所有消息, `im:message.group_msg`)** — lets the bot read chat history.
   - **"Read user and bot messages in group chats" (获取群组中用户和机器人消息, `im:message.group_msg.include_bot:read`)** — includes messages from other bots in that history.
   These are sensitive permissions: on Feishu they are only available to self-built apps (自建应用), not store apps.
3. Create and publish a new app **version** (self-built apps need admin approval).

Without these permissions the bot still answers when @-ed, but without chat context, and it DMs the owner a short notice with a link to the app's permission page. Optionally, enabling **"Obtain basic group information" (获取群基本信息, `im:chat:readonly`)** lets session titles show the real group name instead of an ID suffix.

**Notes:**

- **Used by another device** means this App ID is already connected on another device or Cindy instance (for example, running two Cindy builds at once). Unbind it on one side to clear the conflict.
- A bot can live in only one place. You can also give a bot to a teammate from that teammate's **Messaging platforms** page. Choosing the bot already set up in Cindy moves it out of Settings > IM bots, and its chats continue with the teammate.
- Settings > IM bots also has an **Official** section (Slack, Telegram, and X through Cindy's official bots, no credentials needed). The **Personal** section also has Personal WeChat, WeCom, DingTalk, Discord, and Telegram bots. See the integrations topic.
