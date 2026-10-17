import { useMemo } from 'react';
import { UsersRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { AttentionDot } from '@/components/sidebar/AttentionDot';
import { useWorkerProjection } from '@/features/cc-agent/hooks/workerProjectionStore';
import { useWorkerAttentionSnapshot } from '@/features/cc-agent/lib/workerAttentionStore';
import {
  useSessionsAttentionUrgentKind,
  type AttentionKind,
} from '@/lib/sessionAttentionStore';

/**
 * 多个 Worker 时取最高一档:出错(红)> 等待确认(蓝)> 完成未读(绿)。
 * 出错 / 等待确认跟随 Worker 自己的 attention,tab 激活时同样显示(与侧栏 Lead 行同口径);
 * 完成未读沿用原语义,tab 激活即视为看到。
 */
export function resolveOrcaWorkersTabTone({
  urgentKind,
  hasDoneAttention,
  active,
}: {
  urgentKind: 'error' | 'awaiting' | undefined;
  hasDoneAttention: boolean;
  active: boolean;
}): AttentionKind | null {
  if (urgentKind) return urgentKind;
  return hasDoneAttention && !active ? 'done' : null;
}

export function OrcaWorkersAttentionIcon({
  sessionId,
  active,
}: {
  sessionId: string | null;
  active: boolean;
}) {
  const { t } = useTranslation();
  const attention = useWorkerAttentionSnapshot();
  const projection = useWorkerProjection(sessionId ?? '');
  const workerSessionIds = useMemo(
    () => (sessionId ? projection.workers.map((worker) => worker.sessionId) : []),
    [sessionId, projection.workers],
  );
  const urgentKind = useSessionsAttentionUrgentKind(workerSessionIds);
  const hasDoneAttention = Boolean(
    sessionId && projection.workers.some((worker) => attention.has(worker.workerId)),
  );
  const tone = resolveOrcaWorkersTabTone({ urgentKind, hasDoneAttention, active });
  const toneLabel =
    tone === 'error'
      ? t('orca.rolePill.errorBadgeAria')
      : tone === 'awaiting'
        ? t('orca.rolePill.awaitingBadgeAria')
        : t('orca.rolePill.unread');

  return (
    <span className="relative inline-flex">
      <UsersRound size={13} />
      {tone && (
        <span
          aria-label={toneLabel}
          className="absolute -right-[3px] -top-[3px] inline-flex rounded-full"
          style={{ boxShadow: '0 0 0 1.5px var(--surface)' }}
        >
          <AttentionDot size={6} tone={tone} />
        </span>
      )}
    </span>
  );
}
