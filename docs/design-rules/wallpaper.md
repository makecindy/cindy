# 应用壁纸

> 迁自 `DESIGN.md` §2，规范效力不变。文中未注明文档的 `§N` 均指 [DESIGN.md](./DESIGN.md)。

### Optional application wallpaper (user decision, 2026-10-01)

An explicitly selected Desktop wallpaper replaces the flat page canvas across
the whole host application: title bar, navigation, messages, tool-pane chrome,
settings and other host pages share continuous viewport-aligned artwork. This
opt-in setting supersedes the CINDY sidebar-only backdrop treatment while active;
selecting None switches to the native desktop backdrop described below, without modifying theme files or tokens.
Blend wallpaper with the theme surface, never a fixed black overlay in Light mode. Image opacity
must not affect text or icons. In-page raised surfaces — composer, message bubbles,
tool and table-header cards, page cards, inputs and the selected sidebar row —
tint the wallpaper with their own token at 72% (Light) / 64% (Dark) instead of covering
it (user request, 2026-11-03), in the CINDY themes only: their translucent-ink text keeps its
contrast on any wallpaper, while other built-in themes use fixed text colors calibrated
against solid surfaces and keep them opaque. Higher visibility raises that opacity so the artwork
contributes at most 16% under the surface, keeping the tertiary text tier at the 3:1
floor over any wallpaper (84% at 100% visibility). Fill only, no `backdrop-filter`, which
would become the containing block for the composer's fixed palettes. Floating layers
(menus, popovers, dialogs, tooltips, anything positioned over other content), any surface holding
syntax-highlighted code, such as code blocks and diffs (the fixed syntax palette needs a solid surface, §15.4), and embedded
web or editor content keep their readable opaque surfaces. Implementation: the in-page
glass rule in `globals.css`, scoped to page containers and excluding floating roles and
absolute / fixed / sticky surfaces; the floor comes from `useWallpaperBackground`.
Desktop transparency uses this same rule and contrast floor, including its exclusions
(user decision, 2026-11-08). Do not duplicate per-control styles by background source.
At zero desktop transparency, keep raised surfaces fully opaque. The sidebar's own
frost remains independent. Host layout dividers and plugin main-view canvases share
the desktop background just as they share artwork; embedded controls retain their surfaces.
Composer scroll masking must align with the same wallpaper instead of introducing an opaque footer rectangle.
Built-in SVG wallpapers are decorative assets, not new semantic UI colors.
Verify actual Light/Dark screenshots across host pages and the expanded tool pane.

