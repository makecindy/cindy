import { useCallback, useEffect, useState } from "react";
import type { MobileMakerTransport } from "@/device-link/mobileMakerTransport";
import { normalizeRemoteMoney, type RemoteMoney } from "@/session/remoteMoney";
import type { RemoteSession } from "@/session/types";
import {
  readSessionMenuAccountUsage,
  type SessionMenuAccountUsage,
} from "./readSessionMenuAccountUsage";
import {
  isPreconditionFailedRemoteError,
  type MobileCodexRateLimitsResult,
} from "@cindy/maker-shared/device-link-contract";

export type SessionMenuUsageReader = Pick<
  MobileMakerTransport,
  "getSessionEstimatedValue" | "getCodexRateLimits" | "getAccountUsage"
>;

interface UsageState {
  account: SessionMenuAccountUsage | null;
  estimate: RemoteMoney | null;
  accountFailed: boolean;
  estimateFailed: boolean;
  loading: boolean;
}
const EMPTY: UsageState = {
  account: null,
  estimate: null,
  accountFailed: false,
  estimateFailed: false,
  loading: true,
};

/** Identity shared by menu snapshots; live counters do not change their owner. */
export function sessionMenuUsageScope(session: RemoteSession): string {
  return [
    session.deviceLinkDeviceId,
    session.id,
    session.model,
    session.providerId,
    session.agentKind,
    session.remoteHostId,
    session.clearedAt,
    session.runtimeGeneration,
  ].join("\0");
}

/** Only fetch while the sheet is visible. An effect owns both requests and their late results. */
export function useSessionMenuUsage(
  session: RemoteSession,
  reader: SessionMenuUsageReader,
  visible: boolean,
  codexRateLimits: MobileCodexRateLimitsResult | null = null,
) {
  const taskScope = [
    session.deviceLinkDeviceId,
    session.id,
    session.clearedAt,
  ].join("\0");
  const scope = sessionMenuUsageScope(session);
  const [stored, setStored] = useState<{
    scope: string;
    taskScope: string;
    value: UsageState;
  } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);
  // Parent control reads/resets replace codexRateLimits. Effect cleanup discards
  // pre-reset reads and refreshes immediately instead of waiting for polling.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let inFlight = false;
    const update = (patch: Partial<UsageState>) => {
      if (cancelled) return;
      setStored((previous) => ({
        scope,
        taskScope,
        value: {
          ...(previous?.scope === scope
            ? previous.value
            : {
                ...EMPTY,
                estimate:
                  previous?.taskScope === taskScope
                    ? previous.value.estimate
                    : null,
              }),
          ...patch,
        },
      }));
    };
    const read = async () => {
      if (inFlight) return;
      inFlight = true;
      update({ loading: true });
      await Promise.allSettled([
        readSessionMenuAccountUsage(session, reader).then(
          (account) => update({ account, accountFailed: false }),
          (error) =>
            update({
              accountFailed: true,
              ...(isPreconditionFailedRemoteError(error)
                ? { account: null }
                : {}),
            }),
        ),
        reader.getSessionEstimatedValue(session.id).then(
          (snapshot) =>
            update({
              estimate:
                normalizeRemoteMoney(snapshot.totalValueMoney) ??
                (typeof snapshot.totalValueUsd === "number" &&
                Number.isFinite(snapshot.totalValueUsd) &&
                snapshot.totalValueUsd >= 0
                  ? {
                      amount: snapshot.totalValueUsd,
                      currency: "USD",
                      approximate: true,
                      kind: "value-estimate",
                    }
                  : null),
              estimateFailed: false,
            }),
          () => update({ estimateFailed: true }),
        ),
      ]);
      update({ loading: false });
      inFlight = false;
    };
    void read();
    // Existing host readers refresh cached snapshots in the background. Re-read while visible
    // so their first cold response does not leave the sheet empty until it is reopened.
    const timer = setInterval(() => void read(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    scope,
    taskScope,
    reader,
    visible,
    refreshKey,
    session.id,
    codexRateLimits,
  ]);
  return {
    ...(stored?.scope === scope
      ? stored.value
      : {
          ...EMPTY,
          estimate:
            stored?.taskScope === taskScope ? stored.value.estimate : null,
        }),
    refresh,
  };
}
