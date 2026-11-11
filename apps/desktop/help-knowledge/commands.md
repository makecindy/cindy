---
id: commands
title: Slash commands
summary: Type "/" in the composer to open a palette merging your skills, built-in app commands (/help, /clear, /side, /cmd, /issue, /review, /goal, /plan, /learn …), and the agent's own commands; type "$" for installed plugin commands.
---
Type `/` at the start of a line (or after a space) in the composer to open the command palette.

**What's in the palette (priority order on collisions):**

1. **Your installed skills and Cindy's built-in Skills** (highest priority) — anything in your global or project skills directory, including the built-in `/cindy-skill-creator` (see the Skills topic).
2. **Built-in app commands:**
   - `/help` — show a help card listing every available command with usage examples.
   - `/clear` — clear the current session context in place (wipes its messages and state without creating a new session; the session stays in the sidebar).
   - `/side` — open a side chat with this session's context; any text after it becomes the draft question.
   - `/cmd <command>` — run a shell command in the working directory and show the output in the chat (for a session on another of your computers, it runs on that computer).
   - `/issue [description]` — send feedback or a bug report to the Cindy team (see below).
   - `/review [focus or path]` — review the current session's work in a fresh, read-only reviewer session (local sessions only; see the Reviewing changes topic).
   - `/goal <condition>` — set a goal the agent keeps working toward across turns; `/goal` alone opens the **New goal** dialog, and `/goal clear` clears it.
   - `/plan` — toggle **Plan mode** on or off (when available for the session; see the Plan mode topic).
   - `/learn [description]` — distill a reusable Skill from this session or a described workflow, reviewed as a diff before saving (when enabled; see the Skills topic).
   - `/workflows` — show the progress of workflows running in this session.
   - `/jump-session` — jump straight to a session by its ID.
3. **The agent's own commands** — e.g. `/compact` and `/context` for Claude Code. The exact list depends on the engine (Claude Code, Codex, or Pi).

**Plugin commands (`$`):**

- Type `$` (a full-width `$` or `¥` also works) to open a separate palette listing commands from your installed, enabled plugins.

**Using the palette:**

- Start typing to filter. Matching is substring-based (case-insensitive) on the command name — exact matches rank first, then prefix matches, then other matches; Cindy's official commands rank ahead on ties. It is not fuzzy.
- Up to 25 matches are shown at a time.
- **↑ / ↓** move focus, **Enter** or **Tab** inserts the focused command into the composer (add any arguments, then send), **Esc** closes the palette.

**`/issue` feedback:**

- `/issue` doesn't require a GitHub plugin or GitHub account. Before submitting, the agent helps clarify missing details so the issue is actionable; for bugs it can collect reproduction steps and user-approved, redacted diagnostic summaries.
- The confirmation card always shows the final public **Title** and **Body**, lets you choose the **Submission Identity** — **Cindy official bot (default)**, or **My GitHub account** if a working account is connected on the **GitHub** plugin's detail page under **Plugins** — and set a **Public Attribution** (or **Anonymous**). You must confirm the content contains nothing private before **Submit Feedback**.
- After creation, Cindy returns the issue link and can help you reproduce or fix the problem from source, because Cindy is open source. To see issues you've submitted, open **Issues** from the app menu (top-left **Menu**, or **Help > Issues** in the macOS menu bar).

**Notes:**

- If a name collides across sources (same command in a skill and in a built-in), the higher-priority source wins; the lower-priority one is silently skipped.
- Built-in app commands run inside the desktop app; agent commands and skills are sent to the agent as the start of your prompt.
