---
id: plan-mode
title: Plan mode and reviewing plans
summary: Turn on Plan mode from the composer's "+" menu (or type /plan) so the agent proposes a plan first; then approve it, edit it, send feedback, or dismiss it before any work starts.
---
In **Plan mode** the agent first proposes a **plan** and waits for your approval before it starts doing the work. It's available for Claude Code, Codex, and Pi tasks.

**Turning Plan mode on:**

- Click the **+** button in the composer (or type `@`) and choose **Plan mode**, or type `/plan` and pick it.
- While it's on, a **Plan mode** chip appears above the composer. Click the ✕ on the chip (**Exit plan mode**) to turn it off.
- After you approve a plan, Plan mode turns off automatically and the agent starts executing. To plan again, turn it back on.

**Reviewing the plan:**

When the plan is ready, a **Review the agent's plan** card replaces the composer at the bottom of the task, with the plan and a **Content** outline beside it.

- **Approve the plan and start coding** — click it or press **Enter**. The agent receives the plan (including your edits) and starts working.
- **Tell the agent what to do instead** — click this row, type your feedback, and press Enter or click send. The agent revises the plan and shows it again.
- **Edit plan** (toolbar) — edit the plan's Markdown directly. Edits are saved automatically, and Approve uses the edited version. **Exit edit mode** goes back to the formatted view.
- **Dismiss this plan** (the toolbar **✕**, or **Esc**) — closes the review without approving or sending feedback; the agent doesn't start the work.
- **Expand / Collapse to half / Minimize** — change the card's size so you can read the chat above it; a minimized card can be restored from its bar.

**In the chat history:**

- Each plan stays in the task as a **Plan review** entry marked **Approved**, **Revision requested** (with your feedback), **Cancelled**, or **Expired**. Use **Show full plan** to read an approved plan again.
- If the agent's turn is stopped or the task closes before you decide, the review is marked **Expired** and can no longer be answered — send a new message to continue.

**Notes:**

- You can also review and approve plans from the Cindy mobile app when you control this computer from your phone.
