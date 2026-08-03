import { Alert, type AlertButton, type AlertOptions } from 'react-native';
import { getLocales } from 'expo-localization';
import { requiresFullAccessConfirmation } from '@cindy/maker-shared/permission-mode';

import { getManualLocaleOverride } from '@/i18n/appLanguage';
import {
  FULL_ACCESS_CONFIRMATION_COPY,
  type FullAccessConfirmationCopy,
} from './fullAccessConfirmationCopy';



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
  /** 仅用于把新建任务默认权限恢复为该 agent 上一次明确选过的档位。 */
  restoringRememberedChoice?: boolean;
  showAlert?: ShowAlert;
}

/**
 * 手机端进入 Full access 的确认。只有新建任务恢复该 agent 上一次明确选择的权限时
 * 直接沿用；其它从非 Full access 进入 Full access 的操作每次都确认。
 */
export function confirmFullAccessChange(
  currentMode: unknown,
  nextMode: unknown,
  options: FullAccessConfirmationOptions = {},
): Promise<boolean> {
  if (options.restoringRememberedChoice || !requiresFullAccessConfirmation(currentMode, nextMode)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      resolve(confirmed);
    };

    const copy = getFullAccessConfirmationCopy();
    (options.showAlert ?? Alert.alert)(
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
