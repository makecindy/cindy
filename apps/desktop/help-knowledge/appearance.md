---
id: appearance
title: Appearance, theme, language and notifications
summary: Theme, theme family, fonts, display language, and desktop / FeiShu notifications — all in Settings > General.
tab: general
---

Settings > General controls how the app looks and how it notifies you.

**Appearance:**

- **Theme**: light, dark, or system (follows your OS).
- **Theme family**: pick from the registered theme families; each family supplies its own colors for light and dark. The app uses a VSCode-style token system (see docs/design-rules/cindy-design-system.md) so themes only override what they need.
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

**Language:**

- Display language: System / English / 简体中文 / 繁體中文 / 日本語 / 한국어. Used for the interface and AI error reports. Other replies follow your message or language request. On mobile, the phone's display language is used for AI error reports for messages sent from that phone.

**Notifications:**

- **System Notifications** — notify when a session finishes, encounters an error, or needs a reply. Regular sessions notify only while the window is in the background. When Agent Island is enabled, it handles these alerts instead.
- **FeiShu DM on session finished** — requires the FeiShu bot to be configured (see the FeiShu bot topic).

**Notes:**

- Theme changes apply immediately; no restart needed.
- Language changes apply immediately, but a few static strings may need a window reload to update.
