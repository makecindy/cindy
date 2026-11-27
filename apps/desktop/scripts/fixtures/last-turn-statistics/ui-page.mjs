import assert from 'node:assert/strict';
export default {
  name: 'last-turn-statistics', entry: './fixture.tsx',
  viewport: { width: 720, height: 420 },
  real: 'LastTurnStatisticsCell, RunningStatusBar, persisted turn projection, UsageCostPopover and TurnGenerationTrace',
  notCovered: 'Real model execution, transport, database persistence and the full session view',
  stubs: {
    'src/renderer/components/chat/GhostToolCard': 'export const GhostToolCard = () => null; export const MailCardEditor = () => null; export const CARD_EXPAND_TOGGLE_EVENT = "xdt-card-expand-toggle";',
    'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => "";',
  },
  cases: {
    default: { about: 'Opt-in summary survives switching back, opens the saved speed trace and hides for a new run' },
    'no-trace': { about: 'Older saved turns retain their figures without inventing a speed curve' },
  },
  async check(page, ui) {
    const summary = page.locator('[data-last-turn-statistics]');
    assert.equal(await summary.count(), 0, 'The setting defaults off');
    assert.equal(await page.getByRole('switch').count(), 0, 'Advanced settings start collapsed');
    await page.locator('summary').click();
    await page.getByRole('switch').click();
    await summary.waitFor();
    const text = await summary.innerText();
    assert.ok(text.includes('1.2k'), 'Summary uses output, not input/total tokens');
    assert.ok(!text.includes('91.2k'));
    assert.equal(await page.locator('[data-running-status-label]').count(), 0, 'Idle summary is not a running label');
    await ui.capture('summary');
    await page.getByRole('button', { name: 'Switch task', exact: true }).click();
    assert.equal(await summary.count(), 0);
    await page.getByRole('button', { name: 'Switch task', exact: true }).click();
    await summary.waitFor();
    assert.equal(await summary.innerText(), text, 'Elapsed duration is a static saved value');
    await summary.getByRole('button').click();
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByTestId('turn-generation-trace').count(), ui.case === 'no-trace' ? 0 : 1);
    await ui.capture('details');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Toggle run', exact: true }).click();
    assert.equal(await summary.count(), 0, 'A new run cannot retain the old curve');
    await page.getByRole('button', { name: 'Toggle run', exact: true }).click();
    await summary.waitFor();
    await page.getByRole('switch').click();
    assert.equal(await summary.count(), 0, 'Disabling restores the original idle behavior');
  },
};
