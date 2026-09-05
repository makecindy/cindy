import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';

const log = createLogger('useInterruptedTurnAutoResumeSettings');

interface InterruptedTurnAutoResumeState {
  enabled: boolean;
  isCustomized: boolean;
  defaultEnabled: boolean;
}

const DEFAULT_STATE: InterruptedTurnAutoResumeState = {
  enabled: true,
  isCustomized: false,
  defaultEnabled: true,
};

export function useInterruptedTurnAutoResumeSettings() {
  const { t } = useTranslation();
  const [state, setState] = useState(DEFAULT_STATE);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  const hasLocalEdit = useRef(false);

  useEffect(() => {
    mounted.current = true;
    void window.electronAPI?.maker
      ?.interruptedTurnAutoResumeGet()
      .then((next) => {
        if (mounted.current && !hasLocalEdit.current) setState(next);
      })
      .catch((error) => log.warn('load interrupted turn auto-resume setting failed', error))
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, []);

  const commit = useCallback(
    async (operation: () => Promise<InterruptedTurnAutoResumeState>) => {
      if (loading || pending) return;
      hasLocalEdit.current = true;
      setPending(true);
      try {
        const next = await operation();
        if (mounted.current) setState(next);
      } catch (error) {
        log.warn('update interrupted turn auto-resume setting failed', error);
        toast.error(t('settings.windowBehavior.interruptedAutoResume.saveFailed'));
      } finally {
        if (mounted.current) setPending(false);
      }
    },
    [loading, pending, t],
  );

  const setEnabled = useCallback(
    (enabled: boolean) =>
      commit(() => window.electronAPI.maker.interruptedTurnAutoResumeSet(enabled)),
    [commit],
  );
  const reset = useCallback(
    () => commit(() => window.electronAPI.maker.interruptedTurnAutoResumeReset()),
    [commit],
  );

  return { ...state, loading, pending, setEnabled, reset };
}
