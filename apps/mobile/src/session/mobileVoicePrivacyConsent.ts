import {
  createVoicePrivacyConsent,
  isCurrentVoicePrivacyConsent,
} from '@cindy/maker-shared/voice-privacy-consent';
import { getSecureItem, setSecureItem } from '@/auth/secureStorage';
import { i18n } from '@/i18n';
import { Alert } from 'react-native';

const STORAGE_KEY = 'xdt.mobileVoicePrivacyConsent.v1';
let consentInFlight: Promise<boolean> | null = null;

export async function persistMobileVoicePrivacyConsent(): Promise<boolean> {
  try {
    await setSecureItem(STORAGE_KEY, JSON.stringify(createVoicePrivacyConsent()));
    return true;
  } catch {
    return false;
  }
}

export async function ensureMobileVoicePrivacyConsent(): Promise<boolean> {
  if (consentInFlight) return consentInFlight;
  consentInFlight = resolveMobileVoicePrivacyConsent();
  try {
    return await consentInFlight;
  } finally {
    consentInFlight = null;
  }
}

async function resolveMobileVoicePrivacyConsent(): Promise<boolean> {
  const stored = await getSecureItem(STORAGE_KEY).catch(() => null);
  if (stored) {
    try {
      if (isCurrentVoicePrivacyConsent(JSON.parse(stored))) return true;
    } catch {
      // Treat corrupt consent as missing and ask again.
    }
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      resolve(accepted);
    };
    Alert.alert(
      i18n.t('session.common.voicePrivacyConsent.title'),
      i18n.t('session.common.voicePrivacyConsent.description'),
      [
        {
          text: i18n.t('session.common.voicePrivacyConsent.cancel'),
          style: 'cancel',
          onPress: () => finish(false),
        },
        {
          text: i18n.t('session.common.voicePrivacyConsent.confirm'),
          onPress: () => {
            void persistMobileVoicePrivacyConsent().then(finish);
          },
        },
      ],
      { cancelable: true, onDismiss: () => finish(false) },
    );
  });
}
