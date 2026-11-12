---
id: buddies
title: Buddies (Cindy and custom companions)
summary: Buddies are long-lived AI companions (the built-in Cindy plus ones you create) listed at the top of the left sidebar. Chat with them, set their profile, model, memory, capabilities, projects, voice, and messaging platforms; give them automations; let them open tasks, follow up on your sessions, and keep todos; put several in a group chat; choose which computer runs them.
---
A **buddy** is a long-lived AI companion with its own name, avatar, personality, memory, skills, and one continuous conversation. **Cindy** is built in and is added automatically the first time you use buddies; you can create more. A buddy belongs to your account, not to one computer: you see the same buddy on every computer and on your phone, but it runs on one **main computer**.

**Where buddies are:**

- The **Buddies** section sits at the top of the left sidebar, above **Pinned** and your task list. It mixes private chats and group chats, newest activity first; pinned ones stay on top. The first 5 show, then **Show all N**.
- Click **Buddies** (the section title) or its arrow to collapse the section into one row of avatars (overflow goes into **+N**). An unread dot marks new replies.
- Hover the section header for the **+** menu: **Discover Buddies**, **New buddy**, **New Group Chat**, and **Enter Invite Link…**. If you have hidden buddies, an eye button there shows or collapses them.
- Right-click a buddy row: **Pin to top** / **Unpin**, **Hide**, **Duplicate buddy** (not for Cindy), **Delete permanently**. Hidden buddies move to **Hidden (N)** at the bottom of the section; click the eye on a row to unhide it.
- The sidebar **Search** also finds buddies (name, introduction, skills) and group chats (group name, member names); they're listed before session results.
- Buddies running on your other computers also show up here, under their main computer.
- When the sidebar is collapsed to icons, the buddies icon (with an unread count) opens the buddy you last viewed.

**Chatting with a buddy:**

- Click a buddy to open its chat and type in the box ("Say something to …"). The conversation is one continuous timeline; it isn't replaced each day. Long histories are compacted automatically, and the buddy keeps the full record and its memory.
- The **permission** chip under the message box works like in a normal task (**Default permissions**, **Auto-review**, **Full access**, and for Claude Code also **Auto accept edits**). There's no model picker in the buddy's message box; set the model in its settings.
- Hover a message for **Reply** (quotes it above the message box) and **Start a thread**. A thread opens in a side panel with its own separate conversation. Work started in a thread reports back in that thread. Threads are desktop-only for now.
- The chat header has the buddy's name/avatar and a gear (both open its settings), a grid button (**… at a glance**, see below), and for buddies on this computer **Add … to a Group Chat** (**New Group Chat…** or **Add to Existing Group**).
- In a normal task you can also @-mention a buddy ("Message or delegate") to send it a message or hand it work.

**Creating a buddy:**

- **+ → New buddy** opens **Create a buddy**. Pick a portrait (or **Upload image**), enter a **Name** (names must be distinct), and check the **Model**. It follows the default buddy model unless you change it ("This selection applies only to this buddy"). If no model is connected, connect a provider first. Click **Create buddy**.
- Cindy then prepares the buddy ("Getting ready to meet"), and it sends a first hello. You can start typing right away. If preparation pauses, everything done so far is saved; use **Change Model** or retry.
- **Import an Agent** (in the same dialog) brings in a buddy from Hermes or OpenClaw on this computer. You can bring its personality, memories, skills, environment and connections, automations, and messaging bots.
- **Discover Buddies** lists ready-made buddies with their skills; click **Invite** to add one.
- You can also ask Cindy to create a buddy for you.

**Buddy settings** (click the name/avatar or gear in the chat header; changes save automatically):

