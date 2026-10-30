import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useCindyMakeState } from '@/lib/cindyMakeState';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { extractIpcError } from '@/utils/ipcError';

/** Optional actions above the ordinary editor; nothing runs until clicked. */
export function CindyMakeEditingActions({
  sessionId,
  messageId,
}: {
  sessionId: string;
  messageId: string;
}) {
  const { t } = useTranslation();
  const { upstreamMerge } = useCindyMakeState();
  const sourceMergePending =
    !!upstreamMerge &&
    upstreamMerge.status !== 'merged' &&
    (upstreamMerge.hasWorkspace || upstreamMerge.cancellationRequested);
  const owner = getDataOwnerGeneration();
  const [pending, setPending] = useState<'start' | 'build'>();
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const active = useRef(true);
  const current = () =>
    active.current && isDataOwnerGenerationCurrent(owner) && !getStickySessionDeviceId(sessionId);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const act = async (action: 'start' | 'build') => {
    if (busy.current || !current() || (action === 'build' && sourceMergePending)) return;
    busy.current = true;
    setPending(action);
    setError(undefined);
    try {
      await window.electronAPI.cindyMakeTest(sessionId, messageId, `resume-${action}`);
    } catch (error) {
      if (current()) {
        const code = extractIpcError(error)?.message.replace(/^\[PRECONDITION_FAILED\]\s*/, '');
        setError(
          code === 'changed' || code === 'environment' || code === 'stopFailed'
            ? code
            : 'unavailable',
        );
      }
    } finally {
      busy.current = false;
      if (current()) setPending(undefined);
    }
  };
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {error && (
        <p role="alert" className="mr-auto text-12 text-[var(--error-fg)]">
          {t('cindyMake.test.errors.' + error)}
        </p>
      )}
      <Button
        variant="secondary"
        disabled={!!pending}
        loading={pending === 'start'}
        onClick={() => void act('start')}
      >
        {t('cindyMake.test.start')}
      </Button>
      <Button
        variant="secondary"
        disabled={!!pending || sourceMergePending}
        loading={pending === 'build'}
        onClick={() => void act('build')}
      >
        {t('cindyMake.personal.generate')}
      </Button>
    </div>
  );
}
