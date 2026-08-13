import { UsersRound } from 'lucide-react';

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
  const attention = useWorkerAttentionSnapshot();
  const projection = useWorkerProjection(sessionId ?? '');
  const hasAttention = Boolean(
    sessionId && projection.workers.some((worker) => attention.has(worker.workerId)),
  );

  return (
    <span className="relative inline-flex">
      <UsersRound size={13} />
      {!active && hasAttention && (
        <span
          aria-label="unread"
          className="absolute -right-[3px] -top-[3px] inline-flex rounded-full"
          style={{ boxShadow: '0 0 0 1.5px var(--surface)' }}
        >
          <AttentionDot size={6} />
        </span>
      )}
    </span>
  );
}
