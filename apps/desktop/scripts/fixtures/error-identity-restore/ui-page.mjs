import assert from 'node:assert/strict';

export default {
  name: 'error-identity-restore',
  entry: './fixture.tsx',
  viewport: { width: 780, height: 620 },
  stubs: {
    'src/renderer/components/chat/GhostToolCard':
      'export const GhostToolCard = () => null; export const MailCardEditor = () => null; export const CARD_EXPAND_TOGGLE_EVENT = "xdt-card-expand-toggle";',
    'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => "";',
  },
  real: 'makerChatStore projection restore, light subscription, MessageStream error deduplication, findErrorTailMessage, ErrorTailErrorBanner, ErrorBanner',
  notCovered: 'Full CCAgentSessionView mounting, real database, Host/relay transport, upstream model execution; recovery enqueue and dismissal persistence',
  cases: {
    default: { about: 'Snapshot-only restore with a later system row and an unrelated historical error' },
    narrow: { about: 'Same restore at 320 px', viewport: { width: 320, height: 640 } },
    terminal: { about: '#10744: zero assistant output, reconnect timeout, then a restored-location card', data: { terminal: true } },
    'terminal-dismiss': { about: 'Dismissed timeout stays dismissed across later location records', data: { terminal: true, action: 'dismiss' } },
    'terminal-retry': { about: 'Accepted recovery input retires the old timeout banner', data: { terminal: true, action: 'retry' } },
  },
  async ready(page) {
    await page.getByTestId('tail-error').or(page.getByTestId('restore')).waitFor();
  },
  async check(page, ui) {
    if (ui.data.terminal) {
      const banner = page.getByTestId('tail-error');
      const timeout = await ui.t('logic.errors.upstreamResponseIdleTimeout');
      await banner.getByText(timeout, { exact: true }).waitFor();
      assert.equal(await page.getByText(timeout, { exact: true }).count(), 1, 'the timeout must have one actionable owner');
      assert.equal(await page.locator('[data-message-client-id="location"]').count(), 1);
      await banner.getByRole('button', { name: await ui.t('chat.errorBanner.retry'), exact: true }).waitFor();
      await ui.capture('terminal-error');
      if (ui.data.action) {
        const key = ui.data.action === 'dismiss' ? 'chat.errorBanner.cancelTitle' : 'chat.errorBanner.retry';
        await banner.getByRole('button', { name: await ui.t(key), exact: true }).click();
        await banner.getByText(timeout, { exact: true }).waitFor({ state: 'hidden' });
        await page.getByTestId('boundary').click();
        await banner.getByText(timeout, { exact: true }).waitFor({ state: 'hidden' });
        assert.equal(await banner.getByText(timeout, { exact: true }).count(), 0, 'a later location record must not revive a handled failure');
      }
      await page.getByTestId('progress').click();
      await banner.getByText(timeout, { exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await banner.getByText(timeout, { exact: true }).count(), 0, 'a later answer resolves the banner even before another location record');
      return;
    }
    const current = page.getByText(await ui.t('logic.errors.turnFailed'), { exact: true });
    await current.first().waitFor();
    assert.equal(await current.count(), 1, 'current failure must have one owner');
    assert.equal(await page.locator('[data-message-client-id="error-earlier"]').count(), 1);
    await page.getByTestId('restore').click();
    assert.equal(await current.count(), 1, 'recreated view must retain the row identity');
    const details = page.getByTestId('live-error').locator('button[aria-expanded]');
    await details.click();
    assert.equal(await details.getAttribute('aria-expanded'), 'true');
  },
};