The built-in picker lists 13 artworks (user curation, 2026-10-17): the Cindy group —
Whisper, Night Glance, Scarlet Stroll, Neon Silhouette, Prism Shards — followed by
Night Launch, Silent Orbits, Dune Dawn, Planet Dawn, Indigo Folds, Dune Sphere,
Ocean Clouds and Rose Quartz. All five Cindy wallpapers offer Static / Dynamic; their
1920×1080, 24fps, 10-second loops keep the source composition as first and last frame.
The other eight are stills. All official originals are metadata-free WebP/MP4 delivered
on demand from the CDN (user decision, 2026-10-17); only lightweight thumbnails and the
three legacy scene previews ship with the app.
Window Companion, Future Atelier and Dream Wander are retired from the picker
(`RETIRED_WALLPAPER_IDS`, 2026-10-17). Their manifest entries and CDN objects stay, so a
saved selection keeps its still and motion; while one is in use it appears selected right
after None with its Static / Dynamic choice, and it disappears once the user switches away.
Removing a catalog choice never rewrites appearance preferences or deletes CDN objects.
All official images share the existing on-demand downloader, verified cache reuse,
and preview fallback; only manifest entries with video metadata offer motion. Download progress appears
as a 3px bottom track inside the selected thumbnail (user choice, 2026-10-19), with no visible
percentage or separate row. Its transform interpolates the precise byte ratio over
the base motion tier, linearly for this transfer indicator to avoid restarting an
ease-in/out on every progress sample; reduced motion updates immediately.
It follows real transfer progress and disappears once ready;
cache hits show the original directly. A failed tile shows a retry icon and supports click,
Enter and Space to retry, preserving the grid's single Tab stop and selected border.
Expose progress and failure descriptions to assistive technology outside the radio descendants.
Show the selected official wallpaper's bundled preview immediately while its original
is loading or decoding (user decision, 2026-11-03, #8591). Download or decode failure
keeps that selection's preview, not the previous wallpaper. Reuse already decoded
original URLs directly when revisiting a selection. Crossfade both the preview and
the ready original on the static canvas and its composer copies using opacity and
the fast motion token, respecting reduced motion. Custom image replacements still
retain the previous background until decoding succeeds.
Reuse the settings download percentage normalization. Browsing the grid or hiding the wallpaper does not
download originals; only a selected, visible image is requested. Reuse valid cached
images offline and after upgrades. Do not request CDN assets for IDs absent from the manifest.
Earlier unreleased artwork (including Blue Gaze, Amber Light and the 2026-10-16 batch
trimmed on 2026-10-17) is not shipped and needs no compatibility.
The new artwork uses the existing continuous cover fit, theme-derived visibility
and blur controls. None remains the default. With None selected, visibility controls
desktop background transparency (0% opaque, 100% clear); the retained left sidebar
material is independent. Both controls remain
sliders with the same ranges, preview/commit behavior and reset action when switching
between None and artwork (user decision, 2026-11-08). Their labels and hints identify
the current background source; do not replace desktop blur with a separate switch.
Desktop transparency has its own optional `desktopVisibility` override, defaulting to
0% for both upgrades and new installs. Never infer desktop opt-in from legacy
`wallpaperVisibility` or `wallpaperOverlay`; artwork keeps its existing values.
Switching background sources restores each source's visibility. Reset removes the
desktop override and returns to opaque content, retaining independent sidebar frost.
At 0% desktop transparency or wallpaper visibility, disable the blur slider and
suspend background blur without writing over its saved value. Restore that value
as soon as visibility becomes positive. The independent sidebar material is not
disabled by this optimization (user decision, 2026-11-08).
macOS passes the numeric radius to the native window backdrop. See
[`desktop-backdrop-blur-research.md`](../desktop-backdrop-blur-research.md).
Text and controls are never faded.
The left task sidebar retains its own frosted material and readable tint floor,
even when the background blur is zero (user decision, 2026-11-08). The two existing
sliders still control the background; do not add a separate sidebar preference.
For a desktop background on macOS, a non-interactive native effect view covers
only the sidebar's currently visible width. Its geometry is local to each window,
follows collapse/rail/peek animation and UI zoom, and disappears when hidden or
when artwork covers the window. With artwork, a paint-only child of the sidebar
blurs the in-app canvas; never apply the filter to the sidebar ancestor, which
would change the containing block of its fixed menus. In desktop mode, the shared
veil starts after the sidebar's visible edge; otherwise 0% transparency hides the
native material beneath an opaque body. The sidebar retains its original tint.
With artwork, compensate for the existing canvas veil rather than stacking two full coats.
Windows/Linux retain the readable tint; native regional desktop sampling has only
been implemented on macOS. Existing Windows whole-window Acrylic fallback remains.
Without that native sidebar material (Windows/Linux), 0% desktop transparency does not
enter desktop-background mode: the window keeps its original backdrop (Windows 11
Acrylic, otherwise opaque) until transparency is raised (#9424).
The controls reuse the visibility and blur overrides. On macOS, the own-window
native addon applies `CGSSetWindowBackgroundBlurRadius` (0–20), with fixed vibrancy
removed so it cannot obscure radius changes. Artwork clears this native radius.
Positive blur must preserve AppKit's native rounded window mask: a completely
clear NSWindow background needs a visually negligible alpha (0.001), restored
when blur is cleared without overwriting the next theme's background.
The private API is resolved at runtime; a missing addon or failed call falls back
to the system material. Windows 11 continues to use Acrylic for nonzero values;
systems without a native material retain clear transparency. The hint describes
system-default fallback where adjustable blur is unavailable. A successful native
call alone is not visual acceptance; keep the research document's validation limits.
Selecting artwork restores the image/video controls. Reset removes these overrides.
While a window's opaque in-app wallpaper canvas is active, disable its covered
native macOS Vibrancy / Windows backdrop material. With None selected, restore the
user's desktop backdrop choice when that canvas is removed. Use actual per-window canvas state rather
than the saved selection; pending replacements may retain the previous canvas.
The visibility veil (including 0%) remains opaque to the desktop. Wallpaper blur
and in-app overlay blur keep their existing behavior.
The picker remains an inline compact grid (user choice, 2026-10-15): use
container-width-driven columns with a 6rem minimum, 8px grid gaps, 16:9 previews,
and a 4px gap before each readable name. At the standard 1280px window width this
shows eight columns; narrower windows naturally show fewer. Keep direct click-to-apply
selection, the existing selected/focus treatment, and full names in accessible labels
and hover/focus tooltips when the visible label is truncated.
The grid has one Tab entry, using the selected visible tile or the first tile for
a hidden saved selection. Arrow keys move focus and selection with wrapping; Home /
End reach the first / last tile. An empty Custom tile only receives focus during
arrow navigation; Enter / Space explicitly opens the file picker.
Custom wallpaper is available through Choose Wallpaper, Replace Wallpaper and Remove Wallpaper
in the same section (user addition, 2026-10-01; video support, 2026-10-05). Accept local PNG/JPEG/WebP up to
20 MB and 40 megapixels, store a metadata-free static image up to 3840 pixels
in the managed media store. Also accept local MP4 videos up to 100 MB, preserving their bytes;
H.264 is recommended for playback compatibility. Wallpaper selection and the custom media reference
are shared within the Desktop profile, just like theme preferences (user decision,
2026-10-02). Import, replacement, removal and recycling are client-wide as well:
no account database, account-bound operation guard or pre-release owner migration.
The media store's client wallpaper scope isolates its bytes from chat attachments;
switching accounts (or signing out) keeps the same wallpaper. Font-only utility renderers never receive
custom media URLs.
Detached sidebar and plugin-panel host chrome use the same wallpaper provider;
plugin main-view documents share the host canvas while wallpaper is active, including
when docked or detached. Only their html/body background color becomes transparent;
theme surface tokens, controls, author background images, regular panels and settings
webviews retain their own surfaces. Disabling wallpaper restores the page background
without reloading the plugin. All webviews retain their permission boundary.
Cancellation and import failures retain the existing media. Switching to a built-in
or None keeps the imported media available; Remove Wallpaper forgets it. Custom imagery
shares the continuous cover-fit canvas and readability veil. Custom MP4 exposes the existing
Static / Dynamic choice: Static and reduced motion show a paused frame; Dynamic loops silently
and pauses when hidden/minimized. Playback failure releases the decoder, leaves the theme surface
visible and shows an actionable error in wallpaper settings. The custom video tile uses a film icon
instead of opening a second decoder for a thumbnail.
Wallpaper Visibility ranges from 0% (hidden) to 100% (fully visible), in 1% steps
(user decision, 2026-10-05). Static images use the theme-surface veil with opacity equal to
100% minus visibility. Video uses visibility directly as the video element's opacity over
an opaque theme-surface backing, without a separate translucent veil; this avoids the
observed Windows HDR brightness shift when P3 content changes the output composition.
The video wrapper's opacity is reserved for loading/exit crossfades. Visibility never fades
text or controls: they keep their token colors (including the translucent text tiers of §2)
and no element opacity is layered on top. Release video playback at 0%. Blend-mode controls
remain out of scope.
Optional Wallpaper Blur (user addition, 2026-10-06) ranges from 0 (off, default) to 20
in whole steps, applying a CSS-pixel radius only to the wallpaper image/video. No UI,
theme backing, or text is blurred; video opacity remains on the video itself. At zero,
retain the existing filter-free rendering path. Overscan the artwork by three radii
and clip the video at the viewport to avoid transparent edges; static and video crops
must match. For blurred static scenes, reuse the moving-scene message fade instead
of repainting a sharp wallpaper behind the composer. Persist only explicit overrides;
Reset removes the blur override. Reuse the settings Slider with a localized accessible
label and hint; None uses the desktop behavior above. Explain the additional GPU cost for video.
Dragging previews both visibility and blur locally; only a committed pointer/keyboard
value is saved and broadcast to other windows. Cancelled gestures, window blur or
leaving settings discard the preview; a failed save restores the saved value.
The macOS dispatcher caches successful native state per window: radius-only changes
retain the sidebar material, replaced materials resynchronize its mask, and failed
native calls remain retryable. It also owns background-color writes so redundant
updates cannot erase the tiny alpha backing that preserves AppKit window corners.
Existing artwork preferences without an explicit visibility override keep the previous Light/Dark veil
mapping and display its equivalent visibility. The unchanged soft default is 37% visible in
Light and 27% in Dark. Adjusting the slider saves literal visibility, shared across themes;
Reset removes that override and restores the theme-dependent default. Do not rewrite old
preferences just because they were read or a theme changed.
Remove the previous arrow, standalone portrait, gradient and paper
options and assets. Retired saved selections normalize to None; unrelated theme
and font preferences remain unchanged. All three scenes use the same cover fit,
so do not expose a fit selector that cannot affect them.

The scene-led Cindy wallpaper alternatives (2026-10-01) place the recognizable
character and black cat in three distinct illustrated environments: a sunny
window, a futuristic atelier and a floating garden above clouds. Preserve each
landscape as one viewport-sized, cover-fitted canvas behind navigation, chat and
tools. Do not confine the scene to chat, fade its edges into a separate backdrop,
or reposition/scale it when sidebars open: that splits the app into disconnected
pieces (user correction, 2026-10-01). Only window resizing changes the crop.
These curated scenes use a lighter theme-derived
veil than arbitrary photos, with a stronger Dark veil to preserve reading
contrast. Validate real long messages, not only empty chat views.

The three approved scenes also offer an explicit Static / Dynamic choice (2026-10-01).
Static remains the default. Dynamic uses a silent, subtly moving loop with a fixed
camera, preserving the same composition and full-window crop. Camera position,
viewing angle and field of view must stay constant throughout the entire loop,
including Dream Wander and Future Atelier (user correction, 2026-10-02). No pans,
tilts, dolly movement, zooms or perspective drift; matching first and last frames
alone is insufficient. Built-in static artwork
uses 3584×2240 WebP. The three official scenes use bundled 640×400 previews and
download the full WebP or 2304×1440 MP4 on demand (2026-10-15 decision), with no
resolution switching on window resize. Only the previews enter the Renderer bundle.
The motion approved on 2026-10-02 is preserved frame for frame at its original
24fps. The 2304×1440 delivery is Real-ESRGAN anime-video super-resolution
of the approved 1214×758 sources, not native 2K generation; do not regenerate,
retime or reverse the accepted motion while preparing higher-resolution assets.
Download only selected, visible assets and request video only for active dynamic
mode without reduced motion. Verify byte length and SHA-256 before placing assets
in the existing client-wallpaper media scope. Valid cached content is reused across
restarts, upgrades and accounts without another download; failures retain the preview
and permit retry. The download and cache contract is defined in
[`media-storage-and-protocols.md`](../dev-rules/media-storage-and-protocols.md).
Decode one local video
per window, suspend playback while hidden/minimized, and use the original still for
reduced motion or playback failure. Static / Dynamic switches crossfade the video
over the retained high-resolution still using base/ease-move (200ms), starting
only after playback is ready. Switching back to Static releases the video after
the fade; rapid toggles reverse it without adding a decoder. Reduced motion
bypasses the transition and releases the video immediately.
For moving scenes, fade the message layer above the composer instead of painting a
static duplicate of the wallpaper over it. Check the loop seam and actual Light/Dark
chat readability, including collapsed sidebars and resized windows.

Environment motion must be clearly perceptible rather than concentrated on the
character (user correction, 2026-10-01). Animate existing foliage, curtains and
leaf shadows in the sunny scene; rain, plants and reflections in the atelier;
clouds, grasses, vines and waterfalls in the floating garden. Keep architecture
and the camera stationary. Prefer several slow, independent environmental rhythms
with restrained character movement; verify foliage crops and loop transitions,
including after the Light/Dark readability veil is applied.
For the floating garden, keep the environmental amplitude restrained: tiny leaf
and vine-tip movement, slow cloud-edge drift and fine downward water flow. Avoid
large drifting petals, rolling cloud banks and whole flowerbeds sweeping across
the view (user correction, 2026-10-01). Demonstrate motion in recordings of the real
chat interface with messages, composer and pane chrome, not only isolated artwork.
In the sunny window scene, keep the curtain close to its resting drape: small,
slow folds rather than large billows across the window. Nearby leaves and light
shadows should move gently without competing with messages (user correction,
2026-10-01).
The window scene needs infrequent, natural blinking and coherent whole-scene
motion (user corrections, 2026-10-01). Judge hair, face, eyes, cat, curtains and
foliage together at normal playback speed. Do not retime an isolated eye patch
against a differently moving face or reverse hair motion to manufacture a loop.
Keep the blink gentle and the environment moving at a steady pace: never speed
up the entire frame to shorten a blink, which also accelerates curtains, hair and
shadows (user correction, 2026-10-02). Avoid mid-blink reopening, alternating-frame
holds and doubled eyelid outlines. Decoder frame counts alone do not establish natural
motion; inspect the complete action and loop boundary before accepting an asset.

