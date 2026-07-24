/** Versioned local consent contract for voice input. Policy content can move to
 * a separately fetched document later without changing the gate semantics. */
export const VOICE_PRIVACY_POLICY_ID = 'voice-input';
export const CURRENT_VOICE_PRIVACY_POLICY_VERSION = 'voice-input-v1';

export type VoicePrivacyConsent = {
  policyId: typeof VOICE_PRIVACY_POLICY_ID;
  policyVersion: string;
  acceptedAt: number;
};

export function isCurrentVoicePrivacyConsent(
  value: unknown,
  now = Date.now(),
): value is VoicePrivacyConsent {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<VoicePrivacyConsent>;
  return candidate.policyId === VOICE_PRIVACY_POLICY_ID
    && candidate.policyVersion === CURRENT_VOICE_PRIVACY_POLICY_VERSION
    && typeof candidate.acceptedAt === 'number'
    && Number.isFinite(candidate.acceptedAt)
    && candidate.acceptedAt > 0
    && candidate.acceptedAt <= now;
}

export function createVoicePrivacyConsent(now = Date.now()): VoicePrivacyConsent {
  return {
    policyId: VOICE_PRIVACY_POLICY_ID,
    policyVersion: CURRENT_VOICE_PRIVACY_POLICY_VERSION,
    acceptedAt: now,
  };
}
