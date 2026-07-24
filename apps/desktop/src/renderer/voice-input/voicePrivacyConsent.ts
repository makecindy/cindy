import {
  createVoicePrivacyConsent,
  isCurrentVoicePrivacyConsent,
  type VoicePrivacyConsent,
} from '@lizi/maker-shared/voice-privacy-consent';

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
    return isCurrentVoicePrivacyConsent(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return false;
  }
}
