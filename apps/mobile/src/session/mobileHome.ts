import type { RemoteSession } from '@/session/types';
import { i18n } from '@/i18n';
import { mobilePresentationLocalizer } from '@/i18n/presentationLocalizer';
import { localizeRemoteSessionListItem } from '@/session/sessionList';
import {
  buildMobileHomePresentation as buildMobileHomePresentationShared,
  type MobileHomeSessionLike,
  type MobileHomeNoDeviceContext,
  type MobileHomeOptions,
  type MobileHomePresentation,
} from '@cindy/maker-shared/mobile-home';

export * from '@cindy/maker-shared/mobile-home';

export function buildMobileHomePresentation(options: MobileHomeOptions): MobileHomePresentation {
  const now = options.now ?? Date.now();
  const base = buildMobileHomePresentationShared({ ...options, localizer: mobilePresentationLocalizer });
  const deviceFilters = base.deviceFilters.map((filter) => ({
    ...filter,
    label: filter.deviceId === null ? i18n.t('devices.presentation.home.allDevices') : filter.label,
    statusLabel: filter.waitingCount > 0
      ? i18n.t('devices.presentation.home.waitingCount', { count: filter.waitingCount })
      : filter.deviceId === null
        ? i18n.t('devices.presentation.home.allComputers')
        : filter.statusLabel === '已同步'
          ? i18n.t('devices.presentation.home.synced')
          : filter.statusLabel,
  }));
  const primaryDevice = base.primaryDevice
    ? deviceFilters.find((item) => item.id === base.primaryDevice?.id) ?? null
    : null;
  const empty = localizedHomeEmpty(base.emptyKind, base.emptyNoDevice);
  return {
    ...base,
    chats: base.chats.map((item) => localizeRemoteSessionListItem(item, now)),
    deviceFilters,
    emptyCopy: empty.copy,
    emptyTitle: empty.title,
    pinned: base.pinned.map((item) => localizeRemoteSessionListItem(item, now)),
    primaryDevice,
    projects: base.projects.map((project) => {
      const sourceDeviceName = (project.sessions[0]?.session as MobileHomeSessionLike | undefined)?.deviceLinkDeviceName
        ?? (project.deviceId
          ? options.devices?.find((device) => device.deviceId === project.deviceId)?.name
          : undefined);
      const deviceName = sourceDeviceName == null
        ? i18n.t('devices.presentation.home.unknownComputer')
        : project.deviceName;
      const workingDir = project.workingDir;
      return {
        ...project,
        deviceName,
        sessions: project.sessions.map((item) => localizeRemoteSessionListItem(item, now)),
        subtitle: [deviceName, workingDir].filter(Boolean).join(' · '),
        title: project.workingDir
          ? project.title
          : i18n.t('devices.presentation.home.uncategorizedProject'),
      };
    }),
  };
}

function localizedHomeEmpty(
  kind: MobileHomePresentation['emptyKind'],
  noDevice: MobileHomeNoDeviceContext | null,
): { title: string; copy: string } {
  if (kind !== 'noDevice' || !noDevice) {
    return {
      title: i18n.t(`devices.presentation.home.empty.${kind}.title`),
      copy: i18n.t(`devices.presentation.home.empty.${kind}.copy`),
    };
  }
  const names = formatDeviceNames(noDevice.devices.map((device) => device.name));
  return {
    title: i18n.t(`devices.presentation.home.noDevice.${noDevice.reason}.title`),
    copy: i18n.t(`devices.presentation.home.noDevice.${noDevice.reason}.copy`, { names }),
  };
}

function formatDeviceNames(names: readonly string[]): string {
  if (names.length === 0) return '';
  const quoted = names.map((name) => `“${name}”`);
  try {
    return new Intl.ListFormat(i18n.resolvedLanguage || i18n.language, {
      style: 'long',
      type: 'conjunction',
    }).format(quoted);
  } catch {
    return quoted.join(', ');
  }
}

/**
 * 手机端隐藏 Orca worker 子会话(本期不支持进 worker 子会话聊天),Lead 会话与普通会话保留。
 * **只在 mobile 侧过滤**——桌面仍需显示/管理 worker,绝不动共享的 sessionList 过滤逻辑。
 */
export function excludeOrcaWorkerSessions<T extends Pick<RemoteSession, 'orcaRole'>>(
  sessions: readonly T[],
): T[] {
  return sessions.filter((session) => session.orcaRole !== 'worker');
}
