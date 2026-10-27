---
id: teammates
title: Teammates (Cindy and custom companions)
summary: Teammates are long-lived AI companions (the built-in Cindy plus ones you create) listed at the top of the left sidebar. Chat with them, set their profile, model, memory, capabilities, projects, voice, messaging platforms, and routines; let them run background tasks, follow up on your sessions, and keep todos; put several in a group chat; choose which computer runs them.
---
A **teammate** is a long-lived AI companion with its own name, avatar, personality, memory, skills, and one continuous conversation. **Cindy** is built in and is added automatically the first time you use teammates; you can create more. A teammate belongs to your account, not to one computer: you see the same teammate on every computer and on your phone, but it runs on one **main computer**.

**Where teammates are:**

- The **Teammates** section sits at the top of the left sidebar, above **Pinned** and your task list. It mixes private chats and group chats, newest activity first; pinned ones stay on top. The first 5 show, then **Show all N**.
- Click **Teammates** (the section title) or its arrow to collapse the section into one row of avatars (overflow goes into **+N**). An unread dot marks new replies.
- Hover the section header for the **+** menu: **Discover Teammates**, **New teammate**, **New Group Chat**, and **Enter Invite Link…**. If you have hidden teammates, an eye button there shows or collapses them.
- Right-click a teammate row: **Pin to top** / **Unpin**, **Hide**, **Duplicate teammate** (not for Cindy), **Delete permanently**. Hidden teammates move to **Hidden (N)** at the bottom of the section; click the eye on a row to unhide it.
- The sidebar **Search** also finds teammates (name, introduction, skills) and group chats (group name, member names); they're listed before session results.
- Teammates running on your other computers also show up here, under their main computer.
- When the sidebar is collapsed to icons, the teammates icon (with an unread count) opens the teammate you last viewed.

**Chatting with a teammate:**

- Click a teammate to open its chat and type in the box ("Say something to …"). The conversation is one continuous timeline; it isn't replaced each day. Long histories are compacted automatically, and the teammate keeps the full record and its memory.
- The **permission** chip under the message box works like in a normal task (**Default permissions**, **Auto-review**, **Full access**, and for Claude Code also **Auto accept edits**). There's no model picker in the teammate's message box; set the model in its settings.
- Hover a message for **Reply** (quotes it above the message box) and **Start a thread**. A thread opens in a side panel with its own separate conversation. Work started in a thread reports back in that thread. Threads are desktop-only for now.
- The chat header has the teammate's name/avatar and a gear (both open its settings), a grid button (**… at a glance**, see below), and for teammates on this computer **Add … to a Group Chat** (**New Group Chat…** or **Add to Existing Group**).
- In a normal task you can also @-mention a teammate ("Message or delegate") to send it a message or hand it work.

**Creating a teammate:**

- **+ → New teammate** opens **Create a teammate**. Pick a portrait (or **Upload image**), enter a **Name** (names must be distinct), and check the **Model**. It follows the default teammate model unless you change it ("This selection applies only to this teammate"). If no model is connected, connect a provider first. Click **Create teammate**.
- Cindy then prepares the teammate ("Getting ready to meet"), and it sends a first hello. You can start typing right away. If preparation pauses, everything done so far is saved; use **Change Model** or retry.
- **Import an Agent** (in the same dialog) brings in a teammate from Hermes or OpenClaw on this computer. You can bring its personality, memories, skills, environment and connections, automations, and messaging bots.
- **Discover Teammates** lists ready-made teammates with their skills and routines; click **Invite** to add one. Their routines start turned off.
- You can also ask Cindy to create a teammate for you.

**Teammate settings** (click the name/avatar or gear in the chat header; changes save automatically):

