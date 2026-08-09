import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useAuth } from '@/contexts/AuthContext';
import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import type { PluginRecoveryProposal } from '../../../shared/pluginMarket';

const log = createLogger('PluginRecoveryPromptHost');

function RecoveryCandidateList({ proposal }: { proposal: PluginRecoveryProposal }) {
  return (
    <ul className="space-y-2">
      {proposal.candidates.map((candidate) => (
        <li
          key={candidate.candidateId}
          className="rounded-lg border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-2"
        >
          <div className="text-base font-medium text-[var(--text-primary)]">{candidate.name}</div>
          <div className="mt-0.5 break-all text-13 text-[var(--text-secondary)]">
            {candidate.ghostId} · {candidate.version}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Main-owned, owner-scoped one-time recovery decision host. */
export function PluginRecoveryPromptHost() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const { canEnterApp, dataOwnerId, mode } = useAuth();
  const activeProposalRef = useRef<string | null>(null);

  useEffect(() => {
    if (!canEnterApp || !dataOwnerId || mode === 'signed-out') return undefined;
    let cancelled = false;
    const controller = new AbortController();

    const showPending = async (): Promise<void> => {
      try {
        const status = await window.electronAPI.pluginMarket.recoveryStatus();
        if (
          cancelled ||
          status.state !== 'pending' ||
          !status.proposal ||
          activeProposalRef.current === status.proposal.proposalId
        ) {
          return;
        }
        const proposal = status.proposal;
        activeProposalRef.current = proposal.proposalId;
        const restore = await confirm({
          title: t('settings.ghosts.recovery.prompt.title', {
            count: proposal.candidates.length,
          }),
          description: t('settings.ghosts.recovery.prompt.description'),
          content: <RecoveryCandidateList proposal={proposal} />,
          maxWidth: 520,
          confirmText: t('settings.ghosts.recovery.prompt.restore'),
          cancelText: t('settings.ghosts.recovery.prompt.keep'),
          autoFocusConfirm: true,
          requireExplicitChoice: true,
          signal: controller.signal,
        });
        if (cancelled || controller.signal.aborted) return;
        const result = await window.electronAPI.pluginMarket.resolveRecovery(
          proposal.proposalId,
          restore ? 'restore' : 'keep',
        );
        window.dispatchEvent(new Event('plugin-market:recovery-resolved'));
        if (result.reviewCount > 0) {
          toast.info(
            t('settings.ghosts.recovery.prompt.reviewRemaining', {
              count: result.reviewCount,
            }),
            { duration: 8000 },
          );
        }
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) {
          log.warn('failed to resolve Plugin recovery:', error);
          toast.error(t('settings.ghosts.recovery.prompt.failed'));
        }
      } finally {
        activeProposalRef.current = null;
      }
    };

    const unsubscribe = window.electronAPI.pluginMarket.onRecoveryAvailable(() => {
      void showPending();
    });
    void showPending();
    return () => {
      cancelled = true;
      controller.abort();
      activeProposalRef.current = null;
      unsubscribe();
    };
  }, [canEnterApp, confirm, dataOwnerId, mode, t]);

  return null;
}
