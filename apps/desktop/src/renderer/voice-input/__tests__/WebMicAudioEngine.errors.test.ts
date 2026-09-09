import { describe, expect, it } from 'vitest';

import { isMicrophonePermissionDeniedError } from '../WebMicAudioEngine';

describe('WebMicAudioEngine error classification', () => {
  it('recognizes microphone permission revocation errors structurally', () => {
    expect(isMicrophonePermissionDeniedError(new DOMException('denied', 'NotAllowedError'))).toBe(true);
    expect(isMicrophonePermissionDeniedError({ name: 'SecurityError', message: 'blocked' })).toBe(true);
    expect(isMicrophonePermissionDeniedError({ name: 'NotReadableError' })).toBe(false);
    expect(isMicrophonePermissionDeniedError(new Error('permission denied'))).toBe(false);
  });
});
