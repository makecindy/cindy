# Portable theme packages

Use a ZIP archive with the `.cindy` suffix. File type comes from the contents,
not from a different suffix. A data-only theme package contains no plugin code:

```text
cindy.json
themes/light.json
themes/dark.json
assets/icon.png
assets/logo.png
```

`cindy.json` is the file-level manifest:

```json
{
  "formatVersion": 1,
  "type": "theme",
  "themes": ["themes/light.json", "themes/dark.json"]
}
```

Each theme uses the JSON schema in [capabilities](capabilities.md). Its optional
`brand.icon` and `brand.logo` must be relative to the **package root**, for example
`"brand": { "icon": "assets/icon.png", "logo": "assets/logo.png" }`.
Use different IDs and one shared `family` for light/dark. IDs must be unique;
each family can contain at most one variant of each type. No arbitrary CSS,
JavaScript, remote asset URLs, absolute host paths or directory traversal.
Keep paths portable across macOS/Windows: `/` separators, no links, reserved
device names, case-only aliases, trailing dots/spaces or special filename characters.
Do not include `ghost.json`: it identifies a legacy plugin and takes precedence.

Generate identifiers once when creating an independent theme. For example, this
uses Python's standard library to generate three independent 128-bit random IDs:

```bash
python3 -c "import json, secrets; print(json.dumps({key: secrets.token_hex(16) for key in ('family', 'light', 'dark')}, indent=2))"
```

Use `light` and `dark` as the respective theme IDs and `family` for both. Keep
these values in the editable sources across revisions; do not regenerate them
when packaging. They are stable identities, separate from the archive's content
hash, which changes with colors or assets. Existing string IDs remain supported;
the loader does not require hexadecimal IDs.

From the Skill directory, validate and build using Python 3 (Windows: `py -3`):

```bash
python3 scripts/validate_theme.py --package-root /task/mist /task/mist/themes/light.json /task/mist/themes/dark.json
python3 scripts/package_theme.py /task/mist /task/mist.cindy
```

The packager validates sources and includes only `cindy.json`, declared themes
and referenced brand assets. It creates a new file without overwriting an old
one. Limits: 256 KiB manifest, 1 MiB per theme JSON, 20 MiB per asset,
256 MiB total output bytes before compression, 128 MiB archive, 256 variants and
2048 archive entries. Keep original sources beside the deliverable for later edits.

## Share and install

Send the `.cindy` file itself. Recipients double-click it or drag it into Cindy;
the existing file picker also recognizes it. Cindy installs the theme and opens
Appearance settings; the recipient chooses it from the normal theme list. It
does not silently select the theme or overwrite wallpaper/font preferences.
Brand paths are resolved on the recipient's computer. No source-machine paths
or manual client changes are needed.

When the user asks the Agent to install it, discover the **running host** with
`cindy_helper.list_tools({"query":"导入主题"})` and follow the returned operation
schema. Supporting clients expose `import_theme_package` through `call_tool`:

```json
{"name":"import_theme_package","args":{"filePath":"/task/mist.cindy"}}
```

Relative paths resolve against this task's working directory; files outside it
use the existing task file authorization. The importer accepts theme packages
only and uses the same validation/installation as a native file drop. Inspect
`status: "installed"` and `refreshed`: a false refresh means the file is installed
but the current window did not confirm its list update. Do not re-import merely
to retry that confirmation. `themes` describes available local variants and their
selectable `themeFamily` IDs; `names` identifies the imported display names.

Importing does not select a theme. When application is requested, read
`get_app_settings` with `section: "preferences"` before changing it. Select the
returned family through `update_app_settings` with that section and a patch
containing `themeFamily`; include `theme` (`light`, `dark` or `system`) only if
the user requested a mode change. Read back the same section and inspect the real
appearance. Retain the previous selection for restoration. Use the schemas
returned by discovery, rather than assuming a tool exists on an older host.

If the target host lacks this importer, deliver the package and explain the
manual drop/picker path. Do not run shell `open`, target `/Applications/Cindy.app`
or install a replacement app to guess the right instance. Do not send a theme
package to plugin tools or turn it into a plugin to bypass a missing importer.

Installed packages live beneath the existing themes folder in
`.packages/<archive SHA-256>/`. Original JSON and assets remain canonical;
the installation record references the active document for each authored theme
ID, without copying its palette. **Importing the same ID updates that theme's
colors and referenced assets by default.** Runtime IDs and the authored family
stay stable, so a selected theme continues using its updated version. Keep IDs
stable when making a revision; use new IDs (and a distinct family for a separate
theme) when making a copy. Display names and archive filenames do not decide updates.

The same archive reuses its stored bytes. A changed archive can update matching
IDs and add new ones in one operation; IDs absent from it remain installed.
Different themes can reference images with identical filenames because each
archive owns its files. All referenced content is validated before the active
references change together. A failed update preserves the previous active
colors/assets. This does not introduce a publisher/update service.

Old loose JSON files still load unchanged. If an imported package has a matching
ID, its content becomes the effective local theme while the loose source file is
left intact. Built-in themes retain their existing identities; local themes keep
the existing runtime `-local` suffix.

After installation, verify selection, both requested modes, actual brand images
and restart loading using [verification](verification.md). For an update, keep
the previous package if the user needs to restore that revision by re-importing
it; selecting the same theme does not undo a content update. Switch back to the
previous theme to restore its colors and brand artwork. This data-only package
does not carry wallpaper, fonts, runtime app icons or other appearance-plugin
overrides. For those capabilities, produce an appearance **plugin** through the
existing `cindy-plugin-creator` workflow and explain the difference to the user.

## Compatibility

The generic loader in supporting clients checks `formatVersion` and `type`
before reading type-specific payloads. Unknown types or newer versions show
“This version does not support this file”; corrupt files have a separate error.
Clients predating this loader may treat a theme as an invalid plugin. Do not
promise that those existing binaries can display the new unsupported-file message.
Legacy plugin packages with `ghost.json` keep their existing approval, install,
update and credential behavior; they do not need a `cindy.json` manifest.
