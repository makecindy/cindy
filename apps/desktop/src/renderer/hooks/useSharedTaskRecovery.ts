import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { sharedTaskRecoveryFor } from '../../shared/sharedTaskRecovery';
import { extractUsageLimitRecoveryHint } from '../../shared/usageLimitRecovery';
import { makerChatStore } from '@/lib/makerChatStore';

/** One prompt per terminal failure; choosing only opens the existing, authorized route selector. */
export function useSharedTaskRecovery(input: { sessionId?: string; agentDeviceId?: string | null; agentKind?: string; error: string; active: boolean; handledUsageLimit?: boolean }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [manual, setManual] = useState<{ episode?: string; nonce: number }>({ nonce: 0 });
  const [picker, setPicker] = useState<{ sessionId?: string; nonce: number }>({ nonce: 0 });
  const [consumed, setConsumed] = useState<{ sessionId?: string; nonce: number }>({ nonce: 0 });
  const accountLimit = input.agentKind === 'codex'
    && extractUsageLimitRecoveryHint({ message: input.error })?.isAccountUsageLimit;
  const reason = input.handledUsageLimit || accountLimit ? undefined : sharedTaskRecoveryFor(input.error, input.agentDeviceId);
  const stage = /\[SHARED_TASK_STAGE_(owner|allocation|executor|capability|authorization)\]/.exec(input.error)?.[1] ?? 'unknown';
  // Live errors become persisted tail rows without creating a second episode.
  const episode = JSON.stringify([input.sessionId, input.agentDeviceId, input.error]);
  const request = manual.episode === episode ? manual.nonce : 0;
  const key = JSON.stringify([episode, request]);
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    const sessionId = input.sessionId;
    if (!input.error) shown.current = undefined;
    if (!input.active || !sessionId || !reason || shown.current === key
      || (request === 0 && makerChatStore.getSnapshot(sessionId).sharedTaskRecoveryAcknowledged === episode)) return;
    const abort = new AbortController();
    // StrictMode's discarded effect must not enqueue a second dialog.
    void Promise.resolve().then(async () => {
      if (abort.signal.aborted) return;
      const accepted = await confirm({
        title: t('sharedTaskRecovery.title'),
        description: `${t(`sharedTaskRecovery.stage.${stage}`)}\n\n${t(`sharedTaskRecovery.reason.${reason}`)}\n\n${t('sharedTaskRecovery.description')}`,
        textClassName: 'whitespace-pre-line',
        confirmText: t('sharedTaskRecovery.choose'),
        cancelText: t('sharedTaskRecovery.cancel'),
      }, abort.signal);
      if (abort.signal.aborted) return;
      shown.current = key;
      makerChatStore.acknowledgeSharedTaskRecovery(sessionId, episode);
      // The user's request is consumed by this answer. It cannot bypass an
      // acknowledgement on another task or revive when returning to this one.
      setManual(value => value.episode === episode && value.nonce === request
        ? { nonce: value.nonce } : value);
      if (accepted) setPicker(value => ({ sessionId, nonce: value.nonce + 1 }));
    });
    return () => abort.abort();
  }, [input.active, input.sessionId, key, episode, request, reason, stage, confirm, t]);
  const askAgain = useCallback(() => setManual(value => ({ episode, nonce: value.nonce + 1 })), [episode]);
  const consumeModelPickerRequest = useCallback((nonce: number) => {
    setConsumed({ sessionId: input.sessionId, nonce });
  }, [input.sessionId]);
  return { modelPickerRequest: picker.sessionId === input.sessionId
      && !(consumed.sessionId === input.sessionId && consumed.nonce === picker.nonce) ? picker.nonce : 0,
    consumeModelPickerRequest,
    askAgain: reason && input.active ? askAgain : undefined };
}
