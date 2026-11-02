---
id: scheduler
title: Scheduling automations
summary: Automations run a prompt (or a script) for you on a schedule, once, or on demand — open Automations in the left sidebar to create, pause, run, and review them.
---
**Automations** run a prompt for you on a schedule — recurring, once, or only when you trigger it. Open **Automations** from the top of the left sidebar (if you've customized the sidebar, it may be under **More**).

**Creating an automation:**

- Click **New Automation**. Start from a template (**Start from a template** — e.g. nightly test self-healing, PR gatekeeper, domain radar) or choose **Blank**.
- Give it a title and a **prompt**, and choose where it runs: a **project** folder (optionally an isolated **worktree**, under **Advanced**) or a plain chat with no project.
- Pick the **model** (and reasoning effort); the engine — Claude Code, Codex, or Pi — follows the model.
- **Schedule**: **Automatic** or **Manually** (runs only when you click Run now). For Automatic, choose a preset — every N minutes, hourly, daily, weekdays, weekly, or monthly — in **Cron** mode (fixed clock times) or **Relative interval** mode (waits that long after the previous run finishes). Tick **Once** to run a single time at the next scheduled slot.
- **Run session**: **New each run**, **Continuous session** (every run continues the same session), or **Bind existing session**.
- Optional: **Stay quiet when checks find nothing** (only report changes or problems), send the result to a Feishu bot or WeCom group, and a **Pre-run check** — a command that decides whether a round runs or is skipped (**Generate with AI** can write it for you).
- **Execution** can also be **Script only**: run a command in a project directory without an AI turn.
- You can also ask an agent in any session to set up an automation for you.

**Managing automations:**

- The list groups automations by project and filters by status (All / Active / Paused).
- **Run now**, **Edit**, **Rename**, **Pause** / **Resume**, and **Delete Automation**. Deleting asks what to do with the sessions it created: keep, archive, or delete them. Pausing or deleting stops any run in progress.
- **Promote to project automation** saves it into the project's repository so collaborators share it; project automations are edited through their config file.

**Run history:**

- Select an automation to see **Recent runs**: when each ran, its status (Success, Skipped, Aborted, Interrupted, …), duration, cost, and pre-run check output. **Open session** shows what the agent did; **Restart** re-runs, and a run record can be deleted.

**Notes:**

- Automations run locally: they only fire while Cindy is running on this computer (closing the window to the tray is fine). Runs missed while the app was closed are not made up — the next one fires at the next scheduled time. To stop the computer from sleeping, turn on **Keep computer awake** in **Settings > General > App Behavior**.
- Automation runs are normal sessions; in the sidebar they're grouped under the automation's name (marked "Created by automation"), with Run now / Edit / Pause there too.
- A limited number of runs execute at the same time; others show "Waiting for a slot" and start as soon as one frees up.
- If several Cindy instances share the same account data on this computer, they coordinate so a due run fires only once.
- A failing automation shows the failure in its run history but doesn't pause itself — disable a chronically failing one manually.
