# Classic Mac-inspired hardware artwork

Generated on 2026-10-24 with OpenAI image_gen, following the owner’s request for physical classic Macintosh styling. These are generated material illustrations, not photographs of a manufactured device or original Apple assets.

Reference: https://x.com/snsnotecom/status/2113540405891625291 (physical cream miniature laptop).

Prompt direction:

- display.webp: orthographic front view of a 1984 Macintosh-inspired aged ivory molded-plastic display fascia, fine grain, thick recessed black CRT opening, lower chin, floppy slot on the right, subtle Cindy 84 mark on the left. Upper-left studio lighting; no Apple logo, app UI or outside background.
- deck.webp: matching orthographic top view of an ivory keyboard deck, recessed empty keyboard well and lower central trackpad; same plastic grain and studio lighting, no keys or UI.
- keycap.webp: one unlettered ivory vintage mechanical keycap, sculpted bevels and soft shadow, orthographic top view, transparent background.

Delivery: generated PNGs resized/encoded as WebP (display/deck 1536×1024, keycap 192×192). Text, pointer targets and keyboard input are live React Native components. Screen content is the existing remote viewer; historical screenshots used for visual previews are not bundled here.

## Space-efficient variants (2026-10-24)

Built-in OpenAI image_gen; reference inputs were display.webp and deck.webp. Original artwork is retained.

Final prompt set:

- display-compact.webp: exact orthographic 1536×1024 ivory molded ABS fascia, keep realistic plastic grain, chamfers and antique Macintosh character; enlarge the empty black opening to nearly the whole frame, narrow sides/top and a small lower chin with Cindy 84 and floppy slot. No perspective or app UI.
- display-edge.webp: matching physical ivory fascia, maximize black display with only a narrow sculpted rim and dark recessed gasket; remove chin, slot and lettering. Fine plastic grain and upper-left studio light; no UI or external scene.
- deck-rail.webp / deck-keys.webp / deck-pad.webp: one matching orthographic 1536×1024 ivory deck, near-full-width empty keyboard recess and broad lower trackpad, minimal borders and palm rest, blank top appearance strip; no keys, labels, logos or speakers. Exported into three horizontal bands (0–110, 110–680, 680–1024) so the real keyboard and touchpad can adapt independently to the available height without shrinking touch targets.

Source slice boundaries follow the measured inner glass edges in each 1536×1024 image, not an inset within the black glass: classic `(170,144)–(1367,761)`, compact `(70,67)–(1468,848)`, edge `(67,68)–(1471,954)`. The surrounding case is resized around the exact live-view rectangle so no extra black glass is retained as a second frame. The destination opening is enlarged separately and fitted to the host display aspect inside the safe region; the remote image itself is never stretched.

## Historical computer collection (2026-10-24)

Generated with built-in OpenAI image_gen using real product-photo references:

- Macintosh II: https://theapplemuseum.org/html/main/x-mac-ii.html (1987; separate desktop/monitor adapted to a foldable UI).
- PowerBook 170: https://www.mac-museum.com/apple-geraete/powerbook-170.html (1991; graphite case, trackball and rainbow Apple badge).
- ThinkPad 701C: https://www.computerhistory.org/revolution/artifact/317/1803 and https://mcomputers.cz/2022/10/05/thinkpad-30-let/thinkpad-701c/ (1995; black case, red TrackPoint and butterfly keyboard reference).

These are generated historical homages, not original manufacturer artwork. Enlarged displays, simplified live keyboard layouts and invisible palmrest input adapt the physical designs to Duo; the butterfly mechanism is not simulated. The screen always remains the live remote desktop, regardless of hardware skin.

Final prompt set:

- macii-* / powerbook-* / thinkpad-*: photoreal orthographic hardware atlas, front display above top-view deck, equal panels, no perspective or exterior scene; enlarged empty black screen with narrow brand strip, near-full-width empty keyboard well for live keys. Preserve each reference’s real molded material, subtle bevels, characteristic logo and details. Macintosh II: platinum Snow White grooves, six-stripe rainbow Apple and green LED, small center touchpad as an adaptation. PowerBook: dark gray, rainbow Apple, latch/hinges and compact gray trackball/buttons. ThinkPad: black rubberized material, IBM/701C lettering, stepped keyboard seam, compact red-accent buttons, no rectangular pad.
- keycap-dark.webp: single unlettered graphite ABS vintage laptop keycap, concave top and bevels, upper-left studio light, transparent background.
- trackpoint.webp: single classic red rubber ThinkPad cap, dimple texture, orthographic top view, transparent background.
- deck-pad-small.webp: edit the original ivory palmrest, keep material and borders, replace the full-width pad with a centered pad roughly22% of the width.

Atlas slices are separated into display, rail, keyboard backing, blank palmrest texture and small control sprites. Pointing controls preserve their own aspect ratio while their input surface spans the entire palmrest; key/rail hit areas remain separate. Original three study skins are retained. No third-party reference photos are included in the app bundle.

Additional finishing prompts (built-in image_gen):

- *-palm-v2.webp: three equal edge-to-edge blank material samples (platinum ABS / graphite ABS / black soft-touch rubber), subtle fine grain with diffuse lighting, no gradients, controls, logos or borders. Each sample is extracted separately and covers the palmrest without stretching grain.
- powerbook-control-cutout.webp: preserve the photographed trackball and two curved buttons, remove all surrounding palmrest and the gap between controls to true transparency; retain shapes, rim and lighting.
