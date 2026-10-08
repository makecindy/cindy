/** 手机端首次进入另一 Agent 浏览态、以及把 Agent 换到另一台电脑运行时的原生确认门。 */
import { Alert, type AlertButton, type AlertOptions } from 'react-native';

import { i18n } from '@/i18n';

import {
  mobileAgentLabel,
  resolveAgentLocationPick,
  type MobileSessionAgentKind,
} from './sessionAgentSwitch';
import type { RemoteSession, RemoteSessionAgentSwitchIntent } from './types';

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

/** 换位置的结果:{} = 位置不变;agentDeviceId = 带给被控端的新位置(null = 被控电脑)。 */
export type AgentLocationPatch = { agentDeviceId?: string | null };

/**
 * 远程 Agent:选中一行模型时 Agent 的运行位置怎么处理(规则见 resolveAgentLocationPick)。
 * 换到另一台电脑(或改回被控电脑)先确认;取消 = null,调用方什么都不改。
 * movable = false(访客 / 不支持切换 / 旧被控端)时只接受被控电脑自己的目录。
 */
export async function confirmAgentLocationForPick(
  input: {
    movable: boolean;
    session: Pick<RemoteSession, 'agentDeviceId'> | null | undefined;
    intent: RemoteSessionAgentSwitchIntent | null | undefined;
    /** 这一行来自哪台电脑的目录(null = 被控电脑)。 */
    catalogDeviceId: string | null;
    /** 其他电脑的展示名。 */
    deviceName(deviceId: string): string;
    /** 被控电脑的展示名;未知 = null。 */
    hostName: string | null;
  },
  showAlert: ShowAlert = Alert.alert,
): Promise<AgentLocationPatch | null> {
  if (!input.movable) return input.catalogDeviceId === null ? {} : null;
  const pick = resolveAgentLocationPick(input);
  if (pick.needsConfirm) {
    const target = input.catalogDeviceId
      ? { kind: 'device' as const, name: input.deviceName(input.catalogDeviceId) }
      : { kind: 'host' as const, name: input.hostName };
    if (!await confirmMobileAgentRelocation(target, showAlert)) return null;
  }
  return pick.relocateTo !== undefined ? { agentDeviceId: pick.relocateTo } : {};
}

/**
 * 远程 Agent:选中另一台电脑(或被控电脑)目录里的模型 = 把 Agent 换到那台电脑运行,
 * 下一条消息发出时生效。与桌面同一份风险说明;取消 / 系统 dismiss = 什么都不变。
 * target.kind = 'host' 指任务所在的被控电脑,name 未知时用不带名字的说法。
 */
export function confirmMobileAgentRelocation(
  target: { kind: 'device'; name: string } | { kind: 'host'; name: string | null },
  showAlert: ShowAlert = Alert.alert,
): Promise<boolean> {
  const title = target.kind === 'device'
    ? i18n.t('models.agentRelocation.titleOther', { device: target.name })
    : target.name
      ? i18n.t('models.agentRelocation.titleHost', { host: target.name })
      : i18n.t('models.agentRelocation.titleHostUnnamed');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      resolve(confirmed);
    };
    showAlert(
      title,
      i18n.t('models.agentRelocation.message'),
      [
        { text: i18n.t('models.agentRelocation.cancel'), style: 'cancel', onPress: () => finish(false) },
        { text: i18n.t('models.agentRelocation.confirm'), onPress: () => finish(true) },
      ],
      { cancelable: true, onDismiss: () => finish(false) },
    );
  });
}
