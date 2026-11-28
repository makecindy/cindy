import assert from 'node:assert/strict';

export default {
  name: 'context-capacity',
  entry: './context-capacity-fixture.tsx',
  viewport: { width: 560, height: 650 },
  real: 'PluginEngineUsageChip, QuotaHoverCard, ContextCapacityRing, ContextWindowBudgetChip and their real popovers',
  notCovered: 'Real model settings, remote writes and compaction. Uses fixture host data.',
  stubs: {
    'src/renderer/lib/modelDefinitions': 'export const getModelsForVendor = () => [];',
  },
  cases: {
    'remote-task-quota': { about: 'Remote task bound to the second account, original account paused', data: { usage: 'remote' } },
    'plugin-quotas': { about: 'ACP account quotas beside its reported context window', data: { usage: 'quotas' }, viewport: { width: 320, height: 420 } },
    'plugin-balance': { about: 'Zero available balance', data: { usage: 'balance' } },
    'plugin-missing': { about: 'Engine provides neither account nor context data', data: { usage: 'missing' } },
    default: { about: 'One ring opens usage, manual compaction and window choices' },
    high: { about: 'Context nearly full', data: { high: true } },
    codex: { about: 'Native Codex details above window choices', data: { codex: true } },
    narrow: {
      about: 'Read-only task at 320px',
      data: { readOnly: true },
      viewport: { width: 320, height: 650 },
    },
    'narrow-editable': {
      about: 'Window controls and model settings at 320px',
      viewport: { width: 320, height: 650 },
    },
    unknown: {
      about: 'Missing route data keeps the ring and usage details',
      data: { unknown: true },
    },
  },
  async ready(page) {
    await page.getByTestId('context-footer').waitFor();
  },
  async check(page, ui) {
    if (ui.data.usage) {
      const footer = page.getByTestId('context-footer');
      assert.equal(await footer.locator('[data-context-window-budget-chip]').count(), 0);
      if (ui.data.usage === 'missing') {
        assert.equal(await footer.innerText(), '—');
        return;
      }
      const trigger = footer.getByRole('button');
      await trigger.waitFor();
      assert.match(await footer.innerText(), /12%/);
      if (ui.data.usage === 'remote') {
        assert.match(await trigger.innerText(), /98%/);
        await ui.capture('entry', { locator: footer });
        await trigger.click();
        const card = page.getByTestId('quota-hover-card');
        await card.waitFor();
        assert.match(await card.innerText(), /98%/);
        await ui.capture('details', { locator: card });
        return;
      }
      assert.match(await trigger.innerText(), ui.data.usage === 'balance' ? /CNY\s*0[.,]00/ : /(?:6天|6d)[\s\S]*0%/);
      await ui.capture('entry', { locator: footer });
      if (ui.data.usage === 'balance') {
        await page.keyboard.press('Tab');
        assert.ok(await trigger.evaluate(button => button.matches(':focus-visible') && getComputedStyle(button).boxShadow !== 'none'));
        await page.keyboard.press('Enter');
      } else {
        await trigger.hover();
      }
      const card = page.getByTestId('quota-hover-card');
      await card.waitFor();
      if (ui.data.usage === 'quotas') {
        assert.match(await card.innerText(), /Gemini/);
        assert.match(await card.innerText(), /Archive/);
        assert.doesNotMatch(await card.innerText(), /91%/);
      }
      await ui.capture('details', { locator: card });
      return;
    }
    const ring = page.locator('[data-context-window-budget-chip]');
    assert.equal(await ring.textContent(), ui.data.high ? '92%' : '12%');
    assert.equal(await page.getByRole('radiogroup').count(), 0);
    await ui.capture('entry', { locator: page.locator('[data-testid="context-footer"]') });
    // Hover must allow moving into the same card to reach its options.
    await ring.hover();
    const card = page.getByRole('dialog');
    await card.waitFor();
    await card.hover();
    await ui.capture('details', { locator: card });
    if (ui.case === 'codex') {
      const technical = card.locator('details:not([data-context-window-options]) > summary');
      await technical.click();
      await ui.capture('native-details', { locator: card });
      await technical.click();
    }
    if (ui.case === 'unknown') {
      assert.equal(await page.getByRole('radiogroup').count(), 0);
    } else {
      await page.locator('[data-context-window-options] > summary').click();
      const rows = page.getByRole('radio');
      assert.equal(await rows.count(), 3);
      if (ui.case === 'narrow') assert.equal(await rows.first().isDisabled(), true);
    }
    await ui.capture('expanded', { locator: card });
    const box = await card.boundingBox();
    const height = await page.evaluate(() => window.innerHeight);
    assert.ok(box && box.y >= -1 && box.y + box.height <= height + 1,
      `Expanded controls stay within the viewport: ${JSON.stringify(box)} / ${height}`);
    // Keyboard entry and dismissal work without triggering compaction or a budget write.
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'hidden' });
    await ring.focus();
    await page.keyboard.press('Enter');
    await card.waitFor();
    await page.keyboard.press('Escape');
    await card.waitFor({ state: 'hidden' });
  },
};
