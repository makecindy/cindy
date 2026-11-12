---
id: keyboard-shortcuts
title: Keyboard shortcuts and accessories
summary: Settings > Keyboard Shortcuts lists Cindy's default shortcuts and lets you rebind, clear, or reset them; Accessories sets up Work Louder keyboards and Xbox, PlayStation, Switch, or generic game controllers.
---
Open **Settings > Keyboard Shortcuts** to see and change Cindy's app shortcuts. Below, **Mod** means ⌘ on macOS and Ctrl on Windows / Linux.

**Default shortcuts:**

- **New session** — Mod+N
- **Toggle sidebar** — Mod+B
- **Cycle permission mode** — Shift+Tab (while the message box is focused)
- **Previous / Next right sidebar tab** — macOS: ⌘⇧[ / ⌘⇧] or Ctrl+Shift+Tab / Ctrl+Tab; Windows / Linux: Ctrl+PageUp / Ctrl+PageDown or Ctrl+Shift+Tab / Ctrl+Tab
- **Open terminal** — Ctrl+` (opens a terminal in the right sidebar, or focuses the existing one)
- **Find in page** — Mod+F
- **Search in project** — Mod+Shift+F (while browsing documents)
- **Zoom in / Zoom out / Reset zoom** — Windows / Linux: Ctrl+= / Ctrl+- / Ctrl+0. On macOS, zoom uses the standard View menu shortcuts and isn't listed here.
- Built-in browser: **Focus address bar** Mod+L, **Browser back** / **Browser forward** Alt+← / Alt+→ (Option on macOS), **Reload page** Mod+R or F5

These also work but aren't shown on the page: Mod+1 … Mod+9 jump to the first nine visible sessions in the sidebar; Mod+S saves the document you're editing; Mod+W closes the active right sidebar tab when focus is there (on macOS it otherwise closes the window); ⌘, opens Settings on macOS.

**Changing a shortcut:**

- Click the pencil on a row, press the new key combination, or click **Cancel**. The trash button removes the binding (the row shows **Not set**).
- Cindy rejects combinations that can't be used, are **Reserved by the operating system**, conflict with another Cindy shortcut (it names which one), or conflict with the voice input shortcut.
- A changed row gets **Reset to default**; **Reset all to defaults** appears at the top once anything is customized.
- Other shortcuts live elsewhere: the voice input shortcut is in **Settings > Voice Input** (see the voice input topic), and the send key (**Use ⌘↵ to send**) is under **Settings > General > Message input**.

**Accessories (keyboards and controllers):**

- Open **Accessories** at the top of the page. A device also gets its own entry on the main page once it's connected or turned on.
- **Work Louder Codex Micro** and **Work Louder Creator Micro 2** — open tasks from the keys and show their status with key lighting.
  - Connect with a data-capable USB cable and turn on **Enable**. Cindy uses the official Work Louder software that comes with a supported ChatGPT or Codex app, so keep one installed; close ChatGPT if it's holding the device. On macOS, allow Cindy under **Input Monitoring**.
  - **Lighting**: **Brightness** and **Auto-dim**.
  - **Agent keys**: **Task order** (**Sidebar order**, **Recent tasks**, **Priority**, or **Custom**), **Focus Cindy with a single tap**, and each key's role — a **Task key** switches tasks and shows status (only the first 6 task keys can light independently), an **Action key** runs a shortcut.
  - Also **Microphone** (separate mic keys), **Joystick** directions, **Encoder** mode (switch tasks, navigate the composer, reasoning effort, scroll, or custom), the keycap **Layout** editor, and **Reset layout**.
  - **Codex compatibility** (macOS only): **Prevent Codex from occupying the device** while Cindy runs; quit and reopen Codex to apply.
- **Xbox controller**, **PlayStation controller** (DualSense / DualShock), **Switch controller** (Switch Pro / Joy-Con), and **Generic controller** — scroll, talk, send, and switch tasks with a gamepad over USB or Bluetooth.
  - Turn on **Enable**; Cindy only listens while it's in the foreground.
  - Click a control to assign an action (a command, a skill, or **Voice input** — hold to talk, release to stop). A stick can **Scroll conversation** or use **Custom directions**. **Reset mapping** restores the defaults.

### 离开时继续工作（macOS 14+）

按 `Control+Shift+L`，3 秒后遮住本机所有屏幕，让工作在离开后继续。
本机再次有键盘或鼠标输入时会触发系统锁屏，再用系统方式解锁。
此操作没有“试试看”的两分钟时限，也不改变自动离开的开关或等待时间。
首次使用须授予现有的辅助功能权限；缺少权限时不会遮屏。
可在「设置 → 键盘快捷键」修改或清除该快捷键，恢复默认会删除自定义绑定。
