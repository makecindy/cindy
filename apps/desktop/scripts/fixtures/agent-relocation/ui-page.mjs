import assert from 'node:assert/strict';
export default {
  name: 'agent-relocation',
  entry: './agent-relocation-fixture.tsx',
  viewport: { width: 680, height: 340 },
  real: 'SystemCard switch and rebuild dividers, including legacy and current handoff labels',
  notCovered: 'Actual device transport, Harness startup and native mobile rendering. Uses fixture history.',
  stubs: {
    'src/renderer/features/bots/useRemoteBots': 'export const useRemoteBots = () => [];',
    'src/renderer/features/bots/BotCollaborationCard': 'export const BotTaskCard = () => null; export const BotSessionTaskCard = () => null; export const BotSessionTaskMessageTrace = () => null;',
    'src/renderer/features/learn/LearnStatusCard': 'export const LearnStatusCard = () => null;',
  },
  cases: {
    default: { about: 'Native history resumed on the target computer' },
    fallback: { about: 'Explicit summary fallback', data: { fallback: true } },
    complete: { about: 'Both dividers show complete carryover; it supersedes the legacy fallback badge', data: { fallback: true, coverage: 'complete' } },
    narrow: { about: 'Both dividers show condensed carryover at 320px', data: { fallback: true, coverage: 'condensed' }, viewport: { width: 320, height: 340 } },
  },
  async ready(page) { await page.getByRole('separator').first().waitFor(); },
  async check(page, ui) {
    const key = ui.data.fallback ? 'fallbackBadge' : 'resumedBadge';
    const legacyBadge = await ui.t(`chat.systemCard.agentSwitch.${key}`);
    assert.equal(await page.getByText(legacyBadge, { exact: true }).count(), ui.data.coverage ? 0 : 1);
    if (ui.data.coverage) {
      const coverage = await ui.t(`chat.systemCard.handoffCoverage.${ui.data.coverage}`);
      assert.equal(await page.getByText(coverage, { exact: true }).count(), 2);
    }
    await page.getByRole('button').first().click();
    await page.getByText(ui.data.fallback ? 'Earlier requirements and latest tool outcome.' : 'Native history restored; continue with the current environment.', { exact: true }).waitFor();
    await ui.capture('expanded');
  },
};
