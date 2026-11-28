---
id: feishu-bot
title: Setting up the Feishu / Lark bot
summary: Connect your own Feishu or Lark bot (App ID / App Secret) under Settings > IM bots > Feishu / Lark to chat with Cindy or a buddy, get session DMs, and use it in group chats.
tab: im-bot
---
Cindy can take requests and send you DMs through a Feishu or Lark bot that you create yourself. (This is unrelated to signing into Cindy — Feishu is not a sign-in method.)

**Setting up the bot:**

- Open **Settings > IM bots** and click **Feishu / Lark**. Each chat app has its own page; **Back** returns to the list.
- If the page offers both the Cindy official bot and your own bot, find **Your own bot** and click **Set up**.
- Under **Service**, choose **Feishu** or **Lark**.
- Don't have a bot yet? Click **Create on Feishu Open Platform ↗** (or **Lark Open Platform**) to create one, then come back with its credentials.
- Paste the bot's **App ID** and **App Secret**, then click **Bind**.
- The status badge shows **Needs configuration** → **Connecting…** → **Connected**. Other states: **Reconnecting…**, **Used by another device**, **Connection failed**.

**Binding the bot to you:**

- After it connects, send the bot any private message once. The first person to DM the bot becomes its **Owner**; until then the card shows "Waiting for first private-message bind".
- DMs from anyone other than the owner are silently ignored.
- The connection row shows the service, the end of the App ID, and the status, with a reconnect button; **Unbind this bot** is below it. Unbinding disconnects the bot and removes the saved App ID / App Secret / owner from this computer.

**Who replies, project and model:**

- **Who replies** picks **Cindy** or one of your buddies. When a buddy replies, its own model, permissions and memory apply, and the **Project** and **Model** rows are hidden; open **{buddy}’s settings** to change them. Switch once the bot has no queued messages or running task.
- **Project** puts new tasks into one of your sidebar projects. They then use that project's model and permissions from **Projects and models** (on the IM bots list). Choose **Chat (no project)** to use the bot's own model instead. Groups can still have their own project under **Group settings**.
- **Model** (shown when no project is chosen) picks the Agent and model for new Feishu conversations (or **Automatic**, which uses an available recommended model). Existing chats switch on their next message unless their model was changed manually.
- **Permission mode for new group tasks** sets the permission mode for every session created in a group chat (@-ing the bot, `/new`, `/ctr`). It defaults to **Auto-review**. Group messages can come from other members, so choose **Full access** only for groups you trust. Use `/permission` in the group to change an existing one.

**Notifications (shown after the bot is bound):**

- **Online/offline announcement → Message notification** — the bot posts a message when this computer connects or disconnects.
- **Session notifications → Send a Feishu / Lark DM when a session finishes or needs a reply** — DMs you only while the Cindy window is unfocused. You can turn it on only after the owner is bound.
- **System Notifications** (desktop pop-ups) is a separate toggle in **Settings > General > Notifications** — see the language and notifications topic.

**Chat commands:**

- `/new` starts a fresh context, `/model` switches the model, `/permission` changes the permission mode, `/ctr` takes over a desktop session (`/exctr` ends the takeover), and `/help` lists the commands.
- Send `!stop` to stop the current run and clear queued messages. The session is kept, so you can continue it.

**Reading replies:**

- While Cindy works, the reply card shows its latest steps above the answer so far. When the reply is done, the answer stays clean and the steps fold into one line above it (**过程记录 · N 项 · time**). Click that line to review everything Cindy did in this reply; quick answers with no steps don't have it.
- A long reply is never cut off. When it doesn't fit in one Feishu card, it arrives as several cards in order, each marked with its position (for example `2/3`). Code blocks and tables stay intact across cards.
- While a long reply is still being written, the card shows the beginning and a note that the rest will follow; the complete reply arrives when it finishes.

**Group chats:**

- In a group, @ the bot to ask a question. The bot opens a new thread (话题) for the reply, so the main chat stays clean and each thread is its own session.
- When @-ed in the main chat, the bot reads back through recent group messages (newest first, up to about 250) and stops once they're no longer relevant to your question. It answers with that history as context, including images and files shared in the chat.
- @-ing the bot inside an existing thread uses that thread's own history as context.
- These sessions appear in the sidebar's Chat group: thread sessions are titled like `[飞书·{group name}·{topic summary}] {id suffix}`, group sessions `[飞书·群] {group name}`, and DMs `[飞书·DM] {summary}`. Lark bots use "Lark" instead of "飞书".

**Per-group settings:**

- On the Feishu / Lark page, **Group chats** lists the groups the bot is in. Open one to set its own project, model and permissions, or tick **Members can ask too** so other members who @mention the bot get answers (at Auto review at most; paused after 10 questions in a row while you're away, until you @mention the bot or click **Resume**). Without it, other members get a short polite reply and no task.

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
- A bot can live in only one place. To let a buddy answer through it, set **Who replies** to that buddy; the bot stays in Settings > IM bots and the buddy's **Messaging platforms** page lists it. A buddy can also bring a separate bot of its own from that page.
- Feishu / Lark also has the **Cindy official bot** (no credentials needed), and its **Who replies** can be a buddy too. Settings > IM bots also lists WeChat, WeCom, DingTalk, Telegram, Slack, Discord and X. See the integrations topic.
