---
name: cindy-theme-creator
description: Create or edit a Cindy theme and its visual assets, including app colors, light/dark variants, brand images, wallpaper, typography, reading and message styles, and runtime app icons. Use when the user wants to personalize Cindy's appearance, with previews, validation and a clear way to restore it.
metadata:
  short-description: Create and verify a complete Cindy theme
---

# Cindy Theme Creator

Turn the user's style or reference images into a usable Cindy appearance. Make the
parts they want; a theme does not need every available customization. Keep the
user's language, chosen style and existing assets. Ask only for a missing choice
that would materially change the result.

## Choose the existing application path

Read [capabilities](references/capabilities.md) before producing configuration.
Separate the following outputs:

- A data-only `.cindy` theme package contains JSON for global colors, optional
  light/dark pairing and the new-task page's brand icon/logo, plus its assets.
  Read [package format](references/package-format.md) for portable delivery,
  validation, sharing and installation. Loose local JSON remains supported.
- On hosts exposing the plugin appearance API, it controls wallpaper, fonts,
  reading and message styles, content colors, runtime app icons and temporary
  region visibility through the existing appearance settings. These are
  conditional capabilities, not fields supported by the data-only theme format.
- Images, fonts and videos are assets referenced by those outputs. Keep originals
  and reusable source files in the task's output folder.

For an ordinary theme request, deliver the data-only theme package. Do not
substitute an executable plugin for it. If requested capabilities also require
an appearance plugin, explain which parts go in that companion before building
it, give the two packages distinct names, and identify the companion as a plugin
when installing it. A plugin permission prompt must not be presented as a theme
package import. Do not add a companion just to work around missing theme tools.

Discover the running Cindy host's available tools and capabilities first. For
settings, use `cindy_helper` discovery and its returned schemas. For a theme
plugin, use the bundled `cindy-plugin-creator` Skill and its current appearance,
resource and packaging references. Check `cindy.ui?.appearance` in the plugin;
do not infer installed-version support from repository documentation alone.
If that host contract or its current authoring reference is absent, deliver the
supported theme package and identify the unavailable parts. Do not generate a
companion plugin containing unknown appearance declarations: accepting such a
manifest does not mean Cindy implements those fields.
Only a plugin's declared resources can be passed to its appearance API. Do not
invent helper tools, send plugin calls from the task shell, or edit Cindy's
database, installation bundle or global system prompt.

## Build a coherent appearance

Start from a copy/export of an existing theme when available, preserving tokens
the user did not ask to change. Generate paired light/dark variants when wanted;
single-variant themes are also supported. Generate random unique IDs once for a
new theme: use a shared `family` and different IDs for a pair. See the
[package reference](references/package-format.md) for a generator. Preserve these
identifiers for revisions: importing the same ID updates its colors and assets
by default. Give an independent copy new IDs/family. Do not derive identity from
display names or recompute it from changing package contents.
Keep global colors in `colors`, without a second persisted
palette or an invented inheritance schema. Existing themes can contain aliases,
HSL components and non-color string tokens; do not convert every value to hex.

Coordinate the requested wallpaper, brand images, icon and fonts with the palette.
Use the user's supplied media or available image-generation/editing tools. Inspect
the actual images and keep readable text areas, transparent edges and small-icon
legibility in mind. Do not replace missing media with fabricated URLs or claim an
image was generated when only a prompt exists. Preserve font fallbacks and provide
a static wallpaper alternative when creating motion assets.

Treat brand icon/logo, runtime application icon, and installation/shortcut icons
as different targets. Native `appIcon` can change the Dock or running-window icon
without repackaging Cindy. Arbitrary CSS, replacing application files and changing
the operating system's wallpaper are not local-theme features.

## Make the result easy to verify

Read [verification](references/verification.md) and use its applicable checks.
For local JSON, run this read-only checker from this Skill's directory, with the
Python 3 launcher available on the machine:

```bash
python3 scripts/validate_theme.py /path/to/theme-light.json /path/to/theme-dark.json
```

For packaged themes, use `--package-root` and the packager described in the
package reference; absolute brand paths are only for loose local JSON.
The checker reports schema, duplicate IDs/variants, local brand-file availability
and contrast for literal hex pairs. It explicitly lists unresolved checks;
passing it does not prove that CSS expressions, fonts, native icons or the app UI
have rendered correctly. On Windows, use `py -3` or a verified Python 3 `python`.

Provide a preview of the requested parts, with a realistic message, input, tool
result, code, table and status controls where relevant. Use real generated media,
not stock placeholders passed off as the result. Inspect light/dark appearances
and the actual crop of each brand asset. Keep previews inside Cindy's available
presentation/browser/plugin workflows; never modify the running installation to
obtain a screenshot.

## Apply, inspect and restore

Follow the user's requested endpoint: files/preview, a `.cindy` theme package,
an appearance plugin when those capabilities are requested, or
application to this Cindy instance. Creating a theme does not authorize publishing
it, changing other computers or modifying the installation. Apply through the
existing local-theme/settings or approved plugin path when application is in scope.
For theme packages, follow the exact helper discovery, import receipt and
preferences workflow in [package format](references/package-format.md). This
targets the Cindy running the task; shell `open` or a fixed application path can
launch a different installed build and does not verify this instance.
Retain the previous selection and relevant settings so the user can return to them.

For plugin changes, inspect the mutation receipt and read back relevant settings.
`applied`, `saved` and `failed` are different outcomes. Verify visual/native effects
on the target computer before reporting them as observed. Use revision-aware
updates when available. Provide reset for the fields this theme changes; removing
an override restores the current default, not an arbitrary previous custom value.
Do not overwrite a later user or another plugin's choice during restoration.

Deliver the `.cindy` package or explicitly requested loose files/plugin, actual
assets and editable sources, preview locations, application
and restore instructions, and a short record of passed, failed and unverified
checks. State exactly which appearance capabilities were used and which requested
parts remain unavailable on the target build. Avoid presenting mockups or saved
preferences as proof that the real app has already changed.
