import assert from 'node:assert/strict';
export default {
  name: 'model-group-strategies',
  entry: './fixture.tsx',
  viewport: { width: 680, height: 1000 },
  real: 'ModelGroupsSection, StrategyDetails, real queued save client, Select, translations and themes',
  notCovered: 'Real persistence, account quotas, model routing, remote transport or native mobile UI; host replies are isolated fixtures',
  stubs: {
    'src/renderer/hooks/useModelRouteDevices': 'export const useModelRouteDevices = () => ({ devices: [] });',
    'src/renderer/features/model-groups/modelGroupsClient': { partial: 'export const useModelGroupCandidateNames = () => () => ({ connected: true, modelName: "Example", sourceLabel: "Example" });' },
  },
  cases: {
    default: { about: 'Four real model-group strategies with keyboard disclosure, selection, saved scope' },
    narrow: { about: 'Strategy explanations and saved scope at touch width', viewport: { width: 320, height: 1000 } },
  },
  async check(page, ui) {
    await page.locator('[data-model-group-route="fixture-mode"]').click();
    await page.getByTestId('model-group-route-detail').waitFor();
    const details = page.getByRole('button', { name: await ui.t('subscriptionAccounts.strategyHelp.details'), exact: true });
    await details.focus();
    await page.keyboard.press('Enter');
    assert.equal(await details.getAttribute('aria-expanded'), 'true');
    const panel = page.locator(`[id="${await details.getAttribute('aria-controls')}"]`);
    for (const strategy of ['expiring', 'order', 'rotate', 'cheapest']) {
      await panel.getByText(await ui.t(`modelGroups.strategy.${strategy}.hint`), { exact: true }).waitFor();
    }
    assert.equal(await panel.getByRole('heading').count(), 4);
    await ui.capture('explanations');
    await details.focus();
    await page.keyboard.press('Space');
    assert.equal(await details.getAttribute('aria-expanded'), 'false');
    await page.getByRole('combobox', { name: await ui.t('modelGroups.settings.pick'), exact: true }).click();
    await page.getByRole('option', { name: await ui.t('modelGroups.strategy.rotate.title'), exact: true }).click();
    await page.getByRole('status').filter({ hasText: await ui.t('subscriptionAccounts.strategyHelp.saved') }).waitFor();
    await ui.capture('saved');
  },
};
