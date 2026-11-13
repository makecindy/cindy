import assert from 'node:assert/strict';

export default {
  name: 'chat-video',
  entry: './chat-video-fixture.tsx',
  viewport: { width: 800, height: 600 },
  real: 'ChatVideoView, native playback controls, real WebM decoding, retry, light/dark themes and five languages',
  notCovered:
    'Electron fullscreen permission and OS transitions require the full Desktop sandbox; clipboard/folder APIs are fakes and local protocol bytes are supplied by the fixture.',
  cases: {
    default: {
      about: 'Inline player retains the original native playback and fullscreen controls',
    },
    error: {
      about:
        'Media errors show an unavailable state and a working Retry action, without claiming the file was deleted',
    },
    'menu-inline': {
      about: 'Local video context menu stays visible and clickable above native fullscreen',
    },
    'menu-lightbox': {
      about: 'Lightbox uses the same fullscreen menu and keeps focus inside the player',
    },
  },
  async ready(page) {
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
  },
  async check(page, ui) {
    if (ui.case.startsWith('menu-')) {
      // Playwright evaluation carries a user gesture; use the real Fullscreen API.
      await page.locator('video').evaluate((video) => video.requestFullscreen());
      await page.waitForFunction(() => document.fullscreenElement?.tagName === 'VIDEO');
      await page.locator('video').click({ button: 'right', position: { x: 250, y: 150 } });
      const menu = page.getByRole('menu');
      await menu.waitFor({ state: 'visible' });
      await ui.capture('fullscreen-menu');
      const hit = await menu.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { open: el.closest('dialog')?.matches(':modal'), contains: el.contains(target) };
      });
      assert.ok(hit.open && hit.contains, JSON.stringify(hit));
      await page
        .getByRole('menuitem', { name: await ui.t('chat.media.copyVideo'), exact: true })
        .click();
      await page.waitForFunction(
        () => document.body.dataset.videoMenuAction === 'copy' && !document.querySelector('dialog'),
      );
      assert.ok(await page.evaluate(() => document.fullscreenElement?.tagName === 'VIDEO'));
      await page.waitForFunction(() => document.activeElement?.tagName === 'VIDEO');
      await page.locator('video').click({ button: 'right', position: { x: 250, y: 150 } });
      await menu.waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('dialog'));
      assert.ok(await page.locator('video').evaluate(video => getComputedStyle(video.parentElement).opacity !== '0'));
      assert.ok(await page.evaluate(() => !document.body.dataset.videoLightboxClosed));
      if (!await page.evaluate(() => Boolean(document.fullscreenElement))) {
        await page.locator('video').evaluate(video => video.requestFullscreen());
      }
      await page.locator('video').click({ button: 'right', position: { x: 250, y: 150 } });
      await menu.waitFor({ state: 'visible' });
      await page.mouse.click(40, 40);
      await page.waitForFunction(() => !document.querySelector('dialog'));
      await page.locator('video').click({ button: 'right', position: { x: 250, y: 150 } });
      await menu.waitFor({ state: 'visible' });
      await page.evaluate(() => document.exitFullscreen());
      await page.waitForFunction(
        () => !document.fullscreenElement && !document.querySelector('dialog'),
      );
      await page.locator('video').click({ button: 'right' });
      await page
        .getByRole('menuitem', { name: await ui.t('chat.media.revealVideo'), exact: true })
        .click();
      await page.waitForFunction(() => document.body.dataset.videoMenuAction === 'reveal');
      return;
    }
    if (ui.case === 'error') {
      await page.locator('video').evaluate((video) => video.dispatchEvent(new Event('error')));
      assert.ok(
        await page
          .getByText(await ui.t('chat.media.videoUnavailable'), { exact: true })
          .isVisible(),
      );
      await ui.capture('unavailable');
      await page
        .getByRole('button', { name: await ui.t('chat.errorBanner.retry'), exact: true })
        .click();
      await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
      return;
    }
    assert.ok(await page.locator('video').evaluate((video) => video.controls));
  },
};
