# App icon choices

The single source for the app icons users can pick on Desktop (macOS Dock) and
Mobile (iOS home screen). Everything else is derived from this directory.

- `manifest.json` lists the choices in display order. `default` has no artwork:
  each platform keeps the icon it ships with.
- Each artwork file is a 1024×1024 full-bleed square PNG without transparency
  or rounded corners. `dark` is optional; without it the light artwork is used
  in both modes.

## Adding or replacing an icon

1. Put the PNG here and add or edit its entry in `manifest.json`.
2. Run `pnpm generate:app-icons`.
3. A new id also needs its name under `settings.appearance.appIcon.options` in
   the Desktop and Mobile locale files.

The command rewrites the Desktop Dock images, the Mobile previews and the
generated TypeScript lists, and records what it produced in `generated.json`.
`pnpm generate:app-icons --check` fails when the sources changed without
running it again. iOS reads the artwork from here when the native project is
generated, so changed artwork reaches phones with the next native build, not an
over-the-air update.
