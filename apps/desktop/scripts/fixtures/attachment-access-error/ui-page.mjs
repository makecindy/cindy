import assert from 'node:assert/strict';

export default {
  name: 'attachment-access-error',
  entry: './attachment-access-error-fixture.tsx',
  viewport: { width: 560, height: 400 },
  real: 'ErrorBanner, ErrorTailErrorBanner, ErrorMessageCard, error-code decoding, ErrorNotice and localized attachment recovery guidance',
  notCovered: 'macOS WeChat permissions, file I/O and cross-device sending; transport behavior is covered by targeted unit tests',
  cases: {
    default: { about: '#6530: source permission denial explains how to reattach a readable copy' },
    live: { about: '#6530: live send failure exposes recovery without expanding details' },
    'live-narrow': { about: 'Live recovery at narrow width', viewport: { width: 320, height: 480 } },
    tail: { about: '#6530: tail banner exposes recovery without expanding details' },
    'tail-narrow': { about: 'Tail recovery at narrow width', viewport: { width: 320, height: 480 } },
    narrow: { about: 'Recovery text wraps at a narrow message width', viewport: { width: 320, height: 480 } },
  },
  async check(page, ui) {
    assert.ok(await page.getByText(await ui.t('chat.errorBanner.attachmentAccessDeniedRecovery'), { exact: true }).isVisible());
    assert.ok(await page.getByText(await ui.t('chat.errorBanner.attachmentAccessDeniedTitle'), { exact: true }).isVisible());
    assert.equal(await page.getByRole('button', { name: await ui.t('chat.errorBanner.networkShowRaw'), exact: true }).getAttribute('aria-expanded'), 'false');
    assert.equal(await page.getByText(await ui.t('chat.errorBanner.replyFailed'), { exact: true }).count(), 0);
  },
};
