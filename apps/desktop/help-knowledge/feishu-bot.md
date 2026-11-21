---
id: feishu-bot
title: Setting up the Feishu / Lark bot
summary: Connect your own Feishu or Lark bot (App ID / App Secret) under Settings > IM bots > Personal to chat with Cindy, get session DMs, and use it in group chats; includes app permissions, event subscription, and troubleshooting.
tab: im-bot
---
Cindy can take requests and send you DMs through a Feishu or Lark bot that you create yourself. (This is unrelated to signing into Cindy — Feishu is not a sign-in method.)

**Setting up the bot:**

- Open **Settings > IM bots**. In the **Personal** section, expand **Feishu / Lark Bot**.
- Under **Service**, choose **Feishu** or **Lark**.
- Don't have a bot yet? Click **Create on Feishu Open Platform ↗** (or **Lark Open Platform**) to create one, then come back with its credentials.
- Paste the bot's **App ID** and **App Secret**, then click **Bind**.
- The status badge shows **Needs configuration** → **Connecting…** → **Connected**. Other states: **Reconnecting…**, **Used by another device**, **Connection failed**.
- Do this in order: bind in Cindy first — this opens the long connection — then save the long-connection events and callback on the Open Platform, and publish the app version last. The next section walks through the Open Platform side.

**Configuring the Feishu app:**

1. **Create the app.** On the Feishu (or Lark) Open Platform, create a **self-built enterprise app** (企业自建应用) and add the **Bot** capability (机器人). **Credentials & Basic Info** (凭证与基础信息) shows the **App ID** and **App Secret** you paste in Cindy. Keep the app on the same platform you picked under **Service**: a Feishu app ID does not work with Lark, or the other way round.
2. **Add permissions.** Under **Permissions & Scopes** (权限管理), enable:

   | Scope | Why it is needed |
   | --- | --- |
   | `im:message.p2p_msg:readonly` | Read the direct messages people send the bot. |
   | `im:message:send_as_bot` | Send and update messages as the app. |
   | `im:message.group_at_msg:readonly` | Receive group messages that @ the bot. |
   | `im:message.group_msg` + `im:message.group_msg.include_bot:read` | Read group history, including messages from other bots. Sensitive; only needed for group context. |
   | `im:chat:readonly` | Optional: show the real group name in session titles. |

3. **Subscribe to events.** In **Events & Callbacks** (事件与回调), set the subscription mode to **Use long connection to receive events** (使用长连接接收事件) and add the **Receive message** event (`im.message.receive_v1`).
4. **Add the card callback.** In **Callback Configuration** (回调配置), choose the long-connection mode and add the **Card action callback** (`card.action.trigger`). Without it, the buttons on Cindy's cards do nothing.
5. **Publish the app.** Create and publish a version. Self-built apps need administrator approval; after approval, make sure your own account is inside the app's **availability scope** (可用范围).

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

**Reading replies:**

- While Cindy works, the reply card shows its latest steps above the answer so far. When the reply is done, the answer stays clean and the steps fold into one line above it (**过程记录 · N 项 · time**). Click that line to review everything Cindy did in this reply; quick answers with no steps don't have it.
- A long reply is never cut off. When it doesn't fit in one Feishu card, it arrives as several cards in order, each marked with its position (for example `2/3`). Code blocks and tables stay intact across cards.
- While a long reply is still being written, the card shows the beginning and a note that the rest will follow; the complete reply arrives when it finishes.

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

**Troubleshooting:**

- **The bot connects, but a direct message gets no reply.** The long connection is up, but the app is not receiving the message event. Check the long-connection subscription and `im.message.receive_v1` in **Events & Callbacks**, publish the version again after changing events, and open **Operations & Monitoring → Log search → Event log search** (运营监控 → 日志检索 → 事件日志检索) to see whether the event arrived.
- **A request fails with error 21001.** The platform blocked it by policy, not by a Cindy setting. Check the developer account, the app and the enterprise status; if they all look correct, contact Feishu support. Retrying the same request does not help.
- **The bot is connected, but it cannot send messages.** Check that the app has the **Bot** capability and `im:message:send_as_bot`. A newly reset App Secret must be entered again in Cindy.
- **@-ing the bot in a group answers without context.** Group context needs `im:message.group_msg` and `im:message.group_msg.include_bot:read`, and a new version must be published after adding them.
- **The status says "Used by another device".** The same App ID is connected elsewhere. Unbind it on one side; a bot can live in only one place.
- **The bot cannot be found in Feishu.** Search for the bot name from the app, not "Cindy", and confirm your account is in the app's availability scope. A self-built app is visible only inside its own enterprise.
- **Feishu and Lark are mixed up.** The app, the service selected in Cindy and the Open Platform you open must all be the same platform.

The Cindy log on the work computer also records connection details. Search it for `bot open_id resolved`, `TOFU: claimed owner`, `fetchBotOpenId failed`, `exceed_conn_limit`, and tenant-token errors (`tenant_access_token`).

**Notes:**

- **Used by another device** means this App ID is already connected on another device or Cindy instance (for example, running two Cindy builds at once). Unbind it on one side to clear the conflict.
- A bot can live in only one place. You can also give a bot to a buddy from that buddy's **Messaging platforms** page. Choosing the bot already set up in Cindy moves it out of Settings > IM bots, and its chats continue with the buddy.
- Settings > IM bots also has an **Official** section (Slack, Telegram, and X through Cindy's official bots, no credentials needed). The **Personal** section also has Personal WeChat, WeCom, DingTalk, Discord, and Telegram bots. See the integrations topic.
