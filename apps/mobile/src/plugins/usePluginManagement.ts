import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useAuth } from "@/auth/AuthContext";
import { startFocusedTopicSubscription } from "@/device-link/focusedTopicSubscription";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import { createPluginManagementClient } from "./pluginManagementClient";
import {
  createPluginManagementController,
  type PluginManagementController,
  type PluginManagementState,
} from "./pluginManagementController";

/** A screen owns one target. Visibility changes pause polling without replaying writes. */
export function usePluginManagement(
  deviceId: string | undefined,
  online: boolean,
  visible: boolean,
  selectionKey?: string,
) {
  const { invoke, onRemoteResourceChanged, subscribe, unsubscribe, connectionEpoch } = useDeviceLink();
  const { accountGeneration } = useAuth();
  const [state, setState] = useState<PluginManagementState | null>(null);
  const [controller, setController] =
    useState<PluginManagementController | null>(null);
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const scope = JSON.stringify([deviceId, accountGeneration, selectionKey]);
  const liveScope = useRef(scope);
  liveScope.current = scope;
  const [publishedScope, setPublishedScope] = useState(scope);
  const availability = useRef(online && visible && foreground);
  availability.current = online && visible && foreground;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) =>
      setForeground(next === "active"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    setState(null);
    setPublishedScope(scope);
    if (!deviceId) {
      setController(null);
      return;
    }
    let disposed = false;
    const client = createPluginManagementClient({
      invoke,
      deviceId,
      isCurrent: () => !disposed && liveScope.current === scope,
    });
    const next = createPluginManagementController(client, {
      online: availability.current,
      onChange: (value) => {
        if (!disposed && liveScope.current === scope) setState(value);
      },
    });
    setController(next);
    setState(next.getState());
    void next.refresh();
    return () => {
      next.dispose();
      disposed = true;
    };
  }, [deviceId, accountGeneration, invoke, selectionKey]);
  useEffect(() => {
    controller?.setOnline(availability.current);
  }, [controller, online, visible, foreground]);
  useEffect(() => {
    if (!deviceId || !controller || !online || !visible || !foreground) return;
    const stop = startFocusedTopicSubscription({ deviceId, owner: `plugin-management:${scope}`,
      topic: 'sessions', subscribe, unsubscribe });
    const off = onRemoteResourceChanged((source, payload) => {
      if (source === deviceId && payload.collectionId === 'plugins') void controller.refresh();
    });
    return () => { off(); stop(); };
  }, [deviceId, controller, online, visible, foreground, onRemoteResourceChanged, subscribe, unsubscribe, connectionEpoch, scope]);
  return publishedScope === scope
    ? { state, controller }
    : { state: null, controller: null };
}
