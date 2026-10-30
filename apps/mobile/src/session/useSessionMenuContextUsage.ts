import { useCallback, useEffect, useMemo, useState } from "react";
import type { MobileMakerTransport } from "@/device-link/mobileMakerTransport";
import { formatRemoteError } from "@/device-link/remoteStatus";
import type { RemoteSession } from "./types";
import { buildContextUsageCreateOpts } from "./sessionControls";
import { sessionMenuUsageScope } from "./useSessionMenuUsage";

/** The info view alone owns its context snapshot; primary menus never bootstrap an engine. */
export function useSessionMenuContextUsage(
  session: RemoteSession,
  reader: Pick<MobileMakerTransport, "getContextUsage">,
  inspecting: boolean,
  onError: (error: string | null) => void,
) {
  const key = sessionMenuUsageScope(session);
  // Object identity also distinguishes A -> B -> A, including while the menu is closed.
  const owner = useMemo(() => ({ key, reader }), [key, reader]);
  const [stored, setStored] = useState<{
    owner: typeof owner;
    usage: unknown;
    loading: boolean;
  } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  useEffect(() => {
    if (!inspecting) return;
    let cancelled = false;
    setStored((previous) => ({
      owner,
      usage: previous?.owner === owner ? previous.usage : null,
      loading: true,
    }));
    onError(null);
    void reader
      .getContextUsage(session.id, buildContextUsageCreateOpts(session))
      .then(
        (usage) => {
          if (!cancelled) setStored({ owner, usage, loading: false });
        },
        (error) => {
          if (cancelled) return;
          setStored((previous) =>
            previous?.owner === owner
              ? { ...previous, loading: false }
              : previous,
          );
          onError(formatRemoteError(error));
        },
      );
    return () => {
      cancelled = true;
    };
    // Counter pushes must not restart inspection; owner captures the running configuration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, inspecting, refreshKey, onError]);

  return {
    contextUsage: stored?.owner === owner ? stored.usage : null,
    contextLoading: inspecting && (stored?.owner !== owner || stored.loading),
    refresh,
  };
}
