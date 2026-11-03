---
id: language-and-notifications
title: Display language and notifications
summary: Display language and desktop notifications in Settings > General, plus where IM-bot notifications, Agent Island, and other General settings (app behavior, send shortcut) live.
tab: general
---

Settings > General controls the display language, desktop notifications, and a few app-wide behaviors. Theme, wallpaper, and fonts live in Settings > Appearance (see the appearance topic).

**Language:**

- **Display language**: Auto (follow system) / English / 简体中文 / Traditional Chinese (繁體中文) / 日本語 / 한국어. It's used for the interface and AI error reports. Other replies follow your message or language request.
- Changes apply immediately. With **Auto (follow system)**, Cindy reads the system language at startup, so restart Cindy after changing your computer's language.
- On mobile, the phone app's display language is used for AI error reports for messages sent from that phone.

**Notifications:**

- **System Notifications** — notify when a session finishes, encounters an error, or needs a reply. Regular sessions notify only while the window is in the background.
- **Agent Island** (macOS 14 or later, in its own **Settings > Agent Island** tab) shows running, needs-reply, and unread completed tasks at the top of the display. When it's on, it handles these alerts instead of system notifications.
- **Feishu / Lark DMs** are no longer set here. Turn on **Send a Feishu / Lark DM when a session finishes or needs a reply** in the Feishu / Lark Bot card under **Settings > IM bots** (see the Feishu bot topic). It needs a bound bot and only sends while the window is unfocused.
- **WeCom group notifications** (automation completion alerts via a WeCom group-bot webhook) are in the WeCom Intelligent Bot card under Settings > IM bots.

**Other settings in General:**

- **App Behavior** — **Keep computer awake** (so background agents and scheduled tasks keep running), **Start at Login** (off by default), **Show remaining usage in the menu bar** (macOS), **When closing the main window** (Windows: Minimize to tray / Quit Cindy; Linux: Minimize window / Quit Cindy), and **Prevent Accidental Clicks When Returning** (macOS / Windows).
- **Message input** — **Use ⌘↵ to send** (Ctrl+Enter on Windows / Linux). When it's off (the default), Enter sends and Shift+Enter inserts a new line.
- General also holds your account info, Teammates, Collaboration limits, Agent Resource Usage, Git Safety, Pi extensions, Experimental, and Logout.
