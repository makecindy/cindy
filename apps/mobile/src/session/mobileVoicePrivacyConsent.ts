import {
  createVoicePrivacyConsent,
  isCurrentVoicePrivacyConsent,
} from '@lizi/maker-shared/voice-privacy-consent';
import { getSecureItem, setSecureItem } from '@/auth/secureStorage';
import { Alert } from 'react-native';

const STORAGE_KEY = 'xdt.mobileVoicePrivacyConsent.v1';
let consentInFlight: Promise<boolean> | null = null;

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
      '语音输入隐私说明',
      '语音输入会使用麦克风，并将音频发送到配置的语音识别服务进行转写。你可以取消，取消不会影响文字输入。',
      [
        { text: '取消', style: 'cancel', onPress: () => finish(false) },
        {
          text: '同意并继续',
          onPress: () => {
            void setSecureItem(STORAGE_KEY, JSON.stringify(createVoicePrivacyConsent()))
              .then(async () => finish(isCurrentVoicePrivacyConsent(JSON.parse((await getSecureItem(STORAGE_KEY)) ?? 'null'))))
              .catch(() => finish(false));
          },
        },
      ],
      { cancelable: true, onDismiss: () => finish(false) },
    );
  });
}
