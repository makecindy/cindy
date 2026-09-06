import { UsersRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { AttentionDot } from '@/components/sidebar/AttentionDot';
import { useWorkerProjection } from '@/features/cc-agent/hooks/workerProjectionStore';
import { useWorkerAttentionSnapshot } from '@/features/cc-agent/lib/workerAttentionStore';

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
  const attentionKind = sessionId
    ? projection.workers.reduce<'permission' | 'done' | null>((current, worker) => {
        const reasons = attention.get(worker.workerId);
        if (reasons?.some((reason) => reason.kind === 'permission')) return 'permission';
        if (current === null && reasons?.some((reason) => reason.kind === 'done')) return 'done';
        return current;
      }, null)
    : null;

  return (
    <span className="relative inline-flex">
      <UsersRound size={13} />
      {!active && attentionKind && (
        <span
          aria-label={
            attentionKind === 'permission'
              ? t('agentIsland.native.awaitingPermission')
              : t('orca.rolePill.unread')
          }
          className="absolute -right-[3px] -top-[3px] inline-flex rounded-full"
          style={{ boxShadow: '0 0 0 1.5px var(--surface)' }}
        >
          <AttentionDot size={6} tone={attentionKind === 'permission' ? 'awaiting' : 'done'} />
        </span>
      )}
    </span>
  );
}
