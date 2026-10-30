import assert from 'node:assert/strict';
export default {
  name: 'region-capture', entry: './capture-fixture.tsx', viewport: { width: 900, height: 700 },
  real: 'RegionScreenshotOverlay, ScrollCaptureOverlay, LiveCapturePanel, ScrollCapture, CaptureRecorder, real Chromium canvas/MediaRecorder and GIF encoding',
  notCovered: 'Native screen acquisition, global keyboard sampling, macOS permissions and native save dialogs; frame source is synthetic.',
  cases: {
    snapping: { about: 'Correct a transparent window guess, hover adjacent elements, cycle hierarchy and click to select' },
    default: { about: 'Scroll overlapping text, finish, export the actual stitched pixels' },
    idle: { about: 'Repainting before the first scroll keeps the gesture hint, then scrolling still exports a long image' },
    'preview-motion': { about: 'Prepending reveals new rows without jumping existing content; growth and scrolling share one animation' },
    inactive: { about: 'Only the display under the pointer shows capture controls' },
    drag: { about: 'Move the top toolbar horizontally without selecting pixels or leaving screen bounds' },
    video: { about: 'Record, annotate, pause/resume, save and decode a WebM' },
    gif: { about: 'Record, annotate, pause/resume, save and decode an animated GIF' },
  },
  async ready(page) { await page.locator('canvas').first().waitFor(); },
  async check(page, ui) {
    if (ui.case === 'snapping') {
      await page.getByText('180 × 140', { exact: true }).waitFor();
      await ui.capture('first-element');
      await page.mouse.move(400, 180);
      await page.getByText('200 × 140', { exact: true }).waitFor();
      await ui.capture('adjacent-element');
      await page.mouse.wheel(0, -120);
      await page.getByText('480 × 360', { exact: true }).waitFor();
      await ui.capture('corrected-window');
      await page.mouse.click(400, 180);
      await page.mouse.move(650, 550);
      assert.equal(await page.getByText('480 × 360', { exact: true }).count(), 1, 'click keeps the resolved window selected');
      await ui.capture('selected');
      return;
    }
    if (ui.case === 'preview-motion') await page.emulateMedia({ reducedMotion: 'no-preference' });
    const isScroll = ['default', 'idle', 'preview-motion'].includes(ui.case);
    const button = async (key) => page.getByRole('button', { name: await ui.t(key), exact: true });
    let pausedAt = 0, resumedAt = 0;
    // e2e: exercise the real pointer capture path. Dragging the handle must move
    // only the toolbar, retain its top position, and keep both ends reachable.
    if (ui.case === 'drag') {
      const handle = await button('regionScreenshot.moveToolbar');
      const bar = handle.locator('..');
      const initial = await bar.boundingBox();
      const move = async (x, y) => {
        const grip = await handle.boundingBox();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
        await page.mouse.down(); await page.mouse.move(x, y, { steps: 10 }); await page.mouse.up();
      };
      const grip = await handle.boundingBox();
      // Longer translations have less free space. Exercise an unconstrained
      // move first; the following drags independently verify both screen edges.
      const distance = Math.min(100, (page.viewportSize().width - initial.width) / 4);
      assert.ok(distance > 0);
      await move(grip.x + grip.width / 2 + distance, grip.y + 150);
      let bounds = await bar.boundingBox();
      assert.ok(Math.abs(bounds.x - initial.x - distance) < 1);
      assert.equal(bounds.y, initial.y);
      await move(899, 400);
      bounds = await bar.boundingBox();
      assert.ok(bounds.x + bounds.width <= 893);
      await move(1, 400);
      const leftBounds = await bar.boundingBox();
      // CSS centering can round a fractional width by half a layout subpixel.
      assert.ok(Math.abs(leftBounds.x - 8) < 0.02, JSON.stringify(leftBounds));
      await (await button('regionScreenshot.live.scroll')).click();
      assert.equal(await (await button('regionScreenshot.live.startScroll')).count(), 0, 'dragging the toolbar does not create a capture selection');
      assert.equal(await page.evaluate(() => window.captureQa.frames), 0);
      await ui.capture('dragged');
      return;
    }
    // e2e regression: previously every monitor showed its own mode bar. A begin
    // payload with no local cursor models the second screen; entry/exit must
    // transfer visible controls without relying on emulated document focus.
    if (ui.case === 'inactive') {
      const mode = await button('regionScreenshot.live.scroll');
      assert.equal(await mode.count(), 0);
      await page.mouse.move(20, 100);
      await mode.waitFor({ state: 'visible' });
      await ui.capture('active');
      await page.mouse.move(-10, -10);
      await mode.waitFor({ state: 'hidden' });
      return;
    }
    if (!isScroll) {
      await (await button('regionScreenshot.live.video')).click();
      assert.equal(await page.getByRole('button', { name: 'GIF', exact: true }).count(), 0, 'GIF is a format after selection, not a top-level mode');
      await page.mouse.move(100, 80); await page.mouse.down();
      await page.mouse.move(580, 320, { steps: 8 }); await page.mouse.up();
      if (ui.case === 'gif') await page.getByRole('button', { name: 'GIF', exact: true }).click();
      assert.equal(await page.getByRole('checkbox').count(), 0, 'recording needs no pointer or keystroke settings');
      assert.equal(await page.evaluate(() => window.captureQa.frames), 0);
      await ui.capture('prepare');
      await (await button('regionScreenshot.live.start')).click();
      await ui.capture('countdown');
      assert.equal(await page.evaluate(() => window.captureQa.frames), 0, 'countdown is not recorded');
      await page.waitForFunction(() => window.captureQa.frames >= 3);
      assert.equal(await page.evaluate(() => window.captureQa.keysRequested), false, 'recording does not request keyboard input');
      assert.equal(await page.locator('canvas').count(), 0, 'recording has no permanent thumbnail');
      await ui.capture('compact-controls');
      // User regression: dragging the format/time area did nothing. Exercise real
      // pointer capture, including release and continued recording after the move.
      const bar = page.getByRole('region', { name: await ui.t('regionScreenshot.live.video'), exact: true });
      const initial = await bar.boundingBox();
      const label = await bar.getByText(ui.case === 'gif' ? 'GIF' : 'WebM', { exact: true }).boundingBox();
      await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);
      await page.mouse.down();
      await page.mouse.move(label.x + label.width / 2 + 90, label.y + label.height / 2 + 40, { steps: 6 });
      await page.mouse.up();
      const moved = await bar.boundingBox();
      assert.ok(Math.abs(moved.x - initial.x - 90) < 1 && Math.abs(moved.y - initial.y - 40) < 1, 'format/time area moves the recording toolbar');
      await page.mouse.move(20, 600);
      assert.deepEqual(await bar.boundingBox(), moved, 'toolbar stays put after release');
      await ui.capture('dragged-recording-controls');
    }
    else {
      const modeButton = await button('regionScreenshot.live.scroll');
      assert.ok((await modeButton.boundingBox()).y < 60, 'capture modes are at the screen top before selection');
      await modeButton.click();
      assert.equal(await page.locator('button[aria-pressed="true"]').count(), 1);
      await page.mouse.move(100, 100); await page.mouse.down();
      await page.mouse.move(580, 340, { steps: 8 }); await page.mouse.up();
      assert.equal(await page.evaluate(() => window.captureQa.frames), 0, 'choosing a mode and a region does not start capture');
      await ui.capture('ready');
      await (await button('regionScreenshot.live.startScroll')).click();
      assert.equal(await (await button('regionScreenshot.live.pause')).count(), 0, 'scrolling has no separate capture toolbar');
      assert.equal(await page.getByRole('complementary').count(), 1, 'the selection has an inline stitched preview');
      const previewStyle = await page.getByRole('complementary').evaluate(el => {
        const box = el.getBoundingClientRect(), css = getComputedStyle(el);
        return { bottom: box.bottom, x: box.x, border: css.borderWidth, background: css.backgroundColor };
      });
      assert.equal(previewStyle.bottom, 340, 'preview starts at the selection bottom');
      assert.ok(previewStyle.x > 580, 'preview prefers the right side');
      assert.equal(previewStyle.border, '0px', 'image has no surrounding frame');
      assert.equal(previewStyle.background, 'rgba(0, 0, 0, 0)', 'image has no opaque backing');
    }
    if (ui.case === 'preview-motion') {
      // e2e regression: at each real paint, follow a row already in the image.
      // A prepended strip must grow upward without moving that old row down first.
      // The existing long-preview test only checks final geometry, missing this jump.
      const motion = await page.evaluate(async () => {
        const panel = document.querySelector('aside');
        const view = panel.querySelector('[tabindex="0"]');
        const strip = view.firstElementChild;
        const initial = panel.getBoundingClientRect();
        const extent = strip.getBoundingClientRect().height;
        const rows = [];
        window.captureQa.manualScroll = 180;
        await new Promise(resolve => {
          const start = performance.now();
          const tick = () => {
            const box = panel.getBoundingClientRect();
            rows.push({ height: box.height, bottom: box.bottom, anchor: box.top + strip.getBoundingClientRect().height - extent - view.scrollTop });
            if (performance.now() - start < 650) requestAnimationFrame(tick); else resolve();
          };
          requestAnimationFrame(tick);
        });
        return { initial: { top: initial.top, height: initial.height }, rows };
      });
      assert.ok(motion.rows.at(-1).height > motion.initial.height + 10, 'new rows were stitched');
      assert.ok(motion.rows.some(row => row.height > motion.initial.height + 1 && row.height < motion.rows.at(-1).height - 1), 'growth has intermediate frames');
      assert.ok(motion.rows.every(row => Math.abs(row.bottom - 340) < 1), 'bottom anchor is stable');
      const jump = Math.max(...motion.rows.map(row => Math.abs(row.anchor - motion.initial.top)));
      assert.ok(jump < 2, `existing image rows jumped by ${jump.toFixed(2)}px during prepend`);
      await ui.capture('smooth-prepend');
      const frames = await page.evaluate(() => { window.captureQa.manualScroll = 300; return window.captureQa.frames; });
      await page.waitForFunction(n => window.captureQa.frames >= n + 2, frames);
      await page.evaluate(() => { window.captureQa.manualScroll = 420; });
      await page.waitForFunction(() => {
        const p = document.querySelector('aside');
        return p.getBoundingClientRect().height >= p.getBoundingClientRect().width - 1;
      });
      const scrolling = await page.evaluate(async () => {
        const panel = document.querySelector('aside');
        const view = panel.querySelector('[tabindex="0"]');
        const samples = [];
        window.captureQa.manualScroll = 540;
        await new Promise(resolve => {
          const start = performance.now();
          const tick = () => {
            samples.push({ height: panel.getBoundingClientRect().height, scroll: view.scrollTop });
            if (performance.now() - start < 650) requestAnimationFrame(tick); else resolve();
          };
          requestAnimationFrame(tick);
        });
        return { samples, end: view.scrollHeight - view.clientHeight };
      });
      assert.ok(scrolling.end > 0 && Math.abs(scrolling.samples.at(-1).scroll - scrolling.end) < 2, 'append follows the new bottom after reaching the panel limit');
      assert.ok(scrolling.samples.some(row => row.scroll > 1 && row.scroll < scrolling.end - 1), 'following new rows has intermediate frames');
      await ui.capture('smooth-append');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate(() => { window.captureQa.manualScroll = 660; });
      await page.waitForFunction(() => {
        const view = document.querySelector('aside [tabindex="0"]');
        return view.firstElementChild.getBoundingClientRect().height >= 450;
      });
      assert.ok(await page.locator('aside [tabindex="0"]').evaluate(el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 2), 'reduced motion reaches the new bottom without animation');
      return;
    }
    if (ui.case === 'idle') {
      // e2e regression: the old panel displayed a lost-overlap warning after
      // 1.5 seconds even though the source had only repainted without scrolling.
      await page.waitForFunction(() => window.captureQa.frames >= 10);
      assert.equal(await page.getByRole('status').innerText(), await ui.t('regionScreenshot.live.scrollHint'));
      await ui.capture('waiting-for-scroll');
      await page.evaluate(() => { window.captureQa.idle = false; });
      await page.waitForFunction(() => window.captureQa.scrollFrames >= 3);
    }
    await page.waitForFunction(() => window.captureQa.frames >= 3);
    if (isScroll) {
      await (await button('regionScreenshot.live.autoScroll')).click();
      await page.waitForFunction(() => window.captureQa.automatic);
      await (await button('regionScreenshot.live.stopScroll')).click();
      await page.waitForFunction(() => !window.captureQa.automatic);
      await ui.capture('scrolling');
      if (ui.case === 'default') {
        // Regression: a growing screenshot previously shrank to fit the panel.
        // Real canvas output must retain its width, scroll to new content and allow review.
        const thumbnail = page.getByRole('complementary').locator('canvas');
        const width = await thumbnail.evaluate(el => el.width);
        await page.evaluate(() => { window.captureQa.scrollLimit = 600; });
        await page.waitForFunction(() => window.captureQa.scrollFrames >= 21);
        assert.equal(await thumbnail.evaluate(el => el.width), width);
        assert.equal((await page.getByRole('complementary').boundingBox()).y + (await page.getByRole('complementary').boundingBox()).height, 340, 'preview keeps its bottom anchor as it grows');
        const viewport = page.getByRole('complementary').locator('[tabindex="0"]');
        assert.ok(await viewport.evaluate(el => el.scrollHeight > el.clientHeight && el.scrollTop > 0));
        await ui.capture('long-preview');
        await viewport.hover(); await page.mouse.wheel(0, -1000);
        await page.waitForFunction(() => document.querySelector('aside [tabindex="0"]').scrollTop === 0);
      }
    }
    if (!isScroll) {
    pausedAt = await page.evaluate(() => performance.now());
    await (await button('regionScreenshot.live.pause')).click();
    const frames = await page.evaluate(() => window.captureQa.frames);
    // e2e: cross a real capture tick to prove that the user-visible pause stops sampling.
    await page.waitForTimeout(ui.case === 'video' ? 1600 : 400);
    assert.equal(await page.evaluate(() => window.captureQa.frames), frames);
    await ui.capture('paused');
    if (!isScroll) {
      await (await button('regionScreenshot.live.annotate')).click();
      await (await button('regionScreenshot.tools.arrow')).click();
      const box = await page.locator('canvas').boundingBox();
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.4);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 8 });
      await page.mouse.up();
    }
    await (await button('regionScreenshot.live.resume')).click();
    resumedAt = await page.evaluate(() => performance.now());
    await page.waitForFunction((previous) => window.captureQa.frames >= previous + 3, frames);
    await ui.capture('capturing');
    }
    const sampledDuration = await page.evaluate(() => performance.now() - window.captureQa.firstFrameAt) - (resumedAt - pausedAt);
    await (await button(isScroll ? 'regionScreenshot.live.edit' : 'regionScreenshot.live.finish')).click();
    if (isScroll) {
      await page.setViewportSize({ width: 900, height: 700 });
      await page.waitForFunction(() => window.captureQa.restored);
      const arrow = await ui.t('regionScreenshot.tools.arrow');
      await page.getByRole('button', { name: `${arrow} (A)`, exact: true }).click();
      const box = await page.locator('canvas').first().boundingBox();
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2); await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4, { steps: 8 }); await page.mouse.up();
      await ui.capture('independent-editor');
      const dimensions = await page.locator('canvas').first().evaluate(el => [el.width, el.height]);
      await (await button('remoteDesktop.fit')).click();
      await (await button('remoteDesktop.actualSize')).click();
      // The idle case produces a short image. Give it a smaller editing window
      // so a wheel gesture has real overflow to scroll, just as with a long capture.
      try {
        if (ui.case === 'idle') await page.setViewportSize({ width: 900, height: 400 });
        const review = page.locator('[tabindex="0"]');
        assert.ok(await review.evaluate(el => el.scrollHeight > el.clientHeight), 'the editor has overflow to review');
        await review.evaluate(el => { el.scrollTop = 0; });
        await review.hover(); await page.mouse.wheel(0, 300);
        await page.waitForFunction(() => document.querySelector('[tabindex="0"]').scrollTop > 0);
        assert.deepEqual(await page.locator('canvas').first().evaluate(el => [el.width, el.height]), dimensions, 'zoom and scrolling do not resample the source');
      } finally {
        // Electron reuses this page across variants. A CDP viewport override
        // survives native setContentSize, poisoning every case after idle.
        if (ui.case === 'idle') await page.setViewportSize({ width: 900, height: 700 });
      }
      // The shortcut hint follows the host platform: "(Ctrl+S)" on Windows, "(⌘S)" on macOS.
      const save = (await ui.t('regionScreenshot.save')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await page.getByRole('button', { name: new RegExp(`^${save} \\((Ctrl\\+|⌘)S\\)$`) }).click();
      await page.waitForFunction(() => window.captureQa.exportedHeight > 240);
      assert.ok(await page.evaluate(() => window.captureQa.annotationPixels > 0), 'independent editor annotations are included in the full-resolution export');
    } else {
      await (await button('regionScreenshot.save')).waitFor();
      await (await button('regionScreenshot.save')).click();
      assert.equal(await page.evaluate(() => window.captureQa.saved), null, 'cancelling the save dialog retains playback');
      await (await button('regionScreenshot.copy')).click();
      await page.getByRole('alert').filter({ hasText: await ui.t('regionScreenshot.live.copyFailed') }).waitFor();
      assert.equal(await page.evaluate(() => window.captureQa.closed), false, 'failed copy keeps playback available');
      await (await button('regionScreenshot.copy')).click();
      await page.waitForFunction(() => window.captureQa.copied);
      await page.getByRole('status').filter({ hasText: await ui.t('regionScreenshot.live.copied') }).waitFor();
      if (ui.case === 'video') {
        await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
        assert.ok(await page.locator('video').evaluate(video => Number.isFinite(video.duration) && video.duration > 0), 'finished WebM has a usable timeline');
        const initial = await page.locator('video').evaluate(video => ({ time: video.currentTime, duration: video.duration, paused: video.paused }));
        assert.equal(initial.time, 0, 'new playback starts at zero');
        assert.equal(initial.paused, true, 'preview does not advance before Play');
        assert.ok(Math.abs(initial.duration * 1000 - sampledDuration) < 750, 'duration excludes countdown and paused time');
        await page.locator('video').evaluate(video => video.play());
        await page.waitForFunction(() => document.querySelector('video').currentTime > 0);
        await page.locator('video').evaluate(video => { video.pause(); video.currentTime = video.duration / 2; });
        await page.waitForFunction(() => { const video = document.querySelector('video'); return !video.seeking && Math.abs(video.currentTime - video.duration / 2) < 0.05; });
        await page.locator('video').evaluate(video => { video.currentTime = 0; });
        await page.waitForFunction(() => { const video = document.querySelector('video'); return !video.seeking && video.currentTime === 0; });
        // User feedback: fullscreen did nothing, and Esc must not discard the clip.
        // Browser coverage checks exit behavior; native window entry is verified in Electron.
        await page.locator('video').evaluate(video => video.requestFullscreen());
        await page.waitForFunction(() => document.fullscreenElement === document.querySelector('video'));
        await ui.capture('fullscreen-playback');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.fullscreenElement);
        assert.equal(await page.evaluate(() => window.captureQa.closed), false, 'Esc exits fullscreen without closing playback');
      } else {
        await page.waitForFunction(() => document.querySelector('img')?.naturalWidth > 0);
        await (await button('regionScreenshot.live.replay')).click();
      }
      await ui.capture('independent-playback');
      await (await button('regionScreenshot.save')).click();
      await page.waitForFunction(() => window.captureQa.saved?.length > 0);
      const clip = await page.evaluate(() => ({ saved: Array.from(window.captureQa.saved), format: window.captureQa.format }));
      // Decode the saved bytes with a fresh image/video element and Blob URL,
      // independently of the preview's URL, element and decoded state. Electron
      // contexts cannot create browser tabs through Target.createTarget.
      const decoded = await page.evaluate(async ({ saved, format }) => {
        saved = new Uint8Array(saved);
        const url = URL.createObjectURL(new Blob([saved], { type: format === 'gif' ? 'image/gif' : 'video/webm' }));
        try {
          if (format === 'gif') {
            const image = new Image(); image.src = url; await image.decode();
            return { width: image.naturalWidth, height: image.naturalHeight };
          }
          const video = document.createElement('video'); video.muted = true; video.src = url;
          await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; });
          if (!Number.isFinite(video.duration) || video.duration <= 0 || video.currentTime !== 0) throw new Error('Saved video has an invalid timeline');
          const size = { width: video.videoWidth, height: video.videoHeight };
          video.removeAttribute('src'); video.load();
          return size;
        } finally { URL.revokeObjectURL(url); }
      }, clip);
      assert.deepEqual(decoded, { width: 480, height: 240 });
    }
  },
};
