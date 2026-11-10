# Appearance capabilities and output formats

This is a map of Cindy's existing appearance mechanisms, not a promise that every
installed build exposes all of them. Inspect the target host and the current
`cindy-plugin-creator` appearance reference before invoking plugin APIs.

## Capability map

| Requested result | Existing mechanism | Boundaries and useful checks |
| --- | --- | --- |
| Global app colors | Local theme JSON `colors` | Existing registered tokens; missing values use defaults. No arbitrary CSS or layout injection. Preserve untouched values. |
| Light/dark switching | Separate JSON files sharing `family` | Unique IDs; `type` is `light` or `dark`. A single variant remains valid. |
| New-task brand artwork | JSON `brand.icon` / `brand.logo` | Package-root-relative paths in `.cindy` themes; absolute image paths in loose JSON. Icon display area is 50×50; logo is 110×37.5. Transparent margins are trimmed at rendering. Missing assets fall back to Cindy artwork. |
| Static or animated wallpaper | Existing wallpaper settings or plugin `wallpaper` | PNG/JPEG/WebP or MP4; opacity/visibility, blur and motion. App wallpaper is separate from the local theme JSON and from OS wallpaper. |
| UI, code and body fonts | Existing font settings or plugin `uiFont`, `codeFont`, `bodyFont` | Family or owned font resource, size, weight and normal/italic style. Preserve missing-glyph fallbacks. Terminal font/size use their separate existing settings. |
| Reading layout | Plugin `reading` | Body/code line height and maximum reading width; width stays inside its container. |
| Message geometry | Plugin `contentStyle` | Message gap, padding and radius in registered message regions; no unrestricted page layout. |
| Message colors | Plugin `theme.light` / `.dark` | `text`, `secondaryText`, `surface`, `border`, `userBubble`, `userText`, `assistantBubble`; literal `#RRGGBB`. This does not select a global theme family. |
| Runtime application icon | Plugin `appIcon` | macOS Dock or Windows/Linux running content-window icons. Not Finder, installer, shortcuts, pinned taskbar, tray or app identity. |
| Temporary region visibility | Plugin `visibility` declaration and `cindy.ui.visibility` | Current Desktop window only; regions include sidebar, header, messages, composer, tools, windowControls and workspace. Provide a reachable restore action when using it. |
| Custom interactive theme controls/views | Existing plugin contribution surfaces | Use the plugin creator's native UI/page contracts. These are plugin UI, not new fields in theme JSON. |

Code syntax colors and the embedded terminal palette have their own existing
behavior. Do not promise that a global theme recolors every editor/terminal.
Desktop theme JSON is not a Mobile theme format; check each requested target.

## Local theme JSON

```json
{
  "id": "ce83c87b38a04d9fac05f07fefce6253",
  "name": "Mist",
  "type": "dark",
  "family": "ce660015a4dc4f0ba70cd63888b2b6db",
  "colors": {
    "surface": "#181b20",
    "text-primary": "#edf0f5",
    "text-secondary": "#b8c0cc",
    "border-default": "#424953"
  }
}
```

Generate fresh random identifiers for a new theme rather than copying the example
IDs; keep them fixed for updates. For a light variant, use another ID,
`type: "light"`, the same `family`, and designed light colors. Names are user-facing.
Do not append the runtime `-local`
suffix to an authored ID. Optional `brand` has only `icon` and `logo`. Use package
paths for a shareable theme, following [package format](package-format.md).
For loose JSON, set actual absolute paths on the target computer.

Use the existing **Create local copy**, **Open themes folder**, **Refresh** and
theme selection workflow when no applicable host tool is available. The current
Desktop loader reads `~/.cindy/themes/*.json` and installed `.cindy` themes;
discover/confirm the target folder
through Cindy rather than writing another computer's or account's settings.
Author files in the task folder first. VS Code/Obsidian import produces color
themes; it does not execute the source theme's CSS or import its complete layout.

## Appearance plugin

Load `cindy-plugin-creator` for the current manifest and authoring workflow. Its
`references/plugin-appearance.md` is the authoritative API contract; use its
resource declarations and the existing package validation/installation tools.
An appearance plugin declares only the fields and resources it uses in
`ui.appearance`. Assets are owned `asset:<id>`, plugin Library paths or readable
`cindy-media://blobs/...` references, not arbitrary absolute paths or remote URLs.

Inside that plugin, an application icon can be applied as follows after declaring
an `appIcon` field and a `client-icon` image resource:

```js
const appearance = cindy.ui?.appearance;
if (!appearance) throw new Error('APPEARANCE_UNAVAILABLE');
const before = await appearance.read();
const result = await appearance.set(
  { appIcon: { resource: 'asset:client-icon' } },
  { ifRevision: before.revision },
);
// Check result.application.status, then inspect the target Dock/window icon.
```

Use the current API's limits, rather than assuming all settings accept the same
units. Current ranges include UI font 12–24px, code 10–24px, body 12–28px;
body line height 1.2–2.4, code 1.1–2.4, reading width 320–1400px;
message gap 0–48px, padding/radius 0–32px; wallpaper visibility 0–1 and blur 0–20px.
Fonts are TTF/OTF resources; runtime app icons are static PNG/JPEG/WebP. Wallpaper
and icon pixel/file-size limits differ. Read the current resource contract before
preparing large files; do not patch the host when an asset is rejected.

Restore through the existing APIs and selection controls. `reset(fields)` removes
the named overrides, restoring defaults. Restoring previous custom values needs
the actual prior values and valid owned resource references; an opaque resource
belonging to another plugin cannot be replayed as this plugin's asset.
