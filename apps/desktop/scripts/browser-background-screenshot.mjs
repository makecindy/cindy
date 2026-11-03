import sharp from 'sharp';

// A native capture must contain the local fixture, not just a correctly sized PNG.
// These are the two background bands; text and button pixels are intentionally ignored.
export async function checkBrowserFixtureScreenshot(png) {
  const { data, info } = await sharp(png).toColourspace('srgb').ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const colours = [[232, 237, 244], [210, 222, 239]];
  const counts = [0, 0];
  for (let offset = 0; offset < data.length; offset += info.channels) {
    if (data[offset + 3] < 250) continue;
    for (let band = 0; band < colours.length; band++) {
      if (colours[band].every((value, channel) => Math.abs(data[offset + channel] - value) <= 5)) {
        counts[band]++;
      }
    }
  }
  const stripeCoverage = counts.map(count => count / (info.width * info.height));
  // Both bands occupy about half the page. Allow room for text, controls and colour rounding.
  if (stripeCoverage.some(coverage => coverage < 0.2)) {
    throw new Error('FIXTURE_SCREENSHOT_CONTENT_MISMATCH');
  }
  return { stripeCoverage };
}
