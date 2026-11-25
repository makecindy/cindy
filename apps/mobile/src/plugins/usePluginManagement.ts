import { useEffect, useRef, useState } from "react";
import { usePluginPromptReads } from './PluginPromptReadsContext';
import { AppState } from "react-native";
import { useAuth } from "@/auth/AuthContext";
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from "@/auth/authOwnerGeneration";
import { startFocusedTopicSubscription } from "@/device-link/focusedTopicSubscription";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import { createPluginManagementClient } from "./pluginManagementClient";
import {
  createPluginManagementController,
  nextDetachedStep,
  type PluginManagementController,
  type PluginManagementState,
} from "./pluginManagementController";

/**
 * Controllers whose view went away while their operation was still under way (maintainer review 15:37): switching to
 * another plugin's detail, opening the README and coming back, leaving the page. The operation keeps its page slot and
 * is followed to its end here, so no second operation starts beside it; the same view coming back takes it again.
 * - Waiting for this phone's answer (a confirmation not answered): leaving cancels it, as before; the controller
 *   stays until the cancel settles.
 * - An unknown result whose automatic lookups stopped, or a cancel that could not be sent: nobody here can move it on,
 *   so it is let go (the slot is released, the controller disposed); the Host is never asked twice.
 * - A new account drops them all.
 */
interface ManagementEntry {
  controller: PluginManagementController;
  /** The hook instance showing it; none while retained. */
  listener?: (value: PluginManagementState) => void;
  owner: ReturnType<typeof getMobileAuthOwner>;
  dead: boolean;
  stopWatching?: () => void;
}
const retained = new Map<string, ManagementEntry>();
function letGo(scope: string, entry: ManagementEntry) {
  if (retained.get(scope) === entry) retained.delete(scope);
  entry.stopWatching?.();
  entry.stopWatching = undefined;
  entry.dead = true;
  entry.controller.dispose();
}
function retain(scope: string, entry: ManagementEntry) {
  const previous = retained.get(scope);
  if (previous && previous !== entry) letGo(scope, previous);
  retained.set(scope, entry);
  const review = () => {
    if (entry.listener || entry.dead) return;
    if (!isMobileAuthOwnerCurrent(entry.owner)) { letGo(scope, entry); return; }
    const step = nextDetachedStep(entry.controller);
    if (step === "letGo") letGo(scope, entry);
    else if (step === "cancel") void entry.controller.cancel();
  };
  entry.stopWatching = entry.controller.subscribe(review);
  review();
}
export const __retainedForTests = { size: () => retained.size, clear: () => { for (const [scope, entry] of [...retained]) letGo(scope, entry); } };

/** A screen owns one target. Visibility changes pause polling without replaying writes. */
export function usePluginManagement(
  deviceId: string | undefined,
  online: boolean,
  visible: boolean,
  selectionKey?: string,
  chatPrompt = false,
  /** The market install path reads `{read:'installed'}`; every existing caller keeps the full snapshot. */
  snapshotRead?: "installed",
) {
  const sharedReads = usePluginPromptReads();
  const displayReads = chatPrompt ? sharedReads : null;
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
    // The same view coming back takes over the operation it left under way.
    const owner = getMobileAuthOwner();
    const kept = retained.get(scope);
    let entry: ManagementEntry;
    if (kept && !kept.dead && isMobileAuthOwnerCurrent(kept.owner)) {
      retained.delete(scope);
      kept.stopWatching?.();
      kept.stopWatching = undefined;
      entry = kept;
    } else {
      if (kept) letGo(scope, kept);
      const created: ManagementEntry = { owner, dead: false } as ManagementEntry;
      // Current while this entry lives (shown or retained) and the account is the same; a retained controller keeps
      // following its operation after the view moved on.
      const client = createPluginManagementClient({
        invoke,
        deviceId,
        isCurrent: () => !created.dead && isMobileAuthOwnerCurrent(owner),
      });
      created.controller = createPluginManagementController(client, {
        online: availability.current,
        snapshotRead,
        readDisplay: displayReads ? () => displayReads.read(deviceId) : undefined,
        onChange: (value) => {
          if (value.operationId) displayReads?.invalidate(deviceId);
          created.listener?.(value);
        },
      });
      entry = created;
    }
    entry.listener = (value) => { if (liveScope.current === scope) setState(value); };
    const next = entry.controller;
    setController(next);
    setState(next.getState());
    if (!kept || kept !== entry) void next.refresh();
    else next.setOnline(availability.current);
    return () => {
      entry.listener = undefined;
      if (!entry.dead && isMobileAuthOwnerCurrent(entry.owner) && next.hasOpenOperation()) retain(scope, entry);
      else letGo(scope, entry);
    };
  }, [deviceId, accountGeneration, invoke, selectionKey, displayReads, snapshotRead]);
  useEffect(() => {
    controller?.setOnline(availability.current);
  }, [controller, online, visible, foreground]);
  useEffect(() => {
    if (!deviceId || !controller || !online || !visible || !foreground) return;
    const release = displayReads?.retain(deviceId);
    // A reconnect can replace the read epoch without changing this chat's identity.
    if (displayReads) void controller.refresh();
    const stop = startFocusedTopicSubscription({ deviceId, owner: `plugin-management:${scope}`,
      topic: 'sessions', subscribe, unsubscribe });
    const off = onRemoteResourceChanged((source, payload) => {
      if (source === deviceId && payload.collectionId === 'plugins') {
        displayReads?.invalidate(deviceId, payload);
        void controller.refresh();
      }
    });
    return () => { release?.(); off(); stop(); };
  }, [deviceId, controller, online, visible, foreground, onRemoteResourceChanged, subscribe, unsubscribe, connectionEpoch, scope, displayReads]);
  return publishedScope === scope
    ? { state, controller }
    : { state: null, controller: null };
}
