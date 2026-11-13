---
id: language-and-notifications
title: Display language and notifications
summary: Display language and desktop notifications in Settings > General, plus where IM-bot notifications, Agent Notch, and other General settings (app behavior, send shortcut) live.
tab: general
---

Settings > General controls the display language, desktop notifications, and a few app-wide behaviors. Theme, wallpaper, and fonts live in Settings > Appearance (see the appearance topic).

**Language:**

- **Display language**: Auto (follow system) / English / 简体中文 / Traditional Chinese (繁體中文) / 日本語 / 한국어. It's used for the interface and AI error reports. Other replies follow your message or language request.
- Changes apply immediately. With **Auto (follow system)**, Cindy reads the system language at startup, so restart Cindy after changing your computer's language.
- On mobile, the phone app's display language is used for AI error reports for messages sent from that phone.

**Notifications:**

- **System Notifications** — notify when a session finishes, encounters an error, or needs a reply. Regular sessions notify only while the window is in the background.
- **Agent Notch** (macOS 14 or later, in its own **Settings > Dynamic Island** tab; formerly called Agent Island, 中文界面叫「任务胶囊」) shows running, needs-reply, and unread completed tasks at the top of the display. When it's on, it handles these alerts instead of system notifications.
- **Show tasks in the Dynamic Island** (same tab, macOS 27.3 or later) shows the same tasks through macOS Live Activities: in the Dynamic Island on the new MacBook Pro, and at the right of the menu bar on other Macs. It's on by default and switches independently of Agent Notch. When only this one is on and it can show (Live Activities allowed for Cindy in System Settings), it also replaces the system notifications for finished tasks and requests for input; errors still send a system notification.
- **Shared settings** on the same tab — the **Character** and **Event sounds** — apply to both. The tap sound only plays when you tap Agent Notch.
- **Feishu / Lark DMs** are no longer set here. Turn on **Send a Feishu / Lark DM when a session finishes or needs a reply** in the Feishu / Lark Bot card under **Settings > IM bots** (see the Feishu bot topic). It needs a bound bot and only sends while the window is unfocused.
- **WeCom group notifications** (automation completion alerts via a WeCom group-bot webhook) are in the WeCom Intelligent Bot card under Settings > IM bots.

**Other settings in General:**

- **App Behavior** — **Keep computer awake** (so background agents and scheduled tasks keep running), **Start at Login** (off by default), **Show remaining usage in the menu bar** (macOS), **When closing the main window** (Windows: Minimize to tray / Quit Cindy; Linux: Minimize window / Quit Cindy), and **Prevent Accidental Clicks When Returning** (macOS / Windows).
- **Message input** — **Use ⌘↵ to send** (Ctrl+Enter on Windows / Linux). When it's off (the default), Enter sends and Shift+Enter inserts a new line.
- General also holds your account info, Buddies, Collaboration limits, Agent Resource Usage, Git Safety, Pi extensions, Experimental, and Logout.
