import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { ProviderView } from "@cindy/model-providers/registry";
import { isCodexBucketStale } from "@cindy/maker-shared/codex-usage-buckets";
import type { MobileCodexRateLimitsResult } from "@cindy/maker-shared/device-link-contract";
import {
  selectableSubscriptionAccount,
  subscriptionQuotaAccounts,
  subscriptionQuotaOverview,
} from "@cindy/maker-shared/subscription-selection";
import { isProviderShareAgentDeviceId } from "./providerShareAgentDevice";
import {
  useDeviceLink,
  subscribeRemoteSubscriptionAccountsChanged,
} from "@/device-link/DeviceLinkContext";
import {
  mobileQuotaSource,
  mobileWeeklyQuota,
  quotaCountdown,
  type QuotaSource,
} from "./mobileModelRowPresentation";

type QuotaValue = {
  source: QuotaSource;
  raw: unknown;
  accountIdentity?: string | null;
  members?: QuotaValue[];
};
type QuotaValues = Record<string, QuotaValue>;
type PickerPool = {
  boundAccountId?: string | null;
  providerId: string;
  configured: boolean;
  accounts: {
    id?: string;
    paused: boolean;
    status: string;
    running: number;
    limit: number;
    identity?: string;
    plan?: string;
    usage?: { claude?: unknown; codex?: { buckets: Record<string, unknown> } };
  }[];
};

/** Compare time-dependent presentation per account/bucket, never per model row. */
function quotaTimeKey(values: QuotaValues, now: number): string {
  const present = (source: QuotaSource, raw: unknown) => {
    const quota = mobileWeeklyQuota(source, raw, now);
    return (
      quota && [
        quota.remaining,
        quota.resetsAt,
        subscriptionQuotaOverview([quota], now).reset,
        quota.resetsAt === null
          ? null
          : quotaCountdown(quota.resetsAt, now, undefined, quota.windowMinutes),
      ]
    );
  };
  return JSON.stringify(
    Object.values(values)
      .flatMap((value) => (value.members?.length ? value.members : [value]))
      .map(({ source, raw }) => {
        if (source !== "codex") return present(source, raw);
        const data = raw as MobileCodexRateLimitsResult | null;
        if (!data?.rateLimits) return null;
        // The generic provider quota alone would miss model-specific reset times.
        return Object.values(
          data.rateLimitsByLimitId ?? { codex: data.rateLimits },
        ).map((bucket) => [
          isCodexBucketStale(bucket, now),
          present("codex", {
            rateLimits: bucket,
            rateLimitsByLimitId: { codex: bucket },
          }),
        ]);
      }),
  );
}

