import type { AttentionKind } from '@/lib/sessionAttentionStore';
import { getRemoteSessionActivity } from '@/features/device-link/remoteSessionActivityStore';
import type { RailLampSession } from './railPanelStore';

const TONE_RANK: Record<AttentionKind, number> = { error: 3, awaiting: 2, done: 1 };

export function dotToneOf(
  id: string,
  notifications: ReadonlySet<string>,
  attentionKinds: ReadonlyMap<string, AttentionKind>,
  urgentSessionIds: ReadonlySet<string>,
): AttentionKind | null {
  if (!notifications.has(id)) return null;
  const kind = attentionKinds.get(id);
  if (kind === 'error' || urgentSessionIds.has(id)) return 'error';
  if (kind === 'awaiting') return 'awaiting';
  return 'done';
}

/** device-link 远程会话的灯语补充:本地 running/attention 链路对被控端后台会话
 *  是盲区,SessionItem 行内状态由 remoteSessionActivityStore 驱动 —— rail 聚合灯
 *  与置顶瓷砖必须并入同一镜像,否则远程会话「行亮而入口不亮」(codex review)。
 *  phase → 灯语映射与 SessionItem.remoteRightStatus 同一张表;镜像里 completed/
 *  error 条目仅在未读(attention)期间存在,存在即未读。 */
export function remoteLampOf(
  id: string,
  deviceId: string | null | undefined,
): { running: boolean; tone: AttentionKind | null } | null {
  const remote = getRemoteSessionActivity(id, deviceId);
  if (!remote) return null;
  if (remote.phase === 'running') return { running: true, tone: null };
  return {
    running: false,
    tone:
      remote.phase === 'error'
        ? 'error'
        : remote.phase === 'needs-interaction'
          ? 'awaiting'
          : 'done',
  };
}

/** 保留每行设备来源，禁止聚合前降为仅含任务 ID 的映射。 */
export function aggregateRailActivity(
  rows: readonly RailLampSession[],
  runningSessionIds: ReadonlySet<string>,
  notifications: ReadonlySet<string>,
  attentionKinds: ReadonlyMap<string, AttentionKind>,
  urgentSessionIds: ReadonlySet<string>,
): { running: boolean; dotTone: AttentionKind | null } {
  let running = false;
  let best: AttentionKind | null = null;
  const consider = (tone: AttentionKind | null) => {
    if (tone && (!best || TONE_RANK[tone] > TONE_RANK[best])) best = tone;
  };
  for (const { id, deviceLinkDeviceId } of rows) {
    if (!deviceLinkDeviceId && runningSessionIds.has(id)) running = true;
    consider(dotToneOf(id, notifications, attentionKinds, urgentSessionIds));
    const remote = remoteLampOf(id, deviceLinkDeviceId);
    if (remote) {
      if (remote.running) running = true;
      consider(remote.tone);
    }
  }
  return { running, dotTone: best };
}
