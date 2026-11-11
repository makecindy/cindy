// NativeImage bitmap is BGRA. The caller explicitly requests scaleFactor: 1.
function inspectPixels(bitmap) {
  if (bitmap.length !== 640 * 480 * 4) return { pixelsMatch: false, bitmapBytes: bitmap.length };
  const colors = [60, 160, 260].map((x) => {
    const offset = (60 * 640 + x) * 4;
    return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]];
  });
  return {
    colors,
    // Electron 41 returns the display color space; 43 defaults to sRGB. Test
    // three distinct dominant channels rather than requiring identical bytes.
    pixelsMatch: colors.every(
      (rgb, dominant) =>
        rgb[dominant] >= 150 &&
        rgb.every((value, channel) => channel === dominant || rgb[dominant] - value >= 70),
    ),
  };
}
module.exports = { inspectPixels };
