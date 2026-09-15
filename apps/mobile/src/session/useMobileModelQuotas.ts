import { useEffect, useState } from "react";
import { AppState } from "react-native";
import type { ProviderView } from "@cindy/model-providers/registry";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import {
  mobileQuotaSource,
  mobileWeeklyQuota,
  type QuotaSource,
} from "./mobileModelRowPresentation";

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
    values: Record<string, { source: QuotaSource; raw: unknown }>;
  }>();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!visible || status !== "online") return;
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending || AppState.currentState === "background") return;
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
      if (active) {
        setState({ binding, values });
        setNow(Date.now());
      }
      pending = false;
    };
    void refresh();
    const clock = setInterval(() => { if(AppState.currentState !== "background") setNow(Date.now()); },1000);
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 30000);
    const app = AppState.addEventListener("change", (value) => {
      if (value === "active") void refresh();
    });
    return () => {
      active = false;
      clearInterval(timer);
      clearInterval(clock);
      app.remove();
    };
  }, [binding, invoke]);
  const quotas = Object.fromEntries(
    Object.entries(state?.binding === binding ? state.values : {}).map(
      ([id, v]) => [id, mobileWeeklyQuota(v.source, v.raw, now)],
    ),
  );
  return { quotas, now };
}
