import { describe, expect, it } from 'vitest';
import { TEST_XD_GATEWAY_BASE_URL as XD_GATEWAY_BASE_URL } from '../../../test/vitest/clientEndpointsFixture';

import { isVoiceInputServiceConnectionError } from '../overlayErrors';

describe('voice input overlay error classification', () => {
  it('detects transport failures as service connection errors', () => {
    expect(isVoiceInputServiceConnectionError(`getaddrinfo ENOTFOUND ${new URL(XD_GATEWAY_BASE_URL).host}`)).toBe(true);
    expect(isVoiceInputServiceConnectionError('WebSocket connection timed out')).toBe(true);
    expect(isVoiceInputServiceConnectionError('fetch failed')).toBe(true);
    expect(isVoiceInputServiceConnectionError('network socket disconnected before secure TLS connection was established')).toBe(true);
    expect(isVoiceInputServiceConnectionError('unable to verify the first certificate')).toBe(true);
  });

  it('does not classify ordinary user-facing errors as service connection errors', () => {
    expect(isVoiceInputServiceConnectionError('需要开启麦克风权限，才能使用语音输入。')).toBe(false);
    expect(isVoiceInputServiceConnectionError('No speech was detected.')).toBe(false);
  });
});
