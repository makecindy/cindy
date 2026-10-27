/**
 * 把其它设备(device-link「我控制它」)任务的实时活动同步给 main,供本机灵动岛与
 * 桌面通知使用。
 * ---------------------------------------------------------------------------
 * 范围跟侧栏「任务范围」走:只同步当前范围内、侧栏会展示的远程任务;断线设备的快照
 * 可能停在旧状态,不同步。状态跃迁的判定(何时弹出 / 响铃 / 发通知)在 main 的岛状态机。
 * 伙伴属于账号、不受任务范围限制:主力电脑在那台设备上的伙伴,聊天活动也同步过来。
 */

import { useEffect, useRef } from 'react';
import { AGENT_ISLAND_REMOTE_SESSIONS_MAX, type AgentIslandRemoteSessionInput } from '../../../shared/agentIsland';
import type { Session } from '@/lib/ccAgent.types';
import type { RemoteBot } from '@/features/bots/remoteBotRoster';
import { useRemoteBots } from '@/features/bots/useRemoteBots';
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
  remoteBots: readonly RemoteBot[] = [],
): AgentIslandRemoteSessionInput[] {
  const inputs: AgentIslandRemoteSessionInput[] = [];
  // Companions belong to the account, not to a task scope: a companion whose main computer is
  // another device reports its chat here whatever machine the sidebar is scoped to. Its chat is
  // a hidden Session, so it is never also in the remote task list.
  for (const bot of remoteBots) {
    if (inputs.length >= AGENT_ISLAND_REMOTE_SESSIONS_MAX) break;
    if (!bot.sessionId || !bot.online) continue;
    const activity = readActivity(bot.sessionId, bot.deviceId);
    if (!activity) continue;
    inputs.push({
      ...remoteActivityInput(activity),
      sessionId: bot.sessionId,
      deviceId: bot.deviceId,
      deviceName: bot.deviceName || null,
      title: bot.name,
      workingDir: null,
      workspaceKind: null,
      agentKind: null,
      companion: { name: bot.name, avatar: bot.avatar, avatarColor: bot.avatarColor },
    });
  }
  const companionSessionIds = new Set(inputs.map((input) => input.sessionId));
  for (const session of selectVisibleSessions([], remoteSessions, selection)) {
    const deviceId = session.deviceLinkDeviceId;
    if (!deviceId || session.deviceLinkConnectionStatus === 'disconnected') continue;
    if (companionSessionIds.has(session.id)) continue;
    // Companions were added first, so the cap trims tasks, never a companion.
    if (inputs.length >= AGENT_ISLAND_REMOTE_SESSIONS_MAX) break;
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
      ...remoteActivityInput(activity),
    });
  }
  return inputs;
}

function remoteActivityInput(activity: RemoteSessionActivity): Pick<
  AgentIslandRemoteSessionInput,
  'phase' | 'detail' | 'completionNotification' | 'completionToken' | 'workingPhase' | 'interactionKind'
> {
  return {
    phase: activity.phase,
    ...(activity.completionToken ? { completionToken: activity.completionToken } : {}),
    detail: activity.compactDetail,
    ...(activity.completionNotification ? { completionNotification: activity.completionNotification } : {}),
    ...(activity.workingPhase ? { workingPhase: activity.workingPhase } : {}),
    ...(activity.interactionKind
      ? {
          interactionKind:
            activity.interactionKind as AgentIslandRemoteSessionInput['interactionKind'],
        }
      : {}),
  };
}

/** 主窗常驻挂载一次(MainLayout)。内容未变时不发 IPC。 */
export function useAgentIslandRemoteSessionsSync(): void {
  const remoteSessions = useRemoteProjectSessions();
  const remoteBots = useRemoteBots();
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
      remoteBots,
    );
    const signature = JSON.stringify(inputs);
    if (signature === lastSignatureRef.current) return;
    lastSignatureRef.current = signature;
    void setRemoteSessions(inputs).catch(() => {
      // 下一次变化时重发完整列表。
      lastSignatureRef.current = null;
    });
  }, [remoteSessions, remoteBots, selection, activityRevision]);
}
