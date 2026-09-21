import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isSelectableVendor } from '@/lib/agentVendors';
import { toast } from '@/lib/toast';
import type { CindyMakeMergeState } from '../../../shared/cindyMakeMerge';
import type { CindyMakeTaskOptions } from '../../../shared/cindyMakeDoctor';

/** Fresh and retained conflicts use the same decision before starting a resolution task. */
export function useCindyMakeMergeResolution() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const navigate = useNavigate();
  const submitting = useRef(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const generation = getDataOwnerGeneration();
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    submitting.current = false;
    setBusy(false);
    return () => controller.abort();
  }, [generation.dataOwnerId, generation.generation]);

  const resolveMerge = async (state: CindyMakeMergeState, options?: CindyMakeTaskOptions) => {
    const signal = lifetime.current?.signal;
    if (submitting.current || !signal || signal.aborted) return;
    const owner = getDataOwnerGeneration();
    const isCurrent = () => !signal.aborted && isDataOwnerGenerationCurrent(owner);
    submitting.current = true;
    setBusy(true);
    try {
      let confirmed = !state.cancellationRequested && state.error !== 'cancelFailed';
      if (confirmed && !state.feature && !state.sessionId && state.status === 'conflict') {
        confirmed = await confirm(
          {
            presentation: 'standard',
            title: t('cindyMake.merge.conflictConfirm.title'),
            description: t('cindyMake.merge.conflictConfirm.description'),
            confirmText: t('cindyMake.merge.conflictConfirm.confirm'),
            cancelText: t('cindyMake.merge.conflictConfirm.cancel'),
          },
          signal,
        );
      }
      // Leaving Settings or changing accounts dismisses the prompt without discarding work.
      if (!isCurrent()) return;
      if (confirmed && !options) {
        const draftState = await import('@/state/newMakerDraft');
        if (!isCurrent()) return;
        const draft = draftState.getDraft();
        const vendor = isSelectableVendor(draft.vendor) ? draft.vendor : 'cc';
        const prefs = draft.lastByVendor[vendor];
        options = {
          agentKind: vendor,
          model: prefs.model,
          effort: prefs.effort,
          providerId: prefs.providerId,
          permissionMode: prefs.permissionMode,
          fastMode: draftState.getFastModeForModel(prefs.model),
          planModeEnabled: false,
        };
      }
      const result = await window.electronAPI.cindyMakeMerge({
        action: confirmed ? 'resolve' : 'cancel',
        operationId: state.id,
        ...(confirmed ? { createOptions: options } : {}),
      });
      if (!isCurrent()) return;
      if (result?.status === 'failed') {
        toast.error(
          t(
            result.error
              ? `cindyMake.merge.errors.${result.error}`
              : 'cindyMake.merge.status.failed',
          ),
        );
      } else if (confirmed) {
        if (result?.sessionId) navigate(`/cc-agent/${result.sessionId}`);
        else if (result?.status !== 'merged') toast.error(t('cindyMake.merge.errors.startFailed'));
      }
    } catch {
      if (isCurrent()) toast.error(t('cindyMake.merge.errors.unavailable'));
    } finally {
      if (lifetime.current?.signal === signal) {
        submitting.current = false;
        if (!signal.aborted) setBusy(false);
      }
    }
  };
  return { resolveMerge, busy };
}
