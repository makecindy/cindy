---
id: appearance
title: Appearance, theme, wallpaper and fonts
summary: Theme, theme family, wallpaper, fonts, sidebar styles, panel layout, and reply animation — all in Settings > Appearance.
tab: appearance
---

Settings > Appearance controls how the app looks. It starts with the theme and appearance mode, followed by Wallpaper, Fonts, Sidebar & panels, and Reply Animation. Display language and notifications stay in Settings > General (see the language and notifications topic).

- **Theme**: pick from the registered theme families; each family supplies its own colors for light and dark. The app uses a VSCode-style token system (see docs/design-rules/cindy-design-system.md) so themes only override what they need. Families with only one variant are tagged Light only / Dark only; while one is selected the appearance mode is fixed to that variant, and your saved mode returns when you pick a two-variant theme.
- **Appearance mode**: light, dark, or system (follows your OS).
- **Wallpaper**: choose a Cindy scene, your own image, or a video for the whole app. The wallpaper is independent of the theme.
- **Fonts**: choose fonts and sizes for interface text and code. Code font size changes code blocks, change comparisons, and editors; inline code, status numbers, badges, and path labels keep their size.
- **Pinned Style**: show pinned sessions as Text, Cards, or List. **List Style** controls unpinned sessions: Text uses one line; List adds a preview.
- **Local theme brand identity**: this is an optional power-user feature configured in the local theme JSON. The settings page intentionally keeps only create-copy, open-folder, and refresh actions. New copies include self-explanatory example paths directly in the JSON.
- **Export / open local theme files**: export the current theme's tokens to a file or open a local theme JSON for inspection / sharing. To replace the icon and logo used on the new-chat page:

  ```json
  {
    "brand": {
      "icon": "/absolute/path/to/your-image-folder/icon-square-50x50px.png",
      "logo": "/absolute/path/to/your-image-folder/logo-horizontal-110x37.5px.png"
    }
  }
  ```

  The example filenames describe the final display areas; source images may be exported at 2x/3x while keeping the same aspect ratios. Paths must be absolute JSON strings; spaces do not need shell quotes. PNG, JPEG, and WebP are supported. Transparent padding is trimmed at render time without changing the source file. Only `brand.icon` and `brand.logo` are recognized; the previous single-image fields are not compatible with the redesigned two-asset layout.

- **Plugin panel restore entry**: choose whether minimized plugin panels come back from a floating bubble or from the sidebar.
- **Panel layout**: panel positions and widths are saved automatically; **Restore default layout** puts them back.
- **Reply Animation**: new reply text fades in while it streams. Turn it off to show text immediately. It stays off when your system reduces motion.

**Notes:**

- Theme changes apply immediately; no restart needed.
