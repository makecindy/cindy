import assert from 'node:assert/strict';
export default {
  name: 'agent-relocation',
  entry: './agent-relocation-fixture.tsx',
  viewport: { width: 680, height: 340 },
  real: 'SystemCard agent-switch branch and localized native-resume / summary-fallback badges',
  notCovered: 'Actual device transport, Harness startup and native mobile rendering. Uses fixture history.',
  stubs: {
    'src/renderer/features/bots/useRemoteBots': 'export const useRemoteBots = () => [];',
    'src/renderer/features/bots/BotCollaborationCard': 'export const BotTaskCard = () => null; export const BotSessionTaskCard = () => null; export const BotSessionTaskMessageTrace = () => null;',
    'src/renderer/features/learn/LearnStatusCard': 'export const LearnStatusCard = () => null;',
  },
  cases: {
    default: { about: 'Native history resumed on the target computer' },
    fallback: { about: 'Explicit summary fallback', data: { fallback: true } },
    narrow: { about: 'Summary badge at 320px', data: { fallback: true }, viewport: { width: 320, height: 340 } },
  },
  async ready(page) { await page.getByRole('separator').waitFor(); },
  async check(page, ui) {
    const key = ui.data.fallback ? 'fallbackBadge' : 'resumedBadge';
    assert.equal(await page.getByText(await ui.t(`chat.systemCard.agentSwitch.${key}`), { exact: true }).count(), 1);
    await page.getByRole('button').click();
    await page.getByText(ui.data.fallback ? 'Earlier requirements and latest tool outcome.' : 'Native history restored; continue with the current environment.', { exact: true }).waitFor();
    await ui.capture('expanded');
  },
};
