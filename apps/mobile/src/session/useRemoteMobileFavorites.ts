import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  MODEL_FAVORITES_GET,
  MODEL_FAVORITES_APPLY,
  parseModelFavorites,
  type RemoteModelFavorite,
  type ModelFavoriteMutation,
} from "@cindy/device-link";
import {
  useDeviceLink,
  subscribeRemoteFavoritesChanged,
} from "@/device-link/DeviceLinkContext";
import { startFocusedTopicSubscription } from "@/device-link/focusedTopicSubscription";
import type { MobileModelFavorite } from "./unifiedMobileModels";

export function mobileFavorite(item: RemoteModelFavorite): MobileModelFavorite {
  return {
    ...item,
    agent: item.agent === "cc" ? "claude-code" : item.agent,
    effort: item.effort ?? "",
    fast: !!item.fast,
  };
}
/** Convert exactly one UI action to an operation, never send a stale full table. */
export function mobileFavoriteMutation(
  before: RemoteModelFavorite[],
  after: MobileModelFavorite[],
): ModelFavoriteMutation | null {
  const old = before.map(mobileFavorite);
  const changed = after.filter((item) => {
    const prior = old.find((value) => value.uid === item.uid);
    return (
      !prior ||
      item.providerId !== prior.providerId ||
      item.modelId !== prior.modelId ||
      item.agent !== prior.agent ||
      item.effort !== prior.effort ||
      item.fast !== prior.fast
    );
  });
  const removed = before.filter(
    (item) => !after.some((value) => value.uid === item.uid),
  );
  if (!changed.length && !removed.length) return null;
  if (changed.length + removed.length !== 1)
    throw new Error("Only one favorite may change at a time");
  if (removed.length) return { kind: "remove", expected: removed[0]! };
  const next = changed[0]!;
  const item = {
    providerId: next.providerId,
    modelId: next.modelId,
    agent: next.agent === "claude-code" ? ("cc" as const) : next.agent,
    ...(next.effort ? { effort: next.effort } : {}),
    ...(next.fast ? { fast: true as const } : {}),
  };
  const expected = before.find((value) => value.uid === next.uid);
  return expected ? { kind: "update", expected, item } : { kind: "add", item };
}
export function useRemoteMobileFavorites(scope: string, visible: boolean) {
  const { invoke, connectionEpoch, status, subscribe, unsubscribe } =
    useDeviceLink();
  const deviceId = (JSON.parse(scope) as [string, string])[1];
  const binding = JSON.stringify([scope, connectionEpoch, status, visible]);
  const current = useRef(binding);
  current.current = binding;
  const seq = useRef(0);
  const [state, setState] = useState<{
    binding: string;
    items: RemoteModelFavorite[];
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const valid = () => current.current === binding;
  const refresh = async () => {
    if (!visible || status !== "online") return;
    const request = ++seq.current;
    try {
      const items = parseModelFavorites(
        await invoke(deviceId, MODEL_FAVORITES_GET, []),
      );
      if (valid() && seq.current === request) {
        setState({ binding, items });
        setError(null);
      }
    } catch (error) {
      if (valid() && seq.current === request) {
        setState(null);
        setError(error);
      }
    }
  };
  useEffect(() => {
    if (!visible || status !== "online") return;
    void refresh();
    const off = subscribeRemoteFavoritesChanged((source) => {
      if (source === deviceId) void refresh();
    });
    const stop = startFocusedTopicSubscription({
      deviceId,
      owner: "model-favorites",
      topic: "sessions",
      subscribe,
      unsubscribe,
    });
    const app = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => {
      off();
      stop();
      app.remove();
      ++seq.current;
    };
  }, [binding, invoke, subscribe, unsubscribe]);
  const items = state?.binding === binding ? state.items : [];
  return {
    items: items.map(mobileFavorite),
    error,
    save: async (next: MobileModelFavorite[]) => {
      const mutation = mobileFavoriteMutation(items, next);
      if (!mutation) return;
      if (!valid() || state?.binding !== binding || status !== "online")
        throw new Error("Favorites not ready");
      ++seq.current;
      try {
        await invoke(deviceId, MODEL_FAVORITES_APPLY, [mutation]);
        if (!valid()) throw new Error("Device changed");
        await refresh();
      } catch (error) {
        if (valid()) {
          setError(error);
          void refresh();
        }
        throw error;
      }
    },
  };
}
