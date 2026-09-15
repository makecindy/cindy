/**
 * sessionLampAggregation — 会话「灯语」聚合的唯一事实源
 * ---------------------------------------------------------------------------
 * 灯语 = running(呼吸橙)+ 未读点 tone(红 error > 蓝 awaiting > 绿 done,
 * AttentionDot 色表)。聚合口径:
 *   - 本地链路:runningSessionIds / notifications + attentionKinds + urgent
 *     (定时任务失败未读按 error 提升,与 SessionItem.isUrgentFromContext 同语义);
 *   - device-link 远程镜像(remoteLampOf):本地链路对被控端后台会话是盲区,
 *     必须并入,否则「行亮而入口不亮」(codex review,rail 聚合灯先例)。
 *
 * 消费方:rail 段钮 / rail 浮层面板项目行(先例),以及展开态的项目行、
 * 「对话」组行、设备段头(2026-08 用户反馈:未读绿点只在最底层会话行,上层
 * 文件夹与顶层设备头没有灯,多设备下找未读要逐层展开翻找)。三处聚合必须
 * 与其下**实际渲染的行集合**一致——灯亮进去一定找得到亮的行。
 *
 * 注意:remoteLampOf 直接读 remoteSessionActivityStore(非 React 状态),
 * 组件里调用聚合时必须把 useRemoteSessionActivityRevision() 纳入 memo/callback
 * 依赖,否则跟不上被控端 relay 推送(RailNav / CCAgentSidebarUpper 同款先例)。
 */

import { getRemoteSessionActivity } from '@/features/device-link/remoteSessionActivityStore';
import type { AttentionKind } from '@/lib/sessionAttentionStore';

const TONE_RANK: Record<AttentionKind, number> = { error: 3, awaiting: 2, done: 1 };

/** device-link 远程会话的灯语补充。phase → 灯语映射与 SessionItem.remoteRightStatus
 *  同一张表;镜像里 completed/error 条目仅在未读(attention)期间存在,存在即未读。 */
export function remoteLampOf(id: string): { running: boolean; tone: AttentionKind | null } | null {
  const remote = getRemoteSessionActivity(id);
  if (!remote) return null;
  if (remote.phase === 'running') return { running: true, tone: null };
  return {
    running: false,
    tone:
      remote.phase === 'error' ? 'error' : remote.phase === 'needs-interaction' ? 'awaiting' : 'done',
  };
}

/** 单会话本地未读点 tone;未读集合之外返回 null。 */
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

export interface SessionLampContext {
  runningSessionIds: ReadonlySet<string>;
  notifications: ReadonlySet<string>;
  attentionKinds: ReadonlyMap<string, AttentionKind>;
  urgentSessionIds: ReadonlySet<string>;
}

export interface SessionLampAggregate {
  running: boolean;
  dotTone: AttentionKind | null;
}

/** 聚合一组会话 id 的灯语:任一 running → running;未读点取最高优先级 tone。 */
export function aggregateSessionLamps(
  ids: Iterable<string>,
  ctx: SessionLampContext,
): SessionLampAggregate {
  let running = false;
  let best: AttentionKind | null = null;
  const consider = (tone: AttentionKind | null) => {
    if (tone && (!best || TONE_RANK[tone] > TONE_RANK[best])) best = tone;
  };
  for (const id of ids) {
    if (ctx.runningSessionIds.has(id)) running = true;
    consider(dotToneOf(id, ctx.notifications, ctx.attentionKinds, ctx.urgentSessionIds));
    const remote = remoteLampOf(id);
    if (remote) {
      if (remote.running) running = true;
      consider(remote.tone);
    }
  }
  return { running, dotTone: best };
}
