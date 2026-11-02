import assert from 'node:assert/strict';

export default {
  name: 'compact-recovery',
  entry: './compact-recovery-fixture.tsx',
  viewport: { width: 560, height: 320 },
  real: 'ErrorBanner, ErrorMessageCard, legacy error classification and localized compact recovery guidance',
  notCovered: 'Live provider compaction and host rollover; recovery behavior is covered by targeted tests',
  cases: {
    default: { about: 'Encrypted compact failure retains Retry and explains the cause' },
    legacy: { about: 'Older host error no longer claims the input is oversized' },
    history: { about: 'Persisted compact error displays the corrected explanation' },
    'legacy-split': { about: 'Older host live error with discarded ciphertext details' },
    'history-split': { about: 'Persisted legacy error with discarded ciphertext details' },
    overflow: { about: 'Concrete context overflow retains its own guidance' },
    narrow: { about: 'Recovery guidance at 320 px', viewport: { width: 320, height: 440 } },
  },
  async check(page, ui) {
    const expected = ui.case === 'overflow' ? 'chat.errorBanner.contextOverflow' : 'chat.errorBanner.remoteCompactEncryptedContent';
    const other = ui.case === 'overflow' ? 'chat.errorBanner.remoteCompactEncryptedContent' : 'chat.errorBanner.contextOverflow';
    assert.ok(await page.getByText(await ui.t(expected), { exact: true }).isVisible());
    assert.equal(await page.getByText(await ui.t(other), { exact: true }).count(), 0);
    if (!ui.case.startsWith('history')) {
      await page.getByTitle(await ui.t('chat.errorBanner.retryTitle'), { exact: true }).click();
      assert.equal(await page.locator('[data-retries]').getAttribute('data-retries'), '1');
    }
  },
};
