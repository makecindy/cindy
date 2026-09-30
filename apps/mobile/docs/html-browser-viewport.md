# HTML browser viewport

On iOS 26+, local HTML and websites keep a full-size WebView under floating
browser controls. The host sets WebKit's public `obscuredContentInsets`, which
adjusts the layout viewport and fixed/sticky positioning without shrinking the
native view. Matching scroll-view `contentInset` values let ordinary document
content scroll clear of both toolbars at the start and end. The obscured prop
alone does not supply this scroll range. No page styles or browser APIs are overridden. The keyboard is
handled by WebKit; it is not added to the browser-chrome prop a second time.

Android and older iOS retain a bounded WebView fallback. Optional advisory
geometry remains available without a page-to-native message handler.

## CSS and JavaScript

All lengths are **CSS pixels**, including when the page is zoomed or has no viewport meta tag.

| CSS custom property | Meaning |
| --- | --- |
| `--cindy-viewport-width`, `--cindy-viewport-height` | Measured WebView frame |
| `--cindy-controls-top/right/bottom/left` | Conservative strips occupied by browser controls and device safe areas within that frame |
| `--cindy-inset-top/right/bottom/left` | Same strips, with keyboard obstruction included |
| `--cindy-available-width`, `--cindy-available-height` | Frame minus the obstruction strips, clamped to zero |
| `--cindy-available-top`, `--cindy-available-left` | Available rectangle origin in **document** coordinates, including native scrolling |

`window.cindyViewport` is a read-only, frozen snapshot:

```js
// Every field except version is a CSS length.
{ version: 1, width, height, controls: { top, right, bottom, left },
  insets: { top, right, bottom, left }, availableTop, availableLeft,
  availableWidth, availableHeight }
```

Read it if present, then listen for `window`'s `cindyviewportchange` event;
`event.detail` contains the next snapshot. Geometry can arrive after page scripts
start. Updates follow native layout, scrolling, rotation, keyboard frame/show/hide and page
zoom changes. Each navigated document receives its own installation. Event handlers
must be idempotent; delivery can repeat the same geometry after navigation/load.

## Full-height application example

```html
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  .app { position: absolute;
         top: var(--cindy-available-top, 0px);
         left: var(--cindy-available-left, 0px);
         height: var(--cindy-available-height, 100dvh);
         width: var(--cindy-available-width, 100%);
         display: flex; flex-direction: column; }
  .app > main { flex: 1; min-height: 0; overflow: auto; }
  .app > header, .app > footer { flex: none; }
</style>
<div class="app"><header>Title</header><main>Content</main><footer>Actions</footer></div>
```

On iOS 26+, the published width/height describe the full native WebView frame.
Controls describe the toolbar/safe-area strips, and insets describe their union
with keyboard occlusion. Available dimensions exclude those strips. These custom
values are advisory; ordinary fixed footers rely on WebKit's native layout.
`obscuredContentInsets` and CSS `env(safe-area-inset-*)` are distinct APIs; do not
assume the latter equals the toolbar height or add toolbar padding twice.

In the older-platform fallback, strips are excluded by native layout, so published
controls/insets are zero and available dimensions equal the smaller WebView frame.
The full-height example uses document coordinates, not fixed-position offsets.
An overlapping floating keyboard conservatively reserves the strip below its top
edge in the advisory geometry. Transient menus and share sheets are not included.
Page-local properties are not a security boundary.

## Native build requirement

The WebView dependency patch adds the prop to Fabric, Paper and TypeScript with
an iOS 26 SDK/runtime guard and zero default. Existing selection-menu changes are
preserved. This changes the native fingerprint: ship a new binary; an OTA update
cannot add this native capability to an old binary. Release/merge still requires
the repository's explicit cold-update review.

## Address editing

Tapping the address capsule edits the address in place. Submitting a bare domain
uses HTTPS; explicit HTTP and HTTPS addresses are supported. Invalid input keeps
the editor open. The file preview displays its local path, never its private
snapshot bootstrap URL; leaving that path unchanged dismisses editing. The field
does not navigate to other local filesystem paths.

Opening a website waits for the file snapshot server to close, then mounts a
separate incognito WebView without file access or a page-to-native message handler.
The website receives the same advisory viewport geometry. Native website history
stays available while the app is inactive. The menu offers Return to file and Copy
address; returning to the file starts a fresh snapshot. Copy and share use the
website's current URL, including redirects.
