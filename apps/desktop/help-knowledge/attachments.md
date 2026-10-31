---
id: attachments
title: Attaching files and images, and referencing code
summary: Paste / drag images and files, use the composer's + / @ panel to attach files, reference files, tasks, browser tabs and more, and add extra directories the agent can work in.
---
You can give the agent more than plain text.

**Images and files:**

- **Paste** an image from the clipboard (e.g. a screenshot), or **drag** files onto the composer / task window. You can also open the composer's **+** menu and choose **Add files, images, or videos…** to pick files from the OS dialog.
- Images (**PNG, JPEG, WEBP, GIF**) are sent to the model as images. Other files (PDF, Office documents, code, text, videos, etc.) are attached by path, and the agent opens or reads them as needed.
- Attachments appear above the input. Click an image to open a full-screen preview; click a text / code file to preview its contents. Hover a thumbnail and click **×** to remove it.
- Pasting a copied folder inserts it as a folder reference instead of an attachment.
- Pasting a very long block of text (about 24+ lines or 4,000+ characters) folds it into a **Pasted text** chip; click the chip to view or edit it.
- Local file attachments aren't available in tasks running on an SSH remote host — paste the content directly instead.

**The + menu and `@` mentions:**

- Clicking **+** (left of the composer toolbar) and typing `@` open the same panel. It lists actions — **Add files, images, or videos…**, **New goal**, **Plan mode**, **Collaboration**, and **Add directory…** — followed by your installed plugins and the task's extra directories. Type to filter; **↑ / ↓** and **Enter** select.
- Things you can reference with `@`:
  - **Files and folders** in the task's **working directory** (extra directories aren't scanned by the picker).
  - Agents defined in the project.
  - **Tasks** — type a keyword to find past tasks and reference them.
  - **Teammates** — "Message or delegate" to one of your teammates.
  - The current task's built-in **browser tabs** and open **app windows** on this computer (local tasks only).
  - **Plugin** commands and plugin resources.
- Matching favors names that start with what you typed, then falls back to in-order fuzzy matching on names and paths.

**Extra directories:**

- Choose **Add directory…** in the **+** menu to pick a folder from the OS dialog. The agent can **read and write** in it, in addition to the working directory. Added directories are listed under **Directories** in the same panel; hover one to remove it.
- Per task; up to **10** extra directories (**Limit reached (10)** when full). Available for local Claude Code, Codex, and Pi tasks; not available for SSH remote or linked-device tasks.
- Choosing a subdirectory of the working directory is silently skipped (already covered). Choosing a parent / ancestor directory asks you to confirm first, because the agent could then modify everything inside it.

**Notes:**

- Attachments are sent with that one message only; they're not implicitly re-included on later turns.
- An `@` reference just inserts a reference into your prompt — it's the agent's job to actually open / read the referenced item.
