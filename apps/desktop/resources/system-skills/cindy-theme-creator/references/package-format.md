# Portable theme packages

Use a ZIP archive with the `.cindy` suffix. Contents determine its type. A theme
package is data and assets, with no `ghost.json`, JavaScript or plugin declarations.

```text
cindy.json
themes/light.json
themes/dark.json
assets/icon.png
assets/logo.png
assets/body.ttf
assets/background.webp
```

## V2 manifest and appearance

```json
{
  "formatVersion": 2,
  "type": "theme",
  "themes": ["themes/light.json", "themes/dark.json"],
  "resources": [
    { "id": "body", "kind": "font", "path": "assets/body.ttf" },
    { "id": "background", "kind": "image", "path": "assets/background.webp" }
  ]
}
```

Each document has the identity/colors schema in [capabilities](capabilities.md),
optional `"brand": { "icon": "assets/icon.png", "logo": "assets/logo.png" }`,
and optional appearance defaults. For example:

```json
{
  "uiFont": { "family": "Inter", "size": 15 },
  "codeFont": { "family": "JetBrains Mono", "size": 14 },
  "bodyFont": { "resource": "asset:body", "size": 16, "weight": 400 },
  "terminalFont": { "family": "Menlo", "size": 14 },
  "wallpaper": { "resource": "asset:background", "visibility": 0.4, "blur": 8, "motion": "static" },
  "reading": { "bodyLineHeight": 1.8, "codeLineHeight": 1.5, "maxWidth": 760 },
  "contentStyle": { "messageGap": 12, "messagePadding": 8, "messageRadius": 12 },
  "density": 0.9,
  "motion": 0.5
}
```

Put this object under `appearance`, beside `colors`, not inside it. Each variant
can carry its own defaults. Omitted values inherit normal Host defaults; no
separate persisted palette or plugin theme registration is created.

| Field | Allowed values |
| --- | --- |
| Font `family` / `resource` | Choose one: a family up to 256 characters, or `asset:<declared font id>`. No raw paths, URLs, Library or another plugin's resources. |
| Font `size` | UI 12–24px; code/terminal 10–24px; body 12–28px. |
| Font `weight`, `style` | UI/code/body: integer 100–900; `normal` or `italic`. Terminal accepts neither. |
| Wallpaper `resource` | Declared `image` or `video`; `fallbackResource`, if supplied, is a declared image and requires `resource`. |
| Wallpaper `visibility`, `blur`, `motion` | 0–1, 0–20px, `static` or `dynamic`. Visibility is artwork visibility, not veil opacity. |
| `reading` | `bodyLineHeight` 1.2–2.4; `codeLineHeight` 1.1–2.4; `maxWidth` 320–1400px. |
| `contentStyle` | `messageGap` 0–48px; `messagePadding` / `messageRadius` 0–32px. |
| `density`, `motion` | 0.75–1.25 and 0–2. Neutral 1; motion 0 requests reduced motion. System reduced motion remains authoritative. |

Objects contain only these fields. A font/reading/contentStyle/wallpaper object
must contain at least one field. Resource IDs are unique, 1–64 letters, digits,
`_` or `-`; `kind` is `font`, `image` or `video`. Declare at most 256 resources.
Brand paths and resource paths are relative to the **package root**. Resources
can be shared across variants; the declared kind must match each use.

Paths use `/`, no links, absolute paths, traversal, Windows device names,
case-only aliases, trailing dots/spaces or special filename characters.
Do not include `ghost.json`: legacy plugin identification takes precedence.
No remote asset URLs, arbitrary CSS, executable code or system-prompt changes.

## Identity, validation and build

Generate identifiers once for an independent theme, for example:

```bash
python3 -c "import json, secrets; print(json.dumps({key: secrets.token_hex(16) for key in ('family', 'light', 'dark')}, indent=2))"
```

Light and dark use their respective IDs and shared family. Revisions retain
these values; independent copies get new ones. Existing string IDs are valid;
hex-only IDs are not required. Content hashes change independently of theme IDs.

From the Skill directory (Windows: `py -3`):

```bash
python3 scripts/validate_theme.py --package-root /task/mist /task/mist/themes/light.json /task/mist/themes/dark.json
python3 scripts/package_theme.py /task/mist /task/mist.cindy
```

The checker validates the manifest, theme schema, references, resource kinds,
font table bounds and media signatures, plus literal hex contrast. It lists
full media/browser decoding and rendering as unchecked. The Host performs the
final canonical decoding and validation during import/application.

