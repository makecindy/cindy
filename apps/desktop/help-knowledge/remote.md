---
id: remote
title: Remote workspaces and device control
summary: Run agents on a remote machine over SSH, and let another signed-in device (e.g. your phone) control this desktop — both in Settings > Remote & device control.
tab: remote-control
---
Settings > **Remote & device control** has two parts: **SSH remote workspaces** (run an agent on another machine) and **My Devices** (let other devices you're signed into control this one).

**SSH remote workspaces:**

- **Add a host** with the **+** button: give it an alias, hostname (IP or domain), user, port (default 22), and an auth method (SSH agent or a key file). Hosts from your `~/.ssh/config` also show up automatically; you can re-read that file at any time.
- Once a host connects (status dot turns green), expand it to:
  - **Install the agents** (Claude Code / Codex) on the remote machine, and run a quick test prompt against them.
  - **Start a remote session** — enter a working directory on the remote (defaults to `~`); the app creates the directory if needed and opens a normal session whose agent runs **on the remote machine** with that remote working directory. It appears in your sidebar like any other session.
- The agent-facing SSH tools (via the `cindy-ssh` plugin) reuse these **same** configured hosts — if a tool reports the host isn't found, add it here first.

**My Devices (controlling this desktop from another device):**

- **No manual pairing** — any device signed into the **same Cindy account** is discovered automatically and appears in the list (this is how the phone app connects to your desktop).
- The **top card is this machine**: rename it, see its relay-connection status, and toggle the master switch **"allow other devices to control this machine"**.
- Each **other device** has two independent switches: **you control it** (outbound) and **allow it to control this machine** (inbound). You can rename devices, and delete ones that are offline.

**What a controlling device can and can't do:**

- A controlling device (like the phone app, which is control-only — it has no local agent or database of its own) can drive sessions: create / close / fork them, send and steer input, approve interaction prompts, switch model / effort / permission mode, rewind, manage collaboration workers and scheduled tasks, and read session / message lists.
- It can **not** touch auth or API keys, change global settings, write the database directly, trigger updates, or run local shell / file dialogs on the controlled machine. A new remote session's working directory must be currently accessible on the controlled desktop; disconnected network drives are rejected.

**Notes:**

- Remote project sessions **can** be the lead in a collaboration workflow — workers then run on the same remote host (see the Collaboration topic).
- Device control works only between devices on the **same account**; the relay just routes between them — your session data isn't stored on it.
