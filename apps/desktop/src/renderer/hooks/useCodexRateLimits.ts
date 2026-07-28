import { useCallback, useEffect, useRef, useState } from 'react';

import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';

type CodexRateLimitsReader = () => Promise<MobileCodexRateLimitsResult>;
type CodexAuthStateSubscriber = (
  callback: (payload: { agentKind?: string }) => void,
) => () => void;

function readCodexRateLimitsReader(): CodexRateLimitsReader | undefined {
  return (window as unknown as {
    electronAPI?: {
      maker?: {
        usage?: {
          getCodexRateLimits?: CodexRateLimitsReader;
        };
      };
    };
  }).electronAPI?.maker?.usage?.getCodexRateLimits;
}

function readCodexAuthStateSubscriber(): CodexAuthStateSubscriber | undefined {
  return (window as unknown as {
    electronAPI?: {
      maker?: {
        auth?: {
          onStateChanged?: CodexAuthStateSubscriber;
        };
      };
    };
  }).electronAPI?.maker?.auth?.onStateChanged;
}

/** Missing/older preload and failed app-server reads both degrade to no extra tooltip rows. */
export async function readCodexRateLimitsSafely(
  reader: CodexRateLimitsReader | undefined,
): Promise<MobileCodexRateLimitsResult | null> {
  if (!reader) return null;
  try {
    return await reader();
  } catch {
    return null;
  }
}

export interface CodexRateLimitsState {
  snapshot: MobileCodexRateLimitsResult | null;
  /** Best-effort authoritative refetch, used when the tooltip is opened again. */
  refresh: () => void;
}

export function useCodexRateLimits(enabled: boolean): CodexRateLimitsState {
  const [snapshot, setSnapshot] = useState<MobileCodexRateLimitsResult | null>(null);
  const requestVersionRef = useRef(0);

  const refresh = useCallback(() => {
    if (!enabled) return;
    const requestVersion = ++requestVersionRef.current;
    void readCodexRateLimitsSafely(readCodexRateLimitsReader()).then((next) => {
      if (requestVersionRef.current === requestVersion) setSnapshot(next);
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      requestVersionRef.current += 1;
      setSnapshot(null);
      return;
    }

    refresh();
    const onStateChanged = readCodexAuthStateSubscriber();
    const unsubscribe = onStateChanged?.((payload) => {
      if (payload.agentKind !== 'codex') return;
      // Never show the previous account while the new authoritative read settles.
      requestVersionRef.current += 1;
      setSnapshot(null);
      refresh();
    });

    return () => {
      requestVersionRef.current += 1;
      unsubscribe?.();
    };
  }, [enabled, refresh]);

  return { snapshot, refresh };
}
