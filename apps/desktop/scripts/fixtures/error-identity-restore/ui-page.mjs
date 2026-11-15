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
  real: 'makerChatStore projection restore, light subscription, MessageStream ID deduplication, ErrorBanner',
  notCovered: 'Real database, Host/relay transport, upstream model execution; Host binding covered by unit tests',
  cases: {
    default: { about: 'Snapshot-only restore with a later system row and an unrelated historical error' },
    narrow: { about: 'Same restore at 320 px', viewport: { width: 320, height: 640 } },
  },
  async ready(page) {
    await page.getByTestId('restore').waitFor();
  },
  async check(page, ui) {
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
