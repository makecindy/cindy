# Theme capabilities

V2 data-only theme packages use one Host appearance service for all defaults.
Existing settings controls and approved plugin fixed operations write explicit
overrides through that same owner. Plugins do not register or supply themes.

| Result | Theme field | Boundaries and checks |
| --- | --- | --- |
| Global app colors | `colors` | Existing tokens, aliases and values; missing values use normal defaults. No arbitrary CSS or layout injection. |
| Light/dark pairing | `family`, `type` | Separate IDs, same family, at most one variant per mode. Single-mode themes remain valid. |
| In-app brand artwork | `brand.icon`, `brand.logo` | Package-root-relative image paths. Icon display area 50×50, logo 110×37.5; rendering trims transparent margins. These are not native app icons. |
| UI/code/body fonts | `appearance.uiFont`, `.codeFont`, `.bodyFont` | A system `family` or bundled font `resource`, optional size/weight/style. Preserve Chinese and missing-glyph fallbacks. |
| Terminal font | `appearance.terminalFont` | Family or TTF/OTF resource and size. Weight/style are not supported here; the client rejects them. Does not change terminal color palettes or shell/session state. |
| Wallpaper/background | `appearance.wallpaper` | PNG/JPEG/WebP or MP4, visibility, blur, static/dynamic playback and optional static fallback. This is Cindy's canvas, not OS wallpaper. |
| Reading layout | `appearance.reading` | Body/code line height and maximum reading width, constrained by the containing panel. |
| Message geometry | `appearance.contentStyle` | Gap, padding and radius inside the Host's existing message regions. No unrestricted component layout. |
| Density | `appearance.density` | 0.75–1.25 multiplier for existing spacing tokens; 1 preserves default geometry. Fixed platform/editor measurements remain independent. |
| Motion | `appearance.motion` | 0–2 duration multiplier; 1 preserves defaults, 0 reduces motion. System “Reduce motion” always wins. Wallpaper playback also follows its own static/dynamic field. |

Fonts are TTF/OTF, up to 10 MiB each. Wallpaper images are up to 20 MiB / 40
megapixels and are decoded, oriented and stripped of metadata by Cindy; MP4 is up
to 100 MiB. Check actual browser font loading and video playback as well as files.
Full limits, field names and examples are in [package format](package-format.md).

## Color and identity document

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
  },
  "appearance": {
    "bodyFont": { "size": 16 },
    "reading": { "bodyLineHeight": 1.8 },
    "density": 0.9,
    "motion": 0.5
  }
}
```

Generate fresh IDs rather than copying these example IDs. Keep authored IDs free
of the runtime `-local` suffix. Use one shared family and another ID for light.
Brand paths and manifest resources follow the package reference.

## Existing boundaries

The current Desktop loader reads loose `~/.cindy/themes/*.json` and installed
packages. Loose files are left unchanged and ignore unknown `appearance` fields;
use a v2 package for the extended appearance. A shareable result should include its
resources in a package rather than depend on absolute paths on one computer.
Discover the actual target folder through Cindy before writing user themes there.
Create editable source files in the task folder first.

Use **Create local copy**, **Open themes folder**, **Refresh** and selection when
host tools are unavailable. VS Code/Obsidian color import does not execute source
CSS or import all appearance settings. Embedded code/editor/terminal colors retain
their existing behavior; Desktop JSON is not a Mobile theme format.

Native Dock/running-window icon presets remain a separate existing setting.
V2 packages do not accept `appIcon`, region visibility or interactive plugin
views. Temporary visibility belongs to the existing window capability, not a
theme. Do not manufacture a companion plugin to claim unsupported theme fields.
