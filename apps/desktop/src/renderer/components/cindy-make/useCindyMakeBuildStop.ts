import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import type { CindyMakeHistoryState } from '../../../shared/cindyMakeHistory';

/** One confirmation for the exact build, dismissed on owner/build change or unmount. */
export function useCindyMakeBuildStop(buildId: string | undefined) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const owner = getDataOwnerGeneration();
  const lifetime = useRef<AbortController | undefined>(undefined);
  const submitting = useRef(false);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    submitting.current = false;
    setStopping(false);
    return () => controller.abort();
  }, [buildId, owner.dataOwnerId, owner.generation]);
  const stop = async (
    current: () => boolean,
    update: (state: CindyMakeHistoryState) => void,
    failed: () => void,
  ) => {
    const signal = lifetime.current?.signal;
    if (!buildId || submitting.current || !signal || signal.aborted || !current()) return;
    const valid = () => !signal.aborted && isDataOwnerGenerationCurrent(owner) && current();
    submitting.current = true;
    try {
      const accepted = await confirm(
        {
          presentation: 'standard',
          title: t('cindyMake.history.stopConfirm.title'),
          description: t('cindyMake.history.stopConfirm.description'),
          confirmText: t('cindyMake.history.stop'),
          confirmVariant: 'destructive',
        },
        signal,
      );
      if (!accepted || !valid()) return;
      setStopping(true);
      const state = await window.electronAPI.cancelCindyMakePersonal(buildId);
      if (valid()) update(state);
    } catch {
      if (valid()) failed();
    } finally {
      if (lifetime.current?.signal === signal) {
        submitting.current = false;
        if (!signal.aborted) setStopping(false);
      }
    }
  };
  return { stop, stopping };
}
