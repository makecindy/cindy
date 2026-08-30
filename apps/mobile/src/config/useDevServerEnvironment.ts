import { useCallback, useEffect, useState } from 'react';

import {
  getDevServerEnvironment,
  hydrateDevServerEnvironment,
  setDevServerEnvironment,
  subscribeDevServerEnvironment,
  type DevServerEnvironment,
} from './devServerEnvironment';

export function useDevServerEnvironment(): {
  environment: DevServerEnvironment;
  ready: boolean;
  setEnvironment: (next: DevServerEnvironment) => Promise<void>;
} {
  const [environment, setEnvironmentState] = useState(getDevServerEnvironment);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      if (!cancelled) setEnvironmentState(getDevServerEnvironment());
    };
    const unsubscribe = subscribeDevServerEnvironment(sync);
    void hydrateDevServerEnvironment().then(() => {
      if (!cancelled) {
        sync();
        setReady(true);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const setEnvironment = useCallback(async (next: DevServerEnvironment) => {
    await setDevServerEnvironment(next);
    setEnvironmentState(next);
  }, []);

  return { environment, ready, setEnvironment };
}
