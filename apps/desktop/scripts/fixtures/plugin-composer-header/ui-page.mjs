import assert from 'node:assert/strict';
import companion from '../companion-composer/ui-page.mjs';

// Browser tier: measure the real ChatInput mount, not a reconstructed composer.
// Existing toolbar cases cannot detect a misplaced header or an empty layout gap.
export default {
  name: 'plugin-composer-header',
  entry: '../companion-composer/companion-composer-fixture.tsx',
  viewport: { width: 760, height: 480 },
  real: 'ChatInput, PluginUiProvider, PluginUiSlot, Button, Select, installed-plugin change subscription',
  notCovered: 'Live plugin process, installation and MCP App iframe; popover lifecycle and approval projection use unit tests. Host IPC and installed metadata use scenario data.',
  stubs: companion.stubs,
  cases: {
    empty: { about: 'No contribution leaves the input layout unchanged' },
    default: { about: 'Native controls occupy the full-width lane above the input card', data: { pluginHeader: true } },
    narrow: { about: 'Header controls remain usable in a narrow window', viewport: { width: 320, height: 480 }, data: { pluginHeader: true } },
  },
  async ready(page) { await page.locator('[contenteditable="true"]').waitFor(); },
  async check(page, ui) {
    const header = page.locator('[data-plugin-composer-header]');
    const root = page.locator('[data-chat-input-root]');
    if (!ui.data.pluginHeader) {
      assert.equal(await header.count(), 0);
      return;
    }
    const lane = await header.boundingBox();
    const input = await root.locator(':scope > div').last().boundingBox();
    assert.ok(lane && input && lane.y + lane.height <= input.y);
    assert.equal(lane.width, input.width);
    await page.getByText('Ready', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.waitForFunction(() => window.__pluginActions.includes('refresh'));
    await page.getByRole('combobox', { name: 'Scope' }).click();
    await page.getByRole('option', { name: 'All', exact: true }).click();
    await page.waitForFunction(() => window.__pluginActions.includes('scope'));
    await ui.capture('controls');
    const ghosts = await page.evaluate(() => window.electronAPI.ghosts.listSync().ghosts);
    await page.evaluate(() => window.__uiPage.emit('ghosts', { ghosts: [] }));
    await header.waitFor({ state: 'detached' });
    const empty = await root.boundingBox();
    const card = await root.locator(':scope > div').last().boundingBox();
    assert.ok(empty && card);
    assert.equal(empty.height, card.height);
    await page.evaluate(ghosts => window.__uiPage.emit('ghosts', { ghosts }), ghosts);
    await header.waitFor();
  },
};
