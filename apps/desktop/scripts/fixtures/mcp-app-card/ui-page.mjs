import assert from 'node:assert/strict';

async function enterFullscreen(page) {
  const frame = page.locator('iframe');
  await frame.waitFor({ state: 'attached' });
  await frame.evaluate((element) => {
    window.dispatchEvent(new MessageEvent('message', {
      source: element.contentWindow,
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/host-context-changed',
        params: { displayMode: 'fullscreen' },
      },
    }));
  });
  await page.getByRole('dialog').waitFor();
}

export default {
  name: 'mcp-app-card',
  entry: './mcp-app-card-fixture.tsx',
  viewport: { width: 800, height: 520 },
  real: 'McpAppCard, McpAppController, Button, saved fallback text, theme and translations',
  notCovered: 'Pending approvals, live guest content, teardown, session switching and native macOS pointer hit testing',
  stubs: {
    'src/renderer/lib/makerChatStore': 'export const makerChatStore = { subscribe: () => () => {}, getSnapshot: () => ({}) };',
    'src/renderer/features/device-link/stickySessionOrigin':
      'export const getStickySessionDeviceId = () => undefined;',
    'src/renderer/features/device-link/remoteProjectsStore':
      'export const getSessionDeviceId = () => undefined; export const remoteProjectsStore = { subscribe: () => () => {} };',
  },
  cases: {
    default: { about: 'Failed App retains saved text and offers retry' },
    fullscreen: { about: 'macOS fullscreen host dialog clears the draggable title bar' },
  },
  async ready(page) {
    if (await page.evaluate(() => window.__uiPage.ctx.case === 'fullscreen')) {
      await enterFullscreen(page);
    } else {
      await page.getByRole('alert').waitFor();
    }
  },
  async check(page, ui) {
    if (ui.case === 'fullscreen') {
      const dialog = page.getByRole('dialog');
      const exit = dialog.locator('[data-exit-fullscreen]');
      const header = page.locator('[data-plugin-ui-element="header"]');
      const [panelBox, headerBox] = await Promise.all([dialog.boundingBox(), header.boundingBox()]);
      assert.ok(panelBox && headerBox);
      if (ui.platform === 'darwin') {
        assert.ok(panelBox.y >= headerBox.y + headerBox.height, 'Fullscreen dialog overlaps the title bar');
      }
      assert.equal(await exit.evaluate((element) => getComputedStyle(element).getPropertyValue('app-region')), 'no-drag');
      await exit.click();
      await dialog.waitFor({ state: 'hidden' });
      await enterFullscreen(page);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      return;
    }
    assert.equal(await page.locator('iframe').count(), 0);
    const retry = page.getByRole('button', { name: await ui.t('mcpApps.retry'), exact: true });
    await retry.click();
    await page.waitForFunction(() => document.documentElement.dataset.fixtureOpens === '2');
    await page.getByRole('alert').waitFor();
    assert.ok(await page.getByText('Saved result:', { exact: false }).isVisible());
    assert.ok(await retry.isVisible());
  },
};
