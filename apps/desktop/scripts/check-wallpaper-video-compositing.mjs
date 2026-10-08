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
  // A uniform poster must remain uniform even at the viewport edges with blur.
  // This catches transparent filter margins and an accidentally blurred backing.
  for (const surface of [[24, 24, 24], [242, 242, 237]]) {
    await page.evaluate((surface) => {
      const root = document.documentElement;
      root.dataset.wallpaperBlur = 'true';
      root.style.setProperty('--app-wallpaper-blur', '20px');
      root.style.setProperty('--surface', `rgb(${surface.join(',')})`);
      root.style.setProperty('--app-wallpaper-veil', '50%');
      document.querySelector('.app-wallpaper-video').style.opacity = '1';
    }, surface);
    const { data, info } = await sharp(await page.screenshot()).raw().toBuffer({ resolveWithObject: true });
    for (const [x, y] of [[0, 0], [319, 0], [0, 239], [319, 239], [160, 120]]) {
      for (let c = 0; c < 3; c++) {
        assert.ok(Math.abs(data[(y * info.width + x) * info.channels + c] - (surface[c] + mediaColor[c]) / 2) <= 2,
          `blurred video edge ${x},${y} channel ${c}`);
      }
    }
  }
  const stripes = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><defs><pattern id="p" width="16" height="16" patternUnits="userSpaceOnUse"><path fill="black" d="M0 0h8v16H0z"/><path fill="white" d="M8 0h8v16H8z"/></pattern></defs><path fill="url(#p)" d="M0 0h320v240H0z"/></svg>')}`;
  await page.evaluate(async (src) => {
    const image = new Image(); image.src = src; await image.decode();
    document.querySelector('video').poster = src;
    document.documentElement.style.setProperty('--app-wallpaper-image', `url("${src}")`);
    document.documentElement.style.setProperty('--app-wallpaper-veil', '0%');
  }, stripes);
  for (const mode of ['static', 'video']) {
    for (const blur of [0, 20]) {
      const computed = await page.evaluate(({ mode, blur }) => {
        const root = document.documentElement;
        if (blur) root.dataset.wallpaperBlur = 'true'; else delete root.dataset.wallpaperBlur;
        root.style.setProperty('--app-wallpaper-blur', `${blur}px`);
        document.querySelector('.app-wallpaper-video').style.opacity = mode === 'video' ? '1' : '0';
        return { body: getComputedStyle(document.body).filter,
          media: mode === 'video' ? getComputedStyle(document.querySelector('video')).filter : getComputedStyle(document.body, '::before').filter };
      }, { mode, blur });
      assert.equal(computed.body, 'none');
      assert.equal(computed.media, blur ? 'blur(20px)' : 'none');
      const pixel = await sharp(await page.screenshot({ clip: { x: 162, y: 120, width: 1, height: 1 } })).raw().toBuffer();
      if (blur) assert.ok(pixel[0] > 100 && pixel[0] < 155, `${mode} did not soften stripes: ${pixel[0]}`);
      else assert.ok(pixel[0] < 5, `${mode} zero blur changed the original artwork: ${pixel[0]}`);
    }
  }
  console.log(
    `PASS: ${checked} light/dark visibility cases, opaque backing, loading/exit fallback, blur edges and static/video softness.`,
  );
  console.log(
    'HDR acceptance: toggle P3/sRGB content with a fixed video frame; compare FP16 scRGB screen captures, not GDI/PNG screenshots.',
  );
} finally {
  await browser.close();
}
