# Desktop backdrop blur: investigation, 2026-11-08

The intended interaction reuses wallpaper visibility and blur controls. With no
in-app wallpaper selected, they affect the content behind the app window. Keep
foreground text and controls sharp and opaque. This document records evidence,
not acceptance of a completed cross-platform implementation.

## macOS

### Current implementation: numeric window radius

The earlier UI-only fallback did not satisfy the requested adjustment: all nonzero
values selected the same material. The correction transports the full integer
0–20 through the existing local theme IPC, validates it in main, and stores it
per window. `macosDesktopBlur.ts` applies it through the own-window N-API addon
in `native/desktop-blur/`; both the main and secondary windows use this dispatcher.
It removes fixed vibrancy before applying the radius and clears the radius when
artwork covers the window. There is no screen capture in the production path.

The addon dynamically resolves `CGSSetWindowBackgroundBlurRadius` and
`CGSMainConnectionID`. This is private SPI, used in implementations such as
[winit](https://github.com/rust-windowing/winit/blob/v0.30.12/src/platform_impl/macos/window_delegate.rs)
and [par-term](https://docs.rs/crate/par-term/0.20.0/source/src/macos_blur.rs),
not an Apple-supported blur-radius API. A missing symbol, rejected call or missing
addon falls back to the system material. The native binding accepts only a live
content view belonging to this process, checks the integer range again, and
performs the call on the main thread. Build hooks cover development startup and
macOS packaging; Windows/Linux do not load this module.

Validation on macOS 27.3 arm64: the production addon and dispatcher ran in an
isolated Electron process, with native success for 0 → 5 → 20 → 0 → 5 and clearing
on artwork. Invalid numeric input and a non-window handle were rejected. Unit
tests cover two different nonzero values reaching IPC/native calls, per-window
isolation, reset and native fallback.

**Manual radius acceptance passed:** the user confirmed an obvious change from
5 to 20 in the isolated Mac development app on 2026-11-08. Automated stripe
comparison remains unavailable: the isolated Electron process did not have
screen-recording permission; no prompt or permission change was requested. The
runtime script reports `DESKTOP_BLUR_NATIVE_CALLS_ONLY`, not visual success. The
script can compare stripe contrast in the actual composed desktop when that
permission is already granted, saving only the fixture crop. Single-window
captures replace blurred backdrops with flat color and cannot prove the result.

### Rounded window corners

2026-11-08 的本机性能样本、测量限制与保持效果的优化候选见
[桌面透明与模糊性能检查](desktop-backdrop-performance.md)。

The user subsequently found that nonzero blur extended into rectangular corners.
An Electron fixture with the production `titleBarStyle: 'hidden'` reproduced it:
the content was rounded but all four outermost pixels had alpha 255. Merely
refreshing AppKit's corner mask did not fix it. A completely clear NSWindow
background disables the server-side clipping of this backdrop, as also described
in [MaterialView's window setup](https://github.com/OskarGroth/MaterialView/blob/main/Sources/MaterialView/NSMaterialView.swift).

While blur is positive, the addon replaces a fully clear native background with
white at alpha 0.001. AppKit then supplies the native corner mask, without a
hardcoded radius or a renderer clip that cannot affect WindowServer blur. The
original color is retained on that window and restored on zero or failure; an
already-installed theme background is preserved. No additional private corner
API or window observer is required.

Production-addon fixtures at 0, 5 and 20 all had alpha 0 at all four outermost
pixels after the correction. Unlike blur strength, this clipping is observable
in single-window captures. Both arm64 and x64 builds passed; only arm64 was run.
Fullscreen/Spaces and other macOS releases remain unverified.

### Task-sidebar material (removed 2026-11-10, reinstated without color 2026-11-11)

> **History.** On 2026-11-10 the masked sidebar view was removed so the sidebar would
> share the main area's backdrop. On 2026-11-11 the user asked for the sidebar to stay
> distinct but follow the same transparency and blur, in the main area's hue and
> slightly deeper. The masked HUD view, `theme:set-sidebar-width` and `setSidebar`
> below were reinstated; 0% desktop transparency still keeps the original backdrop on
> every platform. Current behavior is specified in
> [`design-rules/wallpaper.md`](design-rules/wallpaper.md).

**Colorless material (2026-11-11).** Measured over a neutral gray desktop, the HUD
material gave the sidebar a cooler hue than Cindy's surfaces (dark, 100%
transparency: sidebar `#7F8083` vs main area `#BFBFBF`; light: `#D1D2D5` vs `#BFBFBF`).
On macOS 27 the `NSVisualEffectView` layer tree is a `CABackdropLayer`
(`sdrNormalize`, `gaussianBlur` radius 30, `colorSaturate` 1.6 dark / 1.9 light)
beside a 40–48% gray tint layer, a lighten/darken blend layer and a 5%
`CAChameleonLayer` desktop-tinting layer. The addon keeps only `gaussianBlur` and
`sdrNormalize` and hides the sibling layers; the result matched the unveiled desktop
exactly (`#BFBFBF`), leaving the color entirely to CSS. AppKit rebuilds these layers on
appearance changes (and replaces them with an opaque gray in an inactive window), so
a one-time hook on `NSVisualEffectView` strips them again after `updateLayer`,
`layout` and `viewDidChangeEffectiveAppearance`, only for views the addon has marked
(no class swap, so KVO and other views are unaffected), and the marked view's state
is set to active. Verified live: light/dark switching and focus loss/regain keep the colorless
blur. Width zero unmarks the view and restores its state and appearance. Any other layer
layout is left untouched. Other macOS releases, Reduce Transparency and multiple
displays remain unverified.

The user requested that the original sidebar frost survive background blur zero.
The sidebar uses Electron's existing `NSVisualEffectView` with `behindWindow`
blending and the original HUD material. Electron owns its NativeViewHost below
Chromium; the addon obtains that own-window `vibrantView` (guarded Electron-specific
selector) and applies a mask with a fixed opaque left cap and stretchable transparent
center. Its appearance follows the current light/dark theme. This reuses the
placement/lifecycle described in [Electron's native window implementation](https://github.com/electron/electron/blob/v42.0.0/shell/browser/native_window_mac.mm).
Width zero removes it. A local-only `theme:set-sidebar-width` IPC accepts a finite
bounded width from a trusted top-level Cindy renderer; main derives the sender's
window, applies its zoom factor, and clamps to the content bounds. No renderer can
submit a native handle or target another window. Geometry changes do not reapply
the whole-window radius, update other windows or persist settings.

The renderer observes the sidebar's actual bounds and samples only active
transitions/animations, including the visible portion of a sliding peek drawer.
Artwork clears the native view and uses a CSS filter on a separate background
child, keeping fixed-position descendants and foreground text unaffected. In
desktop mode the shared veil excludes the sidebar and the original sidebar tint
is retained. In artwork mode the tint compensates for the shared canvas veil.

The first trial did not pass user acceptance: a fully opaque shared body covered
the native material, making the sidebar solid too. The corrected veil is a
separate paint layer starting after the visible sidebar edge, including at 0%
desktop transparency. An unmanaged effect view inserted into Chromium's content
view was also replaced with Electron's own hosted effect view.

The native runtime script exercises 260 → 78 → 0 → 300 widths, light/dark, resize,
radius zero/20 and removal for artwork. Unit tests exercise zoom, invalid geometry,
per-window isolation, retained width after wallpaper, and visible DOM bounds.
A standalone Electron capture confirmed a bounded left material alongside clear
right content and preserved corner clipping. Actual desktop blur composition,
particularly overlapping native effects, cannot be established by single-window
screenshots. On 2026-11-08, after the veil exclusion and Electron-hosted mask were
loaded, the user confirmed that the left sidebar visibly frosts the desktop while
the main content stays opaque. The complete app's computed veil starts at 260px
for its 260px sidebar, body remains transparent, and the sidebar retains the
original 85% tint. Cross-version behavior and native fullscreen/Spaces remain
outside this acceptance.

Run `node apps/desktop/scripts/desktop-blur.verify.mjs` on a Mac with the required
capture permission to verify clear/weak/strong blur and off/on recovery. This
runtime test owns an isolated profile and windows, and is separate from unit tests.

### Earlier layer prototype

Electron's `setVibrancy` selects a material; it does not expose a blur radius.
AppKit's public `NSVisualEffectView` likewise exposes material, state and blending
mode rather than a numeric radius. This is an API boundary, not proof that the
window server cannot vary blur.

[MaterialView's implementation](https://github.com/OskarGroth/MaterialView/blob/main/Sources/MaterialView/NSMaterialView.swift)
uses private `CABackdropLayer` and `CAFilter` APIs, with a radius mapped to
`filters.gaussianBlur.inputRadius`. Behind-window sampling requires native window
and layer configuration in addition to setting that number.

A standalone Objective-C probe was compiled and run on macOS 27.3, arm64. It used
two overlapping windows: a black/white stripe pattern behind a transparent window
with three backdrop panels and sharp foreground labels. Private filter values
0, 10 and 30 were successfully written and read back. This establishes only that
the classes and properties exist on the tested system.

**Visual verification is inconclusive.** Single-window captures showed a substitute
solid color or transparency rather than the underlying pattern. These captures
do not distinguish a capture limitation from an incorrectly configured prototype.
Do not report the desktop blur or Electron integration as verified. The probe
was stopped after the experiment; local sources/logs are in ignored
`artifacts/desktop-blur-probe/`.

Next acceptance step: inspect the actual composed desktop with the same pattern
at radius 0, 10 and 30, including movement of the background window. Then validate
the native layer inside Electron, resizing, focus, Spaces and reduced-transparency
settings. Private API behavior needs compatibility testing across supported OS
versions before adopting it as the product implementation.

Sources: [AppKit](https://developer.apple.com/documentation/appkit/nsvisualeffectview),
[Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window).

## Windows

The documented Desktop Acrylic controller customizes tint and luminosity opacity,
not a numeric blur radius. Mica samples the wallpaper and is opaque, so it is not
an equivalent implementation of live transparency through to other windows.
See [system backdrops](https://learn.microsoft.com/en-us/windows/apps/develop/ui/system-backdrops).

There is a lower-level public path worth prototyping:
[`CreateHostBackdropBrush`](https://learn.microsoft.com/en-us/uwp/api/windows.ui.composition.compositor.createhostbackdropbrush)
samples behind the window, and
[`DWMWA_USE_HOSTBACKDROPBRUSH`](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute)
enables host backdrop brushes for Win32 windows on Windows 11 build 22000+.
The earlier availability of the UWP brush does not by itself establish this Win32
support on Windows 10.

Win2D's [`GaussianBlurEffect.BlurAmount`](https://github.com/microsoft/Win2D/blob/winappsdk/main/winrt/docsrc/effects/GaussianBlurEffect.xml)
is adjustable, but that alone does not establish an unblurred desktop sample or
a continuous desktop radius starting at zero. The toolkit's
[`FromHostBackdropAcrylic`](https://github.com/CommunityToolkit/WindowsCommunityToolkit/blob/main/Microsoft.Toolkit.Uwp.UI.Media/Pipelines/PipelineBuilder.Prebuilt.cs)
does not expose blur amount, whereas its in-app acrylic pipeline does. Do not
substitute an in-app `CreateBackdropBrush` example for a behind-window test.

No Windows device test was performed for the host backdrop brush path. A Windows
prototype must check whether the host sample is already blurred, whether zero can be
truly clear, and whether the result composes correctly with Electron's transparent
content. Tint opacity and blur radius must be tested independently.

### Device finding: transparent window with Acrylic (2026-11-11)

Windows 11 build 26200, Electron 42.11.12, RTX 5080, two 4K displays (120 Hz and
60 Hz). A frameless `transparent: true` window with `backgroundMaterial: 'acrylic'`
that fills the work area flickers: whenever any window on either display is shown or
hidden (a notification, a tooltip-sized tool window), DWM stops drawing what lies
behind the window for one or more frames. The material then blurs nothing, the
translucent sidebar turns into a flat dark fill, and the composed desktop reports a
non-opaque pixel there (alpha 241 instead of 255). The running app spent about 99% of
the time in that state, with brief returns to the correct one.

An isolated Electron reproduction with the same window options, sampled at about
120 Hz while a 3 px tool window on the other display was shown and hidden 24 times in
3 seconds:

| Window | Time in the wrong state |
| --- | --- |
| transparent, Acrylic, fills the work area | 146–266 ms |
| transparent, Acrylic, 760×560 | 0 ms |
| transparent, no material, fills the work area | 0 ms |
| regular (`transparent: false`), Acrylic, maximized or work-area sized | 0 ms |

Disabling delegated compositing made it worse (480 ms); requesting `thickFrame` on a
transparent window changes nothing because Electron ignores it there. A regular
frameless window keeps the same Acrylic look, so Windows uses one whenever a system
backdrop is shown and keeps transparent windows for the clear desktop (no material)
only.

## Linux

Capabilities depend on the compositor and X11/Wayland backend. KDE's
[`KWindowEffects::enableBlurBehind`](https://api.kde.org/kwindoweffects.html)
accepts an enable flag and region, not radius. The staging Wayland
[`ext-background-effect-v1` protocol](https://gitlab.freedesktop.org/wayland/wayland-protocols/-/blob/main/staging/ext-background-effect/ext-background-effect-v1.xml)
advertises blur support and accepts a blur region; the algorithm remains under
compositor policy. Its current interface has no per-window strength parameter.
The protocol text was inspected through its
[source mirror](https://github.com/wayland-mirror/wayland-protocols/blob/main/staging/ext-background-effect/ext-background-effect-v1.xml).

This does not rule out compositor-specific extensions. It does mean that a
portable per-window radius slider cannot be promised from these interfaces.
Do not alter the user's compositor-wide blur settings to implement one app's
slider. No Linux desktop test was performed.

## Product consequence

Reusing the two settings is compatible with platform-specific rendering. Preserve
their distinct meanings: visibility controls the background veil, blur controls
spatial blur. A slider whose nonzero values all select the same material does not
meet the continuous-blur requirement, nor does varying tint opacity. Choose the
fallback presentation only after the actual platform capability is established.
The user subsequently chose to keep the same two sliders in both modes
(2026-11-08). The UI retains numeric values across selections. The later macOS
correction above connects the radius; other platforms retain their documented
fallback. Visual acceptance must be reported separately from API-call success.
