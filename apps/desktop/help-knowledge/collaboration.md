---
id: collaboration
title: Collaboration mode (lead + workers)
summary: Turn on Collab to bring one or more worker agents in beside your session and delegate tasks to them.
---
Collaboration ("协同" / Collab) lets one session — the **lead** — bring in one or more **worker** agents to run alongside it (a "team"). The lead delegates tasks to workers through a built-in MCP, and you can watch and steer each worker.

**Turning it on:**

- In any regular project or dialogue session, open the composer's **+** menu and choose **Collaboration mode**. You can also choose it before sending the first message of a new task. Both Claude Code and Codex sessions can be the lead.
- Pick the first worker's agent (Claude Code or Codex), and optionally its role / model / effort / an initial task.
- Start. This creates the team plus that first worker.

**Adding more workers:**

- From the collaboration tab's worker list, use **Create new worker** (+) to add more.
- Default limits are a **soft cap of 5** and a **hard cap of 8** workers per lead — you'll see a warning past the soft cap, and creation is blocked at the hard cap. Both are adjustable (1–20) in the Collaboration section under **Settings > General**.

**While collaborating:**

- Each worker is a full session with its own history, tools, working directory, and model, and runs with permissions bypassed so it doesn't stop to ask. It inherits the lead's working directory by default (or shares the worktree when the lead uses one).
- A worker's model defaults to your last new-session choice for that vendor, falling back to the lead's model.
- Only one worker is **focused** (shown) at a time — switch between them with the worker tabs / dropdown. You can intervene in any worker directly, and archive workers individually.

**Turning it off:**

- Closing collab **confirms with you first** (in-progress work is lost), then ends the workflow and archives **all** the team's workers. The conversation history stays searchable.

**Notes:**

- The lead can be a Claude Code / Codex **project or dialogue** session. On an SSH remote lead, workers are spawned on the **same remote host**, and the collaboration MCP reaches the remote side over an SSH remote-forward to the local bridge (with a persistent bearer token). A worker can't start its own sub-collab (no nesting).
- A lead can have only **one active collaboration workflow** at a time. If you have two clients open on the same account (e.g. dev + release) and start collab on the same session in both, the second fails with "开启协同失败" because a workflow is already active — close one client or end the existing collab.