- **Profile** — avatar (**Change avatar**; PNG, JPEG, or WebP under 5 MB), name ("What Should We Call Them?"), and **Self-introduction**.
- **Personality & conversation** — free text describing who the teammate is and how it talks.
- **Memory** — **Use memory** toggle (off: memories aren't read or saved), **What you know about me**, and the teammate's saved memories grouped as About you / Your preferences / Projects / References. Search, edit, or delete them. Each teammate's memory is its own, separate from Settings > Personalization > Memory.
- **Linked Projects** — projects the teammate may read for background when needed (**Choose a project**, **Add**). Linking doesn't assign the project's sessions or start background work.
- **Model** — **Primary Model** with up to 5 candidates (**Add fallback model**; **Backup models (N)**). If one is unavailable, it automatically continues with the next. **Task Model** is the model for new background tasks; by default it uses **Inherit Primary Model**. **Restore default model** goes back to the shared default.
- **Voice** — speech model, voice, speech speed, and **Read by sentence** for voice conversations (see below).
- **Capabilities** — choose which **Built-in tools**, **MCP** servers, and **Skills** this teammate may use (items unavailable on this computer are marked). By default it follows the tools enabled on this computer; turning one off switches to an explicit list. **Input Handoff** lets it ask you to type a password or code on any of your devices; it never sees the value.
- **Messaging platforms** — give the teammate its own bot (see below).
- **Routines** — follow-ups, built-in routines, nightly learning, and your own routines (see below).
- **Search teammate history** — search past messages, background tasks, and archived records.
- **Advanced configuration** — **Open folder** opens the teammate's own folder (SOUL.md, USER.md, system_prompt.md, skills/, memories/). Use it only to fix something by hand.
- Also on the settings home: **Main Computer** (see below), **Restart teammate** (stops the current run for a fresh start; history, memory, and files are kept; send a message to continue), and **Permanently delete teammate**. Deleting removes its profile, memory, working directory, channel connections, and automated tasks. Task history and separate worktrees are kept. A paused teammate shows **Resume teammate**.

**What a teammate can do for you:**

- **Background tasks:** for bigger work, a teammate starts a normal Cindy task. The task shows in your task list as "…'s background task", and a **Background task** card in the chat lets you **Open task** or **Stop task**. The result comes back to the teammate's chat.
- **At a glance** (grid button in the chat header) has up to three blocks:
  - **Computers**: where it runs and other computers it can move to.
  - **Todos**: open todos, due ones first. Click one to quote it in the message box and tell the teammate what to change. Right-click → **Delete**. **Check for me** asks it to look through your connected mail and chats for new todos; **Check every day** does that on weekdays at 9:00 and stays quiet when nothing is new.
  - **Outputs**: finished files from its tasks.
- **Follow Up on My Sessions** (Settings → **Routines**): when on, the teammate reads summaries of sessions you create on this computer, assesses progress, and tells you about important changes. This uses your model allowance. It's off by default, and only one teammate can hold it; Cindy may offer to turn it on in chat (**Start Following Up** / **Not Now**). Tasks you hand to a teammate are followed by that teammate either way (built-in **Follow assigned sessions**). It reacts when they stall, need you, fail, reach a usage limit, or finish. Sessions a teammate is looking after show its avatar in the sidebar ("This task is looked after by …").
- **Routines:** **Add Routine** gives the teammate standing instructions plus triggers (Hourly, Daily, Weekdays, Weekly, Monthly, Interval, Cron, or plugin events; any trigger can start a run). Each routine has **Run Now**, **Run History**, and an optional **Stay quiet when checks find nothing**. Built-in routines can only be paused or resumed. Routines run on the teammate's main computer and are managed on the desktop.
- **Nightly learning** (built-in, on by default): every night at 3:30 (or weekly), it reviews new conversations, tidies memories, and saves approaches that keep coming up as skills. When there's nothing new, it skips without calling a model. Open it under **Routines** for **Review now**, **Frequency**, **History** (with **Undo** per change), and **Approaches being watched** (**Make it a skill** / **Don't learn**). It runs only on the main computer; with memory off, only skills are reviewed.
- Teammates can message each other; those exchanges appear as cards in the chat.

**How permissions work (high level):**

- When you ask in its chat, a teammate acts on your behalf under the chat's permission mode. **Full access** doesn't ask, **Auto-review** reviews automatically, and **Default permissions** asks you. No extra confirmation cards are added.
- When it acts on its own (a follow-up wake-up, a message from another teammate or a stranger), it can only touch its own background tasks and tasks already handed to it. It can keep those going toward the original goal or switch their model. Anything else on your sessions (new requirements, stopping, renaming, archiving, creating or changing routines) becomes a todo or a note to you. Reply to it and the teammate does it on your behalf.
- Routines you set up run as your standing instructions.

