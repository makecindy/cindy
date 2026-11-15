import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { createLogger } from '@/lib/logger';

const log = createLogger('AutomationSettingsRead');
const READ_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 1_000;
type ReadStatus = 'loading' | 'retrying' | 'error' | 'ready';

/** Independent, bounded reads for the Automation panel's initial configuration.
 * IPC cannot be cancelled: obsolete attempts may finish, but never commit state.
 * Each load gets one automatic retry; leaving the panel clears its timers.
 */
export function useAutomationSettingsRead<T>(name: string, load: () => Promise<T>) {
  const [state, setState] = useState<{
    owner: typeof load;
    value: T | null;
    status: ReadStatus;
  }>({ owner: load, value: null, status: 'loading' });
  const [revision, setRevision] = useState(0);
  const cancelRef = useRef<{ owner: typeof load; cancel: () => void } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      cancelled = true;
      clearTimeout(timer);
    };
    cancelRef.current = { owner: load, cancel };
    setState({ owner: load, value: null, status: 'loading' });

    const run = (isRetry: boolean) => {
      if (cancelled) return;
      const currentAttempt = ++attempt;
      const fail = (error: unknown) => {
        if (cancelled || currentAttempt !== attempt) return;
        ++attempt;
        clearTimeout(timer);
        log.warn('initial configuration read failed', { name, isRetry, error });
        setState({ owner: load, value: null, status: isRetry ? 'error' : 'retrying' });
        if (!isRetry) timer = setTimeout(() => run(true), RETRY_DELAY_MS);
      };
      timer = setTimeout(() => fail(new Error('SETTINGS_READ_TIMEOUT')), READ_TIMEOUT_MS);
      // Capture synchronous bridge errors as well as rejected IPC promises.
      void Promise.resolve()
        .then(() => (cancelled ? null : load()))
        .then((value) => {
          if (cancelled || currentAttempt !== attempt) return;
          clearTimeout(timer);
          setState({ owner: load, value, status: 'ready' });
        }, fail);
    };
    run(false);
    return () => {
      cancel();
      if (cancelRef.current?.cancel === cancel) cancelRef.current = null;
    };
  }, [load, name, revision]);

  const retry = useCallback(() => {
    if (cancelRef.current?.owner !== load) return;
    cancelRef.current.cancel();
    setState({ owner: load, value: null, status: 'loading' });
    setRevision((current) => current + 1);
  }, [load]);

  // A successful user action owns the value from here; an older initial read
  // or scheduled retry must not revert it.
  const setValue = useCallback(
    (next: SetStateAction<T | null>) => {
      // A previous project's save can settle after this hook has a new loader.
      // It must neither cancel the current read nor publish the old ownership.
      if (cancelRef.current?.owner !== load) return;
      cancelRef.current.cancel();
      setState((current) =>
        current.owner !== load
          ? current
          : {
              owner: load,
              value:
                typeof next === 'function'
                  ? (next as (previous: T | null) => T | null)(current.value)
                  : next,
              status: 'ready',
            },
      );
    },
    [load],
  );

  return {
    value: state.owner === load ? state.value : null,
    status: state.owner === load ? state.status : ('loading' as ReadStatus),
    setValue,
    retry,
  };
}