- **Profile** — avatar (**Change avatar**; PNG, JPEG, or WebP under 5 MB), name ("What Should We Call Them?"), and **Self-introduction**.
- **Personality & conversation** — free text describing who the buddy is and how it talks.
- **Memory** — **Use memory** toggle (off: memories aren't read or saved), **What you know about me**, and the buddy's saved memories grouped as About you / Your preferences / Projects / References. Search, edit, or delete them. Each buddy's memory is its own, separate from Settings > Personalization > Memory.
- **Linked Projects** — projects the buddy may read for background when needed (**Choose a project**, **Add**). Linking doesn't assign the project's sessions or start background work.
- **Model** — **Primary Model** with up to 5 candidates (**Add fallback model**; **Backup models (N)**). If one is unavailable, it automatically continues with the next. **Restore default model** goes back to the shared default. When a buddy starts a new task, it picks that task's model itself (you can tell it which one you prefer).
- **Voice** — speech model, voice, speech speed, and **Read by sentence** for voice conversations (see below).
- **Capabilities** — choose which **Built-in tools**, **MCP** servers, and **Skills** this buddy may use (items unavailable on this computer are marked). By default it follows the tools enabled on this computer; turning one off switches to an explicit list. Cindy built-in Skills and verified official plugin Skills are inherited automatically and follow their enabled state on this computer. Personal, third-party, and engine-provided Skills remain opt-in. **Input Handoff** lets it ask you to type a password or code on any of your devices; it never sees the value.
- **Messaging platforms** — give the buddy its own bot (see below).
- **Search buddy history** — search past messages, tasks it opened, and archived records.
- **Advanced configuration** — **Open folder** opens the buddy's own folder (SOUL.md, USER.md, system_prompt.md, skills/, memories/). Use it only to fix something by hand.
- Also on the settings home: **Main Computer** (see below), **Restart buddy** (stops the current run for a fresh start; history, memory, and files are kept; send a message to continue), and **Permanently delete buddy**. Deleting removes its profile, memory, working directory, channel connections, and automated tasks. Task history and separate worktrees are kept. A paused buddy shows **Resume buddy**.

**What a buddy can do for you:**

- **Tasks:** for bigger work, a buddy opens an ordinary Cindy task. It shows in your task list with the buddy's avatar, and when the buddy asks for the result, its final reply comes back to the buddy's chat once. **Background task** cards from earlier versions stay in the chat history and still open their task; they no longer offer **Stop task** or adding a note.
- **At a glance** (grid button in the chat header) has up to three blocks:
  - **Computers**: where it runs and other computers it can move to.
  - **Todos**: open todos, due ones first. Click one to quote it in the message box and tell the buddy what to change. Right-click → **Delete**. **Check for me** asks it to look through your connected mail and chats for new todos; **Check every day** does that on weekdays at 9:00 and stays quiet when nothing is new.
  - **Outputs**: finished files from its tasks.
- **Automations:** recurring or triggered work is an ordinary automation of the buddy's own project (see Scheduling automations). Ask the buddy to set one up, or create it yourself. Routines from earlier versions become automations of that project, keeping their schedule and paused or running state.
- Buddies can message each other; those exchanges appear as cards in the chat.

**How permissions work (high level):**

- When you ask in its chat, a buddy acts on your behalf under the chat's permission mode. **Full access** doesn't ask, **Auto-review** reviews automatically, and **Default permissions** asks you. No extra confirmation cards are added.
- When something else starts its turn (a message from another task or buddy, or an automation), it works like any other task under the same permission mode. There are no extra buddy-only limits, and nothing is turned into a todo for you.
- Automations you set up run as your standing instructions.

**Messaging platforms (the buddy's own bot):**

- On **Messaging platforms**, click **Add platform** and paste the credentials of a bot you created on **Telegram**, **Feishu** / **Lark**, **WeCom**, **DingTalk**, or **Discord**. Credentials stay on this computer. If the same bot is already set up in Settings > IM bots, choose **Use the bot already set up in Cindy** to move it over; Settings > IM bots is then left empty. A bot can be connected in only one place.
- You can also link this computer's **Personal WeChat** to one buddy at a time. Where available, you can assign the official X bot (@askmycindy) to it; X replies are public.
- After owner binding, **Telegram**, **Feishu** / **Lark**, **WeCom**, **DingTalk**, and **Discord** bots accept private messages only from their bound owner. Telegram sends other people a fixed rejection at most once per minute; Feishu / Lark ignores their private messages. Your own messages go into the buddy's main conversation. Groups and topics follow each connection's participation settings and get separate hidden tasks. These separate conversations do not isolate access to the buddy's files or memory. Group tools follow its permission mode; **Full access** can let admitted members use tools without asking you. Prefer **Auto-review** or **Default permissions** when other people can reach the bot.
- Each connection lists its **… tasks**; **Start over** gives one a clean context while keeping history. For Telegram groups, choose **@ only** or **Always** (reads every message and decides whether to chime in; each one costs tokens). **Remove** stops the bot and deletes its credentials. Memory is shared across all of a buddy's channels.

**Voice conversations (desktop):**

- Set up **Voice** in the buddy's settings (needs a text-to-speech model from a connected provider). Then click **Start voice conversation** in the message box. Speak; it sends after a pause and reads replies aloud. Speak again to interrupt; **Mute** and **End** are on the call bar.
- Work you ask for during a call is handed to the buddy's main conversation ("Work from this call"). A record of the call is saved as a card. Voice mode works for buddies on this computer, one-on-one only; it's not available on the phone.

**Group chats:**

- **+ → New Group Chat**: give it a name and choose buddies (up to 6). Group chats live in the same Buddies section.
- **@** a buddy to have only them reply, or **@Everyone**. **Group Settings** has **When No One Is @Mentioned** (**Anyone Can Reply** / **Only @Mentioned Reply**). A round runs up to 3 passes and 10 messages, then waits for **Continue Discussion**.
- For real work, the **Organizer** can split it into steps. Review the plan card, then **Start Plan** or **Skip Plan**. Each step waits for **Start Next Step** unless **Step handoffs** is on. Set a **Project Folder** for the group; with a git project, each work split gets its own worktree and branch.
- Invite people with **Invite to group** / **Invitation link**; they can bring their own companions (**Invite my companion**). **Access for other members** controls what others may use from your companion: **Owner only**, **Group conversation only**, or **Owner authorized tools and information**.
- Group messages are separate from the buddy's private chat; memories it saves in a group are still its own. Groups can be archived, left (**Leave group**), or dissolved by the owner (**Dissolve group**).

**Main computer and other devices:**

- The computer where you created a buddy is its **Main Computer**. Its working folder, logins, model connections, and automations live there. Other computers and your phone see the same buddy and can chat with it through remote control. This needs "Allow same-account devices to control this machine" on in Settings → Remote Connection on the main computer.
- To move it, use **Main Computer** in its settings or **Computers** in **at a glance**, then **Move to "…"**. Chat history, memory, skills, and todos come along. Working directories, connections, and local files stay where they are. On the new computer it uses that computer's default permissions, and if its model isn't available there, it follows that computer's default model.
- If the main computer is offline, other computers show the cloud copy of the conversation (read only) and offer **Continue on This Computer**. Only visible messages and final replies are saved in the cloud; tool details stay on the main computer.
- If you had a separate Cindy on several computers, Cindy's settings show **Merge Duplicate Cindys**. It merges them into one and keeps everyone's history, memories, skills, and todos.

**On your phone:**

- The phone's home screen starts with the same **Buddies** section (tap **+** to create a buddy or group chat). Creating a buddy needs a computer that's online and signed in to the same account.
- In a chat, tap the buddy's avatar at the top for **at a glance**. Use the settings button for **Buddy settings**: Profile & Personality, Memory, Skills & Connections, Artifacts, Buddy Messages, Models & Permissions, Main Computer, and Messaging platforms.
- Voice conversations and private threads are desktop-only.

**Settings shared by all buddies** (Settings > General > **Buddies**):

- **Default model**: used by buddies that don't choose their own, independent of new-task model choices.
- **Show which message a reply answers**: shows above a buddy's reply which of your messages it answers. It's off by default.
