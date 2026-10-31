import assert from 'node:assert/strict';

export default {
  name: 'mcp-app-card',
  entry: './mcp-app-card-fixture.tsx',
  viewport: { width: 800, height: 520 },
  real: 'McpAppCard, McpAppController, Button, saved fallback text, theme and translations',
  notCovered: 'Pending page approvals have a separate mcp-app-approval fixture; this card fixture supplies no pending requests. Live cross-origin App, teardown handshake, fullscreen and full Cindy session switching; verified separately from this error-surface screenshot',
  stubs: {
    'src/renderer/lib/makerChatStore': 'export const makerChatStore = { subscribe: () => () => {}, getSnapshot: () => ({}) };',
    'src/renderer/features/device-link/stickySessionOrigin':
      'export const getStickySessionDeviceId = () => undefined;',
    'src/renderer/features/device-link/remoteProjectsStore':
      'export const remoteProjectsStore = { subscribe: () => () => {} };',
  },
  cases: { default: { about: 'Failed App retains saved text and offers retry' } },
  async ready(page) { await page.getByRole('alert').waitFor(); },
  async check(page, ui) {
    assert.equal(await page.locator('iframe').count(), 0);
    const retry = page.getByRole('button', { name: await ui.t('mcpApps.retry'), exact: true });
    await retry.click();
    await page.waitForFunction(() => document.documentElement.dataset.fixtureOpens === '2');
    await page.getByRole('alert').waitFor();
    assert.ok(await page.getByText('Saved result:', { exact: false }).isVisible());
    assert.ok(await retry.isVisible());
  },
};
