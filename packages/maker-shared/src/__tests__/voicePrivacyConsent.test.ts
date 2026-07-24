import { describe, expect, it } from 'vitest';
import {
  CURRENT_VOICE_PRIVACY_POLICY_VERSION,
  createVoicePrivacyConsent,
  isCurrentVoicePrivacyConsent,
} from '../voicePrivacyConsent';

describe('voice privacy consent', () => {
  it('creates a versioned consent record', () => {
    expect(createVoicePrivacyConsent(123)).toEqual({
      policyId: 'voice-input',
      policyVersion: CURRENT_VOICE_PRIVACY_POLICY_VERSION,
      acceptedAt: 123,
    });
  });

  it('rejects stale, malformed, and future consent records', () => {
    expect(isCurrentVoicePrivacyConsent(null)).toBe(false);
    expect(isCurrentVoicePrivacyConsent({ policyId: 'voice-input', policyVersion: 'old', acceptedAt: 123 })).toBe(false);
    expect(isCurrentVoicePrivacyConsent({ policyId: 'voice-input', policyVersion: CURRENT_VOICE_PRIVACY_POLICY_VERSION, acceptedAt: 0 })).toBe(false);
    expect(isCurrentVoicePrivacyConsent(createVoicePrivacyConsent(124), 123)).toBe(false);
    expect(isCurrentVoicePrivacyConsent(createVoicePrivacyConsent(123), 123)).toBe(true);
  });
});
