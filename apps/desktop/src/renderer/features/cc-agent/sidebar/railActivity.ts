import type { AttentionKind } from '@/lib/sessionAttentionStore';
import { aggregateSessionLamps } from '../lib/sessionLampAggregation';
import type { RailLampSession } from './railPanelStore';

export { dotToneOf, remoteLampOf } from '../lib/sessionLampAggregation';

/** 与展开态共用灯语口径；保留每行设备来源及已知归属的远程启动状态。 */
export function aggregateRailActivity(
  rows: readonly RailLampSession[],
  runningSessionIds: ReadonlySet<string>,
  notifications: ReadonlySet<string>,
  attentionKinds: ReadonlyMap<string, AttentionKind>,
  urgentSessionIds: ReadonlySet<string>,
): { running: boolean; dotTone: AttentionKind | null } {
  return aggregateSessionLamps(rows, {
    runningSessionIds, notifications, attentionKinds, urgentSessionIds,
  });
}
