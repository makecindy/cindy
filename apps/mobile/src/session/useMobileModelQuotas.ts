import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { ProviderView } from "@cindy/model-providers/registry";
import { isCodexBucketStale } from "@cindy/maker-shared/codex-usage-buckets";
import type { MobileCodexRateLimitsResult } from "@cindy/maker-shared/device-link-contract";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import {
  mobileQuotaSource,
  mobileWeeklyQuota,
  quotaCountdown,
  type QuotaSource,
} from "./mobileModelRowPresentation";

type QuotaValues = Record<string, { source: QuotaSource; raw: unknown }>;

/** Compare time-dependent presentation per account/bucket, never per model row. */
function quotaTimeKey(values: QuotaValues, now: number): string {
  const present = (source: QuotaSource, raw: unknown) => {
    const quota = mobileWeeklyQuota(source, raw, now);
    return (
      quota && [
        quota.remaining,
        quota.resetsAt,
        quota.resetsAt === null
          ? null
          : quotaCountdown(quota.resetsAt, now, undefined, quota.windowMinutes),
      ]
    );
  };
  return JSON.stringify(
    Object.values(values).map(({ source, raw }) => {
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
) {
  const { invoke, status, connectionEpoch } = useDeviceLink();
  const deviceId = (JSON.parse(scope) as [string, string])[1];
  const sources = JSON.stringify(
    providers.flatMap((p) => {
      const source = mobileQuotaSource(p);
      return source
        ? [
            {
              id: p.id,
              source,
              identity: p.openAiAccount ?? p.subscriptionAccount,
            },
          ]
        : [];
    }),
  );
  const binding = JSON.stringify([
    scope,
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
    const refresh = async () => {
      if (pending || AppState.currentState !== "active") return;
      pending = true;
      const items = JSON.parse(sources) as {
        id: string;
        source: QuotaSource;
      }[];
      const values: Record<string, { source: QuotaSource; raw: unknown }> = {};
      await Promise.all(
        items.map(async ({ id, source }) => {
          try {
            const channel =
              source === "codex"
                ? "maker:usage:codex-rate-limits"
                : `maker:usage:${source}-subscription`;
            const raw = await invoke<unknown>(deviceId, channel, [id]);
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
            values[id] = { source, raw };
          } catch {
            /* Unknown quota remains absent; other accounts still load. */
          }
        }),
      );
      if (active && AppState.currentState === "active") {
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
    const app = AppState.addEventListener("change", (value) => {
      if (value === "active") resume();
      else stopTimers();
    });
    return () => {
      active = false;
      stopTimers();
      app.remove();
    };
  }, [binding, invoke]);
  const quotas = Object.fromEntries(
    Object.entries(state?.binding === binding ? state.values : {}).map(
      ([id, v]) => [
        id,
        {
          ...mobileWeeklyQuota(v.source, v.raw, now),
          source: v.source,
          raw: v.raw,
        },
      ],
    ),
  );
  return { quotas, now };
}
