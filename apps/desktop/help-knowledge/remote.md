---
id: remote
title: Remote workspaces and device control
summary: Run agents on a remote machine over SSH, let your other signed-in devices (e.g. your phone) control this computer or view its desktop, and manage local app connections — all in Settings > Remote Connection.
tab: remote-control
---
**Settings > Remote Connection** has three parts: **My devices** (control your other signed-in devices, or let them control this one), **SSH remote hosts** (run an agent on another machine), and **Local App Connections**.

**SSH remote hosts:**

- **Add** opens "Add a remote machine": alias, optional display name, hostname (IP or domain), user, port (default 22), and authentication — **SSH agent (recommended)**, optionally pinned to one key, or an **Identity file** (encrypted keys aren't supported; use ssh-agent for those). Optionally turn on **Route agent traffic via proxy** (a Cindy-managed tunnel back to your local proxy, or your own proxy URL reachable from the remote).
- Hosts from your `~/.ssh/config` show up automatically (their connection details are read-only in Cindy); the refresh icon (**Reload ~/.ssh/config**) re-reads the file. **Manage keys** lets you browse, generate, or unlock SSH keys; **Setup key** helps install a key on a host.
- Each host has **Connect** / **Disconnect**, **Auto-connect** (connect when Cindy starts), **Edit**, and **Remove**. Status reads Disconnected / Connecting… / Authenticating… / **Ready**.
- Once a host is Ready, **Show agent setup** lets you **Install** / **Reinstall** / **Uninstall** Claude Code, Codex, and Pi on it, **Sync auth** (copy your local Codex sign-in to the remote), and run a **Quick test** prompt.
- To work on the remote: on the new-session page, open the project picker and choose **Add remote project**, pick the host under **Remote hosts (SSH)**, then choose (or create) a folder. Claude Code, Codex, and Pi can all run over SSH; if the agent isn't installed on the host yet, Cindy installs it automatically when you send the first message. Agent setup also has **Start a remote Codex session** (working directory defaults to `~`; you're asked before a missing directory is created). The session appears in your sidebar like any other, but its agent runs **on the remote machine**.
- Models that only work locally (e.g. Ollama) or subscription-direct models may not be available in SSH sessions; Cindy AI works.
- The agent's built-in **SSH commands** tool (Settings > Tools) reuses these **same** hosts — if it reports a host isn't found, add it here first.

**My devices (shown when you're signed in):**

- **No manual pairing** — every device signed into the **same Cindy account** appears automatically (this is how the phone app connects to your computer). If none appear, sign in with the same account on the other device.
- The **top card is this device**: rename it, see its connection status, and the master switch **"Allow same-account devices to control this machine"** (no per-connection approval; a visible indicator shows while it's being controlled, and you can disconnect at any time).
- Below it, **Allow remote desktop** lets your signed-in devices view and operate all apps on this computer (device control must also be on). On macOS this needs Screen Recording and Accessibility permission; on Windows, **Lock screen control** additionally needs administrator authorization.
- Each **other device** has two independent switches: **I control it** and **Let it control this device**, plus rename and delete. Desktops also have a **Remote desktop** button to open their screen. Phones can control this computer but can't be controlled.
- While another device is connected, a "<device> is connected to Cindy" notice appears on this computer with a **Revoke** button (with several devices, **View** opens this page). A revoked device can't reconnect until you restore its access here.

**Using another computer:**

- On the new-session page, the **Device** picker chooses which computer the session runs on. The sidebar's device scope menu shows sessions from your other computers.

**What a controlling device can and can't do:**

- A controlling device (like the phone app, which is control-only — it has no local agent of its own) can drive sessions: create / close / fork them, send and steer input, approve prompts, switch model / effort / permission mode, rewind, manage collaboration workers and Automations, and read session / message lists.
- It can **not** touch sign-in or API keys, change the controlled computer's global settings, trigger updates, or open local shell / file dialogs there. A new remote session's working directory must be currently accessible on the controlled computer; disconnected network drives are rejected.

**Local App Connections:**

- Lists other local apps you've allowed to use Cindy's models and agent capabilities (Cindy keeps the provider credentials). Revoke a single connection, or all of them, here.

**Notes:**

- Remote project sessions **can** be the lead in a collaboration workflow — workers then run on the same remote host (see the Collaboration topic).
- To keep a computer reachable while you're away, turn on **Keep computer awake** in **Settings > General > App Behavior**.
- Device control works only between devices on the **same account**; the relay just routes between them — your session data isn't stored on it.
