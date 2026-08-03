import { Alert, type AlertButton, type AlertOptions } from 'react-native';
import { getLocales } from 'expo-localization';
import { requiresFullAccessConfirmation } from '@cindy/maker-shared/permission-mode';

import { getManualLocaleOverride } from '@/i18n/appLanguage';
import {
  getMobileAuthOwner,
  isMobileAuthOwnerCurrent,
} from '@/auth/authOwnerGeneration';
import {
  FULL_ACCESS_CONFIRMATION_COPY,
  type FullAccessConfirmationCopy,
} from './fullAccessConfirmationCopy';
import {
  hasFullAccessAcknowledgement,
  rememberFullAccessAcknowledgement,
} from './fullAccessConfirmationStore';



/** 生效语言(手动选择优先,否则系统语言)选择手机端 Full access 确认文案;未覆盖的语言使用英文。 */
export function getFullAccessConfirmationCopy(
  languageCode = getManualLocaleOverride() ?? getLocales()[0]?.languageCode,
): FullAccessConfirmationCopy {
  const normalized = languageCode?.toLowerCase() ?? '';
  const language = normalized.startsWith('zh')
    ? 'zh'
    : normalized.startsWith('ja')
      ? 'ja'
      : normalized.startsWith('ko')
        ? 'ko'
        : 'en';
  return FULL_ACCESS_CONFIRMATION_COPY[language];
}

type ShowAlert = (
  title: string,
  message?: string,
  buttons?: AlertButton[],
  options?: AlertOptions,
) => void;

export interface FullAccessConfirmationOptions {
  controlledDeviceId?: string | null;
  isControlledDeviceCurrent?: () => boolean;
  showAlert?: ShowAlert;
}

const confirmationInFlight = new Map<string, Promise<boolean>>();

function showFullAccessConfirmation(showAlert: ShowAlert): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      resolve(confirmed);
    };

    const copy = getFullAccessConfirmationCopy();
    showAlert(
      copy.title,
      copy.description,
      [
        { text: copy.cancel, style: 'cancel', onPress: () => finish(false) },
        { text: copy.confirm, style: 'destructive', onPress: () => finish(true) },
      ],
      { cancelable: true, onDismiss: () => finish(false) },
    );
  });
}

/**
 * 手机端进入 Full access 的首次确认。同一账号控制同一台桌面电脑只确认一次；
 * 换账号或换电脑重新确认。取消、系统 dismiss、账号/设备切换都保持原权限。
 */
export async function confirmFullAccessChange(
  currentMode: unknown,
  nextMode: unknown,
  options: FullAccessConfirmationOptions = {},
): Promise<boolean> {
  if (!requiresFullAccessConfirmation(currentMode, nextMode)) {
    return true;
  }

  const owner = getMobileAuthOwner();
  const controlledDeviceId = options.controlledDeviceId?.trim() ?? '';
  const scopeIsCurrent = () => (
    !!owner.accountId
    && !!controlledDeviceId
    && isMobileAuthOwnerCurrent(owner)
    && (options.isControlledDeviceCurrent?.() ?? true)
  );
  if (!scopeIsCurrent()) return false;

  const inFlightKey = `${owner.accountId}\u0000${controlledDeviceId}\u0000${owner.generation}`;
  const existing = confirmationInFlight.get(inFlightKey);
  if (existing) {
    const confirmed = await existing;
    return confirmed && scopeIsCurrent();
  }

  const task = (async () => {
    const acknowledged = await hasFullAccessAcknowledgement(owner.accountId, controlledDeviceId);
    if (!scopeIsCurrent()) return false;
    if (acknowledged) return true;

    const confirmed = await showFullAccessConfirmation(options.showAlert ?? Alert.alert);
    if (!confirmed || !scopeIsCurrent()) return false;

    await rememberFullAccessAcknowledgement(owner.accountId, controlledDeviceId);
    return scopeIsCurrent();
  })();
  confirmationInFlight.set(inFlightKey, task);
  try {
    return await task;
  } finally {
    if (confirmationInFlight.get(inFlightKey) === task) {
      confirmationInFlight.delete(inFlightKey);
    }
  }
}

export const __testing = {
  resetInFlight(): void {
    confirmationInFlight.clear();
  },
};
