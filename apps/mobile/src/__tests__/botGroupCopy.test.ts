import { describe, expect, it } from 'vitest';
import { botGroupActionErrorText } from '../session/botGroupCopy';

describe('group send results', () => {
  it('does not call a transport timeout a failed send or expose raw errors', () => {
    const t = (key: string) => key;
    expect(botGroupActionErrorText(t, Object.assign(new Error('INVOKE_TIMEOUT'), { code: 'INVOKE_TIMEOUT' }), 'groupChat.composer.sendFailed'))
      .toBe('groupChat.errors.requestTimeout');
    expect(botGroupActionErrorText(t, new Error('INVALID_PARAMS: MEDIA_UPLOAD_FAILED'), 'fallback'))
      .toBe('groupChat.errors.mediaUploadFailed');
    expect(botGroupActionErrorText(t, new Error('private /path secret'), 'fallback')).toBe('fallback');
  });
});
