#!/usr/bin/env node
// Run: node apps/desktop/scripts/check-wallpaper-video-compositing.mjs [Chromium executable]
// Uses production CSS and a deterministic video poster in an isolated browser.
// The companion WallpaperVideo.test.tsx checks the CSS contract in normal unit/CI runs.
// Requires an installed Chromium executable argument or a Playwright Chromium cache.
// playwright-core does not download a browser; this script does not install one.
// Guards blending/visibility without relying on codec availability. HDR/driver behavior still
// requires the Windows FP16 screen-capture regression described in the test output.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import sharp from 'sharp';

const css = readFileSync(
  new URL('../src/renderer/styles/globals.css', import.meta.url),
  'utf8',
).replace(/^@import.*$/gm, '');
const mediaColor = [64, 128, 192];
const poster = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path fill="#4080c0" d="M0 0h32v32H0z"/></svg>',
)}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.argv[2] ? { executablePath: process.argv[2] } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
  await page.setContent(`<!doctype html><html data-wallpaper-active="true">
    <style>${css}</style><style>body{margin:0} :root{
      --motion-base:0ms;--motion-ease-move:linear;
      --app-wallpaper-image:linear-gradient(red,red);
    }</style><body><div class="app-wallpaper-video" style="opacity:1">
      <video poster="${poster}"></video></div></body></html>`);
  await page.evaluate(async (src) => {
    const image = new Image();
    image.src = src;
    await image.decode();
  }, poster);
  let checked = 0;
  // The bright red still fallback deliberately differs from the video. It must
  // never bleed through a ready, partially transparent video canvas.
  for (const [theme, surface] of [
    ['dark', [24, 24, 24]],
    ['light', [242, 242, 237]],
  ]) {
    for (const visibility of [0, 0.01, 0.14, 0.5, 0.99, 1]) {
      const styles = await page.evaluate(
        ({ surface, visibility }) => {
          const root = document.documentElement;
          root.style.setProperty('--surface', `rgb(${surface.join(',')})`);
          root.style.setProperty('--app-wallpaper-veil', `${100 - visibility * 100}%`);
          const layer = document.querySelector('.app-wallpaper-video');
          return {
            opacity: Number(getComputedStyle(layer.querySelector('video')).opacity),
            layerOpacity: Number(getComputedStyle(layer).opacity),
            veil: getComputedStyle(layer, '::after').content,
          };
        },
        { surface, visibility },
      );
      assert.ok(
        Math.abs(styles.opacity - visibility) < 0.00001,
        `${theme} ${visibility}: visibility must apply to the video before UI composition`,
      );
      assert.equal(styles.layerOpacity, 1, 'visibility must not fade the theme backing');
      assert.ok(['none', 'normal'].includes(styles.veil), 'no separate translucent video veil');
      const { data } = await sharp(
        await page.screenshot({
          clip: { x: 160, y: 120, width: 1, height: 1 },
        }),
      )
        .raw()
        .toBuffer({ resolveWithObject: true });
      for (let channel = 0; channel < 3; channel++) {
        const expected = surface[channel] * (1 - visibility) + mediaColor[channel] * visibility;
        assert.ok(
          Math.abs(data[channel] - expected) <= 2,
          `${theme} ${visibility}: channel ${channel}=${data[channel]}, expected ${expected}`,
        );
      }
      checked++;
    }
  }
  // Loading and exit still expose the underlying still canvas, rather than
  // leaving an opaque theme-colored rectangle behind.
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--app-wallpaper-veil', '0%');
    document.querySelector('.app-wallpaper-video').style.opacity = '0';
  });
  const hidden = await sharp(
    await page.screenshot({
      clip: { x: 160, y: 120, width: 1, height: 1 },
    }),
  )
    .raw()
    .toBuffer();
  assert.deepEqual([...hidden.subarray(0, 3)], [255, 0, 0]);
  console.log(
    `PASS: ${checked} light/dark visibility cases, opaque backing, and loading/exit fallback.`,
  );
  console.log(
    'HDR acceptance: toggle P3/sRGB content with a fixed video frame; compare FP16 scRGB screen captures, not GDI/PNG screenshots.',
  );
} finally {
  await browser.close();
}