**Messaging platforms (the teammate's own bot):**

- On **Messaging platforms**, click **Add platform** and paste the credentials of a bot you created on **Telegram**, **Feishu** / **Lark**, **WeCom**, **DingTalk**, or **Discord**. Credentials stay on this computer. If the same bot is already set up in Settings > IM bots, choose **Use the bot already set up in Cindy** to move it over; Settings > IM bots is then left empty. A bot can be connected in only one place.
- You can also link this computer's **Personal WeChat** to one teammate at a time. Where available, you can assign the official X bot (@askmycindy) to it; X replies are public.
- Anyone who messages the bot is talking to the teammate. Your own messages go into its main conversation with its permissions. Each group, topic, and DM from someone else gets its own hidden task with restricted permissions; risky actions there need your confirmation. If other people can reach the bot, prefer **Auto-review** or **Default permissions** over **Full access**.
- Each connection lists its **… tasks**; **Start over** gives one a clean context while keeping history. For Telegram groups, choose **@ only** or **Always** (reads every message and decides whether to chime in; each one costs tokens). **Remove** stops the bot and deletes its credentials. Memory is shared across all of a teammate's channels.

**Voice conversations (desktop):**

- Set up **Voice** in the teammate's settings (needs a text-to-speech model from a connected provider). Then click **Start voice conversation** in the message box. Speak; it sends after a pause and reads replies aloud. Speak again to interrupt; **Mute** and **End** are on the call bar.
- Work you ask for during a call is handed to the teammate's main conversation ("Work from this call"). A record of the call is saved as a card. Voice mode works for teammates on this computer, one-on-one only; it's not available on the phone.

**Group chats:**

- **+ → New Group Chat**: give it a name and choose teammates (up to 6). Group chats live in the same Teammates section.
- **@** a teammate to have only them reply, or **@Everyone**. **Group Settings** has **When No One Is @Mentioned** (**Anyone Can Reply** / **Only @Mentioned Reply**). A round runs up to 3 passes and 10 messages, then waits for **Continue Discussion**.
- For real work, the **Organizer** can split it into steps. Review the plan card, then **Start Plan** or **Skip Plan**. Each step waits for **Start Next Step** unless **Step handoffs** is on. Set a **Project Folder** for the group; with a git project, each work split gets its own worktree and branch.
- Invite people with **Invite to group** / **Invitation link**; they can bring their own companions (**Invite my companion**). **Access for other members** controls what others may use from your companion: **Owner only**, **Group conversation only**, or **Owner authorized tools and information**.
- Group messages are separate from the teammate's private chat; memories it saves in a group are still its own. Groups can be archived, left (**Leave group**), or dissolved by the owner (**Dissolve group**).

**Main computer and other devices:**

- The computer where you created a teammate is its **Main Computer**. Its working folder, logins, model connections, and routines live there. Other computers and your phone see the same teammate and can chat with it through remote control. This needs "Allow same-account devices to control this machine" on in Settings → Remote Connection on the main computer.
- To move it, use **Main Computer** in its settings or **Computers** in **at a glance**, then **Move to "…"**. Chat history, memory, skills, todos, and routine definitions come along. Working directories, connections, and local files stay where they are. On the new computer it uses that computer's default permissions, and if its model isn't available there, it follows that computer's default model.
- If the main computer is offline, other computers show the cloud copy of the conversation (read only) and offer **Continue on This Computer**. Only visible messages and final replies are saved in the cloud; tool details stay on the main computer.
- If you had a separate Cindy on several computers, Cindy's settings show **Merge Duplicate Cindys**. It merges them into one and keeps everyone's history, memories, skills, todos, and routines.

**On your phone:**

- The phone's home screen starts with the same **Teammates** section (tap **+** to create a teammate or group chat). Creating a teammate needs a computer that's online and signed in to the same account.
- In a chat, tap the teammate's avatar at the top for **at a glance**. Use the settings button for **Teammate settings**: Profile & Personality, Memory, Skills & Connections, Artifacts, Teammate Messages, Models & Permissions, Main Computer, and Messaging platforms.
- Routines can't be managed on the phone (except **Check every day**). Voice conversations and private threads are desktop-only.

**Settings shared by all teammates** (Settings > General > **Teammates**):

- **Default model**: used by teammates that don't choose their own, independent of new-task model choices.
- **Show which message a reply answers**: shows above a teammate's reply which of your messages it answers. It's off by default.