/** One read per account, never one per model. Responses are fenced by device/account/connection. */
export function useMobileModelQuotas(
  scope: string,
  visible: boolean,
  providers: readonly ProviderView[],
  remoteCatalogs: readonly {
    deviceId: string;
    providers: readonly ProviderView[];
    offline?: boolean;
  }[] = [],
  taskId?: string,
) {
  const { invoke, status, connectionEpoch } = useDeviceLink();
  const deviceId = (JSON.parse(scope) as [string, string])[1];
  const quotaKey = (targetDeviceId: string, providerId: string) =>
    targetDeviceId === deviceId
      ? providerId
      : JSON.stringify([targetDeviceId, providerId]);
  const sourceRows = [
    { deviceId, providers },
    ...remoteCatalogs.filter(
      (catalog) =>
        !catalog.offline && !isProviderShareAgentDeviceId(catalog.deviceId),
    ),
  ].flatMap((catalog) =>
    catalog.providers.flatMap((provider) => {
      const source = mobileQuotaSource(provider);
      return source
        ? [
            {
              id: provider.id,
              deviceId: catalog.deviceId,
              key: quotaKey(catalog.deviceId, provider.id),
              source,
              identity: provider.openAiAccount ?? provider.subscriptionAccount,
            },
          ]
        : [];
    }),
  );
  const sources = JSON.stringify([
    ...new Map(sourceRows.map((row) => [row.key, row])).values(),
  ]);
  const binding = JSON.stringify([
    scope,
    taskId,
    visible,
    status,
    connectionEpoch,
    sources,
  ]);
  const [state, setState] = useState<{
    binding: string;
    values: QuotaValues;
  }>();
  const [now, setNow] = useState(Date.now);
  const clockSnapshot = useRef({ values: {} as QuotaValues, now });
  clockSnapshot.current = {
    values: state?.binding === binding ? state.values : {},
    now,
  };
  useEffect(() => {
    if (!visible || status !== "online" || sources === "[]") return;
    let active = true;
    let pending = false;
    let queued = false;
    let epoch = 0;
    const refresh = async () => {
      if (AppState.currentState !== "active") return;
      if (pending) {
        queued = true;
        return;
      }
      pending = true;
      const current = epoch;
      const items = JSON.parse(sources) as {
        id: string;
        key: string;
        deviceId: string;
        source: QuotaSource;
      }[];
      const values: QuotaValues = {};
      await Promise.all(
        items.map(async ({ id, source, key, deviceId: sourceDeviceId }) => {
          try {
            const sourceTaskId =
              sourceDeviceId === deviceId ? taskId : undefined;
            // Same candidate rule as Desktop; identity and quota travel together.
            if (
              !isProviderShareAgentDeviceId(sourceDeviceId) &&
              ((id === "anthropic" && source === "claude") ||
                (id === "openai" && source === "codex"))
            ) {
              const pool = await invoke<PickerPool>(
                sourceDeviceId,
                "maker:subscription-accounts",
                [
                  {
                    action: "read",
                    providerId: id,
                    ...(sourceTaskId ? { taskId: sourceTaskId } : {}),
                  },
                ],
              ).catch((error: unknown) => {
                // Only an old host's exact missing-channel response permits legacy reads.
                if (String(error).includes("channel 'maker:subscription-accounts' not allowed remotely")) return undefined;
                throw error;
              });
              if (pool && (
                pool?.providerId !== id ||
                typeof pool.configured !== "boolean" ||
                !Array.isArray(pool.accounts)
              ))
                return;
              const account = pool ? selectableSubscriptionAccount(
                pool,
                !!sourceTaskId,
              ) : undefined;
              if (pool && account !== undefined) {
                const accountValue = (member: typeof account): QuotaValue => {
                  const buckets = member?.usage?.codex?.buckets;
                  return {
                    source,
                    accountIdentity: member?.identity?.trim() || null,
                    raw:
                      source === "claude"
                        ? (member?.usage?.claude ?? null)
                        : buckets
                          ? {
                              account: { planType: member?.plan ?? null },
                              rateLimits:
                                buckets.codex ??
                                Object.values(buckets)[0] ??
                                {},
                              rateLimitsByLimitId: buckets,
                            }
                          : null,
                  };
                };
                const members = subscriptionQuotaAccounts(pool);
                values[key] =
                  account && (pool.boundAccountId || members.length <= 1)
                    ? accountValue(account)
                    : {
                        source,
                        raw: null,
                        accountIdentity: null,
                        members: members.map(accountValue),
                      };
                return;
              }
            }
            const channel =
              source === "codex"
                ? "maker:usage:codex-rate-limits"
                : `maker:usage:${source}-subscription`;
            const raw = await invoke<unknown>(sourceDeviceId, channel, [id]);
            // Old hosts may ignore account selection. Only accept their default account response.
            const returned =
              raw && typeof raw === "object"
                ? (raw as { providerId?: string }).providerId
                : undefined;
            const builtin =
              source === "codex"
                ? "openai"
                : source === "claude"
                  ? "anthropic"
                  : "xai";
            if (returned !== id && (returned !== undefined || id !== builtin))
              return;
            values[key] = { source, raw };
          } catch {
            /* Unknown quota remains absent; other accounts still load. */
          }
        }),
      );
      if (active && current === epoch && AppState.currentState === "active") {
        setState((previous) => ({
          binding,
          // 短暂的 IPC/网络失败不应抹掉同一 binding 下最近一次成功额度。
          values:
            previous?.binding === binding
              ? { ...previous.values, ...values }
              : values,
        }));
        setNow(Date.now());
      }
      pending = false;
      if (queued && active) {
        queued = false;
        void refresh();
      }
    };
    let clock: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stopTimers = () => {
      clearInterval(clock);
      clearInterval(timer);
      clock = timer = undefined;
    };
    const resume = () => {
      stopTimers();
      if (AppState.currentState !== "active") return;
      void refresh();
      clock = setInterval(() => {
        if (AppState.currentState !== "active") return;
        const next = Date.now();
        const previous = clockSnapshot.current;
        if (
          quotaTimeKey(previous.values, previous.now) !==
          quotaTimeKey(previous.values, next)
        )
          setNow(next);
      }, 1000);
      timer = setInterval(() => void refresh(), 30000);
    };
    resume();
    const unsubscribeAccounts = subscribeRemoteSubscriptionAccountsChanged(
      (changedDeviceId) => {
        if (sourceRows.some((row) => row.deviceId === changedDeviceId)) {
          epoch++;
          setState(undefined);
          void refresh();
        }
      },
    );
    const app = AppState.addEventListener("change", (value) => {
      if (value === "active") resume();
      else stopTimers();
    });
    return () => {
      active = false;
      stopTimers();
      app.remove();
      unsubscribeAccounts();
    };
  }, [binding, invoke]);
  const pending: QuotaValues = Object.fromEntries(
    sourceRows.flatMap((row) =>
      !isProviderShareAgentDeviceId(row.deviceId) &&
      ((row.id === "anthropic" && row.source === "claude") ||
        (row.id === "openai" && row.source === "codex"))
        ? [[row.key, { source: row.source, raw: null, accountIdentity: null }]]
        : [],
    ),
  );
  const quotas = Object.fromEntries(
    Object.entries({
      ...pending,
      ...(state?.binding === binding ? state.values : {}),
    }).map(([id, v]) => [
      id,
      {
        ...mobileWeeklyQuota(v.source, v.raw, now),
        source: v.source,
        raw: v.raw,
        accountIdentity: v.accountIdentity,
        members: v.members?.map((member) => ({
          ...member,
          ...mobileWeeklyQuota(member.source, member.raw, now),
        })),
      },
    ]),
  );
  return {
    quotas,
    now,
    quotaOf: (targetDeviceId: string, providerId: string) =>
      quotas[quotaKey(targetDeviceId, providerId)],
  };
}