The packager includes only the manifest, named documents, referenced brand assets
and declared resources, and creates a new file without overwriting one. Limits:
256 KiB manifest; 1 MiB per document; 20 MiB / 8 megapixels per brand image; 10 MiB font;
20 MiB wallpaper image / 40 megapixels; 100 MiB MP4; 256 MiB total uncompressed;
128 MiB archive; 256 variants; 2048 entries. Keep originals beside the deliverable.

## Share, install and select

Send the `.cindy` file. Recipients double-click, drag it into Cindy, or use the
existing file picker. Import adds it to Appearance's normal theme list and does
not silently select it. Resource paths resolve on the receiving computer.

When the Agent is asked to install, discover the **running host** through
`cindy_helper.list_tools({"query":"导入主题"})` and follow the returned schema.
Supporting clients expose:

```json
{"name":"import_theme_package","args":{"filePath":"/task/mist.cindy"}}
```

Relative paths use this task's working directory; outside paths use existing file
authorization. The importer accepts only themes and uses the native installer.
`status: "installed"` confirms installation; `refreshed` reports whether the
current window confirmed the list refresh. If false, do not reimport just to retry
that confirmation. `themes` includes selectable `themeFamily` IDs.

To apply when requested, read `get_app_settings` with `section: "preferences"`.
Use the discovered `update_app_settings` schema to set `themeFamily`; set `theme`
(`light` / `dark` / `system`) only when wanted. Read back and inspect the rendered
appearance. Retain the previous selection. If the host lacks the importer, deliver
the package and explain manual import; do not use shell `open`, a fixed installed
application path, plugin installers or a replacement app as a workaround.

## Settings priority and restoration

Selection contributes defaults through the same Host AppearanceService used by
settings and approved plugin fixed writes. Explicit overrides win over the theme.
Selecting/importing never silently erases existing custom fonts or wallpaper.
The owner persists only explicit overrides. Selection stays in Cindy's original
renderer localStorage; it is not migrated to the Host. The package defaults are
an in-memory projection, rebuilt only after that selection requests preparation.
Colors and the user's original fonts/wallpaper display synchronously; package
fonts and media prepare asynchronously without delaying window creation.

If a theme field is masked, show which setting overrides it. Its existing
**Restore default** removes that override and follows the active theme. Restoring
one font size does not reset its family or other fonts. Do not clear all settings
to apply one theme. Switching back restores inherited defaults, while explicit
custom values remain; returning to a previous custom value needs that recorded
value rather than reset. Leaving a package removes its default layer and reveals
the user's settings. Builtin and loose themes retain their existing reset behavior;
resetting appearance never changes the selected mode or family.

Installed content is immutable beneath `.packages/<archive SHA-256>/`. An atomic
installation record selects the current document per authored ID. **Same ID
updates by default**, keeping runtime IDs/family stable; different IDs coexist.
Same archive reuses its bytes; IDs absent from an update remain installed. Equal
asset filenames across archives cannot collide. All referenced content is
validated before activation; failed updates preserve the old references/assets.

Listing installed themes reads bounded manifest/theme JSON and checks resource
paths, file types and byte limits. It does not read font or wallpaper binaries.
Installation and actual use validate those bytes; selected resources are read
asynchronously. An unused corrupt binary therefore stays in the theme list;
selecting it is rejected with a notice, retaining the current appearance and
settings. This keeps large videos off the synchronous first-frame listing path.
Brand cropping remains synchronous within its image limits, with bounds cached
by path/size/mtime in memory and released when a package is removed or replaced.
No derived bounds or second index are written to disk.
If a previously selected package cannot be restored on cold startup, the saved
selection is retained, the appearance falls back to defaults and the Host logs
a warning without showing a toast. Selecting that same package again follows
the normal rejection notice. A theme font rejected by the browser uses the
existing default-font fallback and shows a toast.

Keep the previous package to undo a content update by reimporting it. Reselecting
the same ID does not revert an update. Loose source files remain unchanged even
when an installed package with matching ID becomes effective.

## Compatibility

V1 (`formatVersion: 1`, `type: "theme"`, `themes`) remains supported for colors,
mode pairing and brand images. V1 cannot carry `appearance` or `resources`; build
v2 for those. New clients preserve old theme selection and explicit settings on
upgrade. Existing renderer localStorage, setters and storage-event synchronization
remain authoritative, including rollback to older versions. No startup migration,
dual write or persisted package projection is needed. Old projection fields are
ignored if encountered. Loose JSON still ignores unknown `appearance` fields;
strict appearance validation applies to new package documents.

Unknown file types or newer versions show “This version does not support this
file”; malformed known packages have a separate invalid-file result. Older v1
clients recognize v2 as unsupported. Clients predating generic file recognition
may call it an invalid plugin; do not promise a new message in those binaries.
Legacy `ghost.json` packages retain their original approval/install/update and
credential behavior. Themes contain no plugin and require no plugin installation.
