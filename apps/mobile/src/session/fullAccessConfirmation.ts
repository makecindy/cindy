import { Alert, type AlertButton, type AlertOptions } from 'react-native';
import { getLocales } from 'expo-localization';
import { requiresFullAccessConfirmation } from '@cindy/maker-shared/permission-mode';

import { getManualLocaleOverride } from '@/i18n/appLanguage';

export type FullAccessConfirmationCopy = Readonly<{
  title: string;
  description: string;
  confirm: string;
  cancel: string;
}>;

const FULL_ACCESS_CONFIRMATION_COPY: Record<'en' | 'ja' | 'ko' | 'zh', FullAccessConfirmationCopy> = {
  en: {
    title: 'Enable Full access?',
    description: 'Full access disables the workspace sandbox and skips routine approvals. Cindy can modify files outside the workspace and run network commands without asking; built-in high-risk operations will still require confirmation.',
    confirm: 'Enable Full access',
    cancel: 'Keep current permissions',
  },
  ja: {
    title: 'Full access を有効にしますか？',
    description: 'Full access はワークスペースのサンドボックスを無効にし、通常の承認を省略します。Cindy はワークスペース外のファイル変更やネットワークコマンドを確認なしで実行できます。組み込みの高リスク操作では引き続き確認が必要です。',
    confirm: 'Full access を有効にする',
    cancel: '現在の権限を維持',
  },
  ko: {
    title: 'Full access를 활성화할까요?',
    description: 'Full access는 작업 공간 샌드박스를 비활성화하고 일반 승인을 건너뜁니다. Cindy가 작업 공간 밖의 파일을 수정하고 네트워크 명령을 묻지 않고 실행할 수 있습니다. 기본 제공 고위험 작업은 계속 확인을 요청합니다.',
    confirm: 'Full access 활성화',
    cancel: '현재 권한 유지',
  },
  zh: {
    title: '开启 Full access？',
    description: 'Full access 会关闭工作区沙箱并跳过常规审批。Cindy 可以修改工作区外的文件、执行联网命令且不再询问；内置高风险操作仍会要求确认。',
    confirm: '开启 Full access',
    cancel: '保留当前权限',
  },
};

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

/**
 * 手机端进入 Full access 的一次性确认。
 * 取消、系统 dismiss 或重复回调都保持原权限；不需要升级时直接放行。
 */
export function confirmFullAccessChange(
  currentMode: unknown,
  nextMode: unknown,
  showAlert: ShowAlert = Alert.alert,
): Promise<boolean> {
  if (!requiresFullAccessConfirmation(currentMode, nextMode)) {
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
