---
id: commands
title: Slash commands
summary: Type "/" in the composer to open a palette merging your skills, built-in app commands, and the agent's own commands.
---
Type `/` at the start of the composer to open the command palette.

**What's in the palette (priority order on collisions):**

1. **Your installed skills** (highest priority) — anything in your global or project skills directory (see the Skills topic).
2. **Built-in app commands** — `/help` (show available commands), `/clear` (clear the current session context — resets the conversation in place without creating a new session), `/cmd` (run a shell command in the working directory), `/issue` (file an issue), `/goal` (start a goal-driven run), `/learn`, `/workflows`, and `/jump-session`.
3. **The agent's own commands** — e.g. `/compact`, `/agents`, `/memory` (the exact list depends on the agent; Claude Code and Codex each contribute their own).

**Using the palette:**

- Start typing to filter. Matching is **contains-based** (case-insensitive substring matching on the command name) — not fuzzy.
- Up to 25 matches shown at a time.
- **↑ / ↓** move focus, **Enter** runs the focused command, **Esc** closes the palette.

**Notes:**

- If a name collides across sources (same command in a skill and in a built-in), the higher-priority source wins; the lower-priority one is silently skipped (logged as a warning).
- Most built-in app commands run inside the desktop app (a few, like `/workflows` and `/jump-session`, are handled directly in the UI); agent commands are sent as prompt prefixes to the agent.
