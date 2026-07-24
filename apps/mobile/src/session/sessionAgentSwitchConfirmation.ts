/** 手机端首次进入另一 Agent 浏览态时的原生确认门。 */
import { Alert, type AlertButton, type AlertOptions } from 'react-native';

import { i18n } from '@/i18n';

import { mobileAgentLabel, type MobileSessionAgentKind } from './sessionAgentSwitch';

type ShowAlert = (
  title: string,
  message?: string,
  buttons?: AlertButton[],
  options?: AlertOptions,
) => void;

/**
 * 已有 pending intent 说明本轮选择已经确认过；改模型、切来源或回到当前 Agent
 * 都不重复弹。取消 / 系统 dismiss 保持原浏览分段。
 */
export function confirmMobileSessionAgentSwitch(
  targetAgentKind: MobileSessionAgentKind,
  hasPendingIntent: boolean,
  showAlert: ShowAlert = Alert.alert,
): Promise<boolean> {
  if (hasPendingIntent) return Promise.resolve(true);
  const target = mobileAgentLabel(targetAgentKind);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      resolve(confirmed);
    };
    showAlert(
      i18n.t('models.agentSwitch.confirmTitle', { agent: target }),
      i18n.t('models.agentSwitch.confirmMessage', { agent: target }),
      [
        { text: i18n.t('models.agentSwitch.cancel'), style: 'cancel', onPress: () => finish(false) },
        { text: i18n.t('models.agentSwitch.confirm'), onPress: () => finish(true) },
      ],
      { cancelable: true, onDismiss: () => finish(false) },
    );
  });
}
