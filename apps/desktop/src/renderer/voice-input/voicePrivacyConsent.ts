import {
  createVoicePrivacyConsent,
  isCurrentVoicePrivacyConsent,
  type VoicePrivacyConsent,
} from '@cindy/maker-shared/voice-privacy-consent';

const STORAGE_KEY = 'cindy.voiceInput.privacyConsent.v1';

export function readVoicePrivacyConsent(): VoicePrivacyConsent | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isCurrentVoicePrivacyConsent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveVoicePrivacyConsent(): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(createVoicePrivacyConsent()));
    return true;
  } catch {
    return false;
  }
}
