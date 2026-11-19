import { useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { parseSourceSessionTarget } from '@cindy/maker-shared/message-source';
import {
  remoteProjectsStore,
  useRemoteSessionTitle,
} from '@/features/device-link/remoteProjectsStore';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { buildSessionDeepLink } from '@/lib/deepLink';
import { sessionsStore } from '@/lib/sessionsStore';
import { toast } from '@/lib/toast';

import { useSessionLinkTarget } from './SessionLinkChip';

/**
 * 来源任务的实时标题(只读，不带跳转)：侧栏行上的「由哪个任务发起」标记用它，避免每行挂导航状态。
 * 另一台电脑上的来源(`deviceId::sessionId`)不在本机或本设备镜像里，返回 null，由调用方回退快照。
 */
export function useSourceSessionTitle(sourceSessionId: string | undefined, hostSessionId: string | undefined): string | null {
  const crossDevice = !!parseSourceSessionTarget(sourceSessionId)?.deviceId;
  return useLiveSessionTitle(crossDevice ? undefined : sourceSessionId, Boolean(getStickySessionDeviceId(hostSessionId)));
}

/**
 * 来源任务的实时标题：远程任务查所在设备的任务镜像，本机任务查本机任务列表，
 * 都按 id 索引取值（不随无关任务变化逐条扫描）；拿不到返回 null，由调用方回退快照。
 */
function useLiveSessionTitle(sessionId: string | undefined, remote: boolean): string | null {
  const localTitle = useSyncExternalStore(
    (onChange) => sessionsStore.subscribe(onChange),
    () => (sessionId && !remote ? sessionsStore.getTitleById(sessionId) : null),
  );
  const remoteTitle = useRemoteSessionTitle(remote ? sessionId : undefined);
  return remote ? remoteTitle : localTitle;
}

/**
 * 打开「来源任务」：消息来源标签与任务级「由哪个任务发起」共用。
 * - `deviceId::sessionId`（另一台电脑上的任务发来）走任务深链，按来源设备打开；
 * - 其余来源任务与当前任务在同一台设备上：远程任务的来源任务也钉到那台设备再跳转。
 * 没有来源任务 id（共享任务访客收到的已脱敏来源）时 `open` 为 null，只展示不可点击。
 */
export function useSourceSessionOpener(sourceSessionId: string | undefined, hostSessionId: string | undefined) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const sourceTarget = parseSourceSessionTarget(sourceSessionId);
  const { openTarget: openCrossDeviceTarget } = useSessionLinkTarget(
    sourceTarget?.deviceId ? buildSessionDeepLink(sourceTarget.sessionId, { deviceId: sourceTarget.deviceId }) : '',
  );
  // 粘滞归属：relay 瞬时重连会清空镜像索引，此窗口内仍要把远程任务当远程处理，
  // 否则来源任务会被当成本机任务打开。
  const hostDeviceId = getStickySessionDeviceId(hostSessionId);
  const liveTitle = useLiveSessionTitle(sourceTarget?.deviceId ? undefined : sourceSessionId, Boolean(hostDeviceId));
  const open: (() => void) | null = sourceTarget?.deviceId
    ? () => {
        void openCrossDeviceTarget(false).catch(() => toast.error(t('chat.markdownRenderer.openLinkFailed')));
      }
    : sourceSessionId && sourceTarget
      ? () => {
          if (hostDeviceId) remoteProjectsStore.pinSessionOrigin(hostDeviceId, sourceSessionId);
          navigate(`/cc-agent/${encodeURIComponent(sourceSessionId)}`);
        }
      : null;
  return { sourceTarget, hostDeviceId, liveTitle, open };
}
