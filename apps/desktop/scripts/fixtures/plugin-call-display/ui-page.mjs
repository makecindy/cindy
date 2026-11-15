import assert from 'node:assert/strict';

export default {
  name: 'plugin-call-display',
  entry: './plugin-call-display-fixture.tsx',
  viewport: { width: 720, height: 640 },
  real: 'MessageStream, UserMessage, GhostSummonCard, work log, plugin tool rows, theme and translations',
  notCovered:
    'Real plugin execution, login, IPC transport and native mobile; history and tool results are fixture data.',
  stubs: {
    'src/renderer/components/chat/GhostToolCard':
      'export const GhostToolCard = () => null; export const MailCardEditor = () => null; export const CARD_EXPAND_TOGGLE_EVENT = "xdt-card-expand-toggle";',
    'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => "";',
    'src/renderer/contexts/AuthContext': {
      partial: 'export const useAuth = () => ({ dataOwnerId: "fixture", isAuthenticated: false });',
    },
  },
  cases: {
    default: {
      about:
        'Autonomous plugin call never relabels user text; real result settles while assistant continues',
    },
    explicit: {
      about:
        'Explicit plugin selection remains selected during execution, later turns and history reload',
    },
    mention: {
      about: 'Historical mention remains a quiet pill rather than upgrading to execution status',
    },
  },
  async check(page, ui) {
    // Real renderer regression: one user message + one ghost_call used to add
    // a whole-turn running label. Exercise result arrival, next turn and reload.
    const user = page.locator('[data-message-client-id="ask"]');
    await user.waitFor();
    const selected = await ui.t('chat.ghostSummon.status.selected');
    const calling = await ui.t('chat.ghostSummon.status.running');
    const assertSelection = async () => {
      assert.equal(await user.getByText(calling, { exact: true }).count(), 0);
      if (ui.case === 'explicit') {
        assert.equal(await user.getByText(selected, { exact: true }).count(), 1);
      } else if (ui.case === 'default') {
        assert.equal(await user.getByText('XD Feishu', { exact: true }).count(), 0);
      } else {
        assert.equal(
          await user
            .getByText(await ui.t('chat.ghostSummon.mention', { names: 'XD Feishu' }), {
              exact: true,
            })
            .count(),
          1,
        );
      }
    };
    await assertSelection();
    await page
      .getByRole('img', { name: await ui.t('chat.agentActionRow.status.running'), exact: true })
      .first()
      .waitFor();
    await ui.capture('plugin-running');
    await page.getByTestId('finish-call').click();
    await page.getByText('方案已读取，继续整理实现。', { exact: true }).waitFor();
    await assertSelection();
    await page.locator('[data-scroll-disclosure-header][aria-expanded="false"]').first().click();
    await page
      .getByRole('img', { name: await ui.t('chat.agentActionRow.status.done'), exact: true })
      .first()
      .waitFor();
    assert.equal(
      await page
        .getByRole('img', { name: await ui.t('chat.agentActionRow.status.running'), exact: true })
        .count(),
      0,
    );
    await ui.capture('result-returned-assistant-running');
    await page.getByTestId('next-turn').click();
    const next = page.locator('[data-message-client-id="next"]');
    await next.waitFor();
    assert.equal(await next.getByText('XD Feishu', { exact: true }).count(), 0);
    await assertSelection();
    await page.getByTestId('remount').click();
    await next.waitFor();
    await assertSelection();
    await ui.capture('next-turn-history-reloaded');
  },
};
