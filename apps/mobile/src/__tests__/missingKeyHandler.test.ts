import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

describe('missing key handler', () => {
  it('keeps an explicit fallback for unrelated missing keys', () => {
    expect(i18n.t('models.options.effortLevels.not-a-real-effort', { defaultValue: '' })).toBe('');
    expect(i18n.t('not.a.real.key', { defaultValue: 'keep me' })).toBe('keep me');
  });

  it('still summarizes a missing remote error instead of upstream text', () => {
    expect(i18n.t('session.remoteError.REMOTE_NOT_A_REAL_CODE', { defaultValue: 'upstream english' }))
      .toBe(i18n.t('session.tail.replyFailed'));
  });
});
