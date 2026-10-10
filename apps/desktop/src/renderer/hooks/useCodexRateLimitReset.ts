import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MobileCodexRateLimitResetCredit, MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import { summarizeCodexRateLimitReset } from '@cindy/maker-shared/session-controls';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { formatQuotaResetAt } from '@/components/status/usageCardModel';
import { extractIpcError } from '@/utils/ipcError';

/** Manual reset only. Main owns credit selection, account binding and retry idempotency. */
export function useCodexRateLimitReset(
  snapshot: MobileCodexRateLimitsResult | null,
  refresh: () => void,
  providerId = 'openai',
) {
  const { t, i18n } = useTranslation();
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

  const reset = useCallback(async (credit?: MobileCodexRateLimitResetCredit) => {
    const offer = credit ? credit.resetOffer : snapshot?.resetOffer;
    if (pending.current || !snapshot || !offer || !summary?.canReset) return;
    pending.current = true;
    setBusy(true);
    const owner = getDataOwnerGeneration();
    const key = offer.idempotencyKey;
    const stillCurrent = () => mounted.current
      && isDataOwnerGenerationCurrent(owner)
      && current.current.providerId === providerId
      && (current.current.snapshot?.resetOffer?.idempotencyKey === key
        || current.current.snapshot?.rateLimitResetCredits?.credits?.some(row => row.resetOffer?.idempotencyKey === key));
    try {
      const account = [snapshot.account.email, snapshot.account.accountId]
        .filter(Boolean).join(' · ') || t('codexResets.currentAccount');
      const accepted = await confirm({
        presentation: 'standard',
        title: t('codexResets.confirmTitle'),
        description: credit ? t('codexResets.confirmSelectedBody', {
          account, title: credit.title || t('codexResets.fullReset'),
          expiry: formatQuotaResetAt(credit.expiresAt, Date.now(), i18n?.resolvedLanguage ?? i18n?.language)
            || t('codexResets.expiryUnknown'),
        }) : t('codexResets.confirmBody', { account }),
        confirmText: t('codexResets.consumeOnce'),
      });
      if (!accepted || !stillCurrent()
        || !summarizeCodexRateLimitReset(current.current.snapshot, Date.now())?.canReset) return;
      if (offer.validUntil <= Date.now()) {
        refresh();
        toast.error(t('codexResets.offerExpired'));
        return;
      }
      const result = await window.electronAPI.maker.usage.consumeCodexRateLimitReset(key, providerId);
      // Refresh may replace the offer mid-consume; gate the result by account identity.
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
        // An ambiguous result must retry the same Main-issued key.
        toast.error(t('codexResets.resetFailed'));
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [confirm, providerId, refresh, snapshot, summary?.canReset, t, i18n?.resolvedLanguage, i18n?.language]);

  return { busy, canReset: summary?.canReset === true, reset };
}
