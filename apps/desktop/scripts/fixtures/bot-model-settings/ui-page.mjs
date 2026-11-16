import assert from 'node:assert/strict';

export default {
  name: 'bot-model-settings',
  entry: './fixture.tsx',
  viewport: { width: 440, height: 880 },
  real: 'BotModelChainEditor, ModelRouteSelector, ModelSelector, themes and all translations',
  notCovered: 'Live catalog discovery, remote devices, persistence and model execution; fixture supplies providers and local component state',
  stubs: {
    'src/renderer/hooks/useModelRouteDevices': `export const useModelRouteDevices = ({ leadAgentDeviceId }) => ({
      devices: JSON.parse(document.getElementById('ui-page-context').textContent).case === 'loading-remote-favorite' ? [{ deviceId: 'fixture-device', name: 'Other computer' }]
        : leadAgentDeviceId ? [{ deviceId: leadAgentDeviceId, name: 'Shared models' }] : undefined,
      leadAgentDeviceId: leadAgentDeviceId ?? null,
    });`,
  },
  cases: {
    default: { about: 'Unavailable primary and backup; status belongs to the model' },
    available: { about: 'Long available name with reasoning effort; no unavailable status on this model' },
    loading: { about: '#10207: local first snapshot pending, then ready while the saved model picker stays open' },
    'loading-remote-favorite': { about: '#10207 review: ready other-computer favorite remains selectable while local catalog is pending' },
    'four-backups': { about: 'Four visible backups with unbroken IDs and working reorder/remove controls' },
    'global-settings': { about: 'Global settings row uses the same wrapped picker' },
    'shared-only': { about: 'Shared-only Gemini/Terra labels resolve in primary and backup triggers' },
    'shared-same-id': { about: 'Shared labels and effort never fall back to a same-ID local model' },
  },
  async ready(page) {
    await page.locator('[data-model-settings-fixture]').waitFor();
    if (page.url().includes('shared-')) {
      await page.locator('[data-model-settings-fixture] button[aria-haspopup="listbox"]').first()
        .getByText('Shared Gemini', { exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector('[data-model-settings-fixture] button .animate-spinner'));
    }
  },
  async check(page, ui) {
    const pickers = page.locator('[data-model-settings-fixture] button[aria-haspopup="listbox"]');
    if (ui.case === 'loading-remote-favorite') {
      await pickers.first().click();
      const list = page.getByRole('listbox');
      await list.getByText('Shared Gemini', { exact: true }).waitFor();
      assert.equal(await list.getByRole('status').count(), 0);
      await ui.capture('ready-favorite-local-pending');
      await page.locator('[data-rail-item="favorites"]').click();
      await list.getByText('Shared Gemini', { exact: true }).click();
      await pickers.first().getByText('Shared Gemini', { exact: true }).waitFor();
      await ui.capture('selected-remote-favorite');
      return;
    }
    if (ui.case === 'loading') {
      await pickers.first().click();
      const list = page.getByRole('listbox');
      await list.getByRole('status').getByText(await ui.t('newChat.modelSelector.trigger.loading'), { exact: true }).waitFor();
      await ui.capture('pending');
      await page.evaluate(() => window.dispatchEvent(new Event('fixture:catalog-ready')));
      await list.getByRole('option').first().waitFor();
      assert.equal(await list.getByRole('status').count(), 0);
      await ui.capture('ready');
      return;
    }
    const expected = ui.case === 'four-backups' ? 5 : 2;
    const clipped = await pickers.evaluateAll(buttons => buttons.flatMap(button =>
      [...button.querySelectorAll('span')].filter(span => span.textContent?.trim() &&
        (span.scrollWidth > span.clientWidth + 1 || span.scrollHeight > span.clientHeight + 1))
        .map(span => span.textContent)));
    assert.deepEqual(clipped, [], 'Model text must fit without ellipsis or clipping');
    assert.equal(await pickers.count(), expected, 'Backups are immediately visible');
    if (ui.case === 'default') {
      await pickers.first().click();
      const panel = page.locator('[data-radix-popper-content-wrapper] > *').first();
      await panel.waitFor();
      assert.ok(await panel.evaluate((el) => getComputedStyle(el).boxShadow.includes('16px')), 'Field panel carries --shadow-menu');
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'hidden' });
    }
    const status = await ui.t('settings.auxiliaryModels.unavailable');
    if (ui.case.startsWith('shared-')) {
      for (let index = 0; index < 2; index++) {
        const picker = pickers.nth(index);
        assert.equal(await picker.getByText(status, { exact: true }).count(), 0);
        assert.equal(await picker.locator('svg.lucide-circle-alert').count(), 0, 'Shared catalog capabilities load successfully');
        assert.ok(await picker.getByText(index === 1 ? 'Shared Terra' : 'Shared Gemini', { exact: true }).isVisible());
        assert.ok(!(await picker.textContent()).includes('Local Shared'));
      }
    } else if (ui.case === 'available') {
      assert.equal(await pickers.first().getByText(status, { exact: true }).count(), 0);
      assert.ok(await pickers.first().getByText('Gemini with a very long model display name', { exact: true }).isVisible());
    } else {
      const first = pickers.first();
      assert.equal(await first.getByText(status, { exact: true }).count(), 1);
      const modelBox = await first.getByText('google/gemini-4-argon', { exact: true }).boundingBox();
      const statusBox = await first.getByText(status, { exact: true }).boundingBox();
      assert.ok(statusBox && modelBox && statusBox.y > modelBox.y, 'Status appears below model name');
    }
    if (ui.case === 'four-backups') {
      const add = page.getByRole('button', { name: await ui.t('bots.modelChain.add'), exact: true });
      assert.equal(await add.isDisabled(), true);
      await page.getByRole('button', { name: await ui.t('bots.modelChain.remove'), exact: true }).first().click();
      assert.equal(await pickers.count(), 4);
      assert.equal(await add.isEnabled(), true);
    }
  },
};
