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
        'Ordinary GitHub calls get a signature annotation and stop at their actual result',
    },
    explicit: {
      about:
        'Explicit directive activity follows actual calls, not whole-turn activity',
    },
    mention: {
      about: 'Historical mention upgrades only when the owning turn actually calls a plugin',
    },
    multi: { about: 'Original multiple-name row and artwork; finish only when every call has returned' },
    'explicit-multi': { about: 'Explicit A plus actual A/B calls: retain the directive and wait for both results' },
    'mention-multi': { about: 'Mention A plus actual A/B calls: show both names and wait for both results' },
    selection: { about: 'Uncalled explicit selection stays static and never claims execution' },
    interrupted: { about: 'Interrupted calls stop without a completion tick, including after history reload' },
  },
  async check(page, ui) {
    // Exercise actual MessageStream/UserMessage composition, beyond the pure
    // projection/component unit cases: result -> next ordinary turn -> remount.
    const user = page.locator('[data-message-client-id="ask"]');
    await user.waitFor();
    const icon = user.locator('img').first();
    await icon.waitFor();
    await icon.evaluate(image => image.decode());
    assert.equal(await icon.evaluate(image => image.naturalWidth > 0), true);
    const calling = await ui.t('chat.ghostSummon.status.running');
    const called = await ui.t('chat.ghostSummon.status.called');
    if (ui.case === 'selection') {
      const selected = await ui.t('chat.ghostSummon.status.selected');
      assert.equal(await user.getByText(selected, { exact: true }).count(), 1);
      assert.equal(await user.getByText(calling, { exact: true }).count(), 0);
      assert.equal(await user.getByText(called, { exact: true }).count(), 0);
      await page.getByTestId('finish-turn').click();
      await user.getByText(selected, { exact: true }).waitFor();
      assert.equal(await user.locator('.lucide-check').count(), 0);
      await ui.capture('selected-without-call');
      return;
    }
    if (ui.case === 'interrupted') {
      await user.getByText(calling, { exact: true }).waitFor();
      await page.getByTestId('finish-turn').click();
      await user.getByText(called, { exact: true }).waitFor();
      assert.equal(await user.locator('.lucide-check').count(), 0);
      await page.getByTestId('remount').click();
      await user.getByText(called, { exact: true }).waitFor();
      assert.equal(await user.locator('.lucide-check').count(), 0);
      assert.equal(await user.getByText(calling, { exact: true }).count(), 0);
      await ui.capture('interrupted-without-completion-tick');
      return;
    }
    const multi = ['multi', 'explicit-multi', 'mention-multi'].includes(ui.case);
    const names = multi ? 'XD Feishu、GitHub' : ui.case === 'default' ? 'GitHub' : 'XD Feishu';
    assert.equal(await user.getByText(names, { exact: true }).count(), 1);
    assert.equal(await user.locator('.summon-seal-arc').count(), 2);
    assert.equal(await user.getByText(calling, { exact: true }).count(), 1);
    const spin = user.locator('.summon-seal-spin');
    await page.evaluate(() => document.documentElement.setAttribute('data-app-hidden', 'true'));
    assert.equal(await spin.evaluate(el => getComputedStyle(el).animationPlayState), 'paused');
    await page.evaluate(() => document.documentElement.removeAttribute('data-app-hidden'));
    await ui.capture('plugin-running');
    await page.getByTestId('finish-call').click();
    await page.getByText('方案已读取，继续整理实现。', { exact: true }).waitFor();
    if (multi) {
      assert.equal(await user.getByText(calling, { exact: true }).count(), 1);
      assert.equal(await user.getByText(names, { exact: true }).count(), 1);
      assert.equal(await user.locator('.lucide-check').count(), 0);
      await ui.capture('one-plugin-returned-other-running');
      await page.getByTestId('next-turn').click();
    }
    await user.getByText(called, { exact: true }).waitFor();
    assert.equal(await user.getByText(calling, { exact: true }).count(), 0);
    await user.locator('.lucide-check').waitFor();
    await ui.capture('results-returned-assistant-still-working');
    await page.getByTestId('finish-turn').click();
    await user.getByText(called, { exact: true }).waitFor();
    await ui.capture('turn-finished');
    await page.getByTestId('plain-turn').click();
    const next = page.locator('[data-message-client-id="next"]');
    await next.waitFor();
    assert.equal(await next.locator('.summon-seal-arc').count(), 0);
    assert.equal(await user.getByText(called, { exact: true }).count(), 1);
    await page.getByTestId('remount').click();
    await next.waitFor();
    assert.equal(await next.locator('.summon-seal-arc').count(), 0);
    assert.equal(await user.getByText(calling, { exact: true }).count(), 0);
    assert.equal(await user.locator('.lucide-check').count(), 1);
    assert.equal(await user.locator('.summon-seal-halo').count(), 0);
    await ui.capture('next-turn-history-reloaded');
  },
};
