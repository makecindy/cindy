---
id: mobile-app
title: Using Cindy on your phone (mobile app, notifications, remote desktop)
summary: Control your computer's Cindy tasks from the Cindy mobile app — no pairing, just sign in with the same account and allow device control; get push notifications when a task finishes, fails, or needs your reply; and view or operate your computer with Remote desktop.
tab: remote-control
---
The Cindy mobile app is a remote control for Cindy on your computer. The agents still run on the computer; the phone shows the same tasks and lets you work with them.

**Connecting your phone (no pairing code):**

1. Install the mobile app. On the computer, click the phone icon (**Download Cindy Mobile**) in the account area of the left sidebar to get a download QR code.
2. Sign in on the phone with the **same Cindy account** as the computer.
3. On the computer, turn on **Allow same-account devices to control this machine** (**Settings > Remote Connection**, or the switch in the download dialog).

Your computer then shows up on the phone automatically. If the phone says the computer is offline, open Cindy on the computer and stay signed in; the phone reconnects on its own. Revoked phones can't reconnect until you restore their access in **Settings > Remote Connection** (see the Remote topic).

**What you can do from the phone:**

- Browse tasks by computer, open them, and start a **new task** (choose the computer, then a project or **Chat (no project)**, the agent, and optionally a worktree).
- Send messages (messages sent while the agent is working are queued), **Stop**, attach photos, files, or screenshots, use voice input, and switch model, reasoning effort, and permission mode. **Plan Mode** and **Goal Mode** are available too.
- Approve permission prompts, answer the agent's questions, and review plans.
- Rewind (**Back to here**), fork (**Start new session from here**), ask in a side chat, and manage Collaboration workers.
- Browse a task's files (read-only), use plugins, and chat with Teammates.
- Share a task with other accounts, or join one (**Settings > Share Task > Manage Sharing** on the phone; see the Sharing tasks topic).
- On iPhone, share content from other apps into Cindy; it's placed in the composer, not sent automatically.
- The phone can't change the computer's global settings, sign-in, or API keys, and it can't be controlled itself.

**Push notifications:**

- On the phone, open **Settings** and turn on **Message and task notifications** (off by default; the system asks for permission). You're notified about chat messages and tasks that **finish, fail, or need your reply** (a question, permission prompt, or plan review).
- **Show chat previews** controls whether notifications include message text.
- No push is sent while you're watching that task live on another device, or while the Cindy window on the computer is focused. While the phone app is open, task notifications don't pop up as banners.
- An automation's runs notify the phone only if that automation has desktop or Feishu notifications turned on.
- There's no separate setting on the computer: the phone's switch is the only control.
- On Android phones without Google push, turn on **Keep chat connected in background** to keep receiving chat messages (it shows an ongoing notification you can stop).

**Remote desktop (see and operate the computer's screen):**

- On the computer, turn on **Allow remote desktop** in **Settings > Remote Connection** (device control must also be on). On macOS, grant **Screen recording** (to view) and **Accessibility** (to control) when prompted; the phone can open the permission guide on the computer.
- On the phone, tap **Remote desktop** in a task's header, on the computer's task list, or in its device details. Control is requested when you connect; switch on **View only** to just watch.
- Phone tools include **Keyboard**, **Trackpad** / **Touch** input, **All windows** / **Desktop**, clipboard copy and paste between phone and computer, **Sound**, display quality and resolution, and a Security section (**Lock Computer on Exit**, **Computer privacy screen**, **Clipboard sync**, and on iPhone with a Mac, **Automatically unlock computer**).
- From another computer on your account, open **Remote desktop** from the sidebar's device scope menu, the button next to a task that runs on that computer, or **Settings > Remote Connection**. It opens in its own window with **Controls** for display, sound, clipboard, and security.
- Only one device can use a computer's remote desktop at a time; **Take over connection** disconnects the other device. The controlled computer shows who is viewing or controlling it, with **Disconnect**.

**Notes:**

- The phone has no agent of its own: if the computer is asleep, offline, or signed out, its tasks can't run. Turn on **Keep computer awake** in **Settings > General > App Behavior** to keep it reachable.
- The Mainland China edition is a separate app with its own accounts (it signs in with a phone number). Use the same edition and the same account on the phone and the computer.
