import { useEffect, useState } from 'react';

import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';

type CodexRateLimitsReader = () => Promise<MobileCodexRateLimitsResult>;

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

export function useCodexRateLimits(enabled: boolean): MobileCodexRateLimitsResult | null {
  const [snapshot, setSnapshot] = useState<MobileCodexRateLimitsResult | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      return;
    }

    let cancelled = false;
    void readCodexRateLimitsSafely(readCodexRateLimitsReader()).then((next) => {
      if (!cancelled) setSnapshot(next);
    });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return snapshot;
}
