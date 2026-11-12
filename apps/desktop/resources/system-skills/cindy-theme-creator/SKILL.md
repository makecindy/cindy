---
name: cindy-theme-creator
description: Create or edit a shareable Cindy theme package, including colors, light/dark variants, brand images, UI/code/body/terminal fonts, wallpaper, reading and message styles, density and motion. Use for personalizing Cindy with previews, validation, installation and restoration guidance.
metadata:
  short-description: Create and verify a complete Cindy theme
---

# Cindy Theme Creator

Turn the user's style or reference images into a usable, shareable Cindy theme.
Make the parts they want; a theme does not need every available customization.
Keep their language, style and existing assets. Ask only for a missing choice
that would materially change the result.

## Choose the supported format

Read [capabilities](references/capabilities.md) before authoring and
[package format](references/package-format.md) for the portable schema.
Deliver **one data-only `.cindy` theme package**: v2 includes colors, brand
images, fonts, wallpaper, reading/message styles, density and motion. Do not
split fonts or wallpaper into an appearance plugin. Plugins expose fixed
operations; they do not provide or register themes. A theme package contains no
plugin code, `ghost.json`, permission declarations or arbitrary CSS.

Discover the running Cindy host's available tools through `cindy_helper` and use
its returned schemas. Do not infer installed-build support from repository docs.
V1 clients support colors and brand images only; offer a v1 deliverable when that
is the requested target, and identify which requested v2 parts remain unavailable.
Do not replace or patch Cindy to install a theme, invent helper tools, call plugin
APIs from the task shell, or edit its database or system prompt.

## Build a coherent appearance

Start from an existing theme's copy/export when useful, preserving tokens the
user did not ask to change. Global colors stay in `colors`; do not invent a second
palette or an inheritance schema. Existing values can be aliases, HSL components
or non-color strings, so do not convert every token to hex.

Use separate light/dark documents with a shared `family` when both are wanted;
single-variant themes also work. Generate random unique IDs once for a new theme.
Keep IDs/family for revisions: reimporting the same ID updates it. Give an
independent copy new IDs. Display names and changing archive hashes are not IDs.

Put requested appearance defaults in each variant's `appearance`. Font, image and
video resources are declared in the v2 manifest and referenced by `asset:<id>`.
Brand paths are package-root-relative. Keep editable originals in the task folder;
never embed source-computer paths or another plugin's Library/media references.

Coordinate artwork and fonts with the palette. Use supplied assets or available
image-generation/editing tools, inspect the actual output, and check text areas,
transparent edges and small-icon legibility. Do not fabricate URLs or claim an
image exists when only a prompt was written. Preserve missing-glyph fallbacks;
provide a static image fallback for video wallpaper when possible.

Density and motion multiply the existing design tokens. Their neutral value is 1;
`motion: 0` reduces motion. System “Reduce motion” always takes priority. Brand
icon/logo change Cindy's in-app artwork. Arbitrary Dock/installer/shortcut icon
replacement and OS wallpaper are not v2 theme fields; do not label a brand-image
preview as proof of a changed application icon.

## Validate and preview

Read [verification](references/verification.md). From this Skill directory:

```bash
python3 scripts/validate_theme.py --package-root /task/mist /task/mist/themes/light.json /task/mist/themes/dark.json
python3 scripts/package_theme.py /task/mist /task/mist.cindy
```

On Windows, use `py -3` or a verified Python 3 `python`. The checker reports
schema, IDs, resource references, file limits/signatures and literal hex contrast.
Its `unchecked` list includes full media/font decoding, CSS resolution and actual
rendering. A successful package build does not prove that Cindy displayed it.

Preview the requested parts with real assets, body and secondary text, an input,
a tool result, code, a table and status controls where relevant. Inspect comparable
light/dark views and the actual brand crop. Use Cindy's available presentation or
browser workflows without modifying its installation.

## Install, inspect and restore

Follow the user's endpoint: preview/files, a shareable package, or application to
this Cindy instance. Creation does not authorize publishing or changing other
computers. Use the exact discovery/import/preferences flow in
[package format](references/package-format.md). Shell `open` or a fixed application
path can launch another build and cannot verify the running instance.

Import adds the theme to the list; selection applies its defaults. **Explicit user
settings and approved fixed-operation overrides take priority**, including fonts
and wallpaper. Selection keeps Cindy's existing local preference path. Explicit
package selection prepares resources before saving the choice and applying colors;
a rejected preparation leaves the current choice unchanged. Cold startup applies
saved colors and original settings synchronously, then prepares package resources.
Wait for actual font and wallpaper readiness before verifying the appearance. If a requested theme field is
masked, identify that override; use the corresponding existing “Restore default”
control only when the user wants to follow the theme there. Never silently reset
all appearance settings. With a package active, reset removes the named override
and follows its default; builtin and loose themes keep their existing reset
behavior. Reset does not restore an arbitrary previous custom value.

Retain the previous selection and relevant custom values for restoration. Switching
back changes inherited theme defaults; explicit settings remain. Reimport the old
package to undo a same-ID content update. Verify changed values and actual visuals;
do not overwrite choices made after the preview.

Deliver the `.cindy` file, editable sources and assets, preview/screenshot locations,
selection and restore instructions, and a short passed/failed/not-verified record.
Do not present a mockup, import receipt or saved preference as observed application.
