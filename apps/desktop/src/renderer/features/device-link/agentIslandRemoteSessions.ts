/**
 * 把其它设备(device-link「我控制它」)任务的实时活动同步给 main,供本机灵动岛与
 * 桌面通知使用。
 * ---------------------------------------------------------------------------
 * 范围跟侧栏「任务范围」走:只同步当前范围内、侧栏会展示的远程任务;断线设备的快照
 * 可能停在旧状态,不同步。状态跃迁的判定(何时弹出 / 响铃 / 发通知)在 main 的岛状态机。
 */

import { useEffect, useRef } from 'react';
import type { AgentIslandRemoteSessionInput } from '../../../shared/agentIsland';
import type { Session } from '@/lib/ccAgent.types';
import { useRemoteProjectSessions } from './remoteProjectsStore';
import {
  getRemoteSessionActivity,
  useRemoteSessionActivityRevision,
  type RemoteSessionActivity,
} from './remoteSessionActivityStore';
import { selectVisibleSessions, type MachineSelection } from './selectedMachineStore';
import { useEffectiveSelectedMachineId } from './useMachineSwitcher';

export function buildAgentIslandRemoteSessionInputs(
  remoteSessions: Session[],
  selection: MachineSelection,
  readActivity: (sessionId: string, deviceId: string) => RemoteSessionActivity | undefined,
): AgentIslandRemoteSessionInput[] {
  const inputs: AgentIslandRemoteSessionInput[] = [];
  for (const session of selectVisibleSessions([], remoteSessions, selection)) {
    const deviceId = session.deviceLinkDeviceId;
    if (!deviceId || session.deviceLinkConnectionStatus === 'disconnected') continue;
    const activity = readActivity(session.id, deviceId);
    if (!activity) continue;
    inputs.push({
      sessionId: session.id,
      deviceId,
      deviceName: session.deviceLinkDeviceName ?? null,
      title: session.title?.trim() || null,
      workingDir: session.workingDir,
      workspaceKind: session.workspaceKind,
      agentKind: session.agentKind,
      phase: activity.phase,
      detail: activity.compactDetail,
      ...(activity.completionNotification ? { completionNotification: activity.completionNotification } : {}),
      ...(activity.workingPhase ? { workingPhase: activity.workingPhase } : {}),
      ...(activity.interactionKind
        ? {
            interactionKind:
              activity.interactionKind as AgentIslandRemoteSessionInput['interactionKind'],
          }
        : {}),
    });
  }
  return inputs;
}

/** 主窗常驻挂载一次(MainLayout)。内容未变时不发 IPC。 */
export function useAgentIslandRemoteSessionsSync(): void {
  const remoteSessions = useRemoteProjectSessions();
  const selection = useEffectiveSelectedMachineId();
  const activityRevision = useRemoteSessionActivityRevision();
  const lastSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    const setRemoteSessions = window.electronAPI?.agentIsland?.setRemoteSessions;
    if (!setRemoteSessions) return;
    const inputs = buildAgentIslandRemoteSessionInputs(
      remoteSessions,
      selection,
      getRemoteSessionActivity,
    );
    const signature = JSON.stringify(inputs);
    if (signature === lastSignatureRef.current) return;
    lastSignatureRef.current = signature;
    void setRemoteSessions(inputs).catch(() => {
      // 下一次变化时重发完整列表。
      lastSignatureRef.current = null;
    });
  }, [remoteSessions, selection, activityRevision]);
}
