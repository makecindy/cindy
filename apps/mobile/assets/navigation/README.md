# Native toolbar artwork

`monitor.svg` and `folder.svg` preserve the existing lucide-react-native 0.468.0
Monitor and Folder geometry,
22pt (`iconSize.xl`), viewBox stroke width 2 (`iconStroke.regular`). PNGs at 1x,
2x and 3x let the native toolbar use this same outline icon as a template image,
without substituting an SF Symbol or losing Duo's native vertical placement.
Metro bundles these JS-referenced assets; no native asset catalog change.
Lucide's ISC license is included in LICENSE.
