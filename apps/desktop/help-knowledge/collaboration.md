---
id: collaboration
title: Collaboration mode (lead + workers)
summary: Turn on Collaboration from the composer's + menu to bring one or more worker agents in beside your session — locally, in their own worktree, or on another computer — and delegate tasks to them.
---

Collaboration ("Collab") lets one session — the **lead** — bring in one or more **worker** agents to run alongside it (a "team"). The lead delegates tasks to workers through built-in collaboration tools, and you can watch and steer each worker.

**Turning it on:**

- In a regular project or dialogue session, open the composer's **+** menu and choose **Collaboration**. You can also do this before sending the first message of a new session. Claude Code, Codex, and Pi sessions can lead, locally or over SSH. It isn't offered inside a worker or in a teammate chat.
- The **Start Collaboration** panel ("Bring in a Worker") sets up the first worker:
  - **Agent** (Claude Code, Codex, or Pi), **Model**, **Reasoning Effort**, an optional **Role Name** (just a label to tell workers apart), and an optional **Initial Task**.
  - **Permission Mode**: if you haven't chosen one before, it starts at **Full access** (skips routine approvals). You can choose **Auto-review** instead (safe work proceeds automatically; higher-risk actions may still be denied or need confirmation). Switching to Full access asks you to confirm first.
  - **Project** (local project sessions): work directly in the lead's project and branch, or **Create a worktree for this Worker** branching from a branch you choose. If the directory has uncommitted changes, the worker continues with them.
  - **Run on**: keep the worker **Local**, or run it on another computer on your account that's online and has remote control enabled. Its session, folder, and commands then stay on that computer (choose **Chat** or **Specify folder** for where it works there).
- The panel remembers your last Agent, model, effort, and permission choice for the next worker. Changing it doesn't affect the lead or workers that already exist.
- If the + menu says collaboration is disabled, turn **Collab Mode** back on under **Settings > Tools** (it can also be overridden per project).

**Adding and managing workers:**

- Workers appear in the right sidebar's **Team** tab. The worker header lists all workers (choose **Tabs** or **Dropdown** under **Worker list layout**); use **Create new worker** there to add more.
- Default limits are a **Worker Soft Limit of 5** and a **Worker Hard Limit of 8** per lead — you'll see a warning past the soft limit, and creation is blocked at the hard limit. Both are adjustable (up to 20) in **Settings > General > Collaboration**, which also has **Idle Release (minutes)** to automatically release workers after they sit idle (0, the default, turns it off).
- Only one worker is shown at a time — switch between them in the worker header. You can message any worker directly, **edit** a worker's role name / label, or **archive** a worker individually (archived workers can't be restored; create a new one instead).

**While collaborating:**

- Each worker is a full session with its own history, tools, and model. Workers use the lead's working directory by default (or the shared / new worktree chosen above).

**Turning it off:**

- Choose **Collaboration** again in the **+** menu, or close the **Team** tab. Cindy **asks you to confirm first** — running workers stop immediately and in-progress results are lost — then ends the team and archives **all** of its workers. The conversation history stays searchable.

**Notes:**

- With an SSH lead, workers are created on the **same remote host**. A worker can't start its own collaboration (no nesting).
- A lead can have only **one active collaboration** at a time. If you have two Cindy clients open on the same account and start collaboration on the same session in both, the second fails with "Failed to start collaboration" because one is already active — close one client or stop the existing collaboration.
