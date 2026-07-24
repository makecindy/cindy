import type { DeviceLinkStatus } from '@cindy/device-link';

import { i18n } from '@/i18n';

export interface MobileSettingsOverviewInput {
  authBaseUrl: string;
  authRegion: 'cn' | 'global' | 'dev';
  deviceId: string | null;
  deviceName: string;
  lastSyncedAt?: number | null;
  platform: string;
  relayStatus: DeviceLinkStatus;
  userEmail?: string | null;
  userId?: string | null;
  userName?: string | null;
}

export interface MobileSettingsRow {
  copyValue?: string;
  detail?: string;
  id: string;
  label: string;
  value: string;
}

export interface MobileSettingsSection {
  /** true 表示该分组默认折叠(如「调试 / 开发者」),普通用户不必直面。 */
  collapsible?: boolean;
  id: 'about' | 'debug';
  rows: MobileSettingsRow[];
  title: string;
}

/**
 * 设置页顶部账号头部。替代旧版重复的「账号 / 手机 / Relay」三 metric 条 —— 账号、设备、
 * 连接状态在这里一次性呈现,下面的分组不再重复同样的身份信息。
 */
export interface MobileSettingsHeader {
  deviceName: string;
  /** 仅当与展示名不同才给出,避免「名 = 邮箱」时重复两行。 */
  email?: string;
  name: string;
  relayDetail: string;
  relayLabel: string;
  relayTone: 'ready' | 'busy' | 'off';
}

export interface MobileSettingsOverview {
  header: MobileSettingsHeader;
  sections: MobileSettingsSection[];
}

/**
 * 把账号 / 设备 / 连接 / 调试信息整理成设置页的展示模型(纯函数,便于单测)。
 * 分两层:`header` 承载用户最常看的身份 + 连接状态;`sections` 把「关于这台手机」与
 * 默认折叠的「调试 / 开发者」分开,避免一墙 ID / hash 与真正可操作项平铺等权重。
 * App 版本 / OTA 运行信息不在此处 —— 由设置页的「版本」行直接读 expo-constants / expo-updates。
 */
export function buildMobileSettingsOverview(input: MobileSettingsOverviewInput): MobileSettingsOverview {
  const relayLabel = relayStatusLabel(input.relayStatus);
  const relayDetail = relayStatusHint(input.relayStatus, input.lastSyncedAt ?? null);
  const name = input.userName?.trim() || input.userEmail?.trim() || i18n.t('settings.header.notSignedIn');
  const deviceName = input.deviceName.trim() || i18n.t('settings.header.thisPhone');
  const email = input.userEmail?.trim();
  return {
    header: {
      deviceName,
      email: email && email !== name ? email : undefined,
      name,
      relayDetail,
      relayLabel,
      relayTone: relayStatusTone(input.relayStatus),
    },
    sections: [
      {
        id: 'about',
        title: i18n.t('settings.about.sectionTitle'),
        rows: compactRows([
          {
            id: 'about.deviceName',
            label: i18n.t('settings.about.deviceName'),
            value: deviceName,
            detail: i18n.t('settings.about.deviceNameDetail'),
          },
          {
            id: 'about.platform',
            label: i18n.t('settings.about.platform'),
            value: platformLabel(input.platform),
          },
          {
            id: 'about.remoteControl',
            label: i18n.t('settings.about.remoteControl'),
            value: i18n.t('settings.about.remoteControlValue'),
            detail: i18n.t('settings.about.remoteControlDetail'),
          },
        ]),
      },
      {
        id: 'debug',
        title: i18n.t('settings.debug.sectionTitle'),
        collapsible: true,
        rows: compactRows([
          {
            id: 'debug.userId',
            label: i18n.t('settings.debug.userId'),
            value: input.userId?.trim() || i18n.t('settings.debug.notSynced'),
            copyValue: input.userId?.trim() || undefined,
          },
          {
            id: 'debug.deviceId',
            label: i18n.t('settings.debug.deviceId'),
            value: input.deviceId?.trim() || i18n.t('settings.debug.initializing'),
            copyValue: input.deviceId?.trim() || undefined,
          },
          {
            id: 'debug.authBaseUrl',
            label: i18n.t('settings.debug.authServer'),
            value: input.authBaseUrl,
            copyValue: input.authBaseUrl,
          },
          {
            id: 'debug.authRegion',
            label: i18n.t('settings.debug.authRegion'),
            value: input.authRegion === 'global' ? 'Global' : 'CN',
          },
        ]),
      },
    ],
  };
}

export function relayStatusTone(status: DeviceLinkStatus): 'ready' | 'busy' | 'off' {
  if (status === 'online') return 'ready';
  if (status === 'connecting') return 'busy';
  return 'off';
}

// Relay 状态文案:原来消费 @cindy/maker-shared 的中文直出 helper(桌面端不用那组),
// mobile i18n 化后改在本层用 catalog key 组装,逻辑与共享包版本保持一致。
function relayStatusLabel(status: DeviceLinkStatus): string {
  if (status === 'online') return i18n.t('settings.relay.online');
  if (status === 'connecting') return i18n.t('settings.relay.connecting');
  return i18n.t('settings.relay.stopped');
}

function relayStatusHint(status: DeviceLinkStatus, lastSyncedAt: number | null): string {
  if (status === 'online') {
    return lastSyncedAt
      ? i18n.t('settings.relay.lastSynced', { time: formatClock(lastSyncedAt) })
      : i18n.t('settings.relay.canSync');
  }
  if (status === 'connecting') return i18n.t('settings.relay.reconnectHint');
  return i18n.t('settings.relay.resumeHint');
}

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return [
    date.getHours().toString().padStart(2, '0'),
    date.getMinutes().toString().padStart(2, '0'),
    date.getSeconds().toString().padStart(2, '0'),
  ].join(':');
}

function compactRows(rows: MobileSettingsRow[]): MobileSettingsRow[] {
  return rows.filter((row) => row.value.length > 0);
}

function platformLabel(platform: string): string {
  if (platform === 'ios') return 'iOS';
  if (platform === 'android') return 'Android';
  if (platform === 'web') return 'Web';
  return platform || 'Unknown';
}
