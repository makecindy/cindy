# Native toolbar artwork

`monitor.svg` and `folder.svg` preserve the existing lucide-react-native 0.468.0
Monitor and Folder geometry,
22pt (`iconSize.xl`), viewBox stroke width 2 (`iconStroke.regular`). PNGs at 1x,
2x and 3x let the native toolbar use this same outline icon as a template image,
without substituting an SF Symbol or losing Duo's native vertical placement.
Metro bundles these JS-referenced assets; no native asset catalog change.
Lucide's ISC license is included in LICENSE.

The home menu uses menu.svg: a 26pt transparent canvas with the existing narrow
20pt glyph centered inside it (13.5pt horizontal paths, 2pt round strokes,
matching the regular icon weight). The endpoints are inset by 0.25pt to preserve
the approved 15.5pt visible width.
The native toolbar tints the template; Duo's custom 44pt button uses the same
artwork and semantic tint. Do not use an empty Stack.Toolbar.Badge: the iOS
header bridge constructs a text badge even for an empty value, producing an
oversized circle. These are JS-bundled images, not native asset-catalog inputs.

The home display button uses ellipsis.svg (template) and, while the list shows
archived tasks, ellipsis-attention-light.svg / ellipsis-attention-dark.svg. They
share the same 26pt canvas and Lucide Ellipsis geometry as the Android header;
the attention variants add the same 6pt dot at the upper right in statusAccent
and are rendered as original images, so each theme has its own glyph color.
