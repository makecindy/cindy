import { describe, expect, it } from 'vitest';
import { TEST_XD_GATEWAY_BASE_URL as XD_GATEWAY_BASE_URL } from '../../../test/vitest/clientEndpointsFixture';

import { createInstance } from 'i18next';
import { VOICE_INPUT_RATE_LIMITED_MESSAGE } from '../../../shared/voiceInputErrors';
import { getVoiceInputErrorMessageKey, isVoiceInputServiceConnectionError } from '../overlayErrors';

describe('voice input overlay error classification', () => {
  it('localizes the same start/recovery message using the renderer language after a switch', async () => {
    const local = createInstance();
    await local.init({ lng: 'en', resources: {
      en: { translation: { voiceInputOverlay: { rateLimited: 'English limit message' } } },
      ja: { translation: { voiceInputOverlay: { rateLimited: 'Japanese limit message' } } },
    } });
    const key = getVoiceInputErrorMessageKey(VOICE_INPUT_RATE_LIMITED_MESSAGE)!;
    expect(local.t(key)).toBe('English limit message');
    await local.changeLanguage('ja');
    expect(local.t(getVoiceInputErrorMessageKey(VOICE_INPUT_RATE_LIMITED_MESSAGE)!)).toBe('Japanese limit message');
    expect(getVoiceInputErrorMessageKey('Upstream HTTP 429')).toBeUndefined();
    expect(getVoiceInputErrorMessageKey('WebSocket connection timed out')).toBe('voiceInputOverlay.asrServiceUnavailable');
  });

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
