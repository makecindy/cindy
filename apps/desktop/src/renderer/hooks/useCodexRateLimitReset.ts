import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import { summarizeCodexRateLimitReset } from '@cindy/maker-shared/session-controls';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';

/** Manual reset only. Main owns credit selection, account binding and retry idempotency. */
export function useCodexRateLimitReset(
  snapshot: MobileCodexRateLimitsResult | null,
  refresh: () => void,
  providerId = 'openai',
) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const current = useRef({ snapshot, providerId });
  current.current = { snapshot, providerId };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const summary = summarizeCodexRateLimitReset(snapshot, Date.now());

  const reset = useCallback(async () => {
    if (pending.current || !snapshot?.resetOffer || !summary?.canReset) return;
    pending.current = true;
    setBusy(true);
    const owner = getDataOwnerGeneration();
    const key = snapshot.resetOffer.idempotencyKey;
    const stillCurrent = () => mounted.current
      && isDataOwnerGenerationCurrent(owner)
      && current.current.providerId === providerId
      && current.current.snapshot?.resetOffer?.idempotencyKey === key;
    try {
      const account = [snapshot.account.email, snapshot.account.accountId]
        .filter(Boolean).join(' · ') || t('codexResets.currentAccount');
      const accepted = await confirm({
        presentation: 'standard',
        title: t('codexResets.confirmTitle'),
        description: t('codexResets.confirmBody', { account }),
        confirmText: t('codexResets.consumeOnce'),
      });
      if (!accepted || !stillCurrent()) return;
      if (snapshot.resetOffer.validUntil <= Date.now()) {
        refresh();
        toast.error(t('codexResets.offerExpired'));
        return;
      }
      const result = await window.electronAPI.maker.usage.consumeCodexRateLimitReset(key, providerId);
      // A refresh push can replace the offer while consume is in flight. The account
      // identity, rather than that old offer key, gates the terminal notification.
      if (!mounted.current || !isDataOwnerGenerationCurrent(owner)
        || current.current.providerId !== providerId
        || current.current.snapshot?.account.accountId !== snapshot.account.accountId
        || current.current.snapshot?.account.email !== snapshot.account.email) return;
      refresh();
      if (result.outcome === 'reset' || result.outcome === 'alreadyRedeemed') {
        toast.success(t('codexResets.resetDone'));
      } else {
        toast.info(t(result.outcome === 'noCredit' ? 'codexResets.noCredit' : 'codexResets.nothingToReset'));
      }
    } catch (error) {
      if (!stillCurrent()) return;
      const ipcError = extractIpcError(error);
      if (ipcError?.code === 'PRECONDITION_FAILED') {
        refresh();
        toast.error(t('codexResets.offerExpired'));
      } else {
        // The request may have reached the service. Main retains this same offer
        // for an idempotent retry; never mint a client-side replacement key.
        toast.error(t('codexResets.resetFailed'));
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [confirm, providerId, refresh, snapshot, summary?.canReset, t]);

  return { busy, canReset: summary?.canReset === true, reset };
}
