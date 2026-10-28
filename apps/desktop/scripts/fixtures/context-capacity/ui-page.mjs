import assert from 'node:assert/strict';

export default {
  name: 'context-capacity',
  entry: './context-capacity-fixture.tsx',
  viewport: { width: 560, height: 650 },
  real: 'ContextCapacityRing, ContextWindowBudgetChip, real Popover and context/pricing hooks',
  notCovered: 'Real model settings, remote writes and compaction. Uses fixture host data.',
  stubs: {
    'src/renderer/lib/modelDefinitions': 'export const getModelsForVendor = () => [];',
  },
  cases: {
    hud: { about: 'HUD compactable context bar', data: { hud: true } },
    'hud-codex': { about: 'HUD read-only native context bar', data: { hud: true, codex: true } },
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
    await page.locator('[data-context-window-budget-chip], .hud-context-bar').waitFor();
  },
  async check(page, ui) {
    if (ui.data.hud) {
      const bar = page.locator('.hud-context-bar');
      const footer = page.getByTestId('context-footer');
      const barBox = await bar.boundingBox();
      const footerBox = await footer.boundingBox();
      assert.ok(barBox && footerBox && Math.abs(barBox.width - footerBox.width) <= 1);
      assert.equal(await page.locator('[data-context-window-budget-chip]').count(), 0);
      if (ui.data.codex) {
        assert.equal(await bar.getAttribute('role'), 'meter');
        assert.equal(await bar.getAttribute('aria-valuenow'), '12');
      }
      await ui.capture('hud-bar', { locator: footer });
      await bar.hover();
      const tooltip = page.getByRole('tooltip');
      await tooltip.waitFor();
      assert.ok((await tooltip.innerText()).includes('12%'));
      await ui.capture('hud-details');
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
