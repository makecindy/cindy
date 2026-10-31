---
id: appearance
title: Appearance, theme, wallpaper and fonts
summary: Theme, appearance mode, local and imported themes, wallpaper, UI / code / terminal fonts, sidebar styles, panel layout, and reply animation — all in Settings > Appearance.
tab: appearance
---

Settings > Appearance controls how the app looks. It starts with **Theme** and **Appearance Mode**, followed by **Wallpaper**, **Fonts**, **Sidebar & panels**, and **Reply Animation**. Display language and notifications stay in Settings > General (see the language and notifications topic).

**Theme:**

- **Theme**: pick a theme family; each family supplies its own light and dark colors. Local themes are marked **(Local)**. Families with only one variant are tagged **Light only** / **Dark only**; while one is selected the appearance mode is fixed to that variant, and your saved mode returns when you switch to a two-variant theme.
  - Your light / dark / system preference synchronizes with updated devices signed in to the same Cindy account. Theme families, imported theme files, and wallpaper remain on each device.
- **Appearance Mode**: **Light**, **Dark**, or **Auto** (follows your system).
- **Local themes** row:
  - **Create local copy** — writes an editable JSON copy of the current theme into your themes folder.
  - **Import VSCode / Obsidian theme** — pick a VSCode or Obsidian theme file and turn it into a local theme, then select it in the theme list. VSCode themes that inherit colors via `include` can't be imported on their own.
  - **Open themes folder** — opens the folder that holds local theme JSON files.
  - **Refresh** — reloads local themes after you edit them.
- **Local theme brand identity** (optional, for power users): in a local theme JSON you can replace the icon and logo shown on the new-chat page. New copies already contain example paths to replace:

  ```json
  {
    "brand": {
      "icon": "/absolute/path/to/your-image-folder/icon-square-50x50px.png",
      "logo": "/absolute/path/to/your-image-folder/logo-horizontal-110x37.5px.png"
    }
  }
  ```

  The example filenames describe the final display areas; source images may be exported at 2x/3x while keeping the same aspect ratios. Paths must be absolute JSON strings; spaces do not need shell quotes. Transparent padding is trimmed at render time without changing the source file. Only `brand.icon` and `brand.logo` are recognized. If a path doesn't exist, the default artwork is shown. Save the file, then click **Refresh**.

**Wallpaper:**

- Choose **None**, one of the built-in Cindy scenes / backgrounds, or **Custom wallpaper** for the whole app. The wallpaper is independent of the theme; **Reset** restores the default wallpaper, visibility, blur, and display settings.
- **Choose Wallpaper** / **Replace Wallpaper** / **Remove Wallpaper**: PNG, JPEG or WebP up to 20 MB, or an MP4 (H.264) video up to 100 MB. It's stored on this device.
- **Display**: **Static** (default) or **Dynamic** for animated scenes and custom videos. Motion pauses when the window is hidden and follows your system's reduced-motion setting; videos loop silently.
- **Wallpaper Visibility** (0% hides it, 100% shows it without an overlay) and **Wallpaper Blur** (0 turns it off; blurring animated wallpaper uses more GPU).

**Fonts:**

- **UI font** / **UI font size** — menus, settings, and chat text (12–24).
- **Code font** / **Code font size** — code blocks, change comparisons, and editors (10–24). Inline code, status numbers, badges, and path labels keep their size.
- **Terminal font** / **Terminal font size** — only the built-in terminal (10–24, default 13). A monospace font is recommended.
- Each font picker offers presets or a **Custom** font name; each size has a **Reset to default** button.

**Sidebar & panels:**

- **Pinned Style**: show pinned sessions as **Text**, **Cards**, or **List** (same as the view-style button on the sidebar's **Pinned** header).
- **List Style**: for unpinned sessions — **Text** uses one line; **List** adds a preview (same as **Display** in the sidebar's **Sidebar settings**; see the Sidebar topic).
- **Panel layout**: panel positions and widths are saved automatically; **Restore default layout** puts them back.

**Reply Animation:**

- **Fade In Text**: new reply text fades in while it streams. Turn it off to show text immediately. It stays off when your system reduces motion.

**Notes:**

- Theme changes apply immediately; no restart needed.
- To zoom the whole window, use **Cmd/Ctrl + =** / **Cmd/Ctrl + -**, and **Cmd/Ctrl + 0** to reset (on macOS also under the **View** menu). The zoom level is remembered.
