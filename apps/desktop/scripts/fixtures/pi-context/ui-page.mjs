import assert from 'node:assert/strict';

export default {
  name: 'pi-context',
  entry: './pi-context-fixture.tsx',
  viewport: { width: 560, height: 740 },
  real: 'SystemCard context panel and shared localized text estimates',
  notCovered: 'Native RPC and model behavior; synthetic diagnostic payload',
  stubs: {
    'src/renderer/features/bots/useRemoteBots': 'export const useRemoteBots = () => [];',
    'src/renderer/features/bots/BotCollaborationCard': 'export const BotTaskCard = () => null; export const BotSessionTaskCard = () => null; export const BotSessionTaskMessageTrace = () => null;',
    'src/renderer/features/learn/LearnStatusCard': 'export const LearnStatusCard = () => null;',
  },
  cases: {
    default: { about: 'Native total separated from estimated sources' },
    narrow: { about: 'Context sources at 320px', viewport: { width: 320, height: 860 } },
    legacy: { about: 'Older payload without diagnostics', data: { legacy: true } },
  },
  async ready(page) { await page.getByRole('button').first().waitFor(); },
  async check(page, ui) {
    await page.getByRole('button').first().click();
    await page.getByText('pi-context-demo', { exact: false }).waitFor();
    const title = await ui.t('chat.systemCard.context.estimate.title');
    assert.equal(await page.getByText(title, { exact: true }).count(), ui.data.legacy ? 0 : 1);
    if (!ui.data.legacy) await page.getByText('≈ 2,860 tokens', { exact: true }).waitFor();
    await ui.capture('expanded');
  },
};
