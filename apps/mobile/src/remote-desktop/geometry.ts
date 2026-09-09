// This runs inside the WebView. Keep its source literal: Hermes function.toString()
// does not preserve executable JavaScript source, even in development builds.
/** Preserve the remote focus point when the phone rotates or the keyboard resizes it. */
export const DESKTOP_TRANSFORM_SCRIPT = String.raw`function desktopTransform(
  vw,
  vh,
  dw,
  dh,
  zoom,
  fx,
  fy,
  fillHeight = false,
) {
  const scale =
    (fillHeight ? vh / Math.max(1, dh) : Math.min(vw / Math.max(1, dw), vh / Math.max(1, dh))) *
    Math.max(1, Math.min(5, zoom));
  const width = dw * scale;
  const height = dh * scale;
  const x =
    width <= vw
      ? (vw - width) / 2
      : Math.min(0, Math.max(vw - width, vw / 2 - fx * width));
  const y =
    height <= vh
      ? (vh - height) / 2
      : Math.min(0, Math.max(vh - height, vh / 2 - fy * height));
  return { x, y, width, height, scale };
}`;
