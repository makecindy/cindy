---
id: personalization
title: Custom instructions and the Personalization page
summary: Settings > Personalization — custom instructions the agents follow in every new task, plus Memory, Subagents, Auxiliary models, Vision Bridge, Smart Contacts, context compaction, default terminal shell, where links open, and Tips toggles.
tab: personalization
---
Personalization is where you give the agents standing instructions that apply to **every** new task — tone, language, conventions, things you want the agent to always keep in mind. The same page also holds several agent-behavior settings.

**Custom instructions:**

- Open **Settings > Personalization**. The first section (**Personalization · Custom Prompts**) has a text box for your instructions.
- Write your instructions, then click **Save**. The limit is 8,000 characters; a counter shows how much you've used.
- They're appended to the end of the agent's system prompt in Cindy's own tasks.
- Useful examples: "respond in Chinese", "default to TypeScript", "prefer pnpm over npm", "always check tests before reporting done".

**Other sections on this page:**

- **Memory** — long-term memory across tasks (see the Memory topic).
- **Subagents** — the default model Claude Code uses for subagents, and **Codex smart routing** (lets Codex pick from more connected models per subtask; off uses Codex's native assignment).
- **Auxiliary models** — the small models used for background chores such as automatic task naming, composer input suggestions, the Help assistant, pinned-task summaries, and IM titles. Keep **Automatic recommendation**, or choose **Custom** to set a **Preferred** model and up to two fallbacks.
- **Vision Bridge** — lets text-only models (e.g. DeepSeek) read images: images are first described by a multimodal model you choose (a **Primary** plus an optional **Backup**). Turn on **Enable Vision Bridge**, then pick which models route through it.
- **Smart Contacts** — a people / organization directory the agents can look up and add to as they work (uncertain entries wait in **Pending** for your review). You can browse, search, and edit entries here, and optionally turn on **Sync across my devices**.
- **Context compaction** — the context-usage percentage at which Claude Code and Pi automatically compact a long conversation (Codex sets its own threshold).
- **Default terminal shell** — the shell used for new terminal tabs in the right sidebar (existing tabs aren't affected).
- **Open Links** — whether links in messages open in Cindy's **Built-In Browser** or your **System Default Browser**, set separately for web pages and local pages. Right-click a link to pick another option just for that link.
- **Tips** — a few functional toggles: **Input Suggestions** (suggests your next message after a reply; press Tab to insert it), **Silently drop protocol-encrypted content and retry** (helps when switching providers mid-task; on by default), **Enable chat semantic indexing** (not available in local mode), and **Show question navigation rail** (tick marks beside the chat to jump between your questions).

**Notes:**

- Custom instructions apply to **new tasks**; tasks that are already running keep the instructions they started with and don't rewrite earlier messages.
- They apply only to Cindy's built-in tasks, not to Claude Code, Codex, or Pi you run yourself in a terminal or another IDE.
- Custom instructions are saved on this computer for your signed-in account; they don't sync to other devices.
- For a stricter rule in one specific task, put it in that task's first message instead.
- Don't put secrets here — the instructions are sent to the model with every task.
