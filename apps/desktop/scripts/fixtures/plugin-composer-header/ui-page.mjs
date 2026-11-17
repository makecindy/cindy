import assert from 'node:assert/strict';
import companion from '../companion-composer/ui-page.mjs';

// Browser tier: measure the real ChatInput mount, not a reconstructed composer.
// Existing toolbar cases cannot detect a misplaced header or an empty layout gap.
export default {
  name: 'plugin-composer-header',
  entry: '../companion-composer/companion-composer-fixture.tsx',
  viewport: { width: 760, height: 480 },
  real: 'ChatInput, GoalIndicator, PlanModeIndicator, PendingQueuePanel, PluginUiProvider, PluginUiSlot, Button, Select, Popover shell and installed-plugin change subscription',
  notCovered: 'Live plugin process, installation, MCP App iframe and real plugin panel body; the popover uses a labelled sample body. Host IPC and installed metadata use scenario data. Slash/at panels are not rendered; their original sibling anchor is unchanged.',
  stubs: { ...companion.stubs,
    'src/renderer/hooks/useAgentCapabilities': { partial: 'export const useAgentCapabilities = () => ({ capabilities: { planMode: { supported: true } }, loading: false });' },
    'src/renderer/cindy-brain/PluginUiView': 'export const PluginUiView = () => <div data-header-view>验收样本，非产品界面</div>;',
  },
  cases: {
    empty: { about: 'No contribution leaves the input layout unchanged' },
    nonmatching: { about: 'Filtered contributions leave no header or layout gap', data: { pluginHeader: true, headerNoMatch: true } },
    hidden: { about: 'Runtime-hidden controls release the entire header row', data: { pluginHeader: true, pluginHidden: true } },
    default: { about: 'Native controls occupy the full-width lane above the input card', data: { pluginHeader: true } },
    narrow: { about: 'Header controls remain usable in a narrow window', viewport: { width: 320, height: 480 }, data: { pluginHeader: true } },
    long: { about: 'Long controls and many contributions share one scrolling line', data: { pluginHeader: true, headerLong: true } },
    stacked: { about: 'Long header coexists with real goal, plan and merged queue components', viewport: { width: 760, height: 620 }, data: { pluginHeader: true, headerLong: true, headerStack: true } },
    'stacked-narrow': { about: 'Goal, plan, merged queue and long scrolling header at 320px', viewport: { width: 320, height: 620 }, data: { pluginHeader: true, headerLong: true, headerStack: true } },
  },
  async ready(page) { await page.locator('[contenteditable="true"]').waitFor(); },
  async check(page, ui) {
    const header = page.locator('[data-plugin-composer-header]');
    const root = page.locator('[data-chat-input-root]');
    if (!ui.data.pluginHeader || ui.data.headerNoMatch || ui.data.pluginHidden) {
      if (ui.data.pluginHidden) await header.waitFor({ state: 'hidden' });
      else assert.equal(await header.count(), 0);
      const empty = await root.boundingBox();
      const card = await root.locator(':scope > div').last().boundingBox();
      assert.ok(empty && card);
      assert.equal(empty.height, card.height);
      return;
    }
    const lane = await header.boundingBox();
    const input = await root.locator(':scope > div').last().boundingBox();
    assert.ok(lane && input && lane.y + lane.height <= input.y);
    assert.equal(lane.width, input.width);
    assert.ok(lane.height <= 32, `header must stay one line, got ${lane.height}px`);
    await page.getByText(/^Ready/).waitFor();
    await page.getByRole('button', { name: /^Refresh/ }).click();
    await page.waitForFunction(() => window.__pluginActions.includes('refresh'));
    await page.getByRole('combobox', { name: 'Scope' }).click();
    await page.getByRole('option', { name: 'All', exact: true }).click();
    await page.waitForFunction(() => window.__pluginActions.includes('scope'));
    if (ui.data.headerLong) {
      const controls = header;
      assert.ok(await controls.evaluate(node => node.scrollWidth > node.clientWidth));
      const longLabels = header.locator('.truncate');
      assert.ok(await longLabels.evaluateAll(nodes => nodes.filter(node => node.scrollWidth > node.clientWidth).length >= 2));
      await page.getByRole('button', { name: 'Extra 5', exact: true }).focus();
      await page.getByRole('button', { name: 'Extra 5', exact: true }).click();
      await page.waitForFunction(() => window.__pluginActions.includes('extra-4'));
      await page.getByRole('button', { name: 'Open panel', exact: true }).click();
      const popup = page.locator('[data-header-view]');
      await popup.waitFor();
      const panel = await popup.boundingBox();
      assert.ok(panel && panel.y < lane.y && panel.height > lane.height / 2);
      await ui.capture('popover');
      await page.keyboard.press('Escape');
      await popup.waitFor({ state: 'detached' });
      await controls.evaluate(node => { node.scrollLeft = 0; });
    }
    if (ui.data.headerStack) {
      await page.getByText('验收目标', { exact: true }).waitFor();
      await page.getByText(await ui.t('planMode.indicator.title'), { exact: true }).waitFor();
      await page.getByText('验收排队消息', { exact: true }).waitFor();
      const goal = await page.locator('[data-header-goal]').boundingBox();
      assert.ok(goal && goal.y + goal.height <= lane.y);
    }
    await ui.capture('controls');
    const ghosts = await page.evaluate(() => window.electronAPI.ghosts.listSync().ghosts);
    await page.evaluate(() => window.__uiPage.emit('ghosts', { ghosts: [] }));
    await header.waitFor({ state: 'detached' });
    const empty = await root.boundingBox();
    const card = await root.locator(':scope > div').last().boundingBox();
    assert.ok(empty && card);
    if (!ui.data.headerStack) assert.equal(empty.height, card.height);
    await page.evaluate(ghosts => window.__uiPage.emit('ghosts', { ghosts }), ghosts);
    await header.waitFor();
  },
};
